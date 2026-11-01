import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CACHE_DIR } from './config.js';
import { log } from './logger.js';

/**
 * 内容寻址的文件缓存。
 *
 * 设计要点：
 * - key 一律用内容的 SHA-256（调用方负责把「文件字节 + 参数」拼进哈希），
 *   所以相同输入必然命中同一个缓存条目，和文件名 / uuid 无关。
 * - 每个条目 = 一份数据文件 + 一份 .meta.json（含 created / lastRead / bytes）。
 *   先写数据、最后写 meta：只有 meta 存在才视为「完整可用」，进程中途崩溃也只留下孤儿数据文件。
 * - lastRead 在每次 get 命中时刷新，cleanup 按 lastRead 做 LRU + TTL 淘汰。
 *
 * 这是刻意不引入第三方包：cache-manager / keyv / flat-cache 都是「内存优先 + 字符串 key」，
 * 既不做内容哈希，也不在文件系统上按 lastRead 淘汰，反而多一层依赖。
 */

const META_SUFFIX = '.meta.json';
const DATA_SUFFIX = '.data';

/** 字符串或 Buffer 的 SHA-256 十六进制摘要 */
export const sha256 = (input) => {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''));
  return crypto.createHash('sha256').update(data).digest('hex');
};

/** 把多个组成部分拼成一个稳定 key（用换行分隔，避免歧义拼接） */
export const hashKey = (...parts) => sha256(parts.map((p) => String(p ?? '')).join('\n'));

/**
 * 创建一个命名空间下的文件缓存。
 * @param {string} namespace  缓存子目录名，例如 'stt-transcript'
 * @param {{ maxAgeMs?: number, maxEntries?: number, maxBytes?: number }} [opts]
 */
export function createCache(namespace, { maxAgeMs = 7 * 24 * 3600 * 1000, maxEntries = 1000, maxBytes = 512 * 1024 * 1024 } = {}) {
  const dir = path.join(CACHE_DIR, namespace);
  const metaPath = (key) => path.join(dir, `${key}${META_SUFFIX}`);
  const dataPath = (key) => path.join(dir, `${key}${DATA_SUFFIX}`);
  const now = () => Date.now();

  const readMeta = async (key) => {
    try {
      return JSON.parse(await fsp.readFile(metaPath(key), 'utf8'));
    } catch {
      return null;
    }
  };

  const writeMeta = async (key, meta) => {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(metaPath(key), JSON.stringify(meta));
  };

  /** 列出所有「完整」条目（有 meta），附带读到的元信息 */
  const entries = async () => {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const keys = names
      .filter((name) => name.endsWith(META_SUFFIX))
      .map((name) => name.slice(0, -META_SUFFIX.length));

    const list = [];
    for (const key of keys) {
      const meta = await readMeta(key);
      if (meta) list.push({ key, meta });
    }
    return list;
  };

  return {
    dir,

    /** 命中时刷新 lastRead；返回 { data: Buffer, meta } 或 null */
    async get(key) {
      const meta = await readMeta(key);
      if (!meta) return null;
      let data;
      try {
        data = await fsp.readFile(dataPath(key));
      } catch {
        return null;
      }
      meta.lastRead = now();
      await writeMeta(key, meta).catch(() => {});
      return { data, meta };
    },

    /** 写入（覆盖同名 key）；数据先落盘，meta 最后写 */
    async set(key, data) {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(dataPath(key), data);
      await writeMeta(key, { created: now(), lastRead: now(), bytes: data.length });
    },

    /** 返回该 key 的 lastRead 时间戳，不存在返回 null */
    async lastRead(key) {
      const meta = await readMeta(key);
      return meta ? meta.lastRead : null;
    },

    async has(key) {
      return (await readMeta(key)) !== null;
    },

    async delete(key) {
      await fsp.rm(metaPath(key), { force: true }).catch(() => {});
      await fsp.rm(dataPath(key), { force: true }).catch(() => {});
    },

    entries,

    /** 统计：条目数、总字节数、最近/最久访问时间 */
    async stats() {
      const list = await entries();
      const bytes = list.reduce((sum, e) => sum + (Number(e.meta.bytes) || 0), 0);
      const reads = list.map((e) => Number(e.meta.lastRead) || 0).filter(Boolean);
      return {
        count: list.length,
        bytes,
        oldestRead: reads.length ? Math.min(...reads) : null,
        newestRead: reads.length ? Math.max(...reads) : null,
      };
    },

    /**
     * 淘汰：先清过期（lastRead 超过 maxAgeMs），再按 lastRead 从旧到新
     * 淘汰直到同时满足 maxEntries 与 maxBytes。顺带清掉无 meta 的孤儿数据文件。
     * 返回 { removed, freedBytes }。
     */
    async cleanup({ maxAgeMs: ageMs = maxAgeMs, maxEntries: capEntries = maxEntries, maxBytes: capBytes = maxBytes } = {}) {
      const list = await entries();
      const cutoff = now() - ageMs;

      let removed = 0;
      let freedBytes = 0;

      const drop = async (item) => {
        await fsp.rm(metaPath(item.key), { force: true }).catch(() => {});
        await fsp.rm(dataPath(item.key), { force: true }).catch(() => {});
        removed += 1;
        freedBytes += Number(item.meta.bytes) || 0;
      };

      // 1) 过期
      for (const item of list) {
        if ((Number(item.meta.lastRead) || 0) < cutoff) await drop(item);
      }

      // 2) 超量：按 lastRead 升序（最久没读的先淘汰）
      const remaining = (await entries()).sort(
        (a, b) => (Number(a.meta.lastRead) || 0) - (Number(b.meta.lastRead) || 0),
      );
      let totalBytes = remaining.reduce((sum, e) => sum + (Number(e.meta.bytes) || 0), 0);
      while (remaining.length > capEntries || totalBytes > capBytes) {
        if (remaining.length === 0) break;
        const victim = remaining.shift();
        await drop(victim);
        totalBytes -= Number(victim.meta.bytes) || 0;
      }

      // 3) 孤儿数据文件（写了 data 但没来得及写 meta）
      try {
        const names = await fsp.readdir(dir);
        for (const name of names) {
          if (!name.endsWith(DATA_SUFFIX)) continue;
          const key = name.slice(0, -DATA_SUFFIX.length);
          if (!(await readMeta(key))) {
            const full = dataPath(key);
            const size = await fsp.stat(full).then((s) => s.size, () => 0);
            await fsp.rm(full, { force: true }).catch(() => {});
            removed += 1;
            freedBytes += size;
          }
        }
      } catch {
        /* 目录不存在就忽略 */
      }

      if (removed > 0) {
        log.cache?.info?.({ namespace, removed, freedBytes }, '缓存清理完成');
      }
      return { removed, freedBytes };
    },

    /** 清空整个命名空间 */
    async clear() {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
