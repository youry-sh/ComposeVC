/**
 * Robust Electron launcher for Windows (and other platforms).
 * Avoids "electron is not recognized" when node_modules/.bin is missing
 * or the electron package is a partial install (dist/electron.exe only).
 *
 * Usage:
 *   node scripts/run-electron.cjs electron/runtimeMain.cjs
 *   node scripts/run-electron.cjs .
 *   node scripts/run-electron.cjs --extra-arg
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function resolveElectronBinary() {
  const isWin = process.platform === "win32";
  const candidates = [];

  // Full package: path from require("electron") path module (when package.json exists)
  try {
    // electron package exports the binary path as module.exports = path string
    // but only when package is complete. Guarded.
    const electronPkgDir = path.join(root, "node_modules", "electron");
    if (exists(path.join(electronPkgDir, "package.json"))) {
      // Prefer path.js / index that returns binary path
      try {
        // eslint-disable-next-line import/no-dynamic-require, global-require
        const resolved = require(path.join(electronPkgDir));
        if (typeof resolved === "string" && exists(resolved)) {
          return resolved;
        }
      } catch {
        /* fall through */
      }
    }
  } catch {
    /* fall through */
  }

  if (isWin) {
    candidates.push(
      path.join(root, "node_modules", "electron", "dist", "electron.exe"),
      path.join(root, "node_modules", ".bin", "electron.cmd"),
      path.join(root, "node_modules", ".bin", "electron")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      path.join(
        root,
        "node_modules",
        "electron",
        "dist",
        "Electron.app",
        "Contents",
        "MacOS",
        "Electron"
      ),
      path.join(root, "node_modules", ".bin", "electron")
    );
  } else {
    candidates.push(
      path.join(root, "node_modules", "electron", "dist", "electron"),
      path.join(root, "node_modules", ".bin", "electron")
    );
  }

  for (const c of candidates) {
    if (!exists(c)) continue;
    // A .cmd shim is not directly executable by child_process.spawn on Windows.
    // It is only a last-resort candidate and must be launched through cmd.exe.
    return c;
  }
  return null;
}

function main() {
  const bin = resolveElectronBinary();
  const isWindowsShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin || "");
  if (!bin || isWindowsShim) {
    console.error(
      "[run-electron] Electron binary not found (the npm command shim alone is not enough).\n" +
        "  Expected: node_modules/electron/dist/electron.exe\n" +
        "  Your Electron install is incomplete or incompatible with the installed Node.js.\n" +
        "  Fix: run build-sc\\install.bat with Node.js 22.12 or newer.\n"
    );
    process.exit(1);
  }

  console.log("[run-electron] using:", bin);
  const child = spawn(bin, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    windowsHide: false,
  });

  child.on("error", (err) => {
    console.error("[run-electron] spawn failed:", err.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code == null ? 1 : code);
  });
}

main();
