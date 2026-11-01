import fs from 'node:fs';
import { currentLogFile, formatLogLine, readLogTail } from './logger.js';

/**
 * 把 pino-roll 写盘的日志实时广播给浏览器（SSE）。
 *
 * 这里不碰 pino 的 transport 管线，而是直接「追尾」当天日志文件：
 * 有订阅者时启动轮询，读到新增字节就解析成行并广播。
 * 这样能天然复用已经写好的文件日志，不需要为日志再引入一条写入通路。
 */

const clients = new Set();
let timer = null;
let lastFile = null;
let offset = 0;
let pending = '';

const POLL_MS = 400;

function emitLine(line) {
  const payload = `data: ${JSON.stringify({ line })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function flushNewLines() {
  const file = currentLogFile();
  if (!file) return;

  if (file !== lastFile) {
    // 日志按天轮转：从新文件开头读
    lastFile = file;
    offset = 0;
    pending = '';
  }

  const size = fileSize(file);
  if (size < offset) {
    // 文件被截断重写
    offset = 0;
    pending = '';
  }
  if (size <= offset) return;

  const len = size - offset;
  const buf = Buffer.alloc(len);
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, offset);
  } catch {
    return;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  offset = size;

  pending += buf.toString('utf8');
  let idx;
  while ((idx = pending.indexOf('\n')) >= 0) {
    const raw = pending.slice(0, idx).trim();
    pending = pending.slice(idx + 1);
    if (raw) emitLine(formatLogLine(raw));
  }
}

function start() {
  if (timer) return;
  timer = setInterval(flushNewLines, POLL_MS);
  timer.unref?.();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sendSnapshot(res) {
  try {
    const { lines } = await readLogTail(120);
    for (const line of lines) emitTo(res, line);
  } catch {
    /* 忽略：快照失败不影响后续实时日志 */
  }
}

function emitTo(res, line) {
  try {
    res.write(`data: ${JSON.stringify({ line })}\n\n`);
  } catch {
    clients.delete(res);
  }
}

/** 订阅实时日志。返回后，res 会持续收到 `data: {"line": "…"}` 事件。 */
export async function subscribeLogStream(res) {
  const isFirst = clients.size === 0;
  clients.add(res);
  await sendSnapshot(res);

  if (isFirst) {
    // 把游标指到当前文件末尾，避免重复推送快照里已有的行
    const file = currentLogFile();
    lastFile = file;
    pending = '';
    offset = file ? fileSize(file) : 0;
    start();
  }
}

export function unsubscribeLogStream(res) {
  clients.delete(res);
  if (clients.size === 0) stop();
}
