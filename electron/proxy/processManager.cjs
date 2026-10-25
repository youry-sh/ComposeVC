/**
 * Proxy gateway process manager (Electron main process side).
 *
 * The actual proxy (HTTP endpoint + SSE pipeline + guard + ngrok + quota and
 * health workers) runs in a SEPARATE child process — electron/proxy/standalone.cjs —
 * so heavy streaming and log volume can never freeze or crash the app.
 *
 * This module only:
 *  - spawns / stops the child,
 *  - relays its JSON log lines to the app (bounded ring buffer),
 *  - forwards control commands (status, ngrok-restart, guard-status, …) over the
 *    child channel (MessagePort for Electron utility processes, stdin otherwise),
 *  - forwards usage records (the app process is the single disk writer of
 *    usage-stats.json; the child records into the parent via the pipe),
 *  - auto-restarts the child a bounded number of times after a crash.
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

/**
 * Electron `utilityProcess` is only available in the app's main process (it is
 * absent when this module is required from plain node — tests, CLI tools).
 * Packaged builds flip the RunAsNode fuse off, so `process.execPath` can no
 * longer act as a plain node binary: the proxy child MUST be an Electron
 * utility process there. Both transports are supported below.
 */
let utilityProcess = null;
try {
  // eslint-disable-next-line global-require
  const electronApi = require("electron");
  if (electronApi && typeof electronApi.utilityProcess?.fork === "function") {
    utilityProcess = electronApi.utilityProcess;
  }
} catch {
  /* plain node — no Electron runtime */
}

const MAX_LOGS = 200;
const START_TIMEOUT_MS = 20000;
const STOP_TIMEOUT_MS = 5000;
const CMD_TIMEOUT_MS = 8000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;

let child = null;
let transport = "stdio"; // "stdio" = child_process pipes | "port" = Electron utility process
let userDataPath = null;
let state = "idle"; // idle | starting | running | external | stopping
let statusCache = null;
let startResolve = null;
let startReject = null;
let startTimer = null;
let exitPromise = null;
let stopRequested = false;
let crashCount = 0;
let crashWindowStart = 0;
let cmdSeq = 0;
const pending = new Map();
const recentLogs = [];
const logListeners = new Set();
const usageListeners = new Set();
let stdoutBuf = "";

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function normalizeEntry(entry) {
  const row = entry && typeof entry === "object" ? entry : { msg: entry };
  return {
    ts: Number(row.ts) || Date.now(),
    level: row.level || "info",
    msg: row.msg || "",
    ...row,
  };
}

function pushLog(entry) {
  const row = normalizeEntry(entry);
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

function getLogs() {
  return [...recentLogs];
}

function onLog(fn) {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

function onUsageRecord(fn) {
  usageListeners.add(fn);
  return () => usageListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// External proxy detection (desktop launcher mode)
// ---------------------------------------------------------------------------

function probeHealth(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        /* */
      }
      resolve(false);
    });
  });
}

/** Store-derived status (mirrors server.status() shape) used when the child is not ours. */
async function buildStoreStatus(running, external, hostOverride, portOverride) {
  let providers = [];
  try {
    const reg = require("./providers/registry.cjs");
    reg.bootstrap();
    providers = reg.listProviders();
  } catch {
    /* */
  }
  try {
    const storeApi = require("./store.cjs");
    const store = userDataPath ? await storeApi.load(userDataPath) : storeApi.defaultStore();
    const host = hostOverride || store.host || "127.0.0.1";
    const port = portOverride || store.port || 8787;
    return {
      running: Boolean(running),
      external: Boolean(external),
      host,
      port,
      baseUrl: `http://${host}:${port}/v1`,
      keyCount: (store.keys || []).filter((k) => k.enabled !== false).length,
      connectionCount: (store.connections || []).filter((c) => c.enabled !== false).length,
      providers,
      guard: {
        enabled: (store.guard && store.guard.enabled) !== false,
        mode: (store.guard && store.guard.mode) || "scrub",
        blockOn: (store.guard && store.guard.blockOn) || "high",
      },
      ngrok: {
        enabled: Boolean(store.ngrok && store.ngrok.enabled),
        running: false,
        url: null,
        publicBaseUrl: null,
        error: null,
        domain: (store.ngrok && store.ngrok.domain) || "",
        region: (store.ngrok && store.ngrok.region) || "",
        hasAuthtoken: Boolean(store.ngrok && store.ngrok.authtoken),
      },
    };
  } catch {
    return {
      running: Boolean(running),
      external: Boolean(external),
      host: "127.0.0.1",
      port: 8787,
      baseUrl: "http://127.0.0.1:8787/v1",
    };
  }
}

