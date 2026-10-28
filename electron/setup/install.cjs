const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const registry = require("./registry.cjs");
const detect = require("./detect.cjs");
const store = require("./store.cjs");
const setupPaths = require("./paths.cjs");
const { downloadFile } = require("./download.cjs");

/**
 * Installer for the Setup tab.
 *
 * Rules:
 *  - one job per component, one install running at a time (package managers
 *    share locks; parallel apt-get/winget runs break each other);
 *  - an already installed component is never re-installed — detection decides;
 *  - success is only reported after a fresh detection finds the binary;
 *  - sudo is always `sudo -n`; when it is refused the exact manual command is
 *    returned instead of a generic failure;
 *  - every state change is streamed on `setup:progress` and appended to
 *    <userData>/setup/install.log.
 */

const INSTALL_ORDER = ["python", "git", "websearch", "go", "rust", "blender"];
const MAX_LOG_LINES = 600;
const ACTIVE_STATES = new Set(["queued", "checking", "downloading", "installing"]);

const jobs = new Map();
let queue = Promise.resolve();

/* ── helpers ─────────────────────────────────────────────────────────────── */

function broadcast(channel, payload) {
  try {
    const { webContents } = require("electron");
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (!contents.isDestroyed()) contents.send(channel, payload);
      } catch {
        /* window closed mid-send */
      }
    }
  } catch {
    /* not running inside Electron (tests / CLI) */
  }
}

function appendLogFile(userDataPath, line) {
  try {
    setupPaths.ensureSetupDir(userDataPath);
    fs.appendFileSync(setupPaths.logPath(userDataPath), `${line}\n`, "utf8");
  } catch {
    /* logging must never break an install */
  }
}

function createJob(userDataPath, id) {
  return {
    id,
    userDataPath,
    state: "queued",
    step: "В очереди…",
    log: [],
    percent: null,
    error: null,
    version: null,
    path: null,
    manualCommands: [],
    cancelled: false,
    timedOut: false,
    child: null,
    controller: null,
    startedAt: Date.now(),
    finishedAt: null,
    promise: null,
    lastPublish: 0,
  };
}

function logLine(job, line) {
  const text = String(line || "").replace(/\s+$/g, "");
  if (!text) return;
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
  job.log.push(stamped);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  appendLogFile(job.userDataPath, `${job.id} ${stamped}`);
}

function jobPayload(job) {
  return {
    id: job.id,
    state: job.state === "queued" ? "checking" : job.state,
    step: job.step,
    log: job.log.slice(-25),
    percent: job.percent,
    error: job.error,
    version: job.version,
    path: job.path,
  };
}

function publish(job, force = false) {
  const nowMs = Date.now();
  if (!force && nowMs - job.lastPublish < 400) return;
  job.lastPublish = nowMs;
  broadcast("setup:progress", jobPayload(job));
}

function tapOutput(job, output) {
  const lines = String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines.slice(-8)) logLine(job, `  ${line.slice(0, 300)}`);
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 1500).unref?.();
  } catch {
    /* process may have exited between checks */
  }
}

