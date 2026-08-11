/**
 * 运行时 — Runtime companion host (HTTP + BrowserWindow).
 *
 * Standalone process entry: electron/runtimeMain.cjs
 * Launch: npm run runtime  |  start-runtime.bat
 * (Not embedded in main IDE / ActivityBar.)
 *
 * Completely separate from the main renderer bundle:
 * - static files live in /runtime-app
 * - HTTP server + BrowserWindow start via start() from runtimeMain
 * - settings under Runtime userData, namespace "runtime-app"
 * - /api/* serves local JSON + CF Worker mail proxy (no main-app IPC)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { BrowserWindow } = require("electron");

const DEFAULT_PORT = 7879;
const SETTINGS_DIR = "runtime-app";
const SETTINGS_FILE = "settings.json";
const DATA_DIR = "data";
const CONFIG_FILE = "config.json";
const ADDRESSES_FILE = "cfworker_addresses.json";

/** @type {import('http').Server | null} */
let server = null;
/** @type {BrowserWindow | null} */
let win = null;
/** @type {number | null} */
let activePort = null;
/** @type {Promise<{ ok: boolean, port?: number, url?: string, error?: string, alreadyRunning?: boolean }> | null} */
let startingPromise = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function runtimeRoot() {
  return path.join(__dirname, "..", "runtime-app");
}

function dataDir() {
  return path.join(runtimeRoot(), DATA_DIR);
}

function configPath() {
  return path.join(dataDir(), CONFIG_FILE);
}

function addressesPath() {
  return path.join(dataDir(), ADDRESSES_FILE);
}

function settingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_DIR, SETTINGS_FILE);
}

async function ensureDataDir() {
  await fs.promises.mkdir(dataDir(), { recursive: true });
}

async function readSettings(userDataPath) {
  const file = settingsPath(userDataPath);
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const data = JSON.parse(raw);
    return {
      port: normalizePort(data?.port, DEFAULT_PORT),
    };
  } catch {
    return { port: DEFAULT_PORT };
  }
}

async function writeSettings(userDataPath, patch = {}) {
  const dir = path.join(userDataPath, SETTINGS_DIR);
  await fs.promises.mkdir(dir, { recursive: true });
  const current = await readSettings(userDataPath);
  const next = {
    port: normalizePort(patch.port ?? current.port, DEFAULT_PORT),
  };
  await fs.promises.writeFile(settingsPath(userDataPath), JSON.stringify(next, null, 2), "utf8");
  return next;
}

function normalizePort(value, fallback = DEFAULT_PORT) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return fallback;
  return Math.floor(n);
}

function getStatus() {
  const running = Boolean(
    server &&
      activePort &&
      win &&
      !win.isDestroyed()
  );
  return {
    running,
    starting: Boolean(startingPromise),
    port: activePort || null,
    url: activePort ? `http://127.0.0.1:${activePort}/` : null,
  };
}

