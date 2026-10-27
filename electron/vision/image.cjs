const fs = require("fs");
const path = require("path");

/**
 * Image helpers for the vision tool and tool-result attachments.
 *
 * Electron's nativeImage downscales PNG/JPEG before sending to a provider, so a
 * 1600×1000 Blender render does not consume 32 MiB of base64 context. When
 * nativeImage is unavailable (plain Node diagnostics), the raw file is used.
 */

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath || "")).toLowerCase()] || "image/png";
}

function toDataUrl(buffer, mimeType) {
  return `data:${mimeType || "image/png"};base64,${buffer.toString("base64")}`;
}

async function fileToDataUrl(filePath, { maxSize = 1280, maxBytes = 40 * 1024 * 1024 } = {}) {
  const target = String(filePath || "").trim();
  if (!target) throw new Error("Не указан путь к изображению.");
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`Изображение не найдено: ${target}`);
  if (stat.size > maxBytes) throw new Error(`Изображение слишком большое (${Math.round(stat.size / 1048576)} МБ).`);

  try {
    const { nativeImage } = require("electron");
    if (nativeImage) {
      let image = nativeImage.createFromPath(target);
      if (image && !image.isEmpty()) {
        const size = image.getSize();
        const limit = Math.max(320, Math.min(4096, Number(maxSize) || 1280));
        if (Math.max(size.width, size.height) > limit) {
          const scale = limit / Math.max(size.width, size.height);
          image = image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
            quality: "good",
          });
        }
        let buffer = image.toPNG();
        let mimeType = "image/png";
        if (buffer.length > 2_600_000) {
          buffer = image.toJPEG(82);
          mimeType = "image/jpeg";
        }
        const scaled = image.getSize();
        return {
          dataUrl: toDataUrl(buffer, mimeType),
          mimeType,
          bytes: buffer.length,
          width: scaled.width,
          height: scaled.height,
          path: target,
        };
      }
    }
  } catch {
    /* Electron is unavailable (tests) or the file cannot be decoded. */
  }

  const buffer = await fs.promises.readFile(target);
  const mimeType = mimeFor(target);
  return {
    dataUrl: toDataUrl(buffer, mimeType),
    mimeType,
    bytes: buffer.length,
    width: 0,
    height: 0,
    path: target,
  };
}

module.exports = {
  MIME_BY_EXT,
  mimeFor,
  toDataUrl,
  fileToDataUrl,
};
