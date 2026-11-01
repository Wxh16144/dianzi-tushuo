import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 这些测试不调用真实 whisper，只验证纯逻辑：
 * 失败原因提取、错误翻译、模型缓存判定。
 */

// 用临时 HF_HOME 隔离，避免影响真实模型缓存
const fakeHome = path.join(os.tmpdir(), `hubz-hf-${process.pid}`);

let stt;
let cacheDir;

before(async () => {
  await fs.mkdir(fakeHome, { recursive: true });
  process.env.HF_HOME = fakeHome;
  process.env.LOG_LEVEL = 'silent';
  // 显式用一个不存在的 HF 仓库名，避免真实 .env 里的本地目录模型干扰「未缓存」分支
  process.env.WHISPER_MODEL = 'mlx-community/hubz-test-nonexistent';
  stt = await import('../server/stt.js');
  cacheDir = stt.modelCacheDir('mlx-community/test-model');
});

after(async () => {
  await fs.rm(fakeHome, { recursive: true, force: true });
});

describe('extractFailureReason：从输出里挑出真实错误', () => {
  test('优先挑 HuggingFace 仓库不存在的那行', () => {
    const raw = `
Fetching 4 files:   0%|          | 0/4 [00:00<?, ?it/s]
Repository Not Found for url: https://huggingface.co/api/models/x/y/revision/main.
Please make sure you specified the correct \`repo_id\`.
Some trailing noise`;
    const reason = stt.extractFailureReason(raw);
    assert.match(reason, /Repository Not Found/);
    assert.ok(reason.length <= 400, '原因不应过长');
  });

  test('没有关键字时取最后几行', () => {
    const reason = stt.extractFailureReason('line1\nline2\nline3\nline4');
    assert.match(reason, /line4/);
  });

  test('过滤 ANSI 颜色与 \\r 进度条', () => {
    const raw = '\u001b[32m下载中\u001b[0m\r100%|\r\n最后一行错误';
    const reason = stt.extractFailureReason(raw);
    assert.ok(!reason.includes('\u001b['), '不应残留 ANSI 转义');
    assert.match(reason, /最后一行错误/);
  });

  test('空输出返回空字符串', () => {
    assert.equal(stt.extractFailureReason(''), '');
    assert.equal(stt.extractFailureReason(null), '');
  });
});

describe('explainFailure：把底层错误翻译成可操作提示', () => {
  test('仓库/鉴权问题 → 502，建议换小模型或配置镜像', () => {
    const e = stt.explainFailure('Repository Not Found for url: ...');
    assert.equal(e.status, 502);
    assert.match(e.message, /WHISPER_MODEL|HF_ENDPOINT|模型下载失败/);
  });

  test('401/403 也归为下载失败', () => {
    assert.equal(stt.explainFailure('HTTP 401 Unauthorized').status, 502);
  });

  test('连接问题 → 504', () => {
    const e = stt.explainFailure("Couldn't connect to server");
    assert.equal(e.status, 504);
    assert.match(e.message, /网络|代理|超时/);
  });

  test('内存不足 → 507，建议换更小模型', () => {
    const e = stt.explainFailure('MLX error: out of memory');
    assert.equal(e.status, 507);
    assert.match(e.message, /更小的模型/);
  });

  test('无法归类时给通用提示，不抛异常', () => {
    const e = stt.explainFailure('something weird');
    assert.equal(e.status, 500);
    assert.ok(e.message.length > 0);
  });
});

describe('modelCached：按 weights.npz 判断，不被残片骗', () => {
  const REV = 'aaaa1111';

  /** 造一个缓存目录：blobs + snapshots/<rev>/weights.npz */
  const makeCache = async ({ weights = true, incomplete = 0, snapshot = true } = {}) => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    const blobs = path.join(cacheDir, 'blobs');
    await fs.mkdir(blobs, { recursive: true });
    await fs.writeFile(path.join(blobs, 'cfgblob'), '{}');

    for (let i = 0; i < incomplete; i += 1) {
      await fs.writeFile(path.join(blobs, `part${i}.${i}.incomplete`), 'x');
    }

    if (weights) {
      const weightBlob = path.join(blobs, 'weightblob');
      await fs.writeFile(weightBlob, Buffer.alloc(1024));
    }

    if (snapshot) {
      const snap = path.join(cacheDir, 'snapshots', REV);
      await fs.mkdir(snap, { recursive: true });
      await fs.writeFile(path.join(snap, 'config.json'), '{}');
      if (weights) {
        // 用真实文件代替软链接，stat 能取到大小
        await fs.writeFile(path.join(snap, 'weights.npz'), Buffer.alloc(1024));
      }
    }
  };

  test('目录不存在 → false', async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });

  test('权重齐全且无残片 → true', async () => {
    await makeCache({ weights: true, incomplete: 0 });
    assert.equal(stt.modelCached('mlx-community/test-model'), true);
  });

  test('有 weights.npz 但同时有 .incomplete → false（下载被打断过）', async () => {
    await makeCache({ weights: true, incomplete: 2 });
    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });

  test('只有 config 没有 weights.npz → false（就是 large-v3-turbo 当时的状态）', async () => {
    await makeCache({ weights: false });
    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });

  test('只有 .incomplete 残片 → false（之前踩的坑）', async () => {
    await makeCache({ weights: false, incomplete: 3, snapshot: false });
    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });

  test('没有 snapshots 目录 → false', async () => {
    await makeCache({ weights: true, snapshot: false });
    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });

  test('weights.safetensors 也算有效权重（large-v3-turbo 用这种）', async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    const snap = path.join(cacheDir, 'snapshots', 'rev1');
    await fs.mkdir(snap, { recursive: true });
    await fs.writeFile(path.join(snap, 'config.json'), '{}');
    await fs.writeFile(path.join(snap, 'weights.safetensors'), Buffer.alloc(2048));

    assert.equal(stt.modelCached('mlx-community/test-model'), true);
  });

  test('权重文件为空（0 字节）→ false', async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    const snap = path.join(cacheDir, 'snapshots', 'rev1');
    await fs.mkdir(snap, { recursive: true });
    await fs.writeFile(path.join(snap, 'weights.npz'), '');

    assert.equal(stt.modelCached('mlx-community/test-model'), false);
  });
});