function safeResolve(root, urlPath) {
  const decoded = decodeURIComponent(String(urlPath || "/").split("?")[0] || "/");
  let rel = decoded.replace(/^\/+/, "");
  if (!rel || rel.endsWith("/")) rel = path.posix.join(rel, "index.html");
  const abs = path.normalize(path.join(root, rel));
  if (!abs.startsWith(root)) return null;
  return abs;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function defaultConfig() {
  return {
    cfworker_api_url: "",
    cfworker_admin_token: "",
    cfworker_domain: "",
    cfworker_fingerprint: "",
    enable_prefix: true,
  };
}

function normalizeConfig(data = {}) {
  return {
    ...defaultConfig(),
    ...data,
    cfworker_api_url: String(data?.cfworker_api_url || "").trim(),
    cfworker_admin_token: String(data?.cfworker_admin_token || "").trim(),
    cfworker_domain: String(data?.cfworker_domain || "").trim(),
    cfworker_fingerprint: String(data?.cfworker_fingerprint || "").trim(),
    enable_prefix: data?.enable_prefix !== false,
  };
}

async function readConfigFile() {
  try {
    const raw = await fs.promises.readFile(configPath(), "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function loadConfig() {
  await ensureDataDir();
  const existing = await readConfigFile();
  if (existing) return existing;
  const cfg = defaultConfig();
  await fs.promises.writeFile(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}

async function saveConfig(patch = {}) {
  await ensureDataDir();
  const current = (await readConfigFile()) || defaultConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    cfworker_api_url: patch.cfworker_api_url ?? current.cfworker_api_url,
    cfworker_admin_token: patch.cfworker_admin_token ?? current.cfworker_admin_token,
    cfworker_domain: patch.cfworker_domain ?? current.cfworker_domain,
    cfworker_fingerprint: patch.cfworker_fingerprint ?? current.cfworker_fingerprint,
    enable_prefix: patch.enable_prefix ?? current.enable_prefix,
  });
  await fs.promises.writeFile(configPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function loadAddresses() {
  await ensureDataDir();
  try {
    const raw = await fs.promises.readFile(addressesPath(), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    if (data.length && typeof data[0] === "string") {
      return data.map((email) => ({ email: String(email).toLowerCase(), source: "auto" }));
    }
    return data
      .map((item) => ({
        email: String(item?.email || item?.address || "").trim().toLowerCase(),
        source: item?.source === "manual" ? "manual" : "auto",
        category: String(item?.category || item?.group || "").trim() || "Без категории",
        created_at: item?.created_at || null,
        token: item?.token || null,
      }))
      .filter((a) => a.email);
  } catch {
    return [];
  }
}

async function saveAddresses(list) {
  await ensureDataDir();
  const seen = new Set();
  const deduped = [];
  for (const item of list || []) {
    const email = String(item?.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    deduped.push({
      email,
      source: item?.source === "manual" ? "manual" : "auto",
      category: String(item?.category || "").trim() || "Без категории",
      created_at: item?.created_at || null,
      token: item?.token || null,
    });
  }
  await fs.promises.writeFile(addressesPath(), JSON.stringify(deduped, null, 2), "utf8");
  return deduped;
}

async function upsertAddress(email, source = "manual", extra = {}) {
  const list = await loadAddresses();
  const key = String(email || "").trim().toLowerCase();
  if (!key) return list;
  const idx = list.findIndex((a) => a.email === key);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      source: source === "manual" ? "manual" : list[idx].source || "auto",
      ...extra,
      category:
        extra.category != null
          ? String(extra.category).trim() || "Без категории"
          : list[idx].category || "Без категории",
    };
  } else {
    const { category: catExtra, ...restExtra } = extra || {};
    list.unshift({
      email: key,
      source: source === "manual" ? "manual" : "auto",
      created_at: new Date().toISOString(),
      ...restExtra,
      category: String(catExtra || extra.category || "").trim() || "Без категории",
    });
  }
  return saveAddresses(list);
}

async function removeAddress(email) {
  const key = String(email || "").trim().toLowerCase();
  const list = await loadAddresses();
  return saveAddresses(list.filter((a) => a.email !== key));
}

function workerHeaders(cfg) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-admin-auth": cfg.cfworker_admin_token || "",
  };
  if (cfg.cfworker_fingerprint) headers["x-fingerprint"] = cfg.cfworker_fingerprint;
  return headers;
}

async function workerRequest(cfg, apiPath, { method = "GET", body } = {}) {
  const base = String(cfg.cfworker_api_url || "").replace(/\/+$/, "");
  if (!base || !cfg.cfworker_admin_token) {
    const err = new Error("CF Worker не настроен: укажите API URL и Admin Token");
    err.status = 400;
    throw err;
  }
  const url = `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const res = await fetch(url, {
    method,
    headers: workerHeaders(cfg),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status >= 400) {
    const err = new Error(`CF Worker API error (${res.status}): ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (!text.trim()) return method === "POST" ? {} : [];
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchAllMails(cfg, address = "") {
  const all = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    let p = `/admin/mails?limit=${pageSize}&offset=${offset}`;
    if (address) p += `&address=${encodeURIComponent(address)}`;
    const data = await workerRequest(cfg, p);
    let mails = [];
    if (Array.isArray(data)) mails = data;
    else if (data && typeof data === "object") {
      mails = data.results || [];
      if (!mails.length && data.id != null) mails = [data];
    }
    if (!mails.length) break;
    all.push(...mails);
    if (mails.length < pageSize) break;
    offset += pageSize;
    if (offset > 5000) break;
  }
  return all;
}

function parseUrl(reqUrl) {
  try {
    return new URL(reqUrl || "/", "http://127.0.0.1");
  } catch {
    return new URL("/", "http://127.0.0.1");
  }
}

async function handleApi(req, res) {
  const url = parseUrl(req.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method || "GET").toUpperCase();

  try {
    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, service: "runtime-app" });
      return true;
    }

    if (method === "GET" && pathname === "/api/config") {
      const cfg = await loadConfig();
      sendJson(res, 200, {
        ok: true,
        config: {
          ...cfg,
          // never hide token in local runtime — user owns it; UI can mask display
          configured: Boolean(cfg.cfworker_api_url && cfg.cfworker_admin_token),
        },
      });
      return true;
    }

    if (method === "PUT" && pathname === "/api/config") {
      const body = await readBody(req);
      const cfg = await saveConfig(body || {});
      sendJson(res, 200, { ok: true, config: cfg });
      return true;
    }

    if (method === "GET" && pathname === "/api/addresses") {
      const known = await loadAddresses();
      const knownMap = new Map(known.map((a) => [a.email, a]));
      let mailAddrs = [];
      try {
        const cfg = await loadConfig();
        if (cfg.cfworker_api_url && cfg.cfworker_admin_token) {
          const mails = await fetchAllMails(cfg);
          const seen = new Set();
          for (const mail of mails) {
            const addr = String(mail?.to || "").trim().toLowerCase();
            if (addr && !seen.has(addr)) {
              seen.add(addr);
              mailAddrs.push(addr);
            }
          }
        }
      } catch {
        /* offline / misconfigured — still return local JSON */
      }
      const merged = [];
      const allSeen = new Set();
      for (const a of known) {
        if (!allSeen.has(a.email)) {
          allSeen.add(a.email);
          merged.push(a);
        }
      }
      for (const addr of mailAddrs) {
        if (!allSeen.has(addr)) {
          allSeen.add(addr);
          merged.push({
            email: addr,
            source: "auto",
            category: "Без категории",
            created_at: null,
            token: null,
          });
        }
      }
      // keep local json in sync with discovered mailboxes (auto only)
      if (mailAddrs.length) {
        const next = merged.map((a) => {
          const known = knownMap.get(a.email);
          if (!known) return a;
          return {
            ...a,
            ...known,
            category: known.category || a.category || "Без категории",
          };
        });
        await saveAddresses(next);
      }
      sendJson(res, 200, { ok: true, addresses: merged });
      return true;
    }

    if (method === "POST" && pathname === "/api/addresses") {
      const body = await readBody(req);
      const cfg = await loadConfig();
      const name =
        String(body?.name || "").trim() ||
        Math.random().toString(36).slice(2, 12);
      const domain = String(body?.domain || cfg.cfworker_domain || "").trim();
      const category = String(body?.category || "").trim() || "Без категории";
      const enablePrefix = body?.enable_prefix ?? body?.enablePrefix ?? cfg.enable_prefix !== false;
      const payload = { enablePrefix: Boolean(enablePrefix), name };
      if (domain) payload.domain = domain;
      const data = await workerRequest(cfg, "/admin/new_address", { method: "POST", body: payload });
      let newEmail = "";
      let token = null;
      if (data && typeof data === "object") {
        newEmail = String(data.email || data.address || "").trim().toLowerCase();
        token = data.token || data.jwt || null;
      }
      if (newEmail) {
        await upsertAddress(newEmail, "manual", {
          created_at: new Date().toISOString(),
          token,
          category,
        });
      }
      sendJson(res, 200, { ok: true, data, email: newEmail, category });
      return true;
    }

    const patchMatch = pathname.match(/^\/api\/addresses\/(.+)$/);
    if (method === "PATCH" && patchMatch) {
      const address = decodeURIComponent(patchMatch[1]);
      const body = await readBody(req);
      const list = await loadAddresses();
      const key = String(address || "").trim().toLowerCase();
      const idx = list.findIndex((a) => a.email === key);
      if (idx < 0) {
        // allow setting category on known-only discovery emails
        if (body && (body.category != null || body.source != null)) {
          await upsertAddress(key, body.source === "manual" ? "manual" : "auto", {
            category: body.category != null ? String(body.category).trim() || "Без категории" : "Без категории",
          });
          const updated = (await loadAddresses()).find((a) => a.email === key);
          sendJson(res, 200, { ok: true, address: updated });
          return true;
        }
        sendJson(res, 404, { ok: false, error: "Address not found" });
        return true;
      }
      if (body?.category != null) {
        list[idx].category = String(body.category).trim() || "Без категории";
      }
      if (body?.source === "manual" || body?.source === "auto") {
        list[idx].source = body.source;
      }
      await saveAddresses(list);
      sendJson(res, 200, { ok: true, address: list[idx] });
      return true;
    }

    const deleteMatch = pathname.match(/^\/api\/addresses\/(.+)$/);
    if (method === "DELETE" && deleteMatch) {
      const address = decodeURIComponent(deleteMatch[1]);
      await removeAddress(address);
      const cfg = await loadConfig();
      let remoteOk = false;
      let remoteError = null;
      try {
        await workerRequest(cfg, "/admin/delete_address", {
          method: "POST",
          body: { address },
        });
        remoteOk = true;
      } catch (e1) {
        try {
          await workerRequest(cfg, `/admin/address/${encodeURIComponent(address)}`, {
            method: "DELETE",
          });
          remoteOk = true;
        } catch (e2) {
          remoteError = String(e1?.message || e1);
        }
      }
      sendJson(res, 200, { ok: true, remoteOk, remoteError });
      return true;
    }

    if (method === "GET" && pathname === "/api/mails") {
      const address = String(url.searchParams.get("address") || "").trim();
      if (!address) {
        sendJson(res, 400, { ok: false, error: "Укажите параметр address" });
        return true;
      }
      const limit = Number(url.searchParams.get("limit") || 0);
      const offset = Number(url.searchParams.get("offset") || 0);
      const cfg = await loadConfig();
      if (!limit) {
        const mails = await fetchAllMails(cfg, address);
        sendJson(res, 200, { ok: true, mails, total: mails.length });
        return true;
      }
      const data = await workerRequest(
        cfg,
        `/admin/mails?address=${encodeURIComponent(address)}&limit=${limit}&offset=${offset}`
      );
      if (Array.isArray(data)) {
        sendJson(res, 200, { ok: true, mails: data, total: data.length });
      } else if (data && typeof data === "object") {
        sendJson(res, 200, {
          ok: true,
          mails: data.results || [],
          total: data.total ?? (data.results || []).length,
        });
      } else {
        sendJson(res, 200, { ok: true, mails: [], total: 0 });
      }
      return true;
    }

    const mailMatch = pathname.match(/^\/api\/mails\/(.+)$/);
    if (method === "GET" && mailMatch) {
      const mailId = decodeURIComponent(mailMatch[1]);
      const cfg = await loadConfig();
      const data = await workerRequest(cfg, `/admin/mails/${encodeURIComponent(mailId)}`);
      sendJson(res, 200, { ok: true, data });
      return true;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
    return true;
  } catch (error) {
    const status = Number(error?.status) || 500;
    sendJson(res, status, { ok: false, error: String(error?.message || error) });
    return true;
  }
}