/**
 * When the desktop launcher runs the proxy in its own terminal
 * (LOPSTER_PROXY_EXTERNAL=1), don't spawn a second instance — detect the
 * external one via /health and mark it as managed-by-elsewhere.
 * Returns the status object or null when no external proxy is up.
 */
async function detectExternal() {
  if (process.env.LOPSTER_PROXY_EXTERNAL !== "1") return null;
  let store = null;
  try {
    const storeApi = require("./store.cjs");
    store = userDataPath ? await storeApi.load(userDataPath) : null;
  } catch {
    /* */
  }
  const host = store?.host || "127.0.0.1";
  const port = store?.port || 8787;
  for (let i = 0; i < 8; i++) {
    if (await probeHealth(host, port)) {
      state = "external";
      statusCache = await buildStoreStatus(true, true, host, port);
      pushLog({ level: "info", msg: `External proxy detected on ${host}:${port} — app will not manage it` });
      return statusCache;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Child process
// ---------------------------------------------------------------------------

function spawnChild(ud, opts = {}) {
  const entry = path.join(__dirname, "standalone.cjs");
  const flags = ["--userData", ud, "--stdio"];
  if (opts.port != null) flags.push("--port", String(Number(opts.port) || 8787));
  if (opts.host) flags.push("--host", String(opts.host));

  // Preferred path (dev + packaged): a real Electron utility process. It runs
  // standalone.cjs with Node + asar support and survives the RunAsNode fuse
  // being disabled, which is what broke the packaged build (the old code
  // spawned process.execPath as "node" and got a second GUI instance instead).
  // utility processes have no stdin — the JSON channel uses MessagePort.
  if (utilityProcess) {
    const proc = utilityProcess.fork(entry, flags, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      serviceName: "ComposeVC Proxy Gateway",
    });
    transport = "port";
    child = proc;
    exitPromise = new Promise((resolve) => {
      proc.on("exit", (code) => {
        onChildExit(code, null);
        resolve({ code, signal: null });
      });
    });
    proc.on("message", (msg) => handleChildMessage(msg));
    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", onChildStdout);
    }
    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (d) => {
        const line = String(d).trim();
        if (line) pushLog({ level: "error", msg: line });
      });
    }
    return proc;
  }

  // Fallback for plain node hosts (tests / tooling): classic node child.
  transport = "stdio";
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const proc = spawn(process.execPath, [entry, ...flags], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;
  exitPromise = new Promise((resolve) => {
    proc.on("exit", (code, signal) => {
      onChildExit(code, signal);
      resolve({ code, signal });
    });
  });
  proc.on("error", (err) => {
    pushLog({ level: "error", msg: `proxy process error: ${err.message}` });
    if (state === "starting") {
      state = "idle";
      if (startReject) {
        const rej = startReject;
        startResolve = null;
        startReject = null;
        clearTimeout(startTimer);
        rej(err);
      }
    }
  });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", onChildStdout);
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => {
    const line = String(d).trim();
    if (line) pushLog({ level: "error", msg: line });
  });
  return proc;
}

function onChildStdout(chunk) {
  stdoutBuf += chunk;
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      pushLog({ level: "info", msg: line });
      continue;
    }
    handleChildMessage(msg);
  }
}

