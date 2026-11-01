import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import sharp from 'sharp';
import { BIN, DATA_DIR, TMP_DIR, TTS_CACHE_DIR, VIDEO, VIDEO_CACHE_DIR, VIDEO_DIR } from './config.js';
import { ensureDirs } from './db.js';
import { log } from './logger.js';
import { probeDuration } from './media.js';

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
/** 章节/合集视频里，条目之间的中央标题过渡停留时长 */
const TITLE_CARD_SECONDS = 0.9;
/** 标题过渡的轻切换音效时长（whoosh，放在过渡开头，剩余时长自然静音） */
const TITLE_SOUND_SECONDS = 0.4;
/** 标题过渡音效缓存文件名（音效固定，缓存一次即可） */
const TITLE_SOUND_FILE = 'transition-whoosh.m4a';
/** TTS 朗读时每个换行处插入的停顿时长（毫秒），用 macOS say 的 [[slnc N]] 内嵌指令 */
const TTS_NEWLINE_PAUSE_MS = 400;

const badRequest = (message, status) => Object.assign(new Error(message), { status });

const round3 = (n) => Math.round(n * 1000) / 1000;

/* ---------------- 缓存 ---------------- */

/** 稳定短 hash（sha1 前 20 位） */
function hashStr(input) {
  return createHash('sha1').update(String(input)).digest('hex').slice(0, 20);
}

/** 视频「画面」配置签名：只含影响画面的项，不含音频来源/语音，供无音频视频轨缓存复用 */
function cfgVideoSig(cfg) {
  return [
    cfg.width, cfg.height, cfg.fps, cfg.secondsPerImage, cfg.transSeconds,
    cfg.burnText ? 1 : 0, cfg.fontFamily,
  ].join('|');
}

/** 完整配置签名：含音频来源/语音，供最终合成缓存使用 */
function cfgSig(cfg) {
  return [cfgVideoSig(cfg), cfg.audioSource, cfg.ttsVoice].join('|');
}

/** 进度条签名：进度条内容/位置变了，缓存就失效 */
function progressSig(progress) {
  return progress ? `${progress.labels.join(',')}@${progress.activeIndex}` : '';
}

/**
 * 计算 item 视频片段的缓存 key（纯函数）。
 * 输入 = 图片相对路径 + 各图片文件签名(size:mtime) + 文案 + 标题 + 音频相对路径/签名 + 配置 + 进度条。
 */
export function itemCacheKey({ imageRels, imageSigs, text, title, audioRel, audioSig, cfg, progress }) {
  return hashStr([
    (imageRels ?? []).join('|'),
    (imageSigs ?? []).join('|'),
    text ?? '',
    title ?? '',
    audioRel ?? '',
    audioSig ?? '',
    cfgSig(cfg),
    progressSig(progress),
  ].join('\n'));
}

/**
 * 计算「无音频视频轨」的缓存 key：与音频完全解耦。
 * 切换 TTS 语音 / 录音时视频轨可复用，只需重新合并音频。
 */
export function videoItemCacheKey({ imageRels, imageSigs, text, title, cfg, progress }) {
  return hashStr([
    (imageRels ?? []).join('|'),
    (imageSigs ?? []).join('|'),
    text ?? '',
    title ?? '',
    cfgVideoSig(cfg),
    progressSig(progress),
  ].join('\n'));
}

/** 计算标题过渡片段的缓存 key（标题卡片不含音频，用画面签名） */
export function titleCacheKey({ title, subtitle, cfg }) {
  return hashStr([`title:${title}`, `sub:${subtitle}`, cfgVideoSig(cfg)].join('\n'));
}

/** 文件签名：size + mtime，文件变化则缓存失效；不存在返回 null */
async function fileSig(absPath) {
  try {
    const s = await fsp.stat(absPath);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** 语音来源：auto 时按「有录音用录音，无录音用 TTS」决策（纯函数） */
export function resolveAudioSource(audioSource, hasRecording) {
  if (audioSource === 'recording') return 'recording';
  if (audioSource === 'tts') return 'tts';
  return hasRecording ? 'recording' : 'tts';
}

/** TTS 读什么：文案优先，无文案读标题，都空返回 null（纯函数） */
export function ttsTextFor(item) {
  const text = String(item?.text ?? '').trim();
  if (text) return text;
  const title = String(item?.title ?? '').trim();
  return title || null;
}

/**
 * 把多行文案转换成带停顿的朗读文本：每个换行处插入一段静音，
 * 让语音在换行处自然停顿一下，而不是连读。纯函数，便于单测。
 */
export function ttsPauseText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(` [[slnc ${TTS_NEWLINE_PAUSE_MS}]] `);
}

/**
 * 用 macOS say 生成 TTS 音频，按 voice+text 缓存到 data/cache/tts/。
 * 返回缓存文件路径；无 say 命令或内容为空返回 null。
 */
export async function ensureTts(text, voice = 'Tingting') {
  const content = ttsPauseText(text);
  if (!content || !BIN.say) return null;
  const key = hashStr([voice, content].join('\n'));
  const outPath = path.join(TTS_CACHE_DIR, `${key}.m4a`);
  if (fs.existsSync(outPath)) return outPath;

  await ensureDirs();
  log.video.info({ voice, chars: content.length }, '生成 TTS 配音');
  await execa(BIN.say, ['-v', voice, '-o', outPath, content], { timeout: 60_000 });
  return outPath;
}

/* ---------------- 纯函数（便于单测） ---------------- */

/** 章节名 → 安全文件名（去掉路径分隔符和多余空白） */
export function slug(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || '未命名';
}

/** 数字补零到 2 位，非数字回退到 0 */
const pad2 = (n) => String(Math.max(0, Math.trunc(Number(n) || 0))).padStart(2, '0');

/** 给条目起一个稳定的短标签（用于文件名），优先标题，其次文案首行，回退到章节名+序号 */
export function itemLabel(item, section, index = 0) {
  if (item?.title) return item.title;
  const firstLine = String(item?.text ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 24);
  return `${section?.name || '条目'}-${Number(item?.seq) || index + 1}`;
}

/** 条目视频文件名：页签序-条目序-短标签 */
export function itemFileName(section, item, index = 0) {
  return `${pad2(section?.seq)}-${pad2(item?.seq ?? index + 1)}-${slug(itemLabel(item, section, index))}.mp4`;
}

/** 视频导出粒度 */
export const VIDEO_MODES = ['items', 'sections', 'all'];

export function normalizeMode(mode) {
  return VIDEO_MODES.includes(mode) ? mode : 'sections';
}

/** SVG 里的特殊字符转义，避免注入/坏标签 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 把文案按固定字数折行，最多 maxLines 行；超过行数返回 null（整体隐藏，不显示半截） */
export function captionLines(text, maxChars = 22, maxLines = 4) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  if (s.length > maxChars * maxLines) return null;
  const lines = [];
  for (let i = 0; i < s.length; i += maxChars) {
    lines.push(s.slice(i, i + maxChars));
  }
  return lines;
}

