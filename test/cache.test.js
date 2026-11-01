import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSandbox } from './helpers/sandbox.js';

let box;
let createCache;
let hashKey;
let sha256;

before(async () => {
  // 必须先建沙箱（设置 DATA_DIR / LOG_LEVEL），再动态 import cache.js，
  // 否则 config/logger 会带着仓库的真实路径先被加载，污染仓库的 data 目录。
  box = await createSandbox('hubz-cache-');
  ({ createCache, hashKey, sha256 } = await import('../server/cache.js'));
});

after(async () => {
  await box.cleanup();
});

describe('sha256 / hashKey', () => {
  test('sha256 对相同内容稳定，且 Buffer 与字符串可区分', () => {
    assert.equal(sha256('abc'), sha256('abc'));
    assert.equal(sha256(Buffer.from('abc')), sha256('abc'));
    assert.notEqual(sha256('abc'), sha256('abd'));
  });

  test('hashKey 用换行分隔，避免拼接歧义', () => {
    assert.notEqual(hashKey('ab', 'c'), hashKey('a', 'bc'));
    assert.equal(hashKey('a', 'b'), hashKey('a', 'b'));
  });
});

describe('createCache：set / get / lastRead / has / delete', () => {
  test('set 后可 get 到原始字节，且 get 会刷新 lastRead', async () => {
    const cache = createCache('t-basic');
    await cache.clear();

    const key = hashKey('hello');
    await cache.set(key, Buffer.from('payload-1'));

    const before = await cache.lastRead(key);
    assert.ok(Number.isFinite(before), 'set 后应有 lastRead');

    // 等 5ms 再 get，确保 lastRead 被更新（时间戳变了）
    await new Promise((r) => setTimeout(r, 5));
    const hit = await cache.get(key);
    assert.equal(hit.data.toString(), 'payload-1');
    const after = await cache.lastRead(key);
    assert.ok(after >= before, 'get 命中后 lastRead 应刷新');
  });

  test('未命中返回 null，has 正确反映存在性', async () => {
    const cache = createCache('t-has');
    await cache.clear();

    assert.equal(await cache.has('missing'), false);
    assert.equal(await cache.get('missing'), null);
    assert.equal(await cache.lastRead('missing'), null);

    await cache.set('k1', Buffer.from('v'));
    assert.equal(await cache.has('k1'), true);
    assert.ok((await cache.get('k1')).data.equals(Buffer.from('v')));
  });

  test('delete 后 get 返回 null', async () => {
    const cache = createCache('t-del');
    await cache.clear();
    await cache.set('k', Buffer.from('v'));
    await cache.delete('k');
    assert.equal(await cache.get('k'), null);
  });
});

describe('createCache：cleanup 淘汰', () => {
  test('过期条目（lastRead 太旧）被清理', async () => {
    const cache = createCache('t-expire');
    await cache.clear();

    await cache.set('old', Buffer.from('x'));
    // 把 old 的 lastRead 手动改到很久以前
    const metaPath = path.join(cache.dir, 'old.meta.json');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    meta.lastRead = Date.now() - 1000 * 3600 * 24 * 10;
    await fs.writeFile(metaPath, JSON.stringify(meta));

    await cache.set('fresh', Buffer.from('y'));

    const result = await cache.cleanup({ maxAgeMs: 7 * 24 * 3600 * 1000, maxEntries: 1000, maxBytes: 1 << 30 });
    assert.ok(result.removed >= 1, '应清掉过期的 old');
    assert.equal(await cache.get('old'), null);
    assert.ok(await cache.get('fresh'), 'fresh 应保留');
  });

  test('超过 maxEntries 时按 lastRead 从旧到新淘汰', async () => {
    const cache = createCache('t-lru');
    await cache.clear();

    await cache.set('a', Buffer.from('1'));
    await new Promise((r) => setTimeout(r, 5));
    await cache.set('b', Buffer.from('2'));
    await new Promise((r) => setTimeout(r, 5));
    await cache.set('c', Buffer.from('3'));

    await cache.cleanup({ maxAgeMs: 1 << 30, maxEntries: 2, maxBytes: 1 << 30 });

    assert.equal(await cache.get('a'), null, '最久没读的 a 应被淘汰');
    assert.ok(await cache.get('b'));
    assert.ok(await cache.get('c'));
  });

  test('孤儿数据文件（有 data 无 meta）被清理', async () => {
    const cache = createCache('t-orphan');
    await cache.clear();

    await fs.mkdir(cache.dir, { recursive: true });
    await fs.writeFile(path.join(cache.dir, 'ghost.data'), Buffer.from('no-meta'));

    const result = await cache.cleanup({});
    assert.ok(result.removed >= 1);
    assert.equal(await cache.get('ghost'), null);
  });

  test('stats 统计条目数与字节数', async () => {
    const cache = createCache('t-stats');
    await cache.clear();
    await cache.set('a', Buffer.alloc(10));
    await cache.set('b', Buffer.alloc(20));

    const stats = await cache.stats();
    assert.equal(stats.count, 2);
    assert.equal(stats.bytes, 30);
  });
});
