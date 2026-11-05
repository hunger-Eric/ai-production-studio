import { mkdtemp, readFile, writeFile, link } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { check, encode, ensure, get, hash, inside, now, record, slug } from './store.mjs';
import { fingerprint, mediaPython, mediaTool } from './media-check.mjs';
import { productionNext } from './production.mjs';
import { authorRoute, invokeHarnessAuthor } from './harness-author.mjs';

const base = id => 'runs/' + slug(id) + '/production';
const path = (id, file) => base(id) + '/harness-author/' + file;
const writer = fileURLToPath(new URL('./python/render_animation.py', import.meta.url));
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const integer = (min,max) => z.number().int().min(min).max(max);
const motion = z.array(z.strictObject({ f:integer(0,900), dx:integer(-1080,1080), dy:integer(-1920,1920),
  opacity:z.number().min(0).max(1) })).max(10).optional();
const common = { x:integer(0,1080), y:integer(0,1920), fill:color, motion };
const shape = z.discriminatedUnion('type',[
  z.strictObject({ type:z.literal('rect'),...common,w:integer(1,1080),h:integer(1,1920),radius:integer(0,300).optional() }),
  z.strictObject({ type:z.literal('text'),...common,text:z.string().min(1).max(100),size:integer(16,150) })
]);
const maxSceneElements = 64;
const visualSchema = z.strictObject({ title:z.string().min(1).max(80), handoff:z.string().min(1).max(3000),
  scenes:z.array(z.strictObject({end:integer(1,900),background:color,elements:z.array(shape).min(1).max(maxSceneElements)})).min(1).max(12) });
const elapsed = t => Math.ceil(t.completed.align.proof.durationMs * 30 / 1000 - 1e-7);
const planPath = id => path(id,'plan.json');
const receiptPath = (id,index) => path(id,'segment-'+index+'.receipt.json');
const leasePath = (id,index) => path(id,'segment-'+index+'.dispatch.json');
const responsePath = (id,index) => path(id,'segment-'+index+'.response.json');

export async function animationPlan(root, runId, taskSha256, ends) {
  const task=await productionNext(root,runId);
  check(task.state==='picture' && task.taskSha256===taskSha256,'当前任务不在画面制作阶段');
  const frames=elapsed(task);
  check(ends.length>0 && ends.length<=24 && ends.at(-1)===frames && ends.every((end,i)=>
    Number.isInteger(end) && end>(ends[i-1]??0) && end-(ends[i-1]??0)<=900),'分段须连续覆盖整片，每段最多 900 帧');
  const method=await readFile(new URL('../knowledge/animation-method.md',import.meta.url),'utf8');
  const plan={runId,taskSha256,frames,ends,route:authorRoute,method,methodSha256:hash(method)};
  try {await record(root,planPath(runId),plan);} catch(error){if(error.code!=='EEXIST')throw error;}
  const saved=await get(root,planPath(runId));
  check(saved.payload.taskSha256===taskSha256 && encode(saved.payload.ends)===encode(ends),'已冻结另一份分段计划');
  return {planSha256:saved.sha256,frames,segments:ends.length};
}

function prompt(task,captions,plan,index,previous) {
  const start=plan.ends[index-2]??0;
  const frames=plan.ends[index-1]-start;
  return [
    '你是本片唯一动画作者。以本机可渲染的结构化数据创作原创无声竖屏动画。不访问网络、不调用工具、不写文件。只返回一个 JSON 对象。',
    '结构 {"title":"短标题","handoff":"接续说明","scenes":[{"end":局部结束帧不含,"background":"#RRGGBB","elements":[...] }]}。30fps，1080×1920，本段覆盖全片帧 '+start+' 至 '+(start+frames)+'。场景 end 最后一项必须等于 '+frames+'，首场从 0 开始。',
    '元素 rect: {"type":"rect","x":整数,"y":整数,"w":整数,"h":整数,"radius":整数,"fill":"#RRGGBB","motion":[{"f":本场局部帧,"dx":整数,"dy":整数,"opacity":0到1}]}。text: {"type":"text","x":整数,"y":整数,"text":"短中文或数字","size":整数,"fill":"#RRGGBB","motion":[同上]}。motion 可省略，关键帧必须递增。每场最多 '+maxSceneElements+' 个元素，按层顺序列出。内容置于 x132–948、y200–1360，主流程另烧字幕。',
    '完整口播：'+task.narration,'对齐：'+JSON.stringify(captions.cues),'客户要求：'+JSON.stringify(task.knowledge),
    '上一段交接：'+(previous?.handoff??'首段'),'冻结创作方法：'+plan.method
  ].join('\n\n');
}