/** 生成底部字幕条的 SVG（透明背景 + 半透明底框 + 白色文字） */
export function buildCaptionSvg({
  width,
  height,
  text,
  fontFamily,
  fontSize = 44,
  margin = 40,
  bottom = margin,
}) {
  const lines = captionLines(text);
  if (!lines || lines.length === 0) return null;

  const lineHeight = Math.round(fontSize * 1.4);
  const boxPaddingY = 32;
  const boxHeight = lines.length * lineHeight + boxPaddingY * 2;
  const boxY = height - boxHeight - Math.max(0, Number(bottom) || 0);
  const textY0 = boxY + boxPaddingY + fontSize;

  const spans = lines
    .map(
      (line, i) =>
        `<text x="${width / 2}" y="${textY0 + i * lineHeight}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff" font-family="${escapeXml(fontFamily)}">${escapeXml(line)}</text>`,
    )
    .join('\n');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${margin}" y="${boxY}" width="${width - margin * 2}" height="${boxHeight}" rx="16" fill="rgba(0,0,0,0.55)"/>
  ${spans}
</svg>`;
}

/**
 * 计算一条 item 的片段时长。
 * 有音频 → 时长等于音频时长；没有 → 图片数 × 每图秒数。
 */
export function computeSegments({
  imageCount,
  secondsPerImage,
  hasAudio = false,
  probedDuration = null,
  storedDuration = null,
}) {
  const n = Math.max(1, Math.trunc(Number(imageCount) || 1));
  const fallback = n * (Number(secondsPerImage) || 3);

  let total = fallback;
  if (hasAudio) {
    const d = Number(probedDuration) > 0 ? Number(probedDuration) : Number(storedDuration) > 0 ? Number(storedDuration) : 0;
    total = d > 0 ? d : fallback;
  }

  total = Math.max(0.5, total);
  const seg = total / n;
  return { total: round3(total), seg: round3(seg) };
}

/** 缓动：先慢后快再慢，让滑动过渡更自然 */
export const easeInOutCubic = (t) => {
  const x = Math.min(1, Math.max(0, Number(t) || 0));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/**
 * 画册布局：上方大图舞台 + 底部一排缩略图（swiper）。
 * 返回大图区、缩略图条、每个缩略图格子的几何信息（都是整数）。
 * 缩略图卡片宽度按数量动态计算，保证全部卡片都完整放进画布、不被右侧裁掉。
 */
export function galleryLayout(n, width, height) {
  const count = Math.max(1, Math.trunc(Number(n) || 1));
  const w = Math.max(1, Math.round(Number(width) || 1));
  const h = Math.max(1, Math.round(Number(height) || 1));

  const thumbBarH = Math.round(h * 0.16);
  // 卡片高度固定（缩略图条高度决定），宽度动态收缩以塞下全部
  const thumbH = Math.max(40, Math.round(thumbBarH * 0.7));
  const marginX = Math.round(w * 0.02);
  const gap = Math.max(6, Math.round(w * 0.008));

  // 可用宽度 = 画布宽 - 左右边距；卡片宽度 = (可用宽 - 所有间隙) / 数量
  const availW = Math.max(1, w - marginX * 2);
  const thumbW = Math.max(24, Math.floor((availW - gap * (count - 1)) / count));

  const stage = { x: 0, y: 0, w, h: h - thumbBarH };

  // 缩略图条横向居中
  const totalThumbsW = count * thumbW + (count - 1) * gap;
  const startX = Math.max(marginX, Math.round((w - totalThumbsW) / 2));
  const thumbBarY = h - thumbBarH;
  const thumbs = [];
  for (let i = 0; i < count; i += 1) {
    thumbs.push({
      x: startX + i * (thumbW + gap),
      y: thumbBarY + Math.round((thumbBarH - thumbH) / 2),
      w: thumbW,
      h: thumbH,
    });
  }

  return {
    stage,
    thumbBar: { x: 0, y: thumbBarY, w, h: thumbBarH },
    thumbs,
    thumbW,
    thumbH,
    thumbBarH,
    gap,
    // 字幕贴在大图区底部（缩略图条之上）
    captionBottom: thumbBarH + Math.round(h * 0.01),
  };
}

/**
 * 图片以 contain 方式放进给定区域时实际占用的矩形（黑边之外的部分）。
 */
export function containedRect(aspect, width, height) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const a = Number(aspect) > 0 ? Number(aspect) : 1;
  const canvasAspect = w / h;
  if (a > canvasAspect) {
    const dispW = w;
    const dispH = w / a;
    return { x: 0, y: (h - dispH) / 2, w: dispW, h: dispH };
  }
  const dispH = h;
  const dispW = h * a;
  return { x: (w - dispW) / 2, y: 0, w: dispW, h: dispH };
}

/** 来回（ping-pong）循环的停留索引序列：0..n-1..1，首尾不重复 */
export function pingPongSequence(n) {
  const count = Math.max(1, Math.trunc(Number(n) || 1));
  if (count <= 1) return [0];
  const seq = [];
  for (let i = 0; i < count; i += 1) seq.push(i);
  for (let i = count - 2; i >= 1; i -= 1) seq.push(i);
  return seq; // 长度 = 2n - 2
}

/** 生成「2 / 5」计数角标 SVG（半透明圆角底 + 白色文字） */
export function buildCounterBadge({ width, height, index, total, fontFamily, fontSize = 36, marginRight = 28, marginTop = 28 }) {
  const label = `${Number(index) + 1} / ${Number(total)}`;
  const px = Math.round(fontSize * 0.6);
  const boxW = Math.round(label.length * px + px * 1.6);
  const boxH = Math.round(fontSize + px);
  const boxX = width - boxW - marginRight;
  const boxY = marginTop;

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="${Math.round(boxH / 2)}" fill="rgba(0,0,0,0.55)"/>
  <text x="${boxX + boxW / 2}" y="${boxY + boxH / 2 + Math.round(fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff" font-family="${escapeXml(fontFamily)}">${escapeXml(label)}</text>
</svg>`;
}

/**
 * 顶部斑马纹进度条：横向分段，每段一个条目，交替深浅色，当前段高亮。
 * labels 是每段的显示文字（标题或序号）。单段时返回 null（没必要显示）。
 */
export function buildProgressBar({ width, height, labels, activeIndex, fontFamily, margin = 16, barHeight = 44 }) {
  const n = (labels?.length) || 0;
  if (n <= 1) return null;

  const x0 = Math.round(margin);
  const x1 = Math.round(width - margin);
  const gap = 3;
  const segW = (x1 - x0 - gap * (n - 1)) / n;
  const y = Math.round(margin);
  const fontSize = 22;

  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const x = x0 + i * (segW + gap);
    const active = i === Number(activeIndex);
    const fill = active
      ? '#2f6df6'
      : i % 2 === 0
        ? 'rgba(0,0,0,0.5)'
        : 'rgba(0,0,0,0.28)';
    parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${segW.toFixed(1)}" height="${barHeight}" rx="9" fill="${fill}"/>`);
    parts.push(`<text x="${(x + segW / 2).toFixed(1)}" y="${y + barHeight / 2 + Math.round(fontSize * 0.36)}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff" font-family="${escapeXml(fontFamily)}">${escapeXml(labels[i])}</text>`);
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;
}

