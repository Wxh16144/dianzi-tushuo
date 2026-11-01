#!/usr/bin/env node
/**
 * 危险操作：清理 data 目录。
 *
 * 默认只做「演练」（列出会删什么，不动文件）。真正删除必须显式加 --yes。
 * 执行前会把整个 data 目录完整备份到系统临时目录，并打印恢复命令。
 *
 *   npm run clean                  # 演练：看看孤儿文件有多少
 *   npm run clean:run              # 真正删除孤儿文件（保留被清单引用的）
 *   npm run clean:all              # 删除全部媒体（清单里的图片/音频会失效）
 *   npm run clean -- --logs        # 顺便清空日志
 *   npm run clean -- --exports     # 顺便清空历史导出
 *   npm run clean -- --help        # 查看全部参数
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import pc from 'picocolors';
import { DATA_DIR, EXPORTS_DIR, IMAGES_DIR, AUDIO_DIR, LOG_DIR, CACHE_DIR, STATE_FILE } from '../server/config.js';
import { parseState } from '../server/schema.js';
import { incompleteBlobs, modelCacheDir } from '../server/stt.js';
import { fileSizes, formatBytes, listFiles, planMedia } from '../server/cleanup.js';

const line = (char = '─') => console.log(pc.dim(char.repeat(64)));

/* ---------------- 数据读取 ---------------- */

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    return parseState(JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(pc.yellow('  没有找到 data/state.json，按「清单为空」处理（所有媒体都会算作孤儿）'));
      return { sections: [] };
    }
    throw new Error(`state.json 无法解析：${err.message}`);
  }
}

async function existingFiles(dir, prefix) {
  const files = await listFiles(dir, prefix);
  const present = [];
  for (const rel of files) {
    try {
      await fs.access(path.join(DATA_DIR, rel));
      present.push(rel);
    } catch {
      /* 扫描后被删掉的情况 */
    }
  }
  return present;
}

async function dirSize(dir) {
  let total = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else total += await fs.stat(full).then((s) => s.size, () => 0);
    }
  };
  await walk(dir);
  return total;
}

/* ---------------- 备份 / 确认 ---------------- */

const DEFAULT_BACKUP_BASE = path.join(os.tmpdir(), 'dianzi-tushuo-backups');

/**
 * 展开用户传入的路径：支持 ~ 和 $VAR / ${VAR}。
 * 注意不要把带 $ 的字面量直接交给 path.resolve，否则会在当前目录
 * 下建出名字就叫 $TMPDIR 的文件夹。
 */
function expandPath(input) {
  const expanded = String(input)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced, plain) => process.env[braced ?? plain] ?? '');
  return path.resolve(expanded);
}

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

async function backupDataDir(backupDir) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const base = backupDir ? expandPath(backupDir) : DEFAULT_BACKUP_BASE;

  // 防止把备份塞进 data 目录里（会自己复制自己）
  if (isInside(base, DATA_DIR)) {
    throw new Error(`备份目录不能位于 data 目录内：${base}`);
  }

  const target = path.join(base, `data-${stamp}`);

  await fs.mkdir(base, { recursive: true });
  await fs.cp(DATA_DIR, target, { recursive: true, errorOnExist: false });
  return target;
}

