import { createHash, randomUUID } from 'node:crypto';
import { lstat, link, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, isAbsolute, relative, sep } from 'node:path';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const encode = value => JSON.stringify(value, null, 2) + '\n';
export function check(condition, message) { if (!condition) throw new Error(message); }
export function slug(value) {
  check(typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value), '无效标识：使用小写字母、数字和连字符');
  return value;
}
export function body(value, label) {
  check(typeof value === 'string' && value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, '').trim(), label + '缺少正文');
  return value;
}

async function stat(path) {
  try { return await lstat(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export async function rootAt(path, create = false) {
  const abs = resolve(path);
  if (create) await mkdir(abs, { recursive: true });
  return realpath(abs);
}

export async function inside(root, path, { directories = false, create = false } = {}) {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  check(rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel), '路径超出工作区');
  let current = root;
  const parts = rel.split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const dir = index < parts.length - 1 || directories;
    if (dir && create) await mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await stat(current);
    if (!st) {
      check(!dir, '工作区目录不存在：' + rel);
    } else {
      check(!st.isSymbolicLink() && (dir ? st.isDirectory() : st.isFile()),
        '工作区禁止链接或不匹配的文件类型：' + rel);
    }
  }
  return abs;
}

export async function read(root, path, { optional = false, limit = 2 * 1024 * 1024 } = {}) {
  const abs = await inside(root, path);
  const st = await stat(abs);
  if (!st && optional) return undefined;
  check(st && st.size <= limit, '文件缺失或超过大小上限：' + path);
  return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(abs));
}

// 同卷硬链接提交：单步发布，不覆盖既有记录；临时文件永不作为业务状态读取。
export async function publish(root, path, value) {
  const abs = await inside(root, path, { create: true });
  const tmp = join(dirname(abs), '.tmp-' + randomUUID());
  try {
    await writeFile(tmp, value, { flag: 'wx', mode: 0o600, flush: true });
    await link(tmp, abs);
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function ensure(root, path, value) {
  try { await publish(root, path, value); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
}

export async function record(root, path, payload) {
  const raw = encode(payload);
  await publish(root, path, encode({ sha256: hash(raw), payload }));
}

export async function get(root, path, optional = false, limit) {
  const raw = await read(root, path, { optional, limit });
  if (raw === undefined) return;
  const entry = JSON.parse(raw);
  check(entry && entry.sha256 === hash(encode(entry.payload)), '记录完整性校验失败：' + path);
  return entry;
}

export async function entries(root, path) {
  return (await readdir(await inside(root, path, { directories: true }))).sort();
}
