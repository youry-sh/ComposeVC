const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

/**
 * CC0 asset library bridge (Poly Haven public API).
 *
 * Lets the agent find real PBR textures and HDRIs, download them once into
 * `<userData>/plugins/assets/<type>/<id>/`, and get a ready-to-paste material /
 * world spec pointing at the local files. Nothing is downloaded implicitly.
 */

const API = "https://api.polyhaven.com";
const CDN_THUMB = "https://cdn.polyhaven.com/asset_img/thumbs";
const USER_AGENT = "ComposeVC/1.0 (Blender plugin)";
const listCache = new Map();

const TYPE_ALIASES = {
  hdri: "hdris",
  hdris: "hdris",
  environment: "hdris",
  env: "hdris",
  texture: "textures",
  textures: "textures",
  material: "textures",
  materials: "textures",
  model: "models",
  models: "models",
};

function normalizeType(value) {
  const key = String(value || "textures").trim().toLowerCase();
  return TYPE_ALIASES[key] || "textures";
}

function vaultRoot(userDataPath) {
  const base = String(userDataPath || "").trim();
  if (!base) throw new Error("Assets require Electron userDataPath");
  return path.join(base, "plugins", "assets");
}

function safeId(value) {
  return String(value || "asset").replace(/[^a-z0-9._-]/gi, "_").slice(0, 80) || "asset";
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

async function loadList(type) {
  const key = normalizeType(type);
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const json = await fetchJson(`${API}/assets?t=${key}`);
  const data = json && typeof json === "object" ? json : {};
  listCache.set(key, { at: Date.now(), data });
  return data;
}

function thumbnailUrl(id) {
  return `${CDN_THUMB}/${encodeURIComponent(id)}.png?width=256&height=256`;
}

async function searchAssets({ type = "textures", query = "", limit = 20, categories = "" } = {}) {
  const kind = normalizeType(type);
  const assets = await loadList(kind);
  const text = String(query || "").trim().toLowerCase();
  const categoryFilter = String(categories || "").trim().toLowerCase();
  const tokens = text.split(/\s+/).filter(Boolean);
  const entries = Object.entries(assets).map(([id, value]) => {
    const record = value && typeof value === "object" ? value : {};
    const tags = Array.isArray(record.tags) ? record.tags : [];
    const cats = Array.isArray(record.categories) ? record.categories : [];
    return {
      id,
      type: kind,
      name: String(record.name || id),
      tags,
      categories: cats,
      thumbnail: thumbnailUrl(id),
      maxResolution: Array.isArray(record.max_resolution) ? record.max_resolution : [],
      authors: record.authors || {},
      description: String(record.description || "").slice(0, 240),
      haystack: `${id} ${record.name || ""} ${tags.join(" ")} ${cats.join(" ")}`.toLowerCase(),
    };
  });
  let filtered = entries;
  if (categoryFilter) filtered = filtered.filter((entry) => entry.categories.some((cat) => String(cat).toLowerCase() === categoryFilter));
  if (tokens.length) {
    filtered = filtered
      .map((entry) => {
        const score = tokens.reduce((total, token) => total + (entry.haystack.includes(token) ? 1 : 0), 0) +
          (entry.name.toLowerCase().startsWith(text) ? 3 : 0) +
          (entry.id.toLowerCase() === text ? 5 : 0);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .map((item) => item.entry);
  } else {
    filtered = filtered.slice().sort((a, b) => a.name.localeCompare(b.name));
  }
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  return {
    ok: true,
    type: kind,
    total: entries.length,
    results: filtered.slice(0, max).map(({ haystack, ...rest }) => rest),
  };
}

async function assetInfo(id) {
  const assetId = String(id || "").trim();
  if (!assetId) throw new Error("Не указан id ассета.");
  try {
    const info = await fetchJson(`${API}/info/${encodeURIComponent(assetId)}`);
    return info && typeof info === "object" ? info : {};
  } catch {
    return {};
  }
}

function pickResolution(entry, wanted) {
  if (!entry || typeof entry !== "object") return null;
  const keys = Object.keys(entry).filter((key) => /^\d+k$/.test(key));
  if (!keys.length) return null;
  if (wanted && entry[wanted]) return entry[wanted];
  for (const candidate of ["1k", "2k", "4k", "8k"]) {
    if (entry[candidate]) return entry[candidate];
  }
  return entry[keys[0]];
}

function pickFile(mapEntry, formatOrder) {
  if (!mapEntry || typeof mapEntry !== "object") return null;
  for (const format of formatOrder) {
    const value = mapEntry[format];
    if (value && typeof value === "object" && value.url) {
      return { url: value.url, ext: format === "exr" ? "exr" : format, size: Number(value.size) || 0 };
    }
  }
  for (const [format, value] of Object.entries(mapEntry)) {
    if (value && typeof value === "object" && value.url) {
      return { url: value.url, ext: format, size: Number(value.size) || 0 };
    }
  }
  return null;
}

const MAP_SPECS = [
  { key: "base", maps: ["Diffuse", "diffuse", "albedo", "BaseColor"], order: ["jpg", "png", "exr"], name: "diffuse" },
  { key: "normal", maps: ["nor_gl", "nor_dx"], order: ["png", "jpg", "exr"], name: "normal" },
  { key: "roughness", maps: ["Rough", "rough", "Roughness"], order: ["jpg", "png", "exr"], name: "roughness" },
  { key: "metallic", maps: ["Metal", "metal", "Metallic"], order: ["jpg", "png", "exr"], name: "metalness" },
  { key: "ao", maps: ["AO", "ao"], order: ["jpg", "png"], name: "ao" },
  { key: "displacement", maps: ["Displacement", "disp"], order: ["png", "jpg", "exr"], name: "displacement" },
];

async function downloadFile(url, targetPath, { maxBytes = 120 * 1024 * 1024, timeoutMs = 180000 } = {}) {
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
    const source = Readable.fromWeb(response.body);
    source.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) source.destroy(new Error("Файл превысил допустимый размер."));
    });
    await pipeline(source, fs.createWriteStream(targetPath));
    if (!received) throw new Error("Сервер вернул пустой файл.");
    return { path: targetPath, bytes: received };
  } finally {
    clearTimeout(timer);
  }
}

