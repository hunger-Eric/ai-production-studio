import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, entries, get, hash, inside, now, read, record, ensure, slug } from './store.mjs';
import { mediaTool } from './media-check.mjs';

export const styleDirectory = '02 写稿与制作/动画参考/代码动画画风库';
export const sceneRequirements = '02 写稿与制作/动画参考/正片动画要求.md';
const styleKey = /^[a-z0-9-]+:[a-z0-9-]+$/;
const readPath = (base, key) => base + '/references/' + key.replace(':', '--') + '.json';

export async function animationStyleCatalog(root) {
  const catalog = [];
  const files = (await entries(root, styleDirectory)).filter(file => /^[A-Z](?:-[A-Z])?\.md$/.test(file));
  for (const file of files) {
    const body = await read(root, styleDirectory + '/' + file, { limit: 128 * 1024 });
    const series = file.slice(0, -3);
    for (const line of body.split(/\r?\n/)) {
      const row = /^- \*\*([^*]+)\*\*\s*·\s*(.*?)\s*·\s*\[原提示词\]\(([^)]+)\)/u.exec(line);
      if (!row) continue;
      const [, title, category, prompt] = row;
      const id = title.trim().split(/\s+/u)[0];
      const frame = /\[(?:参考静帧|静帧|参考图)\]\(([^)]+)\)/u.exec(line)?.[1];
      const key = (series + ':' + id).toLowerCase();
      check(styleKey.test(key), '画风索引标识无效：' + series + ' / ' + id);
      catalog.push({ key, series, title: title.trim(), category, prompt, frame });
    }
  }
  check(catalog.length > 0 && new Set(catalog.map(item => item.key)).size === catalog.length, '画风索引为空或标识重复');
  return catalog;
}

function rawGithub(source) {
  const url = new URL(source);
  const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/blob\/([a-f0-9]{40})\/(.+)$/u.exec(url.pathname);
  check(url.origin === 'https://github.com' && match && !url.search && !url.hash, '参考必须使用锁定版本的 GitHub 文件');
  return 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + match[3];
}

async function fetchBytes(source, limit) {
  const result = await fetch(rawGithub(source), { signal: AbortSignal.timeout(30000), redirect: 'error' });
  check(result.ok && result.body, '参考来源暂不可读取：HTTP ' + result.status);
  const chunks = [];
  let size = 0;
  const reader = result.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      check(size <= limit, '参考文件超过大小上限');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export async function frozenStyle(root, base, key) {
  check(styleKey.test(key), '画风标识无效');
  const saved = await get(root, readPath(base, key), true);
  if (!saved) return;
  if (saved.payload.image) {
    const data = await readFile(await inside(root, saved.payload.image.file));
    check(hash(data) === saved.payload.image.sha256, '参考静帧文件已变化');
    return { ...saved, image: { type: 'image', mimeType: 'image/jpeg', data: data.toString('base64') } };
  }
  return saved;
}

export async function captureStyle(root, base, key) {
  const previous = await frozenStyle(root, base, key);
  if (previous) return previous;
  const entry = (await animationStyleCatalog(root)).find(item => item.key === key);
  check(entry, 'Obsidian 画风目录没有这一条');
  const text = await fetchBytes(entry.prompt, 192 * 1024);
  const promptText = new TextDecoder('utf-8', { fatal: true }).decode(text);
  check(promptText.trim(), '参考原提示词正文为空');
  let image;
  if (entry.frame) {
    const bytes = await fetchBytes(entry.frame, 12 * 1024 * 1024);
    const dir = await mkdtemp(join(tmpdir(), 'studio-style-'));
    const input = join(dir, 'input');
    const output = join(dir, 'reference.jpg');
    await import('node:fs/promises').then(fs => fs.writeFile(input, bytes));
    await mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-frames:v', '1',
      '-vf', "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease", '-update', '1', output], 30000, dir);
    const normalized = await readFile(output);
    const file = base + '/references/' + slug(key.replace(':', '--')) + '-' + hash(normalized).slice(0, 16) + '.jpg';
    await ensure(root, file, normalized);
    image = { file, sha256: hash(normalized), sourceSha256: hash(bytes) };
  }
  try {
    await record(root, readPath(base, key), { ...entry, promptText, promptSha256: hash(text), image, capturedAt: now() });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return frozenStyle(root, base, key);
}
