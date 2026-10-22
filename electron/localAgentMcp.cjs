/**
 * Local Coding Agent MCP — запуск/остановка внешнего MCP-сервера (9brains-mcp-agent)
 * + временный Cloudflare-туннель. Отдаёт в UI готовые данные коннектора и промт.
 *
 * IPC:
 *   localAgent:getConfig  -> { ok, agentDir, exists }
 *   localAgent:setDir     (dir)  -> { ok, agentDir, exists }
 *   localAgent:pickDir    -> { ok, agentDir?, exists? }
 *   localAgent:status     -> { ok, state }
 *   localAgent:start      -> { ok, state, error? }
 *   localAgent:stop       -> { ok, state }
 *
 * Токен читается из <agentDir>/.env (MCP_TOKEN) при каждом запросе — в коде не хранится.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn, execFile } = require("child_process");

const IS_WIN = process.platform === "win32";
// Агент лежит внутри проекта: <ComposeVC>/mcp-agent (рядом с electron/).
// В упакованном приложении — resources/mcp-agent (extraResources).
function resolveDefaultAgentDir() {
  const candidates = [
    path.join(__dirname, "..", "mcp-agent"),
    process.resourcesPath ? path.join(process.resourcesPath, "mcp-agent") : null,
  ].filter(Boolean);
  return candidates.find((d) => fs.existsSync(path.join(d, "server.py"))) || candidates[0];
}
const DEFAULT_AGENT_DIR = resolveDefaultAgentDir();
const LEGACY_AGENT_DIRS = [
  path.join(process.env.USERPROFILE || process.env.HOME || "", "Desktop", "9brains-mcp-agent"),
];
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

const FALLBACK_INSTRUCTION = `# Инструкция для Notion Agent (вставь в Custom instructions агента или первым сообщением)

Ты — кодинг-агент с доступом к компьютеру владельца через MCP-сервер local-coding-agent.

Правила:
1. Сначала всегда вызывай system_info и fs_list, чтобы понять структуру. Не гадай пути.
2. Файлы читай через fs_read постранично (offset/limit). Большие файлы — кусками.
3. Ищи файлы через fs_glob ('**/*.py'), содержимое — через fs_grep, прежде чем читать всё дерево.
4. Правки: предпочитай точечный fs_edit. Полный fs_write — только для новых файлов.
5. shell_run: короткие команды (timeout 10-30с). Долгие (npm install, pytest, build) — через shell_run_async + shell_poll.
6. Если в клиенте включён approval-режим — уважай его.
7. Не выводи секреты и токены в чат.
8. После изменений кода запускай проверку (pytest / npm test / tsc) и показывай короткий итог.
9. Если инструмент вернул {"ok": false} — прочитай error, исправься, не повторяй тот же вызов.
10. ВАЖНО — правило новой папки: если ответ содержит need_approval с zone,
    ОСТАНОВИСЬ и спроси пользователя в чате: «дать доступ к <zone>?».
    Только после явного «да» вызови approve_zone(zone, confirm=true)
    и повтори исходный вызов. Знакомые папки подтверждение не требуют.`;

// ---------- persisted settings ----------
let settingsFile = null;
let agentDir = DEFAULT_AGENT_DIR;

function loadSettings(userDataPath) {
  settingsFile = path.join(userDataPath, "local-agent-mcp.json");
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    if (raw && typeof raw.agentDir === "string" && raw.agentDir.trim()) {
      const saved = raw.agentDir.trim();
      // Старый путь с рабочего стола больше не используем — агент теперь внутри проекта.
      const isLegacy = LEGACY_AGENT_DIRS.some((d) => path.resolve(d).toLowerCase() === path.resolve(saved).toLowerCase());
      if (!isLegacy && fs.existsSync(path.join(saved, "server.py"))) agentDir = saved;
    }
  } catch {
    /* defaults */
  }
}

function saveSettings() {
  if (!settingsFile) return;
  try {
    fs.writeFileSync(settingsFile, JSON.stringify({ agentDir }, null, 2), "utf8");
  } catch {
    /* */
  }
}

// ---------- helpers ----------
function readEnv(dir) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, ".env"), "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[t.slice(0, i).trim()] = v;
    }
  } catch {
    /* */
  }
  return out;
}

function readPort(dir) {
  const env = readEnv(dir);
  if (env.MCP_PORT && /^\d+$/.test(env.MCP_PORT)) return Number(env.MCP_PORT);
  try {
    const m = fs.readFileSync(path.join(dir, "config.yaml"), "utf8").match(/^\s*port:\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* */
  }
  return 8000;
}

function readToken(dir) {
  const t = readEnv(dir).MCP_TOKEN || "";
  return /CHANGE_ME/.test(t) ? "" : t;
}

function readInstruction(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, "AGENT.md"), "utf8").trim();
    if (txt) return txt;
  } catch {
    /* */
  }
  return FALLBACK_INSTRUCTION;
}

function pythonPath(dir) {
  const venv = IS_WIN ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
  if (fs.existsSync(venv)) return venv;
  return IS_WIN ? "python" : "python3";
}

function cloudflaredPath(dir) {
  const local = path.join(dir, "bin", IS_WIN ? "cloudflared.exe" : "cloudflared");
  return fs.existsSync(local) ? local : "cloudflared";
}

function getUrl(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastTunnelUrl(dir) {
  try {
    const txt = fs.readFileSync(path.join(dir, "cloudflared.err.log"), "utf8");
    const all = txt.match(URL_RE);
    return all && all.length ? all[all.length - 1] : null;
  } catch {
    return null;
  }
}

function listAgentProcesses(dir, port) {
  return new Promise((resolve) => {
    if (!IS_WIN) {
      execFile("ps", ["-eo", "pid=,command="], (err, stdout) => {
        if (err) return resolve([]);
        const rows = String(stdout)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const sp = l.indexOf(" ");
            return { pid: Number(l.slice(0, sp)), cmd: l.slice(sp + 1) };
          });
        resolve(rows);
      });
      return;
    }
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='cloudflared.exe'\" | " +
      "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }; " +
      `Get-NetTCPConnection -LocalPort ${Number(port) || 8000} -State Listen -ErrorAction SilentlyContinue | ` +
      "ForEach-Object { \"$($_.OwningProcess)`tLISTENER`t\" }";
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const rows = String(stdout)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [pid, name, ...rest] = l.split("\t");
          return { pid: Number(pid), name, cmd: rest.join("\t") };
        });
      resolve(rows);
    });
  }).then((rows) => {
    const low = dir.toLowerCase();
    const tunnelArg = `127.0.0.1:${port}`;
    // Процесс, который держит порт, считаем сервером агента, если это python с server.py
    // (запуск через системный python не содержит путь папки в CommandLine).
    const listenerPids = new Set(rows.filter((r) => r.name === "LISTENER").map((r) => r.pid));
    const procs = rows.filter((r) => r.name !== "LISTENER");
    return {
      server: procs.filter(
        (r) =>
          /server\.py/i.test(r.cmd || "") &&
          ((r.cmd || "").toLowerCase().includes(low) || listenerPids.has(r.pid))
      ),
      tunnel: procs.filter(
        (r) => /cloudflared/i.test(r.cmd || "") && ((r.cmd || "").toLowerCase().includes(low) || (r.cmd || "").includes(tunnelArg))
      ),
    };
  });
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      /* */
    }
  }
}

// ---------- persistent (outlives the app) spawn ----------
// На Windows процессы запускаются через WMI (Win32_Process.Create): их родитель —
// служба WMI, а не приложение. Поэтому закрытие окна, выход из приложения,
// "Снять задачу" в диспетчере или kill дерева процессов НЕ убивают MCP и туннель.
// Остановить их можно только кнопкой Stop MCP (или stop.bat агента).
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function spawnPersistentWin(exe, args, cwd, outFile, errFile) {
  const q = (s) => `"${s}"`;
  const inner = [q(exe), ...args.map((a) => (/[\s"]/.test(a) ? q(a) : a))].join(" ");
  const cmdLine = `cmd.exe /d /s /c "${inner} 1>${q(outFile)} 2>${q(errFile)}"`;
  const script =
    "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; " +
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(cmdLine)}; ` +
    `CurrentDirectory = ${psQuote(cwd)}; ProcessStartupInformation = $si }; ` +
    "Write-Output \"$($r.ReturnValue) $($r.ProcessId)\"";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        const m = String(stdout || "").trim().match(/(\d+)\s+(\d+)/);
        if (err || !m || m[1] !== "0") {
          return resolve({ ok: false, error: err ? err.message : `Win32_Process.Create вернул ${m ? m[1] : "?"}` });
        }
        resolve({ ok: true, pid: Number(m[2]) });
      }
    );
  });
}

