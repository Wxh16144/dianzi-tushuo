import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import which from 'which';
import { z } from 'zod';

/* ---------------- 工作区参数 ---------------- */

/**
 * 从命令行参数里解析工作区目录。
 * 支持：`--workdir <dir>`、`-w <dir>`、`-workdir <dir>`、`--workdir=<dir>`。
 */
function readWorkdirArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    if (key === '--workdir' || key === '-workdir' || key === '-w') {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) return next;
      throw new Error(`参数 ${key} 需要跟一个目录，例如：${key} /path/to/workspace`);
    }
  }
  return undefined;
}

/* ---------------- 路径 ---------------- */

export const ROOT = path.resolve(import.meta.dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

/* ---------------- .env ---------------- */

export const ENV_FILE = path.join(ROOT, '.env');
const envResult = dotenv.config({ path: ENV_FILE, quiet: true });
export const DOTENV = envResult.error
  ? null
  : { file: ENV_FILE, keys: Object.keys(envResult.parsed || {}), applied: envResult.parsed };

/* ---------------- schema ---------------- */

const envBool = (fallback = false) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalPath = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3210),
  HOST: z.string().min(1).default('127.0.0.1'),
  OPEN: envBool(false),
  DATA_DIR: optionalPath,
  EXPORTS_DIR: optionalPath,
  WORK_DIR: optionalPath,
  WORKDIR: optionalPath,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  CHROME_PATH: optionalPath,
  FFMPEG_PATH: optionalPath,
  FFPROBE_PATH: optionalPath,

  WHISPER_BIN: optionalPath,
  WHISPER_MODEL: z.string().min(1).default('mlx-community/whisper-large-v3-turbo'),
  WHISPER_LANGUAGE: z.string().min(1).default('zh'),
  WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),

  VIDEO_WIDTH: z.coerce.number().int().min(320).max(4096).default(1080),
  VIDEO_HEIGHT: z.coerce.number().int().min(320).max(4096).default(1920),
  VIDEO_FPS: z.coerce.number().int().min(1).max(60).default(25),
  VIDEO_SECONDS_PER_IMAGE: z.coerce.number().positive().default(2),
  VIDEO_TRANS_SECONDS: z.coerce.number().nonnegative().default(0.5),
  VIDEO_BURN_TEXT: envBool(true),
  VIDEO_FONT_FAMILY: optionalPath,

  LLM_PROVIDER: z.enum(['ollama', 'lmstudio', 'deepseek', 'openai', 'custom']).default('ollama'),
  LLM_BASE_URL: optionalPath,
  LLM_MODEL: optionalPath,
  LLM_API_KEY: optionalPath,
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  LLM_REASONING_EFFORT: z.string().optional(),
});

const parsedEnv = EnvSchema.safeParse(process.env);
if (!parsedEnv.success) {
  const detail = parsedEnv.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`配置有误（.env）：\n${detail}`);
}
const env = parsedEnv.data;

/* ---------------- 目录 ---------------- */

/**
 * 工作区：数据与导出文件都放在这里，默认是启动时的当前目录（process.cwd()）。
 * 优先级：`--workdir <dir>` 参数 > `WORK_DIR` / `WORKDIR` 环境变量 > 当前目录。
 */
