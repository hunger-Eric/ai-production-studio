import { copyFile, link, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { check, encode, ensure, entries, get, hash, inside, now, read, record, slug } from './store.mjs';
import { fingerprint, mediaCheck, mediaTool } from './media-check.mjs';
import { loadRun } from './studio.mjs';
import { productionNext } from './production.mjs';
import { authorRoute, invokeHarnessAuthor } from './harness-author.mjs';

const notes = '02 写稿与制作/动画参考';
const noteName = /^[^\\/:*?"<>|.][^\\/:*?"<>|]{0,90}\.md$/u;
const base = id => 'runs/' + slug(id) + '/visual-reference-trial';
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
const int = (min, max) => z.number().int().min(min).max(max);
const num = (min, max) => z.number().min(min).max(max);
const coord = num(-3840, 3840);
const svgPath = z.string().min(1).max(2600).regex(/^[Mm][MmZzLlHhVvCcSsQqTtAaEe0-9.,+\-\s]*$/);
const shortText = z.string().trim().min(1).max(220);
const transform = {
  clip: svgPath.optional(), originX: coord.optional(), originY: coord.optional(),
  motion: z.array(z.strictObject({
    f: int(0, 899), x: coord.optional(), y: coord.optional(), rotation: num(-720, 720).optional(),
    scaleX: num(0.001, 8).optional(), scaleY: num(0.001, 8).optional(),
    opacity: num(0, 1).optional(), draw: num(0, 1).optional()
  })).max(20).optional()
};
const style = { ...transform, fill: color.optional(), stroke: color.optional(), strokeWidth: num(0, 120).optional() };
const shape = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), ...style, d: svgPath }),
  z.strictObject({ type: z.literal('rect'), ...style, x: coord, y: coord, w: num(1, 3000), h: num(1, 3000), radius: num(0, 500).optional() }),
  z.strictObject({ type: z.literal('ellipse'), ...style, x: coord, y: coord, rx: num(1, 1600), ry: num(1, 1600) }),
  z.strictObject({ type: z.literal('text'), ...style, x: coord, y: coord, text: shortText, size: int(16, 150),
    weight: int(100, 900).optional(), anchor: z.enum(['start', 'middle', 'end']).optional() })
]);
const visualSchema = z.strictObject({
  title: shortText, applied: z.array(z.strictObject({ reference: shortText, time: shortText, observation: shortText })).min(1).max(8),
  scenes: z.array(z.strictObject({ end: int(1, 900), background: color,
    layers: z.array(z.strictObject({ ...transform, shapes: z.array(shape).min(1).max(40) })).min(1).max(30)
  })).min(1).max(8)
});

async function reference(root, name) {
  check(noteName.test(name), '参考必须是「动画参考」文件夹中的 Markdown 文件名');
  const file = notes + '/' + name;
  const body = await read(root, file, { limit: 24000 });
  return { name, file, sha256: hash(body), body };
}

async function source(root, id) {
  const production = await productionNext(root, id);
  check(production.state === 'delivered_locally', '试做需要已有原片、旁白及字幕');
  const { manifest, results } = await loadRun(root, id);
  const audio = (await get(root, 'runs/' + id + '/local-tts.response.json', true))?.payload;
  const speech = { file: 'runs/' + id + '/local-tts.wav', sha256: audio?.audioSha256 };
  const edit = results.at(-1).payload;
  check(audio?.narrationSha256 === edit.bodySha256 && await fingerprint(await inside(root, speech.file)) === speech.sha256,
    '原旁白与口播身份不匹配');
  const align = production.completed.align;
  const captions = JSON.parse(await read(root, align.outputs[0].file));
  check(captions.audio.sha256 === speech.sha256 && captions.script.sha256 === edit.bodySha256, '原字幕身份不匹配');
  const plan = (await get(root, 'runs/' + id + '/production/harness-author/plan.json')).payload;
  const slices = plan.ends.map((endFrame, i) => {
    const startFrame = plan.ends[i - 1] ?? 0;
    const cues = captions.cues.filter(cue => cue.start_ms < endFrame * 1000 / 30 && cue.end_ms > startFrame * 1000 / 30);
    return { segment: i + 1, startFrame, endFrame, cues };
  });
  return { slices, speech, edit, visualRequirement: manifest.nodes.animation, captions: align.outputs,
    original: production.completed.preview.outputs[0] };
}

export async function visualTrialInputs(root, id) {
  const prior = await source(root, id);
  const files = (await entries(root, notes)).filter(name => noteName.test(name)).slice(0, 24);
  const references = await Promise.all(files.map(name => reference(root, name)));
  return { runId: id, referenceDirectory: notes, references, segments: prior.slices, narration: prior.edit.body };
}

