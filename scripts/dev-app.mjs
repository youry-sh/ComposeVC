import { spawn } from "child_process";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const port = Number(process.env.LOPSTER_DEV_PORT || 3004);
const devServerUrl = process.env.LOPSTER_DEV_SERVER || `http://localhost:${port}`;
const isWin = process.platform === "win32";

function waitForServer(url, timeoutMs = 60000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const target = new URL(url);
      const req = http.get(
        {
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname || "/",
          timeout: 1000,
        },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
      req.on("error", () => retry());
    };

    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for Vite at ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };

    tick();
  });
}

function spawnProc(command, args, env = {}) {
  return spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: isWin,
  });
}

const children = [];

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      try {
        if (isWin && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", shell: true });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        /* */
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[dev-app] starting Vite on ${devServerUrl}`);
const vite = spawnProc(isWin ? "npx.cmd" : "npx", ["vite", "--port", String(port), "--strictPort"]);
children.push(vite);
vite.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

try {
  await waitForServer(devServerUrl);
} catch (error) {
  console.error(`[dev-app] ${error.message || error}`);
  shutdown(1);
}

console.log(`[dev-app] Vite ready — launching Electron with HMR`);
const electron = spawnProc(
  isWin ? "npx.cmd" : "npx",
  ["electron", "."],
  {
    LOPSTER_DEV_MODE: "1",
    LOPSTER_DEV_SERVER: devServerUrl,
    VITE_DEV_SERVER_URL: devServerUrl,
    ELECTRON_FORCE_NEW_INSTANCE: process.env.ELECTRON_FORCE_NEW_INSTANCE || "1",
  }
);
children.push(electron);

electron.on("exit", (code) => {
  shutdown(code ?? 0);
});
