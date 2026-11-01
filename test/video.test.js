import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import sharp from 'sharp';
import { createSandbox, makeImage } from './helpers/sandbox.js';

let box;
let config;
let media;
let video;
let skipReason = null;

before(async () => {
  box = await createSandbox('hubz-video-');
  config = box.config;
  media = await import('../server/media.js');
  video = await import('../server/video.js');
  if (!config.BIN.ffmpeg) skipReason = '本机没有 ffmpeg';
});

after(async () => {
  await box.cleanup();
});

describe('纯函数', () => {
  test('slug：中文保留、分隔符与空白替换', () => {
    assert.equal(video.slug('主舞台'), '主舞台');
    assert.equal(video.slug('迎宾区 入口'), '迎宾区-入口');
    assert.equal(video.slug('a/b:c*d?'), 'a-b-c-d');
    assert.equal(video.slug('   '), '未命名');
    assert.equal(video.slug(''), '未命名');
  });

  test('escapeXml：转义 XML 特殊字符', () => {
    assert.equal(video.escapeXml('<a>&"b"'), '&lt;a&gt;&amp;&quot;b&quot;');
  });

  test('captionLines：固定宽度折行，超长返回 null（整体隐藏）', () => {
    assert.deepEqual(video.captionLines('一二三四五六七八九十', 4, 3), ['一二三四', '五六七八', '九十']);
    assert.equal(video.captionLines('一二三四五六七八九十一二三', 4, 3), null, '超过 3 行应整体隐藏');
    assert.deepEqual(video.captionLines(''), []);
    assert.deepEqual(video.captionLines('   '), []);
  });

  test('itemCacheKey：内容/配置变化会改变 key，相同输入稳定', () => {
    const cfg = { width: 1080, height: 1920, fps: 25, secondsPerImage: 2, transSeconds: 0.5, burnText: true, fontFamily: 'Arial' };
    const base = {
      imageRels: ['images/a.jpg', 'images/b.jpg'],
      imageSigs: ['100:1', '200:2'],
      text: '背景板',
      title: '背景板',
      audioRel: 'audio/a.mp3',
      audioSig: '300:3',
      cfg,
    };

    const k1 = video.itemCacheKey(base);
    const k2 = video.itemCacheKey(base);
    assert.equal(k1, k2, '相同输入应产生相同 key');
    assert.match(k1, /^[0-9a-f]{20}$/);

    // 文案变了 key 变
    assert.notEqual(video.itemCacheKey({ ...base, text: '改了' }), k1);
    // 标题变了 key 变
    assert.notEqual(video.itemCacheKey({ ...base, title: '改了' }), k1);
    // 图片变了 key 变
    assert.notEqual(video.itemCacheKey({ ...base, imageRels: ['images/a.jpg'] }), k1);
    // 图片文件签名变了 key 变（同一路径但内容变了）
    assert.notEqual(video.itemCacheKey({ ...base, imageSigs: ['100:1', '999:2'] }), k1);
    // 音频变了 key 变
    assert.notEqual(video.itemCacheKey({ ...base, audioRel: 'audio/b.mp3' }), k1);
    // 配置变了 key 变
    assert.notEqual(video.itemCacheKey({ ...base, cfg: { ...cfg, secondsPerImage: 5 } }), k1);
    // 字幕开关改变输出画面，key 必须变
    assert.notEqual(video.itemCacheKey({ ...base, cfg: { ...cfg, burnText: false } }), k1);
    // 音频来源/语音改变音轨，key 必须变
    assert.notEqual(video.itemCacheKey({ ...base, cfg: { ...cfg, audioSource: 'tts' } }), k1);
    assert.notEqual(video.itemCacheKey({ ...base, cfg: { ...cfg, ttsVoice: 'Meijia' } }), k1);
  });

  test('titleCacheKey：标题/副标题/配置决定 key', () => {
    const cfg = { width: 1080, height: 1920, fps: 25, secondsPerImage: 2, transSeconds: 0.5, burnText: true, fontFamily: 'Arial' };
    const k1 = video.titleCacheKey({ title: '背景板', subtitle: '主舞台', cfg });
    assert.equal(video.titleCacheKey({ title: '背景板', subtitle: '主舞台', cfg }), k1);
    assert.notEqual(video.titleCacheKey({ title: '花艺', subtitle: '主舞台', cfg }), k1);
    assert.notEqual(video.titleCacheKey({ title: '背景板', subtitle: '迎宾区', cfg }), k1);
    assert.notEqual(video.titleCacheKey({ title: '背景板', subtitle: '主舞台', cfg: { ...cfg, fontFamily: 'SimHei' } }), k1);
  });

  test('chapterCacheKey：条目身份/顺序/标签/进度条开关决定 key', () => {
    const cfg = { width: 1080, height: 1920, fps: 25, secondsPerImage: 2, transSeconds: 0.5, burnText: true, fontFamily: 'Arial', progressBar: true };
    const entries = [
      { type: 'title', path: '/cache/aaa.mp4' },
      { type: 'item', path: '/cache/bbb.mp4', label: '背景板' },
      { type: 'title', path: '/cache/ccc.mp4' },
      { type: 'item', path: '/cache/ddd.mp4', label: '花艺' },
    ];

    const k1 = video.chapterCacheKey({ entries, cfg });
    assert.match(k1, /^[0-9a-f]{20}$/);
    assert.equal(video.chapterCacheKey({ entries, cfg }), k1, '相同输入应稳定');

    // 顺序变了 → 成品不同
    assert.notEqual(video.chapterCacheKey({ entries: [...entries].reverse(), cfg }), k1);
    // 标签变了 → 进度条文字不同
    const relabeled = entries.map((e) => (e.type === 'item' && e.label === '花艺' ? { ...e, label: '花艺布置' } : e));
    assert.notEqual(video.chapterCacheKey({ entries: relabeled, cfg }), k1);
    // 关掉进度条 → 成品不同
    assert.notEqual(video.chapterCacheKey({ entries, cfg: { ...cfg, progressBar: false } }), k1);
    // 单条目时进度条开关不影响成品，key 应一致
    const single = [{ type: 'item', path: '/cache/bbb.mp4', label: '背景板' }];
    assert.equal(
      video.chapterCacheKey({ entries: single, cfg }),
      video.chapterCacheKey({ entries: single, cfg: { ...cfg, progressBar: false } }),
      '单条目不叠进度条，开关不应影响 key',
    );
  });

  test('videoItemCacheKey：与音频解耦，音频/语音变化不变，画面变化才变', () => {
    const cfg = {
      width: 1080, height: 1920, fps: 25, secondsPerImage: 2, transSeconds: 0.5,
      burnText: true, fontFamily: 'Arial', audioSource: 'auto', ttsVoice: 'Tingting',
    };
    const base = {
      imageRels: ['images/a.jpg', 'images/b.jpg'],
      imageSigs: ['100:1', '200:2'],
      text: '背景板',
      title: '背景板',
      cfg,
    };

    const k1 = video.videoItemCacheKey(base);
    assert.match(k1, /^[0-9a-f]{20}$/);

    // 音频变化不应改变视频轨 key
    assert.equal(video.videoItemCacheKey(base), k1);
    assert.equal(video.videoItemCacheKey({ ...base, cfg: { ...cfg, audioSource: 'tts' } }), k1, '切换音频来源不影响视频轨');
    assert.equal(video.videoItemCacheKey({ ...base, cfg: { ...cfg, ttsVoice: 'Meijia' } }), k1, '切换 TTS 语音不影响视频轨');

    // 画面相关变化应改变视频轨 key
    assert.notEqual(video.videoItemCacheKey({ ...base, text: '改了' }), k1);
    assert.notEqual(video.videoItemCacheKey({ ...base, title: '改了' }), k1);
    assert.notEqual(video.videoItemCacheKey({ ...base, imageSigs: ['100:1', '999:2'] }), k1);
    assert.notEqual(video.videoItemCacheKey({ ...base, cfg: { ...cfg, secondsPerImage: 5 } }), k1);
    assert.notEqual(video.videoItemCacheKey({ ...base, cfg: { ...cfg, burnText: false } }), k1, '字幕开关影响画面');
  });

  test('buildCaptionSvg：有文字生成 SVG，空文字或超长返回 null', () => {
    const svg = video.buildCaptionSvg({ width: 1080, height: 1920, text: '背景板', fontFamily: 'Arial' });
    assert.ok(svg);
    assert.match(svg, /<svg/);
    assert.match(svg, /背景板/);
    assert.equal(video.buildCaptionSvg({ width: 1080, height: 1920, text: '', fontFamily: 'Arial' }), null);

    // 超过 4 行（22 字/行）应整体隐藏
    const long = '很'.repeat(22 * 4 + 1);
    assert.equal(video.buildCaptionSvg({ width: 1080, height: 1920, text: long, fontFamily: 'Arial' }), null);
  });

  test('computeSegments：时长规则', () => {
    assert.deepEqual(video.computeSegments({ imageCount: 3, secondsPerImage: 3 }), { total: 9, seg: 3 });

    const withAudio = video.computeSegments({ imageCount: 2, secondsPerImage: 3, hasAudio: true, probedDuration: 8 });
    assert.equal(withAudio.total, 8);
    assert.equal(withAudio.seg, 4);

    assert.equal(video.computeSegments({ imageCount: 2, secondsPerImage: 3, hasAudio: true, storedDuration: 6 }).total, 6);
    assert.equal(video.computeSegments({ imageCount: 2, secondsPerImage: 3, hasAudio: true }).total, 6);
    assert.equal(video.computeSegments({ imageCount: 1, secondsPerImage: 0.1 }).total, 0.5);
  });

  test('galleryLayout：大图区在上、缩略图条在下，缩略图都在画布内', () => {
    const one = video.galleryLayout(1, 1080, 1920);
    assert.equal(one.thumbs.length, 1);
    assert.ok(one.stage.h > 0 && one.thumbBar.h > 0, '应同时有大图区和缩略图条');
    assert.equal(one.stage.h + one.thumbBar.h, 1920, '舞台 + 缩略图条应占满画布高度');

    const four = video.galleryLayout(4, 1080, 1920);
    assert.equal(four.thumbs.length, 4);

    for (const t of four.thumbs) {
      assert.ok(t.x >= 0 && t.y >= four.thumbBar.y, '缩略图不应超出缩略图条上边界');
      assert.ok(t.x + t.w <= 1080 + 1, `缩略图右侧越界：${JSON.stringify(t)}`);
      assert.ok(t.y + t.h <= 1920 + 1, `缩略图底部越界：${JSON.stringify(t)}`);
      assert.ok(t.w > 0 && t.h > 0, '缩略图尺寸应为正');
    }
  });

  test('galleryLayout：图片很多时卡片动态缩窄，全部放得下不越界', () => {
    // 12 张图（当前单条上限），卡片宽度应自动收缩到能全部塞进画布
    const twelve = video.galleryLayout(12, 1080, 1920);
    assert.equal(twelve.thumbs.length, 12);
    const last = twelve.thumbs[twelve.thumbs.length - 1];
    assert.ok(last.x + last.w <= 1080 + 1, `最右侧缩略图越界：${JSON.stringify(last)}`);
    assert.ok(twelve.thumbs[0].x >= 0, '最左侧缩略图不应超出画布');

    // 卡片宽度应明显比 4 张时窄
    const four = video.galleryLayout(4, 1080, 1920);
    assert.ok(twelve.thumbW < four.thumbW, '图片越多卡片越窄');

    // 防御性：20 张（超过业务上限一倍）也不应越界
    const twenty = video.galleryLayout(20, 1080, 1920);
    const lastTwenty = twenty.thumbs[twenty.thumbs.length - 1];
    assert.ok(lastTwenty.x + lastTwenty.w <= 1080 + 1, `20 张时最右侧越界：${JSON.stringify(lastTwenty)}`);
    assert.ok(twenty.thumbW >= 24, '卡片宽度不应小于最小阈值');
  });

  test('containedRect：宽图上下留边，高图左右留边', () => {
    const wide = video.containedRect(2, 1080, 1920);
    assert.equal(Math.round(wide.w), 1080);
    assert.equal(Math.round(wide.h), 540);
    assert.equal(Math.round(wide.y), (1920 - 540) / 2);

    const tall = video.containedRect(0.5, 1080, 1920);
    assert.equal(Math.round(tall.h), 1920);
    assert.equal(Math.round(tall.w), 960);
    assert.equal(Math.round(tall.x), (1080 - 960) / 2);
  });

  test('easeInOutCubic：两端与中点', () => {
    assert.equal(video.easeInOutCubic(0), 0);
    assert.equal(video.easeInOutCubic(1), 1);
    assert.equal(video.easeInOutCubic(0.5), 0.5);
    assert.ok(video.easeInOutCubic(0.25) < 0.25, '前半段应更慢');
    assert.ok(video.easeInOutCubic(0.75) > 0.75, '后半段应更快');
  });

  test('pingPongSequence：来回循环，首尾不重复', () => {
    assert.deepEqual(video.pingPongSequence(1), [0]);
    assert.deepEqual(video.pingPongSequence(2), [0, 1]);
    assert.deepEqual(video.pingPongSequence(3), [0, 1, 2, 1]);
    assert.deepEqual(video.pingPongSequence(4), [0, 1, 2, 3, 2, 1]);
  });

  test('computeGalleryTimeline：每张固定停留 + 来回循环，不按音频缩放', () => {
    const single = video.computeGalleryTimeline({ imageCount: 1, secondsPerImage: 3 });
    assert.equal(single.multi, false);
    assert.equal(single.trans, 0);
    assert.equal(single.hold, 3);
    assert.equal(single.total, 3);

    const multi = video.computeGalleryTimeline({ imageCount: 3, secondsPerImage: 3, transSeconds: 0.5 });
    assert.equal(multi.multi, true);
    assert.equal(multi.hold, 3, '每张固定停留 3 秒');
    assert.equal(multi.trans, 0.5);
    // 无语音：来回 2 轮，seq = [0,1,2,1, 0,1,2,1]，8 停留 + 7 过渡
    assert.deepEqual(multi.seq, [0, 1, 2, 1, 0, 1, 2, 1]);
    assert.equal(multi.total, 8 * 3 + 7 * 0.5);

    // 有语音：停留仍是 3 秒不变，只是循环次数变多，总长对齐音频
    const audio = video.computeGalleryTimeline({ imageCount: 3, secondsPerImage: 3, transSeconds: 0.5, hasAudio: true, probedDuration: 10 });
    assert.equal(audio.hold, 3, '有语音也不能缩放每张停留时间');
    assert.equal(audio.trans, 0.5);
    assert.equal(audio.total, 10);
    assert.ok(audio.seq.length >= 4, '至少覆盖一个来回');
  });

  test('computeGalleryTimeline：语音太短时保底放完每张图', () => {
    // 6 张图、每张 2s、过渡 0.5s，最短完整展示一遍 = 6×2 + 5×0.5 = 14.5s
    const shortAudio = video.computeGalleryTimeline({ imageCount: 6, secondsPerImage: 2, transSeconds: 0.5, hasAudio: true, probedDuration: 3 });
    assert.equal(shortAudio.total, 14.5, '语音 3s 太短，应保底到放完每张图');
    assert.equal(shortAudio.hold, 2, '每张仍固定停 2s');
    // seq 至少覆盖一个正向 0..5（每张图都被看到一次）
    assert.ok(shortAudio.seq.includes(0) && shortAudio.seq.includes(5));

    // 单图也保底：语音 0.5s 但至少停 2s
    const singleShort = video.computeGalleryTimeline({ imageCount: 1, secondsPerImage: 2, transSeconds: 0.5, hasAudio: true, probedDuration: 0.5 });
    assert.equal(singleShort.total, 2);
    assert.equal(singleShort.multi, false);
  });

  test('collectRenderPlan：跳过无图条目，按章节分组', () => {
    const plan = video.collectRenderPlan({
      sections: [
        { seq: 1, name: 'A', items: [{ seq: 1, text: '有图', images: [{ file: 'images/a.jpg' }] }, { seq: 2, text: '无图', images: [] }] },
        { seq: 2, name: 'B', items: [{ seq: 3, text: '也有图', images: [{ file: 'images/b.jpg' }] }] },
        { seq: 3, name: 'C', items: [{ seq: 4, text: '全无图', images: [] }] },
      ],
    });
    assert.deepEqual(plan.map((s) => s.name), ['A', 'B']);
    assert.equal(plan[0].items[0].images[0], 'images/a.jpg');
    assert.deepEqual(video.collectRenderPlan(null), []);
    assert.deepEqual(video.collectRenderPlan({}), []);
  });

  test('findItemWithSection：按 id 定位条目', () => {
    const state = {
      sections: [{ name: 'A', items: [{ id: 'i1', text: 'x', images: [] }] }],
    };
    assert.equal(video.findItemWithSection(state, 'i1').section.name, 'A');
    assert.equal(video.findItemWithSection(state, 'i1').item.id, 'i1');
    assert.equal(video.findItemWithSection(state, 'nope'), null);
  });

  test('itemLabel / itemFileName：文件名稳定且可读，标题优先', () => {
    const item = { seq: 3, text: '背景板：香槟金布幔\n第二行说明' };
    const section = { seq: 1, name: '主舞台' };
    assert.equal(video.itemLabel(item, section), '背景板：香槟金布幔');
    assert.equal(video.itemLabel({ seq: 5, text: '' }, section, 2), '主舞台-5');

    // 有标题时优先用标题
    const titled = { seq: 3, title: '背景板', text: '背景板：香槟金布幔' };
    assert.equal(video.itemLabel(titled, section), '背景板');

    const name = video.itemFileName(section, item);
    assert.match(name, /^01-03-/);
    assert.ok(name.endsWith('.mp4'));
    assert.ok(!name.includes('/'), `文件名不应含路径分隔符：${name}`);
  });

  test('buildProgressTrack：单段返回 null，段宽按时长占比、斑马纹区分，且不含文字', () => {
    assert.equal(video.buildProgressTrack({ width: 1080, height: 1920, labels: ['A'], ratios: [1] }), null);

    const svg = video.buildProgressTrack({
      width: 1080, height: 1920, labels: ['甲', '乙', '丙'], ratios: [0.5, 0.25, 0.25],
    });
    assert.ok(svg);
    assert.match(svg, /<svg/);
    // 3 个斑马纹色块 + 4 条竖立分隔线（含两端）
    const rects = svg.match(/<rect/g) || [];
    assert.equal(rects.length, 7, `应有 3 个色块 + 4 条分隔线，实际 ${rects.length}`);
    assert.ok(svg.includes('rgba(0,0,0,0.5)'), '斑马纹浅色');
    assert.ok(svg.includes('rgba(0,0,0,0.28)'), '斑马纹深色');
    assert.ok(svg.includes('rgba(255,255,255,0.55)'), '应有竖立分隔线');
    assert.ok(!svg.includes('甲'), '底条不应包含文字（文字单独放最顶层）');
    // 第一段宽度应是第二段两倍（0.5 vs 0.25，usable 相同）
    const widths = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)]
      .map((m) => Number(m[2]))
      .filter((w) => w >= 6);
    assert.equal(widths.length, 3);
    assert.ok(widths[0] >= widths[1] * 2 - 2, `第一段应约为第二段两倍宽：${widths.join(', ')}`);
  });

  test('buildProgressLabels：单段返回 null，文字带描边在最顶层', () => {
    assert.equal(video.buildProgressLabels({ width: 1080, height: 1920, labels: ['A'], ratios: [1], fontFamily: 'Arial' }), null);

    const svg = video.buildProgressLabels({
      width: 1080, height: 1920, labels: ['甲', '乙', '丙'], ratios: [0.5, 0.25, 0.25], fontFamily: 'Arial',
    });
    assert.ok(svg);
    assert.match(svg, /甲/);
    assert.match(svg, /乙/);
    assert.match(svg, /丙/);
    assert.ok(svg.includes('paint-order="stroke"'), '文字应带描边（画在填充之下），保证在蓝底也清晰');
    assert.equal((svg.match(/<text/g) || []).length, 3, '应有 3 段文字');
  });

  test('buildTitleCard：中央大字标题 + 可选副标题', () => {
    const svg = video.buildTitleCard({ width: 1080, height: 1920, title: '背景板', subtitle: '主舞台', fontFamily: 'Arial' });
    assert.match(svg, /背景板/);
    assert.match(svg, /主舞台/);
    assert.match(svg, /text-anchor="middle"/);

    const noSub = video.buildTitleCard({ width: 1080, height: 1920, title: '第 2 项', fontFamily: 'Arial' });
    assert.match(noSub, /第 2 项/);
    assert.ok(!noSub.includes('主舞台'));
  });

  test('normalizeMode：非法值回退到 sections', () => {
    assert.equal(video.normalizeMode('items'), 'items');
    assert.equal(video.normalizeMode('sections'), 'sections');
    assert.equal(video.normalizeMode('all'), 'all');
    assert.equal(video.normalizeMode('bogus'), 'sections');
    assert.equal(video.normalizeMode(undefined), 'sections');
  });

  test('buildClipArgs：静音 / 音频映射 / 拼接', () => {
    const silent = video.buildClipArgs({ framePaths: ['/tmp/a.jpg'], audioPath: null, total: 3, seg: 3, fps: 25 });
    assert.ok(silent.some((a) => String(a).includes('anullsrc')));
    assert.ok(silent.some((a) => String(a).includes('concat=n=1:v=1:a=0')));
    assert.ok(silent.some((a) => String(a).includes('yuv420p')));
    assert.ok(silent.includes('-map'));

    const withAudio = video.buildClipArgs({ framePaths: ['/tmp/a.jpg'], audioPath: '/tmp/a.mp3', total: 2, seg: 2, fps: 25 });
    assert.ok(withAudio.includes('/tmp/a.mp3'));
    assert.ok(!withAudio.some((a) => String(a).includes('anullsrc')));
    // 音轨必须补齐到视频长度，否则 concat -c copy 会在接缝处留下音频空洞
    assert.ok(withAudio.includes('apad'), '有音频时必须 apad 补齐');
  });

  test('resolveVideoConfig：默认值与边界夹取', () => {
    const cfg = config.resolveVideoConfig({});
    assert.deepEqual(
      { width: cfg.width, height: cfg.height, fps: cfg.fps, secondsPerImage: cfg.secondsPerImage, burnText: cfg.burnText },
      { width: 1080, height: 1920, fps: 25, secondsPerImage: 2, burnText: true },
    );

    const clamped = config.resolveVideoConfig({ width: 1, height: 999999, fps: 0, secondsPerImage: -1 });
    assert.equal(clamped.width, 320);
    assert.equal(clamped.height, 4096);
    assert.equal(clamped.fps, 1);
    assert.equal(clamped.secondsPerImage, 0.5);

    assert.equal(config.resolveVideoConfig({ burnText: false }).burnText, false);
    assert.equal(cfg.progressBar, true, '进度条默认开启');
    assert.equal(config.resolveVideoConfig({ progressBar: false }).progressBar, false);
    assert.equal(config.resolveVideoConfig({ fontFamily: 'SimHei' }).fontFamily, 'SimHei');

    // 音频来源与 TTS 语音默认值
    assert.equal(config.resolveVideoConfig({}).audioSource, 'auto');
    assert.equal(config.resolveVideoConfig({}).ttsVoice, 'Tingting');
    assert.equal(config.resolveVideoConfig({ audioSource: 'tts' }).audioSource, 'tts');
    assert.equal(config.resolveVideoConfig({ audioSource: 'bogus' }).audioSource, 'auto', '非法来源回退 auto');
    assert.equal(config.resolveVideoConfig({ ttsVoice: '' }).ttsVoice, 'Tingting', '空语音回退默认');
  });

  test('resolveAudioSource：auto 按有无录音决策，recording/tts 强制', () => {
    assert.equal(video.resolveAudioSource('auto', true), 'recording');
    assert.equal(video.resolveAudioSource('auto', false), 'tts');
    assert.equal(video.resolveAudioSource('recording', true), 'recording');
    assert.equal(video.resolveAudioSource('recording', false), 'recording');
    assert.equal(video.resolveAudioSource('tts', true), 'tts');
    assert.equal(video.resolveAudioSource('tts', false), 'tts');
  });

  test('ttsTextFor：文案优先，无文案读标题，都空返回 null', () => {
    assert.equal(video.ttsTextFor({ text: '背景板：香槟金', title: '背景板' }), '背景板：香槟金');
    assert.equal(video.ttsTextFor({ text: '  ', title: '背景板' }), '背景板');
    assert.equal(video.ttsTextFor({ text: '', title: '' }), null);
    assert.equal(video.ttsTextFor(null), null);
  });

  test('ttsPauseText：换行处插入停顿，空白行合并，单行不变', () => {
    assert.equal(video.ttsPauseText('背景板：香槟金'), '背景板：香槟金');
    assert.equal(
      video.ttsPauseText('第一行\n第二行'),
      '第一行 [[slnc 400]] 第二行',
    );
    // 空行合并成一次停顿，行首尾空白清理掉
    assert.equal(
      video.ttsPauseText('第一行\n\n  第二行  '),
      '第一行 [[slnc 400]] 第二行',
    );
    // \r\n 与 \r 也按换行处理
    assert.equal(
      video.ttsPauseText('甲\r\n乙\r丙'),
      '甲 [[slnc 400]] 乙 [[slnc 400]] 丙',
    );
    assert.equal(video.ttsPauseText(null), '');
  });
});