function validate(visual, frames, selected) {
  const parsed = visualSchema.parse(visual);
  check(parsed.applied.every(row => selected.some(note => note.name === row.reference)) &&
    parsed.scenes.at(-1).end === frames, '作者应用记录或片段时长与已选参考不符');
  let start = 0;
  for (const scene of parsed.scenes) {
    check(scene.end > start, '场景结束帧须递增');
    for (const layer of scene.layers) {
      for (const item of [layer, ...layer.shapes]) {
        check((item.motion ?? []).every((point, i, track) =>
          point.f < scene.end - start && (i === 0 || point.f > track[i - 1].f)), '关键帧须严格递增且在本场内');
      }
    }
    start = scene.end;
  }
  return parsed;
}

const promptFor = (input, narration, requirement) => [
  '你是本片唯一动画作者。依据 Harness 已选参考和本片设计决定，创作可由 Remotion 渲染的原创动画。只返回 JSON 对象，不输出代码、不调用工具。',
  '试做 ' + (input.slice.endFrame - input.slice.startFrame) + ' 帧，30fps，1080×1920。字幕由合成器烧录，主体尽量置于 x100–980、y180–1370。',
  '输出 {title, applied:[{reference,time,observation}],scenes:[{end,background,layers:[{originX?,originY?,clip?,motion?,shapes:[...]}]}]}。applied.reference 须等于下方参考的完整 name；time 写本段时刻；observation 写画面上的具体实现。end 为本段累计结束帧，最后一场等于总帧数。',
  '每场最多 30 层，每层最多 40 个形状。形状可用 {type:"path",d}、{type:"rect",x,y,w,h,radius?}、{type:"ellipse",x,y,rx,ry} 或 {type:"text",x,y,text,size,weight?,anchor?}。形状支持 fill、stroke、strokeWidth，颜色 #RRGGBB；无 fill 时填充透明。每层和每个形状均支持独立变换、轮廓裁剪与局部动画。clip 是 SVG path 的 d。',
  'motion 每个关键帧 {f,x?,y?,rotation?,scaleX?,scaleY?,opacity?,draw?}，f 为本场内帧号，严格递增且小于本场长度，每轨最多 20 点。x/y 是位移，rotation 单位为度，originX/originY 是变换中心，draw 仅用于 path 描边显现。缺省位移/旋转是 0，缩放/不透明度/draw 是 1；需要保持的值请在后续关键帧明确写出。层变换及形状变换会叠加。不要给尚未采用的参考编造实现。',
  'Harness 的本片设计决定：\n' + input.design,
  '工作区动画要求：\n' + requirement,
  '已选参考全文：\n' + encode(input.references),
  '口播全文：\n' + narration,
  '本段真实字幕时间轴（毫秒是原片绝对时间，试做段原片起始帧为 ' + input.slice.startFrame + '）：\n' + encode(input.slice.cues)
].join('\n\n');

async function verifyFinished(root, result) {
  for (const output of result.payload.outputs) {
    check(await fingerprint(await inside(root, output.file)) === output.sha256, '试做视频文件已变化');
  }
  return result.payload;
}