describe('WEIGHT_FILENAMES：覆盖两种权重命名', () => {
  test('同时包含 .npz 与 .safetensors', () => {
    assert.ok(Array.isArray(stt.WEIGHT_FILENAMES));
    assert.ok(stt.WEIGHT_FILENAMES.includes('weights.npz'), 'tiny/base/small 用 npz');
    assert.ok(stt.WEIGHT_FILENAMES.includes('weights.safetensors'), 'large-v3-turbo 用 safetensors');
  });
});

describe('findHfBin：定位同环境的 hf 命令', () => {
  test('没有 whisper 可执行文件时返回 null', async () => {
    const config = await import('../server/config.js');
    const original = config.BIN.whisper;
    config.BIN.whisper = null;
    try {
      assert.equal(stt.findHfBin(), null);
    } finally {
      config.BIN.whisper = original;
    }
  });

  test('有 whisper 时返回同目录的 hf（存在则返回路径）', async () => {
    const config = await import('../server/config.js');
    const found = stt.findHfBin();
    if (!config.BIN.whisper) {
      assert.equal(found, null, '没有 whisper 时不应返回路径');
    } else {
      assert.ok(found === null || found.includes('hf'), '返回的应是 hf 路径');
    }
  });
});

describe('模型未就绪时直接拒绝（不在转写超时里下载）', () => {
  test('模型未缓存时返回 503 并提示用 stt:download', async () => {
    const config = await import('../server/config.js');
    const original = config.BIN.whisper;

    // HF_HOME 已被 before() 指向空的临时目录，所以默认模型必然「未缓存」。
    // 这里只要保证 whisper 可执行文件非空，就会走到「模型未就绪」这条分支。
    config.BIN.whisper = process.execPath;

    try {
      await assert.rejects(
        () => stt.transcribe(process.execPath),
        (err) => {
          assert.equal(err.status, 503, '应是 503 而不是 500');
          assert.match(err.message, /尚未下载完成/);
          // 提示里要么给 npm 命令，要么给「手动下载」的说明
          assert.match(err.message, /stt:download|手动下载/, '应告诉用户怎么下模型');
          assert.equal(err.reason, 'model-not-ready');
          return true;
        },
      );
    } finally {
      config.BIN.whisper = original;
    }
  });

  test('未缓存时不会创建长期的临时输出目录（快速失败）', async () => {
    const config = await import('../server/config.js');
    const original = config.BIN.whisper;
    config.BIN.whisper = process.execPath;

    const started = Date.now();
    try {
      await assert.rejects(() => stt.transcribe(process.execPath));
    } finally {
      config.BIN.whisper = original;
    }

    // 快速失败应该远小于转写超时
    assert.ok(Date.now() - started < 5000, '应在数秒内失败，而不是等超时');
  });
});

describe('incompleteBlobs：列出残片文件', () => {
  test('只返回 .incomplete 文件', async () => {
    await fs.rm(cacheDir, { recursive: true, force: true });
    const blobs = path.join(cacheDir, 'blobs');
    await fs.mkdir(blobs, { recursive: true });
    await fs.writeFile(path.join(blobs, 'a.1.incomplete'), 'x');
    await fs.writeFile(path.join(blobs, 'b.2.incomplete'), 'x');
    await fs.writeFile(path.join(blobs, 'c'),
      'x');

    const found = stt.incompleteBlobs('mlx-community/test-model');
    assert.equal(found.length, 2);
    assert.ok(found.every((f) => f.endsWith('.incomplete')));
  });

  test('目录不存在时返回空数组', () => {
    assert.deepEqual(stt.incompleteBlobs('mlx-community/nope-nope'), []);
  });
});