function handleChildMessage(msg) {
  if (msg.type === "ready") {
    statusCache = msg.status || null;
    const external = Boolean(msg.external);
    state = external ? "external" : "running";
    pushLog({
      level: "info",
      msg: external
        ? "Proxy already running in another process — app will not manage it"
        : `Proxy gateway process ready (pid ${child ? child.pid : "?"})`,
    });
    if (startResolve) {
      const r = startResolve;
      startResolve = null;
      startReject = null;
      clearTimeout(startTimer);
      r(statusCache);
    }
  } else if (msg.type === "log") {
    pushLog(msg.entry);
  } else if (msg.type === "usage-record") {
    for (const fn of usageListeners) {
      try {
        fn(msg.entry);
      } catch {
        /* */
      }
    }
  } else if (msg.type === "reply") {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error || "proxy command failed"));
    }
  } else if (msg.type === "fatal") {
    pushLog({ level: "error", msg: `proxy fatal: ${msg.error}` });
  }
}

function onChildExit(code, signal) {
  child = null;
  if (state === "starting") {
    state = "idle";
    if (startReject) {
      const rej = startReject;
      startResolve = null;
      startReject = null;
      clearTimeout(startTimer);
      rej(new Error(`proxy process exited before becoming ready (code ${code})`));
    }
    return;
  }
  if (state === "stopping" || stopRequested) {
    state = "idle";
    pushLog({ level: "info", msg: `Proxy process stopped (code ${code})` });
    return;
  }
  if (state === "external") {
    // The external instance keeps running; nothing to manage/restart.
    state = "external";
    return;
  }

  state = "idle";
  const willRestart = !stopRequested && userDataPath;
  pushLog({
    level: "error",
    msg: `Proxy process died unexpectedly (code ${code})${willRestart ? " — restarting…" : ""}`,
  });
  if (!willRestart) return;

  const now = Date.now();
  if (now - crashWindowStart > RESTART_WINDOW_MS) {
    crashWindowStart = now;
    crashCount = 0;
  }
  crashCount += 1;
  if (crashCount <= MAX_RESTARTS) {
    setTimeout(() => {
      void start(userDataPath).catch((e) =>
        pushLog({ level: "error", msg: `proxy restart failed: ${e.message}` })
      );
    }, 1500);
  } else {
    pushLog({ level: "error", msg: "proxy restart limit reached — giving up" });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function setUserDataPath(ud) {
  if (ud && ud !== userDataPath) {
    userDataPath = ud;
    statusCache = null;
  }
}

function isRunning() {
  return state === "running" || state === "external";
}

async function start(ud, opts = {}) {
  setUserDataPath(ud);
  if (state === "running" || state === "external") return statusCache || (await status());
  if (state === "starting") throw new Error("proxy gateway is already starting…");

  // Desktop launcher mode (LOPSTER_PROXY_EXTERNAL=1): a proxy may already be
  // up in its own terminal — detect it instead of spawning a duplicate.
  if (process.env.LOPSTER_PROXY_EXTERNAL === "1") {
    const ext = await detectExternal();
    if (ext) return ext;
  }

  if (child) {
    hardKill();
    child = null;
  }

  stopRequested = false;
  state = "starting";
  let proc;
  try {
    proc = spawnChild(ud, opts);
  } catch (e) {
    state = "idle";
    throw new Error(`failed to spawn proxy process: ${e.message}`);
  }

  return await new Promise((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
    startTimer = setTimeout(() => {
      if (startResolve) {
        const rej = startReject;
        startResolve = null;
        startReject = null;
        rej(new Error("proxy process did not become ready in time"));
      }
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* */
        }
      }
    }, START_TIMEOUT_MS);
  });
}

/** Write one control message to the child over the active transport. */
function writeToChild(payload) {
  if (!child) throw new Error("proxy process not running");
  if (transport === "port") {
    child.postMessage(payload);
    return;
  }
  child.stdin.write(JSON.stringify(payload) + "\n");
}

