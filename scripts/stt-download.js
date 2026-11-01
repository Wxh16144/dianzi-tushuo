#!/usr/bin/env node
/**
 * 预下载 whisper 模型。
 *
 * 为什么需要单独下载：
 * mlx_whisper 会在「转写」时自动下载模型，而转写有超时（WHISPER_TIMEOUT_MS，默认 15 分钟）。
 * large-v3-turbo 约 1.5GB，慢网络下要一两个小时，必然被超时杀掉，只留下 .incomplete
 * 残片，下次再重来 —— 永远下不完。这个脚本不受转写超时限制，且支持断点续传。
 *
 *   npm run stt:download              # 下载 .env 里配置的模型
 *   npm run stt:download -- --check   # 只检查当前模型是否可用
 *   npm run stt:download -- -m mlx-community/whisper-small-mlx
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { execa } from 'execa';
import pc from 'picocolors';
import { WHISPER_MODEL } from '../server/config.js';
import { findHfBin, incompleteBlobs, modelCacheDir, modelCached } from '../server/stt.js';

const fmtMB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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

/** 每秒刷新一次体积，让长时间下载能看到进展 */
function watchProgress(dir) {
  let last = 0;
  const timer = setInterval(async () => {
    const size = await dirSize(dir);
    const speedKB = (size - last) / 1024;
    last = size;
    process.stdout.write(
      `\r  ${pc.dim('已下载')} ${fmtMB(size).padStart(10)}   ${pc.dim(`约 ${speedKB.toFixed(0)} KB/s`)}   `,
    );
  }, 1000);

  return () => {
    clearInterval(timer);
    process.stdout.write(`\r${' '.repeat(48)}\r`);
  };
}

async function report(model) {
  const cached = modelCached(model);
  const broken = incompleteBlobs(model).length;
  const dir = modelCacheDir(model);

  console.log(`\n  模型：${pc.bold(model)}`);
  console.log(`  状态：${cached ? pc.green('可用 ✓') : pc.red('不可用 ✗')}`);
  if (broken > 0) console.log(`  残片：${pc.yellow(`${broken} 个 .incomplete`)}（建议先清理）`);
  console.log(`  目录：${pc.dim(dir)}`);
  if (cached) console.log(`  占用：${fmtMB(await dirSize(dir))}`);
  console.log('');
  return cached;
}

async function main() {
  const program = new Command();

  program
    .name('stt-download')
    .description('预下载 whisper 模型（不受转写超时限制，支持断点续传）')
    .option('-m, --model <repo>', '模型仓库名', WHISPER_MODEL)
    .option('-c, --check', '只检查状态，不下载')
    .addHelpText(
      'after',
      `
示例：
  $ npm run stt:download                     # 下载 .env 里配置的模型
  $ npm run stt:download -- --check          # 看看当前模型能不能用
  $ npm run stt:download -- -m mlx-community/whisper-small-mlx

说明：
  · 下载中随时 Ctrl+C 都不会损坏缓存，下次运行会接着下
  · 慢网络建议挂后台：nohup npm run stt:download > stt-download.log 2>&1 &
  · 下载完成后重启服务即可使用「转文字」`,
    )
    .action(async (options) => {
      const model = options.model;

      if (options.check) {
        await report(model);
        return;
      }

      const hf = findHfBin();
      if (!hf) {
        console.error(pc.red('\n  找不到 hf 命令（mlx-whisper 环境里应该自带）。'));
        console.error(pc.dim('  先确认已安装：pipx install mlx-whisper\n'));
        process.exit(1);
      }

      console.log(`\n  ${pc.bold('预下载 whisper 模型')}`);
      console.log(`  模型：${pc.cyan(model)}`);
      console.log(`  工具：${pc.dim(hf)}`);

      const broken = incompleteBlobs(model);
      if (broken.length > 0) {
        console.log(pc.yellow(`  发现 ${broken.length} 个下载残片，会尝试续传`));
        console.log(pc.dim('  一直卡住的话可先清理：npm run clean -- --model-cache --yes'));
      }

      if (modelCached(model)) {
        console.log(pc.green('\n  模型已就绪，无需下载。'));
        await report(model);
        return;
      }

      console.log(pc.dim('\n  开始下载（Ctrl+C 可中断，下次会接着下）…\n'));

      const stop = watchProgress(modelCacheDir(model));
      const started = Date.now();
      const child = execa(hf, ['download', model, '--max-workers', '4'], { stdio: 'inherit', reject: false });

      const onSigint = () => child.kill('SIGINT');
      process.once('SIGINT', onSigint);

      const result = await child;
      process.removeListener('SIGINT', onSigint);
      stop();

      const seconds = Math.round((Date.now() - started) / 1000);

      if (result.exitCode !== 0) {
        console.error(pc.red(`\n  下载失败（退出码 ${result.exitCode}），已用时 ${seconds}s`));
        console.error(pc.dim('  缓存会保留，重新运行可以续传。'));
        process.exit(1);
      }

      if (await report(model)) {
        console.log(pc.green(`  ✓ 下载完成，用时 ${seconds}s。重启服务后即可使用「转文字」。\n`));
        return;
      }

      console.log(pc.yellow(`\n  下载结束但模型仍不可用（用时 ${seconds}s）。`));
      console.log(pc.dim('  可能还有残片：npm run clean -- --model-cache --yes 后重跑。\n'));
      process.exit(1);
    });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(pc.red(`\n失败：${err.message}`));
  if (err.stack) console.error(pc.dim(err.stack));
  process.exit(1);
});