async function readMetadata(folder) {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(folder, "asset.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeMetadata(folder, data) {
  await fs.promises.mkdir(folder, { recursive: true });
  const tmp = path.join(folder, "asset.json.tmp");
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmp, path.join(folder, "asset.json"));
}

async function downloadAsset(userDataPath, { id, type = "textures", resolution = "1k", force = false } = {}) {
  const kind = normalizeType(type);
  const assetId = String(id || "").trim();
  if (!assetId) throw new Error("Не указан id ассета.");
  const wanted = /^\d+k$/.test(String(resolution)) ? String(resolution) : "1k";
  const root = vaultRoot(userDataPath);
  const folder = path.join(root, kind, safeId(assetId));
  const existing = await readMetadata(folder);
  if (existing && existing.resolution === wanted && !force && Array.isArray(existing.files) && existing.files.length) {
    return { ...buildUsage(existing, folder), cached: true };
  }
  const filesJson = await fetchJson(`${API}/files/${encodeURIComponent(assetId)}`);
  const info = await assetInfo(assetId);
  const name = String(info?.name || assetId);
  const authors = info?.authors && typeof info.authors === "object" ? Object.keys(info.authors) : [];
  const downloaded = [];
  const errors = [];
  const local = {};

  if (kind === "hdris") {
    const resolutionEntry = pickResolution(filesJson?.hdri, wanted);
    const file = pickFile(resolutionEntry, ["hdr", "exr"]);
    if (!file) throw new Error(`У HDRI '${assetId}' нет файлов в разрешении ${wanted}.`);
    const target = path.join(folder, `hdri_${wanted}.${file.ext}`);
    try {
      const saved = await downloadFile(file.url, target);
      downloaded.push({ key: "hdri", path: saved.path, bytes: saved.bytes });
      local.hdri = saved.path;
    } catch (error) {
      errors.push(`hdri: ${error.message}`);
    }
  } else if (kind === "models") {
    const blendEntry = pickResolution(filesJson?.blend, wanted) || pickResolution(filesJson?.gltf, wanted);
    if (!blendEntry) throw new Error(`У модели '${assetId}' нет файлов в разрешении ${wanted}.`);
    const blendFile = pickFile(filesJson?.blend && pickResolution(filesJson.blend, wanted), ["blend"]);
    const gltfFile = pickFile(filesJson?.gltf && pickResolution(filesJson.gltf, wanted), ["gltf", "glb"]);
    for (const [kindName, file] of [["model", blendFile], ["model", gltfFile]]) {
      if (!file) continue;
      const target = path.join(folder, `${kindName}.${file.ext}`);
      try {
        const saved = await downloadFile(file.url, target);
        downloaded.push({ key: file.ext, path: saved.path, bytes: saved.bytes });
        local[file.ext] = saved.path;
      } catch (error) {
        errors.push(`${file.ext}: ${error.message}`);
      }
    }
  } else {
    for (const spec of MAP_SPECS) {
      let file = null;
      for (const mapName of spec.maps) {
        const resolutionEntry = pickResolution(filesJson?.[mapName], wanted);
        if (!resolutionEntry) continue;
        file = pickFile(resolutionEntry, spec.order);
        if (file) break;
      }
      if (!file) continue;
      const target = path.join(folder, `${spec.name}.${file.ext}`);
      try {
        const saved = await downloadFile(file.url, target);
        downloaded.push({ key: spec.key, path: saved.path, bytes: saved.bytes });
        local[spec.key] = saved.path;
      } catch (error) {
        errors.push(`${spec.key}: ${error.message}`);
      }
    }
    if (!downloaded.length) throw new Error(`Не удалось скачать ни одну карту текстуры '${assetId}'. ${errors.join(" | ")}`);
  }

  const metadata = {
    version: 1,
    type: kind,
    id: assetId,
    name,
    authors,
    license: "CC0 (Poly Haven)",
    source: `https://polyhaven.com/a/${assetId}`,
    resolution: wanted,
    thumbnail: thumbnailUrl(assetId),
    downloadedAt: Date.now(),
    files: downloaded,
    errors,
  };
  await writeMetadata(folder, metadata);
  return buildUsage(metadata, folder);
}

