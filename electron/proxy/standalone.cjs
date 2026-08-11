#!/usr/bin/env node
/**
 * Standalone Lopster proxy gateway — runs OUTSIDE the Electron app.
 *
 * The real HTTP endpoint (/v1/*), SSE stream pipeline, Lopster Guard, ngrok
 * tunnel and the quota/health workers all live HERE, in a separate Node
 * process. That way heavy proxying and log volume can never freeze or kill
 * the app's main process / UI.
 *
 * Two modes:
 *
 *   --stdio   (spawned by electron/proxy/processManager.cjs)
 *             JSON control channel over stdio:
 *               child → stdout lines:  {type:"ready"|"log"|"usage-record"|"reply"|"fatal", …}
 *               parent → stdin lines:  {id, command, payload?}
 *             On stdin close (app quit) the proxy shuts down gracefully.
 *
 *   terminal (manual run, human-readable logs):
 *             node electron/proxy/standalone.cjs --userData <dir> [--port N] [--host H]
 *             Ctrl+C / SIGTERM to stop.
 *
 * The store file (userData/proxy/store.json) is the shared state bus with the
 * app — it already uses a cross-process file lock (storeLock.cjs).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const storeApi = require("./store.cjs");
const server = require("./server.cjs");
const accountsApi = require("./accounts.cjs");
const healthWorker = require("./routing/healthWorker.cjs");
const usageStats = require("./usageStats.cjs");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Lopster proxy gateway (standalone process)

Usage:
  node electron/proxy/standalone.cjs [options]

Options:
  --userData <dir>   userData dir containing proxy/store.json
                     (default: platform app config dir for ComposeVC)
  --port <n>         override listen port (default: from store, 8787)
  --host <h>         override listen host (default: from store, 127.0.0.1)
  --stdio            JSON control channel over stdin/stdout (app-spawned mode)
  --no-autostart     do not persist autoStart=true in the store
  --help             show this help
`);
}

function parseArgs(argv) {
  const out = {
    userData: null,
    port: null,
    host: null,
    stdio: false,
    noAutoStart: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--userData" || a === "--user-data" || a === "--user-data-dir") out.userData = next();
    else if (a === "--port") out.port = Number(next());
    else if (a === "--host") out.host = next();
    else if (a === "--stdio") out.stdio = true;
    else if (a === "--no-autostart") out.noAutoStart = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

/**
 * Identity parts are sanitized exactly like electron/main.cjs.
 * A launcher writing `set LOPSTER_COPY_ID=%VAR% && node …` in cmd keeps the
 * space before `&&` inside the value; without this the proxy would resolve
 * "…-copy " while the app resolves "…-copy", split the store in two, and
 * reject every request with 401 "Invalid API key" against an empty key list.
 */
function sanitizeIdentityPart(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function defaultUserData() {
  // Explicit override always wins.
  if (process.env.LOPSTER_USER_DATA) return process.env.LOPSTER_USER_DATA.trim();
  const appName = (process.env.LOPSTER_APP_NAME || "ComposeVC").trim() || "ComposeVC";
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  // Dev-mode copy convention — mirrors electron/main.cjs (LOPSTER_COPY_ID), so
  // `npm run proxy` from the same shell as start.sh hits the SAME store file.
  const copyId = sanitizeIdentityPart(process.env.LOPSTER_COPY_ID);
  const instanceId = sanitizeIdentityPart(process.env.LOPSTER_INSTANCE_ID);
  if (copyId) {
    const name = `lopster-ide-copy-${copyId}`;
    return path.join(base, instanceId ? `${name}-${instanceId}` : name);
  }
  if (instanceId) {
    return path.join(base, `lopster-ide-copy-${instanceId}`);
  }
  return path.join(base, appName);
}

// ---------------------------------------------------------------------------
// Control channel
// ---------------------------------------------------------------------------

let stdioMode = false;
let userDataPath = null;

function send(obj) {
  if (!stdioMode) return;
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    /* pipe may be gone (app quit) */
  }
}

function formatHuman(entry) {
  const ts = new Date(entry.ts || Date.now()).toISOString().slice(11, 19);
  const lvl = String(entry.level || "info").toUpperCase().padEnd(5);
  return `[proxy ${ts}] ${lvl} ${entry.msg || ""}${entry.model ? ` (model=${entry.model})` : ""}`;
}

function pushLog(entry) {
  if (stdioMode) send({ type: "log", entry });
  else console.log(formatHuman(entry));
}

// ---------------------------------------------------------------------------
// Server + background workers
// ---------------------------------------------------------------------------

