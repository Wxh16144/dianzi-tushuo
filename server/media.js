import fsp from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import mime from 'mime-types';
import dayjs from 'dayjs';
import { execa } from 'execa';
import { AUDIO_DIR, IMAGES_DIR, TMP_DIR, BIN } from './config.js';
import { MAX_IMAGES_PER_REQUEST, MAX_UPLOAD_BYTES } from './schema.js';
import { log } from './logger.js';
import { createCache, hashKey, sha256 } from './cache.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

export const uploadMany = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_IMAGES_PER_REQUEST },
});

/** 音频转码缓存：同一段录音的 mp3 只转一次 */
const audioCache = createCache('audio-transcode', { maxAgeMs: 30 * 24 * 3600 * 1000, maxBytes: 256 * 1024 * 1024 });

const IMAGE_MAX_EDGE = 2000;
const IMAGE_JPEG_QUALITY = 85;

const toSeq = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);

/** 文件名 = 页签序-条目序-时间戳，重排序/重命名页签都不改变已有文件路径 */
export function baseName(sectionSeq, itemSeq) {
  const stamp = dayjs().format('YYYYMMDD-HHmmss');
  return `${String(toSeq(sectionSeq)).padStart(2, '0')}-${String(toSeq(itemSeq)).padStart(2, '0')}-${stamp}`;
}

export async function processImage(buffer, { sectionSeq, itemSeq, suffix = '' }) {
  const base = `${baseName(sectionSeq, itemSeq)}${suffix}`;

  const input = sharp(buffer, { failOn: 'none', animated: false }).rotate();
  const meta = await input.metadata();
  const hasAlpha = Boolean(meta.hasAlpha);

  const pipeline = input.resize({
    width: IMAGE_MAX_EDGE,
    height: IMAGE_MAX_EDGE,
    fit: 'inside',
    withoutEnlargement: true,
  });

  const output = hasAlpha
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
    : await pipeline.jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true }).toBuffer();

  const outMeta = await sharp(output).metadata();
  const fileName = `${base}.${hasAlpha ? 'png' : 'jpg'}`;
  await fsp.writeFile(path.join(IMAGES_DIR, fileName), output);

  log.media.debug({ file: fileName, bytes: output.length }, '图片已保存');
  return {
    file: `images/${fileName}`,
    url: `/images/${fileName}`,
    w: outMeta.width ?? null,
    h: outMeta.height ?? null,
  };
}

/** 一批图片共用同一个时间戳，用 -1、-2 后缀区分 */
export async function processImages(buffers, { sectionSeq, itemSeq }) {
  const multi = buffers.length > 1;
  const results = [];
  for (const [index, buffer] of buffers.entries()) {
    results.push(await processImage(buffer, { sectionSeq, itemSeq, suffix: multi ? `-${index + 1}` : '' }));
  }
  return results;
}

/**
 * 常见录音格式的扩展名。
 * 不用 mime.extension 直接映射，因为它会把 audio/mpeg 映射成 mpga、
 * 把 audio/mp4 映射成 mp4，和浏览器录音的实际情况不符。
 */
const AUDIO_EXT_BY_MIME = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const SAFE_EXT_RE = /^(webm|ogg|opus|m4a|mp4|aac|mp3|wav|flac)$/;

export function guessAudioExt(mimetype = '', originalName = '') {
  const clean = String(mimetype).split(';')[0].trim().toLowerCase();

  if (AUDIO_EXT_BY_MIME[clean]) return AUDIO_EXT_BY_MIME[clean];

  const fromName = path.extname(String(originalName)).replace('.', '').toLowerCase();
  if (SAFE_EXT_RE.test(fromName)) return fromName === 'mp4' ? 'm4a' : fromName;

  // 兜底：mime-types 认识的其它音频类型（过滤掉 mpga/weba 这类别名）
  const fromMime = mime.extension(clean);
  if (fromMime && SAFE_EXT_RE.test(fromMime)) return fromMime;

  return 'webm';
}

export async function probeDuration(file) {
  if (!BIN.ffprobe) return null;
  try {
    const { stdout } = await execa(BIN.ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const value = Number.parseFloat(String(stdout).trim());
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
  } catch {
    return null;
  }
}

const clientSeconds = (value) => (Number(value) > 0 ? Math.round(Number(value) * 100) / 100 : null);

/**
 * 录音统一转 mp3（单声道 96k）。没有 ffmpeg 或转码失败时原样保存，保证功能可用。
 */
export async function processAudio(buffer, { mimetype, originalName, sectionSeq, itemSeq, clientDuration }) {
  const base = baseName(sectionSeq, itemSeq);
  const fallbackExt = guessAudioExt(mimetype, originalName);
  const fallbackMime = String(mimetype || '').split(';')[0].trim() || 'audio/webm';

  const fallback = async (reason) => {
    const fileName = `${base}.${fallbackExt}`;
    await fsp.writeFile(path.join(AUDIO_DIR, fileName), buffer);
    if (reason) log.media.warn({ file: fileName, reason }, '音频未转码，已原样保存');
    return {
      file: `audio/${fileName}`,
      url: `/audio/${fileName}`,
      duration: clientSeconds(clientDuration),
      format: fallbackExt,
      mime: fallbackMime,
      converted: false,
    };
  };

  if (!BIN.ffmpeg) return fallback('未找到 ffmpeg');

  // 转码是「输入字节 → 输出 mp3」的纯函数，参数固定，所以按内容哈希缓存。
  // 同一段录音重新上传 / 重新转码时直接复用上次的 mp3，省掉一次 ffmpeg。
  const TRANSCODE_SIGNATURE = 'mp3-mono-44100-96k-v1';
  const cacheKey = hashKey(TRANSCODE_SIGNATURE, sha256(buffer));
  const hit = await audioCache.get(cacheKey);
  if (hit) {
    const fileName = `${base}.mp3`;
    const outputPath = path.join(AUDIO_DIR, fileName);
    await fsp.writeFile(outputPath, hit.data);
    const duration = (await probeDuration(outputPath)) ?? clientSeconds(clientDuration);
    log.media.debug({ file: fileName, cache: 'hit' }, '音频转码命中缓存');
    return {
      file: `audio/${fileName}`,
      url: `/audio/${fileName}`,
      duration,
      format: 'mp3',
      mime: 'audio/mpeg',
      converted: true,
      cached: true,
    };
  }

  const inputPath = path.join(TMP_DIR, `${base}.${fallbackExt}`);
  const fileName = `${base}.mp3`;
  const outputPath = path.join(AUDIO_DIR, fileName);

  try {
    await fsp.writeFile(inputPath, buffer);
    await execa(
      BIN.ffmpeg,
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', inputPath,
        '-vn', '-ac', '1', '-ar', '44100',
        '-c:a', 'libmp3lame', '-b:a', '96k',
        outputPath,
      ],
      { timeout: 60_000 },
    );

    const outputBytes = await fsp.readFile(outputPath);
    await audioCache.set(cacheKey, outputBytes).catch((err) => log.media.warn({ err: err.message }, '写转码缓存失败'));

    const duration = (await probeDuration(outputPath)) ?? clientSeconds(clientDuration);
    log.media.debug({ file: fileName, duration }, '音频已转 mp3');

    return {
      file: `audio/${fileName}`,
      url: `/audio/${fileName}`,
      duration,
      format: 'mp3',
      mime: 'audio/mpeg',
      converted: true,
      cached: false,
    };
  } catch (err) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    return fallback(err.shortMessage || err.message);
  } finally {
    await fsp.rm(inputPath, { force: true }).catch(() => {});
  }
}