function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const url = parseUrl(req.url);
        if (url.pathname.startsWith("/api/")) {
          await handleApi(req, res);
          return;
        }

        const filePath = safeResolve(rootDir, req.url || "/");
        if (!filePath) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            const indexPath = path.join(rootDir, "index.html");
            fs.readFile(indexPath, (err2, indexData) => {
              if (err2) {
                res.writeHead(404).end("Not found");
                return;
              }
              res.writeHead(200, { "Content-Type": MIME[".html"] });
              res.end(indexData);
            });
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500).end(String(e?.message || e));
      }
    })();
  });
}

function listen(serverInstance, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      serverInstance.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      serverInstance.off("error", onError);
      resolve(port);
    };
    serverInstance.once("error", onError);
    serverInstance.once("listening", onListening);
    serverInstance.listen(port, "127.0.0.1");
  });
}

async function ensureServer(preferredPort) {
  if (server && activePort) {
    return activePort;
  }
  const root = runtimeRoot();
  const indexPath = path.join(root, "index.html");
  try {
    await fs.promises.access(indexPath, fs.constants.R_OK);
  } catch {
    throw new Error(`runtime-app not found: ${indexPath}`);
  }

  const tryPorts = [
    preferredPort,
    preferredPort + 1,
    preferredPort + 2,
    preferredPort + 3,
    0, // OS ephemeral fallback
  ];

  let lastError = null;
  for (const port of tryPorts) {
    const candidate = createStaticServer(root);
    try {
      const bound = await listen(candidate, port);
      // When port=0, read actual assigned port
      const addr = candidate.address();
      const realPort = typeof addr === "object" && addr ? addr.port : bound;
      server = candidate;
      activePort = realPort;
      server.on("error", (err) => {
        console.error("[runtime-app] server error:", err?.message || err);
      });
      return realPort;
    } catch (err) {
      lastError = err;
      try {
        candidate.close();
      } catch {
        /* */
      }
      if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Could not bind runtime-app port");
}

function createRuntimeWindow(port, appIconPath) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  const next = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#000000",
    title: "运行时",
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath || undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // No preload — fully isolated from main IPC surface
      sandbox: true,
    },
  });

  next.once("ready-to-show", () => {
    if (!next.isDestroyed()) {
      next.show();
      next.focus();
    }
  });

  next.on("closed", () => {
    if (win === next) win = null;
    // Keep HTTP server warm while main app lives — cheap static server.
    // Stop only on explicit stop() / app quit.
  });

  const url = `http://127.0.0.1:${port}/`;
  void next.loadURL(url);
  win = next;
  return next;
}

