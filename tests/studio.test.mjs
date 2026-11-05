import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const project = resolve(import.meta.dirname, '..');
const entry = process.env.STUDIO_TEST_ENTRY || join(project, 'engine', 'studio-cli.mjs');
const run = (...args) => JSON.parse(execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
const failure = (regex, ...args) => assert.throws(() => run(...args), e => regex.test(e.stderr));
const use = (cmd, root, ...args) => run(cmd, '--workspace', root, ...args);
const create = (root, name, mode = 'fixture') => use('init', root, '--customer', name, '--mode', mode);

test('two independent Obsidian vaults: exact stage input, restart, readback, and subsequent feedback', async () => {
  const testRoot = await mkdtemp(join(tmpdir(), 'studio-obsidian-'));
  const alpha = join(testRoot, '甲企业 Vault'), beta = join(testRoot, '乙企业 Vault');
  const brief = join(testRoot, 'brief.md'), draft = join(testRoot, 'offline.md');
  await writeFile(brief, '【虚构测试】做一条面向仓库负责人的口播');
  await writeFile(draft, '【离线夹具】这是阶段输入与输出绑定的验证文字。');
  const a = create(alpha, '虚构甲'), b = create(beta, '虚构乙');
  assert.notEqual(a.workspaceId, b.workspaceId);
  const home = await readFile(join(alpha, '工作台首页.md'), 'utf8');
  assert.match(home, /\[\[knowledge\/capabilities\/body\|真实能力/);
  failure(/缺少正文/, 'start', '--workspace', alpha, '--brief', brief);
  for (const [root, marker] of [[alpha, '甲独有：按到货记录排查漏收'], [beta, '乙独有：整理退件异常']]) {
    await writeFile(join(root, 'knowledge/business/body.md'), marker);
    await writeFile(join(root, 'knowledge/capabilities/body.md'), marker + '，交付复核表。');
    await writeFile(join(root, 'knowledge/audio/body.md'), '声音专用正文');
  }
  assert.equal(create(alpha, '虚构甲').workspaceId, a.workspaceId);
  assert.match(await readFile(join(alpha, 'knowledge/business/body.md'), 'utf8'), /甲独有/);
  failure(/已归属其他客户/, 'init', '--workspace', alpha, '--customer', '其他', '--mode', 'fixture');

  const ra = use('start', alpha, '--brief', brief).id, rb = use('start', beta, '--brief', brief).id;
  const next = root => use('next', root, '--run', root === alpha ? ra : rb);
  assert.match(JSON.stringify(next(alpha)), /甲独有/);
  assert.doesNotMatch(JSON.stringify(next(beta)), /甲独有/);
  assert.doesNotMatch(JSON.stringify(next(alpha)), /声音专用正文/);
  failure(/目录不存在/, 'next', '--workspace', beta, '--run', ra);

  await writeFile(join(alpha, 'knowledge/business/body.md'), '甲更新后的企业正文');
  let result;
  for (const stage of ['topic', 'research', 'direction', 'draft', 'edit']) {
    const task = next(alpha);
    assert.equal(task.payload.stage, stage);
    assert.match(JSON.stringify(task.payload.knowledge), /甲独有/);
    assert.doesNotMatch(JSON.stringify(task.payload.knowledge), /甲更新后的/);
    assert.equal(Boolean(task.payload.rewrite), stage === 'edit');
    if (stage === 'edit') assert.equal(task.payload.rewrite.length, 4);
    if (stage === 'draft') failure(/禁止模型调用/, 'author', '--workspace', alpha, '--run', ra, '--stage', stage, '--task-sha', task.sha256, '--allow-network', 'true');
    const opts = ['--run', ra, '--stage', stage, '--file', draft];
    failure(/工作单 SHA/, 'submit', '--workspace', alpha, ...opts, '--task-sha', 'bad');
    result = use('submit', alpha, ...opts, '--task-sha', task.sha256);
    assert.equal(result.outcome, 'offline_fixture');
    assert.deepEqual(use('submit', alpha, ...opts, '--task-sha', task.sha256), result);
  }
  assert.equal(use('status', alpha, '--run', ra).state, 'needs_tts');
  const exported = use('export', alpha, '--run', ra);
  assert.match(exported.path, /narration\.fixture\.md$/);
  assert.equal(await readFile(exported.path, 'utf8'), await readFile(draft, 'utf8'));

  const notes = join(testRoot, 'feedback.md'), adopted = join(testRoot, 'adopted.md');
  await writeFile(notes, '希望更清楚地讲清如何交接。');
  await writeFile(adopted, '甲反馈标记：讲清交接人如何复核。');
  const opts = ['--run', ra, '--stage', 'edit', '--result-sha', result.resultSha256,
    '--feedback-id', 'feedback-one', '--file', notes, '--adopted-file', adopted];
  failure(/反馈必须绑定/, 'feedback', '--workspace', alpha, ...opts, '--node', 'audio');
  const written = use('feedback', alpha, ...opts, '--node', 'narration');
  assert.equal(written.outcome, 'local_readback_verified');
  const feedbackNote = await readFile(join(alpha, written.note), 'utf8');
  assert.match(feedbackNote, /\[\[knowledge\/narration\/body\]\]/);
  assert.match(feedbackNote, new RegExp(ra + '/edit-result'));
  assert.deepEqual(use('feedback', alpha, ...opts, '--node', 'narration'), written);
  const newId = use('start', alpha, '--brief', brief).id;
  const frozen = JSON.parse(await readFile(join(alpha, 'runs', newId, 'run.json'), 'utf8')).payload;
  assert.match(JSON.stringify(frozen.nodes.narration.feedback), /甲反馈标记/);
  const old = JSON.parse(await readFile(join(alpha, 'runs', ra, 'run.json'), 'utf8')).payload;
  assert.deepEqual(old.nodes.narration.feedback, []);
  assert.doesNotMatch(JSON.stringify(next(beta)), /甲反馈标记/);
  await writeFile(notes, '不同的反馈不能覆盖原反馈');
  failure(/已对应另一份记录/, 'feedback', '--workspace', alpha, ...opts, '--node', 'narration');
});

test('production cannot substitute fixture or dispatch without authorization or credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-author-'));
  const file = join(root, 'test.md');
  await writeFile(file, '【仅测试】测试材料');
  create(root, '虚构生产接口测试', 'production');
  for (const node of ['business', 'capabilities']) await writeFile(join(root, 'knowledge', node, 'body.md'), '虚构知识正文');
  const id = use('start', root, '--brief', file).id;
  for (const stage of ['topic', 'research', 'direction']) {
    const task = use('next', root, '--run', id);
    use('submit', root, '--run', id, '--stage', stage, '--task-sha', task.sha256, '--file', file, '--origin', '离线测试 owner 声明');
  }
  const task = use('next', root, '--run', id);
  const args = ['--workspace', root, '--run', id, '--stage', 'draft', '--task-sha', task.sha256];
  failure(/只接受已登记 Gemini/, 'submit', ...args, '--file', file, '--origin', '夹具');
  failure(/调用未授权/, 'author', ...args);
  const original = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try { failure(/缺少客户 GEMINI_API_KEY/, 'author', ...args, '--allow-network', 'true'); }
  finally { if (original !== undefined) process.env.GEMINI_API_KEY = original; }
  assert.equal(use('status', root, '--run', id).requestState, undefined);
});
