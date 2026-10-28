const fs = require("fs");
const { statePath, ensureSetupDir, writeJson } = require("./paths.cjs");
const { COMPONENTS, platforms } = require("./registry.cjs");

/**
 * Persisted Setup tab state — <userData>/setup/state.json, schema v1.
 *
 * Same discipline as electron/usageStore.cjs: aggressive normalization on
 * read, debounced atomic flush, and a corrupt file is moved aside instead of
 * being overwritten in place.
 *
 * Shape:
 *   { version: 1, updatedAt, platform, components: { [id]: {...} }, ui: {...} }
 */

const SCHEMA_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 1000;
const MAX_VERSION_LEN = 64;
const MAX_PATH_LEN = 4096;
const MAX_METHOD_LEN = 80;
const MAX_ERROR_LEN = 600;
const GROUPS = ["runtime", "tool", "3d", "search"];
const KNOWN_IDS = new Set(COMPONENTS.map((component) => component.id));
const KNOWN_PLATFORMS = new Set(platforms);

let current = null;

function now() {
  return Date.now();
}

function emptyState() {
  return {
    version: SCHEMA_VERSION,
    updatedAt: now(),
    platform: "",
    components: {},
    ui: { collapsedGroups: [] },
  };
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function normalizeEntry(raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  return {
    installed: entry.installed === true,
    version: text(entry.version, MAX_VERSION_LEN),
    path: text(entry.path, MAX_PATH_LEN),
    method: text(entry.method, MAX_METHOD_LEN),
    lastCheckAt: Number.isFinite(entry.lastCheckAt) && entry.lastCheckAt > 0 ? Math.floor(entry.lastCheckAt) : 0,
    lastError: text(entry.lastError, MAX_ERROR_LEN),
  };
}

function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;

  state.platform = KNOWN_PLATFORMS.has(raw.platform) ? raw.platform : "";
  state.updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? Math.floor(raw.updatedAt) : now();

  if (raw.components && typeof raw.components === "object") {
    for (const [id, entry] of Object.entries(raw.components)) {
      if (!KNOWN_IDS.has(id)) continue;
      state.components[id] = normalizeEntry(entry);
    }
  }

  if (raw.ui && typeof raw.ui === "object" && Array.isArray(raw.ui.collapsedGroups)) {
    state.ui.collapsedGroups = raw.ui.collapsedGroups.filter(
      (group) => typeof group === "string" && GROUPS.includes(group)
    );
  }

  state.version = SCHEMA_VERSION;
  return state;
}

function fileFor(userDataPath) {
  return statePath(userDataPath);
}

function load(userDataPath) {
  const file = fileFor(userDataPath);
  ensureSetupDir(userDataPath);
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      current = { file, state: emptyState(), dirty: false, timer: null };
      return current;
    }
    // Broken file: move it aside, never truncate it in place.
    const backup = `${file}.corrupt-${Date.now()}.bak`;
    try {
      fs.renameSync(file, backup);
    } catch {
      try {
        fs.copyFileSync(file, backup);
        fs.unlinkSync(file);
      } catch {
        /* nothing else we can do — start from a clean state */
      }
    }
    console.error("[setup] corrupt state backed up", {
      event: "setup_state_corrupt",
      path: file,
      backup,
      error: error instanceof Error ? error.message : String(error),
    });
    raw = null;
  }
  current = { file, state: normalize(raw), dirty: false, timer: null };
  return current;
}

function ensure(userDataPath) {
  const file = fileFor(userDataPath);
  if (current && current.file === file) return current;
  return load(userDataPath);
}

function flushSync(userDataPath) {
  const holder = ensure(userDataPath);
  if (!holder.dirty) return;
  if (holder.timer) {
    clearTimeout(holder.timer);
    holder.timer = null;
  }
  try {
    writeJson(holder.file, holder.state);
    holder.dirty = false;
  } catch (error) {
    console.error("[setup] state flush failed", error instanceof Error ? error.message : error);
  }
}

function scheduleFlush(userDataPath) {
  const holder = ensure(userDataPath);
  if (holder.timer) clearTimeout(holder.timer);
  holder.timer = setTimeout(() => {
    holder.timer = null;
    flushSync(userDataPath);
  }, FLUSH_DEBOUNCE_MS);
  if (holder.timer && typeof holder.timer.unref === "function") holder.timer.unref();
}

function mutate(userDataPath, fn) {
  const holder = ensure(userDataPath);
  fn(holder.state);
  holder.state.updatedAt = now();
  holder.state.version = SCHEMA_VERSION;
  holder.dirty = true;
  scheduleFlush(userDataPath);
  return holder.state;
}

function read(userDataPath) {
  const holder = ensure(userDataPath);
  return JSON.parse(JSON.stringify(holder.state));
}

/** Merge a fresh detection pass into the store and persist it. */
function mergeDetection(userDataPath, plat, results) {
  const list = Array.isArray(results) ? results : [];
  mutate(userDataPath, (state) => {
    state.platform = KNOWN_PLATFORMS.has(plat) ? plat : state.platform;
    for (const result of list) {
      if (!result || !KNOWN_IDS.has(result.id)) continue;
      const previous = state.components[result.id] || normalizeEntry(null);
      state.components[result.id] = {
        installed: result.installed === true,
        version: result.installed ? text(result.version, MAX_VERSION_LEN) : null,
        path: result.installed ? text(result.path, MAX_PATH_LEN) : null,
        method: previous.method,
        lastCheckAt: now(),
        lastError: result.installed
          ? null
          : text(result.error, MAX_ERROR_LEN) ||
            (previous.lastError && previous.lastError !== "Установка отменена" ? previous.lastError : null),
      };
    }
  });
  return read(userDataPath);
}

function setComponent(userDataPath, id, patch) {
  if (!KNOWN_IDS.has(id)) return read(userDataPath);
  const next = patch && typeof patch === "object" ? patch : {};
  mutate(userDataPath, (state) => {
    const previous = state.components[id] || normalizeEntry(null);
    state.components[id] = normalizeEntry({ ...previous, ...next, lastCheckAt: next.lastCheckAt || now() });
  });
  return read(userDataPath);
}

function setCollapsedGroups(userDataPath, groups) {
  const list = Array.isArray(groups) ? groups : [];
  mutate(userDataPath, (state) => {
    state.ui.collapsedGroups = [...new Set(list.filter((group) => GROUPS.includes(group)))];
  });
  return read(userDataPath);
}

module.exports = {
  SCHEMA_VERSION,
  read,
  mergeDetection,
  setComponent,
  setCollapsedGroups,
  flushSync,
  normalize,
};
