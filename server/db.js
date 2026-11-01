import fs from 'node:fs/promises';
import path from 'node:path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import dayjs from 'dayjs';
import { ALL_DIRS, DATA_DIR, IMAGES_DIR, AUDIO_DIR, TMP_DIR, EXPORTS_DIR, STATE_FILE } from './config.js';
import { defaultState, parseState, parseStateStrict } from './schema.js';
import { log } from './logger.js';

/** lowdb + steno：写入是原子的（tmp + rename）并且自动串行化 */
const adapter = new JSONFile(STATE_FILE);
const db = new Low(adapter, defaultState());

let ready = false;

export async function ensureDirs() {
  await Promise.all(ALL_DIRS.map((dir) => fs.mkdir(dir, { recursive: true })));
}

/** 启动时清掉上次异常退出留下的临时文件 */
export async function cleanTmp() {
  try {
    const entries = await fs.readdir(TMP_DIR);
    await Promise.all(entries.map((name) => fs.rm(path.join(TMP_DIR, name), { force: true, recursive: true })));
  } catch {
    /* 目录不存在就忽略 */
  }
}

export async function initDb() {
  await ensureDirs();
  await cleanTmp();

  try {
    await db.read();
  } catch (err) {
    const backup = `${STATE_FILE}.broken-${dayjs().format('YYYYMMDD-HHmmss')}`;
    await fs.rename(STATE_FILE, backup).catch(() => {});
    log.state.warn({ backup: path.basename(backup), err: err.message }, 'state.json 无法解析，已备份并重建');
    db.data = defaultState();
  }

  db.data = parseState(db.data ?? defaultState());
  await db.write();
  ready = true;
  log.state.info({ file: STATE_FILE, sections: db.data.sections.length }, '清单已加载');
  return db.data;
}

export function getState() {
  if (!ready) throw new Error('数据尚未加载');
  return db.data;
}

export async function setState(input) {
  const normalized = parseStateStrict(input);
  normalized.updatedAt = dayjs().toISOString();
  db.data = normalized;
  await db.write();
  return db.data;
}

export async function resetState() {
  db.data = defaultState();
  await db.write();
  return db.data;
}

export function findItem(itemId) {
  for (const section of getState().sections) {
    const item = section.items.find((i) => i.id === itemId);
    if (item) return { section, item };
  }
  return null;
}

const MEDIA_PATH_RE = /^(images|audio)\/[A-Za-z0-9._-]+$/;

export function resolveDataPath(relative) {
  if (!MEDIA_PATH_RE.test(relative)) {
    throw Object.assign(new Error(`非法的媒体路径：${relative}`), { status: 400 });
  }
  return path.join(DATA_DIR, relative);
}

export async function dataFileExists(relative) {
  try {
    await fs.access(resolveDataPath(relative));
    return true;
  } catch {
    return false;
  }
}

export const dirs = { DATA_DIR, IMAGES_DIR, AUDIO_DIR, TMP_DIR, EXPORTS_DIR };
export { db };
