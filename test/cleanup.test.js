import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  collectReferenced,
  fileSizes,
  formatBytes,
  listFiles,
  planMedia,
} from '../server/cleanup.js';

const state = {
  sections: [
    {
      items: [
        { text: 'a', images: [{ file: 'images/a.jpg' }, { file: 'images/b.jpg' }], audio: { file: 'audio/a.mp3' } },
        { text: 'b', images: [], audio: null },
        null,
      ],
    },
    { items: [{ text: 'c', images: [{ file: 'images/a.jpg' }] }] },
  ],
};

describe('collectReferenced', () => {
  test('收集图片与音频引用并去重', () => {
    const { images, audio } = collectReferenced(state);
    assert.deepEqual([...images].sort(), ['images/a.jpg', 'images/b.jpg']);
    assert.deepEqual([...audio], ['audio/a.mp3']);
  });

  test('空/缺失结构不抛错', () => {
    assert.deepEqual([...collectReferenced({}).images], []);
    assert.deepEqual([...collectReferenced({ sections: [{ items: [null, {}] }] }).images], []);
  });
});

describe('planMedia', () => {
  const layout = {
    imageFiles: ['images/a.jpg', 'images/b.jpg', 'images/old1.jpg', 'images/old2.jpg'],
    audioFiles: ['audio/a.mp3', 'audio/old.mp3'],
  };

  test('orphans 模式只删没被引用的文件', () => {
    const plan = planMedia({ state, ...layout, mode: 'orphans' });
    assert.deepEqual(plan.deleteImages, ['images/old1.jpg', 'images/old2.jpg']);
    assert.deepEqual(plan.deleteAudio, ['audio/old.mp3']);
    assert.deepEqual(plan.keptImages, ['images/a.jpg', 'images/b.jpg']);
    assert.deepEqual(plan.keptAudio, ['audio/a.mp3']);
    assert.equal(plan.totals.deleteCount, 3);
    assert.equal(plan.totals.keepCount, 3);
  });

  test('all 模式删除全部媒体', () => {
    const plan = planMedia({ state, ...layout, mode: 'all' });
    assert.equal(plan.deleteImages.length, 4);
    assert.equal(plan.deleteAudio.length, 2);
    assert.equal(plan.keptImages.length, 0);
    assert.equal(plan.totals.keepCount, 0);
  });

  test('清单引用但磁盘缺失的文件会被列出来', () => {
    const plan = planMedia({
      state,
      imageFiles: ['images/a.jpg'],
      audioFiles: [],
      mode: 'orphans',
    });
    assert.deepEqual(plan.missingImages, ['images/b.jpg']);
    assert.deepEqual(plan.missingAudio, ['audio/a.mp3']);
  });

  test('全部被引用时没有可删文件', () => {
    const plan = planMedia({
      state,
      imageFiles: ['images/a.jpg', 'images/b.jpg'],
      audioFiles: ['audio/a.mp3'],
      mode: 'orphans',
    });
    assert.equal(plan.totals.deleteCount, 0);
  });
});

describe('listFiles', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hubz-list-'));
    await fs.writeFile(path.join(dir, 'a.jpg'), 'x');
    await fs.writeFile(path.join(dir, 'b.jpg'), 'xx');
    await fs.writeFile(path.join(dir, '.hidden'), 'x');
    await fs.mkdir(path.join(dir, 'sub'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('只列一层文件并跳过点文件与目录', async () => {
    const files = await listFiles(dir, 'images');
    assert.deepEqual(files.sort(), ['images/a.jpg', 'images/b.jpg']);
  });

  test('目录不存在时返回空数组', async () => {
    assert.deepEqual(await listFiles(path.join(dir, 'nope'), 'x'), []);
  });

  test('fileSizes 统计字节数（baseDir + 相对路径）', async () => {
    assert.equal(await fileSizes(dir, ['a.jpg', 'b.jpg']), 3);
  });

  test('fileSizes 忽略不存在的文件', async () => {
    assert.equal(await fileSizes(dir, ['a.jpg', 'ghost.jpg']), 1);
  });

  test('formatBytes 分级单位', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  });
});

