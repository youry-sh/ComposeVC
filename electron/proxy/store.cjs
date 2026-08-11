/**
 * Proxy config store: userData/proxy/store.json
 *
 * Hardened against concurrent writers and corrupt JSON:
 * - single-process mutex (promise chain)
 * - atomic write (tmp + rename)
 * - rolling .bak before overwrite
 * - auto-recover from .bak* when main file is unreadable
 * - refuse to wipe non-empty accounts with an empty payload
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { withFileLock } = require("./storeLock.cjs");

const DIR = "proxy";
const FILE = "store.json";
const MAX_BACKUPS = 8;

function defaultNgrok() {
  return {
    /** When true, start public ngrok tunnel whenever proxy is running */
    enabled: false,
    /** ngrok authtoken from dashboard (user pastes; persisted in userData) */
    authtoken: "",
    /** Optional reserved domain, e.g. my-proxy.ngrok.app */
    domain: "",
    /** Optional region, e.g. us, eu, ap, au, sa, jp, in */
    region: "",
  };
}

/** Lopster Guard — OFF by default (malicious provider injection scanner; heavy, opt-in). */
function defaultGuard() {
  return {
    /** Master switch — true = scan every chat completion */
    enabled: false,
    /**
     * scrub = cut dangerous fragments, never abort stream (default)
     * block = stop response on hit
     * alert = log only
     * off = disabled
     */
    mode: "scrub",
    /** high | medium | any — severity threshold for block mode */
    blockOn: "high",
    /** high | medium | any — severity threshold for scrub mode */
    scrubOn: "high",
    /** Tool calls when client declared no tools → high severity */
    unsolicitedTools: true,
    /** Scan reasoning / thinking / oversized signatures */
    scanThinking: true,
    maxFindings: 32,
    scrubReplacement: "«removed by Lopster Guard»",
  };
}

function normalizeGuard(raw) {
  const base = defaultGuard();
  if (!raw || typeof raw !== "object") return { ...base };

  // Pre-scrub stores only knew block|alert|off and forced "block" by default.
  // Without an explicit scrubOn field they were the old schema → promote to scrub
  // so ordinary tool use is not aborted mid-stream. Intentional block still works
  // when the user (or UI) sets mode:"block" together with scrubOn (new schema).
  let modeRaw = String(raw.mode != null ? raw.mode : base.mode).toLowerCase().trim();
  const oldSchema = raw.scrubOn == null && raw.scrubReplacement == null;
  if (oldSchema && modeRaw === "block") {
    modeRaw = "scrub";
  }

  const mode =
    modeRaw === "block" || modeRaw === "alert" || modeRaw === "off" || modeRaw === "scrub"
      ? modeRaw
      : base.mode;
  const blockOn = String(raw.blockOn || base.blockOn).toLowerCase();
  const scrubOn = String(
    raw.scrubOn != null ? raw.scrubOn : raw.blockOn != null ? raw.blockOn : base.scrubOn
  ).toLowerCase();
  return {
    // Guard is OFF by default; only an explicit true enables it (heavy scanner).
    // LOPSTER_GUARD_DISABLED=1 forces it off even when the store says on.
    enabled:
      process.env.LOPSTER_GUARD_DISABLED === "1" ? false : raw.enabled === true && mode !== "off",
    mode,
    blockOn: blockOn === "medium" || blockOn === "any" ? blockOn : "high",
    scrubOn: scrubOn === "medium" || scrubOn === "any" ? scrubOn : "high",
    unsolicitedTools: raw.unsolicitedTools !== false,
    scanThinking: raw.scanThinking !== false,
    maxFindings: Math.max(1, Math.min(200, Number(raw.maxFindings) || base.maxFindings)),
    scrubReplacement:
      raw.scrubReplacement != null ? String(raw.scrubReplacement) : base.scrubReplacement,
  };
}

