const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

/**
 * Blender add-on / extension discovery and download.
 *
 * Search uses the public extensions.blender.org API (no key). Downloads are
 * streamed to `<userData>/plugins/addons/` and then installed by the Python
 * driver through `bpy.ops.preferences.addon_install` (legacy add-on) or
 * `bpy.ops.extensions.package_install_files` (Blender 4.2+ extension).
 */

const EXTENSIONS_API = "https://extensions.blender.org/api/v1/extensions/";
const USER_AGENT = "ComposeVC/1.0 (Blender plugin)";
const listCache = { at: 0, data: null };

async function fetchExtensionList() {
  if (listCache.data && Date.now() - listCache.at < 10 * 60 * 1000) return listCache.data;
  const json = await fetchJson(EXTENSIONS_API);
  listCache.at = Date.now();
  listCache.data = json;
  return json;
}

async function fetchJson(url, { timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeExtension(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: String(item.name || id),
    tagline: String(item.tagline || ""),
    type: String(item.type || "add-on"),
    version: String(item.version || ""),
    blenderMin: String(item.blender_version_min || ""),
    archiveUrl: String(item.archive_url || ""),
    website: String(item.website || ""),
    maintainer: String(item.maintainer || ""),
    archiveSize: Number(item.archive_size) || 0,
    license: Array.isArray(item.license) ? item.license.join(", ") : String(item.license || ""),
  };
}

function compareVersions(a, b) {
  const left = String(a || "").split(".").map((part) => Number(part) || 0);
  const right = String(b || "").split(".").map((part) => Number(part) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function searchExtensions(query, { limit = 20 } = {}) {
  const json = await fetchExtensionList();
  const data = Array.isArray(json?.data) ? json.data : [];
  const byId = new Map();
  for (const entry of data.map(normalizeExtension).filter(Boolean)) {
    const previous = byId.get(entry.id);
    if (!previous || compareVersions(entry.version, previous.version) > 0) byId.set(entry.id, entry);
  }
  const entries = Array.from(byId.values());
  const text = String(query || "").trim().toLowerCase();
  let results = entries;
  if (text) {
    const tokens = text.split(/\s+/).filter(Boolean);
    results = entries
      .map((entry) => {
        const haystack = `${entry.id} ${entry.name} ${entry.tagline} ${entry.maintainer}`.toLowerCase();
        const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0) +
          (entry.id === text ? 5 : 0) +
          (entry.name.toLowerCase().startsWith(text) ? 3 : 0);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map((item) => item.entry);
  } else {
    results = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  const slice = results.slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
  return { ok: true, total: entries.length, results: slice, query: text };
}

async function resolveExtension(idOrUrl) {
  const value = String(idOrUrl || "").trim();
  if (!value) throw new Error("Не указан аддон (id или URL).");
  if (/^https?:\/\//i.test(value)) {
    return { id: path.basename(new URL(value).pathname).replace(/\.zip$/i, ""), url: value, name: value };
  }
  const search = await searchExtensions(value, { limit: 50 });
  const exact = search.results.find((entry) => entry.id.toLowerCase() === value.toLowerCase()) || search.results[0];
  if (!exact) throw new Error(`Аддон '${value}' не найден в каталоге extensions.blender.org.`);
  if (!exact.archiveUrl) throw new Error(`У аддона '${exact.id}' нет ссылки на архив.`);
  return { id: exact.id, url: exact.archiveUrl, name: exact.name, version: exact.version };
}

async function downloadFile(url, targetPath, { maxBytes = 220 * 1024 * 1024, timeoutMs = 180000, onProgress } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "*/*", "user-agent": USER_AGENT },
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length && length > maxBytes) throw new Error(`Файл слишком большой (${Math.round(length / 1048576)} МБ).`);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    let received = 0;
    let lastTick = 0;
    const source = Readable.fromWeb(response.body);
    const sink = fs.createWriteStream(targetPath);
    source.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        source.destroy(new Error("Файл превысил допустимый размер."));
        return;
      }
      const now = Date.now();
      if (onProgress && now - lastTick > 400) {
        lastTick = now;
        try {
          onProgress({ received, total: length });
        } catch {
          /* ignore */
        }
      }
    });
    await pipeline(source, sink);
    if (!received) throw new Error("Сервер вернул пустой файл.");
    return { path: targetPath, bytes: received };
  } finally {
    clearTimeout(timer);
  }
}

function addonsDir(userDataPath) {
  return path.join(String(userDataPath || ""), "plugins", "addons");
}

async function downloadAddonArchive(userDataPath, resolved, options = {}) {
  const safeId = String(resolved.id || "addon").replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || "addon";
  const target = path.join(addonsDir(userDataPath), `${safeId}${resolved.version ? "-" + resolved.version : ""}.zip`);
  const result = await downloadFile(resolved.url, target, options);
  return { ...result, id: resolved.id, name: resolved.name || resolved.id, version: resolved.version || "" };
}

module.exports = {
  EXTENSIONS_API,
  searchExtensions,
  resolveExtension,
  downloadFile,
  downloadAddonArchive,
  addonsDir,
};