// Запуск процесса, который переживает приложение. Возвращает { ok, pid?, error? }.
async function spawnPersistent(exe, args, cwd, outFile, errFile) {
  if (IS_WIN) {
    const res = await spawnPersistentWin(exe, args, cwd, outFile, errFile);
    if (res.ok) return res;
    // fallback ниже — обычный detached-спавн
  }
  return new Promise((resolve) => {
    let out;
    let err;
    try {
      out = fs.openSync(outFile, "w");
      err = fs.openSync(errFile, "w");
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const child = spawn(exe, args, { cwd, detached: true, windowsHide: true, stdio: ["ignore", out, err] });
    let done = false;
    child.on("error", (e) => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: e.message });
      }
    });
    child.unref();
    setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: true, pid: child.pid });
      }
    }, 300);
  });
}

// ---------- state ----------
let busy = false;
let lastError = null;
let publicOk = null;

async function buildState() {
  const dir = agentDir;
  const exists = fs.existsSync(path.join(dir, "server.py"));
  const port = readPort(dir);
  const localOk = exists ? await getUrl(`http://127.0.0.1:${port}/health`, 2500) : false;
  const procs = exists ? await listAgentProcesses(dir, port) : { server: [], tunnel: [] };
  const tunnelRunning = procs.tunnel.length > 0;
  const base = tunnelRunning ? lastTunnelUrl(dir) : null;
  const token = exists ? readToken(dir) : "";
  return {
    agentDir: dir,
    exists,
    busy,
    port,
    localOk,
    serverPids: procs.server.map((p) => p.pid),
    tunnelRunning,
    publicOk: base ? publicOk : null,
    running: localOk && Boolean(base),
    error: lastError,
    connector: {
      name: "local-coding-agent",
      url: base ? `${base}/mcp` : "",
      transport: "Streamable HTTP",
      auth: "Bearer token",
      prefix: "Bearer",
      token,
      description: "",
    },
    instruction: readInstruction(dir),
  };
}

