import createError from 'http-errors';
import { Router } from 'express';
import open from 'open';
import { getState } from '../db.js';
import { buildExport, buildPdf } from '../export.js';
import { chromeReady } from '../pdf.js';
import { VIDEO_DIR } from '../config.js';
import { buildVideos } from '../video.js';

const router = Router();

/** 同一时间只允许一个导出任务，避免并发启动多个 Chrome */
let busy = false;

const withLock = async (fn) => {
  if (busy) throw createError(429, '正在导出，请稍候再试');
  if (!chromeReady()) {
    throw createError(503, '未找到 Chrome/Chromium，无法生成 PDF。请设置 CHROME_PATH 环境变量后重启服务');
  }
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
};

/** 视频导出走独立的锁：只依赖 ffmpeg，不该被 Chrome 的 PDF/zip 任务阻塞 */
let videoBusy = false;

const withVideoLock = async (fn) => {
  if (videoBusy) throw createError(429, '正在生成视频，请稍候再试');
  videoBusy = true;
  try {
    return await fn();
  } finally {
    videoBusy = false;
  }
};

router.post('/export/pdf', async (req, res) => {
  const result = await withLock(() => buildPdf({ port: req.app.get('port') }));
  res.json(result);
});

/** zip 备份不依赖 Chrome，无需加锁 */
router.post('/export', async (req, res) => {
  const result = await buildExport({ state: getState() });
  res.json(result);
});

router.post('/export/video', async (req, res) => {
  const result = await withVideoLock(() => buildVideos({ state: getState(), mode: req.body?.mode, itemId: req.body?.itemId }));
  res.json(result);
});

/** 在本机 Finder 里打开视频目录（仅浏览器与服务同机时有意义） */
router.post('/export/video/open', async (req, res) => {
  try {
    await open(VIDEO_DIR);
  } catch (err) {
    throw createError(500, `无法打开视频目录：${err.message}`);
  }
  res.json({ ok: true, dir: 'exports/videos' });
});

export default router;
