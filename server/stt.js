import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { BIN, LLM, WHISPER_LANGUAGE, WHISPER_MODEL, WHISPER_TIMEOUT_MS } from './config.js';
import { log } from './logger.js';
import { createCache, hashKey, sha256 } from './cache.js';

const S = log.stt;
const L = log.llm;

export const sttReady = () => Boolean(BIN.whisper);

/**
 * 找到 mlx-whisper 同一环境里的 hf 命令（pipx 会把两个脚本装在同一个 bin 目录）。
 * 用它预下载模型，避免把下载放进转写超时里。
 */
export function findHfBin() {
  if (!BIN.whisper) return null;
  try {
    const dir = path.dirname(fs.realpathSync(BIN.whisper));
    for (const name of ['hf', 'huggingface-cli']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* 找不到就算了 */
  }
  return null;
}

/* ---------------- 模型缓存 ---------------- */

/** 本地目录（绝对路径、~、./、../ 开头）→ 直接当模型目录用；否则按 HF 仓库名处理 */
export const isLocalModelDir = (model = WHISPER_MODEL) => {
  const m = String(model ?? '').trim();
  if (!m) return false;
  return path.isAbsolute(m) || m.startsWith('~') || m.startsWith('./') || m.startsWith('../');
};

/** 把 ~ 展开成绝对路径；HF 仓库名原样返回 */
export function resolveModelPath(model = WHISPER_MODEL) {
  const m = String(model ?? '').trim();
  if (!isLocalModelDir(m)) return m;
  return m.startsWith('~') ? path.join(os.homedir(), m.slice(1)) : path.resolve(m);
}

export function modelCacheDir(model = WHISPER_MODEL) {
  if (isLocalModelDir(model)) return resolveModelPath(model);
  const hubRoot = process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : path.join(os.homedir(), '.cache/huggingface/hub');
  return path.join(hubRoot, `models--${String(model).replace(/\//g, '--')}`);
}

/** 列出模型缓存里未下载完成的分片（下载中断会留下这些文件） */
export function incompleteBlobs(model = WHISPER_MODEL) {
  if (isLocalModelDir(model)) return [];
  try {
    const blobs = path.join(modelCacheDir(model), 'blobs');
    return fs
      .readdirSync(blobs)
      .filter((name) => name.endsWith('.incomplete'))
      .map((name) => path.join(blobs, name));
  } catch {
    return [];
  }
}

/**
 * mlx-whisper 的权重文件名随模型仓库而异（已实际核对 HuggingFace）：
 *   whisper-tiny / base / small  → weights.npz
 *   whisper-large-v3-turbo       → weights.safetensors
 */
export const WEIGHT_FILENAMES = ['weights.safetensors', 'weights.npz'];

/**
 * 判断模型是否真的可用。
 *
 * 只看目录是否存在会误判：下载中断的缓存目录同样存在，但没有权重。
 * 规则：没有 .incomplete 残片，且 snapshots/<rev>/ 下存在非空的权重文件。
 */
export function modelCached(model = WHISPER_MODEL) {
  try {
    // 本地目录：权重直接放在目录下，不用 HF 的 snapshots/ 结构
    if (isLocalModelDir(model)) {
      const dir = resolveModelPath(model);
      return WEIGHT_FILENAMES.some((name) => {
        try {
          return fs.statSync(path.join(dir, name)).size > 0;
        } catch {
          return false;
        }
      });
    }

    const dir = modelCacheDir(model);

    // 有未完成分片 = 上次下载中断
    if (incompleteBlobs(model).length > 0) return false;

    const snapshots = path.join(dir, 'snapshots');
    if (!fs.existsSync(snapshots)) return false;

    return fs.readdirSync(snapshots).some((rev) =>
      WEIGHT_FILENAMES.some((name) => {
        try {
          // 权重通常是指向 blobs 的软链接，stat 能取到真实大小
          return fs.statSync(path.join(snapshots, rev, name)).size > 0;
        } catch {
          return false;
        }
      }),
    );
  } catch {
    return false;
  }
}

/* ---------------- 转写 ---------------- */

/** 从 mlx_whisper 的输出里挑出最有价值的一行错误 */
const ERROR_HINTS = [
  /Repository Not Found/i,
  /Invalid username or password/i,
  /401|403/,
  /Couldn't connect|Connection (error|refused|reset)|Max retries/i,
  /CUDA|MLX|out of memory|MemoryError/i,
  /Traceback/,
  /Skipping .* due to/i,
  /Error|Exception/i,
];

export function extractFailureReason(output) {
  const text = String(output ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  // 优先带关键字的行，其次取最后几行（异常通常在末尾）
  const hinted = lines.filter((line) => ERROR_HINTS.some((re) => re.test(line)));
  const picked = (hinted.length > 0 ? hinted : lines.slice(-3)).slice(-3);
  return picked.join(' | ').replace(/\s+/g, ' ').slice(0, 400);
}

/** 把底层错误翻译成用户能照着做的提示 */
export function explainFailure(reason = '') {
  const text = String(reason);

  if (/Repository Not Found|Invalid username or password|\b401\b|\b403\b/i.test(text)) {
    return {
      status: 502,
      message: '模型下载失败：无法从 HuggingFace 获取模型（网络或代理问题）。可以换更小的模型，例如在 .env 里设置 WHISPER_MODEL=mlx-community/whisper-tiny，或配置 HF_ENDPOINT 镜像后重试。',
    };
  }

  if (/Couldn't connect|Connection (error|refused|reset)|Max retries|timed? ?out/i.test(text)) {
    return {
      status: 504,
      message: '连接 HuggingFace 超时，模型没下载完。请检查网络/代理后重试，或改用更小的 WHISPER_MODEL。',
    };
  }

  if (/out of memory|MemoryError|MLX/i.test(text)) {
    return {
      status: 507,
      message: '转写时内存不足。请改用更小的模型（WHISPER_MODEL=mlx-community/whisper-small-mlx 或 whisper-tiny）。',
    };
  }

  return {
    status: 500,
    message: 'mlx-whisper 执行失败但没有生成文本。请查看 data/logs 里的详细输出。',
  };
}

/** tqdm 进度条塞满 \r 和转义字符，只保留最后一条有效信息 */
const summarizeStderr = (raw) => {
  const parts = String(raw ?? '').split(/[\r\n]+/).map((t) => t.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').slice(0, 160);
};

export async function transcribe(filePath) {
  if (!BIN.whisper) {
    throw Object.assign(
      new Error('未安装 mlx-whisper，无法转写。安装：pipx install mlx-whisper --python python3.13'),
      { status: 503 },
    );
  }

  const base = path.basename(filePath);
  const stat = await fsp.stat(filePath).catch(() => null);
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dianzi-tushuo-stt-'));
  const started = Date.now();
  const cachedBefore = modelCached();

  S.info({ file: base, size: stat?.size, model: WHISPER_MODEL, lang: WHISPER_LANGUAGE, cached: cachedBefore }, '开始转写');

  /*
   * 关键：不能在转写的超时里下载模型。
   * mlx_whisper 会在转写时自动下载模型，但大模型在慢网络下要几十分钟到几小时，
   * 会被 WHISPER_TIMEOUT_MS（默认 15 分钟）杀掉，留下 .incomplete 残片，
   * 下次又要重下 —— 形成永远失败的循环。
   * 所以模型没准备好时直接报错，让用户用 npm run stt:download 单独下载。
   */
  if (!cachedBefore) {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
    const hint = findHfBin()
      ? '运行 npm run stt:download 单独下载模型（可断点续传，不受转写超时限制）'
      : '先安装 huggingface_hub 或手动下载模型';
    const message = `模型 ${WHISPER_MODEL} 尚未下载完成，无法转写。${hint}。`;
    S.error({ model: WHISPER_MODEL, cacheDir: modelCacheDir() }, '模型未就绪，已拒绝转写');
    throw Object.assign(new Error(message), { status: 503, reason: 'model-not-ready' });
  }

  try {
    const { stdout, stderr } = await execa(
      BIN.whisper,
      [
        filePath,
        '--model', resolveModelPath(WHISPER_MODEL),
        '--language', WHISPER_LANGUAGE,
        '--output-dir', outDir,
        '--output-format', 'txt',
        '--verbose', 'False',
      ],
      { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );

    // 重要：mlx_whisper 的 CLI 会把异常 print 出来后 exit 0，
    // 所以「退出码 0」不等于成功，必须检查输出文件。
    const entries = await fsp.readdir(outDir);
    const txt = entries.find((name) => name.endsWith('.txt'));
    if (!txt) {
      const reason = extractFailureReason(`${stdout}\n${stderr}`) || '（没有任何输出）';
      const explained = explainFailure(reason);
      S.error(
        { file: base, ms: Date.now() - started, reason, cached: cachedBefore },
        'mlx-whisper 退出码为 0 但没有生成文本',
      );
      throw Object.assign(new Error(`${explained.message}（原因：${reason}）`), {
        status: explained.status,
        reason,
      });
    }

    const text = (await fsp.readFile(path.join(outDir, txt), 'utf8')).trim();
    const ms = Date.now() - started;

    S.info(
      { file: base, ms, chars: text.length, downloaded: !cachedBefore, progress: summarizeStderr(stderr) || undefined },
      '转写完成',
    );

    return { text, ms, downloaded: !cachedBefore, model: WHISPER_MODEL };
  } catch (err) {
    const reason = err.reason || summarizeStderr(err.stderr) || err.shortMessage || err.message;
    S.error({ file: base, ms: Date.now() - started, reason }, '转写失败');

    // 保证前端拿到的是可读提示，而不是 @execa 的英文原文
    if (!err.status) {
      const explained = explainFailure(reason);
      throw Object.assign(new Error(`${explained.message}（原因：${reason}）`), {
        status: explained.status,
        reason,
      });
    }
    throw err;
  } finally {
    await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------------- 整理描述 ---------------- */

const stripThinking = (content) =>
  String(content ?? '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*(思考|thinking)[:：][\s\S]*?\n\n/i, '')
    .trim();

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          reasoning_content: z.string().nullish(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .partial()
    .optional(),
});

/** 描述整理的 system prompt，独立成函数：既给 describe 用，也参与描述缓存的 key 计算 */
export function buildDescribeSystem() {
  return (
    [
      '你是「电子图说 · 语音布置清单」的布置说明整理助手。',
      '',
      '【输入】用户对某条清单的口述录音，经语音识别转写后的文本。',
      '转写可能包含同音错别字、口语词、停顿、重复和自我修正。',
      '',
      '【输出】一段可直接使用的「布置描述」正文，它会被追加到该条目的文案栏，',
      '导出到 PDF 的窄栏，并烧录成竖屏视频底部的字幕条。',
      '',
      '【必须保留】',
      '1. 布置关键信息：尺寸、材质、颜色、数量、位置、朝向、工艺、风格等；',
      '2. 数字与单位（如 2 米、3 组、60cm、香槟金）；',
      '3. 结合布置语境，纠正转写中明显的同音错别字。',
      '',
      '【必须去掉】',
      '1. 口头语与填充词：嗯、啊、那个、就是、然后；',
      '2. 重复表达与自我修正，只保留最终结论；',
      '3. 与布置无关的闲聊或客套。',
      '',
      '【格式要求】',
      '1. 用 1～3 句中文书面语，总长不超过 88 字（字幕上限 4 行 × 22 字，超长会被截断加省略号）；',
      '2. 句子之间用句号分隔，是陈述性的说明，不是标题、列表或对话；',
      '3. 只输出正文本身：不要标题、不要「这段描述是…」之类的引导语、不要 markdown、不要引号包裹、不要解释或思考过程。',
    ].join('\n') + (/qwen3/i.test(LLM.model) ? ' /no_think' : '')
  );
}

export async function describe(transcript) {
  const text = String(transcript ?? '').trim();
  if (!text) return null;
  if (!LLM.configured) {
    throw Object.assign(
      new Error('未配置 LLM：请在 .env 里设置 LLM_PROVIDER 或 LLM_BASE_URL / LLM_MODEL'),
      { status: 503 },
    );
  }

  const started = Date.now();
  const system = buildDescribeSystem();

  const request = (withReasoning) =>
    fetch(`${LLM.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(LLM.apiKey ? { Authorization: `Bearer ${LLM.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(LLM.timeoutMs),
      body: JSON.stringify({
        model: LLM.model,
        stream: false,
        temperature: 0.3,
        ...(withReasoning && LLM.reasoningEffort ? { reasoning_effort: LLM.reasoningEffort } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
      }),
    });

  // 部分服务不认 reasoning_effort，遇到 400 时去掉该字段重试一次
  let res = await request(true);
  if (res.status === 400 && LLM.reasoningEffort) {
    const detail = await res.text().catch(() => '');
    if (/reasoning|unsupported|unknown|invalid/i.test(detail)) res = await request(false);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    L.error({ status: res.status, model: LLM.model, ms: Date.now() - started, detail }, 'LLM 请求失败');
    throw new Error(`LLM 返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  const parsed = chatResponseSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error('LLM 返回结构无法识别（缺少 choices[].message.content）');

  const message = parsed.data.choices[0].message;
  const content = stripThinking(message.content);
  const ms = Date.now() - started;

  L.info({ provider: LLM.provider, model: LLM.model, ms, ...parsed.data.usage }, content ? '描述已生成' : '描述为空');
  return { text: content || null, ms, usage: parsed.data.usage };
}

/* ---------------- 转写 / 描述缓存 ---------------- */

/**
 * 缓存按「内容哈希」寻址，和文件名 / uuid 无关：
 * - 转写缓存 key = whisper 模型 + 语言 + 音频字节哈希
 * - 描述缓存 key = LLM 服务商 + 模型 + 推理强度 + system prompt 哈希 + 转写文本
 * prompt 参与哈希，意味着以后改提示词会自动让旧缓存失效，无需手改版本号。
 */
const transcriptCache = createCache('stt-transcript', { maxAgeMs: 30 * 24 * 3600 * 1000, maxBytes: 256 * 1024 * 1024 });
const describeCache = createCache('stt-describe', { maxAgeMs: 30 * 24 * 3600 * 1000, maxBytes: 64 * 1024 * 1024 });

export const transcriptCacheKey = (audioHash) => hashKey(WHISPER_MODEL, WHISPER_LANGUAGE, audioHash);
export const describeCacheKey = (transcript) =>
  hashKey(LLM.provider, LLM.model, LLM.reasoningEffort ?? '', buildDescribeSystem(), transcript);

const readJson = (buf) => {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
};

/** 带缓存的转写：命中直接返回，未命中跑 mlx-whisper 并写缓存 */
export async function transcribeCached(filePath) {
  const bytes = await fsp.readFile(filePath);
  const key = transcriptCacheKey(sha256(bytes));
  const hit = await transcriptCache.get(key);
  if (hit) {
    const payload = readJson(hit.data);
    if (payload?.text) {
      S.info({ file: path.basename(filePath), cache: 'hit' }, '转写命中缓存');
      return { text: payload.text, ms: 0, downloaded: false, cached: true };
    }
  }

  const result = await transcribe(filePath);
  await transcriptCache
    .set(key, Buffer.from(JSON.stringify({ text: result.text, downloaded: result.downloaded })))
    .catch((err) => S.warn({ err: err.message }, '写转写缓存失败'));
  return { ...result, cached: false };
}

/** 带缓存的描述整理：命中直接返回，未命中调 LLM 并写缓存（只缓存非空结果） */
export async function describeCached(transcript) {
  const text = String(transcript ?? '').trim();
  if (!text) return null;

  const key = describeCacheKey(text);
  const hit = await describeCache.get(key);
  if (hit) {
    const payload = readJson(hit.data);
    if (payload?.text) {
      L.info({ cache: 'hit' }, '描述命中缓存');
      return { text: payload.text, ms: 0, cached: true };
    }
  }

  const result = await describe(text);
  if (result?.text) {
    await describeCache
      .set(key, Buffer.from(JSON.stringify({ text: result.text })))
      .catch((err) => L.warn({ err: err.message }, '写描述缓存失败'));
  }
  return { text: result?.text ?? null, ms: result?.ms ?? 0, cached: false };
}

/* ---------------- 健康检查 ---------------- */

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })).default([]) });

export async function llmStatus(timeoutMs = 1200) {
  if (!LLM.configured) return { reachable: false, configured: false, error: '未配置 LLM' };

  try {
    const res = await fetch(`${LLM.baseUrl}/models`, {
      headers: LLM.apiKey ? { Authorization: `Bearer ${LLM.apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, configured: true, provider: LLM.provider, error: `HTTP ${res.status}` };

    const parsed = modelsSchema.safeParse(await res.json().catch(() => ({})));
    const models = parsed.success ? parsed.data.data.map((m) => m.id) : [];
    return {
      reachable: true,
      configured: true,
      provider: LLM.provider,
      hasModel: models.includes(LLM.model),
      models: models.slice(0, 20),
    };
  } catch (err) {
    return {
      reachable: false,
      configured: true,
      provider: LLM.provider,
      error: err.name === 'TimeoutError' || err.name === 'AbortError' ? '连接超时' : err.message,
    };
  }
}