async function probeHealth(host, port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: "/health", timeout: 2500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
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

async function startProxy(args) {
  await fs.promises.mkdir(userDataPath, { recursive: true });

  server.init(userDataPath);
  await usageStats.init(userDataPath).catch(() => {});
  if (stdioMode) {
    // The APP process owns usage-stats.json (single disk writer). The child
    // only forwards each recorded entry over the pipe; the parent aggregates.
    usageStats.setForwardMode(true);
    usageStats.onForwardRecord((entry) => send({ type: "usage-record", entry }));
  }

  server.onLog(pushLog);

  try {
    return await server.start(userDataPath, {
      host: args.host || undefined,
      port: args.port || undefined,
      autoStart: !args.noAutoStart,
    });
  } catch (e) {
    if (e && e.code === "EADDRINUSE") {
      const store = await storeApi.load(userDataPath).catch(() => null);
      const host = args.host || store?.host || "127.0.0.1";
      const port = args.port || store?.port || 8787;
      const healthy = await probeHealth(host, port);
      if (healthy) {
        console.error(`[proxy] another proxy instance already listening on ${host}:${port} — exiting (external mode)`);
        send({ type: "ready", status: { ...(await server.status().catch(() => ({}))), running: true, external: true }, external: true });
        await gracefulExit(0);
        return null;
      }
    }
    console.error("[proxy] start failed:", e && (e.message || e));
    send({ type: "fatal", error: (e && e.message) || String(e) });
    await gracefulExit(1);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Control commands (parent → child)
// ---------------------------------------------------------------------------

async function handleCommand(cmd) {
  const { id, command } = cmd || {};
  try {
    let result;
    switch (command) {
      case "status":
        result = await server.status();
        break;
      case "logs":
        result = server.getLogs().slice(-50);
        break;
      case "stop":
        result = await server.stop();
        // Reply first, then exit — lets the pipe flush before the process dies.
        send({ type: "reply", id, ok: true, payload: result });
        setTimeout(() => void gracefulExit(0), 100);
        return;
      case "ngrok-restart":
        result = await server.restartNgrokFromStore();
        break;
      case "guard-status": {
        const guard = require("./guard/index.cjs");
        const store = await storeApi.load(userDataPath);
        result = guard.status(store && store.guard);
        break;
      }
      case "routing-status": {
        const accountRouter = require("./routing/accountRouter.cjs");
        const store = await storeApi.load(userDataPath);
        for (const a of store.accounts || []) accountRouter.hydrateFromAccount(a);
        result = {
          statuses: accountRouter.getAllStatuses(),
          accounts: storeApi.publicView(store).accounts,
        };
        break;
      }
      case "usage":
        result = usageStats.publicView(80);
        break;
      case "usage-reset":
        result = await usageStats.reset();
        break;
      case "reload-providers": {
        const { registerCustomProvidersFromStore } = require("./providers/registry.cjs");
        const store = await storeApi.load(userDataPath);
        registerCustomProvidersFromStore(store);
        result = { ok: true };
        break;
      }
      default:
        throw new Error("unknown command: " + command);
    }
    send({ type: "reply", id, ok: true, payload: result });
  } catch (e) {
    send({ type: "reply", id, ok: false, error: (e && e.message) || String(e) });
  }
}

function setupControlChannel() {
  if (!stdioMode) return;
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        continue;
      }
      void handleCommand(cmd);
    }
  });
  // Parent process gone (app quit) → shut the gateway down too.
  process.stdin.on("end", () => void gracefulExit(0));
  process.stdin.resume();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let exiting = false;
async function gracefulExit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await server.stop();
  } catch {
    /* */
  }
  process.exit(code || 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  stdioMode = args.stdio;
  userDataPath = args.userData || defaultUserData();
  process.title = "lopster-proxy";

  process.on("SIGINT", () => void gracefulExit(0));
  process.on("SIGTERM", () => void gracefulExit(0));
  // EPIPE on stdout (parent died mid-line) must not crash the child.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  setupControlChannel();

  const st = await startProxy(args);
  if (!st) return; // exited inside startProxy (EADDRINUSE / fatal)

  // Background workers that used to live in the app main process now live here.
  accountsApi.startQuotaLoop(() => userDataPath, 5 * 60 * 1000);
  healthWorker.startHealthWorker(() => userDataPath, 30 * 1000);

  if (stdioMode) {
    send({ type: "ready", status: st });
  } else {
    console.log("");
    console.log("============================================");
    console.log("  Lopster proxy gateway (standalone)");
    console.log(`  listening: ${st.baseUrl || `http://${st.host}:${st.port}/v1`}`);
    console.log(`  userData:  ${userDataPath}`);
    console.log(`  ngrok:     ${st.ngrok && st.ngrok.running ? st.ngrok.url || "running" : "disabled"}`);
    console.log("  Ctrl+C to stop");
    console.log("============================================");
    console.log("");
  }
}

main().catch((e) => {
  console.error("[proxy] fatal:", e && (e.message || e));
  process.exit(1);
});