/**
 * 章节/合集视频顶部的「完整进度条」分段底条：横向分段，每段一个条目，
 * 段宽按各条目时长占比（ratios，与 labels 一一对应）分配，斑马纹交替深浅区分不同条目。
 * 每个分段之间用竖立线条分隔（章节标记），强化章节边界。
 * 这是静态底层，只画色块与分隔线不画文字；文字单独放最顶层，避免被实时进度条盖住。
 * 单段时返回 null（没必要显示进度条）。
 */
export function buildProgressTrack({ width, height, labels, ratios, margin = 16, barHeight = 44 }) {
  const n = (labels?.length) || 0;
  if (n <= 1) return null;

  const x0 = Math.round(margin);
  const x1 = Math.round(width - margin);
  const totalW = Math.max(1, x1 - x0);
  const gap = 3;
  const usable = Math.max(1, totalW - gap * (n - 1));
  const y = Math.round(margin);

  const parts = [];
  const segs = [];
  let x = x0;
  for (let i = 0; i < n; i += 1) {
    const ratio = Math.max(0, Math.min(1, Number(ratios?.[i]) || 0));
    const segW = Math.max(6, Math.round(usable * ratio));
    const fill = i % 2 === 0 ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.28)';
    parts.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${segW.toFixed(1)}" height="${barHeight}" rx="9" fill="${fill}"/>`);
    segs.push({ x, w: segW });
    x += segW + gap;
  }

  // 竖立分隔线：每个章节段的左右边界（含两端），上下略突出于色块，形成章节标记
  const sepW = 2;
  const sepY = y - 6;
  const sepH = barHeight + 12;
  for (let i = 0; i <= n; i += 1) {
    const sepX = i === 0 ? x0 : i === n ? x1 : segs[i].x - gap / 2;
    parts.push(`<rect x="${(sepX - sepW / 2).toFixed(1)}" y="${sepY}" width="${sepW}" height="${sepH}" rx="1" fill="rgba(255,255,255,0.55)"/>`);
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;
}

/**
 * 进度条上的文字层：透明背景 + 白色文字（带深色描边），放在最顶层，
 * 这样无论底下是斑马纹还是蓝色实时进度，文字都清晰可见。
 * 段太窄时不画文字，避免溢出重叠。
 */
