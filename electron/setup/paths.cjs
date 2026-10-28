const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Everything the Setup tab owns lives under a single root:
 *   <userData>/setup/state.json   — persisted per-component state (v1)
 *   <userData>/setup/install.log  — append-only install log
 *   <userData>/setup/downloads/   — officially downloaded installers
 *
 * Mirrors electron/vm/paths.cjs (same atomic-write and userData resolution
 * idioms) but is deliberately separate: VM images and toolchain installers
 * must never share a directory or a state file.
 */

/** Resolve the ComposeVC userData root even outside the Electron main process. */
function resolveUserData(userDataPath) {
  if (userDataPath && typeof userDataPath === "string") return userDataPath;
  if (process.env.COMPOSEVC_USER_DATA) return process.env.COMPOSEVC_USER_DATA;
  try {
    const { app } = require("electron");
    if (app?.getPath) return app.getPath("userData");
  } catch {
    /* not in Electron main — fall through to a home-dir path */
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ComposeVC");
  }
  return path.join(home, ".composevc");
}

function resolveSetupDir(userDataPath) {
  return path.join(resolveUserData(userDataPath), "setup");
}

function downloadsDir(userDataPath) {
  return path.join(resolveSetupDir(userDataPath), "downloads");
}

function statePath(userDataPath) {
  return path.join(resolveSetupDir(userDataPath), "state.json");
}

function logPath(userDataPath) {
  return path.join(resolveSetupDir(userDataPath), "install.log");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureSetupDir(userDataPath) {
  ensureDir(resolveSetupDir(userDataPath));
  ensureDir(downloadsDir(userDataPath));
  return resolveSetupDir(userDataPath);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Atomic write: tmp file -> fsync -> rename -> best-effort directory fsync.
 * A crash mid-write must never truncate a readable state.json.
 */
function writeJson(file, data) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(data, null, 2);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, json, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync unsupported on this fs — rename is still atomic */
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } catch {
        /* ignore */
      }
      fs.closeSync(dirFd);
    } catch {
      /* directory fsync is not available on Windows — ignore */
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return file;
}

module.exports = {
  resolveUserData,
  resolveSetupDir,
  downloadsDir,
  statePath,
  logPath,
  ensureDir,
  ensureSetupDir,
  readJson,
  writeJson,
};