describe('scripts/clean.js 端到端', () => {
  let sandbox;
  let dataDir;

  before(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'hubz-clean-'));
    dataDir = path.join(sandbox, 'data');
    await fs.mkdir(path.join(dataDir, 'images'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'audio'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'tmp'), { recursive: true });

    // 1 个被引用 + 2 个孤儿
    await fs.writeFile(path.join(dataDir, 'images/keep.jpg'), 'keep');
    await fs.writeFile(path.join(dataDir, 'images/orphan1.jpg'), 'orphan-1');
    await fs.writeFile(path.join(dataDir, 'images/orphan2.jpg'), 'orphan-2');
    await fs.writeFile(path.join(dataDir, 'audio/keep.mp3'), 'audio-keep');

    await fs.writeFile(
      path.join(dataDir, 'state.json'),
      JSON.stringify({
        title: '测试',
        sections: [{ name: 'A', items: [{ text: 'x', images: [{ file: 'images/keep.jpg' }], audio: { file: 'audio/keep.mp3' } }] }],
      }),
    );
  });

  after(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const run = (args) =>
    execa(process.execPath, ['scripts/clean.js', ...args], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        EXPORTS_DIR: path.join(sandbox, 'exports'),
        LOG_LEVEL: 'silent',
        HUBZ_TEST_BACKUP: path.join(sandbox, 'env-backup'),
      },
      cwd: process.cwd(),
      reject: false,
    });

  /** 报告走 stdout，错误走 stderr，断言时合并看 */
  const output = (result) => `${result.stdout}\n${result.stderr}`;

  test('不加 --yes 时是演练，不删任何文件', async () => {
    const result = await run([]);
    assert.match(output(result), /演练模式/);
    assert.match(output(result), /将删除 2 个文件/);

    const left = await fs.readdir(path.join(dataDir, 'images'));
    assert.equal(left.length, 3, '演练不应删除文件');
  });

  test('--yes 会备份并删除孤儿，保留引用文件', async () => {
    const backupRoot = path.join(sandbox, 'backup');
    const result = await run(['--yes', '--backup-dir', backupRoot]);

    assert.equal(result.exitCode, 0);
    assert.match(output(result), /备份完成/);
    assert.match(output(result), /已删除 2 个媒体文件/);

    const left = (await fs.readdir(path.join(dataDir, 'images'))).sort();
    assert.deepEqual(left, ['keep.jpg']);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'audio')), ['keep.mp3']);

    // 备份里应包含被删掉的文件
    const [backupDir] = await fs.readdir(backupRoot);
    const backedUp = (await fs.readdir(path.join(backupRoot, backupDir, 'images'))).sort();
    assert.deepEqual(backedUp, ['keep.jpg', 'orphan1.jpg', 'orphan2.jpg']);
  });

  test('--logs 会清空日志目录', async () => {
    await fs.writeFile(path.join(dataDir, 'logs/app.log'), 'log-line');
    await run(['--yes', '--logs', '--backup-dir', path.join(sandbox, 'backup2')]);
    assert.deepEqual(await fs.readdir(path.join(dataDir, 'logs')), []);
  });

  test('state.json 损坏时中止，不删任何文件', async () => {
    const brokenDir = path.join(sandbox, 'broken');
    await fs.mkdir(path.join(brokenDir, 'images'), { recursive: true });
    await fs.writeFile(path.join(brokenDir, 'images/a.jpg'), 'x');
    await fs.writeFile(path.join(brokenDir, 'state.json'), '{ not json');

    const result = await execa(process.execPath, ['scripts/clean.js', '--yes'], {
      env: { ...process.env, DATA_DIR: brokenDir, EXPORTS_DIR: path.join(sandbox, 'out'), LOG_LEVEL: 'silent' },
      reject: false,
    });

    assert.equal(result.exitCode, 1);
    assert.match(output(result), /无法解析|已中止/);
    assert.equal((await fs.readdir(path.join(brokenDir, 'images'))).length, 1, '不应删除文件');
  });

  test('--help 打印用法与安全说明', async () => {
    const result = await run(['--help']);
    assert.equal(result.exitCode, 0);
    const text = output(result);
    for (const flag of ['--yes', '--all', '--logs', '--exports', '--backup-dir', '--no-backup', '--force']) {
      assert.ok(text.includes(flag), `帮助里缺 ${flag}`);
    }
    assert.match(text, /安全说明/);
    assert.match(text, /不加 --yes 绝不删除文件/);
  });

  test('未知参数返回错误并提示用法', async () => {
    const result = await run(['--nope']);
    assert.equal(result.exitCode, 1);
    assert.match(output(result), /unknown option|未知选项/i);
  });

  test('短参数 -y 等价于 --yes', async () => {
    const result = await run(['-y', '--backup-dir', path.join(sandbox, 'backup-short')]);
    assert.equal(result.exitCode, 0);
    assert.match(output(result), /备份完成/);
  });

  test('默认备份位置在系统临时目录，不会建到项目目录里', async () => {
    const before = new Set(await fs.readdir(process.cwd()));
    const result = await run(['--yes']);

    assert.equal(result.exitCode, 0);
    const text = output(result);
    assert.match(text, /备份完成：/, text);

    // 备份路径必须是绝对路径，且不在项目根目录下
    const backupPath = text.match(/备份完成：(\S+)/)?.[1] ?? '';
    assert.ok(path.isAbsolute(backupPath), `备份路径应为绝对路径：${backupPath}`);
    assert.ok(
      !backupPath.startsWith(process.cwd()),
      `备份不该落在项目目录里：${backupPath}`,
    );
    assert.ok(backupPath.startsWith(os.tmpdir()), `应在系统临时目录：${backupPath}`);

    // 项目根目录不应新增任何条目（尤其是名字像 $TMPDIR 的目录）
    const after = await fs.readdir(process.cwd());
    const added = after.filter((name) => !before.has(name));
    assert.deepEqual(added, [], `项目根目录不该新增文件：${added.join(', ')}`);
    assert.ok(!after.includes('$TMPDIR'), '不应出现字面量 $TMPDIR 目录');
  });

  test('--backup-dir 支持 $VAR 与 ~ 展开', async () => {
    const result = await run(['--yes', '--backup-dir', '$HUBZ_TEST_BACKUP']);

    assert.equal(result.exitCode, 0);
    const text = output(result);
    assert.match(text, /备份完成：/, text);

    const backupPath = text.match(/备份完成：(\S+)/)?.[1] ?? '';
    assert.ok(
      backupPath.startsWith(sandbox),
      `$VAR 应被展开到 ${sandbox}，实际：${backupPath}`,
    );
  });

  test('备份目录位于 data 内时拒绝执行', async () => {
    const result = await run(['--yes', '--backup-dir', path.join(dataDir, 'backup')]);
    assert.equal(result.exitCode, 1);
    assert.match(output(result), /备份目录不能位于 data 目录内/);
  });

  test('--all 在非交互环境缺少 --force 时拒绝执行', async () => {
    const result = await run(['--all', '--yes']);
    assert.equal(result.exitCode, 1);
    assert.match(output(result), /必须额外加 --force/);
  });

  test('--all 默认连内容缓存一起清空，--no-cache 可跳过', async () => {
    const dir = path.join(sandbox, 'all-cache');
    await fs.mkdir(path.join(dir, 'images'), { recursive: true });
    await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
    await fs.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fs.writeFile(path.join(dir, 'images/a.jpg'), 'img');
    await fs.writeFile(path.join(dir, 'cache/videos.mp4'), 'cached');
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ title: 't', sections: [] }));

    const env = {
      ...process.env,
      DATA_DIR: dir,
      EXPORTS_DIR: path.join(dir, 'exports'),
      LOG_LEVEL: 'silent',
    };

    // --all --yes --force：应清空 cache
    const result = await execa(process.execPath, ['scripts/clean.js', '--all', '--yes', '--force'], {
      env, cwd: process.cwd(), reject: false,
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /已清空内容缓存/);
    await assert.rejects(fs.access(path.join(dir, 'cache/videos.mp4')), /ENOENT/, '--all 应清空缓存');

    // 重新造一个 cache，验证 --all --no-cache 保留缓存
    await fs.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fs.writeFile(path.join(dir, 'cache/again.mp4'), 'cached-again');
    await fs.writeFile(path.join(dir, 'images/a.jpg'), 'img');
    const noCache = await execa(process.execPath, ['scripts/clean.js', '--all', '--no-cache', '--yes', '--force'], {
      env, cwd: process.cwd(), reject: false,
    });
    assert.equal(noCache.exitCode, 0, `${noCache.stdout}\n${noCache.stderr}`);
    assert.ok((await fs.readdir(path.join(dir, 'cache'))).includes('again.mp4'), '--no-cache 应保留缓存');
  });
});
