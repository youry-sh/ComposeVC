/**
 * Local OpenAI-compatible HTTP server: /v1/*
 */

const http = require("http");
const { assertAuthorized } = require("./auth.cjs");
const { handleChatCompletions, ensureBoot } = require("./pipeline.cjs");
const { listProviders, bootstrap: bootstrapProviders } = require("./providers/registry.cjs");
const { sendJson, sendOpenAIError } = require("./sse.cjs");
const storeApi = require("./store.cjs");
const ngrokTunnel = require("./ngrokTunnel.cjs");
const usageStats = require("./usageStats.cjs");
const guard = require("./guard/index.cjs");

let server = null;
let userDataPath = null;
let logListeners = new Set();
const recentLogs = [];
const MAX_LOGS = 200;

function emitLog(entry) {
  const row = {
    ts: Date.now(),
    level: entry.level || "info",
    msg: entry.msg || "",
    ...entry,
  };
  recentLogs.push(row);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  for (const fn of logListeners) {
    try {
      fn(row);
    } catch {
      /* */
    }
  }
}

function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

function getLogs() {
  return [...recentLogs];
}

const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > MAX_REQUEST_BODY_BYTES) {
      reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let total = 0;
    let rejected = false;
    req.on("data", (c) => {
      if (rejected) return;
      total += c.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, api-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

async function getStore() {
  return storeApi.load(userDataPath);
}

function createHandler() {
  return async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // Health (no auth)
    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      let guardSnap = null;
      try {
        const st = await getStore();
        guardSnap = {
          enabled: st?.guard?.enabled !== false,
          mode: st?.guard?.mode || "scrub",
        };
      } catch {
        guardSnap = { enabled: true, mode: "scrub" };
      }
      sendJson(res, 200, {
        ok: true,
        service: "lopster-proxy",
        version: 1,
        guard: guardSnap,
      });
      return;
    }

    // Guard status (no auth — local loopback; mirrors health transparency)
    if (
      req.method === "GET" &&
      (path === "/guard" || path === "/v1/guard" || path === "/v1/guard/status")
    ) {
      try {
        const st = await getStore();
        sendJson(res, 200, guard.status(st?.guard));
      } catch (e) {
        sendJson(res, 200, guard.status(null));
      }
      return;
    }

    const store = await getStore();

    // Auth for /v1/*
    if (path.startsWith("/v1")) {
      const auth = assertAuthorized(store, req);
      if (!auth.ok) {
        sendOpenAIError(res, auth.status, auth.error.message, auth.error.type);
        return;
      }
    }

    try {
      if (req.method === "GET" && path === "/v1/models") {
        try {
          const modelsApi = require("./models.cjs");
          const data = await modelsApi.modelsForOpenAIEndpoint(userDataPath);
          sendJson(res, 200, { object: "list", data });
        } catch (e) {
          const models = buildModelsList(store);
          sendJson(res, 200, { object: "list", data: models });
        }
        return;
      }

      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = await readBody(req);
        const ac = new AbortController();
        req.on("close", () => {
          if (!res.writableEnded) ac.abort();
        });
        await handleChatCompletions({
          store,
          body,
          res,
          signal: ac.signal,
          onLog: emitLog,
          userDataPath,
        });
        return;
      }

      sendOpenAIError(res, 404, `Unknown path: ${path}`);
    } catch (e) {
      emitLog({ level: "error", msg: e.message || String(e) });
      if (!res.headersSent) {
        const status = Number(e?.statusCode) === 413 ? 413 : 500;
        sendOpenAIError(res, status, e.message || "Internal error", status === 413 ? "invalid_request_error" : "server_error");
      }
    }
  };
}

function buildModelsList(store) {
  ensureBoot();
  bootstrapProviders();
  const out = [];
  const seen = new Set();

  for (const [alias, route] of Object.entries(store.routes || {})) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    out.push({
      id: alias,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: route.providerId || "lopster",
    });
  }

  for (const c of store.connections || []) {
    if (c.enabled === false) continue;
    const id = c.defaultModel || `${c.providerId}/default`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: c.providerId,
      });
    }
    // Also expose provider/model pattern example
    const sample = `${c.providerId}/${c.defaultModel || "model"}`;
    if (!seen.has(sample)) {
      seen.add(sample);
      out.push({
        id: sample,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: c.providerId,
      });
    }
  }

  if (!out.length) {
    out.push({
      id: "openai/gpt-4o",
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "openai",
    });
  }
  return out;
}

