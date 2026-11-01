import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createSandbox, makeImage } from './helpers/sandbox.js';

let box;
let app;
let server;
let baseUrl;
let media;
let buildPdf;
let buildExport;
let skipReason = null;

before(async () => {
  box = await createSandbox('hubz-export-');
  media = await import('../server/media.js');
  ({ buildPdf, buildExport } = await import('../server/export.js'));
  const { getState } = await import('../server/db.js');

  if (!box.config.BIN.chrome) skipReason = '本机没有 Chrome/Chromium';

  const { createApp } = await import('../server/app.js');
  app = createApp();

  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  app.set('port', port);
  baseUrl = `http://127.0.0.1:${port}`;

  // 造一条带图片与文案的数据
  const png = await makeImage({ width: 1200, height: 900 });
  const image = await media.processImage(png, { sectionSeq: 1, itemSeq: 1 });
  const stateModule = await import('../server/db.js');
  await stateModule.setState({
    title: '导出测试',
    sections: [
      {
        id: 's_a',
        name: '主舞台',
        seq: 1,
        items: [
          {
            id: 'i_1',
            seq: 1,
            text: '背景板：香槟金布幔，两侧各一组花艺。',
            images: [image],
            audio: null,
          },
          { id: 'i_2', seq: 2, text: '无图片的条目', images: [], audio: null },
        ],
      },
    ],
  });

  box.getState = getState;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await box.cleanup();
});

describe('PDF 导出', () => {
  test('生成合法的 PDF 文件', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await buildPdf({ port: app.get('port') });
    assert.match(result.pdf, /^清单-\d{8}-\d{6}\.pdf$/);
    assert.ok(result.size > 1000, `PDF 太小：${result.size}`);

    const file = path.join(box.config.EXPORTS_DIR, result.pdf);
    const head = (await fs.readFile(file)).subarray(0, 5).toString();
    assert.equal(head, '%PDF-', '应以 PDF 魔数开头');

    // 页面通过 HTTP 可下载
    const res = await fetch(`${baseUrl}${result.url}`);
    assert.equal(res.status, 200);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  });

  test('打印页能正常渲染并标记就绪', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const res = await fetch(`${baseUrl}/?print=1`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>/);
  });
});

describe('Zip 导出（备份包）', () => {
  test('包含 manifest.json、state.json 与被引用的媒体，不含 PDF', async () => {
    const result = await buildExport({ state: box.getState() });
    assert.match(result.zip, /^备份-\d{8}-\d{6}\.zip$/);
    assert.equal(result.missing.length, 0);

    const zip = new AdmZip(path.join(box.config.EXPORTS_DIR, result.zip));
    const names = zip.getEntries().map((e) => e.entryName);

    assert.ok(names.includes('manifest.json'), `缺少 manifest.json：${names.join(', ')}`);
    assert.ok(names.includes('state.json'), '缺少 state.json');
    assert.ok(names.some((n) => n.startsWith('images/')), '缺少图片');
    assert.equal(names.filter((n) => n.startsWith('images/')).length, 1);
    assert.ok(!names.includes('清单.pdf'), '备份包不应包含 PDF');
    assert.ok(!names.includes('data.json'), '备份包不应包含旧的扁平清单');

    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal(manifest.format, 'dianzi-tushuo-backup');
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.title, '导出测试');
    assert.deepEqual(manifest.counts, { sections: 1, items: 2 });
    assert.equal(manifest.media.images.length, 1);

    const state = JSON.parse(zip.readAsText('state.json'));
    assert.equal(state.title, '导出测试');
    assert.deepEqual(state.sections.map((s) => s.name), ['主舞台']);
    assert.deepEqual(state.sections[0].items.map((i) => i.text), ['背景板：香槟金布幔，两侧各一组花艺。', '无图片的条目']);
    assert.equal(state.version, 1);
  });

  test('缺失的媒体文件会记录在 missing 中而不是报错', async () => {
    const state = JSON.parse(JSON.stringify(box.getState()));
    state.sections[0].items[0].images.push({ file: 'images/ghost.jpg', w: 10, h: 10 });

    const result = await buildExport({ state });
    assert.deepEqual(result.missing, ['images/ghost.jpg']);

    const zip = new AdmZip(path.join(box.config.EXPORTS_DIR, result.zip));
    assert.equal(zip.getEntries().filter((e) => e.entryName === 'images/ghost.jpg').length, 0);
  });
});
