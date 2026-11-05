import { copyFile, link, lstat, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { body, check, encode, get, hash, inside, now, record, slug } from './store.mjs';
import { fingerprint, mediaCheck, mediaPython, mediaTool } from './media-check.mjs';
import { loadRun, writeBoundFeedback } from './studio.mjs';

const stages = ['align', 'picture', 'sound', 'preview', 'review', 'delivery'];
const stageNodes = {
  align: ['audio', 'narration'], picture: ['animation', 'narration'], sound: ['audio', 'animation'],
  preview: ['animation', 'audio'], review: ['review', 'animation', 'audio'], delivery: ['delivery', 'review']
};
const guide = {
  align: '提交逐字保留润色稿的字幕短句。代码用本地 Whisper 和真实口播对齐。',
  picture: '使用真实对齐、全部口播和客户要求创作动画。登记顺序交付的无声竖屏画面及创作者来源，先生成口播粗剪。',
  sound: '先审看粗剪，再提交本片选曲与音效决定。提供已按时间轴编排的独立音轨、增益和许可，或说明只保留口播的原因。',
  preview: '代码用当前画面、字幕与混音制作预览，并进行完整技术检查。',
  review: '由负责人实际审看当前预览，记录画面、字幕和声音观察。以预览 SHA 确认是否接受。',
  delivery: '为已接受预览提供发布说明，并选择真实画面中的封面帧。代码打包本地交付件。'
};
const words = z.string().min(1).max(16000);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[A-Za-z0-9]{2,5}$/);
const asset = { file: name, sha256: sha };
export const stageInputs = {
  align: z.strictObject({ phrases: z.array(words).min(1).max(1000) }),
  picture: z.strictObject({ segments: z.array(z.strictObject(asset)).min(1).max(24), creatorEvidence: words }),
  sound: z.strictObject({ decision: words, tracks: z.array(z.strictObject({
    ...asset, role: z.enum(['music', 'effects']), gainDb: z.number().min(-60).max(0), rights: words
  })).max(8), earshot: z.strictObject({ key: sha, resultSha256: sha }).optional() }),
  preview: z.strictObject({}),
  review: z.strictObject({ previewSha256: sha, observations: words, scope: z.enum(['technical_validation', 'owner_review']) }),
  delivery: z.strictObject({ coverMs: z.number().int().min(0), description: words })
};

const folder = id => 'runs/' + slug(id) + '/production';
const tool = (exe, args, cwd, timeout = 600_000) => mediaTool(exe, args, timeout, cwd);
const ffmpeg = (args, cwd) => tool('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', ...args], cwd);
const probe = async file => JSON.parse((await tool('ffprobe',
  ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file])).stdout);
const fileHash = async (root, file) => fingerprint(await inside(root, file));
const ffinput = file => ['-protocol_whitelist', 'file', '-i', file];

