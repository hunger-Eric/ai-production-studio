import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { check, now } from './store.mjs';

const exec = promisify(execFile);
export async function fingerprint(path) {
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(path)) sha.update(chunk);
  return sha.digest('hex');
}

export async function mediaTool(exe, args, timeout, cwd, env) {
  try { return await exec(exe, args, { timeout, cwd, env, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); }
  catch (e) { throw new Error(exe + (e.code === 'ENOENT' ? ' 未安装或不在 PATH' : ' 执行失败：' + String(e.stderr ?? '').trim().slice(-800))); }
}

export async function mediaCheck(file) {
  check((await stat(file)).isFile(), '媒体必须是本地文件');
  const sha256 = await fingerprint(file);
  const startedAt = now();
  const { stdout } = await mediaTool('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file], 60_000);
  const { streams, format } = JSON.parse(stdout);
  const picture = streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams?.find(s => s.codec_type === 'audio');
  check(picture && audio, '整片必须同时包含实际画面和声音流');
  check(Number(format?.duration) > 0, '媒体时长无效');
  await mediaTool('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', file,
    '-map', '0:' + picture.index, '-map', '0:' + audio.index, '-f', 'null', '-'], 600_000);
  check(await fingerprint(file) === sha256, '检查时媒体已发生变化');
  return { sha256, executor: 'code', handler: 'media-check.v1', technical: 'decoded', startedAt, finishedAt: now(),
    durationSeconds: Number(format.duration), picture: { width: picture.width, height: picture.height, codec: picture.codec_name },
    audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate) }, contentReview: 'not_performed' };
}
