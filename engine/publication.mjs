import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { body, check, encode, get, hash, inside, now, record, slug } from './store.mjs';
import { fingerprint, mediaCheck, mediaTool } from './media-check.mjs';
import { productionNext } from './production.mjs';

const platform = z.enum(['douyin', 'bilibili']);
export const publicationInput = z.strictObject({
  deliverySha256: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1).max(40),
  description: z.string().min(1).max(2000),
  topics: z.array(z.string().regex(/^[^#\r\n,]{1,32}$/u)).max(10),
  platforms: z.array(platform).min(1).max(2),
  aiGenerated: z.boolean(),
  bilibiliCategory: z.number().int().positive().optional(),
  bilibiliSubmitApi: z.enum(['app','web','b-cut-android']).optional()
});
const transport = fileURLToPath(new URL('./publisher/sau_cli.py', import.meta.url));
const inspect = async file => JSON.parse((await mediaTool('ffprobe',
  ['-v','error','-protocol_whitelist','file','-show_streams','-show_format','-of','json',file],60000)).stdout);
const media = (args, cwd) => mediaTool('ffmpeg',['-nostdin','-v','error','-xerror',...args],600000,cwd);
const ffinput = file => ['-protocol_whitelist','file','-i',file];
async function frames(file, cwd) {
  const { stdout } = await media([...ffinput(file),'-map','0:v:0','-an','-fps_mode','passthrough','-f','framemd5','-'], cwd);
  return stdout.split(/\r?\n/u).filter(line => line && !line.startsWith('#'));
}

export async function publicationPrepare(root, runId, raw) {
  const input = publicationInput.parse(raw);
  check(new Set(input.platforms).size === input.platforms.length, '平台不能重复');
  body(input.title, '发布标题');
  body(input.description, '发布描述');
  check([...input.title].length <= 16 && !/[\r\n]/.test(input.title) && !/[\r\n]/.test(input.description), '标题最多 16 字，标题和描述须为单行');
  check(input.platforms.every(p => p !== 'douyin' || (input.description + input.topics.map(t => ' #' + t + ' ').join('')).length <= 1000),
    '抖音文案与话题合计超过限制');
  if (input.platforms.includes('bilibili')) check(input.bilibiliCategory && input.bilibiliSubmitApi, '请明确 B 站分区及提交接口');
  const task = await productionNext(root, runId);
  const delivery = task.completed?.delivery;
  check(task.state === 'delivered_locally' && delivery.resultSha256 === input.deliverySha256, '发布准备必须绑定当前本地交付');
  const key = hash(encode(input));
  const base = 'runs/' + slug(runId) + '/production/publication';
  await inside(root, base, { directories:true, create:true });
  const receiptPath = base + '/' + key + '.json';
  const old = await get(root, receiptPath, true);
  if (old) {
    for (const artifact of old.payload.outputs) {
      check(await fingerprint(await inside(root, artifact.file)) === artifact.sha256, '提交准备产物已变化');
    }
    return { ...old, reused:true };
  }
  const dir = await mkdtemp(join(await inside(root, base, { directories:true }), 'prepare-'));
  const relative = base + '/' + dir.split(/[\\/]/).at(-1);
  const python = process.env.STUDIO_PUBLISH_PYTHON;
  check(python && isAbsolute(python), '需要配置平台发布工具专用 Python');
  const help = {};
  for (const p of input.platforms) {
    const checkResult = await mediaTool(python,[transport,p,'upload-video','--help'],60000,dir,
      { ...process.env, STUDIO_PUBLISH_STATE:join(dir,'uploader-state'), PYTHONDONTWRITEBYTECODE:'1' });
    const flags = p === 'douyin' ? ['--thumbnail-landscape','--thumbnail-portrait','--self-declaration'] :
      ['--tid','--cover','--submit'];
    check(flags.every(flag => checkResult.stdout.includes(flag)), '发布工具参数不兼容：' + p);
    help[p] = hash(checkResult.stdout);
  }
  const source = await inside(root, delivery.outputs[0].file);
  const portrait = await inside(root, delivery.outputs[1].file);
  const clean = join(dir, 'upload.mp4'), landscape = join(dir, 'cover-landscape.png');
  await media([...ffinput(source),'-map','0:v:0','-map','0:a:0','-map_metadata','-1','-map_chapters','-1',
    '-c:v','copy','-c:a','aac','-b:a','192k','-flags:a','+bitexact','-fflags','+bitexact',
    '-metadata:s:v:0','encoder=','-metadata:s:a:0','encoder=','-metadata:s:v:0','handler_name= ',
    '-metadata:s:a:0','handler_name= ','-movflags','+faststart',clean],dir);
  const [before, after, original, cleaned] = await Promise.all([frames(source,dir),frames(clean,dir),inspect(source),inspect(clean)]);
  check(before.length > 0 && before.join('\n') === after.join('\n'), '清理后的实际解码帧或时间轴变化');
  check(cleaned.streams.length === 2 && cleaned.streams.some(s => s.codec_name === 'aac') &&
    Math.abs(Number(original.format.duration) - Number(cleaned.format.duration)) < 0.1 &&
    Object.keys(cleaned.format.tags ?? {}).every(t => ['major_brand','minor_version','compatible_brands'].includes(t)), '上传媒体结构或元数据检查失败');
  const technical = await mediaCheck(clean);
  await media([...ffinput(portrait),'-vf','scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x102824',
    '-frames:v','1','-update','1',landscape],dir);
  const landscapeInfo = (await inspect(landscape)).streams[0];
  check(landscapeInfo.width === 1280 && landscapeInfo.height === 720, '横封面未通过实际尺寸检查');
  const common = ['upload-video','--account','<客户账号别名>','--file','upload.mp4','--title',input.title,
    '--desc',input.description,'--tags',input.topics.join(',')];
  const args = {};
  for (const p of input.platforms) args[p] = [p,...common,...(p === 'douyin'
    ? ['--thumbnail-landscape','cover-landscape.png','--thumbnail-portrait','cover-portrait.png',
      ...(input.aiGenerated ? ['--self-declaration','内容由AI生成'] : []),'--headless']
    : ['--tid',String(input.bilibiliCategory),'--cover','cover-landscape.png','--submit',input.bilibiliSubmitApi])];
  await writeFile(join(dir,'cover-portrait.png'), await (await import('node:fs/promises')).readFile(portrait));
  await writeFile(join(dir,'handoff.json'), encode({ runId, state:'stopped_before_submit', input, args,
    accountCheck:'not_run', submit:'not_dispatched', reviewScope:delivery.proof.reviewScope }));
  const outputs = await Promise.all(['upload.mp4','cover-landscape.png','cover-portrait.png','handoff.json'].map(async name =>
    ({ file:relative + '/' + name, sha256:await fingerprint(join(dir,name)) })));
  check(outputs[2].sha256 === delivery.outputs[1].sha256, '封面交接 SHA 不一致');
  await record(root, receiptPath, { runId, state:'stopped_before_submit', input, outputs, help,
    sourceSha256:delivery.outputs[0].sha256, decodedFrames:after.length, decodedFramesSha256:hash(after.join('\n')),
    technical, accountCheck:'not_run', submit:'not_dispatched', createdAt:now() });
  return get(root, receiptPath);
}
