import createError from 'http-errors';
import { Router } from 'express';
import { dataFileExists, findItem, resolveDataPath } from '../db.js';
import { describeCached, sttReady, transcribeCached } from '../stt.js';
import { log } from '../logger.js';

const router = Router();

/** 把一条录音转成文字，再让 LLM 整理成一句描述 */
router.post('/audio/transcribe', async (req, res) => {
  const started = Date.now();
  const itemId = String(req.body?.itemId ?? '');
  if (!itemId) throw createError(400, '缺少 itemId');

  const found = findItem(itemId);
  if (!found) throw createError(404, '找不到这个条目');
  if (!found.item.audio?.file) throw createError(400, '这个条目还没有录音');

  const filePath = resolveDataPath(found.item.audio.file);
  if (!(await dataFileExists(found.item.audio.file))) {
    throw createError(404, `录音文件不存在：${found.item.audio.file}`);
  }
  if (!sttReady()) {
    throw createError(503, '未安装 mlx-whisper。安装命令：pipx install mlx-whisper --python python3.13，然后重启服务');
  }

  const sttResult = await transcribeCached(filePath);
  if (!sttResult.text) throw createError(422, '没有识别到语音内容');

  let description = null;
  let llmError = null;
  let describeMs = 0;
  let describeCached = false;

  try {
    const result = await describeCached(sttResult.text);
    description = result?.text ?? null;
    describeMs = result?.ms ?? 0;
    describeCached = Boolean(result?.cached);
  } catch (err) {
    llmError = err.message;
    log.llm.warn({ err: err.message }, '生成描述失败（不影响转写）');
  }

  const audioSeconds = Number(found.item.audio.duration) || 0;
  const timings = {
    transcribeMs: sttResult.ms,
    transcribeCached: Boolean(sttResult.cached),
    describeMs,
    describeCached,
    totalMs: Date.now() - started,
    downloaded: Boolean(sttResult.downloaded),
    audioSeconds,
    speed: sttResult.ms > 0 && audioSeconds > 0 ? Math.round((audioSeconds / (sttResult.ms / 1000)) * 10) / 10 : null,
  };

  log.stt.info(
    {
      file: found.item.audio.file,
      transcribeMs: timings.transcribeMs,
      describeMs: timings.describeMs,
      totalMs: timings.totalMs,
      chars: sttResult.text.length,
      descChars: description?.length ?? 0,
    },
    '转写流程完成',
  );

  res.json({ transcript: sttResult.text, description, llmError, tookMs: timings.totalMs, timings });
});

export default router;
