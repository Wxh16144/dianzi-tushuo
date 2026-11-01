import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 每个测试文件在独立进程里跑（node --test 默认如此）。
 * 这个 helper 把数据和导出目录指到临时目录，并关掉日志，
 * 保证测试不污染仓库、不写日志文件、不启动 pino worker。
 */
export async function createSandbox(prefix = 'hubz-test-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.EXPORTS_DIR = path.join(root, 'exports');
  process.env.LOG_LEVEL = 'silent';
  // 确保测试不依赖本机安装的 whisper 与 Chrome（显式指定的除外）
  delete process.env.WHISPER_BIN;
  if (process.env.CHROME_PATH) {
    // 保留调用方显式指定的 Chrome
  } else {
    delete process.env.CHROME_PATH;
  }
  delete process.env.FFMPEG_PATH;

  const config = await import('../../server/config.js');
  const db = await import('../../server/db.js');

  // HUBZ_TEST_NO_CHROME=1 时模拟没有浏览器的环境，用来验证跳过逻辑
  if (process.env.HUBZ_TEST_NO_CHROME === '1') config.BIN.chrome = null;

  await db.ensureDirs();
  await db.initDb();

  return {
    root,
    config,
    db,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** 生成一张纯色测试图片（返回 buffer） */
export async function makeImage({ width = 800, height = 600, alpha = false, color = { r: 200, g: 120, b: 60 } } = {}) {
  const sharp = (await import('sharp')).default;
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height; i += 1) {
    data[i * channels] = color.r;
    data[i * channels + 1] = color.g;
    data[i * channels + 2] = color.b;
    if (alpha) data[i * channels + 3] = 255;
  }
  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}
