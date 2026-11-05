import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { invokeHarnessAuthor } from '../engine/harness-author.mjs';

test('author transport selects High, disables general tools, and resumes the same session', async t => {
  const root=await mkdtemp(join(tmpdir(),'studio-acp-'));
  const keys=['STUDIO_HARNESS_COMMAND','STUDIO_HARNESS_ENTRY','STUDIO_HARNESS_ELECTRON'];
  const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const k of keys) if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];});
  process.env.STUDIO_HARNESS_COMMAND=process.execPath;
  process.env.STUDIO_HARNESS_ENTRY=fileURLToPath(new URL('./fixtures/harness-acp.mjs',import.meta.url));
  delete process.env.STUDIO_HARNESS_ELECTRON;
  const a=join(root,'first'), b=join(root,'second');
  await Promise.all([mkdir(a),mkdir(b)]);
  const common={cwd:root,sessionRoot:join(root,'sessions'),prompt:'离线协议测试'};
  const first=await invokeHarnessAuthor({...common,attemptDir:a});
  const second=await invokeHarnessAuthor({...common,attemptDir:b,priorSession:first.evidence.sessionId});
  assert.equal(second.evidence.sessionId,first.evidence.sessionId);
  assert.equal(second.evidence.reasoningSelection,'high');
  const patch=JSON.parse(await readFile(join(a,'harness-patch.json'),'utf8'));
  assert.equal(patch.find(row=>row.id==='tool-skill').disabled,true);
  assert.equal(patch.find(row=>row.id==='tool-pwsh').disabled,true);
});