export const WORKDIR = path.resolve(readWorkdirArg(process.argv) || env.WORK_DIR || env.WORKDIR || process.cwd());
export const DATA_DIR = env.DATA_DIR ? path.resolve(WORKDIR, env.DATA_DIR) : path.join(WORKDIR, 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const EXPORTS_DIR = env.EXPORTS_DIR ? path.resolve(WORKDIR, env.EXPORTS_DIR) : path.join(WORKDIR, 'exports');
export const VIDEO_DIR = path.join(EXPORTS_DIR, 'videos');
/** item 级视频片段缓存（跨请求复用，不会被启动清理） */
export const VIDEO_CACHE_DIR = path.join(CACHE_DIR, 'videos');

export const ALL_DIRS = [DATA_DIR, IMAGES_DIR, AUDIO_DIR, TMP_DIR, CACHE_DIR, VIDEO_CACHE_DIR, LOG_DIR, EXPORTS_DIR, VIDEO_DIR];

/* ---------------- 可执行文件 ---------------- */

const isExecutable = (p) => {
  try {
    return fs.statSync(p).isFile() && fs.accessSync(p, fs.constants.X_OK) === undefined;
  } catch {
    return false;
  }
};

const resolveBin = (label, explicit, candidates, names) => {
  if (explicit) {
    if (isExecutable(explicit)) return explicit;
    console.warn(`[config] ${label}: 指定路径不可执行 → ${explicit}`);
  }
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  for (const name of names) {
    try {
      return which.sync(name);
    } catch {
      /* 继续找下一个 */
    }
  }
  return null;
};

const HOME = os.homedir();

export const BIN = {
  ffmpeg: resolveBin('FFMPEG_PATH', env.FFMPEG_PATH, ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'], ['ffmpeg']),
  ffprobe: resolveBin('FFPROBE_PATH', env.FFPROBE_PATH, ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe'], ['ffprobe']),
  chrome: resolveBin('CHROME_PATH', env.CHROME_PATH, [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ], ['google-chrome', 'chromium', 'chrome']),
  whisper: resolveBin('WHISPER_BIN', env.WHISPER_BIN, [
    path.join(HOME, '.local/bin/mlx_whisper'),
    '/opt/homebrew/bin/mlx_whisper',
    '/usr/local/bin/mlx_whisper',
    path.join(HOME, 'Library/Python/3.13/bin/mlx_whisper'),
    path.join(HOME, 'Library/Python/3.12/bin/mlx_whisper'),
  ], ['mlx_whisper', 'mlx-whisper']),
};

/* ---------------- LLM ---------------- */

export const LLM_PRESETS = {
  ollama: {
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:4b',
    reasoningEffort: 'none',
  },
  lmstudio: {
    label: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    reasoningEffort: '',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    reasoningEffort: '',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    reasoningEffort: '',
  },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', reasoningEffort: '' },
};

/**
 * 纯函数：根据预设 + 覆盖项算出最终 LLM 配置。
 * 单独导出便于单元测试（不依赖进程环境）。
 */
export function resolveLlmConfig({
  provider = 'ollama',
  baseUrl = '',
  model = '',
  apiKey = '',
  reasoningEffort,
  timeoutMs = 90_000,
  legacyBaseUrl = '',
  legacyModel = '',
} = {}) {
  const name = LLM_PRESETS[provider] ? provider : 'custom';
  const preset = LLM_PRESETS[name];

  const resolvedBaseUrl = String(baseUrl || legacyBaseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  const resolvedModel = model || legacyModel || preset.model || '';
  const resolvedKey = apiKey || '';

  return {
    provider: name,
    label: preset.label,
    baseUrl: resolvedBaseUrl,
    model: resolvedModel,
    apiKey: resolvedKey,
    reasoningEffort: reasoningEffort ?? preset.reasoningEffort ?? '',
    timeoutMs,
    configured: Boolean(resolvedBaseUrl && resolvedModel),
  };
}

/** 默认 CJK 字体族：覆盖 macOS / Windows / Linux 常见中文字体 */
export const DEFAULT_CJK_FONT_FAMILY =
  'PingFang SC, Songti SC, STHeiti, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif';

/**
 * 纯函数：根据配置算出视频导出参数。
 * 单独导出便于单元测试（不依赖进程环境）。
 */
export function resolveVideoConfig({
  width = 1080,
  height = 1920,
  fps = 25,
  secondsPerImage = 2,
  transSeconds = 0.5,
  burnText = true,
  fontFamily = '',
} = {}) {
  const clamp = (value, lo, hi, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    width: Math.round(clamp(width, 320, 4096, 1080)),
    height: Math.round(clamp(height, 320, 4096, 1920)),
    fps: Math.round(clamp(fps, 1, 60, 25)),
    secondsPerImage: clamp(secondsPerImage, 0.5, 60, 2),
    transSeconds: clamp(transSeconds, 0, 5, 0.5),
    burnText: burnText !== false,
    fontFamily: String(fontFamily || '').trim() || DEFAULT_CJK_FONT_FAMILY,
  };
}

const resolvedLlm = resolveLlmConfig({
  provider: env.LLM_PROVIDER,
  baseUrl: env.LLM_BASE_URL,
  model: env.LLM_MODEL,
  apiKey: env.LLM_API_KEY || (LLM_PRESETS[env.LLM_PROVIDER]?.apiKeyEnv ? process.env[LLM_PRESETS[env.LLM_PROVIDER].apiKeyEnv] : ''),
  reasoningEffort: env.LLM_REASONING_EFFORT,
  timeoutMs: env.LLM_TIMEOUT_MS,
  legacyBaseUrl: process.env.OLLAMA_BASE_URL,
  legacyModel: process.env.OLLAMA_MODEL,
});

export const LLM = {
  ...resolvedLlm,
  get publicInfo() {
    return {
      provider: this.provider,
      label: this.label,
      baseUrl: this.baseUrl,
      model: this.model,
      hasApiKey: Boolean(this.apiKey),
    };
  },
};

/* ---------------- 其余 ---------------- */

export const WHISPER_MODEL = env.WHISPER_MODEL;
export const WHISPER_LANGUAGE = env.WHISPER_LANGUAGE;
export const WHISPER_TIMEOUT_MS = env.WHISPER_TIMEOUT_MS;

export const VIDEO = resolveVideoConfig({
  width: env.VIDEO_WIDTH,
  height: env.VIDEO_HEIGHT,
  fps: env.VIDEO_FPS,
  secondsPerImage: env.VIDEO_SECONDS_PER_IMAGE,
  transSeconds: env.VIDEO_TRANS_SECONDS,
  burnText: env.VIDEO_BURN_TEXT,
  fontFamily: env.VIDEO_FONT_FAMILY,
});

export const SERVER = {
  port: env.PORT,
  host: env.HOST,
  openBrowser: env.OPEN || process.argv.includes('--open'),
  logLevel: env.LOG_LEVEL,
};

export const config = {
  root: ROOT,
  workDir: WORKDIR,
  publicDir: PUBLIC_DIR,
  dataDir: DATA_DIR,
  imagesDir: IMAGES_DIR,
  audioDir: AUDIO_DIR,
  tmpDir: TMP_DIR,
  cacheDir: CACHE_DIR,
  videoCacheDir: VIDEO_CACHE_DIR,
  exportsDir: EXPORTS_DIR,
  videosDir: VIDEO_DIR,
  stateFile: STATE_FILE,
  bin: BIN,
  server: SERVER,
  llm: LLM,
  video: VIDEO,
  whisper: { model: WHISPER_MODEL, language: WHISPER_LANGUAGE, timeoutMs: WHISPER_TIMEOUT_MS },
  bin_whisper: BIN.whisper,
};

export function describeEnv() {
  const line = (label, value, extra = '') => `  ${label.padEnd(8)} ${value ? '✓ ' + value : '✗ 未找到'}${extra}`;
  return [
    line('ffmpeg', BIN.ffmpeg, BIN.ffmpeg ? '' : '  → 录音会保存为原始 webm/m4a'),
    line('ffprobe', BIN.ffprobe),
    line('chrome', BIN.chrome, BIN.chrome ? '' : '  → 无法生成 PDF，可用 CHROME_PATH 指定'),
    line('whisper', BIN.whisper, BIN.whisper ? `  (${WHISPER_MODEL})` : '  → 语音转文字不可用'),
    line('llm', LLM.configured ? `${LLM.label} · ${LLM.model}` : '✗ 未配置',
      LLM.configured ? `\n           ${LLM.baseUrl}${LLM.apiKey ? '  (已配置密钥)' : ''}` : '  → 见 .env.example'),
  ].join('\n');
}