function buildUsage(metadata, folder) {
  const usage = { material: null, world: null, import: null, append: null, notes: [] };
  const byKey = Object.fromEntries((metadata.files || []).map((file) => [file.key, file.path]));
  if (metadata.type === "textures") {
    const material = { name: metadata.name || metadata.id, base_color: "#ffffff", roughness: 0.5, metallic: 0 };
    if (byKey.base) material.texture = { type: "image", path: byKey.base, projection: "uv", uv_scale: 1 };
    if (byKey.normal) material.normal_map = { path: byKey.normal, strength: 1 };
    if (byKey.roughness) material.roughness_texture = { path: byKey.roughness, roughness_min: 0.15, roughness_max: 0.95 };
    if (byKey.metallic) material.metallic_texture = { path: byKey.metallic };
    if (!byKey.base) usage.notes.push("Нет diffuse-карты: задайте base_color вручную.");
    usage.material = material;
  } else if (metadata.type === "hdris") {
    if (byKey.hdri) usage.world = { hdri: byKey.hdri, strength: 1.0 };
  } else if (metadata.type === "models") {
    const gltf = (metadata.files || []).find((file) => file.key === "gltf" || file.key === "glb");
    const blend = (metadata.files || []).find((file) => file.key === "blend");
    if (gltf) usage.import = [{ path: gltf.path }];
    if (blend) usage.append = [{ blend: blend.path }];
    usage.notes.push("Модель может ссылаться на внешние текстуры — проверьте материал после импорта.");
  }
  return {
    ok: (metadata.files || []).length > 0,
    cached: false,
    asset: {
      id: metadata.id,
      type: metadata.type,
      name: metadata.name,
      resolution: metadata.resolution,
      folder,
      thumbnail: metadata.thumbnail,
      source: metadata.source,
      license: metadata.license,
      files: metadata.files,
      errors: metadata.errors || [],
    },
    usage,
  };
}

async function listAssets(userDataPath, { type = "", limit = 100 } = {}) {
  const root = vaultRoot(userDataPath);
  const kinds = type ? [normalizeType(type)] : ["textures", "hdris", "models"];
  const results = [];
  for (const kind of kinds) {
    const dir = path.join(root, kind);
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadata = await readMetadata(path.join(dir, entry.name));
      if (!metadata) continue;
      results.push({
        id: metadata.id,
        type: metadata.type,
        name: metadata.name,
        resolution: metadata.resolution,
        folder: path.join(dir, entry.name),
        files: metadata.files,
        thumbnail: thumbnailUrl(metadata.id),
        downloadedAt: metadata.downloadedAt,
      });
    }
  }
  results.sort((a, b) => (b.downloadedAt || 0) - (a.downloadedAt || 0));
  return { ok: true, total: results.length, assets: results.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))) };
}

async function removeAsset(userDataPath, { id, type = "textures" } = {}) {
  const kind = normalizeType(type);
  const folder = path.join(vaultRoot(userDataPath), kind, safeId(id));
  await fs.promises.rm(folder, { recursive: true, force: true });
  return { ok: true, removed: folder };
}

module.exports = {
  API,
  normalizeType,
  vaultRoot,
  searchAssets,
  downloadAsset,
  listAssets,
  removeAsset,
  assetInfo,
};
