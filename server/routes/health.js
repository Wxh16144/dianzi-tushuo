import createError from 'http-errors';
import open from 'open';
import { Router } from 'express';
import sharp from 'sharp';
import { BIN, DOTENV, LLM, ROOT, SERVER, VIDEO, VIDEO_AUDIO_SOURCE, VIDEO_TTS_VOICE, WHISPER_LANGUAGE, WHISPER_MODEL, WORKDIR } from '../config.js';
import { readLogTail } from '../logger.js';
import { incompleteBlobs, llmStatus, modelCacheDir, modelCached, sttReady } from '../stt.js';

const router = Router();

router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    node: process.version,
    root: ROOT,
    workDir: WORKDIR,
    port: SERVER.port,
    sharp: sharp.versions?.vips ? `libvips ${sharp.versions.vips}` : 'ok',
    ffmpeg: BIN.ffmpeg,
    ffprobe: BIN.ffprobe,
    chrome: BIN.chrome,
    say: BIN.say,
    video: {
      audioSource: VIDEO_AUDIO_SOURCE,
      ttsVoice: VIDEO_TTS_VOICE,
      secondsPerImage: VIDEO.secondsPerImage,
      transSeconds: VIDEO.transSeconds,
      burnText: VIDEO.burnText,
      progressBar: VIDEO.progressBar,
    },
    stt: { ready: sttReady(), engine: 'mlx-whisper' },
    llm: LLM.publicInfo,
    env: DOTENV ? { file: '.env', keys: DOTENV.keys.length } : null,
  });
});

router.get('/logs', async (req, res) => {
  const { file, lines } = await readLogTail(req.query.lines);
  res.set('Cache-Control', 'no-store');
  if (req.query.format === 'text') {
    return res.type('text/plain; charset=utf-8').send(lines.join('\n'));
  }
  res.json({ file, count: lines.length, lines });
});

/** 在本机 Finder 里打开工作区文件夹（仅浏览器与服务同机时有意义） */
router.post('/workdir/open', async (req, res) => {
  try {
    await open(WORKDIR);
  } catch (err) {
    throw createError(500, `无法打开工作区：${err.message}`);
  }
  res.json({ ok: true, dir: WORKDIR });
});

router.get('/audio/status', async (req, res) => {
  const llm = await llmStatus();
  res.set('Cache-Control', 'no-store').json({
    sttReady: sttReady(),
    engine: 'mlx-whisper',
    stt: {
      model: WHISPER_MODEL,
      language: WHISPER_LANGUAGE,
      modelCached: modelCached(),
      modelCacheDir: modelCacheDir(),
      // 下载中断会留下 .incomplete 分片，占用空间且导致转写必失败
      incompleteCount: incompleteBlobs().length,
      bin: BIN.whisper,
    },
    llm,
  });
});

export default router;
