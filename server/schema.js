import { z } from 'zod';
import dayjs from 'dayjs';
import { nanoid } from 'nanoid';

/** 当前 state 的数据 schema 版本（决定数据字段结构） */
export const CURRENT_STATE_VERSION = 1;
/** 备份包（zip）的格式版本，独立于 state schema 版本 */
export const BACKUP_FORMAT_VERSION = 1;
/** 备份包格式标识（manifest.format）。改名前的 hunlibuzhi-backup 仍可导入 */
export const BACKUP_FORMAT = 'dianzi-tushuo-backup';
export const LEGACY_BACKUP_FORMATS = ['hunlibuzhi-backup'];

/** UI 上限：一条最多 12 张图片（前端按这个数限制添加） */
export const MAX_IMAGES_PER_ITEM = 12;
/** 一次上传最多 12 张（正好等于单条上限） */
export const MAX_IMAGES_PER_REQUEST = 12;
/**
 * 磁盘读取的安全上限。
 * 故意比 UI 上限高：以后若再调低 MAX_IMAGES_PER_ITEM，
 * 已有数据不会被静默截断丢掉。
 */
export const MAX_IMAGES_HARD_CAP = 100;
export const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const IMAGE_PATH_RE = /^images\/[A-Za-z0-9._-]+$/;
const AUDIO_PATH_RE = /^audio\/[A-Za-z0-9._-]+$/;

export const nowIso = () => dayjs().toISOString();
export const newId = (prefix) => `${prefix}_${nanoid(10)}`;

const round3 = (n) => Math.round(n * 1000) / 1000;
/** 超长字符串截断而不是报错：坏数据不应该让整条记录消失 */
const truncated = (max, fallback = '') =>
  z
    .unknown()
    .optional()
    .transform((v) => (typeof v === 'string' ? v.slice(0, max) : fallback));
const positiveNumber = z.coerce.number().finite().positive().transform(round3);

const imageSchema = z
  .object({
    file: z.string().regex(IMAGE_PATH_RE),
    w: positiveNumber.nullable().catch(null),
    h: positiveNumber.nullable().catch(null),
  })
  .transform(({ file, w, h }) => ({ file, w: w ?? null, h: h ?? null }));

const audioSchema = z
  .object({
    file: z.string().regex(AUDIO_PATH_RE),
    duration: positiveNumber.nullable().catch(null),
    format: z.string().max(12).catch(''),
    mime: z.string().max(60).catch(''),
  })
  .transform(({ file, duration, format, mime }) => ({
    file,
    duration: duration ?? null,
    format: format || '',
    mime: mime || '',
  }));

/** 容错解析一组图片：非法项跳过、重复项去重、限制数量 */
const imagesSchema = z.array(z.unknown()).transform((raw) => {
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const parsed = imageSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (seen.has(parsed.data.file)) continue;
    seen.add(parsed.data.file);
    out.push(parsed.data);
    if (out.length >= MAX_IMAGES_HARD_CAP) break;
  }
  return out;
});

const itemSchema = z
  .object({
    id: truncated(64),
    seq: z.coerce.number().int().positive().optional(),
    /** 可选标题（6 字内），用于视频进度条与章节过渡 */
    title: truncated(6),
    text: truncated(20000),
    images: z.array(z.unknown()).optional(),
    /** 第一版的单图字段，保留兼容 */
    image: z.unknown().optional(),
    audio: z.unknown().nullable().optional(),
    createdAt: truncated(40),
    updatedAt: truncated(40),
  })
  .transform((raw) => {
    const images = imagesSchema.parse([...(raw.images ?? []), ...(raw.image ? [raw.image] : [])]);
    const audio = audioSchema.safeParse(raw.audio);
    const ts = nowIso();
    return {
      id: raw.id || newId('i'),
      seq: raw.seq ?? 0,
      title: raw.title ?? '',
      text: raw.text ?? '',
      images,
      audio: audio.success ? audio.data : null,
      createdAt: raw.createdAt || ts,
      updatedAt: raw.updatedAt || ts,
    };
  });

const sectionSchema = z
  .object({
    id: truncated(64),
    name: truncated(60),
    seq: z.coerce.number().int().positive().optional(),
    createdAt: truncated(40),
    items: z.array(z.unknown()).optional(),
  })
  .transform((raw) => {
    const items = [];
    for (const entry of (raw.items ?? []).slice(0, 500)) {
      const parsed = itemSchema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
    }
    return {
      id: raw.id || newId('s'),
      name: raw.name || '未命名页签',
      seq: raw.seq ?? 0,
      createdAt: raw.createdAt || nowIso(),
      items,
    };
  });

