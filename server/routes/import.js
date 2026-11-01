import createError from 'http-errors';
import { Router } from 'express';
import multer from 'multer';
import { importBackup, MAX_IMPORT_BYTES } from '../import.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_BYTES, files: 1 },
});

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file?.buffer?.length) throw createError(400, '没有收到备份文件');
  const result = await importBackup(req.file.buffer);
  res.json(result);
});

export default router;
