import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { body, check, encode, get, hash, inside, now, record, slug } from './store.mjs';
import { fingerprint, mediaTool } from './media-check.mjs';
import { productionNext } from './production.mjs';

const base = id => 'runs/' + slug(id) + '/production/earshot';
const worker = fileURLToPath(new URL('./python/earshot_sound.py', import.meta.url));
const lock = JSON.parse(await readFile(new URL('../knowledge/earshot-runtime-lock.json', import.meta.url), 'utf8'));
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const text = z.string().min(1).max(4000);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const musicSegment = z.strictObject({
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(wav|mp3|m4a|flac)$/i), sha256: sha, rights: text,
  start_frame: z.number().int().nonnegative(), duration_frames: z.number().int().positive(),
  source_start_seconds: z.number().nonnegative(), gain_db: z.number().min(-60).max(0),
  fade_in_seconds: z.number().nonnegative(), fade_out_seconds: z.number().nonnegative(),
  envelope: z.array(z.strictObject({ frame:z.number().int().nonnegative(),gain_db:z.number().min(-60).max(0) })).max(60)
});
export const earshotPlanInput = z.array(z.strictObject({ id, query: text, alts: z.array(text).max(4),
  candidates: z.array(z.strictObject({ id, sound: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,90}$/),
    edits: z.strictObject({ dur: z.number().positive().max(6).optional(), apex: z.number().min(0).max(1).optional() }).optional()
  })).min(2).max(6) })).min(1).max(4);
export const earshotMixInput = z.strictObject({ candidateReceiptSha256: sha,
  treatment: text, narrationGainDb: z.number().min(-24).max(12),
  musicDecision: text, music: z.array(musicSegment).max(8).optional(),
  selections: z.array(z.strictObject({ group: id, candidate: id, reason: text,
    anchor: z.enum(['onset','peak','end']), frames: z.array(z.number().int().nonnegative()).min(1).max(20)
  })).min(1).max(4) });
const mastering = { schema_version:'feed_loudness.v1', target_lufs:-14, tolerance_lu:0.5, true_peak_max_dbtp:-1 };

async function runtime() {
  const profile = { repository: process.env.STUDIO_EARSHOT_REPOSITORY, cinetic: process.env.STUDIO_CINETIC_PATH,
    python_executable: process.env.STUDIO_EARSHOT_PYTHON, model_cache: process.env.STUDIO_EARSHOT_MODEL_CACHE };
  check(Object.values(profile).every(p => p && isAbsolute(p)), '需要配置本地 Earshot、Cinetic、Python 和模型缓存');
  for (const ref of lock.files) {
    const root = ref.root === 'earshot' ? profile.repository : profile.cinetic;
    check(await fingerprint(await inside(root, ref.path)) === ref.sha256, 'Earshot/Cinetic 源码与锁定版本不一致：' + ref.path);
  }
  return profile;
}
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const relativeAsset = async (root, relative) => ({ file: relative, sha256: await fingerprint(await inside(root, relative)) });
async function verify(root, ref) {
  const path = await inside(root, ref.file);
  check(await fingerprint(path) === ref.sha256, 'Earshot 产物 SHA 已变化：' + ref.file);
  return path;
}
async function attempt(root, prefix) {
  const dir = await inside(root, prefix, { directories: true, create: true });
  const absolute = await mkdtemp(join(dir, 'attempt-'));
  return { absolute, relative: prefix + '/' + absolute.split(/[\\/]/).at(-1) };
}

export async function earshotCandidates(root, runId, taskSha256, groups) {
  groups = earshotPlanInput.parse(groups);
  const task = await productionNext(root, runId);
  check(task.state === 'sound' && task.taskSha256 === taskSha256, '须先审看当前粗剪并读取声音工作单');
  check(new Set(groups.map(g => g.id)).size === groups.length &&
    groups.every(g => new Set(g.candidates.map(c => c.id)).size === g.candidates.length), '候选组和条目不能重名');
  const plan = { schema_version:'earshot_candidate_plan.v1', run_id:runId, groups };
  const key = hash(encode({ taskSha256, plan }));
  const prefix = base(runId) + '/candidates-' + key;
  await inside(root, prefix, { directories: true, create: true });
  const receiptPath = prefix + '/receipt.json';
  const existing = await get(root, receiptPath, true);
  if (existing) {
    for (const ref of existing.payload.assets) await verify(root, ref);
    return { ...existing, reused: true };
  }
  const profile = await runtime();
  const out = await attempt(root, prefix);
  const spec = join(out.absolute, 'spec.json');
  await writeFile(spec, encode({ profile, output: out.absolute, plan, plan_sha256: hash(encode(plan)) }));
  await mediaTool(profile.python_executable, [worker, '--candidates', spec], 600000, out.absolute);
  const report = await readJson(join(out.absolute, 'candidates.json'));
  check(report.groups.length === groups.length && report.groups.every(g =>
    g.candidates.length >= 2 && !g.analysis.unavailable && g.analysis.rank && g.analysis.match && g.analysis.ab),
  'Earshot 实际候选或本地 rank/match/AB 不完整，保留原输出，不替代分析');
  const files = ['candidates.json', 'audition.html', ...report.groups.flatMap(g => g.candidates.map(c => c.file))];
  const assets = await Promise.all(files.map(file => relativeAsset(root, out.relative + '/' + file)));
  await record(root, receiptPath, { taskSha256, plan, assets, bank: report.bank, key, createdAt: now() });
  return get(root, receiptPath);
}

