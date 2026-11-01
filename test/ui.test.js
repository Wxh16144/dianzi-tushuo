import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, makeImage } from './helpers/sandbox.js';

/**
 * 前端交互测试：用 puppeteer-core 驱动真实 Chrome，跑真实的 public/app.js。
 * 没有 Chrome 的机器（例如 CI）会自动跳过。只覆盖核心交互，不做细碎布局断言。
 */
let box;
let server;
let baseUrl;
let browser;
let skipReason = null;

async function launchPuppeteer() {
  const puppeteer = (await import('puppeteer-core')).default;
  return puppeteer.launch({
    executablePath: box.config.BIN.chrome,
    headless: true,
    // 测试里直接调 audio.play()，需要放开自动播放限制
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
}

before(async () => {
  box = await createSandbox('hubz-ui-');

  const media = await import('../server/media.js');
  const db = await import('../server/db.js');

  const png = await makeImage({ width: 1000, height: 750 });
  const img1 = await media.processImage(png, { sectionSeq: 1, itemSeq: 1 });
  const [img2, img3] = await media.processImages(
    [await makeImage({ color: { r: 20, g: 150, b: 90 } }), await makeImage({ color: { r: 90, g: 60, b: 200 } })],
    { sectionSeq: 1, itemSeq: 1 },
  );

  await db.setState({
    title: 'UI 测试清单',
    sections: [
      {
        id: 's_a',
        name: '主舞台',
        seq: 1,
        items: [
          {
            id: 'i_1',
            seq: 1,
            text: '背景板：香槟金布幔',
            images: [img1, img2, img3],
            audio: null,
          },
          { id: 'i_2', seq: 2, text: '无图片条目', images: [], audio: null },
        ],
      },
      { id: 's_b', name: '迎宾区', seq: 2, items: [{ id: 'i_3', seq: 3, text: '迎宾牌', images: [], audio: null }] },
    ],
  });

  const { createApp } = await import('../server/app.js');
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  if (!box.config.BIN.chrome) {
    skipReason = '本机没有 Chrome/Chromium';
    return;
  }
  browser = await launchPuppeteer();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await box.cleanup();
});

const openPage = async (query = '') => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/${query}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.card');
  return { page, errors };
};

describe('编辑模式', () => {
  test('渲染标题、页签、条目，且操作按钮分区', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    const view = await page.evaluate(() => ({
      title: document.getElementById('docTitle').value,
      tabs: [...document.querySelectorAll('.tab .tab-name')].map((n) => n.textContent),
      cards: document.querySelectorAll('.card').length,
      shots: document.querySelectorAll('.shot img').length,
      topbarButtons: [...document.querySelectorAll('.topbar-actions .btn')].map((b) => b.textContent),
      actionGroups: document.querySelectorAll('.topbar-actions .action-group').length,
      videoButtons: document.querySelectorAll('.card .video-btn').length,
      tabExport: document.querySelectorAll('.tab-export').length,
    }));

    assert.equal(view.title, 'UI 测试清单');
    assert.deepEqual(view.tabs, ['主舞台', '迎宾区']);
    assert.equal(view.cards, 2, '只渲染当前页签的条目');
    assert.equal(view.shots, 3);

    // 顶栏按「工作区 / 撤销重做 / 预览 / 导出 / 备份恢复 / 清空」分区，不再有「导出视频」
    assert.equal(view.actionGroups, 6, '顶栏应分成 6 个区');
    for (const label of ['打开工作区', '撤销', '重做', '预览', '导出 PDF', '导出 Zip', '导入', '清空']) {
      assert.ok(view.topbarButtons.includes(label), `顶栏缺少「${label}」`);
    }
    assert.ok(!view.topbarButtons.includes('导出视频'), '顶栏不应再放「导出视频」');

    // 视频入口下放到条目与页签
    assert.equal(view.videoButtons, 2, '每个有图的条目应有一个「视频」按钮');
    assert.equal(view.tabExport, 1, '页签栏末尾应有「导出视频」卡片');

    assert.deepEqual(errors, [], `页面不该有 JS 错误：${errors.join(' | ')}`);
    await page.close();
  });

  test('切换页签显示对应条目', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page } = await openPage();

    await page.evaluate(() => document.querySelectorAll('.tab')[1].click());
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);

    const text = await page.evaluate(() => document.querySelector('.card textarea').value);
    assert.equal(text, '迎宾牌');

    await page.close();
  });

  test('撤销 / 重做新增条目', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    // 拦截保存请求，避免污染共享的测试数据
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().endsWith('/api/state')) {
        req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      req.continue();
    });

    const count = () => page.evaluate(() => document.querySelectorAll('.card').length);
    assert.equal(await count(), 2);

    await page.click('.add-item');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
    assert.equal(await count(), 3, '新增后应有 3 个条目');

    await page.click('#btnUndo');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
    assert.equal(await count(), 2, '撤销后应回到 2 个条目');

    await page.click('#btnRedo');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
    assert.equal(await count(), 3, '重做后应回到 3 个条目');

    assert.deepEqual(errors, []);
    await page.close();
  });

  test('文本改动可一次撤销 / 重做', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().endsWith('/api/state')) {
        req.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return;
      }
      req.continue();
    });

    const firstText = () =>
      page.evaluate(() => document.querySelector('.card textarea')?.value ?? '');

    assert.equal(await firstText(), '背景板：香槟金布幔');

    await page.click('.card textarea');
    await page.keyboard.type('补充文案');
    assert.equal(await firstText(), '背景板：香槟金布幔补充文案');

    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => document.querySelector('.card textarea')?.value === '背景板：香槟金布幔');

    await page.keyboard.down('Meta');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => document.querySelector('.card textarea')?.value === '背景板：香槟金布幔补充文案');

    // 再次撤销回到原文，然后继续输入，新的输入也应能被撤销（撤销后要重新抓拍「改动前」快照）
    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => document.querySelector('.card textarea')?.value === '背景板：香槟金布幔');

    await page.keyboard.type('再次');
    assert.equal(await firstText(), '背景板：香槟金布幔再次');

    await page.keyboard.down('Meta');
    await page.keyboard.press('KeyZ');
    await page.keyboard.up('Meta');
    await page.waitForFunction(() => document.querySelector('.card textarea')?.value === '背景板：香槟金布幔');

    assert.deepEqual(errors, []);
    await page.close();
  });
});