function defaultStore() {
  return {
    version: 3,
    host: "127.0.0.1",
    port: 8787,
    /** Proxy currently listening (runtime also tracked in server) */
    enabled: false,
    /** If true, main process restarts proxy on app launch (works on any UI tab) */
    autoStart: false,
    keys: [],
    routes: {},
    /** Legacy API-key connections (still supported) */
    connections: [],
    /**
     * Unified provider accounts (oauth + apikey)
     * { id, providerId, authType, name, email, planType, workspaceId,
     *   accessToken, refreshToken, idToken, expiresAt, apiKey, baseUrl,
     *   defaultModel, enabled, usage, usageError, usageUpdatedAt, createdAt }
     */
    accounts: [],
    /** Manual models: { [providerId]: [{ id, kind, owned_by, created }] } */
    customModels: {},
    /**
     * User-defined OpenAI-compatible providers (dynamic registry modules).
     * { id, name, baseUrl, modelTag?, description?, createdAt }
     * API keys live in accounts[] with providerId = this id (rotation as usual).
     */
    customProviders: [],
    /** Public tunnel via ngrok (tokens stay in userData store.json) */
    ngrok: defaultNgrok(),
    /**
     * Malicious-provider injection guard (ON by default).
     * Scans model text + tool_call args for download-exec / persistence / exfil / IOC.
     */
    guard: defaultGuard(),
    updatedAt: Date.now(),
  };
}

function normalizeNgrok(raw) {
  const base = defaultNgrok();
  if (!raw || typeof raw !== "object") return base;
  return {
    enabled: Boolean(raw.enabled),
    authtoken: String(raw.authtoken || ""),
    domain: String(raw.domain || "").trim(),
    region: String(raw.region || "").trim(),
  };
}

function storePath(userDataPath) {
  return path.join(userDataPath, DIR, FILE);
}

function storeDir(userDataPath) {
  return path.join(userDataPath, DIR);
}