describe('buildVideos（真实 ffmpeg）', () => {
  // recording：测试里无录音条目保持静音（旧行为），避免默认 auto 触发系统 TTS 影响时长断言
  const smallCfg = { width: 320, height: 568, fps: 10, secondsPerImage: 1, burnText: true, fontFamily: 'Arial', audioSource: 'recording', ttsVoice: 'Tingting' };

  test('生成章节视频（每个章节一个文件，不含合集）', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage({ width: 400, height: 300 }), { sectionSeq: 1, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ width: 300, height: 400, color: { r: 20, g: 160, b: 90 } }), { sectionSeq: 2, itemSeq: 1 });

    const state = {
      title: '视频测试',
      sections: [
        { seq: 1, name: '主舞台', items: [{ seq: 1, text: '背景板：香槟金', images: [a], audio: null }] },
        { seq: 2, name: '迎宾区', items: [{ seq: 1, text: '迎宾牌', images: [b], audio: null }] },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg });
    assert.equal(result.count, 2, '两个章节各一个视频');
    assert.equal(result.missing.length, 0);
    assert.deepEqual(result.files.map((f) => f.kind), ['section', 'section']);

    const names = result.files.map((f) => f.name);
    assert.ok(names.includes('01-主舞台.mp4'), `缺章节文件：${names.join(', ')}`);
    assert.ok(names.includes('02-迎宾区.mp4'), `缺章节文件：${names.join(', ')}`);

    for (const f of result.files) {
      const onDisk = path.join(config.EXPORTS_DIR, 'videos', f.name);
      const stat = await fs.stat(onDisk);
      assert.ok(stat.size > 1000, `${f.name} 太小：${stat.size}`);
    }

    // 标题过渡带轻切换音效：音效缓存存在，章节视频开头有声音（非全静音）
    const sounds = (await fs.readdir(config.VIDEO_CACHE_DIR)).filter((n) => /^transition-whoosh-[0-9a-f]{20}\.m4a$/.test(n));
    assert.equal(sounds.length, 1, `应生成一份参数化命名的切换音效：${sounds.join(', ')}`);

    const firstOut = path.join(config.EXPORTS_DIR, 'videos', result.files[0].name);
    const vol = await execa(config.BIN.ffmpeg, ['-i', firstOut, '-af', 'volumedetect', '-f', 'null', '-']);
    const maxMatch = vol.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
    assert.ok(maxMatch, '应能检测到章节视频音量');
    assert.ok(Number(maxMatch[1]) > -40, `章节视频应有切换音效（max_volume=${maxMatch[1]}dB）`);
  });

  test('无图条目被跳过、缺图记录进 missing', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage(), { sectionSeq: 3, itemSeq: 1 });
    const state = {
      title: '缺图测试',
      sections: [
        {
          seq: 1,
          name: 'A',
          items: [
            { seq: 1, text: '正常', images: [a], audio: null },
            { seq: 2, text: '无图', images: [], audio: null },
            { seq: 3, text: '缺图', images: [{ file: 'images/ghost.jpg', w: 10, h: 10 }], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg });
    assert.equal(result.count, 1, '只有一个章节有可渲染内容');
    assert.ok(result.missing.includes('images/ghost.jpg'));
  });

  test('无图清单返回 422', async (t) => {
    if (skipReason) return t.skip(skipReason);
    await assert.rejects(
      () => video.buildVideos({ state: { title: '空', sections: [{ seq: 1, name: 'A', items: [{ seq: 1, text: 'x', images: [] }] }] }, config: smallCfg }),
      (err) => err.status === 422,
    );
  });

  test('mode=items：每个条目一个视频', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage(), { sectionSeq: 4, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ color: { r: 10, g: 10, b: 200 } }), { sectionSeq: 4, itemSeq: 2 });
    const state = {
      title: '条目测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { seq: 1, text: '背景板', images: [a], audio: null },
            { seq: 2, text: '通道花艺', images: [b], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg, mode: 'items' });
    assert.equal(result.mode, 'items');
    assert.equal(result.count, 2);
    assert.ok(result.files.every((f) => f.kind === 'item'));
    assert.deepEqual(
      result.files.map((f) => f.name).sort(),
      ['01-01-背景板.mp4', '01-02-通道花艺.mp4'],
    );

    for (const f of result.files) {
      const onDisk = path.join(config.EXPORTS_DIR, 'videos', f.name);
      const stat = await fs.stat(onDisk);
      assert.ok(stat.size > 1000, `${f.name} 太小：${stat.size}`);
    }
  });

  test('mode=all：全部条目合并成一个视频', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage(), { sectionSeq: 5, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ color: { r: 0, g: 100, b: 0 } }), { sectionSeq: 5, itemSeq: 2 });
    const state = {
      title: '合集测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { seq: 1, text: '第一张', images: [a], audio: null },
            { seq: 2, text: '第二张', images: [b], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg, mode: 'all' });
    assert.equal(result.mode, 'all');
    assert.equal(result.count, 1);
    assert.equal(result.files[0].kind, 'all');
    assert.equal(result.files[0].name, '合集测试-全部.mp4');
  });

  test('章节视频顶部有完整进度条且实时推进', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const imgs = [];
    for (let i = 0; i < 3; i += 1) {
      imgs.push(await media.processImage(await makeImage({ color: { r: 40 * i + 40, g: 100, b: 60 } }), { sectionSeq: 7, itemSeq: i + 1 }));
    }
    const state = {
      title: '进度条测试',
      sections: [{
        seq: 1,
        name: '主舞台',
        items: [
          { seq: 1, title: '甲', text: '一', images: [imgs[0]], audio: null },
          { seq: 2, title: '乙', text: '二', images: [imgs[1]], audio: null },
          { seq: 3, title: '丙', text: '三', images: [imgs[2]], audio: null },
        ],
      }],
    };

    const result = await video.buildVideos({ state, config: smallCfg, mode: 'all' });
    const out = path.join(config.VIDEO_DIR, result.files[0].name);

    const { stdout } = await execa(config.BIN.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]);
    const total = Number(stdout.trim());

    // 进度条实时推进：在顶部进度条区域（y≈38）采样，统计蓝色进度条的像素宽度
    const blueWidthAt = async (seconds) => {
      const frame = path.join(config.TMP_DIR, `prog-${seconds.toFixed(2)}.png`);
      await execa(config.BIN.ffmpeg, ['-ss', String(seconds), '-i', out, '-frames:v', '1', '-f', 'image2', frame, '-y']);
      const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
      await fs.rm(frame, { force: true }).catch(() => {});
      const y = 38;
      let start = -1;
      let end = -1;
      for (let x = 16; x < 304; x += 1) {
        const i = (y * info.width + x) * info.channels;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (b > 180 && b > r + 60 && g < 120) {
          if (start < 0) start = x;
          end = x;
        }
      }
      return start < 0 ? 0 : end - start + 1;
    };

    const head = await blueWidthAt(0.2);
    const tail = await blueWidthAt(Math.max(0.2, total - 0.2));
    assert.ok(tail > head + 40, `进度条应实时推进（开头 ${head}px → 末尾 ${tail}px）`);

    // 文字标签始终可见：蓝色进度条推进时，白色文字（带描边）仍应存在，
    // 不能被蓝色盖住（文字层在最顶层）
    const frame = path.join(config.TMP_DIR, 'prog-label-check.png');
    await execa(config.BIN.ffmpeg, ['-ss', String(total * 0.5), '-i', out, '-frames:v', '1', '-f', 'image2', frame, '-y']);
    const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
    await fs.rm(frame, { force: true }).catch(() => {});
    let whiteText = 0;
    for (let y = 16; y < 60; y += 1) {
      for (let x = 16; x < 304; x += 1) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) whiteText += 1;
      }
    }
    assert.ok(whiteText > 20, `进度条上应有可见的文字标签（白色像素 ${whiteText}）`);
  });

  test('itemId：只导出单个条目，且不清空目录', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage(), { sectionSeq: 6, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ color: { r: 10, g: 10, b: 200 } }), { sectionSeq: 6, itemSeq: 2 });
    const state = {
      title: '单条测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { id: 'i_single', seq: 1, text: '背景板', images: [a], audio: null },
            { id: 'i_other', seq: 2, text: '通道花艺', images: [b], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg, itemId: 'i_single' });
    assert.equal(result.mode, 'items');
    assert.equal(result.count, 1);
    assert.equal(result.files[0].kind, 'item');
    assert.equal(result.files[0].name, '01-01-背景板.mp4');

    // 不存在的条目返回 404
    await assert.rejects(
      () => video.buildVideos({ state, config: smallCfg, itemId: 'i_nope' }),
      (err) => err.status === 404,
    );
  });

  test('多图条目：画册布局（大图 + 缩略图 swiper）来回循环滑动，产出合法 mp4', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const multiCfg = { ...smallCfg, secondsPerImage: 1, transSeconds: 0.4 };
    const a = await media.processImage(await makeImage({ width: 400, height: 300 }), { sectionSeq: 7, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ width: 300, height: 400, color: { r: 20, g: 160, b: 90 } }), { sectionSeq: 7, itemSeq: 1 });
    const c = await media.processImage(await makeImage({ width: 500, height: 400, color: { r: 200, g: 60, b: 20 } }), { sectionSeq: 7, itemSeq: 1 });

    const state = {
      title: '多图测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [{ seq: 1, text: '三张图的条目', images: [a, b, c], audio: null }],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: multiCfg, mode: 'items' });
    assert.equal(result.count, 1);
    assert.equal(result.files[0].kind, 'item');
    assert.equal(result.files[0].name, '01-01-三张图的条目.mp4');

    const onDisk = path.join(config.EXPORTS_DIR, 'videos', result.files[0].name);
    const stat = await fs.stat(onDisk);
    assert.ok(stat.size > 2000, `多图视频太小：${stat.size}`);

    // 无语音：来回 2 轮 = seq [0,1,2,1,0,1,2,1]，8 停留 + 7 过渡 = 8×1 + 7×0.4 = 10.8s
    const { execa } = await import('execa');
    const { stdout } = await execa(config.BIN.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', onDisk,
    ]);
    const duration = Number.parseFloat(stdout);
    assert.ok(Math.abs(duration - 10.8) < 1.0, `时长应为约 10.8s，实际 ${duration}`);
  });

  test('章节视频：多条目之间有中央标题过渡，进度条区分条目', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage({ width: 400, height: 300 }), { sectionSeq: 8, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ width: 300, height: 400, color: { r: 20, g: 160, b: 90 } }), { sectionSeq: 8, itemSeq: 2 });

    const state = {
      title: '章节测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { seq: 1, title: '背景板', text: '背景板：香槟金', images: [a], audio: null },
            { seq: 2, title: '花艺', text: '两侧花艺', images: [b], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: smallCfg, mode: 'sections' });
    assert.equal(result.count, 1);
    assert.equal(result.files[0].kind, 'section');
    assert.equal(result.files[0].name, '01-主舞台.mp4');

    const onDisk = path.join(config.EXPORTS_DIR, 'videos', result.files[0].name);
    assert.ok((await fs.stat(onDisk)).size > 2000);

    // 单图条目各 1s + 两个中央标题过渡各 0.9s = 1+0.9+1+0.9 = 3.8s
    const { execa } = await import('execa');
    const { stdout } = await execa(config.BIN.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', onDisk,
    ]);
    const duration = Number.parseFloat(stdout);
    assert.ok(Math.abs(duration - 3.8) < 0.6, `时长应为约 3.8s（含标题过渡），实际 ${duration}`);
  });
});