describe('只读模式', () => {
  test('隐藏编辑控件，保留文案与图片', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage('?readonly=1');

    const view = await page.evaluate(() => ({
      textareas: document.querySelectorAll('textarea').length,
      addItem: document.querySelectorAll('.add-item').length,
      videoButtons: document.querySelectorAll('.video-btn').length,
      tabExport: document.querySelectorAll('.tab-export').length,
      staticText: document.querySelectorAll('.item-text-static').length,
      shots: document.querySelectorAll('.shot img').length,
    }));

    assert.equal(view.textareas, 0);
    assert.equal(view.addItem, 0);
    assert.equal(view.videoButtons, 0, '只读视图不应显示条目视频按钮');
    assert.equal(view.tabExport, 0, '只读视图不应显示页签导出卡片');
    assert.equal(view.staticText, 2);
    assert.equal(view.shots, 3);
    assert.deepEqual(errors, []);

    await page.close();
  });
});

describe('打印模式', () => {
  test('渲染全部页签并标记 __PRINT_READY__', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1400 });
    await page.goto(`${baseUrl}/?print=1`, { waitUntil: 'load' });
    await page.waitForFunction('window.__PRINT_READY__ === true', { timeout: 30000 });

    const view = await page.evaluate(() => ({
      sections: [...document.querySelectorAll('.section-title')].map((n) => n.textContent),
      cards: document.querySelectorAll('.card').length,
      textareas: document.querySelectorAll('textarea').length,
      indexes: [...document.querySelectorAll('.card-index')].map((n) => n.textContent),
    }));

    assert.deepEqual(view.sections, ['主舞台', '迎宾区'], '打印模式包含所有页签');
    assert.equal(view.cards, 3);
    assert.equal(view.textareas, 0);
    assert.deepEqual(view.indexes, ['01', '02', '01'], '序号按页签重新编号');

    await page.close();
  });
});

describe('音频播放', () => {
  test('同时只允许一个音频在播', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    const played = await page.evaluate(async () => {
      // 1 秒 8kHz 单声道正弦波 WAV，够用来触发 play 事件
      const makeWav = () => {
        const rate = 8000;
        const n = rate;
        const buf = new ArrayBuffer(44 + n);
        const dv = new DataView(buf);
        const writeStr = (offset, str) => {
          for (let i = 0; i < str.length; i += 1) dv.setUint8(offset + i, str.charCodeAt(i));
        };
        writeStr(0, 'RIFF');
        dv.setUint32(4, 36 + n, true);
        writeStr(8, 'WAVEfmt ');
        dv.setUint32(16, 16, true);
        dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true);
        dv.setUint32(24, rate, true);
        dv.setUint32(28, rate, true);
        dv.setUint16(32, 1, true);
        dv.setUint16(34, 8, true);
        writeStr(36, 'data');
        dv.setUint32(40, n, true);
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < n; i += 1) {
          bytes[44 + i] = 128 + Math.round(60 * Math.sin((i / rate) * 2 * Math.PI * 440));
        }
        let bin = '';
        for (const byte of bytes) bin += String.fromCharCode(byte);
        return `data:audio/wav;base64,${btoa(bin)}`;
      };

      const src = makeWav();
      const a = new Audio(src);
      const b = new Audio(src);
      document.body.append(a, b);

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const state = () => ({ a: !a.paused, b: !b.paused });

      await a.play();
      await wait(150);
      const onlyA = state();

      await b.play();
      await wait(150);
      const afterB = state();

      await a.play();
      await wait(150);
      const afterA = state();

      a.pause();
      a.remove();
      b.remove();
      return { onlyA, afterB, afterA };
    });

    assert.deepEqual(played.onlyA, { a: true, b: false }, '只播 A 时 B 不该响');
    assert.deepEqual(played.afterB, { a: false, b: true }, '播放 B 时应暂停 A');
    assert.deepEqual(played.afterA, { a: true, b: false }, '再播 A 时应暂停 B');
    assert.deepEqual(errors, []);

    await page.close();
  });
});