export function buildProgressLabels({ width, height, labels, ratios, fontFamily, margin = 16, barHeight = 44 }) {
  const n = (labels?.length) || 0;
  if (n <= 1) return null;

  const x0 = Math.round(margin);
  const x1 = Math.round(width - margin);
  const totalW = Math.max(1, x1 - x0);
  const gap = 3;
  const usable = Math.max(1, totalW - gap * (n - 1));
  const y = Math.round(margin);
  const fontSize = 22;
  const minTextW = 44;

  const parts = [];
  let x = x0;
  for (let i = 0; i < n; i += 1) {
    const ratio = Math.max(0, Math.min(1, Number(ratios?.[i]) || 0));
    const segW = Math.max(6, Math.round(usable * ratio));
    if (segW >= minTextW) {
      const cx = (x + segW / 2).toFixed(1);
      const cy = y + barHeight / 2 + Math.round(fontSize * 0.36);
      parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-size="${fontSize}" fill="#ffffff" stroke="rgba(0,0,0,0.65)" stroke-width="2" paint-order="stroke" font-family="${escapeXml(fontFamily)}">${escapeXml(labels[i])}</text>`);
    }
    x += segW + gap;
  }

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${parts.join('\n')}</svg>`;
}

/**
 * 章节过渡的中央标题卡片：屏幕中央大字标题 + 可选副标题。
 * 背景透明，由调用方叠在深色底图上。
 */
export function buildTitleCard({ width, height, title, subtitle, fontFamily, titleSize = 80, subSize = 34 }) {
  const cx = width / 2;
  const cy = subtitle ? height / 2 - 20 : height / 2;
  const sub = subtitle
    ? `<text x="${cx}" y="${cy + Math.round(titleSize * 0.9)}" text-anchor="middle" font-size="${subSize}" fill="rgba(255,255,255,0.72)" font-family="${escapeXml(fontFamily)}">${escapeXml(subtitle)}</text>`
    : '';
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${cx}" y="${cy}" text-anchor="middle" font-size="${titleSize}" font-weight="700" fill="#ffffff" font-family="${escapeXml(fontFamily)}">${escapeXml(title)}</text>
  ${sub}
</svg>`;
}

/**
 * 计算画册条目时间轴：每张图固定停留 hold 秒 + 固定滑动 trans 秒，
 * 按「来回循环」的顺序播放（0..n-1..1 反复），不做等时间缩放。
 * 保底策略：视频总长至少够「每张图完整展示一遍」；语音更短时静音续播，绝不截断图片。
 */
export function computeGalleryTimeline({
  imageCount,
  secondsPerImage,
  transSeconds = 0.5,
  hasAudio = false,
  probedDuration = null,
  storedDuration = null,
}) {
  const n = Math.max(1, Math.trunc(Number(imageCount) || 1));
  const hold = round3(Math.max(0.5, Number(secondsPerImage) || 3));
  const trans = round3(Math.max(0, Number(transSeconds) || 0));
  const audio = hasAudio
    ? (Number(probedDuration) > 0 ? Number(probedDuration) : Number(storedDuration) > 0 ? Number(storedDuration) : 0)
    : 0;

  if (n === 1) {
    // 单图也保底：至少停 hold 秒，语音更短不截断
    const total = round3(Math.max(hold, audio));
    return { n, multi: false, hold: total, trans: 0, total, seq: [0] };
  }

  const base = pingPongSequence(n);
  const baseLen = base.length; // 2n - 2

  let seq;
  let total;
  if (hasAudio && audio > 0) {
    // 每张图至少完整展示一遍的最短时长：n 次停留 + (n-1) 次过渡
    const minFull = n * hold + (n - 1) * trans;
    total = round3(Math.max(audio, minFull));

    // seq 要覆盖 total；一个完整来回（base）的时长 = baseLen 停留 + (baseLen-1) 过渡
    const baseDur = baseLen * hold + (baseLen - 1) * trans;
    const cycles = Math.max(1, Math.ceil((total + trans) / baseDur));
    seq = [];
    for (let c = 0; c < cycles; c += 1) seq.push(...base);
  } else {
    // 无语音：来回循环 2 轮
    seq = [];
    for (let c = 0; c < 2; c += 1) seq.push(...base);
    total = round3(seq.length * hold + (seq.length - 1) * trans);
  }

  return { n, multi: true, hold, trans, total, seq };
}

/** 把一条 item 拍平成渲染单元（纯函数） */
export function toPlanItem(item) {
  return {
    id: item?.id ?? null,
    seq: item?.seq,
    title: item?.title ?? '',
    text: item?.text ?? '',
    images: (item?.images ?? []).map((image) => image?.file).filter(Boolean),
    audio: item?.audio?.file ?? null,
    audioDuration: item?.audio?.duration ?? null,
  };
}

/** 找到 item 及其所属 section（纯函数） */
export function findItemWithSection(state, itemId) {
  for (const section of state?.sections ?? []) {
    const item = (section?.items ?? []).find((i) => i?.id === itemId);
    if (item) return { section, item };
  }
  return null;
}

/**
 * 把 state 拍平成渲染计划（纯函数）。
 * 跳过没有图片的条目；只保留有图片的章节。
 */
export function collectRenderPlan(state) {
  const sections = [];
  for (const section of state?.sections ?? []) {
    const items = [];
    for (const item of section?.items ?? []) {
      if (!item) continue;
      const planItem = toPlanItem(item);
      if (planItem.images.length === 0) continue;
      items.push(planItem);
    }
    if (items.length > 0) {
      sections.push({ seq: section.seq, name: section.name, items });
    }
  }
  return sections;
}

/** 构造单条 item 的 ffmpeg 参数（frame 已按目标尺寸预渲染好） */
export function buildClipArgs({ framePaths, audioPath, total, seg, fps }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const n = framePaths.length;

  for (const frame of framePaths) {
    args.push('-loop', '1', '-t', String(seg), '-i', frame);
  }

  const labels = framePaths.map((_, i) => `[${i}:v]`).join('');
  const filter = `${labels}concat=n=${n}:v=1:a=0,format=yuv420p,fps=${fps}[v]`;
  args.push('-filter_complex', filter);

  if (audioPath) {
    args.push('-i', audioPath);
    args.push('-map', '[v]', '-map', `${n}:a`);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    args.push('-map', '[v]', '-map', `${n}:a`);
  }

  args.push(
    '-t', String(total),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-video_track_timescale', '90000',
  );
  return args;
}

/* ---------------- 渲染 / 拼接 ---------------- */

/** 把一张图片缩放到目标画布（黑边居中），可选叠加文案字幕与进度条 */
export async function renderFrame(inputPath, outputPath, { width, height, burnText, fontFamily, text, progressSvg = null }) {
  // 先 resize 成带黑边的完整底图 buffer，再和字幕/进度条透明层「同一次 composite」，
  // 避免透明 overlay 分次 composite 到无 alpha 图时被当成黑色覆盖。
  const base = await sharp(inputPath)
    .rotate()
    .resize({ width, height, fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .toBuffer();

  const composites = [{ input: base, top: 0, left: 0 }];
  if (burnText) {
    const svg = buildCaptionSvg({ width, height, text, fontFamily });
    if (svg) {
      composites.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), top: 0, left: 0 });
    }
  }
  if (progressSvg) {
    composites.push({ input: progressSvg, top: 0, left: 0 });
  }

  await sharp({ create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outputPath);
}

/** 探一张图的方向修正后的宽高比（大图 contain 定位用），用极小缩略图换取速度 */
export async function imageAspect(imagePath) {
  const { info } = await sharp(imagePath)
    .rotate()
    .resize({ width: 64, height: 64, fit: 'inside' })
    .toBuffer({ resolveWithObject: true });
  const w = info?.width || 1;
  const h = info?.height || 1;
  return w / h;
}

/** 缩略图卡片边框：圆角矩形描边（透明背景），叠在卡片最上层 */
function thumbBorderSvg(w, h, color, radius = 10, strokeWidth = 2) {
  const s = strokeWidth;
  const inset = s / 2;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="${inset}" y="${inset}" width="${w - s}" height="${h - s}" rx="${radius}" fill="none" stroke="${color}" stroke-width="${s}"/>
</svg>`;
}

/**
 * 缩略图卡片：object-fit: contain 的感觉 —— 整张图完整放进卡片（不裁切），
 * 深色底 + 圆角边框；当前项高亮边框、其余淡色边框。
 */
async function thumbTile(imagePath, w, h, active) {
  const bg = { r: 16, g: 18, b: 24 };
  const stroke = active ? 4 : 2;
  const pad = active ? 9 : 7; // 内边距（含边框宽度），图片不贴边框
  const color = active ? '#2f6df6' : 'rgba(255,255,255,0.22)';

  const inner = await sharp(imagePath)
    .rotate()
    .resize(Math.max(1, w - pad * 2), Math.max(1, h - pad * 2), { fit: 'contain', background: bg })
    .toBuffer();

  const borderPng = await sharp(Buffer.from(thumbBorderSvg(w, h, color, 10, stroke))).png().toBuffer();

  // 底图 + 图片 + 边框一次 composite，避免透明层分次叠加变黑
  return sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .composite([
      { input: inner, top: pad, left: pad },
      { input: borderPng, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

/** 渲染一帧「画册停留」：大图区 contain 当前图 + 底部缩略图条（当前高亮）+ 计数角标 + 可选字幕/进度条 */
export async function renderGalleryStill(outputPath, { layout, images, aspects, activeIndex, burnText, fontFamily, text, progressSvg = null }) {
  const width = layout.stage.w;
  const height = layout.thumbBar.y + layout.thumbBar.h;
  const composites = [];

  // 大图 contain 到舞台
  const aspect = aspects[activeIndex];
  const r = containedRect(aspect, layout.stage.w, layout.stage.h);
  const big = await sharp(images[activeIndex])
    .rotate()
    .resize(Math.max(1, Math.round(r.w)), Math.max(1, Math.round(r.h)), { fit: 'fill' })
    .toBuffer();
  composites.push({ input: big, top: layout.stage.y + Math.round(r.y), left: layout.stage.x + Math.round(r.x) });

  // 缩略图条
  for (let i = 0; i < layout.thumbs.length; i += 1) {
    const t = layout.thumbs[i];
    const tile = await thumbTile(images[i], t.w, t.h, i === activeIndex);
    composites.push({ input: tile, top: t.y, left: t.x });
  }

  // 计数角标「2 / 3」；有进度条时下移避开顶部进度条
  const badge = buildCounterBadge({ width, height, index: activeIndex, total: layout.thumbs.length, fontFamily, marginTop: progressSvg ? 80 : 28 });
  composites.push({ input: await sharp(Buffer.from(badge)).png().toBuffer(), top: 0, left: 0 });

  if (burnText) {
    const svg = buildCaptionSvg({ width, height, text, fontFamily, bottom: layout.captionBottom });
    if (svg) {
      composites.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), top: 0, left: 0 });
    }
  }
  if (progressSvg) {
    composites.push({ input: progressSvg, top: 0, left: 0 });
  }

  await sharp({
    create: { width, height, channels: 3, background: { r: 16, g: 18, b: 24 } },
  })
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outputPath);
}

/**
 * 渲染一帧「画册滑动」：大图按方向横向滑动（正向看下一张左移，反向看上一张右移），
 * 缩略图条里高亮切到目标图。
 */
export async function renderGalleryTransition(outputPath, { layout, images, aspects, fromIndex, toIndex, t, progressSvg = null, burnText = false, fontFamily = 'Arial', text = '' }) {
  const width = layout.stage.w;
  const height = layout.thumbBar.y + layout.thumbBar.h;
  const dir = toIndex > fromIndex ? 1 : -1;
  const e = easeInOutCubic(t);
  const composites = [];

  const fromRect = containedRect(aspects[fromIndex], layout.stage.w, layout.stage.h);
  const toRect = containedRect(aspects[toIndex], layout.stage.w, layout.stage.h);

  const fromBig = await sharp(images[fromIndex])
    .rotate()
    .resize(Math.max(1, Math.round(fromRect.w)), Math.max(1, Math.round(fromRect.h)), { fit: 'fill' })
    .toBuffer();
  composites.push({
    input: fromBig,
    top: layout.stage.y + Math.round(fromRect.y),
    left: layout.stage.x + Math.round(fromRect.x) - Math.round(dir * layout.stage.w * e),
  });

  const toBig = await sharp(images[toIndex])
    .rotate()
    .resize(Math.max(1, Math.round(toRect.w)), Math.max(1, Math.round(toRect.h)), { fit: 'fill' })
    .toBuffer();
  composites.push({
    input: toBig,
    top: layout.stage.y + Math.round(toRect.y),
    left: layout.stage.x + Math.round(toRect.x) + Math.round(dir * layout.stage.w * (1 - e)),
  });

  // 缩略图条：目标图高亮
  for (let i = 0; i < layout.thumbs.length; i += 1) {
    const t = layout.thumbs[i];
    const tile = await thumbTile(images[i], t.w, t.h, i === toIndex);
    composites.push({ input: tile, top: t.y, left: t.x });
  }

  // 过渡中也显示目标计数
  const badge = buildCounterBadge({ width, height, index: toIndex, total: layout.thumbs.length, fontFamily: 'Arial', marginTop: progressSvg ? 80 : 28 });
  composites.push({ input: await sharp(Buffer.from(badge)).png().toBuffer(), top: 0, left: 0 });

  // 文案作为固定位置的浮动标签，切换图片时保持不动（和停留帧一致）
  if (burnText) {
    const svg = buildCaptionSvg({ width, height, text, fontFamily, bottom: layout.captionBottom });
    if (svg) {
      composites.push({ input: await sharp(Buffer.from(svg)).png().toBuffer(), top: 0, left: 0 });
    }
  }

  if (progressSvg) {
    composites.push({ input: progressSvg, top: 0, left: 0 });
  }

  await sharp({
    create: { width, height, channels: 3, background: { r: 16, g: 18, b: 24 } },
  })
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(outputPath);
}

async function runFfmpeg(args, outPath) {
  const started = Date.now();
  try {
    await execa(BIN.ffmpeg, [...args, outPath], { timeout: FFMPEG_TIMEOUT_MS });
  } catch (err) {
    const detail = err.shortMessage || String(err.stderr || err.message).slice(-300);
    log.video.error({ out: path.basename(outPath), err: detail }, 'ffmpeg 失败');
    throw new Error(`视频生成失败：${detail}`);
  }
  log.video.debug({ ms: Date.now() - started, out: path.basename(outPath) }, 'ffmpeg 完成');
}

/** 用 concat demuxer 秒拼（所有片段规格一致，无需转码） */
async function concatClips(clipPaths, outPath, listDir) {
  const listPath = path.join(listDir, `concat-${path.basename(outPath)}.txt`);
  await fsp.writeFile(
    listPath,
    clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  await runFfmpeg(
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart'],
    outPath,
  );
}

/**
 * 把「无音频视频轨」和音频合并成一个完整 clip：视频流直接 copy（秒级），
 * 音频转成 aac 保证与其它片段规格一致。视频轨 ≥ 音频时不加 -shortest，
 * 输出时长取较长的视频轨，音频不足的部分自动补静音。
 */
async function muxAudio(videoPath, audioPath, outPath) {
  await runFfmpeg(
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      '-video_track_timescale', '90000',
    ],
    outPath,
  );
}

/**
 * 在拼接好的章节/合集视频上叠加「完整进度条」：
 * 底层 = 分段斑马纹（按各条目时长占比），中层 = 单色实时进度条（随时间从左往右推进），
 * 顶层 = 文字标签（带描边，始终可见，不被蓝色进度条盖住）。
 * 视频流重编码，音频流 copy。只有一段时不叠进度条，直接拷贝。
 */
async function overlayProgressBar({ videoPath, outPath, labels, ratios, cfg, tmpDir }) {
  if ((labels?.length || 0) <= 1) {
    await fsp.copyFile(videoPath, outPath);
    return;
  }

  const total = await probeDuration(videoPath);
  if (!total || total <= 0) {
    await fsp.copyFile(videoPath, outPath);
    return;
  }

  const { width, height, fps, fontFamily } = cfg;
  const margin = 16;
  const barHeight = 44;
  const barW = Math.max(1, width - margin * 2);

  const trackSvg = buildProgressTrack({ width, height, labels, ratios, margin, barHeight });
  const labelSvg = buildProgressLabels({ width, height, labels, ratios, fontFamily, margin, barHeight });
  const trackPng = path.join(tmpDir, `progress-track-${path.basename(outPath)}.png`);
  const labelPng = path.join(tmpDir, `progress-labels-${path.basename(outPath)}.png`);
  await fsp.writeFile(trackPng, await sharp(Buffer.from(trackSvg)).png().toBuffer());
  await fsp.writeFile(labelPng, await sharp(Buffer.from(labelSvg)).png().toBuffer());

  // [2:v] 是 geq 生成的「已播放」遮罩（白=已播放，随时间向右扩展），
  // [3:v] 是纯蓝进度条颜色，用 alphamerge 把遮罩当 alpha → 蓝色实时进度条（288×44 小图）。
  // 叠加顺序（从下到上）：主视频 → 分段底条 → 蓝色实时进度 → 文字层。
  // 注意：trackPng / labelPng 是「全画布」透明层（内部已按 margin 定位），用 overlay=0:0；
  // 蓝色 prog 是 barW×barHeight 小图，需 overlay 到 margin 处。
  await runFfmpeg(
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', videoPath,
      '-loop', '1', '-i', trackPng,
      '-f', 'lavfi', '-i', `color=black:s=${barW}x${barHeight}:r=${fps}:d=${total}`,
      '-f', 'lavfi', '-i', `color=0x2f6df6:s=${barW}x${barHeight}:r=${fps}:d=${total}`,
      '-loop', '1', '-i', labelPng,
      '-filter_complex',
      [
        `[2:v]geq=lum='lt(X,W*T/${total})*255':cb=128:cr=128[mask]`,
        '[3:v][mask]alphamerge[prog]',
        '[0:v][1:v]overlay=0:0[base]',
        `[base][prog]overlay=${margin}:${margin}[withprog]`,
        '[withprog][4:v]overlay=0:0[outv]',
      ].join(';'),
      '-map', '[outv]',
      '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-video_track_timescale', '90000',
      // -loop 1 的 track.png / label.png 是无限流，必须显式限制输出时长，否则 ffmpeg 永不结束
      '-t', String(total),
    ],
    outPath,
  );
}

/**
 * 把一个章节/合集的 clip 序列拼成最终视频，并叠加完整进度条。
 * entries 顺序为 [title0, item0, title1, item1, …]，每个 item 前的 title 时长计入该段，
 * 这样分段宽度与实时进度条的时间基准完全对齐。
 */
async function concatChapter({ entries, outPath, cfg, tmpDir }) {
  const tmpConcat = path.join(tmpDir, `chapter-${path.basename(outPath)}.mp4`);
  await concatClips(entries.map((e) => e.path), tmpConcat, tmpDir);

  const itemEntries = entries.filter((e) => e.type === 'item');
  if (itemEntries.length <= 1) {
    await fsp.copyFile(tmpConcat, outPath);
    return;
  }

  const durs = [];
  for (const e of entries) durs.push(await probeDuration(e.path));

  // 每段 = 前面的 title（若有）+ item，占比按时长算
  const segs = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].type !== 'item') continue;
    const prev = entries[i - 1];
    const dur = (prev?.type === 'title' ? (durs[i - 1] || 0) : 0) + (durs[i] || 0);
    segs.push({ label: entries[i].label, dur });
  }

  const segTotal = segs.reduce((sum, s) => sum + s.dur, 0) || 1;
  await overlayProgressBar({
    videoPath: tmpConcat,
    outPath,
    labels: segs.map((s) => s.label),
    ratios: segs.map((s) => s.dur / segTotal),
    cfg,
    tmpDir,
  });
}

