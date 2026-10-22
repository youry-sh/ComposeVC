// Background shell tasks: launch a command as a detached process that keeps
// running after the tool call returns (and after the app exits), then let the
// renderer show a per-chat "still running" badge with a stop (X) button.
//
// Records are persisted to <userData>/background-tasks.json so the UI can still
// see (and stop) a task after the app restarts. Liveness is checked by pid on
// read; dead pids are pruned.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const IS_WIN = process.platform === "win32";

// id -> { id, pid, command, cwd, sessionId, startedAt, logFile, child? }
// `child` is in-memory only (never persisted).
const tasks = new Map();

let userDataPath = null;
let storePath = null;
let logDir = null;
let broadcast = null;
let initialized = false;

function snapshot(t) {
  return {
    id: t.id,
    pid: t.pid,
    command: t.command,
    cwd: t.cwd,
    sessionId: t.sessionId,
    startedAt: t.startedAt,
    logFile: t.logFile,
  };
}

function persist() {
  if (!storePath) return;
  try {
    const records = [...tasks.values()].map(snapshot);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(`${storePath}.tmp`, JSON.stringify(records, null, 2), "utf8");
    fs.renameSync(`${storePath}.tmp`, storePath);
  } catch {
    /* best-effort persistence */
  }
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it.
    return Boolean(err && err.code === "EPERM");
  }
}

function load() {
  if (!storePath) return;
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const records = JSON.parse(raw);
    if (!Array.isArray(records)) return;
    for (const r of records) {
      if (!r || !Number.isFinite(r.pid)) continue;
      tasks.set(String(r.id), {
        id: String(r.id),
        pid: r.pid,
        command: String(r.command || ""),
        cwd: String(r.cwd || ""),
        sessionId: r.sessionId ?? null,
        startedAt: Number(r.startedAt) || Date.now(),
        logFile: r.logFile || null,
        child: null,
      });
    }
  } catch {
    /* first run / corrupt store */
  }
}

function init(opts = {}) {
  if (initialized) return;
  userDataPath = opts.userDataPath || null;
  broadcast = typeof opts.broadcast === "function" ? opts.broadcast : null;
  if (userDataPath) {
    storePath = path.join(userDataPath, "background-tasks.json");
    logDir = path.join(userDataPath, "background-logs");
  }
  load();
  initialized = true;
}

function launch({ command, cwd, sessionId }) {
  if (!initialized) throw new Error("backgroundTasks is not initialized");

  const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (logDir) {
    try { fs.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
  }
  const logFile = logDir ? path.join(logDir, `${id}.log`) : null;

  let out = null;
  if (logFile) {
    try { out = fs.openSync(logFile, "a"); } catch { out = null; }
  }
  const stdio = out != null ? ["ignore", out, out] : "ignore";

  let child;
  if (IS_WIN) {
    // PowerShell writes console output in the system codepage; force UTF-8 so
    // Cyrillic etc. in the log file is not mojibake.
    const encoded = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;
    child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NonInteractive", "-Command", encoded],
      { cwd, detached: true, windowsHide: true, stdio }
    );
  } else {
    child = spawn("/bin/bash", ["-c", command], { cwd, detached: true, stdio });
  }

  const pid = child.pid;
  const task = {
    id,
    pid,
    command,
    cwd,
    sessionId: sessionId || null,
    startedAt: Date.now(),
    logFile,
    child,
  };
  tasks.set(id, task);
  // Detach from this process's lifecycle so the task survives an app close.
  child.unref();
  persist();

  const cleanup = () => {
    if (out != null) {
      try { fs.closeSync(out); } catch { /* ignore */ }
    }
    if (tasks.get(id) && tasks.get(id).child === child) {
      tasks.delete(id);
      persist();
    }
  };

  child.on("exit", (code) => {
    cleanup();
    broadcast?.({ type: "exited", id, pid, exitCode: code });
  });
  child.on("error", (err) => {
    cleanup();
    broadcast?.({ type: "exited", id, pid, error: err?.message || String(err) });
  });

  broadcast?.({ type: "launched", task: snapshot(task) });
  return snapshot(task);
}

function list(sessionId) {
  let changed = false;
  for (const [id, t] of [...tasks]) {
    if (!isAlive(t.pid)) {
      tasks.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
  const all = [...tasks.values()].map(snapshot);
  if (sessionId == null) return all;
  return all.filter((t) => t.sessionId === sessionId);
}

function kill(id) {
  const key = String(id || "");
  const t = tasks.get(key);
  if (!t) return { ok: false, error: "not found" };

  if (t.child && typeof t.child.kill === "function") {
    try { t.child.kill(); } catch { /* already stopped */ }
  }
  if (IS_WIN) {
    try {
      spawnSync("taskkill", ["/PID", String(t.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch { /* already gone */ }
  } else {
    try { process.kill(-t.pid, "SIGTERM"); } catch { try { process.kill(t.pid, "SIGTERM"); } catch { /* gone */ } }
    try { process.kill(-t.pid, "SIGKILL"); } catch { try { process.kill(t.pid, "SIGKILL"); } catch { /* gone */ } }
  }

  tasks.delete(key);
  persist();
  broadcast?.({ type: "killed", id: key, pid: t.pid });
  return { ok: true, id: key, pid: t.pid };
}

module.exports = { init, launch, list, kill, isAlive };