describe('提示弹窗', () => {
  test('带计时器的提示会自动消失', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page } = await openPage();

    // 让保存失败，触发一条 7 秒的 error 提示
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().endsWith('/api/state')) {
        req.respond({ status: 500, contentType: 'application/json', body: '{"error":"模拟失败"}' });
        return;
      }
      req.continue();
    });

    await page.click('.card textarea');
    await page.keyboard.type('改一下');
    await page.waitForFunction(() => document.querySelectorAll('.toast').length > 0, { timeout: 10000 });

    const shown = await page.evaluate(() => {
      const node = document.querySelector('.toast');
      return {
        text: node.textContent.trim(),
        timed: node.classList.contains('is-timed'),
        hasTimer: Boolean(node.querySelector('.toast-timer')),
        hasClose: Boolean(node.querySelector('.toast-close')),
      };
    });
    assert.ok(shown.text.includes('保存失败'), `提示文案不对：${shown.text}`);
    assert.equal(shown.timed, true, '应带自动消失计时器');
    assert.equal(shown.hasTimer, true, '应显示倒计时细线');
    assert.equal(shown.hasClose, true, '应能手动关闭');

    // 7 秒的提示，留点余量等它自己走掉
    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0, { timeout: 15000 });

    await page.close();
  });

  test('关闭按钮能立即收掉提示', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page } = await openPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().endsWith('/api/state')) {
        req.respond({ status: 500, contentType: 'application/json', body: '{"error":"模拟失败"}' });
        return;
      }
      req.continue();
    });

    await page.click('.card textarea');
    await page.keyboard.type('再改一下');
    await page.waitForFunction(() => document.querySelector('.toast-close'), { timeout: 10000 });
    await page.click('.toast-close');

    await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0, { timeout: 3000 });

    await page.close();
  });
});

describe('删除条目', () => {
  test('⌫ 弹出确认弹窗，Enter 确认后删除', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    // 用 ↑↓ 选中第一条（焦点不在输入框里，⌫ 才会被当成删除）
    await page.keyboard.press('ArrowDown');
    const selected = await page.evaluate(() => document.querySelector('.card.selected')?.dataset.itemId);
    assert.ok(selected, '↓ 应该选中第一条');
    const before = await page.evaluate(() => document.querySelectorAll('.card').length);

    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => !document.getElementById('dialogLayer').hidden, { timeout: 5000 });

    const dialog = await page.evaluate(() => ({
      title: document.getElementById('dialogTitle').textContent,
      text: document.getElementById('dialogText').textContent,
      okText: document.getElementById('dialogOk').textContent,
      focused: document.activeElement?.id,
      cards: document.querySelectorAll('.card').length,
    }));
    assert.match(dialog.title, /删除/, '弹窗标题应说明在删除什么');
    assert.match(dialog.text, /移除/, '弹窗正文应说明影响');
    assert.equal(dialog.okText, '删除');
    assert.equal(dialog.focused, 'dialogOk', '默认聚焦确认按钮，Enter 直达');
    assert.equal(dialog.cards, before, '还没确认，卡片不该减少');

    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (expected) => document.querySelectorAll('.card').length === expected,
      { timeout: 5000 },
      before - 1,
    );

    const gone = await page.evaluate(() => ({
      hidden: document.getElementById('dialogLayer').hidden,
      ids: [...document.querySelectorAll('.card')].map((c) => c.dataset.itemId),
    }));
    assert.equal(gone.hidden, true, '确认后弹窗应关闭');
    assert.ok(!gone.ids.includes(selected), '选中的那条应被删除');
    assert.deepEqual(errors, []);

    await page.close();
  });

  test('Esc 取消则不删除', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    await page.keyboard.press('ArrowDown');
    const before = await page.evaluate(() => document.querySelectorAll('.card').length);

    await page.keyboard.press('Delete');
    await page.waitForFunction(() => !document.getElementById('dialogLayer').hidden, { timeout: 5000 });
    await page.keyboard.press('Escape');

    await page.waitForFunction(() => document.getElementById('dialogLayer').hidden, { timeout: 5000 });
    const after = await page.evaluate(() => document.querySelectorAll('.card').length);
    assert.equal(after, before, '取消后卡片数量不变');
    assert.deepEqual(errors, []);

    await page.close();
  });

  test('卡片上的「删除」按钮走同一个弹窗', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { page, errors } = await openPage();

    const before = await page.evaluate(() => document.querySelectorAll('.card').length);
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.card .rec-btn')].find((b) => b.textContent === '删除');
      btn.click();
    });
    await page.waitForFunction(() => !document.getElementById('dialogLayer').hidden, { timeout: 5000 });

    // 点弹窗里的「取消」，卡片保留
    await page.click('#dialogCancel');
    await page.waitForFunction(() => document.getElementById('dialogLayer').hidden, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.querySelectorAll('.card').length), before);
    assert.deepEqual(errors, []);

    await page.close();
  });
});