/**
 * @param {{ userDataPath: string, appIconPath?: string|null }} opts
 */
async function start(opts = {}) {
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    try {
      const status = getStatus();
      if (status.running) {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        return {
          ok: true,
          alreadyRunning: true,
          port: status.port,
          url: status.url,
        };
      }

      const userDataPath = opts.userDataPath;
      if (!userDataPath) throw new Error("userDataPath required");

      const settings = await readSettings(userDataPath);
      const port = await ensureServer(settings.port);

      // Persist actual bound port (may differ if preferred was busy)
      if (port !== settings.port) {
        await writeSettings(userDataPath, { port });
      }

      createRuntimeWindow(port, opts.appIconPath || null);

      return {
        ok: true,
        alreadyRunning: false,
        port,
        url: `http://127.0.0.1:${port}/`,
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    } finally {
      startingPromise = null;
    }
  })();

  return startingPromise;
}

function focus() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return { ok: true, focused: true, ...getStatus() };
  }
  return { ok: false, focused: false, ...getStatus() };
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) {
      activePort = null;
      resolve();
      return;
    }
    const s = server;
    server = null;
    activePort = null;
    try {
      s.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function stop() {
  if (win && !win.isDestroyed()) {
    try {
      win.close();
    } catch {
      /* */
    }
  }
  win = null;
  await stopServer();
  return { ok: true, running: false };
}

/** Graceful shutdown for app before-quit */
function disposeSync() {
  try {
    if (win && !win.isDestroyed()) win.destroy();
  } catch {
    /* */
  }
  win = null;
  if (server) {
    try {
      server.close();
    } catch {
      /* */
    }
  }
  server = null;
  activePort = null;
  startingPromise = null;
}

module.exports = {
  DEFAULT_PORT,
  start,
  stop,
  focus,
  getStatus,
  readSettings,
  writeSettings,
  disposeSync,
};