async function ensure(userDataPath) {
  const dir = storeDir(userDataPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = storePath(userDataPath);
  try {
    await fs.promises.access(file);
  } catch {
    await atomicWrite(file, JSON.stringify(defaultStore(), null, 2));
  }
  return file;
}

/** Promise-chain mutex: serializes all load/save/merge that touch the file. */
let _writeChain = Promise.resolve();
function withStoreLock(fn) {
  const run = _writeChain.then(() => fn());
  // Keep chain alive even if fn rejects
  _writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const _lastAccountCount = { value: 0 };
const _lastKeysCount = { value: 0 };

/**
 * Atomic write: write to .tmp then rename over target.
 * On Windows rename over existing may fail — fallback to copy+unlink.
 */
async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now().toString(16)}.tmp`
  );
  try {
    await fs.promises.writeFile(tmp, text, "utf8");
    try {
      await fs.promises.rename(tmp, file);
    } catch (renameErr) {
      // Windows: target exists → replace via copyFile then remove tmp
      try {
        await fs.promises.copyFile(tmp, file);
        await fs.promises.unlink(tmp).catch(() => {});
      } catch (copyErr) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw copyErr || renameErr;
      }
    }
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

async function listBackupFiles(userDataPath) {
  const dir = storeDir(userDataPath);
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (name === FILE) continue;
    // store.json.bak, store.json.bak-<ts>, store.json.bak-*-*
    if (name === `${FILE}.bak` || name.startsWith(`${FILE}.bak`)) {
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && st.size > 2) {
          files.push({ name, full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
        /* */
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files;
}

async function pruneBackups(userDataPath) {
  const files = await listBackupFiles(userDataPath);
  // Keep newest MAX_BACKUPS auto backups (store.json.bak-<digits>); never delete named snapshots
  const auto = files.filter((f) => /^store\.json\.bak-\d+$/.test(f.name));
  for (const f of auto.slice(MAX_BACKUPS)) {
    await fs.promises.unlink(f.full).catch(() => {});
  }
}

/**
 * Snapshot current main file as a timestamped bak (previous generation).
 * Used before overwrite so history is preserved.
 */
async function backupCurrent(userDataPath) {
  const file = storePath(userDataPath);
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile() || st.size < 3) return;
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed = parseStoreText(raw);
    // Skip snapshotting empty shells — they pollute recovery ranking
    const acc = (parsed.accounts || []).length;
    const keys = (parsed.keys || []).length;
    if (acc === 0 && keys === 0) return;
    const bak = path.join(storeDir(userDataPath), `${FILE}.bak-${Date.now()}`);
    await fs.promises.writeFile(bak, raw, "utf8");
    await pruneBackups(userDataPath);
  } catch {
    /* corrupt or missing — skip */
  }
}

/** Always keep store.json.bak as the last successfully written good payload. */
async function writeLastGoodBackup(userDataPath, text) {
  try {
    const bak = path.join(storeDir(userDataPath), `${FILE}.bak`);
    await fs.promises.writeFile(bak, text, "utf8");
  } catch (e) {
    console.error("store: failed to write last-good backup:", e?.message || e);
  }
}

function storeRichness(store) {
  return (
    (store.accounts || []).length * 1000 +
    (store.keys || []).length * 100 +
    (Array.isArray(store.customProviders) ? store.customProviders.length : 0) * 10 +
    (store.customModels && typeof store.customModels === "object"
      ? Object.keys(store.customModels).length
      : 0)
  );
}

/**
 * Normalize raw JSON object into a full store shape.
 * Returns null if data is not a plain object.
 */
function normalizeStore(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const base = defaultStore();
  const store = {
    ...base,
    ...data,
    keys: Array.isArray(data.keys) ? data.keys : [],
    routes: data.routes && typeof data.routes === "object" && !Array.isArray(data.routes) ? data.routes : {},
    connections: Array.isArray(data.connections) ? data.connections : [],
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    customModels:
      data.customModels && typeof data.customModels === "object" && !Array.isArray(data.customModels)
        ? data.customModels
        : {},
    customProviders: Array.isArray(data.customProviders) ? data.customProviders : [],
    autoStart: Boolean(data.autoStart),
    enabled: Boolean(data.enabled),
    host: String(data.host || base.host).trim() || base.host,
    port: Math.max(1, Math.min(65535, Number(data.port) || base.port)),
    ngrok: normalizeNgrok(data.ngrok),
    // Guard always present; missing field → defaults ON
    guard: normalizeGuard(data.guard),
    version: Number(data.version) || base.version,
    updatedAt: Number(data.updatedAt) || Date.now(),
  };

  // Migrate legacy connections → accounts once
  if (!store.accounts.length && store.connections.length) {
    store.accounts = store.connections.map((c) => ({
      id: c.id || newId("acc"),
      providerId: c.providerId,
      authType: "apikey",
      name: c.name || c.providerId,
      email: null,
      planType: null,
      workspaceId: null,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
      apiKey: c.apiKey || "",
      baseUrl: c.baseUrl || "",
      defaultModel: c.defaultModel || "",
      enabled: c.enabled !== false,
      usage: null,
      usageUpdatedAt: null,
      createdAt: c.createdAt || Date.now(),
    }));
  }

  return store;
}

function parseStoreText(raw) {
  if (raw == null) throw new Error("empty store");
  const text = String(raw).replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("empty store");
  // Guard against accidental JS source dumps (e.g. updatedAt: Date.now())
  if (/\bDate\.now\s*\(/.test(text) || /\bundefined\b/.test(text) || /\bfunction\b/.test(text)) {
    throw new Error("store looks like JS source, not JSON");
  }
  const data = JSON.parse(text);
  const store = normalizeStore(data);
  if (!store) throw new Error("store root is not an object");
  return store;
}

async function tryReadStoreFile(file) {
  const raw = await fs.promises.readFile(file, "utf8");
  return parseStoreText(raw);
}

/**
 * Try main store.json, then best valid backup (richest data, then newest).
 */
async function loadFromDisk(userDataPath) {
  const main = storePath(userDataPath);
  let mainErr = null;
  try {
    return await tryReadStoreFile(main);
  } catch (e) {
    mainErr = e;
  }

  const backups = await listBackupFiles(userDataPath);
  // Prefer store.json.bak (last good) first, then rank all by richness
  const candidates = [];
  for (const bak of backups) {
    try {
      const store = await tryReadStoreFile(bak.full);
      candidates.push({
        bak,
        store,
        richness: storeRichness(store),
        // boost last-good name slightly over older timestamped empties
        nameBoost: bak.name === `${FILE}.bak` ? 1 : 0,
      });
    } catch {
      /* unreadable backup */
    }
  }
  candidates.sort((a, b) => {
    if (b.richness !== a.richness) return b.richness - a.richness;
    if (b.nameBoost !== a.nameBoost) return b.nameBoost - a.nameBoost;
    return b.bak.mtimeMs - a.bak.mtimeMs;
  });

  if (candidates.length) {
    const best = candidates[0];
    console.error(
      `store.load: recovered from backup ${best.bak.name} (richness=${best.richness}; main error: ${
        mainErr?.message || mainErr
      })`
    );
    try {
      const text = JSON.stringify(best.store, null, 2);
      await atomicWrite(main, text);
      await writeLastGoodBackup(userDataPath, text);
    } catch (writeErr) {
      console.error("store.load: failed to rewrite recovered store:", writeErr?.message || writeErr);
    }
    return best.store;
  }

  throw mainErr || new Error("no readable store or backup");
}

async function load(userDataPath) {
  return withStoreLock(async () => {
    await ensure(userDataPath);
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const store = await withFileLock(storePath(userDataPath), () =>
          loadFromDisk(userDataPath)
        );
        _lastAccountCount.value = (store.accounts || []).length;
        _lastKeysCount.value = (store.keys || []).length;
        return store;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
      }
    }
    console.error(
      "store.load: failed after retries + backups, returning defaultStore:",
      lastErr?.message || lastErr
    );
    // Do NOT reset counters to 0 — keep last known so save() still refuses wipe
    return defaultStore();
  });
}

/**
 * Protect against accidental wipe when callers pass empty accounts after a failed load.
 * Also re-read disk if counters say we should have data.
 */
async function protectAgainstWipe(userDataPath, next) {
  const emptyAccounts = !next.accounts || next.accounts.length === 0;
  const emptyKeys = !next.keys || next.keys.length === 0;

  if (emptyAccounts && _lastAccountCount.value > 0) {
    console.error(
      `store.save: refusing empty accounts (had ${_lastAccountCount.value}) — merging from disk`
    );
    try {
      const existing = await tryReadStoreFile(storePath(userDataPath));
      if (existing.accounts && existing.accounts.length > 0) {
        next.accounts = existing.accounts;
      }
    } catch {
      /* try backup */
      try {
        const recovered = await loadFromDisk(userDataPath);
        if (recovered.accounts && recovered.accounts.length > 0) {
          next.accounts = recovered.accounts;
        }
      } catch {
        /* */
      }
    }
  }

  if (emptyKeys && _lastKeysCount.value > 0 && (!next.keys || next.keys.length === 0)) {
    try {
      const existing = await tryReadStoreFile(storePath(userDataPath));
      if (existing.keys && existing.keys.length > 0) {
        next.keys = existing.keys;
      }
    } catch {
      /* */
    }
  }

  // If still empty but disk has data and caller had zero memory of it (process just started
  // after corrupt load → defaultStore), still refuse to overwrite a non-empty file with empty.
  if ((!next.accounts || next.accounts.length === 0) && (!next.keys || next.keys.length === 0)) {
    try {
      const existing = await tryReadStoreFile(storePath(userDataPath));
      const diskAcc = (existing.accounts || []).length;
      const diskKeys = (existing.keys || []).length;
      if (diskAcc > 0 || diskKeys > 0) {
        console.error(
          `store.save: refusing to overwrite disk store (accounts=${diskAcc}, keys=${diskKeys}) with empty payload`
        );
        if (diskAcc > 0) next.accounts = existing.accounts;
        if (diskKeys > 0) next.keys = existing.keys;
        if (existing.routes && Object.keys(existing.routes).length && (!next.routes || !Object.keys(next.routes).length)) {
          next.routes = existing.routes;
        }
        if (Array.isArray(existing.customProviders) && existing.customProviders.length && !next.customProviders?.length) {
          next.customProviders = existing.customProviders;
        }
        if (
          existing.customModels &&
          Object.keys(existing.customModels).length &&
          (!next.customModels || !Object.keys(next.customModels).length)
        ) {
          next.customModels = existing.customModels;
        }
        if (existing.ngrok && !next.ngrok?.authtoken && existing.ngrok.authtoken) {
          next.ngrok = normalizeNgrok(existing.ngrok);
        }
      }
    } catch {
      /* disk corrupt — allow write (maybe recovery rewrite) */
    }
  }

  return next;
}

async function save(userDataPath, store) {
  return withStoreLock(async () => {
    await ensure(userDataPath);
    let next = {
      ...defaultStore(),
      ...store,
      keys: Array.isArray(store?.keys) ? store.keys : [],
      routes: store?.routes && typeof store.routes === "object" ? store.routes : {},
      connections: Array.isArray(store?.connections) ? store.connections : [],
      accounts: Array.isArray(store?.accounts) ? store.accounts : [],
      customModels:
        store?.customModels && typeof store.customModels === "object" ? store.customModels : {},
      customProviders: Array.isArray(store?.customProviders) ? store.customProviders : [],
      ngrok: normalizeNgrok(store?.ngrok),
      guard: normalizeGuard(store?.guard),
      updatedAt: Date.now(),
    };

    return withFileLock(storePath(userDataPath), async () => {
      next = await protectAgainstWipe(userDataPath, next);

      _lastAccountCount.value = (next.accounts || []).length;
      _lastKeysCount.value = (next.keys || []).length;

      await backupCurrent(userDataPath);
      const text = JSON.stringify(next, null, 2);
      // Sanity: never write non-JSON / JS source
      if (/\bDate\.now\s*\(/.test(text)) {
        throw new Error("store.save: refused to write invalid payload containing Date.now()");
      }
      await atomicWrite(storePath(userDataPath), text);
      await writeLastGoodBackup(userDataPath, text);
      return next;
    });
  });
}

/**
 * Atomically merge one account into the store (load → patch → save under mutex).
 * Safe for parallel usage refresh workers — no lost updates across concurrent saves.
 */
async function mergeAccount(userDataPath, accountId, patch = {}) {
  return withStoreLock(async () => {
    await ensure(userDataPath);
    return withFileLock(storePath(userDataPath), async () => {
      let store;
      try {
        store = await loadFromDisk(userDataPath);
      } catch {
        store = defaultStore();
      }
      const idx = (store.accounts || []).findIndex((a) => a.id === accountId);
      if (idx < 0) {
        return { ok: false, error: "account not found" };
      }
      const merged = {
        ...store.accounts[idx],
        ...(patch && typeof patch === "object" ? patch : {}),
        id: accountId,
      };
      store.accounts[idx] = merged;
      let next = {
        ...defaultStore(),
        ...store,
        keys: Array.isArray(store.keys) ? store.keys : [],
        routes: store.routes && typeof store.routes === "object" ? store.routes : {},
        connections: Array.isArray(store.connections) ? store.connections : [],
        accounts: Array.isArray(store.accounts) ? store.accounts : [],
        customModels:
          store.customModels && typeof store.customModels === "object" ? store.customModels : {},
        customProviders: Array.isArray(store.customProviders) ? store.customProviders : [],
        ngrok: normalizeNgrok(store.ngrok),
        guard: normalizeGuard(store.guard),
        updatedAt: Date.now(),
      };

      next = await protectAgainstWipe(userDataPath, next);
      _lastAccountCount.value = (next.accounts || []).length;
      _lastKeysCount.value = (next.keys || []).length;

      await backupCurrent(userDataPath);
      const text = JSON.stringify(next, null, 2);
      await atomicWrite(storePath(userDataPath), text);
      await writeLastGoodBackup(userDataPath, text);
      return { ok: true, account: merged, store: next };
    });
  });
}

function newId(prefix = "id") {
  return `${prefix}_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
}

