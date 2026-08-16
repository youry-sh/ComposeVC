const fs = require("fs");
const os = require("os");
const path = require("path");

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

/** <userData>/vm — everything the VM engine owns lives under this single root. */
function baseDir(userDataPath) {
  return path.join(resolveUserData(userDataPath), "vm");
}

const layout = {
  base: baseDir,
  config: (u) => path.join(baseDir(u), "config.json"),
  registry: (u) => path.join(baseDir(u), "registry.json"),
  images: (u) => path.join(baseDir(u), "images"),
  qemu: (u) => path.join(baseDir(u), "qemu"),
  machines: (u) => path.join(baseDir(u), "machines"),
  machine: (u, id) => path.join(baseDir(u), "machines", id),
  downloads: (u) => path.join(baseDir(u), "images", ".partial"),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureLayout(userDataPath) {
  ensureDir(baseDir(userDataPath));
  ensureDir(layout.images(userDataPath));
  ensureDir(layout.machines(userDataPath));
  return baseDir(userDataPath);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic write — a half-written registry would lose every machine record. */
function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function readConfig(userDataPath) {
  const cfg = readJson(layout.config(userDataPath), {});
  return {
    qemuDir: cfg.qemuDir || null,
    defaultCpus: cfg.defaultCpus || 2,
    defaultMemoryMb: cfg.defaultMemoryMb || 2048,
    defaultDiskGb: cfg.defaultDiskGb || 20,
    defaultUser: cfg.defaultUser || "vc",
    defaultPassword: cfg.defaultPassword || "composevc",
    accel: cfg.accel || "auto",
    ...cfg,
  };
}

function writeConfig(userDataPath, patch) {
  const next = { ...readConfig(userDataPath), ...(patch || {}), updatedAt: Date.now() };
  writeJson(layout.config(userDataPath), next);
  return next;
}

function diskFree(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { freeBytes: stat.bsize * stat.bavail, totalBytes: stat.bsize * stat.blocks };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  };
  walk(dir);
  return total;
}

module.exports = {
  resolveUserData,
  baseDir,
  layout,
  ensureDir,
  ensureLayout,
  readJson,
  writeJson,
  readConfig,
  writeConfig,
  diskFree,
  dirSize,
};
