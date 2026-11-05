import { lstat, mkdtemp, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, encode, ensure, get, hash, inside, now, read, record, slug } from './store.mjs';
import { fingerprint, mediaTool } from './media-check.mjs';
import { loadRun } from './studio.mjs';

const worker = fileURLToPath(new URL('./python/local_voice.py', import.meta.url));
const profilePath = '.dsh/local-voice-profile.json';
const sha = /^[a-f0-9]{64}$/;
const tidy = text => text.replace(/\s+/gu, '');

export async function localVoiceProfile(root) {
  const settings = await lstat(join(root,'.dsh')).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!settings) return;
  const raw = await read(root, profilePath, { optional:true, limit:32_768 });
  if (raw === undefined) return;
  const profile = JSON.parse(raw);
  const weights = profile.weights ?? {};
  check(typeof profile.id === 'string' && /^[a-f0-9]{40}$/.test(profile.modelRevision) &&
    sha.test(profile.referenceSha256) && typeof profile.referenceText === 'string' &&
    ['python','modelDirectory','reference'].every(key => typeof profile[key] === 'string' && isAbsolute(profile[key])) &&
    Object.keys(weights).length === 2 &&
    ['model.safetensors','speech_tokenizer/model.safetensors'].every(name => sha.test(weights[name])),
  '本地音色配置无效');
  return { id:profile.id, python:profile.python, hash:hash(raw), path:await inside(root, profilePath) };
}

export async function renderLocalVoice(root, jobId, parts) {
  const profile = await localVoiceProfile(root);
  check(profile,'当前工作区尚未配置本机音色');
  check(parts.length > 0 && parts.length <= 60 && parts.every(part => part.trim() && part.length <= 240) &&
    parts.join('').length <= 6000, '本地配音稿的分段长度超限');
  const base = '.dsh/local-voice-jobs/' + slug(jobId);
  const job = base + '/job.json';
  const spec = encode({profile:profile.path,profileSha256:profile.hash,parts});
  await ensure(root,job,spec);
  check(await read(root,job) === spec,'该本地配音任务已绑定另一份输入');
  const dir = await inside(root,base,{directories:true});
  const resultFile = base + '/voice-result.json';
  let raw = await read(root,resultFile,{optional:true});
  if (!raw) {
    await record(root,base+'/dispatch.json',{jobSha256:hash(spec),startedAt:now()});
    await mediaTool(profile.python,[worker,await inside(root,job)],1_800_000,dir,
      {...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONIOENCODING:'utf-8'});
    raw = await read(root,resultFile);
  }
  const result = JSON.parse(raw);
  check(result.profileSha256 === profile.hash && result.parts.length === parts.length &&
    result.parts.every((row,i)=>row.text===parts[i] && row.file==='part-'+String(i+1).padStart(2,'0')+'.wav'),
  '本地配音回执与原稿或音色不符');
  for (const row of result.parts) {
    check(await fingerprint(await inside(root,base+'/'+row.file)) === row.sha256,'本地配音分段已变化');
  }
  return {...result,profileId:profile.id,jobId,parts:result.parts.map(row=>({...row,file:base+'/'+row.file}))};
}

export async function localSpeech(root,runId,narrationSha256,parts) {
  const {manifest,results,task} = await loadRun(root,runId);
  const final = results.at(-1)?.payload;
  check(manifest.mode === 'production' && !task && final?.stage === 'edit' &&
    final.bodySha256 === narrationSha256 && tidy(parts.join('')) === tidy(final.body),
  '本地配音须逐字保留同一任务已冻结的最终口播');
  const base='runs/'+slug(runId);
  check(!await get(root,base+'/tts-test.attempt.json',true),'此任务已有 Gemini 配音，使用新的试听副本');
  const old = await get(root,base+'/local-tts.response.json',true);
  if (old) {
    check(old.payload.narrationSha256===narrationSha256 && old.payload.partsSha256===hash(encode(parts)) &&
      await fingerprint(await inside(root,base+'/local-tts.wav'))===old.payload.audioSha256,'已完成的本地配音身份不匹配');
    return old;
  }
  const result=await renderLocalVoice(root,runId,parts);
  const scratch=await inside(root,'.dsh/local-voice-jobs/'+runId,{directories:true});
  const inputs=await Promise.all(result.parts.map(row=>inside(root,row.file)));
  const trim='silenceremove=start_periods=1:start_duration=0.03:start_threshold=-47dB:start_silence=0.12';
  const graph=inputs.map((_,i)=>'['+i+':a]'+trim+',areverse,'+trim+',areverse[p'+i+']').join(';')+
    ';'+inputs.map((_,i)=>'[p'+i+']').join('')+'concat=n='+inputs.length+':v=0:a=1[out]';
  const wav=join(await mkdtemp(join(scratch,'merge-')),'narration.wav');
  await mediaTool('ffmpeg',['-nostdin','-v','error','-n',...inputs.flatMap(file=>['-i',file]),'-filter_complex',graph,
    '-map','[out]','-c:a','pcm_s16le',wav],600_000,scratch);
  const audio=await readFile(wav);
  await ensure(root,base+'/local-tts.wav',audio);
  const audioSha256=hash(audio);
  check(await fingerprint(await inside(root,base+'/local-tts.wav'))===audioSha256,'工作区已有不同的配音 WAV');
  try {
    await record(root,base+'/local-tts.response.json',{runId,narrationSha256,partsSha256:hash(encode(parts)),
      outcome:'audio_received',audioSha256,model:result.model,device:result.device,
      profileSha256:result.profileSha256,jobId:result.jobId,finishedAt:now()});
  } catch (error) {
    if (error.code!=='EEXIST') throw error;
  }
  return get(root,base+'/local-tts.response.json');
}