function runCommand(job, bin, args, { sudo = false, timeoutMs = 30 * 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    const command = sudo ? "sudo" : bin;
    const argv = sudo ? ["-n", bin, ...args] : args;
    let child = null;
    try {
      child = spawn(command, argv, {
        windowsHide: true,
        cwd,
        shell: false,
        env: {
          ...process.env,
          DEBIAN_FRONTEND: "noninteractive",
          GIT_TERMINAL_PROMPT: "0",
          PIP_DISABLE_PIP_VERSION_CHECK: "1",
        },
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    job.child = child;
    let out = "";
    let lastStreamAt = 0;
    const timer = setTimeout(() => {
      job.timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onData = (chunk) => {
      out += chunk.toString();
      if (out.length > 40_000) out = out.slice(-40_000);
      const nowMs = Date.now();
      if (nowMs - lastStreamAt < 500) return;
      lastStreamAt = nowMs;
      const line = out.split(/\r?\n/).filter(Boolean).pop();
      if (line) {
        job.step = line.trim().slice(0, 200);
        publish(job);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      job.child = null;
      resolve({ ok: false, code: -1, output: `${out}\n${error.message}`.slice(-8000) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      job.child = null;
      resolve({ ok: code === 0 && !job.cancelled, code, output: out.slice(-8000) });
    });
  });
}

function queueTask(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function jobView(id) {
  const job = jobs.get(String(id || ""));
  if (!job) return null;
  return {
    ...jobPayload(job),
    state: job.state === "queued" ? "checking" : job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/* ── install steps ───────────────────────────────────────────────────────── */

async function preparePip(userDataPath, job) {
  const python = await detect.detectComponent(userDataPath, "python", { force: true });
  if (!python.installed) return { method: "none", error: "Python не найден" };
  const bin = python.path || (detect.platform() === "win" ? "python" : "python3");
  const isLauncher = /(^|[\\/])py(\.exe)?$/i.test(bin);
  const args = [...(isLauncher ? ["-3"] : []), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"];
  job.state = "installing";
  job.percent = null;
  job.step = `${path.basename(bin)} -m pip install --upgrade pip setuptools wheel`;
  publish(job, true);
  logLine(job, job.step);
  const result = await runCommand(job, bin, args, { timeoutMs: 15 * 60_000 });
  tapOutput(job, result.output);
  logLine(job, `pip завершился с кодом ${result.code}`);
  return { method: "pip", ok: result.ok, error: result.ok ? null : `pip завершился с кодом ${result.code}` };
}

async function downloadAndRun(userDataPath, fallback, job) {
  job.state = "downloading";
  job.percent = 0;
  job.step = `Загрузка ${fallback.file}`;
  publish(job, true);
  logLine(job, `скачивание: ${fallback.url}`);
  job.controller = new AbortController();
  let lastPercent = -1;
  try {
    const downloaded = await downloadFile(fallback.url, setupPaths.downloadsDir(userDataPath), fallback.file, {
      signal: job.controller.signal,
      sha512: fallback.sha512,
      size: fallback.size,
      onProgress: ({ percent }) => {
        if (percent === null || percent === lastPercent) return;
        lastPercent = percent;
        job.percent = percent;
        job.step = `Загрузка ${fallback.file} · ${percent}%`;
        publish(job);
      },
    });
    logLine(job, `загружено: ${downloaded.path}`);
    if (job.cancelled) return { method: "download", cancelled: true };

    job.state = "installing";
    job.percent = null;
    job.step = `Запуск ${path.basename(downloaded.path)}`;
    publish(job, true);

    let result;
    if (fallback.run) {
      result = await runCommand(job, fallback.run, [downloaded.path, ...(fallback.args || [])]);
    } else if (detect.platform() === "win") {
      result = await runCommand(job, downloaded.path, fallback.args || []);
    } else {
      result = await runCommand(job, "sh", [downloaded.path, ...(fallback.args || [])]);
    }
    tapOutput(job, result.output);
    logLine(job, `установщик завершился с кодом ${result.code}`);
    return { method: "download", ok: result.ok, installerPath: downloaded.path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logLine(job, `установка из загруженного файла не удалась: ${message}`);
    return { method: "download", error: message };
  } finally {
    job.percent = null;
    job.controller = null;
  }
}

async function runInstallSteps(userDataPath, component, job) {
  const plat = detect.platform();
  if (component.prepare === "pip") return preparePip(userDataPath, job);

  const commands = component.install[plat] || [];
  let attempted = false;

  for (const spec of commands) {
    if (job.cancelled) return { method: "none", cancelled: true };
    if (!detect.which(spec.bin)) {
      logLine(job, `менеджер ${spec.bin} не найден`);
      continue;
    }
    attempted = true;
    job.state = "installing";
    job.percent = null;
    job.step = `${spec.sudo ? "sudo -n " : ""}${spec.bin} ${spec.args.join(" ")}`;
    publish(job, true);
    logLine(job, `запуск: ${job.step}`);

    const result = await runCommand(job, spec.bin, spec.args, { sudo: spec.sudo });
    if (job.cancelled) return { method: spec.bin, cancelled: true };

    if (result.ok) {
      logLine(job, `${spec.bin}: готово`);
      return { method: spec.sudo ? `${spec.bin} (sudo)` : spec.bin, ok: true };
    }

    tapOutput(job, result.output);
    if (spec.sudo) {
      const manual = `sudo ${spec.bin} ${spec.args.join(" ")}`;
      job.manualCommands.push(manual);
      if (/password|пароль|terminal is required|no tty|not a terminal|a password is required/i.test(result.output)) {
        logLine(job, `sudo отказал без пароля — выполните вручную: ${manual}`);
      } else {
        logLine(job, `${spec.bin} завершился с кодом ${result.code} — вручную: ${manual}`);
      }
    } else {
      logLine(job, `${spec.bin} завершился с кодом ${result.code}`);
    }
  }

  const fallback = component.fallback?.[plat];
  if (fallback) return downloadAndRun(userDataPath, fallback, job);

  if (!attempted) {
    return {
      method: "none",
      error: commands.length
        ? `Не найден менеджер пакетов (${[...new Set(commands.map((c) => c.bin))].join(", ")}).`
        : "Для этой ОС автоматическая установка недоступна.",
    };
  }
  return { method: "none" };
}

/* ── job orchestration ───────────────────────────────────────────────────── */

function buildManualHint(component, outcome, job) {
  const parts = [];
  if (outcome?.error) parts.push(outcome.error);
  if (job.manualCommands.length) {
    parts.push(`Выполните вручную:\n${[...new Set(job.manualCommands)].join("\n")}`);
  }
  if (component.manualUrl) parts.push(`Скачать вручную: ${component.manualUrl}`);
  if (!parts.length) parts.push("Автоматическая установка не завершилась — установите компонент вручную.");
  return parts.join("\n");
}

async function ensureDependency(userDataPath, depId) {
  let dep = await detect.detectComponent(userDataPath, depId, { force: true });
  if (dep.installed) return dep;

  const running = jobs.get(depId);
  if (running && ACTIVE_STATES.has(running.state)) {
    await running.promise;
    return detect.detectComponent(userDataPath, depId, { force: true });
  }

  const depJob = createJob(userDataPath, depId);
  jobs.set(depId, depJob);
  depJob.promise = runInstall(userDataPath, depId, depJob);
  await depJob.promise;
  return detect.detectComponent(userDataPath, depId, { force: true });
}

async function finishCancelled(userDataPath, job) {
  job.state = "error";
  job.step = "Установка отменена";
  job.error = "Установка отменена";
  job.finishedAt = Date.now();
  store.setComponent(userDataPath, job.id, {
    lastCheckAt: Date.now(),
    lastError: "Установка отменена",
  });
  publish(job, true);
  return { ok: false, cancelled: true, error: job.error, log: job.log.slice(-25) };
}

async function runInstall(userDataPath, id, job) {
  const component = registry.getComponent(id);
  logLine(job, `=== ${component?.name || id} ===`);

  if (job.cancelled) return finishCancelled(userDataPath, job);

  job.state = "checking";
  job.step = "Проверка установленных компонентов…";
  publish(job, true);

  let before;
  try {
    before = await detect.detectComponent(userDataPath, id, { force: true });
  } catch (error) {
    before = { installed: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (before.installed) {
    job.state = "already";
    job.step = `Уже установлено${before.version ? ` · v${before.version}` : ""}`;
    job.version = before.version || null;
    job.path = before.path || null;
    job.finishedAt = Date.now();
    store.setComponent(userDataPath, id, {
      installed: true,
      version: before.version || null,
      path: before.path || null,
      lastError: null,
      lastCheckAt: Date.now(),
    });
    logLine(job, `${job.step}${job.path ? ` (${job.path})` : ""}`);
    publish(job, true);
    return {
      ok: true,
      alreadyInstalled: true,
      version: job.version,
      path: job.path,
      method: "none",
      log: job.log.slice(-25),
      error: null,
    };
  }

  if (job.cancelled) return finishCancelled(userDataPath, job);

  const missing = [];
  for (const depId of component.dependsOn) {
    logLine(job, `зависимость: ${registry.getComponent(depId)?.name || depId}`);
    let dep = null;
    try {
      dep = await ensureDependency(userDataPath, depId);
    } catch {
      dep = null;
    }
    if (!dep?.installed) missing.push(registry.getComponent(depId)?.name || depId);
    if (job.cancelled) return finishCancelled(userDataPath, job);
  }

  if (missing.length) {
    const error = `Сначала установите ${missing.join(" и ")}`;
    job.state = "error";
    job.error = error;
    job.step = error;
    job.finishedAt = Date.now();
    logLine(job, error);
    store.setComponent(userDataPath, id, { lastCheckAt: Date.now(), lastError: error });
    publish(job, true);
    return { ok: false, error, missing, log: job.log.slice(-25) };
  }

  let outcome;
  try {
    outcome = await runInstallSteps(userDataPath, component, job);
  } catch (error) {
    outcome = { method: "none", error: error instanceof Error ? error.message : String(error) };
    logLine(job, `ошибка установки: ${outcome.error}`);
  }

  if (job.cancelled) return finishCancelled(userDataPath, job);

  let found = null;
  try {
    found = await detect.detectComponent(userDataPath, id, { force: true });
  } catch (error) {
    logLine(job, `повторная проверка не удалась: ${error instanceof Error ? error.message : error}`);
  }

  if (found?.installed) {
    job.state = "done";
    job.version = found.version || null;
    job.path = found.path || null;
    job.step = `Установлено${found.version ? ` · v${found.version}` : ""}`;
    job.error = null;
    job.finishedAt = Date.now();
    store.setComponent(userDataPath, id, {
      installed: true,
      version: found.version || null,
      path: found.path || null,
      method: outcome?.method || "system",
      lastError: null,
      lastCheckAt: Date.now(),
    });
    logLine(job, `${job.step}${job.path ? ` — ${job.path}` : ""}`);
    publish(job, true);
    return {
      ok: true,
      alreadyInstalled: false,
      version: job.version,
      path: job.path,
      method: outcome?.method || "system",
      log: job.log.slice(-25),
      error: null,
    };
  }

  const error = buildManualHint(component, outcome, job);
  job.state = "error";
  job.error = error;
  job.step = job.timedOut ? "Установка превысила лимит времени" : "Установка не завершилась";
  job.finishedAt = Date.now();
  logLine(job, error.replace(/\n/g, " | "));
  store.setComponent(userDataPath, id, {
    lastCheckAt: Date.now(),
    lastError: error,
    method: outcome?.method || null,
  });
  publish(job, true);
  return {
    ok: false,
    error,
    method: outcome?.method || "none",
    log: job.log.slice(-25),
    manualCommands: [...new Set(job.manualCommands)],
  };
}

/* ── public API ──────────────────────────────────────────────────────────── */

function installComponent(userDataPath, id, { wait = true } = {}) {
  const component = registry.getComponent(id);
  if (!component) {
    return Promise.resolve({ ok: false, error: `Неизвестный компонент: ${String(id || "")}` });
  }

  const existing = jobs.get(component.id);
  if (existing && ACTIVE_STATES.has(existing.state)) {
    if (wait) return existing.promise;
    return Promise.resolve({ ok: true, running: true, job: jobView(component.id) });
  }

  const job = createJob(userDataPath, component.id);
  jobs.set(component.id, job);
  publish(job, true);
  job.promise = queueTask(() => runInstall(userDataPath, component.id, job));

  if (!wait) return Promise.resolve({ ok: true, running: true, job: jobView(component.id) });
  return job.promise;
}

async function installAll(userDataPath) {
  const results = [];
  for (const id of INSTALL_ORDER) {
    let result;
    try {
      result = await installComponent(userDataPath, id, { wait: true });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    results.push({ id, ...result });
    if (result && result.cancelled) break;
  }
  return { ok: results.every((entry) => entry.ok || entry.alreadyInstalled), results };
}

function cancel(id) {
  const job = jobs.get(String(id || ""));
  if (!job || !ACTIVE_STATES.has(job.state)) {
    return { ok: false, error: "Нет активной установки для этого компонента" };
  }
  job.cancelled = true;
  try {
    job.controller?.abort();
  } catch {
    /* no active download */
  }
  if (job.child) killTree(job.child);
  job.step = "Отмена…";
  logLine(job, "отмена установки");
  publish(job, true);
  return { ok: true };
}

function activeJobs() {
  const out = {};
  for (const [id, job] of jobs) {
    if (!ACTIVE_STATES.has(job.state)) continue;
    out[id] = jobView(id);
  }
  return out;
}

module.exports = {
  INSTALL_ORDER,
  installComponent,
  installAll,
  cancel,
  jobView,
  activeJobs,
};
