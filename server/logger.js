import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { prettyFactory } from 'pino-pretty';
import readLastLines from 'read-last-lines';
import { LOG_DIR, SERVER } from './config.js';

const LOG_PREFIX = path.join(LOG_DIR, 'app');

const transports = [
  {
    target: 'pino-pretty',
    level: SERVER.logLevel,
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,tag',
      singleLine: true,
      messageFormat: '{if tag}[{tag}] {end}{msg}',
    },
  },
];

// 文件日志：按天轮转，保留 7 个
if (SERVER.logLevel !== 'silent') {
  transports.push({
    target: 'pino-roll',
    level: 'debug',
    options: {
      file: LOG_PREFIX,
      extension: '.log',
      frequency: 'daily',
      dateFormat: 'yyyy-MM-dd',
      mkdir: true,
      limit: { count: 7 },
    },
  });
}

const silent = SERVER.logLevel === 'silent';

export const logger = silent
  ? pino({ level: 'silent' })
  : pino(
      {
        level: SERVER.logLevel,
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      pino.transport({ targets: transports }),
    );

export function setLogTag(tag, bindings = {}) {
  return logger.child({ tag, ...bindings });
}

/** 最新的一份日志文件（pino-roll 按日期命名） */
export function currentLogFile() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('app') && name.endsWith('.log'))
      .map((name) => {
        const full = path.join(LOG_DIR, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return files[0].full;
  } catch {
    /* ignore */
  }
  return null;
}

const prettyLine = prettyFactory({
  colorize: false,
  translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
  ignore: 'pid,hostname,tag',
  singleLine: true,
  messageFormat: '{if tag}[{tag}] {end}{msg}',
});

/** 文件里是 ndjson，这里格式化成可读文本 */
export function formatLogLine(line) {
  try {
    return prettyLine(JSON.parse(line)).trimEnd();
  } catch {
    return line;
  }
}

export async function readLogTail(lines = 200) {
  const limit = Math.min(Math.max(Number(lines) || 200, 1), 2000);
  const file = currentLogFile();
  if (!file) return { file: null, lines: [] };
  try {
    const text = await readLastLines.read(file, limit);
    return { file, lines: text.split('\n').filter(Boolean).map(formatLogLine) };
  } catch {
    return { file, lines: [] };
  }
}

export const log = {
  app: setLogTag('app'),
  http: setLogTag('http'),
  state: setLogTag('state'),
  media: setLogTag('media'),
  export: setLogTag('export'),
  import: setLogTag('import'),
  pdf: setLogTag('pdf'),
  video: setLogTag('video'),
  stt: setLogTag('stt'),
  llm: setLogTag('llm'),
  env: setLogTag('env'),
  cache: setLogTag('cache'),
};
