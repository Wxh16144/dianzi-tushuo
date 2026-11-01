import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, collectMedia } from '../server/export.js';

const state = {
  title: '婚礼布置清单',
  sections: [
    {
      name: '主舞台',
      items: [
        {
          text: '背景板',
          images: [{ file: 'images/a.jpg', w: 800, h: 600 }, { file: 'images/b.jpg', w: 600, h: 800 }],
          audio: { file: 'audio/a.mp3', duration: 3.2, format: 'mp3' },
        },
        { text: '通道', images: [], audio: null },
      ],
    },
    {
      name: '迎宾区',
      items: [{ text: '迎宾牌', images: [{ file: 'images/a.jpg', w: 800, h: 600 }], audio: null }],
    },
  ],
};

describe('collectMedia', () => {
  test('跨页签、跨条目收集并去重', () => {
    const { images, audio } = collectMedia(state);
    assert.deepEqual(images.sort(), ['images/a.jpg', 'images/b.jpg']);
    assert.deepEqual(audio, ['audio/a.mp3']);
  });

  test('没有媒体时返回空数组', () => {
    const { images, audio } = collectMedia({ sections: [{ items: [{ text: 'x' }] }] });
    assert.deepEqual(images, []);
    assert.deepEqual(audio, []);
  });

  test('缺字段不会抛错', () => {
    assert.doesNotThrow(() => collectMedia({ sections: [{ items: [null, {}] }] }));
  });
});

describe('buildManifest', () => {
  test('版本清单包含格式与 schema 版本', () => {
    const manifest = buildManifest(state);
    assert.equal(manifest.format, 'dianzi-tushuo-backup');
    assert.equal(manifest.formatVersion, 1);
    assert.equal(manifest.schemaVersion, 1);
  });

  test('记录标题、计数与被引用的媒体清单', () => {
    const manifest = buildManifest(state);
    assert.equal(manifest.title, '婚礼布置清单');
    assert.deepEqual(manifest.counts, { sections: 2, items: 3 });
    assert.deepEqual(manifest.media.images.sort(), ['images/a.jpg', 'images/b.jpg']);
    assert.deepEqual(manifest.media.audio, ['audio/a.mp3']);
  });

  test('导出时间戳是合法 ISO 字符串', () => {
    const { exportedAt } = buildManifest(state);
    assert.match(exportedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!Number.isNaN(Date.parse(exportedAt)));
  });
});
