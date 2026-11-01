import { BIN } from './config.js';
import { log } from './logger.js';

let puppeteerModule = null;

async function getPuppeteer() {
  if (!puppeteerModule) puppeteerModule = (await import('puppeteer-core')).default;
  return puppeteerModule;
}

export const chromeReady = () => Boolean(BIN.chrome);

/**
 * 用本机 Chrome 把 ?print=1 页面打印成 A4 PDF。
 * 页面渲染完成后会设置 window.__PRINT_READY__ = true。
 */
export async function renderPdf({ port, outPath }) {
  if (!BIN.chrome) {
    throw Object.assign(
      new Error('未找到 Chrome/Chromium，无法生成 PDF。请安装 Chrome 或设置 CHROME_PATH'),
      { status: 503 },
    );
  }

  const puppeteer = await getPuppeteer();
  const started = Date.now();
  const browser = await puppeteer.launch({
    executablePath: BIN.chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1400, deviceScaleFactor: 2 });

    const response = await page.goto(`http://127.0.0.1:${port}/?print=1`, { waitUntil: 'load', timeout: 30_000 });
    if (response && !response.ok()) throw new Error(`打开打印页面失败：HTTP ${response.status()}`);

    await page.waitForFunction('window.__PRINT_READY__ === true', { timeout: 30_000 });
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images).map((img) => (img.decode ? img.decode().catch(() => {}) : Promise.resolve())));
    });

    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });

    log.pdf.info({ ms: Date.now() - started }, 'PDF 已生成');
  } finally {
    await browser.close().catch(() => {});
  }
}
