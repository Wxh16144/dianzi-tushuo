import fs from 'node:fs/promises';
import path from 'node:path';

/** 从清单里收集所有被引用的媒体相对路径 */
export function collectReferenced(state) {
  const images = new Set();
  const audio = new Set();

  for (const section of state?.sections ?? []) {
    for (const item of section?.items ?? []) {
      if (!item) continue;
      for (const image of item.images ?? []) {
        if (image?.file) images.add(image.file);
      }
      if (item.audio?.file) audio.add(item.audio.file);
    }
  }

  return { images, audio };
}

/** 列出目录里的文件（只列一层，媒体目录是扁平的） */
export async function listFiles(dir, prefix) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => `${prefix}/${entry.name}`);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * 计算清理计划（纯函数，便于测试）。
 * mode:
 *   'orphans' 只删没被引用的文件（默认）
 *   'all'     删掉全部媒体（清单里的图片/音频引用会失效）
 */
export function planMedia({ state, imageFiles, audioFiles, mode = 'orphans' }) {
  const referenced = collectReferenced(state);
  const images = [...imageFiles].sort();
  const audio = [...audioFiles].sort();

  const unreferencedImages = images.filter((file) => !referenced.images.has(file));
  const unreferencedAudio = audio.filter((file) => !referenced.audio.has(file));

  const deleteImages = mode === 'all' ? images : unreferencedImages;
  const deleteAudio = mode === 'all' ? audio : unreferencedAudio;

  const keptImages = images.filter((file) => !deleteImages.includes(file));
  const keptAudio = audio.filter((file) => !deleteAudio.includes(file));

  // 清单里引用了但磁盘上不存在的文件，值得单独提示
  const missingImages = [...referenced.images].filter((file) => !images.includes(file));
  const missingAudio = [...referenced.audio].filter((file) => !audio.includes(file));

  return {
    mode,
    deleteImages,
    deleteAudio,
    keptImages,
    keptAudio,
    missingImages,
    missingAudio,
    totals: {
      images: images.length,
      audio: audio.length,
      deleteCount: deleteImages.length + deleteAudio.length,
      keepCount: keptImages.length + keptAudio.length,
    },
  };
}

export async function fileSizes(baseDir, relativeFiles) {
  let total = 0;
  for (const rel of relativeFiles) {
    try {
      const stat = await fs.stat(path.join(baseDir, rel));
      total += stat.size;
    } catch {
      /* 文件可能已被删掉 */
    }
  }
  return total;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