describe('音画对齐（真实 ffmpeg）', () => {
  const cfg = {
    width: 320, height: 568, fps: 10, secondsPerImage: 1, transSeconds: 0.5,
    burnText: true, fontFamily: 'Arial', audioSource: 'recording', ttsVoice: 'Tingting', progressBar: true,
  };

  /** 返回音频包相邻间隔里超过阈值的空洞 */
  const audioHoles = async (file, threshold = 0.06) => {
    const { stdout } = await execa(config.BIN.ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts_time', '-of', 'json', file,
    ]);
    const pts = JSON.parse(stdout).packets.map((p) => Number(p.pts_time)).filter(Number.isFinite).sort((x, y) => x - y);
    const holes = [];
    for (let i = 1; i < pts.length; i += 1) {
      const gap = pts[i] - pts[i - 1];
      if (gap > threshold) holes.push({ at: Number(pts[i - 1].toFixed(3)), gap: Number(gap.toFixed(3)) });
    }
    return { holes, span: pts.length ? Number((pts.at(-1) - pts[0]).toFixed(3)) : 0 };
  };

  const streamDurations = async (file) => {
    const { stdout } = await execa(config.BIN.ffprobe, [
      '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'csv=p=0', file,
    ]);
    const out = {};
    for (const line of stdout.trim().split('\n')) {
      const [type, dur] = line.split(',');
      out[type] = Number(dur);
    }
    return out;
  };

  test('章节成品：音轨无空洞，且时长与视频一致', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage({ width: 400, height: 300 }), { sectionSeq: 21, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ width: 300, height: 400, color: { r: 20, g: 160, b: 90 } }), { sectionSeq: 21, itemSeq: 2 });

    const state = {
      title: '对齐测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { seq: 1, title: '背景板', text: '背景板：香槟金', images: [a], audio: null },
            { seq: 2, title: '花艺', text: '两侧花艺', images: [b], audio: null },
          ],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: cfg, mode: 'sections' });
    const onDisk = path.join(config.EXPORTS_DIR, 'videos', result.files[0].name);

    const { holes, span } = await audioHoles(onDisk);
    assert.deepEqual(holes, [], `章节成品音频不应有空洞，实际：${JSON.stringify(holes)}`);

    const durs = await streamDurations(onDisk);
    assert.ok(Math.abs(durs.video - durs.audio) < 0.1, `音视频时长应对齐：video=${durs.video} audio=${durs.audio}`);

    // 音频内容（每包 1024 样本 @44.1k）不应明显短于时间轴
    const { stdout } = await execa(config.BIN.ffprobe, [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=pts_time', '-of', 'json', onDisk,
    ]);
    const packets = JSON.parse(stdout).packets.length;
    const contentSeconds = (packets * 1024) / 44100;
    assert.ok(Math.abs(contentSeconds - span) < 0.2, `音频内容 ${contentSeconds.toFixed(2)}s 与时间轴 ${span}s 偏差过大`);
  });

  test('章节成品缓存：同配置二次导出命中，不再重编码', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const a = await media.processImage(await makeImage({ width: 400, height: 300 }), { sectionSeq: 22, itemSeq: 1 });
    const b = await media.processImage(await makeImage({ width: 300, height: 400 }), { sectionSeq: 22, itemSeq: 2 });
    const state = {
      title: '缓存测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [
            { seq: 1, title: '背景板', text: '背景板', images: [a], audio: null },
            { seq: 2, title: '花艺', text: '花艺', images: [b], audio: null },
          ],
        },
      ],
    };

    const beforeKeys = new Set(
      (await fs.readdir(config.VIDEO_CACHE_DIR)).filter((n) => n.endsWith('.ch.mp4')),
    );

    const first = await video.buildVideos({ state, config: cfg, mode: 'sections' });
    const created = (await fs.readdir(config.VIDEO_CACHE_DIR))
      .filter((n) => n.endsWith('.ch.mp4') && !beforeKeys.has(n));
    assert.equal(created.length, 1, `本次导出应新增一份章节成品缓存：${created.join(', ')}`);

    const cachePath = path.join(config.VIDEO_CACHE_DIR, created[0]);
    const before = (await fs.stat(cachePath)).mtimeMs;

    // 删掉导出文件，确保第二次必须重新复制
    await fs.rm(path.join(config.EXPORTS_DIR, 'videos', first.files[0].name), { force: true });
    const second = await video.buildVideos({ state, config: cfg, mode: 'sections' });

    const after = (await fs.stat(cachePath)).mtimeMs;
    assert.equal(after, before, '二次导出应命中缓存，不重写缓存文件');
    assert.ok((await fs.stat(path.join(config.EXPORTS_DIR, 'videos', second.files[0].name))).size > 0, '导出文件应被重新生成');
  });

  test('多图条目：过渡段画面确实在滑动（不是静止帧）', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // 两张纯色图：左红右绿，滑动时中间帧必然左右半区颜色不同
    const red = await media.processImage(await makeImage({ width: 400, height: 300, color: { r: 200, g: 20, b: 20 } }), { sectionSeq: 23, itemSeq: 1 });
    const green = await media.processImage(await makeImage({ width: 400, height: 300, color: { r: 20, g: 160, b: 40 } }), { sectionSeq: 23, itemSeq: 2 });

    const state = {
      title: '过渡测试',
      sections: [
        {
          seq: 1,
          name: '主舞台',
          items: [{ seq: 1, title: '两张', text: '', images: [red, green], audio: null }],
        },
      ],
    };

    const result = await video.buildVideos({ state, config: { ...cfg, secondsPerImage: 1, transSeconds: 0.5 }, mode: 'items' });
    const videoPath = path.join(config.EXPORTS_DIR, 'videos', result.files[0].name);

    /** 抽一帧，返回左右两半的平均 RGB */
    const halves = async (seconds) => {
      const frame = path.join(config.TMP_DIR, `probe-${Date.now()}-${seconds}.png`);
      await execa(config.BIN.ffmpeg, ['-y', '-v', 'error', '-ss', String(seconds), '-i', videoPath, '-frames:v', '1', frame]);
      const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      const acc = { l: [0, 0, 0], r: [0, 0, 0] };
      const cnt = { l: 0, r: 0 };
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * channels;
          const side = x < width / 2 ? 'l' : 'r';
          for (let c = 0; c < 3; c += 1) acc[side][c] += data[i + c];
          cnt[side] += 1;
        }
      }
      await fs.rm(frame, { force: true });
      const avg = (s) => acc[s].map((v) => v / cnt[s]);
      return { left: avg('l'), right: avg('r') };
    };

    // 时间线：图0 停 1s → 过渡 0.5s → 图1 停 1s …
    const still = await halves(0.4);
    assert.ok(still.left[0] > still.right[1] || still.left[0] > 100, `停留段应偏红：${still.left}`);

    const mid = await halves(1.25);
    const gap = Math.abs(mid.left[0] - mid.right[0]) + Math.abs(mid.left[1] - mid.right[1]);
    assert.ok(
      gap > 30,
      `过渡段左右半区颜色应有明显差异（说明两图在滑动），实际 左=${mid.left.map(Math.round)} 右=${mid.right.map(Math.round)}`,
    );
  });
});
