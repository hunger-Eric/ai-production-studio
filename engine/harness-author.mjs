import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { check } from './store.mjs';

export const authorRoute = { provider:'openai', model:'gpt-6.1-sol', reasoningEffort:'high' };

export async function invokeHarnessAuthor({ cwd, sessionRoot, attemptDir, prompt, priorSession, retry = false,
  saveResponse, timeoutMs = 540_000 }) {
  const command = process.env.STUDIO_HARNESS_COMMAND;
  const entry = process.env.STUDIO_HARNESS_ENTRY;
  const electron = process.env.STUDIO_HARNESS_ELECTRON === '1';
  check(command && isAbsolute(command) && (!entry || isAbsolute(entry)) && (!electron || entry),
    '请配置 DeepSeek Harness ACP 启动程序');
  await mkdir(sessionRoot, { recursive:true });
  const patch = join(attemptDir, 'harness-patch.json');
  await writeFile(patch, JSON.stringify([
    { id:'llm-pi-ai', config:{ providers:{ openai:{ apiKeyEnv:'OPENAI_API_KEY',
      ...(retry ? { retryPolicy:{ mode:'normal', maxRetries:0 } } : {}) } } } },
    { id:'acp', config:{ provider:authorRoute.provider, model:authorRoute.model } },
    { id:'agent-default-model', config:authorRoute },
    { id:'session-persistence-jsonl', config:{ root:sessionRoot } },
    { id:'session-log-deepseek', config:{ enabled:false } },
    { id:'session-title-llm', disabled:true },
    ...['tool-skill','tool-working-directory','tool-fs','tool-fs-search','tool-bash','tool-pwsh','tool-jobs','tool-web',
      'tool-subagent','tool-subagent-fork','tool-subagent-control','tool-subagent-list-agents','tool-workflow',
      'tool-plugin-manager','tool-todo','tool-goal'].map(id => ({ id, disabled:true }))
  ]));
  const networkTrace = new URL('./harness-network-trace.mjs', import.meta.url).href;
  const args = [...(electron ? ['--expose-internals','--import',networkTrace] : []), ...(entry ? [entry] : []),
    '--profile','acp','--patch',patch];
  const child = spawn(command, args, { cwd, windowsHide:true, env:{ ...process.env, DSH_TELEMETRY_MODE:'DISABLED',
    ...(electron ? { ELECTRON_RUN_AS_NODE:'1', STUDIO_HARNESS_NETWORK_TRACE:join(attemptDir,'network.jsonl') } : {}) },
    stdio:['pipe','pipe','pipe'] });
  const stream=join(attemptDir,'author-stream.txt');
  let nextId=0, response='', responseBytes=0, diagnostics='', promptSession;
  const pending=new Map(), trace=[];
  const abort=error=>{for (const cb of pending.values()) cb.reject(error); pending.clear();};
  child.on('error', abort);
  child.stdin.on('error', abort);
  child.on('exit', code=>abort(new Error('Harness ACP 退出：' + code)));
  child.stderr.on('data', data=>{ diagnostics=(diagnostics+data).slice(-2000); });
  const send=packet=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...packet})+'\n');
  const lines=createInterface({input:child.stdout});
  lines.on('line', line=>{
    let packet; try {packet=JSON.parse(line);} catch {return;}
    if (packet.method && packet.id!==undefined) {
      send({id:packet.id,result:{outcome:{outcome:'cancelled'}}});
      return;
    }
    const event=packet.method==='session/update' && packet.params?.update;
    if(event && promptSession && packet.params.sessionId===promptSession) {
      trace.push(event.sessionUpdate);
      if(event.sessionUpdate==='agent_message_chunk' && event.content?.type==='text') {
        try {
          const chunk=event.content.text;
          responseBytes+=Buffer.byteLength(chunk);
          check(responseBytes<=2*1024*1024,'Harness 动画输出超过大小上限');
          appendFileSync(stream,chunk,'utf8');
          response+=chunk;
        } catch(error) { abort(error); }
      }
    }
    const cb=pending.get(packet.id);
    if(cb) {
      pending.delete(packet.id);
      if(packet.error) cb.reject(new Error(JSON.stringify(packet.error)));
      else cb.resolve(packet.result);
    }
  });
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++nextId; pending.set(id,{resolve,reject}); send({id,method,params});
  });
  const timeout=setTimeout(()=>{abort(new Error('Harness ACP 等待超时'));child.kill();},timeoutMs);
  const evidence={host:'DeepSeek Harness ACP',route:authorRoute};
  try {
    await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'studio-animation',version:'1.0.0'}});
    const opened=priorSession ? await rpc('session/resume',{sessionId:priorSession,cwd,mcpServers:[]}) :
      await rpc('session/new',{cwd,mcpServers:[]});
    const sessionId=priorSession ?? opened.sessionId;
    check(sessionId, 'Harness 未返回作者会话 ID');
    evidence.sessionId=sessionId;
    const config=opened.configOptions ?? [];
    check(config.find(item=>item.id==='model')?.currentValue===JSON.stringify([authorRoute.provider,authorRoute.model]),
      'Harness 实际作者模型与冻结配置不符');
    const effort=config.find(item=>item.category==='thought_level');
    check(effort?.options?.some(item=>item.value==='high'), '当前作者路由无法选择 High');
    const selected=await rpc('session/set_config_option',{sessionId,configId:effort.id,value:'high'});
    check(selected.configOptions?.some(item=>item.id===effort.id && item.currentValue==='high'), 'Harness 未确认 High');
    evidence.reasoningSelection=selected.configOptions.find(item=>item.id===effort.id).currentValue;
    await writeFile(join(attemptDir,'prompt-intent.json'),JSON.stringify(evidence),{flag:'wx',flush:true});
    promptSession=sessionId;
    const result=await rpc('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]});
    check(result?.stopReason==='end_turn' && response.trim(), 'Harness 作者未完整交付');
    const visual=JSON.parse(response.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/g,''));
    const completed={ visual, evidence:{ ...evidence, result, trace } };
    if(saveResponse) await saveResponse(completed);
    return completed;
  } catch(error) {
    await writeFile(join(attemptDir,'host-failure.json'),JSON.stringify({ ...evidence, trace, error:error.message,
      diagnostics:diagnostics.replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]') }));
    throw error;
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}
