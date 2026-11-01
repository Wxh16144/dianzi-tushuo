import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGES_HARD_CAP,
  MAX_IMAGES_PER_ITEM,
  MAX_IMAGES_PER_REQUEST,
  defaultState,
  parseState,
  parseStateStrict,
} from '../server/schema.js';

describe('parseState（读取宽松）', () => {
  test('空对象也能得到可用的默认清单', () => {
    const state = parseState({});
    assert.equal(state.version, 1);
    assert.equal(state.title, '清单');
    assert.equal(state.sections.length, 1);
    assert.equal(state.sections[0].items.length, 0);
    assert.ok(state.sections[0].id);
  });

  test('非对象的 sections 被忽略', () => {
    const state = parseState({ sections: [null, 'x', 42, { name: '好的' }] });
    assert.equal(state.sections.length, 1);
    assert.equal(state.sections[0].name, '好的');
  });

  test('非法图片路径被丢弃，合法图片保留', () => {
    const state = parseState({
      sections: [{ items: [{ images: [{ file: '../../etc/passwd' }, { file: 'images/ok.jpg', w: 800, h: 600 }] }] }],
    });
    const images = state.sections[0].items[0].images;
    assert.deepEqual(images, [{ file: 'images/ok.jpg', w: 800, h: 600 }]);
  });

  test('路径前缀不匹配（audio 冒充 images）会被丢弃', () => {
    const state = parseState({
      sections: [{ items: [{ images: [{ file: 'audio/x.mp3' }, { file: 'images/a.png' }] }] }],
    });
    assert.deepEqual(state.sections[0].items[0].images.map((i) => i.file), ['images/a.png']);
  });

  test('重复图片去重', () => {
    const state = parseState({
      sections: [{ items: [{ images: [{ file: 'images/a.png' }, { file: 'images/a.png' }, { file: 'images/b.png' }] }] }],
    });
    assert.deepEqual(state.sections[0].items[0].images.map((i) => i.file), ['images/a.png', 'images/b.png']);
  });

  test('图片数量上限按界面上限设定', () => {
    assert.equal(MAX_IMAGES_PER_ITEM, 12, '一条最多 12 张');
    assert.equal(MAX_IMAGES_PER_REQUEST, 12, '一次最多粘贴 12 张');
  });

  test('读取时按安全上限截断，不按界面上限', () => {
    // 关键：以后调低界面上限（比如 12），旧数据里 20 张图不能被静默砍掉
    const many = Array.from({ length: MAX_IMAGES_PER_ITEM + 8 }, (_, i) => ({ file: `images/${i}.jpg` }));
    const state = parseState({ sections: [{ items: [{ images: many }] }] });
    assert.equal(state.sections[0].items[0].images.length, MAX_IMAGES_PER_ITEM + 8, '旧数据应完整保留');

    const huge = Array.from({ length: MAX_IMAGES_HARD_CAP + 20 }, (_, i) => ({ file: `images/${i}.jpg` }));
    const capped = parseState({ sections: [{ items: [{ images: huge }] }] });
    assert.equal(capped.sections[0].items[0].images.length, MAX_IMAGES_HARD_CAP, '超过安全上限才截断');
  });

  test('第一版的单图字段 image 会迁移到 images[]', () => {
    const state = parseState({
      sections: [{ items: [{ image: { file: 'images/old.jpg', w: 100, h: 80 } }] }],
    });
    const item = state.sections[0].items[0];
    assert.equal(item.image, undefined, '旧字段不应保留');
    assert.deepEqual(item.images, [{ file: 'images/old.jpg', w: 100, h: 80 }]);
  });

  test('audio 结构不合法时置为 null', () => {
    const state = parseState({ sections: [{ items: [{ audio: { file: 'nope/x.mp3' } }] }] });
    assert.equal(state.sections[0].items[0].audio, null);
  });

  test('合法 audio 保留时长与格式', () => {
    const state = parseState({
      sections: [{ items: [{ audio: { file: 'audio/a.mp3', duration: 3.456, format: 'mp3' } }] }],
    });
    assert.deepEqual(state.sections[0].items[0].audio, {
      file: 'audio/a.mp3',
      duration: 3.456,
      format: 'mp3',
      mime: '',
    });
  });

  test('超长文案被截断', () => {
    const state = parseState({ sections: [{ items: [{ text: 'a'.repeat(30000) }] }] });
    assert.equal(state.sections[0].items[0].text.length, 20000);
  });

  test('可选标题：保留并截断到 6 字，缺失时为空串', () => {
    const withTitle = parseState({ sections: [{ items: [{ title: '背景板布置设计图' }] }] });
    assert.equal(withTitle.sections[0].items[0].title, '背景板布置设', '标题应截断到 6 字');

    const emptyTitle = parseState({ sections: [{ items: [{ text: '只有文案' }] }] });
    assert.equal(emptyTitle.sections[0].items[0].title, '', '缺标题应为空串');

    const nonString = parseState({ sections: [{ items: [{ title: 123 }] }] });
    assert.equal(nonString.sections[0].items[0].title, '', '非字符串标题应为空串');
  });

  test('seq 缺失时自动补齐且互不重复', () => {
    const state = parseState({
      sections: [
        { name: 'A', items: [{ text: '1' }, { text: '2' }] },
        { name: 'B', seq: 7, items: [{ text: '3' }] },
      ],
    });
    const sectionSeqs = state.sections.map((s) => s.seq);
    assert.equal(new Set(sectionSeqs).size, sectionSeqs.length, '页签 seq 不重复');
    const itemSeqs = state.sections.flatMap((s) => s.items.map((i) => i.seq));
    assert.equal(new Set(itemSeqs).size, itemSeqs.length, '条目 seq 不重复');
    assert.ok(itemSeqs.every((n) => n > 0));
  });

  test('counters 不小于实际最大 seq', () => {
    const state = parseState({
      counters: { section: 0, item: 0 },
      sections: [{ seq: 5, items: [{ seq: 9, text: 'x' }] }],
    });
    assert.ok(state.counters.section >= 5);
    assert.ok(state.counters.item >= 9);
  });
});

describe('parseStateStrict（写入严格）', () => {
  test('非法图片路径直接报 400', () => {
    assert.throws(
      () => parseStateStrict({ sections: [{ items: [{ images: [{ file: '../../etc/passwd' }] }] }] }),
      (err) => err.status === 400 && /媒体文件路径不合法/.test(err.message),
    );
  });

  test('非法音频路径直接报 400', () => {
    assert.throws(
      () => parseStateStrict({ sections: [{ items: [{ audio: { file: 'images/a.jpg' } }] }] }),
      (err) => err.status === 400,
    );
  });

  test('顶层不是对象报 400', () => {
    for (const bad of [null, [], 'x', 42]) {
      assert.throws(() => parseStateStrict(bad), (err) => err.status === 400);
    }
  });

  test('合法数据正常通过', () => {
    const state = parseStateStrict({
      title: '婚礼',
      sections: [{ name: '主舞台', items: [{ text: 'hi', images: [{ file: 'images/a.jpg' }] }] }],
    });
    assert.equal(state.title, '婚礼');
    assert.equal(state.sections[0].items[0].images[0].file, 'images/a.jpg');
  });
});

describe('defaultState', () => {
  test('包含一个空页签和自增计数器', () => {
    const state = defaultState();
    assert.equal(state.sections.length, 1);
    assert.deepEqual(state.counters, { section: 1, item: 0 });
  });
});
