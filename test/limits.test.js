import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_IMAGES_HARD_CAP,
  MAX_IMAGES_PER_ITEM,
  MAX_IMAGES_PER_REQUEST,
} from '../server/schema.js';

/**
 * 上限相关的独立回归测试。
 * 这些数值会出现在三处（前端常量、服务端 schema、README），
 * 任何一处被改动而其它地方没跟上，这里会失败。
 */

const APP_JS = path.resolve(import.meta.dirname, '../public/app.js');
const README = path.resolve(import.meta.dirname, '../README.md');

const readFrontendConst = (src, name) => {
  const matched = new RegExp(`const ${name} = (\\d+);`).exec(src);
  assert.ok(matched, `public/app.js 里找不到常量 ${name}`);
  return Number(matched[1]);
};

describe('上限：录音 3 分钟', () => {
  test('前端 MAX_RECORD_SECONDS = 180', async () => {
    const src = await fs.readFile(APP_JS, 'utf8');
    assert.equal(readFrontendConst(src, 'MAX_RECORD_SECONDS'), 180);
  });

  test('自动停止提示按常量推导，不写死"10 分钟"', async () => {
    const src = await fs.readFile(APP_JS, 'utf8');
    assert.ok(!src.includes('已达到 10 分钟上限'), '提示文案不应写死为 10 分钟');
    assert.match(src, /MAX_RECORD_SECONDS \/ 60/, '提示应从常量换算分钟数');
  });
});

describe('上限：一条 12 张图', () => {
  test('前端常量 = 12', async () => {
    const src = await fs.readFile(APP_JS, 'utf8');
    assert.equal(readFrontendConst(src, 'MAX_IMAGES_PER_ITEM'), 12);
    assert.equal(readFrontendConst(src, 'MAX_IMAGES_PER_REQUEST'), 12);
  });

  test('服务端 schema 常量与前端一致', () => {
    assert.equal(MAX_IMAGES_PER_ITEM, 12);
    assert.equal(MAX_IMAGES_PER_REQUEST, 12);
  });

  test('读取时的安全上限高于界面上限（避免旧数据被截断）', () => {
    assert.ok(
      MAX_IMAGES_HARD_CAP > MAX_IMAGES_PER_ITEM,
      `安全上限 ${MAX_IMAGES_HARD_CAP} 必须大于界面上限 ${MAX_IMAGES_PER_ITEM}`,
    );
  });

  test('满额时前端不再渲染「继续添加」按钮', async () => {
    const src = await fs.readFile(APP_JS, 'utf8');
    assert.match(
      src,
      /images\.length < MAX_IMAGES_PER_ITEM/,
      '渲染相册时应判断是否已达上限',
    );
  });
});

describe('文档与实现一致', () => {
  test('README 写的是 3 分钟 / 12 张', async () => {
    const md = await fs.readFile(README, 'utf8');
    assert.match(md, /录音最长\s*\*\*3 分钟\*\*/, 'README 应说明录音 3 分钟');
    assert.match(md, /一条最多\s*\*\*12 张图片\*\*/, 'README 应说明一条 12 张');
    assert.ok(!/录音最长 10 分钟/.test(md), 'README 不应还写 10 分钟');
    assert.ok(!/一条最多 20 张/.test(md), 'README 不应还写 20 张');
  });
});
