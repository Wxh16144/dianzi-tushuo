import fsp from 'node:fs/promises';
import path from 'node:path';
import createError from 'http-errors';
import AdmZip from 'adm-zip';
import { AUDIO_DIR, IMAGES_DIR } from './config.js';
import { setState } from './db.js';
import { parseState, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, CURRENT_STATE_VERSION, LEGACY_BACKUP_FORMATS } from './schema.js';
import { log } from './logger.js';

/** zip 上传大小上限 */
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
/** zip 内条目数上限，防解压炸弹 */
export const MAX_IMPORT_ENTRIES = 1000;
/** 媒体文件数量上限 */
export const MAX_IMPORT_MEDIA = 500;

const MEDIA_ENTRY_RE = /^(images|audio)\/([A-Za-z0-9._-]+)$/;

/**
 * 解析备份包并整体替换当前清单。
 * 返回导入摘要；缺失的媒体文件记入 missing 而不导致整包失败。
 */
export async function importBackup(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw createError(400, '没有收到备份文件');
  }
  if (buffer.length > MAX_IMPORT_BYTES) {
    throw createError(413, '备份文件过大');
  }

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw createError(400, '无法解析 zip 文件');
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > MAX_IMPORT_ENTRIES) {
    throw createError(400, `备份包条目过多（${entries.length} > ${MAX_IMPORT_ENTRIES}）`);
  }

  const manifestEntry = zip.getEntry('manifest.json');
  const stateEntry = zip.getEntry('state.json');
  if (!manifestEntry || !stateEntry) {
    throw createError(400, '备份包缺少 manifest.json 或 state.json');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw createError(400, 'manifest.json 不是合法 JSON');
  }

  if (![BACKUP_FORMAT, ...LEGACY_BACKUP_FORMATS].includes(manifest.format)) {
    throw createError(400, '不是本工具的备份包');
  }
  if (Number(manifest.formatVersion) !== BACKUP_FORMAT_VERSION) {
    throw createError(400, `备份包格式版本不兼容（${manifest.formatVersion} ≠ ${BACKUP_FORMAT_VERSION}）`);
  }

  // state 解析走宽松校验：坏条目丢弃，版本超出当前时在这里报错
  let state;
  try {
    const raw = JSON.parse(stateEntry.getData().toString('utf8'));
    state = parseState(raw);
  } catch (err) {
    throw createError(400, `state.json 无法解析：${err.message}`);
  }

  // 白名单写盘媒体文件，杜绝 zip-slip / 路径穿越
  const mediaEntries = [];
  for (const entry of entries) {
    const name = entry.entryName;
    if (name === 'manifest.json' || name === 'state.json') continue;

    const match = MEDIA_ENTRY_RE.exec(name);
    if (!match) {
      throw createError(400, `备份包含不允许的文件：${name}`);
    }
    const [, kind, base] = match;
    if (base === '.' || base === '..') {
      throw createError(400, `非法的媒体文件名：${name}`);
    }
    mediaEntries.push({ kind, base, data: entry.getData() });
  }

  if (mediaEntries.length > MAX_IMPORT_MEDIA) {
    throw createError(400, `媒体文件过多（${mediaEntries.length} > ${MAX_IMPORT_MEDIA}）`);
  }

  // 收集 state 引用的媒体，用于计算 missing
  const referenced = new Set();
  for (const section of state.sections ?? []) {
    for (const item of section?.items ?? []) {
      for (const image of item?.images ?? []) {
        if (image?.file) referenced.add(image.file);
      }
      if (item?.audio?.file) referenced.add(item.audio.file);
    }
  }

  const present = new Set(mediaEntries.map((m) => `${m.kind}/${m.base}`));
  const missing = [...referenced].filter((rel) => !present.has(rel));

  // 先落盘媒体，再整体替换 state
  for (const { kind, base, data } of mediaEntries) {
    const target = path.join(kind === 'images' ? IMAGES_DIR : AUDIO_DIR, base);
    await fsp.writeFile(target, data);
  }

  await setState(state);

  const images = mediaEntries.filter((m) => m.kind === 'images').length;
  const audio = mediaEntries.filter((m) => m.kind === 'audio').length;

  log.import.info(
    {
      title: state.title,
      sections: state.sections.length,
      items: state.sections.reduce((sum, s) => sum + s.items.length, 0),
      images,
      audio,
      missing: missing.length,
    },
    '导入完成',
  );

  return {
    ok: true,
    version: CURRENT_STATE_VERSION,
    title: state.title,
    sections: state.sections.length,
    items: state.sections.reduce((sum, s) => sum + s.items.length, 0),
    images,
    audio,
    missing,
  };
}
