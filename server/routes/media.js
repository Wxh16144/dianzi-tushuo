import createError from 'http-errors';
import { Router } from 'express';
import { processAudio, processImage, processImages, upload, uploadMany } from '../media.js';

const router = Router();

const requireFile = (file, message) => {
  if (!file?.buffer?.length) throw createError(400, message);
  return file;
};

router.post('/media/image', upload.single('file'), async (req, res) => {
  const file = requireFile(req.file, '没有收到图片数据');
  const result = await processImage(file.buffer, { sectionSeq: req.body.sectionSeq, itemSeq: req.body.itemSeq });
  res.json(result);
});

/** 一次粘贴多张：字段名 files */
router.post('/media/images', uploadMany.array('files'), async (req, res) => {
  const files = (req.files ?? []).filter((f) => f.buffer?.length);
  if (files.length === 0) throw createError(400, '没有收到图片数据');

  const images = await processImages(
    files.map((f) => f.buffer),
    { sectionSeq: req.body.sectionSeq, itemSeq: req.body.itemSeq },
  );
  res.json({ images });
});

router.post('/media/audio', upload.single('file'), async (req, res) => {
  const file = requireFile(req.file, '没有收到音频数据');
  const result = await processAudio(file.buffer, {
    mimetype: file.mimetype,
    originalName: file.originalname,
    sectionSeq: req.body.sectionSeq,
    itemSeq: req.body.itemSeq,
    clientDuration: req.body.duration,
  });
  res.json(result);
});

export default router;
