import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { check, encode, rootAt } from './store.mjs';
import * as studio from './studio.mjs';
import { mediaCheck } from './media-check.mjs';

const commands = {
  init: ['workspace', 'customer', 'mode'],
  start: ['workspace', 'brief'],
  status: ['workspace', 'run'],
  next: ['workspace', 'run'],
  submit: ['workspace', 'run', 'stage', 'task-sha', 'file', 'origin'],
  author: ['workspace', 'run', 'stage', 'task-sha', 'allow-network'],
  export: ['workspace', 'run'],
  feedback: ['workspace', 'run', 'stage', 'node', 'result-sha', 'feedback-id', 'file', 'adopted-file'],
  'media-check': ['file'],
  doctor: []
};

const textFile = async path => new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolve(path)));
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') return { version: studio.version, commands };
  check(Object.hasOwn(commands, command), '未知命令；运行 --help 查看可用命令');
  const options = Object.fromEntries(commands[command].map(key => [key, { type: 'string' }]));
  const { values: a } = parseArgs({ args, options });
  const required = commands[command].filter(key => !['origin', 'allow-network', 'adopted-file'].includes(key));
  check(required.every(k => a[k]), '缺少参数：' + required.filter(k => !a[k]).map(k => '--' + k).join(' '));
  check(a['allow-network'] === undefined || a['allow-network'] === 'true', '--allow-network 只接受 true');
  if (command === 'doctor') return { node: process.version, studio: studio.version, supportedNode: Number(process.versions.node.split('.')[0]) >= 22 };
  check(Number(process.versions.node.split('.')[0]) >= 22, '请安装 Node.js 22 或更新的 LTS 版本');
  if (command === 'media-check') return mediaCheck(resolve(a.file));
  const root = await rootAt(a.workspace, command === 'init');
  const id = a.run;
  switch (command) {
    case 'init': return studio.init(root, a);
    case 'start': return studio.start(root, await textFile(a.brief));
    case 'status': return studio.status(root, id);
    case 'next': return studio.next(root, id);
    case 'submit': return studio.submit(root, id, { stage: a.stage, taskSha256: a['task-sha'], origin: a.origin, text: await textFile(a.file) });
    case 'author': return studio.author(root, id, { stage: a.stage, taskSha256: a['task-sha'], allowNetwork: a['allow-network'] === 'true' });
    case 'export': return studio.exportNarration(root, id);
    case 'feedback': return studio.feedback(root, id, { stage: a.stage, node: a.node, resultSha256: a['result-sha'],
      feedbackId: a['feedback-id'], comment: await textFile(a.file), adopted: a['adopted-file'] ? await textFile(a['adopted-file']) : undefined });
  }
}

try { process.stdout.write(encode(await main())); }
catch (e) { process.stderr.write(encode({ error: e.message, code: e.code })); process.exitCode = 1; }