export async function earshotMix(root, runId, taskSha256, candidateKey, input) {
  input = earshotMixInput.parse(input);
  check(sha.safeParse(candidateKey).success, '候选 key 无效');
  const task = await productionNext(root, runId);
  check(task.state === 'sound' && task.taskSha256 === taskSha256, '当前声音工作单不匹配');
  const candidates = await get(root, base(runId) + '/candidates-' + candidateKey + '/receipt.json');
  check(candidates.sha256 === input.candidateReceiptSha256 && candidates.payload.taskSha256 === taskSha256,
    '选择须绑定当前粗剪的实际候选报告');
  for (const ref of candidates.payload.assets) await verify(root, ref);
  body(input.treatment, '声音处理依据');
  body(input.musicDecision, '音乐决定');
  const key = hash(encode({ taskSha256, candidateKey, input }));
  const prefix = base(runId) + '/mix-' + key;
  await inside(root, prefix, { directories:true, create:true });
  const receiptPath = prefix + '/receipt.json';
  const existing = await get(root, receiptPath, true);
  if (existing) {
    for (const ref of existing.payload.assets) await verify(root, ref);
    return { ...existing, reused:true };
  }
  const frames = task.completed.picture.proof.frames.reduce((a,b) => a + b, 0);
  const music = [];
  for (const segment of input.music ?? []) {
    body(segment.rights, '音乐许可');
    check(segment.start_frame + segment.duration_frames <= frames &&
      (segment.fade_in_seconds + segment.fade_out_seconds) * 30 <= segment.duration_frames &&
      segment.envelope.every((point,i) => point.frame <= segment.duration_frames &&
        (!i || point.frame > segment.envelope[i-1].frame)), '音乐段或包络超出实际口播时间轴');
    music.push({ ...segment, file: await verify(root,{ file:task.inputs+'/'+segment.file,sha256:segment.sha256 }) });
  }
  const roles = {}, events = [], effects = [];
  for (const [index, select] of input.selections.entries()) {
    body(select.reason, '候选选择原因');
    const candidate = candidates.payload.plan.groups.find(g => g.id === select.group)?.candidates.find(c => c.id === select.candidate);
    check(candidate && select.frames.every(f => f < frames), '选中的候选或帧超出当前任务');
    const role = 'confirm.' + 'abcd'[index];
    roles[role] = { sound: candidate.sound, edits: candidate.edits ?? {}, align: select.anchor };
    for (const [i, f] of select.frames.entries()) {
      const cue = role + '-' + (i + 1);
      events.push({ id:cue, kind:role, f });
      effects.push({ cue_id:cue, frame:f, anchor:select.anchor });
    }
  }
  events.sort((a,b) => a.f - b.f);
  const profile = await runtime();
  const out = await attempt(root, prefix);
  const spec = join(out.absolute, 'spec.json');
  const score = { key:'C major', bpm:120, music:'none', sections:[], mix:{music:1,sfx:0.5,reverb:0},
    master:{lufs:-14,ceiling:0.82,fade:0.12} };
  await writeFile(spec, encode({ profile, output:out.absolute, kit:{ kit:1,sr:48000,name:'owner-selected',roles },
    cues:{fps:30,total:frames,bpm:120,cue:{},events}, score, supplied:{narration_gain_db:input.narrationGainDb}, music,
    arrangement:{effects,music_absence:[]}, mastering_target:mastering, iteration_policy:'iterate_then_analyze.v1',
    rough_cut: await verify(root, task.completed.picture.outputs[0]), narration: await verify(root, task.audio), duration_frames:frames }));
  await mediaTool(profile.python_executable, [worker, spec], 600000, out.absolute);
  const result = await readJson(join(out.absolute, 'result.json'));
  check(result.status === 'success' && result.kit_cues === events.length, '原生渲染没有放置所有选配音效');
  const analysis = await attempt(root, prefix);
  const analysisSpec = join(analysis.absolute, 'spec.json');
  await writeFile(analysisSpec, encode({ profile, output:analysis.absolute, analysis_source:out.absolute }));
  await mediaTool(profile.python_executable, [worker, '--analyze', analysisSpec], 600000, analysis.absolute);
  const listen = await readJson(join(analysis.absolute, 'listen.json'));
  const files = ['soundtrack.wav','mix.m4a','mastering-qc.json','score-report.json','relative-levels.json',
    'mix-integrity.json','placements.json','bank-provenance.json','ATTRIBUTION.md','av-audit.json','calls.json'];
  const assets = await Promise.all([...files.map(file => relativeAsset(root, out.relative + '/' + file)),
    relativeAsset(root, analysis.relative + '/listen.json'), relativeAsset(root, analysis.relative + '/calls.json')]);
  check(assets[1].sha256 === result.output_sha256, 'Earshot 编码成品与原生回执不一致');
  await record(root, receiptPath, { key, taskSha256, selection:input, assets, result, listen, mix:assets[0], encodedMix:assets[1], createdAt:now() });
  return get(root, receiptPath);
}
