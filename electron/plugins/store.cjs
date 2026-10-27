const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * ComposeVC plugin store.
 *
 * Everything that must survive a restart lives under Electron userData:
 *
 *   <userData>/plugins/plugins.json          plugin registry state (versioned)
 *   <userData>/plugins/jobs/<jobId>/job.json one metadata file per job
 *   <userData>/plugins/jobs/<jobId>/…        large artifacts (scripts, logs, renders, exports)
 *   <userData>/plugins/output/               default export/render folder
 *
 * All JSON writes are atomic (tmp file in the same directory → fsync → rename),
 * so a crash can never leave half-written state behind. Reads validate and
 * normalize every field; unknown/corrupt plugin records are dropped instead of
 * crashing the workspace.
 */

const STORE_VERSION = 1;
const MAX_JOBS = 300;

const ENGINE_VALUES = ["EEVEE", "CYCLES", "WORKBENCH"];
const FORMAT_VALUES = ["GLB", "GLTF", "FBX", "OBJ", "USD", "STL", "PLY", "BLEND"];

const DEFAULT_BLENDER_CONFIG = {
  executable: "",
  outputDir: "",
  engine: "EEVEE",
  resolution: { width: 1600, height: 1000 },
  samples: 64,
  format: "GLB",
  autoRender: true,
  timeoutSec: 900,
  factoryStartup: true,
  keepJobFiles: true,
};

function requireUserDataPath(userDataPath) {
  const value = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!value) throw new Error("Plugins require Electron userDataPath");
  return path.resolve(value);
}

function pluginsRoot(userDataPath) {
  return path.join(requireUserDataPath(userDataPath), "plugins");
}

function storeFile(userDataPath) {
  return path.join(pluginsRoot(userDataPath), "plugins.json");
}

function jobsRoot(userDataPath) {
  return path.join(pluginsRoot(userDataPath), "jobs");
}

function defaultOutputDir(userDataPath) {
  return path.join(pluginsRoot(userDataPath), "output");
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function cleanString(value, max = 4096) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function normalizeBlenderConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const res = src.resolution && typeof src.resolution === "object" ? src.resolution : {};
  const config = {
    executable: cleanString(src.executable),
    outputDir: cleanString(src.outputDir),
    engine: ENGINE_VALUES.includes(String(src.engine))
      ? String(src.engine)
      : DEFAULT_BLENDER_CONFIG.engine,
    resolution: {
      width: clampNumber(res.width, DEFAULT_BLENDER_CONFIG.resolution.width, 64, 8192),
      height: clampNumber(res.height, DEFAULT_BLENDER_CONFIG.resolution.height, 64, 8192),
    },
    samples: clampNumber(src.samples, DEFAULT_BLENDER_CONFIG.samples, 1, 4096),
    format: FORMAT_VALUES.includes(String(src.format).toUpperCase())
      ? String(src.format).toUpperCase()
      : DEFAULT_BLENDER_CONFIG.format,
    autoRender: src.autoRender !== false,
    timeoutSec: clampNumber(src.timeoutSec, DEFAULT_BLENDER_CONFIG.timeoutSec, 10, 7200),
    factoryStartup: src.factoryStartup !== false,
    keepJobFiles: src.keepJobFiles !== false,
  };
  return config;
}

function normalizePlugin(entry, fallbackId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = cleanString(entry.id || fallbackId, 64);
  if (!id) return null;
  const config = id === "blender" ? normalizeBlenderConfig(entry.config) : {};
  return {
    id,
    enabled: entry.enabled !== false,
    config,
    stats: {
      runs: clampNumber(entry.stats?.runs, 0, 0, 1e9),
      failures: clampNumber(entry.stats?.failures, 0, 0, 1e9),
      lastRunAt: clampNumber(entry.stats?.lastRunAt, 0, 0, 1e15),
      lastError: cleanString(entry.stats?.lastError, 800),
    },
    updatedAt: clampNumber(entry.updatedAt, Date.now(), 0, 1e15),
  };
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    plugins: {
      blender: {
        id: "blender",
        enabled: true,
        config: { ...DEFAULT_BLENDER_CONFIG },
        stats: { runs: 0, failures: 0, lastRunAt: 0, lastError: "" },
        updatedAt: Date.now(),
      },
    },
  };
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const handle = await fs.promises.open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmpPath, filePath);
  try {
    const dirHandle = await fs.promises.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is best effort (unsupported on some platforms).
  }
}