export async function visualTrial(root, id, choice, retryDispatchSha256) {
  const prefix = base(id);
  const inputFile = prefix + '/selection.json';
  const responseFile = prefix + '/author-response.json';
  const receiptFile = prefix + '/receipt.json';
  const prior = await source(root, id);
  await inside(root, prefix, { directories: true, create: true });
  let selection = await get(root, inputFile, true);
  if (!selection) {
    check(choice, '当前没有已登记的参考选择');
    const slice = prior.slices[choice.segment - 1];
    check(slice && slice.endFrame - slice.startFrame <= 900, '仅支持原片的一段且不超过 30 秒');
    const references = await Promise.all(choice.references.map(name => reference(root, name)));
    check(new Set(choice.references).size === references.length, '参考笔记重复');
    const input = { runId: id, slice, references, design: choice.design, original: prior.original,
      speech: prior.speech, narrationSha256: prior.edit.bodySha256, captions: prior.captions };
    await record(root, inputFile, input);
    selection = await get(root, inputFile);
  }
  const input = selection.payload;
  if (choice) check(input.slice.segment === choice.segment &&
    encode(input.references.map(note => note.name)) === encode(choice.references) && input.design === choice.design,
  '本次试做已绑定另一个选择，恢复时使用原选择');
  check(input.speech.sha256 === prior.speech.sha256 && input.narrationSha256 === prior.edit.bodySha256 &&
    encode(input.captions) === encode(prior.captions) && input.original.sha256 === prior.original.sha256,
  '原素材身份发生变化');
  const existing = await get(root, receiptFile, true);
  if (existing) return verifyFinished(root, existing);
  let response = await get(root, responseFile, true);
  if (!response) {
    check(choice || retryDispatchSha256, '没有已保存的完整作者响应，恢复不会再次派发');
    const prompt = promptFor(input, prior.edit.body, prior.visualRequirement.body);
    const originalDispatch = prefix + '/dispatch.json';
    const promptSha256 = hash(prompt);
    if (retryDispatchSha256) {
      const first = await get(root, originalDispatch);
      check(first.sha256 === retryDispatchSha256 && first.payload.selectionSha256 === selection.sha256 &&
        first.payload.promptSha256 === promptSha256, '重试授权、原选择与原派发身份不符');
    }
    const dispatch = retryDispatchSha256 ? prefix + '/retry-dispatch.json' : originalDispatch;
    try { await record(root, dispatch, { selectionSha256: selection.sha256, promptSha256, at: now(),
      ...(retryDispatchSha256 ? { retryOf: retryDispatchSha256 } : {}) }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { state: 'awaiting_author_response', file: dispatch };
    }
    const taskFile = prefix + '/author.task.md';
    await ensure(root, taskFile, prompt);
    check(hash(await read(root, taskFile)) === promptSha256, '动画作者工作单正文已变化');
    const attemptDir = await mkdtemp(join(await inside(root, prefix, { directories: true }), 'acp-'));
    await invokeHarnessAuthor({ cwd: root, sessionRoot: await inside(root, prefix + '/sessions', { directories: true, create: true }),
      attemptDir, prompt, retry: Boolean(retryDispatchSha256), timeoutMs: 1_080_000,
      saveResponse: result => record(root, responseFile, { selectionSha256: selection.sha256, ...result }) });
    response = await get(root, responseFile);
  }
  const { evidence } = response.payload;
  check(response.payload.selectionSha256 === selection.sha256 && evidence.host === 'DeepSeek Harness ACP' &&
    encode(evidence.route) === encode(authorRoute) && evidence.reasoningSelection === 'high' &&
    evidence.result?.stopReason === 'end_turn' && evidence.trace?.includes('agent_message_chunk'), '作者响应身份不匹配');
  const frames = input.slice.endFrame - input.slice.startFrame;
  const visual = validate(response.payload.visual, frames, input.references);
  const outputs = await render(root, prefix, input, visual, frames);
  await record(root, receiptFile, { state: 'rendered', segment: input.slice.segment, sourceFrames: input.slice,
    selectionSha256: selection.sha256, authorSha256: response.sha256, applied: visual.applied, outputs, at: now() });
  return verifyFinished(root, await get(root, receiptFile));
}

async function render(root, prefix, input, visual, frames) {
  const dir = await mkdtemp(join(await inside(root, prefix, { directories: true }), 'render-'));
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundle({ entryPoint: fileURLToPath(new URL('./visual-svg.jsx', import.meta.url)),
    outDir: join(dir, 'bundle'), onProgress: () => {} });
  const props = { inputProps: { visual }, serveUrl, browserExecutable: process.env.STUDIO_REMOTION_BROWSER || undefined, logLevel: 'error' };
  const composition = await selectComposition({ ...props, id: 'StudioVisualTrial' });
  check(composition.durationInFrames === frames, 'Remotion 合成帧数与原片片段不同');
  const silent = join(dir, 'silent.mp4');
  await renderMedia({ ...props, composition, codec: 'h264', muted: true, concurrency: 3, outputLocation: silent });
  const audio = await inside(root, input.speech.file);
  const original = await inside(root, input.original.file);
  await copyFile(await inside(root, input.captions[1].file), join(dir, 'captions.ass'));
  const start = input.slice.startFrame / 30;
  const end = input.slice.endFrame / 30;
  const audioFilter = '[1:a]atrim=start=' + start + ':end=' + end + ',asetpts=PTS-STARTPTS[a]';
  const outputs = [];
  for (const [name, video, videoFilter] of [
    ['reference-preview.mp4', silent, '[0:v]setpts=PTS+' + start + '/TB,ass=captions.ass,setpts=PTS-STARTPTS[v]'],
    ['original-excerpt.mp4', original, '[0:v]trim=start_frame=' + input.slice.startFrame +
      ':end_frame=' + input.slice.endFrame + ',setpts=PTS-STARTPTS[v]']
  ]) {
    const file = join(dir, name);
    await mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', video, '-i', audio,
      '-filter_complex', videoFilter + ';' + audioFilter, '-map', '[v]', '-map', '[a]', '-frames:v', String(frames),
      '-c:v', 'libx264', '-threads', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart', file], 300000, dir);
    const proof = await mediaCheck(file);
    check(proof.picture.width === 1080 && proof.picture.height === 1920 &&
      Math.abs(proof.durationSeconds - frames / 30) < 0.05, '输出片段规格或时长不符');
    const relative = prefix + '/' + name;
    const target = await inside(root, relative);
    try { await link(file, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    check(await fingerprint(target) === proof.sha256, '试做输出已存在不同版本');
    outputs.push({ file: relative, sha256: proof.sha256, proof });
  }
  return outputs;
}