/**
 * 构造画册条目的 ffmpeg 参数：按 seq（来回循环索引）依次「停留 + 滑动」。
 * stillByIndex / transByPair 分别是复用缓存的停留帧与过渡帧序列，避免重复渲染。
 */
export function buildGalleryClipArgs({ seq, stillByIndex, transByPair, hold, trans, fps, audioPath, total }) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  const filters = [];
  const labels = [];
  let idx = 0;

  for (let i = 0; i < seq.length; i += 1) {
    const still = stillByIndex.get(seq[i]);
    args.push('-loop', '1', '-t', String(hold), '-i', still);
    filters.push(`[${idx}:v]fps=${fps},format=yuv420p,setsar=1[s${i}]`);
    labels.push(`[s${i}]`);
    idx += 1;

    if (i < seq.length - 1 && trans > 0) {
      const key = `${seq[i]}>${seq[i + 1]}`;
      const pattern = transByPair.get(key);
      if (pattern) {
        args.push('-framerate', String(fps), '-i', pattern);
        filters.push(`[${idx}:v]format=yuv420p,setsar=1[t${i}]`);
        labels.push(`[t${i}]`);
        idx += 1;
      }
    }
  }

  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[outv]`);
  args.push('-filter_complex', filters.join(';'));

  if (audioPath) {
    args.push('-i', audioPath);
    args.push('-map', '[outv]', '-map', `${idx}:a`);
  } else {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
    args.push('-map', '[outv]', '-map', `${idx}:a`);
  }

  args.push(
    '-t', String(total),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-video_track_timescale', '90000',
  );
  return args;
}

/**
 * 渲染画册条目的全部帧：每个唯一 index 的停留帧 + 每个唯一 (from,to) 方向的过渡帧。
 * 帧只依赖画面内容，与音频无关，因此可以跨不同音频复用。
 */
async function renderGalleryFrames({ images, aspects, layout, timeline, base, tmpDir, burnText, fontFamily, text, progressSvg, fps }) {
  const n = images.length;

  // 停留帧：每个唯一 index 渲染一次，来回循环时复用
  const stillByIndex = new Map();
  for (let i = 0; i < n; i += 1) {
    const frame = path.join(tmpDir, `${base}-still-${i}.jpg`);
    await renderGalleryStill(frame, { layout, images, aspects, activeIndex: i, burnText, fontFamily, text, progressSvg });
    stillByIndex.set(i, frame);
  }

  // 过渡帧：每个唯一 (from,to) 方向渲染一次，来回循环时复用
  const transByPair = new Map();
  const tframes = timeline.trans > 0 ? Math.max(1, Math.round(timeline.trans * fps)) : 0;
  for (let i = 0; i < timeline.seq.length - 1; i += 1) {
    const from = timeline.seq[i];
    const to = timeline.seq[i + 1];
    const key = `${from}>${to}`;
    if (transByPair.has(key)) continue;
    if (tframes === 0) {
      transByPair.set(key, null);
      continue;
    }
    const pattern = path.join(tmpDir, `${base}-trans-${from}-${to}-%03d.jpg`);
    for (let j = 0; j < tframes; j += 1) {
      const t = tframes === 1 ? 1 : j / (tframes - 1);
      const framePath = path.join(tmpDir, `${base}-trans-${from}-${to}-${String(j).padStart(3, '0')}.jpg`);
      await renderGalleryTransition(framePath, { layout, images, aspects, fromIndex: from, toIndex: to, t, progressSvg, burnText, fontFamily, text });
    }
    transByPair.set(key, pattern);
  }

  return { stillByIndex, transByPair };
}

/**
 * 生成（或复用）「无音频视频轨」：时长等于保底时长（每张图完整展示一遍），
 * 不依赖任何音频，因此切换 TTS 语音 / 录音时可复用，只需重新合并音频。
 */
async function ensureVideoTrack({ images, aspects, layout, text, cfg, progressSvg, minFull, videoKey, cacheDir, tmpDir }) {
  const { fps, secondsPerImage, transSeconds, burnText, fontFamily } = cfg;
  const videoCachePath = path.join(cacheDir, `${videoKey}.v.mp4`);

  if (fs.existsSync(videoCachePath)) {
    const stat = await fsp.stat(videoCachePath).catch(() => null);
    if (stat && stat.size > 0) {
      log.video.debug({ key: videoKey.slice(0, 8) }, '命中视频轨缓存');
      return videoCachePath;
    }
  }

  const timeline = computeGalleryTimeline({
    imageCount: images.length,
    secondsPerImage,
    transSeconds,
    hasAudio: true,
    probedDuration: minFull,
  });

  const base = `v-${videoKey.slice(0, 12)}`;
  const { stillByIndex, transByPair } = await renderGalleryFrames({
    images, aspects, layout, timeline, base, tmpDir, burnText, fontFamily, text, progressSvg, fps,
  });
  const args = buildGalleryClipArgs({
    seq: timeline.seq,
    stillByIndex,
    transByPair,
    hold: timeline.hold,
    trans: timeline.trans,
    fps,
    audioPath: null,
    total: timeline.total,
  });
  await runFfmpeg(args, videoCachePath);
  return videoCachePath;
}

/**
 * 把一个条目渲染成一个 mp4 clip（带 item 级缓存）。
 * 单图：全屏停留；多图：画册（大图 + 底部缩略图 swiper + 计数），大图来回循环滑动。
 * 返回缓存文件路径；命中缓存时不重新渲染帧。
 */
async function buildItemClip({ images, imageRels, text, title, audio, audioRel, audioDuration, cfg, tmpDir, cacheDir, progress = null }) {
  const { width, height, fps, secondsPerImage, transSeconds, burnText, fontFamily } = cfg;
  const n = images.length;

  // 最终合成缓存 key（含音频）：命中直接返回
  const imageSigs = [];
  for (const absPath of images) imageSigs.push(await fileSig(absPath));
  const audioSig = audio ? await fileSig(audio) : null;
  const key = itemCacheKey({ imageRels, imageSigs, text, title, audioRel, audioSig, cfg, progress });
  const cachePath = path.join(cacheDir, `${key}.mp4`);

  if (fs.existsSync(cachePath)) {
    const stat = await fsp.stat(cachePath).catch(() => null);
    if (stat && stat.size > 0) {
      log.video.debug({ key: key.slice(0, 8), title: title || text.slice(0, 12) }, '命中 item 缓存');
      return cachePath;
    }
  }

  const audioPath = audio || null;
  const hasAudio = Boolean(audioPath);
  const probed = hasAudio ? await probeDuration(audioPath) : null;

  // 章节/合集视频的顶部进度条 overlay
  const progressSvg = progress && progress.labels.length > 1
    ? await sharp(Buffer.from(buildProgressBar({
        width,
        height,
        labels: progress.labels,
        activeIndex: progress.activeIndex,
        fontFamily,
      }))).png().toBuffer()
    : null;

  // 先算「无音频」时间线：单图/多图分支判断 + 拿到 clamp 后的 hold/trans
  const timelineNoAudio = computeGalleryTimeline({
    imageCount: n,
    secondsPerImage,
    transSeconds,
    hasAudio: false,
  });

  // 单图：全屏停留，直接渲染 + 编码（保底时长很短，拆音频收益小，保持旧路径）
  if (!timelineNoAudio.multi) {
    const base = `item-${key.slice(0, 12)}`;
    const timeline = hasAudio
      ? computeGalleryTimeline({
          imageCount: n,
          secondsPerImage,
          transSeconds,
          hasAudio: true,
          probedDuration: probed,
          storedDuration: audioDuration,
        })
      : timelineNoAudio;
    const frame = path.join(tmpDir, `${base}-frame.jpg`);
    await renderFrame(images[0], frame, { width, height, burnText, fontFamily, text, progressSvg });
    const args = buildClipArgs({ framePaths: [frame], audioPath, total: timeline.total, seg: timeline.total, fps });
    await runFfmpeg(args, cachePath);
    return cachePath;
  }

  // 多图：布局与 aspect 只依赖画面，与音频无关
  const layout = galleryLayout(n, width, height);
  const aspects = [];
  for (const imagePath of images) {
    aspects.push(await imageAspect(imagePath));
  }

  // 保底时长：每张图完整展示一遍（与后端保底策略一致）
  const minFull = round3(n * timelineNoAudio.hold + (n - 1) * timelineNoAudio.trans);

  // 音频短于保底：复用「无音频视频轨」，仅 -c:v copy 合并音频（秒级），不重新渲染帧
  if (hasAudio && probed > 0 && probed <= minFull) {
    const video = await ensureVideoTrack({
      images, aspects, layout, text, cfg, progressSvg, minFull,
      videoKey: videoItemCacheKey({ imageRels, imageSigs, text, title, cfg, progress }),
      cacheDir, tmpDir,
    });
    await muxAudio(video, audioPath, cachePath);
    return cachePath;
  }

  // 音频更长或无音频：按对应时间线渲染 + 编码
  const timeline = hasAudio
    ? computeGalleryTimeline({
        imageCount: n,
        secondsPerImage,
        transSeconds,
        hasAudio: true,
        probedDuration: probed,
        storedDuration: audioDuration,
      })
    : timelineNoAudio;

  const base = `item-${key.slice(0, 12)}`;
  const { stillByIndex, transByPair } = await renderGalleryFrames({
    images, aspects, layout, timeline, base, tmpDir, burnText, fontFamily, text, progressSvg, fps,
  });
  const args = buildGalleryClipArgs({
    seq: timeline.seq,
    stillByIndex,
    transByPair,
    hold: timeline.hold,
    trans: timeline.trans,
    fps,
    audioPath,
    total: timeline.total,
  });
  await runFfmpeg(args, cachePath);
  return cachePath;
}

/**
 * 生成（或复用）章节切换的轻音效：一个带淡入淡出的柔和 whoosh（粉红噪声 bandpass）。
 * 音效固定，只合成一次，缓存到视频缓存目录。
 */
async function ensureTransitionAudio(cacheDir) {
  const outPath = path.join(cacheDir, TITLE_SOUND_FILE);
  if (fs.existsSync(outPath)) {
    const stat = await fsp.stat(outPath).catch(() => null);
    if (stat && stat.size > 0) return outPath;
  }
  await fsp.mkdir(cacheDir, { recursive: true });
  await runFfmpeg(
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:duration=${TITLE_SOUND_SECONDS}:sample_rate=44100`,
      '-af', 'highpass=f=350,lowpass=f=2600,volume=0.35,afade=t=in:st=0:d=0.08,afade=t=out:st=0.28:d=0.12',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    ],
    outPath,
  );
  return outPath;
}