async function start(udPath, opts = {}) {
  userDataPath = udPath;
  try {
    await usageStats.init(udPath);
  } catch {
    /* */
  }
  try {
    require("./oauth/grokFreeTracker.cjs").setUserDataPath(udPath);
  } catch {
    /* */
  }
  ensureBoot();
  bootstrapProviders();

  let store = await storeApi.load(userDataPath);
  if (opts.port != null) store.port = Number(opts.port) || store.port;
  if (opts.host) store.host = opts.host;
  store.enabled = true;
  // Remember to restart on next app launch (proxy is main-process — independent of UI tabs)
  store.autoStart = opts.autoStart !== false;
  store = await storeApi.save(userDataPath, store);

  if (!server) {
    await new Promise((resolve, reject) => {
      server = http.createServer(createHandler());
      // Support 20+ concurrent chat clients (Node default is fine; make explicit).
      try {
        server.maxHeadersCount = 0;
        if (typeof server.maxConnections === "number" || server.maxConnections == null) {
          server.maxConnections = 256;
        }
      } catch {
        /* */
      }
      server.on("error", (err) => {
        server = null;
        reject(err);
      });
      server.listen(store.port, store.host, () => {
        emitLog({
          level: "info",
          msg: `Proxy listening on http://${store.host}:${store.port}/v1 (maxConnections=${server.maxConnections || "default"})`,
        });
        resolve();
      });
    });
  }

  // Public tunnel follows proxy: only when enabled + authtoken saved
  await ngrokTunnel.startFromStore(store, { emitLog });

  return status();
}

async function stop() {
  // Always tear down public tunnel with the proxy
  try {
    await ngrokTunnel.stop({ emitLog });
  } catch {
    /* */
  }

  if (!server) {
    if (userDataPath) {
      const store = await storeApi.load(userDataPath);
      store.enabled = false;
      await storeApi.save(userDataPath, store);
    }
    return status();
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
  server = null;
  if (userDataPath) {
    const store = await storeApi.load(userDataPath);
    store.enabled = false;
    store.autoStart = false;
    await storeApi.save(userDataPath, store);
  }
  emitLog({ level: "info", msg: "Proxy stopped" });
  return status();
}

/** Resume listening if autoStart was set (call from app.whenReady). */
async function autoStartIfNeeded(udPath) {
  userDataPath = udPath;
  const store = await storeApi.load(udPath);
  if (!store.autoStart && !store.enabled) return { started: false, status: await status() };
  if (server && server.listening) return { started: true, status: await status() };
  try {
    const st = await start(udPath, { host: store.host, port: store.port, autoStart: true });
    return { started: true, status: st };
  } catch (e) {
    emitLog({ level: "error", msg: `autoStart failed: ${e.message}` });
    return { started: false, error: e.message, status: await status() };
  }
}

async function status() {
  const store = userDataPath ? await storeApi.load(userDataPath) : storeApi.defaultStore();
  const running = Boolean(server && server.listening);
  const tunnel = ngrokTunnel.status();
  let guardStatus = null;
  try {
    guardStatus = guard.status(store.guard);
  } catch {
    guardStatus = { enabled: true, mode: "scrub" };
  }
  return {
    running,
    host: store.host,
    port: store.port,
    baseUrl: `http://${store.host}:${store.port}/v1`,
    keyCount: (store.keys || []).filter((k) => k.enabled !== false).length,
    connectionCount: (store.connections || []).filter((c) => c.enabled !== false).length,
    providers: listProviders(),
    guard: {
      enabled: guardStatus.enabled !== false,
      mode: guardStatus.mode || "scrub",
      blockOn: guardStatus.blockOn || "high",
      rules: guardStatus.rules,
      stats: guardStatus.stats,
    },
    ngrok: {
      enabled: Boolean(store.ngrok?.enabled),
      running: tunnel.running,
      url: tunnel.url,
      publicBaseUrl: tunnel.publicBaseUrl,
      error: tunnel.error,
      domain: store.ngrok?.domain || "",
      region: store.ngrok?.region || "",
      hasAuthtoken: Boolean(store.ngrok?.authtoken),
    },
  };
}

function init(udPath) {
  userDataPath = udPath;
  ensureBoot();
  bootstrapProviders();
  // Register user-defined custom OpenAI-compatible providers from store
  void storeApi
    .load(udPath)
    .then((st) => {
      try {
        const { registerCustomProvidersFromStore } = require("./providers/registry.cjs");
        registerCustomProvidersFromStore(st);
      } catch {
        /* */
      }
    })
    .catch(() => {});
  // Load durable usage counters (all providers) — non-blocking
  void usageStats.init(udPath).catch(() => {});
}

/**
 * Re-apply ngrok from current store while proxy is already running
 * (e.g. after saving token/domain/enable in Settings).
 */
async function restartNgrokFromStore() {
  if (!userDataPath) return ngrokTunnel.status();
  const store = await storeApi.load(userDataPath);
  const running = Boolean(server && server.listening);
  if (!running) {
    await ngrokTunnel.stop({ emitLog });
    return ngrokTunnel.status();
  }
  return ngrokTunnel.startFromStore(store, { emitLog });
}

module.exports = {
  init,
  start,
  stop,
  status,
  autoStartIfNeeded,
  restartNgrokFromStore,
  onLog,
  getLogs,
  emitLog,
  getUserDataPath: () => userDataPath,
  ngrok: ngrokTunnel,
};