async function readAll(userDataPath) {
  const file = storeFile(userDataPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const fresh = emptyStore();
      await writeJsonAtomic(file, fresh);
      return fresh;
    }
    throw new Error(`Файл плагинов повреждён: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Файл плагинов повреждён (не является объектом).");
  }
  const defaults = emptyStore();
  const plugins = {};
  const source = parsed.plugins && typeof parsed.plugins === "object" ? parsed.plugins : {};
  for (const [id, entry] of Object.entries(source)) {
    const normalized = normalizePlugin(entry, id);
    if (normalized) plugins[normalized.id] = normalized;
  }
  for (const [id, entry] of Object.entries(defaults.plugins)) {
    if (!plugins[id]) plugins[id] = entry;
  }
  return {
    version: STORE_VERSION,
    createdAt: Number(parsed.createdAt) || defaults.createdAt,
    updatedAt: Number(parsed.updatedAt) || Date.now(),
    plugins,
  };
}

async function getPlugin(userDataPath, id) {
  const key = cleanString(id, 64);
  if (!key) throw new Error("Не указан id плагина.");
  const store = await readAll(userDataPath);
  return store.plugins[key] || null;
}

async function updatePlugin(userDataPath, id, patch = {}) {
  const key = cleanString(id, 64);
  if (!key) throw new Error("Не указан id плагина.");
  const store = await readAll(userDataPath);
  const existing = normalizePlugin(store.plugins[key] || { id: key }, key);
  if (!existing) throw new Error("Плагин не найден.");
  const mergedConfig =
    key === "blender"
      ? normalizeBlenderConfig({ ...existing.config, ...(patch.config || {}) })
      : { ...existing.config, ...(patch.config || {}) };
  const next = {
    ...existing,
    enabled: patch.enabled == null ? existing.enabled : patch.enabled !== false,
    config: mergedConfig,
    stats: { ...existing.stats, ...(patch.stats || {}) },
    updatedAt: Date.now(),
  };
  store.plugins[key] = next;
  store.updatedAt = Date.now();
  await writeJsonAtomic(storeFile(userDataPath), store);
  return next;
}

// ── Jobs ─────────────────────────────────────────────────────────────────────

function makeJobId(pluginId) {
  const prefix = cleanString(pluginId, 16).replace(/[^a-z0-9]/gi, "").toLowerCase() || "job";
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeExport(entry) {
  if (!entry || typeof entry !== "object") return null;
  const filePath = cleanString(entry.path, 4096);
  if (!filePath) return null;
  return {
    format: cleanString(entry.format, 24).toUpperCase(),
    path: filePath,
    bytes: clampNumber(entry.bytes, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeRender(entry) {
  if (!entry || typeof entry !== "object") return null;
  const filePath = cleanString(entry.path, 4096);
  if (!filePath) return null;
  return { name: cleanString(entry.name, 80) || path.basename(filePath), path: filePath };
}

function normalizeJob(entry, fallbackId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = cleanString(entry.id || fallbackId, 96);
  if (!id) return null;
  const status = ["queued", "running", "succeeded", "failed", "canceled"].includes(entry.status)
    ? entry.status
    : "queued";
  return {
    id,
    pluginId: cleanString(entry.pluginId, 48) || "blender",
    kind: cleanString(entry.kind, 32) || "scene",
    title: cleanString(entry.title, 200),
    status,
    progress: clampNumber(entry.progress, 0, 0, 100),
    stage: cleanString(entry.stage, 120),
    createdAt: Number(entry.createdAt) || Date.now(),
    startedAt: Number(entry.startedAt) || 0,
    finishedAt: Number(entry.finishedAt) || 0,
    durationMs: clampNumber(entry.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
    dir: cleanString(entry.dir, 4096),
    blendPath: cleanString(entry.blendPath, 4096),
    previewPath: cleanString(entry.previewPath, 4096),
    renders: Array.isArray(entry.renders) ? entry.renders.map(normalizeRender).filter(Boolean) : [],
    bakes: Array.isArray(entry.bakes) ? entry.bakes.map(normalizeRender).filter(Boolean) : [],
    exports: Array.isArray(entry.exports) ? entry.exports.map(normalizeExport).filter(Boolean) : [],
    logPath: cleanString(entry.logPath, 4096),
    error: cleanString(entry.error, 4000),
    warnings: Array.isArray(entry.warnings)
      ? entry.warnings.slice(0, 60).map((line) => cleanString(line, 600))
      : [],
    summary: cleanString(entry.summary, 4000),
    stats: entry.stats && typeof entry.stats === "object" ? entry.stats : {},
    blender: {
      path: cleanString(entry.blender?.path, 4096),
      version: cleanString(entry.blender?.version, 80),
      engine: cleanString(entry.blender?.engine, 32),
    },
  };
}

function jobDir(userDataPath, jobId) {
  const id = cleanString(jobId, 96);
  if (!id || /[\\/]/.test(id) || id.includes("..")) throw new Error("Некорректный id задачи.");
  return path.join(jobsRoot(userDataPath), id);
}

async function createJob(userDataPath, input = {}) {
  const id = makeJobId(input.pluginId || "blender");
  const dir = jobDir(userDataPath, id);
  await fs.promises.mkdir(dir, { recursive: true });
  const job = normalizeJob(
    {
      id,
      pluginId: input.pluginId || "blender",
      kind: input.kind || "scene",
      title: input.title || "",
      status: "queued",
      createdAt: Date.now(),
      dir,
      logPath: path.join(dir, "log.txt"),
    },
    id
  );
  await writeJsonAtomic(path.join(dir, "job.json"), job);
  return job;
}

async function updateJob(userDataPath, jobId, patch = {}) {
  const dir = jobDir(userDataPath, jobId);
  const file = path.join(dir, "job.json");
  let current = null;
  try {
    current = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    current = null;
  }
  const merged = normalizeJob({ ...(current || {}), ...(patch || {}), id: jobId }, jobId);
  if (!merged) throw new Error("Задача не найдена.");
  merged.dir = dir;
  await writeJsonAtomic(file, merged);
  return merged;
}

async function getJob(userDataPath, jobId) {
  const dir = jobDir(userDataPath, jobId);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, "job.json"), "utf8"));
    return normalizeJob(parsed, jobId);
  } catch {
    return null;
  }
}

async function listJobs(userDataPath, options = {}) {
  const root = jobsRoot(userDataPath);
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const limit = clampNumber(options.limit, 30, 1, MAX_JOBS);
  const pluginId = cleanString(options.pluginId, 48);
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (jobs.length >= MAX_JOBS * 2) break;
    const job = await getJob(userDataPath, entry.name);
    if (!job) continue;
    if (pluginId && job.pluginId !== pluginId) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jobs.slice(0, limit);
}

async function deleteJob(userDataPath, jobId) {
  const dir = jobDir(userDataPath, jobId);
  await fs.promises.rm(dir, { recursive: true, force: true });
  return { deleted: true, id: jobId };
}

/** Keep the newest `keep` finished jobs; running jobs are never pruned. */
async function pruneJobs(userDataPath, keep = MAX_JOBS) {
  const max = clampNumber(keep, MAX_JOBS, 5, MAX_JOBS);
  const jobs = await listJobs(userDataPath, { limit: MAX_JOBS });
  const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");
  const doomed = finished.slice(max);
  for (const job of doomed) {
    try {
      await deleteJob(userDataPath, job.id);
    } catch {
      /* ignore individual failures */
    }
  }
  return { removed: doomed.length, kept: Math.min(jobs.length, max) };
}

function resolveOutputDir(userDataPath, config) {
  const configured = cleanString(config?.outputDir, 4096);
  return configured || defaultOutputDir(userDataPath);
}

module.exports = {
  STORE_VERSION,
  MAX_JOBS,
  ENGINE_VALUES,
  FORMAT_VALUES,
  DEFAULT_BLENDER_CONFIG,
  pluginsRoot,
  jobsRoot,
  defaultOutputDir,
  resolveOutputDir,
  readAll,
  getPlugin,
  updatePlugin,
  createJob,
  updateJob,
  getJob,
  listJobs,
  deleteJob,
  pruneJobs,
  jobDir,
  writeJsonAtomic,
  normalizeBlenderConfig,
};