async function finish(root,runId,plan,segment,lease,visual,host) {
  const previous=segment===1 ? undefined : (await get(root,receiptPath(runId,segment-1))).payload;
  check(host.host==='DeepSeek Harness ACP' && typeof host.sessionId==='string' &&
    encode(host.route)===encode(authorRoute) && host.reasoningSelection==='high' &&
    host.result?.stopReason==='end_turn' && host.trace?.includes('agent_message_chunk') &&
    (!previous || previous.sessionId===host.sessionId),'需要同一个 Harness 作者的实际 High 完成回执');
  const design=visualSchema.parse(visual);
  const frames=plan.payload.ends[segment-1]-(plan.payload.ends[segment-2]??0);
  check(design.scenes.at(-1).end===frames && design.scenes.every((scene,i)=>{
    const duration=scene.end-(design.scenes[i-1]?.end??0);
    return duration>0 && scene.elements.every(el=>(el.motion??[]).every((point,j)=>
      point.f<duration && (j===0 || point.f>el.motion[j-1].f)));
  }), '动画场景或关键帧没有覆盖当前段范围');
  const stem='harness-segment-'+segment;
  const relative=base(runId)+'/inputs/';
  const source=relative+stem+'.json',video=relative+stem+'.mp4';
  await ensure(root,source,encode(design));
  check(hash(await readFile(await inside(root,source)))===hash(encode(design)),'同一动画段已有不同源文件');
  const dir=await inside(root,path(runId,'attempts'),{directories:true,create:true});
  const attempt=await mkdtemp(join(dir,'render-'));
  const tmp=join(attempt,stem+'.mp4');
  const font=process.env.STUDIO_ANIMATION_FONT;
  check(font && isAbsolute(font),'需要配置动画中文字体 STUDIO_ANIMATION_FONT');
  await mediaTool(mediaPython(),[writer,await inside(root,source),tmp,font],300000,attempt);
  const {stdout}=await mediaTool('ffprobe',['-v','error','-show_entries','stream=nb_frames,width,height,r_frame_rate',
    '-of','json',tmp],60000);
  const [info,extra]=JSON.parse(stdout).streams;
  check(!extra && Number(info.nb_frames)===frames && info.width===1080 && info.height===1920 && info.r_frame_rate==='30/1',
    'Harness 动画实际渲染规格不符');
  const output=await inside(root,video,{create:true});
  try {await link(tmp,output);} catch(error){if(error.code!=='EEXIST')throw error;}
  const videoSha=await fingerprint(output);
  check(videoSha===await fingerprint(tmp),'同一动画段已有不同视频');
  const payload={segment,dispatchSha256:lease.sha256,planSha256:plan.sha256,sessionId:host.sessionId,host,
    source:{file:source,sha256:hash(encode(design))},video:{file:stem+'.mp4',sha256:videoSha},handoff:design.handoff,completedAt:now()};
  await record(root,receiptPath(runId,segment),payload);
  return get(root,receiptPath(runId,segment));
}

