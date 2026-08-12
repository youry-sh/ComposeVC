const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function filePath(userDataPath) { return path.join(userDataPath, "youtube", "library.json"); }
function parseVideoId(value) {
  const raw = String(value || "").trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(raw);
    if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || null;
  } catch { return null; }
  return null;
}
function read(userDataPath) {
  try { const data = JSON.parse(fs.readFileSync(filePath(userDataPath), "utf8")); return Array.isArray(data?.videos) ? data.videos : []; }
  catch { return []; }
}
async function write(userDataPath, videos) {
  const target = filePath(userDataPath); await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`; await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, videos }, null, 2), "utf8"); await fs.promises.rename(tmp, target);
}
function list(userDataPath) { return read(userDataPath).sort((a, b) => b.createdAt - a.createdAt); }
async function add(userDataPath, input = {}) {
  const videoId = parseVideoId(input.url); if (!videoId || !/^[\w-]{11}$/.test(videoId)) throw new Error("Некорректная ссылка YouTube");
  const videos = read(userDataPath); const existing = videos.find((v) => v.videoId === videoId); if (existing) return existing;
  const item = { id: `yt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, title: String(input.title || "").trim() || `YouTube · ${videoId}`, watched: false, createdAt: Date.now(), updatedAt: Date.now() };
  videos.push(item); await write(userDataPath, videos); return item;
}
async function update(userDataPath, id, patch = {}) {
  const videos = read(userDataPath); const index = videos.findIndex((v) => v.id === id); if (index < 0) throw new Error("Видео не найдено");
  videos[index] = { ...videos[index], ...(typeof patch.title === "string" ? { title: patch.title.trim() || videos[index].title } : {}), ...(typeof patch.watched === "boolean" ? { watched: patch.watched } : {}), updatedAt: Date.now() };
  await write(userDataPath, videos); return videos[index];
}
async function remove(userDataPath, id) { const videos = read(userDataPath); const next = videos.filter((v) => v.id !== id); if (next.length === videos.length) return false; await write(userDataPath, next); return true; }

module.exports = { parseVideoId, list, add, update, remove };