function newKeyRecord(label = "") {
  const secret = `sk-${crypto.randomBytes(24).toString("hex")}`;
  return {
    id: newId("key"),
    key: secret,
    label: String(label || "default").slice(0, 64),
    createdAt: Date.now(),
    enabled: true,
  };
}

function maskKey(key) {
  const s = String(key || "");
  if (s.length <= 10) return "sk-…";
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}

function publicAccount(a) {
  let routing = a.routing || null;
  try {
    const accountRouter = require("./routing/accountRouter.cjs");
    // Live runtime status (auto-unblocks when timer elapses)
    if (a.id) {
      accountRouter.hydrateFromAccount(a);
      routing = accountRouter.getStatus(a.id);
    }
  } catch {
    /* */
  }
  return {
    id: a.id,
    providerId: a.providerId,
    authType: a.authType || "apikey",
    name: a.name || a.email || a.providerId,
    email: a.email || null,
    planType: a.planType || null,
    workspaceId: a.workspaceId || null,
    projectId: a.providerMeta?.projectId || a.workspaceId || null,
    enabled: a.enabled !== false,
    hasCredentials: Boolean(a.accessToken || a.apiKey),
    apiKeyMasked: a.apiKey ? maskKey(a.apiKey) : "",
    baseUrl: a.baseUrl || "",
    defaultModel: a.defaultModel || "",
    expiresAt: a.expiresAt || null,
    usage: a.usage || null,
    usageError: a.usageError || null,
    usageUpdatedAt: a.usageUpdatedAt || null,
    routing,
    priority: a.priority != null ? a.priority : null,
    createdAt: a.createdAt,
  };
}

