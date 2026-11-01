import express from 'express';
import compression from 'compression';
import createError from 'http-errors';
import multer from 'multer';
import pinoHttp from 'pino-http';
import { AUDIO_DIR, EXPORTS_DIR, IMAGES_DIR, PUBLIC_DIR, SERVER } from './config.js';
import { log } from './logger.js';
import healthRoutes from './routes/health.js';
import stateRoutes from './routes/state.js';
import mediaRoutes from './routes/media.js';
import audioRoutes from './routes/audio.js';
import exportRoutes from './routes/export.js';
import importRoutes from './routes/import.js';
import logStreamRoutes from './routes/logs.js';

const QUIET_PATHS = ['/images/', '/audio/', '/exports/', '/style.css', '/app.js', '/favicon'];

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('port', SERVER.port);
  app.set('trust proxy', 'loopback');

  // SSE 日志流必须在压缩中间件之前，否则 gzip 缓冲会让日志失去实时性
  app.use('/api/logs', logStreamRoutes);

  app.use(compression());
  app.use(
    pinoHttp({
      logger: log.http,
      autoLogging: { ignore: (req) => QUIET_PATHS.some((p) => req.url.startsWith(p)) },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug'),
    }),
  );
  app.use(express.json({ limit: '20mb' }));

  app.use('/api', healthRoutes, stateRoutes, mediaRoutes, audioRoutes, exportRoutes, importRoutes);

  app.use('/images', express.static(IMAGES_DIR, { fallthrough: false, maxAge: '1h', immutable: true }));
  app.use('/audio', express.static(AUDIO_DIR, { fallthrough: false, maxAge: '1h' }));
  app.use('/exports', express.static(EXPORTS_DIR, { fallthrough: false }));
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

  // 未匹配的 /api 请求
  app.use('/api', (req, res, next) => next(createError(404, `接口不存在：${req.method} ${req.originalUrl}`)));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err instanceof multer.MulterError
      ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      : (err.status ?? err.statusCode ?? 500);

    const message = err instanceof multer.MulterError
      ? (err.code === 'LIMIT_FILE_SIZE' ? '文件超过 60MB 限制' : `上传失败：${err.message}`)
      : (err.message || '服务内部错误');

    const payload = { error: message };
    if (status >= 500) payload.stack = undefined;

    log.http[status >= 500 ? 'error' : 'warn']({ status, path: req.originalUrl, err: err.message }, '请求失败');
    res.status(status).json(payload);
  });

  return app;
}