function command(command, payload, timeoutMs = CMD_TIMEOUT_MS) {
  if (!child || (state !== "running" && state !== "starting" && state !== "stopping")) {
    return Promise.reject(
      new Error(state === "external" ? "external proxy is not managed by the app" : "proxy process not running")
    );
  }
  const id = ++cmdSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`proxy command '${command}' timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      writeToChild({ id, command, payload });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

async function refreshStatus() {
  if (state === "running") {
    try {
      const st = await command("status", undefined, 4000);
      if (st) statusCache = st;
    } catch {
      /* keep last known status */
    }
  } else if (state === "external") {
    // Re-probe the external proxy — it may have been closed in its terminal.
    let store = null;
    try {
      const storeApi = require("./store.cjs");
      store = userDataPath ? await storeApi.load(userDataPath) : null;
    } catch {
      /* */
    }
    const host = store?.host || "127.0.0.1";
    const port = store?.port || 8787;
    if (await probeHealth(host, port)) {
      statusCache = await buildStoreStatus(true, true, host, port);
    } else {
      state = "idle";
      statusCache = await buildStoreStatus(false, false, host, port);
    }
  }
  return await status();
}

async function stop() {
  if (state === "external") {
    pushLog({
      level: "warn",
      msg: "External proxy instance cannot be stopped from the app — stop it in its own terminal",
    });
    return { running: true, external: true };
  }
  if (!child || state === "idle") {
    await writeStoreStopped();
    return await status();
  }

  stopRequested = true;
  state = "stopping";
  try {
    await command("stop", undefined, 4000);
  } catch {
    /* child may already be gone — kill below */
  }
  if (exitPromise) {
    await Promise.race([
      exitPromise,
      new Promise((resolve) => {
        setTimeout(() => {
          hardKill();
          resolve(null);
        }, STOP_TIMEOUT_MS);
      }),
    ]);
  }
  state = "idle";

  statusCache = statusCache ? { ...statusCache, running: false } : null;
  await writeStoreStopped();
  pushLog({ level: "info", msg: "Proxy stopped" });
  return await status();
}

/** Terminate the child immediately on whichever transport it runs. */
function hardKill() {
  if (!child) return;
  try {
    if (transport === "port") child.kill();
    else child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Fire-and-forget teardown for app quit (the child also dies with its parent). */
function kill() {
  stopRequested = true;
  if (child) {
    if (transport === "port") {
      hardKill();
    } else {
      try {
        child.stdin.end();
      } catch {
        /* */
      }
      const timer = setTimeout(() => hardKill(), 1500);
      if (typeof timer.unref === "function") timer.unref();
    }
  }
  child = null;
  state = "idle";
}

async function status() {
  if (state === "running" || state === "external") {
    return statusCache || { running: true, host: "127.0.0.1", port: 8787 };
  }
  if (state === "starting") return { running: true, starting: true };
  if (statusCache) return { ...statusCache, running: false };
  return await buildStoreStatus(false, false);
}

/** Resume the gateway on app launch if the store says it should run. */
async function autoStartIfNeeded(udPath, opts = {}) {
  setUserDataPath(udPath);
  try {
    const storeApi = require("./store.cjs");
    const store = await storeApi.load(udPath);
    // Desktop launcher mode: proxy already runs in its own terminal — detect
    // it instead of spawning a second instance.
    if (process.env.LOPSTER_PROXY_EXTERNAL === "1") {
      const ext = await detectExternal();
      if (ext) return { started: false, external: true, status: ext };
    }
    // `force` (packaged exe) always brings the gateway up: a first-run machine
    // has no store yet, so autoStart/enabled default to false and the app's
    // providers would hit a dead 127.0.0.1:8787. Persist the flag so the state
    // stays consistent for the proxy UI.
    if (opts.force && !store.autoStart) {
      try {
        store.autoStart = true;
        await storeApi.save(udPath, store);
      } catch {
        /* non-fatal — still start below */
      }
    }
    if (!opts.force && !store.autoStart && !store.enabled) {
      return { started: false, status: await status() };
    }
    const st = await start(udPath, { host: store.host, port: store.port });
    return { started: true, status: st };
  } catch (e) {
    pushLog({ level: "error", msg: `autoStart failed: ${e.message}` });
    return { started: false, error: e.message, status: await status() };
  }
}

async function writeStoreStopped() {
  if (!userDataPath) return;
  try {
    const storeApi = require("./store.cjs");
    const store = await storeApi.load(userDataPath);
    store.enabled = false;
    store.autoStart = false;
    await storeApi.save(userDataPath, store);
  } catch {
    /* best-effort */
  }
}

module.exports = {
  setUserDataPath,
  start,
  stop,
  kill,
  status,
  refreshStatus,
  autoStartIfNeeded,
  command,
  onLog,
  onUsageRecord,
  getLogs,
  isRunning,
};