async function stopAll() {
  const dir = agentDir;
  const port = readPort(dir);
  const procs = await listAgentProcesses(dir, port);
  killPids([...procs.server, ...procs.tunnel].map((p) => p.pid));
  for (const f of [".server_pid", ".cf_pid", ".public_url"]) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* */
    }
  }
  publicOk = null;
  await sleep(800);
}

async function startAll() {
  const dir = agentDir;
  if (!fs.existsSync(path.join(dir, "server.py"))) {
    throw new Error(`server.py не найден в ${dir}. Укажи папку агента.`);
  }
  if (!readToken(dir)) {
    throw new Error(`MCP_TOKEN не задан в ${path.join(dir, ".env")}`);
  }
  const port = readPort(dir);

  // Чистый старт: гасим старые процессы этого агента (дубли server.py ломают /health).
  await stopAll();

  // 1) MCP-сервер
  const srv = await spawnPersistent(
    pythonPath(dir),
    ["server.py"],
    dir,
    path.join(dir, "server.log"),
    path.join(dir, "server.err.log")
  );
  if (!srv.ok) throw new Error(`Не удалось запустить Python: ${srv.error}`);
  try {
    fs.writeFileSync(path.join(dir, ".server_pid"), String(srv.pid || ""));
  } catch {
    /* */
  }

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(500);
    up = await getUrl(`http://127.0.0.1:${port}/health`, 1500);
  }
  if (!up) throw new Error(`Сервер не ответил на /health за 20с. Смотри ${path.join(dir, "server.err.log")}`);

  // 2) Cloudflare quick tunnel (URL меняется при каждом запуске)
  const cfLog = path.join(dir, "cloudflared.err.log");
  // старый URL в логе не должен подхватиться как новый
  try {
    fs.writeFileSync(cfLog, "");
  } catch {
    /* */
  }
  const cf = await spawnPersistent(
    cloudflaredPath(dir),
    ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"],
    dir,
    path.join(dir, "cloudflared.log"),
    cfLog
  );
  if (!cf.ok) throw new Error(`cloudflared не запустился: ${cf.error}`);

  let base = null;
  for (let i = 0; i < 60 && !base; i++) {
    await sleep(500);
    base = lastTunnelUrl(dir);
  }
  if (!base) throw new Error(`Туннель не выдал URL за 30с. Смотри ${cfLog}`);
  try {
    fs.writeFileSync(path.join(dir, ".public_url"), base);
    fs.writeFileSync(path.join(dir, ".cf_pid"), String(cf.pid || ""));
  } catch {
    /* */
  }

  // 3) Проверка снаружи (DNS trycloudflare поднимается несколько секунд)
  publicOk = false;
  for (let i = 0; i < 10 && !publicOk; i++) {
    await sleep(1500);
    publicOk = await getUrl(`${base}/health`, 4000);
  }
}

// ---------- IPC ----------
function registerLocalAgentHandlers(ipcMain, getUserDataPath) {
  loadSettings(getUserDataPath());

  const cfg = () => ({ ok: true, agentDir, exists: fs.existsSync(path.join(agentDir, "server.py")) });

  ipcMain.handle("localAgent:getConfig", async () => cfg());

  ipcMain.handle("localAgent:setDir", async (_e, dir) => {
    if (typeof dir === "string" && dir.trim()) {
      agentDir = dir.trim();
      saveSettings();
    }
    return cfg();
  });

  ipcMain.handle("localAgent:pickDir", async () => {
    const { dialog, BrowserWindow } = require("electron");
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, {
      title: "Папка local-coding-agent (где лежит server.py)",
      defaultPath: agentDir,
      properties: ["openDirectory"],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    agentDir = res.filePaths[0];
    saveSettings();
    return cfg();
  });

  ipcMain.handle("localAgent:status", async () => ({ ok: true, state: await buildState() }));

  ipcMain.handle("localAgent:start", async () => {
    if (busy) return { ok: false, error: "Уже запускается", state: await buildState() };
    busy = true;
    lastError = null;
    try {
      await startAll();
      busy = false;
      return { ok: true, state: await buildState() };
    } catch (e) {
      lastError = e.message || String(e);
      busy = false;
      return { ok: false, error: lastError, state: await buildState() };
    }
  });

  ipcMain.handle("localAgent:stop", async () => {
    lastError = null;
    await stopAll();
    return { ok: true, state: await buildState() };
  });
}

module.exports = { registerLocalAgentHandlers, spawnPersistent };
