const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/**
 * ffprobe helpers for Motion Studio.
 *
 * ffprobeJson() runs one ffprobe process (no shell) and parses its JSON.
 * summarize() flattens the ffprobe payload into the small shape the UI and the
 * agent need, tolerating files with no streams / no format block.
 * listDirMedia() lists supported media files (max 2 levels deep).
 */

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".webm",
  ".mp3",
  ".wav",
  ".m4a",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
]);

function ffprobeJson(ffprobePath, filePath, options = {}) {
  const executable = String(ffprobePath || "").trim();
  const file = String(filePath || "").trim();
  if (!executable) return Promise.resolve({ ok: false, json: null, error: "FFprobe не найден." });
  if (!file) return Promise.resolve({ ok: false, json: null, error: "Не указан файл." });
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return Promise.resolve({ ok: false, json: null, error: `Не удалось прочитать файл: ${file}` });
  }
  if (!stat.isFile()) {
    return Promise.resolve({ ok: false, json: null, error: `Не удалось прочитать файл: это не файл — ${file}` });
  }
  const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 20000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        executable,
        [
          "-v",
          "error",
          "-print_format",
          "json",
          "-show_format",
          "-show_streams",
          "-show_error",
          file,
        ],
        { windowsHide: true, shell: false }
      );
    } catch (error) {
      resolve({ ok: false, json: null, error: `Не удалось запустить FFprobe: ${error?.message || String(error)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ ok: false, json: null, error: "FFprobe не ответил вовремя." });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(stdout.length - 8 * 1024 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 64000) stderr = stderr.slice(stderr.length - 64000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, json: null, error: `Не удалось запустить FFprobe: ${error?.message || String(error)}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
        resolve({ ok: false, json: null, error: `Не удалось прочитать файл: ${detail || `ffprobe код ${code}`}` });
        return;
      }
      try {
        const json = JSON.parse(stdout || "{}");
        resolve({ ok: true, json, error: "" });
      } catch {
        resolve({ ok: false, json: null, error: "Не удалось прочитать файл: FFprobe вернул некорректный JSON." });
      }
    });
  });
}

function parseRate(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (match) {
    const num = Number(match[1]);
    const den = Number(match[2]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) return Math.round((num / den) * 100) / 100;
  }
  const direct = Number(text);
  return Number.isFinite(direct) && direct > 0 ? Math.round(direct * 100) / 100 : 0;
}

function parseNum(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function rotationOf(stream) {
  const direct = Number(stream?.tags?.rotate);
  if (Number.isFinite(direct) && direct !== 0) return ((Math.round(direct) % 360) + 360) % 360;
  const sideData = Array.isArray(stream?.side_data_list) ? stream.side_data_list : [];
  for (const entry of sideData) {
    const rotation = Number(entry?.rotation);
    if (Number.isFinite(rotation) && rotation !== 0) return ((Math.round(rotation) % 360) + 360) % 360;
  }
  return 0;
}

function summarize(json) {
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const format = json?.format && typeof json.format === "object" ? json.format : {};
  const video = streams.find((stream) => stream && stream.codec_type === "video") || null;
  const audio = streams.find((stream) => stream && stream.codec_type === "audio") || null;
  const durationSec = Math.round((parseNum(format.duration) || parseNum(video?.duration) || parseNum(audio?.duration)) * 100) / 100;
  const bitrate = parseNum(format.bit_rate);
  return {
    durationSec,
    width: Math.round(parseNum(video?.width)),
    height: Math.round(parseNum(video?.height)),
    fps: parseRate(video?.avg_frame_rate || video?.r_frame_rate),
    videoCodec: String(video?.codec_name || ""),
    audioCodec: String(audio?.codec_name || ""),
    bitrateKbps: bitrate ? Math.round(bitrate / 1000) : 0,
    sizeBytes: Math.round(parseNum(format.size)),
    hasAudio: Boolean(audio),
    rotation: video ? rotationOf(video) : 0,
  };
}

async function listDirMedia(dirPath, limit = 200) {
  const root = String(dirPath || "").trim();
  const max = Math.max(1, Math.min(2000, Number(limit) || 200));
  const files = [];
  if (!root) return files;
  const walk = async (dir, depth) => {
    if (files.length >= max || depth < 0) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= max) return;
      if (/^(node_modules|\.git|\.backup)$/i.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) await walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(ext)) continue;
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = await fs.promises.stat(full);
        size = stat.size;
        modifiedAt = Math.round(stat.mtimeMs);
      } catch {
        size = 0;
      }
      files.push({ name: entry.name, path: full, ext: ext.slice(1), sizeBytes: size, modifiedAt });
    }
  };
  await walk(root, 2);
  return files;
}

module.exports = {
  MEDIA_EXTENSIONS,
  ffprobeJson,
  summarize,
  listDirMedia,
  parseRate,
};
