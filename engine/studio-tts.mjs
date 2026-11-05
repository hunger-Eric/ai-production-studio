import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, ensure, get, hash, inside, now, record } from './store.mjs';
import { loadRun } from './studio.mjs';

const model = 'gemini-3.8-flash-tts';
const voice = 'Zubenelgenubi';
const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
const responseLimit = 16 * 1024 * 1024;

async function receive(request, credential) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(600_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': credential }, body: JSON.stringify(request)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { outcome: 'provider_http_error', httpStatus: response.status };
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > responseLimit) return { outcome: 'response_too_large' };
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts?.filter(part => part.inlineData) ?? [];
    const audio = parts.length === 1 ? parts[0].inlineData : undefined;
    const bytes = typeof audio?.data === 'string' ? Buffer.from(audio.data, 'base64') : Buffer.alloc(0);
    const modelVersion = payload.modelVersion;
    const responseId = payload.responseId;
    if (candidate?.finishReason !== 'STOP' || !/^audio\/wav(?:;|$)/i.test(audio?.mimeType ?? '') ||
        bytes.length <= 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
        (modelVersion !== undefined && modelVersion !== model)) {
      return { outcome: 'provider_response_invalid', modelVersion, responseId };
    }
    return { outcome: 'audio_received', modelVersion, responseId, audioSha256: hash(bytes), wavBase64: bytes.toString('base64') };
  } catch {
    return { outcome: 'dispatch_unconfirmed' };
  }
}

export async function testSpeech(root, runId, narrationSha256) {
  const { manifest, results } = await loadRun(root, runId);
  const final = results.find(result => result.payload.stage === 'edit');
  check(manifest.mode === 'production' && final?.payload.evidence.outcome === 'model_response' &&
    final.payload.bodySha256 === narrationSha256, '配音必须绑定真实 Gemini 润色后的最终口播 SHA');
  const narration = final.payload.body;
  check(narration.length <= 1500, '短配音测试只接受 1500 字符以内的口播');
  const credential = process.env.GEMINI_API_KEY;
  check(credential?.trim(), '缺少客户 GEMINI_API_KEY；未派发配音');
  const prefix = 'runs/' + runId + '/tts-test';
  const attemptPath = prefix + '.attempt.json';
  const responsePath = prefix + '.response.json';
  let reply = (await get(root, responsePath, true, responseLimit + 4096))?.payload;
  if (!reply) {
    check(!await get(root, attemptPath, true), '配音已经派发且结果待核实；不会重发');
    const request = {
      contents: [{ parts: [{ text: narration }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        responseFormat: { audio: { mimeType: 'AUDIO_WAV', sampleRate: 24000 } },
        speechConfig: { voiceConfig: { voice } }
      }
    };
    const attempt = { runId, narrationSha256, model, voice, requestSha256: hash(JSON.stringify(request)), startedAt: now() };
    try { await record(root, attemptPath, attempt); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error('配音已被其他进程领取；不会重发');
      throw error;
    }
    reply = { ...attempt, ...await receive(request, credential), finishedAt: now() };
    await record(root, responsePath, reply);
  }
  const attempt = (await get(root, attemptPath)).payload;
  check(reply.runId === runId && reply.narrationSha256 === narrationSha256 &&
    reply.requestSha256 === attempt.requestSha256 && reply.model === model && reply.voice === voice, '配音响应身份不匹配');
  check(reply.outcome === 'audio_received', '配音未产出可验证的音频：' + reply.outcome +
    (reply.httpStatus ? ' HTTP ' + reply.httpStatus : '') + '；未自动重发');
  const path = prefix + '.wav';
  const bytes = Buffer.from(reply.wavBase64, 'base64');
  await ensure(root, path, bytes);
  check(hash(await readFile(await inside(root, path))) === reply.audioSha256, '配音 WAV 与回执不同');
  const { wavBase64, ...summary } = reply;
  return { ...summary, path: join(root, path) };
}