function publicView(store) {
  const ngrok = normalizeNgrok(store.ngrok);
  return {
    host: store.host,
    port: store.port,
    enabled: store.enabled,
    baseUrl: `http://${store.host}:${store.port}/v1`,
    keys: (store.keys || []).map((k) => ({
      id: k.id,
      label: k.label,
      key: k.key,
      masked: maskKey(k.key),
      enabled: k.enabled !== false,
      createdAt: k.createdAt,
    })),
    routes: store.routes || {},
    connections: (store.connections || []).map((c) => ({
      id: c.id,
      providerId: c.providerId,
      name: c.name,
      baseUrl: c.baseUrl,
      enabled: c.enabled !== false,
      hasApiKey: Boolean(c.apiKey),
      apiKeyMasked: c.apiKey ? maskKey(c.apiKey) : "",
    })),
    accounts: (store.accounts || []).map(publicAccount),
    customModels: store.customModels || {},
    customProviders: Array.isArray(store.customProviders)
      ? store.customProviders.map((p) => ({
          id: p.id,
          name: p.name || p.id,
          baseUrl: p.baseUrl || "",
          modelTag: p.modelTag || p.id,
          description: p.description || "",
          createdAt: p.createdAt || null,
        }))
      : [],
    autoStart: Boolean(store.autoStart),
    ngrok: {
      enabled: ngrok.enabled,
      // Full token is needed in UI so user can edit/save — only lives in local userData
      authtoken: ngrok.authtoken,
      authtokenMasked: ngrok.authtoken ? maskKey(ngrok.authtoken) : "",
      hasAuthtoken: Boolean(ngrok.authtoken),
      domain: ngrok.domain,
      region: ngrok.region,
    },
    guard: normalizeGuard(store.guard),
    updatedAt: store.updatedAt,
  };
}

module.exports = {
  defaultStore,
  defaultNgrok,
  defaultGuard,
  normalizeNgrok,
  normalizeGuard,
  load,
  save,
  mergeAccount,
  newKeyRecord,
  newId,
  maskKey,
  publicView,
  publicAccount,
};
