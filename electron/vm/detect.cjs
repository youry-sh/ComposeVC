const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { layout, readConfig, diskFree } = require("./paths.cjs");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const SYSTEM_BIN = `qemu-system-x86_64${EXE}`;
const IMG_BIN = `qemu-img${EXE}`;

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Managed install may unpack into <base>/qemu or one level below it. */
function managedCandidates(userDataPath) {
  const root = layout.qemu(userDataPath);
  const dirs = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(root, entry.name));
    }
  } catch {
    /* nothing installed yet */
  }
  return dirs;
}

function pathDirs() {
  return String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function wellKnownDirs() {
  if (IS_WIN) {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA || "";
    return [
      path.join(programFiles, "qemu"),
      path.join(programFilesX86, "qemu"),
      "C:\\qemu",
      "C:\\tools\\qemu",
      path.join(localAppData, "Programs", "qemu"),
      path.join(os.homedir(), "scoop", "apps", "qemu", "current"),
    ];
  }
  return ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/local/opt/qemu/bin", "/snap/bin"];
}

function findQemuDir(userDataPath) {
  const config = readConfig(userDataPath);
  const candidates = [
    ...(config.qemuDir ? [config.qemuDir] : []),
    ...managedCandidates(userDataPath),
    ...pathDirs(),
    ...wellKnownDirs(),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const system = path.join(dir, SYSTEM_BIN);
    if (isFile(system)) {
      const img = path.join(dir, IMG_BIN);
      return { dir, system, img: isFile(img) ? img : null, source: config.qemuDir === dir ? "config" : "found" };
    }
  }
  return null;
}

function run(binary, args, timeout = 8000) {
  try {
    return String(execFileSync(binary, args, { timeout, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (err) {
    return String(err?.stdout || "");
  }
}

function qemuVersion(system) {
  const out = run(system, ["--version"]);
  const match = out.match(/version\s+([0-9][^\s(]*)/i);
  return { version: match ? match[1] : null, raw: out.trim().split(/\r?\n/)[0] || "" };
}

/** Accelerators compiled into this binary — the enabled/usable one is decided at start. */
function listAccels(system) {
  const out = run(system, ["-accel", "help"]);
  const lines = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/accelerators supported/i.test(line));
  return lines.filter((line) => /^[a-z0-9]+$/.test(line));
}

function preferredAccel(accels) {
  const available = new Set(accels);
  if (IS_WIN && available.has("whpx")) return "whpx";
  if (process.platform === "linux" && available.has("kvm") && fs.existsSync("/dev/kvm")) return "kvm";
  if (process.platform === "darwin" && available.has("hvf")) return "hvf";
  return "tcg";
}

let cache = { key: null, value: null, at: 0 };

function detect(userDataPath, { force = false } = {}) {
  const key = String(userDataPath || "");
  if (!force && cache.key === key && Date.now() - cache.at < 20_000) return cache.value;
  const found = findQemuDir(userDataPath);
  const base = {
    platform: process.platform,
    arch: process.arch,
    hostCpus: os.cpus().length,
    hostMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    disk: diskFree(layout.base(userDataPath)),
    qemu: null,
  };
  if (!found) {
    const value = { ...base, installed: false, reason: "qemu-system-x86_64 was not found on this host" };
    cache = { key, value, at: Date.now() };
    return value;
  }
  const version = qemuVersion(found.system);
  const accels = listAccels(found.system);
  const accel = preferredAccel(accels);
  const value = {
    ...base,
    installed: true,
    qemu: {
      dir: found.dir,
      system: found.system,
      img: found.img,
      version: version.version,
      banner: version.raw,
      accels,
      preferredAccel: accel,
      hardwareAccel: accel !== "tcg",
      source: found.source,
    },
  };
  cache = { key, value, at: Date.now() };
  return value;
}

function requireQemu(userDataPath) {
  const info = detect(userDataPath);
  if (!info.installed) {
    throw new Error(
      "QEMU is not installed. Run action=host_install (downloads/installs QEMU), " +
        "or install it manually and point at it with action=host_config qemu_dir=<folder containing qemu-system-x86_64>."
    );
  }
  return info.qemu;
}

module.exports = { detect, requireQemu, findQemuDir, listAccels, preferredAccel, SYSTEM_BIN, IMG_BIN, IS_WIN };