export async function animationDispatch(root,runId,retryDispatchSha256) {
  const task=await productionNext(root,runId);
  check(task.state==='picture','当前任务不在画面制作阶段');
  const plan=await get(root,planPath(runId));
  check(task.taskSha256===plan.payload.taskSha256,'动画计划未绑定当前工作单');
  let previous;
  for (let segment=1;segment<=plan.payload.ends.length;segment++) {
    const old=await get(root,receiptPath(runId,segment),true);
    if(old){previous=old.payload;continue;}
    const waiting=await get(root,leasePath(runId,segment),true);
    const responseFile=responsePath(runId,segment);
    const response=waiting && await get(root,responseFile,true);
    const retryFile=path(runId,'segment-'+segment+'.retry.json');
    const retry=waiting && await get(root,retryFile,true);
    if(response){
      const binding=[waiting,retry].find(entry=>entry?.sha256===response.payload.dispatchSha256);
      check(binding,'已有 Harness 响应未绑定派发');
      return finish(root,runId,plan,segment,binding,response.payload.visual,response.payload.evidence);
    }
    if(retry || (waiting && waiting.sha256!==retryDispatchSha256)){
      return {state:'awaiting_harness_evidence',segment,dispatchSha256:(retry||waiting).sha256};
    }
    check(process.env.STUDIO_HARNESS_COMMAND && process.env.STUDIO_ANIMATION_FONT,'请先配置 Harness ACP 和中文字体');
    const captions=JSON.parse(await readFile(await inside(root,task.completed.align.outputs[0].file),'utf8'));
    const request=prompt(task,captions,plan.payload,segment,previous);
    const taskFile=path(runId,'segment-'+segment+(waiting?'.retry':'')+'.task.md');
    await ensure(root,taskFile,request);
    check(hash(await readFile(await inside(root,taskFile)))===hash(request),'动画工作单正文已变化');
    const dispatchFile=waiting?retryFile:leasePath(runId,segment);
    try {
      await record(root,dispatchFile,{segment,planSha256:plan.sha256,taskFile,promptSha256:hash(request),
        retryOf:waiting?.sha256,host:'DeepSeek Harness ACP',createdAt:now()});
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      return {state:'awaiting_harness_evidence',segment,dispatchSha256:(await get(root,dispatchFile)).sha256};
    }
    const lease=await get(root,dispatchFile);
    const parent=await inside(root,path(runId,'attempts'),{directories:true,create:true});
    const attemptDir=await mkdtemp(join(parent,'acp-'));
    const result=await invokeHarnessAuthor({cwd:root,sessionRoot:await inside(root,path(runId,'sessions'),{directories:true,create:true}),
      attemptDir,prompt:request,priorSession:previous?.sessionId});
    await writeFile(join(attemptDir,'actual-response.json'),encode(result),{flag:'wx'});
    await record(root,responseFile,{dispatchSha256:lease.sha256,...result});
    return finish(root,runId,plan,segment,lease,result.visual,result.evidence);
  }
  return animationDelivery(root,runId);
}

export async function animationDelivery(root,runId) {
  const plan=await get(root,planPath(runId));
  const receipts=[];
  for(const [i] of plan.payload.ends.entries()) {
    const entry=await get(root,receiptPath(runId,i+1));
    const {payload}=entry;
    check(payload.planSha256===plan.sha256 && (!i || payload.sessionId===receipts[0].payload.sessionId) &&
      await fingerprint(await inside(root,payload.source.file))===payload.source.sha256 &&
      await fingerprint(await inside(root,base(runId)+'/inputs/'+payload.video.file))===payload.video.sha256,
      '动画交件或同一作者身份不一致');
    receipts.push(entry);
  }
  return {state:'animation_ready',creatorEvidence:encode({host:'DeepSeek Harness ACP',profile:plan.payload.route,planSha256:plan.sha256,
    sessionId:receipts[0].payload.sessionId,segments:receipts.map(entry=>entry.sha256)}),segments:receipts.map(entry=>entry.payload.video)};
}
