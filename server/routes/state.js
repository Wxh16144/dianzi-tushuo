import { Router } from 'express';
import { getState, resetState, setState } from '../db.js';
import { log } from '../logger.js';

const router = Router();

router.get('/state', (req, res) => {
  res.set('Cache-Control', 'no-store').json(getState());
});

router.put('/state', async (req, res) => {
  const saved = await setState(req.body);
  res.set('Cache-Control', 'no-store').json({ ok: true, updatedAt: saved.updatedAt });
});

router.post('/reset', async (req, res) => {
  const fresh = await resetState();
  log.state.info('清单已清空（媒体文件保留在 data/images、data/audio）');
  res.set('Cache-Control', 'no-store').json(fresh);
});

export default router;
