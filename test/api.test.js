import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { createSandbox, makeImage } from './helpers/sandbox.js';

let box;
let app;
let BIN;

before(async () => {
  box = await createSandbox('hubz-api-');
  const { createApp } = await import('../server/app.js');
  app = createApp();
  BIN = box.config.BIN;
});

after(async () => {
  await box.cleanup();
});

const validState = () => ({
  title: '婚礼布置清单',
  sections: [
    {
      id: 's_a',
      name: '主舞台',
      seq: 1,
      items: [{ id: 'i_1', seq: 1, text: '背景板', images: [], audio: null }],
    },
  ],
});

describe('GET /api/health', () => {
  test('返回环境信息，且不包含密钥字段', async () => {
    const res = await request(app).get('/api/health').expect(200);
    assert.equal(res.body.node, process.version);
    assert.ok(res.body.llm);
    assert.equal(Object.hasOwn(res.body.llm, 'apiKey'), false);
    assert.equal(typeof res.body.llm.hasApiKey, 'boolean');
    assert.equal(typeof res.body.stt.ready, 'boolean');
  });
});

describe('GET/PUT /api/state', () => {
  test('初始状态是空清单', async () => {
    const res = await request(app).get('/api/state').expect(200);
    assert.equal(res.body.title, '清单');
    assert.equal(res.body.sections.length, 1);
    assert.equal(res.body.sections[0].items.length, 0);
  });

  test('合法数据保存后能读回', async () => {
    await request(app).put('/api/state').send(validState()).expect(200);
    const res = await request(app).get('/api/state').expect(200);
    assert.equal(res.body.title, '婚礼布置清单');
    assert.equal(res.body.sections[0].name, '主舞台');
    assert.equal(res.body.sections[0].items[0].text, '背景板');
    assert.ok(res.body.updatedAt);
  });

  test('非法媒体路径返回 400，且不覆盖已有数据', async () => {
    const before = (await request(app).get('/api/state')).body;

    const res = await request(app)
      .put('/api/state')
      .send({ sections: [{ items: [{ images: [{ file: '../../etc/passwd' }] }] }] })
      .expect(400);
    assert.match(res.body.error, /媒体文件路径不合法/);

    const after = (await request(app).get('/api/state')).body;
    assert.deepEqual(after.title, before.title);
    assert.deepEqual(after.sections, before.sections);
  });

  test('顶层不是对象返回 400', async () => {
    await request(app).put('/api/state').send([]).expect(400);
    await request(app).put('/api/state').set('Content-Type', 'application/json').send('"x"').expect(400);
  });

  test('图片数组里混入 audio 路径时返回 400（前缀不匹配）', async () => {
    const res = await request(app)
      .put('/api/state')
      .send({ sections: [{ items: [{ text: 'a', images: [{ file: 'images/ok.jpg' }, { file: 'audio/x.mp3' }] }] }] })
      .expect(400);
    assert.match(res.body.error, /媒体文件路径不合法/);
  });
});

describe('POST /api/reset', () => {
  test('清空为默认清单，并保留默认页签', async () => {
    await request(app).put('/api/state').send(validState()).expect(200);
    const res = await request(app).post('/api/reset').expect(200);
    assert.equal(res.body.title, '清单');
    assert.equal(res.body.sections.length, 1);
    assert.equal(res.body.sections[0].items.length, 0);
  });
});

describe('媒体上传', () => {
  test('单张图片：返回可访问的路径与尺寸', async () => {
    const png = await makeImage({ width: 400, height: 300 });
    const res = await request(app)
      .post('/api/media/image')
      .field('sectionSeq', '1')
      .field('itemSeq', '2')
      .attach('file', png, 'shot.png')
      .expect(200);

    assert.match(res.body.file, /^images\/01-02-\d{8}-\d{6}\.jpg$/);
    assert.equal(res.body.w, 400);
    assert.equal(res.body.h, 300);

    const onDisk = path.join(box.config.DATA_DIR, res.body.file);
    const stat = await fs.stat(onDisk);
    assert.ok(stat.size > 0);

    // 静态资源可访问
    await request(app).get(`/${res.body.file}`).expect(200);
  });

  test('多张图片：一次上传得到 -1/-2 后缀', async () => {
    const a = await makeImage();
    const b = await makeImage({ color: { r: 20, g: 160, b: 90 } });

    const res = await request(app)
      .post('/api/media/images')
      .field('sectionSeq', '2')
      .field('itemSeq', '5')
      .attach('files', a, 'a.png')
      .attach('files', b, 'b.png')
      .expect(200);

    assert.equal(res.body.images.length, 2);
    assert.match(res.body.images[0].file, /-1\.jpg$/);
    assert.match(res.body.images[1].file, /-2\.jpg$/);
  });

  test('没有文件时返回 400', async () => {
    const res = await request(app).post('/api/media/image').expect(400);
    assert.match(res.body.error, /没有收到图片数据/);
  });
});

describe('语音转写前置校验', () => {
  test('缺少 itemId 返回 400', async () => {
    await request(app).post('/api/audio/transcribe').send({}).expect(400);
  });

  test('条目不存在返回 404', async () => {
    await request(app).post('/api/audio/transcribe').send({ itemId: 'i_nope' }).expect(404);
  });

  test('条目没有录音返回 400', async () => {
    await request(app).put('/api/state').send(validState()).expect(200);
    const res = await request(app).post('/api/audio/transcribe').send({ itemId: 'i_1' }).expect(400);
    assert.match(res.body.error, /还没有录音/);
  });
});

describe('导出前置校验', () => {
  test('没有 Chrome 时 PDF 返回 503，但 zip 备份不受影响', async () => {
    const original = BIN.chrome;
    BIN.chrome = null;
    try {
      const res = await request(app).post('/api/export/pdf').expect(503);
      assert.match(res.body.error, /Chrome/);

      // zip 备份不依赖 Chrome，应正常生成
      const zipRes = await request(app).post('/api/export').expect(200);
      assert.match(zipRes.body.zip, /^备份-\d{8}-\d{6}\.zip$/);
    } finally {
      BIN.chrome = original;
    }
  });
});

describe('错误处理', () => {
  test('未知接口返回 404 JSON', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    assert.match(res.body.error, /接口不存在/);
  });

  test('不存在的静态文件返回 404', async () => {
    await request(app).get('/images/not-exist.png').expect(404);
  });

  test('首页返回 HTML', async () => {
    const res = await request(app).get('/').expect(200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.text, /<title>/);
  });
});

describe('数据持久化', () => {
  test('state.json 是完整可解析的 JSON', async () => {
    await request(app).put('/api/state').send(validState()).expect(200);
    const raw = await fs.readFile(box.config.STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.title, '婚礼布置清单');
  });

  test('并发写入不会产生半截文件', async () => {
    const writes = Array.from({ length: 8 }, (_, i) =>
      request(app).put('/api/state').send({ ...validState(), title: `并发-${i}` }).then((r) => r.status),
    );
    const codes = await Promise.all(writes);
    assert.ok(codes.every((c) => c === 200));

    const raw = await fs.readFile(box.config.STATE_FILE, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'state.json 必须是完整 JSON');
  });
});
