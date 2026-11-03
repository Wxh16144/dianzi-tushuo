import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { createSandbox } from './helpers/sandbox.js';

let box;
let app;
let importBackup;

before(async () => {
  box = await createSandbox('hubz-import-');
  ({ importBackup } = await import('../server/import.js'));
  const { createApp } = await import('../server/app.js');
  app = createApp();
});

after(async () => {
  await box.cleanup();
});

const makeZip = (entries) => {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
};

const manifest = () => ({
  format: 'dianzi-tushuo-backup',
  formatVersion: 1,
  schemaVersion: 1,
  exportedAt: new Date().toISOString(),
  title: '备份清单',
  counts: { sections: 1, items: 1 },
  media: { images: ['images/pic.png'], audio: [] },
});

const state = () => ({
  version: 1,
  title: '备份清单',
  sections: [
    {
      id: 's_a',
      name: '主舞台',
      seq: 1,
      items: [{ id: 'i_1', seq: 1, text: '背景板', images: [{ file: 'images/pic.png', w: 10, h: 10 }], audio: null }],
    },
  ],
});

describe('importBackup', () => {
  test('有效备份包：整体替换并写入媒体', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify(manifest()),
      'state.json': JSON.stringify(state()),
      'images/pic.png': Buffer.from('fake-png-bytes'),
    });

    const result = await importBackup(buffer);
    assert.equal(result.ok, true);
    assert.equal(result.title, '备份清单');
    assert.equal(result.sections, 1);
    assert.equal(result.items, 1);
    assert.equal(result.images, 1);
    assert.deepEqual(result.missing, []);

    // 状态已替换
    const { getState } = await import('../server/db.js');
    assert.equal(getState().title, '备份清单');
    assert.equal(getState().sections[0].items[0].text, '背景板');

    // 媒体已落盘
    const onDisk = path.join(box.config.IMAGES_DIR, 'pic.png');
    assert.equal(await fs.readFile(onDisk, 'utf8'), 'fake-png-bytes');
  });

  test('媒体目录不存在时自动创建，不报 ENOENT', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify(manifest()),
      'state.json': JSON.stringify(state()),
      'images/pic.png': Buffer.from('fake-png-bytes'),
    });

    // 模拟工作区目录被手动删掉（或用 --workdir 指到新目录）
    await fs.rm(box.config.IMAGES_DIR, { recursive: true, force: true });
    await fs.rm(box.config.AUDIO_DIR, { recursive: true, force: true });

    const result = await importBackup(buffer);
    assert.equal(result.ok, true);
    assert.equal(await fs.readFile(path.join(box.config.IMAGES_DIR, 'pic.png'), 'utf8'), 'fake-png-bytes');
  });

  test('缺失媒体记入 missing，不拒绝整包', async () => {
    const ghostState = () => ({
      ...state(),
      sections: [
        {
          id: 's_a',
          name: '主舞台',
          seq: 1,
          items: [{ id: 'i_1', seq: 1, text: '背景板', images: [{ file: 'images/ghost.png', w: 10, h: 10 }], audio: null }],
        },
      ],
    });

    const buffer = makeZip({
      'manifest.json': JSON.stringify({ ...manifest(), media: { images: ['images/ghost.png'], audio: [] } }),
      'state.json': JSON.stringify(ghostState()),
    });

    const result = await importBackup(buffer);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, ['images/ghost.png']);
  });

  test('版本高于当前版本被拒绝', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify(manifest()),
      'state.json': JSON.stringify({ ...state(), version: 99 }),
    });

    await assert.rejects(
      () => importBackup(buffer),
      (err) => err.status === 400 && /高于当前支持的版本/.test(err.message),
    );
  });

  test('路径穿越条目被拒绝', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify(manifest()),
      'state.json': JSON.stringify(state()),
      'images/../../evil.txt': 'boom',
    });

    await assert.rejects(
      () => importBackup(buffer),
      (err) => err.status === 400 && /不允许的文件/.test(err.message),
    );
  });

  test('非本工具备份包被拒绝', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify({ ...manifest(), format: 'other-thing' }),
      'state.json': JSON.stringify(state()),
    });

    await assert.rejects(
      () => importBackup(buffer),
      (err) => err.status === 400 && /不是本工具的备份包/.test(err.message),
    );
  });

  test('旧格式 hunlibuzhi-backup 仍可导入（向后兼容）', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify({ ...manifest(), format: 'hunlibuzhi-backup' }),
      'state.json': JSON.stringify(state()),
      'images/pic.png': Buffer.from('legacy-png'),
    });

    const result = await importBackup(buffer);
    assert.equal(result.ok, true);
    assert.equal(result.title, '备份清单');
  });

  test('缺少 manifest 或 state 被拒绝', async () => {
    const buffer = makeZip({ 'state.json': JSON.stringify(state()) });
    await assert.rejects(
      () => importBackup(buffer),
      (err) => err.status === 400 && /缺少 manifest.json 或 state.json/.test(err.message),
    );
  });
});

describe('POST /api/import', () => {
  test('通过 multipart 上传备份并整体替换', async () => {
    const buffer = makeZip({
      'manifest.json': JSON.stringify(manifest()),
      'state.json': JSON.stringify(state()),
      'images/pic.png': Buffer.from('via-http'),
    });

    const res = await request(app)
      .post('/api/import')
      .attach('file', buffer, 'backup.zip')
      .expect(200);

    assert.equal(res.body.ok, true);
    assert.equal(res.body.title, '备份清单');

    const { getState } = await import('../server/db.js');
    assert.equal(getState().title, '备份清单');
  });

  test('没有文件返回 400', async () => {
    const res = await request(app).post('/api/import').expect(400);
    assert.match(res.body.error, /没有收到备份文件/);
  });
});