/**
 * 生成一个中央标题过渡 clip（带缓存）：深色背景 + 屏幕中央大字标题（+ 副标题）。
 * 用在章节/合集视频的条目之间，让观众知道切换到下一个条目。
 */
async function buildTitleClip({ title, subtitle, cfg, tmpDir, cacheDir }) {
  const { width, height, fps, fontFamily } = cfg;
  const key = titleCacheKey({ title, subtitle, cfg });
  const cachePath = path.join(cacheDir, `${key}.mp4`);

  if (fs.existsSync(cachePath)) {
    const stat = await fsp.stat(cachePath).catch(() => null);
    if (stat && stat.size > 0) {
      log.video.debug({ key: key.slice(0, 8), title }, '命中标题缓存');
      return cachePath;
    }
  }

  const svg = buildTitleCard({ width, height, title, subtitle, fontFamily });
  const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
  const frame = path.join(tmpDir, `title-${key.slice(0, 12)}.jpg`);

  await sharp({ create: { width, height, channels: 3, background: { r: 16, g: 18, b: 24 } } })
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toFile(frame);

  // 标题过渡带一个轻切换音效；音效短于标题时长，末尾自动补静音
  const soundPath = await ensureTransitionAudio(cacheDir);
  const args = buildClipArgs({ framePaths: [frame], audioPath: soundPath, total: TITLE_CARD_SECONDS, seg: TITLE_CARD_SECONDS, fps });
  await runFfmpeg(args, cachePath);
  return cachePath;
}

