import { Router } from 'express';
import { subscribeLogStream, unsubscribeLogStream } from '../logstream.js';

const router = Router();

/**
 * 实时日志流（SSE）。挂在压缩中间件之前，确保不会被 gzip 缓冲而失去实时性。
 * 前端用 EventSource 连接，服务端持续推送格式化的日志行。
 */
router.get('/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // 先发一条注释作为心跳占位，让代理不立刻判定连接空闲
  res.write(': connected\n\n');

  await subscribeLogStream(res);

  const cleanup = () => unsubscribeLogStream(res);
  res.on('close', cleanup);
  res.on('finish', cleanup);
});

export default router;