async function ask(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/* ---------------- 主流程 ---------------- */

async function runClean(options) {
  const mode = options.all ? 'all' : 'orphans';
  // --all 语义是「全部」，默认连内容缓存一起清；--no-cache 可在 --all 时跳过缓存清理
  const clearCache = options.all ? options.cache !== false : Boolean(options.cache);

  line('═');
  console.log(pc.bold('  电子图说 · 清理工具'));
  console.log(pc.dim('  data 目录：') + DATA_DIR);
  line('═');

  const state = await readState();
  const [imageFiles, audioFiles] = await Promise.all([
    existingFiles(IMAGES_DIR, 'images'),
    existingFiles(AUDIO_DIR, 'audio'),
  ]);

  const plan = planMedia({ state, imageFiles, audioFiles, mode });
  const { totals } = plan;
  const deleteList = [...plan.deleteImages, ...plan.deleteAudio];
  const deleteBytes = await fileSizes(DATA_DIR, deleteList);

  console.log(`\n  模式：${options.all ? pc.bgRed(' ALL ') : pc.bgCyan(' 孤儿文件 ')}`);
  console.log(`  图片  ${pc.bold(totals.images)} 个  音频  ${pc.bold(totals.audio)} 个`);
  console.log(`  将删除 ${pc.bold(pc.red(totals.deleteCount))} 个文件，保留 ${pc.bold(pc.green(totals.keepCount))} 个`);
  console.log(`  预计释放 ${pc.bold(pc.yellow(formatBytes(deleteBytes)))}`);

  if (plan.missingImages.length || plan.missingAudio.length) {
    console.log(pc.yellow(`  ⚠ 清单里引用了 ${plan.missingImages.length + plan.missingAudio.length} 个磁盘上不存在的文件（不会被删除）`));
  }

  if (deleteList.length > 0) {
    console.log('');
    for (const rel of deleteList.slice(0, 10)) console.log(pc.dim(`    - ${rel}`));
    if (deleteList.length > 10) console.log(pc.dim(`    … 另外 ${deleteList.length - 10} 个`));
  }

  // 额外目标
  const extra = [];
  if (options.logs) {
    const logs = await listFiles(LOG_DIR, 'logs');
    extra.push({ label: `日志 ${logs.length} 个`, bytes: await fileSizes(LOG_DIR, logs) });
  }
  if (options.exports) {
    const count = await fs.readdir(EXPORTS_DIR).then((f) => f.length, () => 0);
    extra.push({ label: `历史导出 ${count} 个`, bytes: await dirSize(EXPORTS_DIR) });
  }

  // whisper 模型里下载中断留下的 .incomplete 分片（只删这些，不动完整的权重）
  const brokenBlobs = options.modelCache ? incompleteBlobs() : [];
  if (options.modelCache) {
    const bytes = (
      await Promise.all(
        brokenBlobs.map((file) => fs.stat(file).then((s) => s.size, () => 0)),
      )
    ).reduce((a, b) => a + b, 0);
    extra.push({
      label: `whisper 未完成分片 ${brokenBlobs.length} 个`,
      bytes,
      hint: modelCacheDir(),
    });
  }

  // 内容缓存（转写/描述/视频片段/TTS），可安全清空，下次会按需重建
  const cacheBytes = clearCache ? await dirSize(CACHE_DIR) : 0;
  if (clearCache) {
    extra.push({ label: '内容缓存（转写/描述/视频/TTS）', bytes: cacheBytes, hint: CACHE_DIR });
  }
  if (extra.length) {
    console.log('');
    for (const item of extra) {
      console.log(`  另外清理：${item.label}（${formatBytes(item.bytes)}）`);
      if (item.hint) console.log(pc.dim(`            ${item.hint}`));
    }
  }

  console.log('');
  line();

  if (!options.yes) {
    console.log(pc.yellow('\n  演练模式：没有删除任何文件。'));
    console.log(pc.dim('  确认无误后执行：'));
    console.log(pc.dim(`    npm run ${options.all ? 'clean:all' : 'clean:run'}`));
    console.log('');
    return;
  }

  // --all 的二次确认：交互终端要手打 DELETE ALL；非交互环境必须显式 --force
  if (options.all) {
    if (process.stdin.isTTY && !options.force) {
      const answer = await ask(
        pc.bgRed(pc.white(` --all 会删除 ${deleteList.length} 个媒体文件（包括清单正在引用的），输入 DELETE ALL 继续： `)) + ' ',
      );
      if (answer !== 'DELETE ALL') {
        console.log(pc.yellow('\n  已取消，未做任何改动。\n'));
        return;
      }
    } else if (!process.stdin.isTTY && !options.force) {
      throw new Error('--all 在非交互环境下必须额外加 --force（例：npm run clean -- --all --yes --force）');
    }

    console.log(pc.red('\n  ⚠ --all 会删掉清单正在引用的文件，页面上的图片/音频会变成 404。'));
    console.log(pc.dim('    整个 data 目录已在下面完整备份，可按提示恢复。'));
  }

  // ---- 备份（--all 永远备份，忽略 --no-backup）----
  let backupPath = null;
  if (options.backup || options.all) {
    console.log(pc.dim('\n  正在备份 data 目录…'));
    backupPath = await backupDataDir(options.backupDir);
    console.log(`  ${pc.green('✓')} 备份完成：${pc.cyan(backupPath)}`);
  } else {
    console.log(pc.red('\n  ⚠ 已跳过备份（--no-backup）'));
  }

  // ---- 删除 ----
  let removed = 0;
  let failed = 0;
  for (const rel of deleteList) {
    try {
      await fs.rm(path.join(DATA_DIR, rel), { force: true });
      removed += 1;
    } catch (err) {
      failed += 1;
      console.log(pc.red(`  删除失败 ${rel}：${err.message}`));
    }
  }

  if (options.logs) {
    for (const rel of await listFiles(LOG_DIR, 'logs')) {
      await fs.rm(path.join(DATA_DIR, rel), { force: true }).catch(() => {});
    }
  }
  if (options.exports) {
    await fs.rm(EXPORTS_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(EXPORTS_DIR, { recursive: true }).catch(() => {});
  }
  if (options.modelCache) {
    for (const file of brokenBlobs) await fs.rm(file, { force: true }).catch(() => {});
    console.log(pc.dim(`  已清理 ${brokenBlobs.length} 个未完成模型分片，下次转写会重新下载`));
  }
  if (clearCache) {
    await fs.rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
    console.log(pc.dim(`  已清空内容缓存（释放约 ${formatBytes(cacheBytes)}），下次转写/转码/生成视频会重新生成`));
  }

  line();
  console.log(`\n  ${pc.green('✓')} 已删除 ${pc.bold(removed)} 个媒体文件${failed ? pc.red(`（${failed} 个失败）`) : ''}`);
  console.log(`  ${pc.green('✓')} 释放约 ${pc.bold(formatBytes(deleteBytes))}`);

  if (backupPath) {
    console.log(pc.dim('\n  需要恢复时执行（先停掉服务）：'));
    console.log(pc.dim(`    cp -R "${path.join(backupPath, '.')}" "${DATA_DIR}"`));
    console.log(pc.dim('  恢复完重启服务。'));
  }
  console.log('');
}

/* ---------------- CLI ---------------- */

const program = new Command();

const { version } = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
);

program
  .name('clean')
  .version(version, '-v, --version', '显示版本号')
  .description('清理 data 目录（危险操作：默认只演练，删除前会整体备份）')
  .option('-y, --yes', '真正执行删除（默认只演练，不删任何文件）')
  .option('-a, --all', '删除全部媒体（清单里的图片/音频会失效），并默认清空内容缓存')
  .option('-w, --workdir <dir>', '工作区目录（默认当前目录，也可用 WORK_DIR 环境变量）')
  .option('--logs', '顺便清空 data/logs')
  .option('--exports', '顺便清空 exports/')
  .option('--model-cache', '清掉 whisper 模型里下载中断的 .incomplete 分片')
  .option('--cache', '清空内容缓存（转写 / 描述 / 视频片段 / TTS）')
  .option('--no-cache', '不清内容缓存（仅 --all 时有用，跳过缓存清理）')
  .option('--backup-dir <dir>', '备份目录（支持 ~ 与 $VAR）', DEFAULT_BACKUP_BASE)
  .option('--no-backup', '跳过备份（--all 时无效，--all 永远备份）')
  .option('--force', '非交互环境（脚本/CI）执行 --all 时必须加，跳过手打确认')
  .addHelpText(
    'after',
    `
示例：
  $ npm run clean                          # 演练，只看会删什么
  $ npm run clean:run                      # 删除孤儿文件
  $ npm run clean:all                      # 删除全部媒体 + 内容缓存（需手打 DELETE ALL）
  $ npm run clean -- --logs --exports      # 顺便清空日志与历史导出
  $ npm run clean -- --model-cache --yes   # 清掉 whisper 下载中断的残片
  $ npm run clean -- --cache --yes         # 清空转写/描述/视频/TTS 的内容缓存
  $ npm run clean -- --all --no-cache --yes --force  # 删全部媒体但保留缓存
  $ npm run clean -- --all --yes --force   # CI 里删除全部媒体 + 缓存
  $ npm run clean -- --workdir /path/to/workspace --yes   # 清理指定工作区

安全说明：
  · 不加 --yes 绝不删除文件
  · 删除前把整个 data 目录备份到临时目录，并打印恢复命令
  · state.json 解析失败时直接中止，避免误删
  · 只删 data/images、data/audio，不动 state.json
  · --all 默认连 data/cache 一起清（可用 --no-cache 跳过）`,
  )
  .showHelpAfterError()
  .action(async (options) => {
    try {
      await runClean(options);
    } catch (err) {
      console.error(pc.red(`\n清理失败：${err.message}`));
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(`\n清理失败：${err.message}`));
  process.exit(1);
});