async function putFile(root, scratch, source, relative) {
  const destination = await inside(root, relative, { create: true });
  const staged = join(scratch, 'publish-' + relative.split('/').at(-1));
  if (staged !== source) await copyFile(source, staged);
  const expected = await fingerprint(staged);
  try { await link(staged, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  check(await fingerprint(destination) === expected, '已有制作文件内容冲突：' + relative);
  return { file: relative, sha256: expected };
}

async function state(root, id) {
  const { manifest, results, task } = await loadRun(root, id);
  if (task) return { runId: id, state: task.payload.stage };
  const final = results.at(-1).payload;
  const runBase = 'runs/' + id;
  const localTts = await get(root, runBase + '/local-tts.response.json', true);
  const tts = localTts ?? await get(root, runBase + '/tts-test.response.json', true, 17 * 1024 * 1024);
  if (!tts || tts.payload.outcome !== 'audio_received') return { runId: id, state: 'needs_tts' };
  const audio = { file: runBase + (localTts ? '/local-tts.wav' : '/tts-test.wav'), sha256: tts.payload.audioSha256 };
  check(tts.payload.runId === id && tts.payload.narrationSha256 === final.bodySha256 &&
    await fileHash(root, audio.file) === audio.sha256, '配音与最终口播的身份或文件不匹配');
  const base = folder(id);
  const runDir = await inside(root, 'runs/' + id, { directories: true });
  const productionDir = await lstat(join(runDir, 'production')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (productionDir) check(productionDir.isDirectory() && !productionDir.isSymbolicLink(), '无效制作目录');
  const records = {};
  let prior = tts.sha256;
  for (const stage of stages) {
    const packet = { runId: id, stage, prior, audio, narration: final.body,
      knowledge: stageNodes[stage].map(node => manifest.nodes[node]), guide: guide[stage] };
    const taskSha256 = hash(encode(packet));
    const entry = productionDir && await get(root, base + '/' + stage + '.json', true);
    if (!entry) return { ...packet, taskSha256, state: stage, base, records };
    check(entry.payload.taskSha256 === taskSha256 && entry.payload.stage === stage, '制作记录身份冲突：' + stage);
    for (const output of entry.payload.outputs) {
      check(await fileHash(root, output.file) === output.sha256, '制作产物已变化：' + output.file);
    }
    records[stage] = entry;
    prior = entry.sha256;
  }
  return { runId: id, state: 'delivered_locally', records, base };
}

export async function productionNext(root, id) {
  const result = await state(root, id);
  if (!result.records) return result;
  const { records, base, ...task } = result;
  return { ...task, inputs: base + '/inputs',
    completed: Object.fromEntries(Object.entries(records).map(([stage, entry]) =>
      [stage, { resultSha256: entry.sha256, outputs: entry.payload.outputs, proof: entry.payload.proof }])) };
}

async function verifyInput(root, base, input) {
  const file = base + '/inputs/' + input.file;
  check(await fileHash(root, file) === input.sha256, '制作输入 SHA 不匹配：' + input.file);
  return inside(root, file);
}

const stamp = ms => {
  const whole = Math.round(ms / 10);
  return [Math.floor(whole / 360000), String(Math.floor(whole / 6000) % 60).padStart(2, '0'),
    String(Math.floor(whole / 100) % 60).padStart(2, '0')].join(':') + '.' + String(whole % 100).padStart(2, '0');
};

function ass(cues) {
  const style = '[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n' +
    '[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
    'Style: Default,Microsoft YaHei,46,&H00FFFFFF,&H000000FF,&H00101620,&H80101620,-1,0,0,0,100,100,0,0,1,3,1,2,132,132,365,1\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  return style + cues.map(cue => 'Dialogue: 0,' + stamp(cue.start_ms) + ',' + stamp(cue.end_ms) +
    ',Default,,0,0,0,,' + cue.subtitle.replace(/[{}\\]/g, char => ({ '{': '｛', '}': '｝', '\\': '＼' })[char])
      .replace(/\r?\n/g, ' ') + '\n').join('');
}

async function execute(root, task, input, scratch, inputSha256) {
  const { stage, base, records } = task;
  const output = (source, name) => putFile(root, scratch, source, base + '/' + stage + '/' + inputSha256 + '/' + name);
  const prior = (step, index = 0) => inside(root, records[step].payload.outputs[index].file);
  const audio = task.audio ? await inside(root, task.audio.file) : undefined;
  let outputs = [], proof = {};
  if (stage === 'align') {
    check(input.phrases.join('') === task.narration, '字幕短句必须逐字拼回最终润色稿');
    const modelPath = process.env.STUDIO_WHISPER_MODEL_PATH;
    check(modelPath && isAbsolute(modelPath) && (await stat(modelPath)).isFile(), '请配置本机 STUDIO_WHISPER_MODEL_PATH');
    const audioInfo = await probe(audio);
    const durationMs = Math.round(Number(audioInfo.format.duration) * 1000);
    check(Number.isSafeInteger(durationMs) && durationMs > 0, '实际音频时长无效');
    const plan = join(scratch, 'plan.json');
    const aligned = join(scratch, 'captions.json');
    await writeFile(plan, encode({ beats: [{ beat_id: 'narration', narration: task.narration, phrases: input.phrases }] }));
    await tool(mediaPython(), [fileURLToPath(new URL('./python/audio_caption_alignment.py', import.meta.url)),
      '--audio', audio, '--plan', plan, '--output', aligned, '--duration-ms', String(durationMs), '--model-file', modelPath], scratch);
    const result = JSON.parse(await readFile(aligned, 'utf8'));
    check(result.audio.sha256 === task.audio.sha256 && result.script.sha256 === hash(task.narration) &&
      result.cues.map(cue => cue.subtitle).join('') === task.narration, '对齐未绑定最终音频与口播');
    const subtitles = join(scratch, 'captions.ass');
    await writeFile(subtitles, ass(result.cues));
    outputs = [await output(aligned, 'captions.json'), await output(subtitles, 'captions.ass')];
    proof = { durationMs, ...result.metrics, whisperModelSha256: await fingerprint(modelPath) };
  } else if (stage === 'picture') {
    body(input.creatorEvidence, '创作者来源记录');
    const files = await Promise.all(input.segments.map(segment => verifyInput(root, base, segment)));
    const duration = records.align.payload.proof.durationMs / 1000;
    const frames = [];
    for (const file of files) {
      const info = await probe(file);
      const picture = info.streams[0];
      check(info.streams.length === 1 && picture.codec_type === 'video' && picture.width === 1080 && picture.height === 1920 &&
        picture.r_frame_rate === '30/1' && !picture.disposition?.attached_pic, '动画段须为无声 1080×1920、30fps 视频');
      const count = Number(picture.nb_frames);
      check(Number.isInteger(count) && count > 0 && count <= 900, '动画段须有 1 至 900 帧');
      frames.push(count);
    }
    check(frames.reduce((a, b) => a + b, 0) === Math.ceil(duration * 30 - 1e-7), '动画段总帧数须连续覆盖完整口播');
    await copyFile(await prior('align', 1), join(scratch, 'captions.ass'));
    const concat = files.map((_, i) => '[' + i + ':v:0]').join('') + 'concat=n=' + files.length +
      ':v=1:a=0,ass=captions.ass[v]';
    const rough = join(scratch, 'rough.mp4');
    await ffmpeg([...files.flatMap(ffinput), ...ffinput(audio), '-filter_complex', concat, '-map', '[v]',
      '-map', files.length + ':a:0', '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', rough], scratch);
    proof = { frames, creatorEvidence: input.creatorEvidence, technical: await mediaCheck(rough) };
    outputs = [await output(rough, 'rough.mp4')];
  } else if (stage === 'sound') {
    body(input.decision, '粗剪后的声音选择依据');
    if (input.earshot) {
      check(!input.tracks.length, '原生 Earshot 成品不得再与其他分轨叠混');
      const native = await get(root, base + '/earshot/mix-' + input.earshot.key + '/receipt.json');
      check(native.sha256 === input.earshot.resultSha256 && native.payload.taskSha256 === task.taskSha256,
        'Earshot 成品须绑定当前粗剪工作单');
      for (const ref of native.payload.assets) {
        check(await fileHash(root, ref.file) === ref.sha256, 'Earshot 产物已变化');
      }
      check(native.payload.listen.listened === true && Array.isArray(native.payload.listen.critique?.actions) &&
        native.payload.listen.critique.actions.length === 0, 'Earshot 仍有未解决的分析建议，请调整候选后重测');
      outputs = [await output(await inside(root, native.payload.mix.file), 'mix.wav'),
        await output(await inside(root, native.payload.encodedMix.file), 'mix.m4a')];
      proof = { decision: input.decision, earshot: input.earshot, encodedMetrics: native.payload.result.encoded_metrics,
        hearing: native.payload.result.hearing, nativeAnalysis: native.payload.listen };
      return { outputs, proof };
    }
    const files = await Promise.all(input.tracks.map(track => verifyInput(root, base, track)));
    const duration = records.align.payload.proof.durationMs / 1000;
    for (const file of files) {
      const info = await probe(file);
      check(info.streams.length === 1 && info.streams[0].codec_type === 'audio' &&
        Math.abs(Number(info.format.duration) - duration) < 0.05, '声音分轨须为单独的音频文件，并已对齐完整口播时间轴');
    }
    const mixed = join(scratch, 'mix.wav');
    if (!files.length) await copyFile(audio, mixed);
    else {
      const chain = input.tracks.map((track, index) => '[' + (index + 1) + ':a]volume=' + track.gainDb + 'dB[t' + index + '];').join('');
      const mix = '[0:a]' + files.map((_, i) => '[t' + i + ']').join('') + 'amix=inputs=' + (files.length + 1) +
        ':duration=first:normalize=0,alimiter=limit=0.891:level=false:latency=true[a]';
      await ffmpeg([...ffinput(audio), ...files.flatMap(ffinput), '-filter_complex', chain + mix, '-map', '[a]',
        '-ar', '48000', '-c:a', 'pcm_s24le', mixed], scratch);
    }
    check(Math.abs(Number((await probe(mixed)).format.duration) - duration) < 0.05, '混音改动了口播时长');
    outputs = [await output(mixed, 'mix.wav')];
    proof = { decision: input.decision, tracks: input.tracks, duration };
  } else if (stage === 'preview') {
    const preview = join(scratch, 'preview.mp4');
    const nativeMix = Boolean(records.sound.payload.proof.earshot);
    await ffmpeg([...ffinput(await prior('picture')), ...ffinput(await prior('sound', nativeMix ? 1 : 0)), '-map', '0:v:0',
      '-map', '1:a:0', '-c:v', 'copy', ...(nativeMix ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']),
      '-movflags', '+faststart', preview], scratch);
    proof = await mediaCheck(preview);
    outputs = [await output(preview, 'preview.mp4')];
  } else if (stage === 'review') {
    body(input.observations, '整片审看记录');
    check(input.previewSha256 === records.preview.payload.outputs[0].sha256, '审看必须绑定当前预览');
    const native = records.sound.payload.proof.nativeAnalysis;
    if (native) check(native.listened === true && Array.isArray(native.critique?.actions) &&
      native.critique.actions.length === 0, '原生混音仍有未解决的分析建议');
    proof = input;
  } else if (stage === 'delivery') {
    body(input.description, '交付文案');
    const preview = await prior('preview');
    const durationMs = records.align.payload.proof.durationMs;
    check(input.coverMs < durationMs - 33, '封面时刻超出有效画面');
    const cover = join(scratch, 'cover.png'), description = join(scratch, 'description.md');
    await ffmpeg(['-ss', String(input.coverMs / 1000), ...ffinput(preview), '-frames:v', '1', '-update', '1', cover], scratch);
    await writeFile(description, input.description);
    outputs = [await output(preview, 'final.mp4'), await output(cover, 'cover.png'), await output(description, 'description.md')];
    proof = { previewSha256: outputs[0].sha256, reviewScope: records.review.payload.proof.scope,
      disposition: 'local_delivery', coverMs: input.coverMs };
  }
  return { outputs, proof };
}

export async function productionApply(root, id, stage, taskSha256, raw) {
  check(Object.hasOwn(stageInputs, stage), '无效制作阶段');
  const input = stageInputs[stage].parse(raw);
  const current = await state(root, id);
  const inputSha256 = hash(encode(input));
  const previous = current.records?.[stage];
  if (previous) {
    check(previous.payload.taskSha256 === taskSha256 && previous.payload.inputSha256 === inputSha256,
      '阶段已完成，提交内容与原记录不一致');
    return { ...previous, reused: true };
  }
  check(current.state === stage && current.taskSha256 === taskSha256, '不是当前制作工作单，请重新读取');
  await inside(root, current.base + '/inputs', { directories: true, create: true });
  const scratch = await mkdtemp(join(await inside(root, current.base, { directories: true }), '.scratch-'));
  try {
    const result = await execute(root, current, input, scratch, inputSha256);
    const path = current.base + '/' + stage + '.json';
    try { await record(root, path, { stage, taskSha256, inputSha256, input, ...result, completedAt: now() }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const saved = await get(root, path);
    check(saved.payload.inputSha256 === inputSha256, '另一个进程已提交该阶段');
    return saved;
  } finally {
    // Only unlink known files in this newly created, private scratch directory.
    for (const file of await readdir(scratch)) await rm(join(scratch, file));
    await rmdir(scratch);
  }
}

export async function productionFeedback(root, id, input) {
  const current = await state(root, id);
  const stage = current.records?.[input.stage];
  check(stage?.sha256 === input.resultSha256 && stageNodes[input.stage]?.includes(input.node), '反馈未绑定当前制作结果或知识节点');
  const { manifest } = await loadRun(root, id);
  return writeBoundFeedback(root, manifest, input, manifest.nodes[input.node], encode(stage.payload));
}
