import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import dayjs from 'dayjs';
import { DATA_DIR, EXPORTS_DIR } from './config.js';
import { ensureDirs, resolveDataPath } from './db.js';
import { renderPdf } from './pdf.js';
import { log } from './logger.js';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, CURRENT_STATE_VERSION } from './schema.js';

const stamp = () => dayjs().format('YYYYMMDD-HHmmss');

/** 收集被引用的媒体文件 */
export function collectMedia(state) {
  const images = new Set();
  const audio = new Set();
  for (const section of state.sections ?? []) {
    for (const item of section?.items ?? []) {
      if (!item) continue;
      for (const image of item.images ?? []) {
        if (image?.file) images.add(image.file);
      }
      if (item.audio?.file) audio.add(item.audio.file);
    }
  }
  return { images: [...images], audio: [...audio] };
}

/**
 * 备份包版本清单：用于导入时识别格式与数据版本。
 * 与 state.json 的 version 不同，这里额外带 format 版本，
 * 保证「备份包容器」本身也能独立演进。
 */
export function buildManifest(state) {
  const { images, audio } = collectMedia(state);
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: CURRENT_STATE_VERSION,
    exportedAt: dayjs().toISOString(),
    title: state.title,
    counts: {
      sections: state.sections?.length ?? 0,
      items: state.sections?.reduce((sum, section) => sum + (section?.items?.length ?? 0), 0) ?? 0,
    },
    media: { images, audio },
  };
}

const exists = (rel) => fs.existsSync(resolveDataPath(rel));

/** 只生成 PDF，存到 exports/ 供浏览器下载 */
export async function buildPdf({ port }) {
  await ensureDirs();
  const pdfName = `清单-${stamp()}.pdf`;
  const pdfPath = path.join(EXPORTS_DIR, pdfName);

  await renderPdf({ port, outPath: pdfPath });
  const { size } = await fsp.stat(pdfPath);

  return { pdf: pdfName, path: `exports/${pdfName}`, url: `/exports/${encodeURIComponent(pdfName)}`, size };
}

/**
 * 打包可回导备份 zip：manifest.json + state.json + 被引用的 images/ + audio/。
 * 不再依赖 Chrome/PDF，因此调用方无需串行化。
 */
export async function buildExport({ state }) {
  await ensureDirs();

  const ts = stamp();
  const zipName = `备份-${ts}.zip`;
  const zipPath = path.join(EXPORTS_DIR, zipName);

  const { images, audio } = collectMedia(state);
  const missing = [...images, ...audio].filter((rel) => !exists(rel));
  if (missing.length) {
    log.export.warn({ missing: missing.slice(0, 5), total: missing.length }, '部分媒体文件缺失，已跳过');
  }

  const manifest = buildManifest(state);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') log.export.warn({ err: err.message }, '归档警告');
      else reject(err);
    });

    archive.pipe(output);
    archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
    archive.append(`${JSON.stringify(state, null, 2)}\n`, { name: 'state.json' });

    for (const rel of images) {
      if (!missing.includes(rel)) archive.file(path.join(DATA_DIR, rel), { name: rel });
    }
    for (const rel of audio) {
      if (!missing.includes(rel)) archive.file(path.join(DATA_DIR, rel), { name: rel });
    }

    archive.finalize();
  });

  const { size } = await fsp.stat(zipPath);
  log.export.info({ zip: zipName, size, media: images.length + audio.length }, '导出完成');

  return {
    zip: zipName,
    path: `exports/${zipName}`,
    url: `/exports/${encodeURIComponent(zipName)}`,
    size,
    mediaCount: images.length + audio.length,
    missing,
  };
}
