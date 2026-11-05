import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { init } from '../engine/studio.mjs';

const engine = resolve(import.meta.dirname, '../engine');
const require = createRequire(join(engine, 'package.json'));
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')));

test('stdio MCP reconnects to the same run and verifies an Obsidian feedback write', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'studio-mcp-'));
  await init(workspace, { customer: '虚构甲', mode: 'fixture' });
  for (const node of ['business', 'capabilities']) {
    await writeFile(join(workspace, 'knowledge', node, 'body.md'), '虚构客户正文：仓库收货复核');
  }
  let client;
  t.after(() => client?.close());
  async function connect() {
    client = new Client({ name: 'studio-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(engine, 'studio-mcp.mjs'), '--workspace', workspace]
    }));
  }
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  async function call(name, args) {
    const result = await raw(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    return result.structuredContent;
  }
  async function submit(runId, stage) {
    const task = await call('run_next', { runId });
    assert.equal(task.payload.stage, stage);
    return call('stage_submit', { runId, stage, taskSha256: task.sha256, text: '离线阶段正文 ' + stage });
  }
  await connect();
  const catalog = await client.listTools();
  assert.ok(catalog.tools.some(tool => tool.name === 'production_next'));
  assert.ok(!catalog.tools.some(tool => tool.name === 'author_generate'));
  assert.equal((await call('workspace_info')).customer, '虚构甲');
  assert.equal((await raw('workspace_info', { workspace: '../another-vault' })).isError, true);
  const { id: runId } = await call('run_start', { brief: '离线验证仓库收货' });
  await submit(runId, 'topic');
  await client.close();

  await connect();
  assert.equal((await call('run_status', { runId })).state, 'research');
  let final;
  for (const stage of ['research', 'direction', 'draft', 'edit']) final = await submit(runId, stage);
  const exported = await call('narration_export', { runId });
  assert.equal(await readFile(exported.path, 'utf8'), '离线阶段正文 edit');
  const input = { runId, stage: 'edit', node: 'narration', resultSha256: final.resultSha256,
    feedbackId: 'offline-review', comment: '交接要更清楚', adopted: '写明由谁复核' };
  assert.equal((await raw('feedback_write', { ...input, resultSha256: '0'.repeat(64) })).isError, true);
  const written = await call('feedback_write', input);
  assert.equal(written.outcome, 'local_readback_verified');
  assert.match(await readFile(join(workspace, written.note), 'utf8'), /写明由谁复核/);
  assert.deepEqual(await call('feedback_write', input), written);
  const fresh = await call('run_start', { brief: '离线验证新任务反馈' });
  await submit(fresh.id, 'topic');
  await submit(fresh.id, 'research');
  const direction = await call('run_next', { runId: fresh.id });
  assert.equal(direction.payload.knowledge.find(n => n.id === 'narration').feedback[0].adopted, input.adopted);
});