/* ---------------- 入口 ---------------- */

/**
 * 把清单渲染成视频。mode：
 *   - 'items'    每个条目一个 mp4（小文件，方便逐个发）
 *   - 'sections' 每个章节一个 mp4
 *   - 'all'      全部条目合并成一个 mp4
 * 传入 itemId 时只导出那一个条目（覆盖同名文件，不清空目录）。
 * 完整导出会先清空 exports/videos（视频是可再生的），避免旧文件堆积。
 */
export async function buildVideos({ state, config: configOverride, mode: modeInput, itemId, audioSource } = {}) {
  await ensureDirs();
  if (!BIN.ffmpeg) {
    throw badRequest('未找到 ffmpeg，无法生成视频。请安装 ffmpeg 或设置 FFMPEG_PATH', 503);
  }

  const baseCfg = configOverride ?? VIDEO;
  // 前端可覆盖音频来源；非法值回退到配置默认
  const source = ['auto', 'recording', 'tts'].includes(audioSource) ? audioSource : baseCfg.audioSource;
  const cfg = { ...baseCfg, audioSource: source };

  const single = itemId ? findItemWithSection(state, itemId) : null;
  if (itemId && !single) {
    throw badRequest('找不到这个条目', 404);
  }

  const mode = single ? 'items' : normalizeMode(modeInput);
  const plan = single
    ? [{ seq: single.section.seq, name: single.section.name, items: [toPlanItem(single.item)] }]
    : collectRenderPlan(state);

  if (plan.length === 0) {
    throw badRequest('没有可导出的内容：所有条目都没有图片', 422);
  }

  // 单条目导出只覆盖同名文件，不清空目录，保留其它已导出的视频
  if (single) {
    await fsp.mkdir(VIDEO_DIR, { recursive: true });
  } else {
    await fsp.rm(VIDEO_DIR, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(VIDEO_DIR, { recursive: true });
  }

  const tmpDir = await fsp.mkdtemp(path.join(TMP_DIR, 'video-'));
  const missing = new Set();
  let skippedItems = 0;

  const abs = (rel) => path.join(DATA_DIR, rel);
  const exists = (rel) => fs.existsSync(abs(rel));

  try {
    // 收集所有「有图」的条目，并计算进度条 label（标题或序号）
    const renderables = [];
    for (const section of plan) {
      let visibleIndex = 0;
      for (const item of section.items) {
        const imagePaths = [];
        for (const rel of item.images) {
          if (!exists(rel)) {
            missing.add(rel);
            continue;
          }
          imagePaths.push(abs(rel));
        }

        if (imagePaths.length === 0) {
          skippedItems += 1;
          continue;
        }

        // 解析语音来源：录音 / TTS / 静音
        let audioPath = null;
        let audioRel = null;
        const recordingPath = item.audio ? (exists(item.audio) ? abs(item.audio) : null) : null;
        if (item.audio && !recordingPath) missing.add(item.audio);

        const source = resolveAudioSource(cfg.audioSource, Boolean(recordingPath));
        if (source === 'recording' && recordingPath) {
          audioPath = recordingPath;
          audioRel = item.audio;
        } else if (source === 'tts') {
          const spoken = ttsTextFor(item);
          if (spoken) {
            const ttsPath = await ensureTts(spoken, cfg.ttsVoice);
            if (ttsPath) {
              audioPath = ttsPath;
              audioRel = `tts/${path.basename(ttsPath)}`;
            }
          }
        }

        const title = (item.title || '').trim();
        renderables.push({
          section,
          item,
          imagePaths,
          imageRels: item.images,
          audioPath,
          audioRel,
          visibleIndex,
          progressLabel: title || String(visibleIndex + 1).padStart(2, '0'),
          titleText: title || `第 ${visibleIndex + 1} 项`,
        });
        visibleIndex += 1;
      }
    }

    if (renderables.length === 0) {
      throw badRequest('没有可导出的内容：所有图片都不存在或条目没有图片', 422);
    }

    const multiItemMode = mode === 'sections' || mode === 'all';

    log.video.info({ mode, sections: plan.length, items: renderables.length, audioSource: cfg.audioSource }, '开始生成视频');

    // 生成每个条目的视频 clip，以及（多条目模式下）条目之间的中央标题过渡 clip
    const items = [];
    for (let gi = 0; gi < renderables.length; gi += 1) {
      const r = renderables[gi];
      const step = { i: gi + 1, total: renderables.length, label: r.progressLabel, section: r.section.name };
      log.video.info(step, '生成条目视频');

      // 章节/合集的进度条改为拼接完成后整段叠加，item clip 不再烧录静态进度条，
      // 这样 item 缓存也不再依赖 progress，切换进度条样式时无需重渲染
      const clipPath = await buildItemClip({
        images: r.imagePaths,
        imageRels: r.imageRels,
        text: r.item.text,
        title: r.item.title,
        audio: r.audioPath,
        audioRel: r.audioRel,
        audioDuration: r.item.audioDuration,
        cfg,
        tmpDir,
        cacheDir: VIDEO_CACHE_DIR,
        progress: null,
      });
      log.video.info(step, '条目视频完成');

      let titleClipPath = null;
      if (multiItemMode && renderables.length > 1) {
        titleClipPath = await buildTitleClip({
          title: r.titleText,
          subtitle: r.section.name,
          cfg,
          tmpDir,
          cacheDir: VIDEO_CACHE_DIR,
        });
      }

      items.push({
        section: r.section,
        item: r.item,
        clipPath,
        index: r.visibleIndex,
        label: r.progressLabel,
        titleClipPath,
      });
    }

    const files = [];

    const addFile = async (name, absolutePath, kind, extra = {}) => {
      const { size } = await fsp.stat(absolutePath);
      files.push({
        name,
        path: `exports/videos/${name}`,
        url: `/exports/videos/${encodeURIComponent(name)}`,
        size,
        kind,
        ...extra,
      });
    };

    if (mode === 'items') {
      for (const { section, item, clipPath, index } of items) {
        const name = itemFileName(section, item, index);
        const outPath = path.join(VIDEO_DIR, name);
        // 从缓存复制到导出目录，缓存本身保留（供章节/合集复用）
        await fsp.copyFile(clipPath, outPath);
        await addFile(name, outPath, 'item', {
          sectionSeq: section.seq,
          sectionName: section.name,
          itemSeq: item.seq,
        });
      }
    } else if (mode === 'sections') {
      const bySection = new Map();
      for (const { section, clipPath, label, titleClipPath } of items) {
        if (!bySection.has(section.seq)) bySection.set(section.seq, []);
        const list = bySection.get(section.seq);
        if (titleClipPath) list.push({ type: 'title', path: titleClipPath });
        list.push({ type: 'item', path: clipPath, label });
      }

      for (const section of plan) {
        const entries = bySection.get(section.seq) ?? [];
        if (entries.length === 0) continue;
        const name = `${pad2(section.seq)}-${slug(section.name)}.mp4`;
        const outPath = path.join(VIDEO_DIR, name);
        await concatChapter({ entries, outPath, cfg, tmpDir });
        await addFile(name, outPath, 'section', { sectionSeq: section.seq, sectionName: section.name });
      }
    } else {
      // mode === 'all'
      const name = `${slug(state?.title || '清单')}-全部.mp4`;
      const outPath = path.join(VIDEO_DIR, name);
      const entries = [];
      for (const { clipPath, label, titleClipPath } of items) {
        if (titleClipPath) entries.push({ type: 'title', path: titleClipPath });
        entries.push({ type: 'item', path: clipPath, label });
      }
      await concatChapter({ entries, outPath, cfg, tmpDir });
      await addFile(name, outPath, 'all');
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    log.video.info({ mode, count: files.length, size: totalSize, skipped: skippedItems }, '视频导出完成');

    return {
      mode,
      files,
      count: files.length,
      totalSize,
      skippedItems,
      dir: 'exports/videos',
      dirUrl: '/exports/videos/',
      missing: [...missing],
    };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