export const stateSchema = z
  .object({
    version: z.coerce.number().optional(),
    title: truncated(120),
    updatedAt: truncated(40),
    counters: z
      .object({
        section: z.coerce.number().int().nonnegative().catch(0).optional(),
        item: z.coerce.number().int().nonnegative().catch(0).optional(),
      })
      .optional(),
    sections: z.array(z.unknown()).optional(),
  })
  .transform((raw) => {
    const sections = [];
    for (const entry of (raw.sections ?? []).slice(0, 200)) {
      const parsed = sectionSchema.safeParse(entry);
      if (parsed.success) sections.push(parsed.data);
    }
    if (sections.length === 0) {
      const ts = nowIso();
      sections.push({ id: newId('s'), name: '页签 1', seq: 1, createdAt: ts, items: [] });
    }

    // 补齐 seq，保证文件名前缀可读且稳定
    let maxSectionSeq = Math.max(0, ...sections.map((s) => s.seq));
    for (const section of sections) {
      if (!section.seq) section.seq = ++maxSectionSeq;
    }
    let maxItemSeq = Math.max(0, ...sections.flatMap((s) => s.items.map((i) => i.seq)));
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.seq) item.seq = ++maxItemSeq;
      }
    }

    return {
      version: CURRENT_STATE_VERSION,
      title: raw.title || '清单',
      updatedAt: raw.updatedAt || nowIso(),
      counters: {
        section: Math.max(raw.counters?.section ?? 0, maxSectionSeq),
        item: Math.max(raw.counters?.item ?? 0, maxItemSeq),
      },
      sections,
    };
  });

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * 版本迁移表：`迁移目标版本 -> 迁移函数`。
 * 迁移函数接收「旧版本数据」，返回「新版本数据」，逐级链式执行。
 * v1 是当前版本，没有迁移（identity）。
 *
 * 上线后加 v2 时，只需在这里追加 `2: (v1) => ({ ...v1, version: 2, ... })`，
 * `migrateState` 会自动把 1 -> 2 串起来，解析逻辑无需改动。
 */
export const migrations = {
  1: (data) => data,
};

/**
 * 把任意版本的 state 迁移到当前版本。
 * - 缺省 version 按 1 处理（第一版历史数据）。
 * - 版本高于当前版本时拒绝（旧程序读不了新数据）。
 */
export function migrateState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  let version = Number.isFinite(Number(input.version)) ? Math.trunc(Number(input.version)) : 1;
  if (version < 1) version = 1;

  if (version > CURRENT_STATE_VERSION) {
    throw badRequest(`数据版本 ${version} 高于当前支持的版本 ${CURRENT_STATE_VERSION}，请升级应用后再导入`);
  }

  let data = input;
  for (let v = version; v < CURRENT_STATE_VERSION; v += 1) {
    const migrate = migrations[v];
    if (migrate) data = migrate(data);
  }
  data.version = CURRENT_STATE_VERSION;
  return data;
}

/** 读出磁盘数据时用宽松校验：坏条目丢掉，但要能启动 */
export function parseState(input) {
  const migrated = migrateState(input);
  const result = stateSchema.safeParse(migrated);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw badRequest(`数据格式不合法：${detail || '未知原因'}`);
  }
  return result.data;
}

/**
 * 写入时用严格校验：媒体路径非法直接拒绝，
 * 避免客户端错误数据被静默丢弃后覆盖磁盘上的好数据。
 */
export function parseStateStrict(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('state 必须是对象');
  }

  const invalid = [];
  for (const section of Array.isArray(input.sections) ? input.sections : []) {
    for (const item of Array.isArray(section?.items) ? section.items : []) {
      const images = [...(Array.isArray(item?.images) ? item.images : []), ...(item?.image ? [item.image] : [])];
      for (const image of images) {
        const file = image?.file;
        if (file != null && !IMAGE_PATH_RE.test(String(file))) invalid.push(String(file));
      }
      const audioFile = item?.audio?.file;
      if (audioFile != null && !AUDIO_PATH_RE.test(String(audioFile))) invalid.push(String(audioFile));
    }
  }

  if (invalid.length > 0) {
    throw badRequest(`媒体文件路径不合法：${invalid.slice(0, 3).join(', ')}`);
  }

  return parseState(input);
}

export function defaultState() {
  const ts = nowIso();
  return {
    version: 1,
    title: '清单',
    updatedAt: ts,
    counters: { section: 1, item: 0 },
    sections: [{ id: newId('s'), name: '页签 1', seq: 1, createdAt: ts, items: [] }],
  };
}
