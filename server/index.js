import pc from 'picocolors';
import open from 'open';
import {
  describeEnv,
  displayHost,
  DOTENV,
  isLoopbackHost,
  isWildcardHost,
  lanAddresses,
  SERVER,
  WORKDIR,
} from './config.js';
import { ensureDirs, initDb } from './db.js';
import { createApp } from './app.js';
import { log } from './logger.js';

async function main() {
  await ensureDirs();
  await initDb();

  log.app.info({ port: SERVER.port, host: SERVER.host }, '服务启动');
  log.env.info(DOTENV ? `已加载 .env（${DOTENV.keys.length} 项）` : '未找到 .env，使用默认配置');
  for (const line of describeEnv().split('\n')) log.env.info(line.trim());

  const app = createApp();
  const port = SERVER.port;
  const url = `http://${displayHost(SERVER.host)}:${port}/`;
  const lanUrls = isWildcardHost(SERVER.host)
    ? lanAddresses().map((ip) => `http://${ip}:${port}/`)
    : isLoopbackHost(SERVER.host)
      ? []
      : [url];

  const server = app.listen(port, SERVER.host, async () => {
    console.log('');
    console.log(`  ${pc.bold('电子图说')}  ${pc.cyan(url)}`);
    console.log(`  ${pc.dim('只读视图')}  ${pc.cyan(`${url}?readonly=1`)}`);
    for (const lanUrl of lanUrls) {
      console.log(`  ${pc.dim('局域网')}    ${pc.cyan(lanUrl)}`);
    }
    if (!lanUrls.length) {
      const hint = isLoopbackHost(SERVER.host)
        ? '仅本机可访问，加 --host（或 HOST=0.0.0.0）可让手机 / 平板打开'
        : '未发现可用的局域网 IPv4 地址，检查网络连接';
      console.log(`  ${pc.dim('局域网')}    ${pc.dim(hint)}`);
    }
    console.log(`  ${pc.dim('工作区')}    ${WORKDIR}`);
    console.log('');

    if (SERVER.openBrowser) {
      await open(url).catch((err) => log.app.warn({ err: err.message }, '打开浏览器失败'));
    } else {
      console.log(pc.dim('  （未自动打开浏览器，需要时运行 npm run start:open）\n'));
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const port = SERVER.port;
      console.error('');
      console.error(pc.red(`  端口 ${port} 已被占用`));
      console.error(pc.dim('  ────────────────────────────────────────'));
      console.error(pc.dim('  看看是谁占用的：'));
      console.error(pc.cyan(`    lsof -nP -iTCP:${port} -sTCP:LISTEN`));
      console.error(pc.dim('  如果是本工具残留的进程，直接结束它：'));
      console.error(pc.cyan(`    lsof -ti:${port} -sTCP:LISTEN | xargs kill`));
      console.error(pc.dim('  或者换个端口启动：'));
      console.error(pc.cyan(`    PORT=${port + 1} npm start`));
      console.error('');
      process.exit(1);
    }
    log.app.error({ err }, '服务出错');
    process.exit(1);
  });

  const shutdown = async (signal) => {
    log.app.info({ signal }, '正在关闭');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(pc.red(`启动失败：${err.message}`));
  if (err.stack) console.error(pc.dim(err.stack));
  process.exit(1);
});
