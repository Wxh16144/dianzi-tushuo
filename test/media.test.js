import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSandbox, makeImage } from './helpers/sandbox.js';

let box;
let media;

before(async () => {
  box = await createSandbox('hubz-media-');
  media = await import('../server/media.js');
});

after(async () => {
  await box.cleanup();
});

describe('文件命名', () => {
  test('格式为 页签序-条目序-时间戳', () => {
    const name = media.baseName(2, 13);
    assert.match(name, /^02-13-\d{8}-\d{6}$/);
  });

  test('非法 seq 归零而不是 NaN', () => {
    assert.match(media.baseName('x', null), /^00-00-\d{8}-\d{6}$/);
  });
});

describe('音频扩展名推断', () => {
  test('按 MIME 推断', () => {
    assert.equal(media.guessAudioExt('audio/webm;codecs=opus'), 'webm');
    assert.equal(media.guessAudioExt('audio/mpeg'), 'mp3');
    assert.equal(media.guessAudioExt('audio/wav'), 'wav');
    assert.equal(media.guessAudioExt('audio/mp4'), 'm4a');
  });

  test('MIME 缺失时退回文件名', () => {
    assert.equal(media.guessAudioExt('', 'voice.webm'), 'webm');
    assert.equal(media.guessAudioExt('', 'record.m4a'), 'm4a');
  });

  test('都识别不出时给 webm', () => {
    assert.equal(media.guessAudioExt('', ''), 'webm');
  });
});

describe('图片处理', () => {
  test('不透明图片存为 jpg 并返回尺寸', async () => {
    const buffer = await makeImage({ width: 640, height: 480 });
    const result = await media.processImage(buffer, { sectionSeq: 1, itemSeq: 1 });

    assert.match(result.file, /^images\/01-01-\d{8}-\d{6}\.jpg$/);
    assert.equal(result.w, 640);
    assert.equal(result.h, 480);
    assert.equal(result.url, `/${result.file}`);

    const stat = await fs.stat(path.join(box.config.DATA_DIR, result.file));
    assert.ok(stat.size > 0);
  });

  test('带透明通道的图片存为 png', async () => {
    const buffer = await makeImage({ width: 320, height: 240, alpha: true });
    const result = await media.processImage(buffer, { sectionSeq: 1, itemSeq: 2 });
    assert.match(result.file, /\.png$/);
  });

  test('长边超过 2000 时按比例缩小', async () => {
    const buffer = await makeImage({ width: 3000, height: 1000 });
    const result = await media.processImage(buffer, { sectionSeq: 3, itemSeq: 4 });
    assert.equal(result.w, 2000);
    assert.equal(result.h, 667);
  });

  test('小图不会被放大', async () => {
    const buffer = await makeImage({ width: 300, height: 200 });
    const result = await media.processImage(buffer, { sectionSeq: 5, itemSeq: 6 });
    assert.equal(result.w, 300);
    assert.equal(result.h, 200);
  });

  test('批量图片带 -1/-2 后缀', async () => {
    const buffers = [await makeImage(), await makeImage({ color: { r: 10, g: 20, b: 200 } })];
    const results = await media.processImages(buffers, { sectionSeq: 7, itemSeq: 8 });
    assert.equal(results.length, 2);
    assert.match(results[0].file, /-1\.jpg$/);
    assert.match(results[1].file, /-2\.jpg$/);
  });
});

describe('音频处理', () => {
  test('没有 ffmpeg 时原样保存并标记 converted=false', async () => {
    const original = box.config.BIN.ffmpeg;
    box.config.BIN.ffmpeg = null;
    try {
      const buffer = Buffer.from('fake-audio-bytes');
      const result = await media.processAudio(buffer, {
        mimetype: 'audio/webm;codecs=opus',
        originalName: 'recording.webm',
        sectionSeq: 9,
        itemSeq: 10,
        clientDuration: 2.5,
      });

      assert.equal(result.converted, false);
      assert.equal(result.format, 'webm');
      assert.match(result.file, /\.webm$/);
      assert.equal(result.duration, 2.5, '应回退到客户端上报的时长');

      const saved = await fs.readFile(path.join(box.config.DATA_DIR, result.file));
      assert.equal(saved.toString(), 'fake-audio-bytes', '内容应原样保存');
    } finally {
      box.config.BIN.ffmpeg = original;
    }
  });
});
