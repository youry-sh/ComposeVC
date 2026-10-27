const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const store = require("../store.cjs");

/**
 * Blender plugin bridge (first ComposeVC plugin).
 *
 * Detection: explicit config path → env vars → PATH → platform install dirs →
 * Steam / snap / flatpak locations. Version is read with `--version`.
 *
 * Execution: `blender --background --factory-startup --python driver.py --
 * --plan plan.json --out <jobDir>`. The Python driver builds the scene, renders
 * stills, bakes materials and exports game-ready files; it writes result.json,
 * which this module turns into a compact job record. stdout is streamed to
 * log.txt and parsed for progress markers.
 */

const PLUGIN_ID = "blender";
const DRIVER = path.join(__dirname, "driver.py");
const active = new Map();
const detectCache = new Map();
const probeCache = new Map();
let progressSink = null;

/** Main wires this to broadcast `plugins:job` so the Plugins tab streams live progress. */
function setProgressSink(sink) {
  progressSink = typeof sink === "function" ? sink : null;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function whichBlender() {
  const command = process.platform === "win32" ? "where" : "which";
  const arg = process.platform === "win32" ? ["blender"] : ["blender"];
  try {
    const output = execFileSync(command, arg, {
      timeout: 6000,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function versionWeight(name) {
  const match = String(name).match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return 0;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 0);
}

function windowsCandidates() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
  ].filter(Boolean);
  const found = [];
  for (const root of roots) {
    const foundation = path.join(root, "Blender Foundation");
    let entries = [];
    try {
      entries = fs.readdirSync(foundation, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => versionWeight(b) - versionWeight(a));
    for (const dir of dirs) found.push(path.join(foundation, dir, "blender.exe"));
    found.push(path.join(foundation, "Blender", "blender.exe"));
  }
  // Steam
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
    found.push(path.join(root, "Steam", "steamapps", "common", "Blender", "blender.exe"));
  }
  // Scoop
  if (process.env.USERPROFILE) {
    found.push(path.join(process.env.USERPROFILE, "scoop", "apps", "blender", "current", "blender.exe"));
  }
  return found;
}

function unixCandidates() {
  const found = [
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
    "/opt/blender/blender",
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/Applications/Blender/Blender.app/Contents/MacOS/Blender",
  ];
  for (const dir of ["/opt", "/usr/local", os.homedir()]) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/^blender/i.test(entry.name)) continue;
        found.push(path.join(dir, entry.name, "blender"));
        found.push(path.join(dir, entry.name, "blender-launcher"));
      }
    } catch {
      /* ignore unreadable dirs */
    }
  }
  try {
    const flatpakRoot = path.join(os.homedir(), ".local", "share", "flatpak", "app", "org.blender.Blender");
    found.push(path.join(flatpakRoot, "current", "active", "files", "bin", "blender"));
  } catch {
    /* ignore */
  }
  return found;
}

function executableCandidates(config) {
  const list = [];
  const explicit = String(config?.executable || "").trim();
  if (explicit) list.push(explicit);
  for (const key of ["CV_BLENDER_EXE", "BLENDER_EXE", "BLENDER_PATH", "BLENDER_BIN"]) {
    const value = process.env[key];
    if (value) list.push(value);
  }
  if (process.env.BLENDER_HOME) {
    list.push(path.join(process.env.BLENDER_HOME, process.platform === "win32" ? "blender.exe" : "blender"));
  }
  list.push(...whichBlender());
  list.push(...(process.platform === "win32" ? windowsCandidates() : unixCandidates()));
  const seen = new Set();
  const unique = [];
  for (const candidate of list) {
    const clean = String(candidate || "").trim().replace(/^"|"$/g, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

function readVersion(executable) {
  const key = `${executable}::${(() => {
    try {
      return Math.round(fs.statSync(executable).mtimeMs);
    } catch {
      return 0;
    }
  })()}`;
  const cached = detectCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached;
  let version = "";
  let error = "";
  try {
    const output = execFileSync(executable, ["--version"], {
      timeout: 25000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = String(output).match(/Blender\s+([\d.]+)/i);
    version = match ? match[1] : "";
    if (!version) version = String(output).split(/\r?\n/)[0].trim().slice(0, 40);
  } catch (err) {
    error = err?.message || String(err);
    const stdout = err?.stdout ? String(err.stdout) : "";
    const match = stdout.match(/Blender\s+([\d.]+)/i);
    if (match) {
      version = match[1];
      error = "";
    }
  }
  const result = { executable, version, error, at: Date.now() };
  detectCache.set(key, result);
  return result;
}

function detect(config) {
  const candidates = executableCandidates(config);
  const checked = [];
  for (const candidate of candidates) {
    if (!isFile(candidate)) {
      checked.push({ path: candidate, ok: false });
      continue;
    }
    const info = readVersion(candidate);
    checked.push({ path: candidate, ok: !info.error, version: info.version, error: info.error });
    if (!info.error) {
      return {
        found: true,
        executable: candidate,
        version: info.version,
        source: candidate === String(config?.executable || "").trim() ? "config" : "auto",
        checked,
        error: "",
      };
    }
  }
  return {
    found: false,
    executable: "",
    version: "",
    source: "none",
    checked,
    error: candidates.length
      ? "Blender не найден ни по одному известному пути. Укажите путь к blender.exe в настройках плагина (вкладка Plugins) или установите Blender: https://www.blender.org/download/"
      : "Blender не найден. Установите Blender (https://www.blender.org/download/) или укажите путь вручную.",
  };
}

function requireBlender(config) {
  const info = detect(config);
  if (!info.found) {
    const error = new Error(info.error);
    error.code = "BLENDER_NOT_FOUND";
    error.checked = info.checked;
    throw error;
  }
  return info;
}

function tailAppend(buffer, chunk, limit = 24000) {
  const next = buffer + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

function summarizeResult(result, parsed) {
  const stats = result?.stats || {};
  const parts = [];
  if (stats.objects) parts.push(`${stats.objects} объектов`);
  if (stats.polygons) parts.push(`${Number(stats.polygons).toLocaleString("ru-RU")} полигонов`);
  if (stats.materials) parts.push(`${stats.materials} материалов`);
  if (Array.isArray(result?.renders) && result.renders.length) parts.push(`${result.renders.length} рендер(ов)`);
  if (Array.isArray(result?.bakes) && result.bakes.length) parts.push(`${result.bakes.length} текстур`);
  if (Array.isArray(result?.exports) && result.exports.length) {
    parts.push(result.exports.map((item) => item.format).join("/"));
  }
  if (!parts.length && parsed?.error) parts.push(parsed.error);
  return parts.join(" · ");
}

function existingArtifact(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { path: filePath, bytes: stat.size } : null;
  } catch {
    return null;
  }
}

async function execute(userDataPath, job, executable, args, options = {}) {
  const logStream = fs.createWriteStream(job.logPath, { flags: "w" });
  const timeoutSec = Math.max(10, Number(options.timeoutSec) || 900);
  let stdoutTail = "";
  let stderrTail = "";
  let canceled = false;
  let timedOut = false;
  let resultPayload = null;
  let lastProgress = 0;
  let spawnError = null;
  let writeChain = Promise.resolve();

  const child = spawn(executable, args, {
    cwd: job.dir,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  });
  active.set(job.id, { child, cancel: () => { canceled = true; killTree(child); } });

  let abortListener = null;
  if (options.signal) {
    abortListener = () => {
      canceled = true;
      killTree(child);
    };
    try {
      if (options.signal.aborted) abortListener();
      else options.signal.addEventListener("abort", abortListener, { once: true });
    } catch {
      /* ignore */
    }
  }

  const emitProgress = (stage, percent) => {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    if (value === lastProgress && stage === options.lastStage) return;
    lastProgress = value;
    options.lastStage = stage;
    const payload = { jobId: job.id, pluginId: PLUGIN_ID, stage, percent: value, status: "running" };
    try {
      if (typeof options.onProgress === "function") options.onProgress(payload);
    } catch {
      /* renderer gone */
    }
    try {
      if (progressSink) progressSink(payload);
    } catch {
      /* sink listener failed */
    }
  };

  const consumeLine = (line) => {
    if (!line) return;
    if (line.startsWith("CVJOB ")) {
      try {
        const payload = JSON.parse(line.slice(6));
        emitProgress(payload.stage || "working", payload.percent);
        if (payload.stage) {
          // Serialise disk writes so a late progress marker can never overwrite
          // the final status written after the process exits.
          writeChain = writeChain
            .then(() => store.updateJob(userDataPath, job.id, { stage: payload.stage, progress: payload.percent }))
            .catch(() => {});
        }
      } catch {
        /* ignore malformed marker */
      }
      return;
    }
    if (line.startsWith("CVRESULT ")) {
      try {
        resultPayload = JSON.parse(line.slice(9));
      } catch {
        /* ignore */
      }
    }
  };

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    stdoutTail = tailAppend(stdoutTail, text);
    stdoutBuffer += text;
    let index = stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      consumeLine(stdoutBuffer.slice(0, index).replace(/\r$/, ""));
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      index = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    logStream.write(text);
    stderrTail = tailAppend(stderrTail, text);
  });
  child.on("error", (err) => {
    spawnError = err;
    stderrTail = tailAppend(stderrTail, String(err?.stack || err?.message || err));
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, timeoutSec * 1000);

  const exit = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code == null ? -1 : code));
  });
  clearTimeout(timer);
  active.delete(job.id);
  if (abortListener && options.signal) {
    try {
      options.signal.removeEventListener("abort", abortListener);
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => {
    logStream.end(resolve);
  });

  let driverResult = null;
  try {
    const raw = await fs.promises.readFile(path.join(job.dir, "result.json"), "utf8");
    driverResult = JSON.parse(raw);
  } catch {
    driverResult = null;
  }

  const ok = !spawnError && !timedOut && !canceled && exit === 0 && (!driverResult || driverResult.ok !== false);
  let error = "";
  if (spawnError) error = spawnError.message || String(spawnError);
  else if (timedOut) error = `Blender не завершился за ${timeoutSec} с и был остановлен.`;
  else if (canceled) error = "Задача отменена.";
  else if (driverResult && driverResult.ok === false) error = driverResult.error || "Blender driver: неизвестная ошибка";
  else if (exit !== 0) {
    const lines = stderrTail.split(/\r?\n/).filter(Boolean);
    error = lines.slice(-6).join("\n") || `Blender завершился с кодом ${exit}.`;
  }

  const warnings = Array.isArray(driverResult?.warnings) ? driverResult.warnings : [];
  const renders = Array.isArray(driverResult?.renders)
    ? driverResult.renders
        .map((item) => {
          const file = existingArtifact(item.path);
          return file ? { name: item.name || path.basename(item.path), path: file.path } : null;
        })
        .filter(Boolean)
    : [];
  const exportsList = Array.isArray(driverResult?.exports)
    ? driverResult.exports
        .map((item) => {
          const file = existingArtifact(item.path);
          return file ? { format: item.format || path.extname(item.path).slice(1).toUpperCase(), path: file.path, bytes: file.size } : null;
        })
        .filter(Boolean)
    : [];
  const bakes = Array.isArray(driverResult?.bakes)
    ? driverResult.bakes
        .map((item) => {
          const file = existingArtifact(item.path);
          return file ? { name: item.name || path.basename(item.path), path: file.path } : null;
        })
        .filter(Boolean)
    : [];
  const blendPath = driverResult?.blendPath && existingArtifact(driverResult.blendPath) ? driverResult.blendPath : "";
  const preview = renders[0]?.path || (existingArtifact(path.join(job.dir, "preview.png"))?.path ?? "");

  const finishedAt = Date.now();
  await writeChain.catch(() => {});
  const updated = await store.updateJob(userDataPath, job.id, {
    status: ok ? "succeeded" : canceled ? "canceled" : "failed",
    progress: ok ? 100 : lastProgress,
    stage: ok ? "done" : timedOut ? "timeout" : "failed",
    finishedAt,
    durationMs: finishedAt - (job.startedAt || job.createdAt || finishedAt),
    blendPath,
    previewPath: preview,
    renders,
    bakes,
    exports: exportsList,
    warnings,
    error,
    addons: Array.isArray(driverResult?.addons)
      ? driverResult.addons.map((entry) => ({
          path: entry?.path || "",
          kind: entry?.kind || "addon",
          module: entry?.module || (Array.isArray(entry?.modules) ? entry.modules[0] || "" : ""),
          enabled: Boolean(entry?.enabled || (Array.isArray(entry?.modules) && entry.modules.length)),
          installed: Boolean(entry?.installed),
          error: entry?.error || (Array.isArray(entry?.errors) ? entry.errors[0] || "" : ""),
        }))
      : [],
    quality: driverResult?.stats?.meshes ? driverResult.quality || null : null,
    summary: summarizeResult(driverResult, resultPayload),
    stats: driverResult?.stats?.objectsDetail ? driverResult.stats : driverResult?.stats || {},
    blender: {
      path: executable,
      version: options.version || "",
      engine: driverResult?.engine || "",
    },
  });

  try {
    const plugin = await store.getPlugin(userDataPath, PLUGIN_ID);
    await store.updatePlugin(userDataPath, PLUGIN_ID, {
      stats: {
        runs: (plugin?.stats?.runs || 0) + 1,
        failures: (plugin?.stats?.failures || 0) + (ok ? 0 : 1),
        lastRunAt: finishedAt,
        lastError: ok ? "" : String(error).slice(0, 700),
      },
    });
  } catch {
    /* stats are best effort */
  }

  try {
    if (progressSink) {
      progressSink({
        jobId: updated.id,
        pluginId: PLUGIN_ID,
        status: updated.status,
        stage: updated.stage,
        percent: updated.progress,
        done: true,
        error: updated.error || "",
      });
    }
  } catch {
    /* sink listener failed */
  }

  return {
    ...updated,
    logTail: stdoutTail.slice(-6000),
    stderrTail: stderrTail.slice(-6000),
    driverResult,
    checked: false,
  };
}

function safeAddonName(value) {
  let base = "addon";
  try {
    base = path.basename(new URL(String(value)).pathname).replace(/\.zip$/i, "");
  } catch {
    base = path.basename(String(value || "addon")).replace(/\.zip$/i, "");
  }
  return base.replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || "addon";
}

/**
 * Scene plans may reference add-on archives by URL or extensions.blender.org id;
 * download them into the add-ons folder before the driver needs a local path.
 */
async function preparePlanAddons(userDataPath, plan) {
  const entries = Array.isArray(plan?.install_addons) ? plan.install_addons : [];
  if (!entries.length) return;
  const addonsLib = require("./addons.cjs");
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || entry.path) continue;
    const url = entry.url || entry.archive_url || "";
    const pkg = entry.pkg_id || entry.id || entry.package || "";
    try {
      let archive = null;
      if (url) {
        const target = path.join(addonsLib.addonsDir(userDataPath), `${safeAddonName(url)}.zip`);
        archive = await addonsLib.downloadFile(String(url), target);
      } else if (pkg) {
        const resolved = await addonsLib.resolveExtension(String(pkg));
        archive = await addonsLib.downloadAddonArchive(userDataPath, resolved);
      }
      if (archive?.path) entry.path = archive.path;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }
}

async function runPlan(userDataPath, config, plan, options = {}) {
  const blender = requireBlender(config);
  const mergedPlan = { ...(plan || {}) };
  const configuredAddons = Array.isArray(config?.addons)
    ? config.addons.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (configuredAddons.length) {
    const disabled = new Set(
      (Array.isArray(mergedPlan.disable_addons) ? mergedPlan.disable_addons : []).map((entry) => String(entry || ""))
    );
    const existingEntries = Array.isArray(mergedPlan.addons) ? mergedPlan.addons : [];
    const existing = new Set(
      existingEntries.map((entry) => (typeof entry === "string" ? entry : entry?.module ? String(entry.module) : "")).filter(Boolean)
    );
    const missing = configuredAddons.filter((module) => !existing.has(module) && !disabled.has(module));
    if (missing.length) {
      mergedPlan.addons = [...existingEntries, ...missing.map((module) => ({ module, enable: true }))];
    }
  }
  await preparePlanAddons(userDataPath, mergedPlan);
  const job = await store.createJob(userDataPath, {
    pluginId: PLUGIN_ID,
    kind: options.kind || "scene",
    title: String(options.title || mergedPlan?.name || mergedPlan?.title || "Blender scene"),
  });
  const planPath = path.join(job.dir, "plan.json");
  await fs.promises.writeFile(planPath, JSON.stringify(mergedPlan, null, 2), "utf8");
  const startedAt = Date.now();
  let current = await store.updateJob(userDataPath, job.id, {
    status: "running",
    startedAt,
    stage: "starting",
    progress: 0,
    blender: { path: blender.executable, version: blender.version, engine: "" },
  });
  const args = [];
  if (config?.factoryStartup !== false) args.push("--factory-startup");
  args.push("-b", "--python-exit-code", "3", "--python", DRIVER, "--", "--plan", planPath, "--out", job.dir);
  current = await execute(userDataPath, current, blender.executable, args, {
    timeoutSec: config?.timeoutSec || 900,
    onProgress: options.onProgress,
    signal: options.signal,
    version: blender.version,
  });
  await store.pruneJobs(userDataPath, store.MAX_JOBS).catch(() => {});
  return current;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const EXPORT_EXTS = {
  ".glb": "GLB",
  ".gltf": "GLTF",
  ".fbx": "FBX",
  ".obj": "OBJ",
  ".usd": "USD",
  ".usdc": "USD",
  ".usdz": "USD",
  ".stl": "STL",
  ".ply": "PLY",
};

async function collectJobArtifacts(jobDir) {
  const renders = [];
  const bakes = [];
  const exportsList = [];
  let blendPath = "";
  async function walk(folder) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const rel = path.relative(jobDir, full).replace(/\\/g, "/");
      if (IMAGE_EXTS.has(ext)) {
        const record = { name: entry.name, path: full };
        if (/(^|\/)textures\//i.test(rel) || /^cvbake_/i.test(entry.name)) bakes.push(record);
        else renders.push(record);
        continue;
      }
      if (ext === ".blend") {
        if (!blendPath || entry.name.toLowerCase() === "scene.blend") blendPath = full;
        continue;
      }
      const format = EXPORT_EXTS[ext];
      if (format) {
        let bytes = 0;
        try {
          bytes = (await fs.promises.stat(full)).size;
        } catch {
          bytes = 0;
        }
        exportsList.push({ format, path: full, bytes });
      }
    }
  }
  await walk(jobDir);
  renders.sort((a, b) => a.path.localeCompare(b.path));
  bakes.sort((a, b) => a.path.localeCompare(b.path));
  exportsList.sort((a, b) => a.path.localeCompare(b.path));
  return {
    renders,
    bakes,
    exports: exportsList,
    blendPath,
    previewPath: renders[0]?.path || "",
  };
}

async function runPython(userDataPath, config, code, options = {}) {
  const blender = requireBlender(config);
  const script = String(code || "").trim();
  if (!script) throw new Error("Пустой python-скрипт.");
  const job = await store.createJob(userDataPath, {
    pluginId: PLUGIN_ID,
    kind: "python",
    title: String(options.title || "Blender python"),
  });
  const scriptPath = path.join(job.dir, "script.py");
  await fs.promises.writeFile(scriptPath, script, "utf8");
  const startedAt = Date.now();
  let current = await store.updateJob(userDataPath, job.id, {
    status: "running",
    startedAt,
    stage: "starting",
    progress: 0,
    blender: { path: blender.executable, version: blender.version, engine: "" },
  });
  const args = [];
  if (config?.factoryStartup !== false) args.push("--factory-startup");
  args.push("-b", "--python-exit-code", "3", "--python", scriptPath, "--", "--out", job.dir);
  current = await execute(userDataPath, current, blender.executable, args, {
    timeoutSec: config?.timeoutSec || 900,
    onProgress: options.onProgress,
    signal: options.signal,
    version: blender.version,
  });
  const artifacts = await collectJobArtifacts(current.dir);
  const parts = [];
  if (artifacts.renders.length) parts.push(`${artifacts.renders.length} рендер(ов)`);
  if (artifacts.exports.length) parts.push(artifacts.exports.map((item) => item.format).join("/"));
  if (artifacts.blendPath) parts.push(".blend");
  if (artifacts.bakes.length) parts.push(`${artifacts.bakes.length} текстур`);
  current = await store.updateJob(userDataPath, current.id, {
    renders: artifacts.renders,
    bakes: artifacts.bakes,
    exports: artifacts.exports,
    blendPath: artifacts.blendPath,
    previewPath: artifacts.previewPath || current.previewPath,
    summary: parts.length ? `Python: ${parts.join(" · ")}` : current.summary,
  });
  return current;
}

/**
 * Install / enable / disable Blender add-ons and extensions. The driver writes
 * into Blender's user addons/extensions folders; enabled module ids are stored
 * in the plugin config so every later job re-enables them automatically.
 */
async function runAddonJob(userDataPath, config, spec = {}, options = {}) {
  const plan = {
    name: String(spec.title || "Blender add-on"),
    reset: true,
    render: false,
    export: false,
    save: false,
    install_addons: [],
    addons: [],
    disable_addons: [],
  };
  if (spec.path) plan.install_addons.push({ path: String(spec.path), enable: spec.enable !== false });
  if (spec.module) {
    if (spec.enable === false) plan.disable_addons.push(String(spec.module));
    else plan.addons.push({ module: String(spec.module), enable: true });
  }
  for (const module of spec.disable || []) plan.disable_addons.push(String(module));
  if (!plan.install_addons.length && !plan.addons.length && !plan.disable_addons.length) {
    throw new Error("Не указан аддон: передайте path (zip), module или pkg_id.");
  }
  const job = await runPlan(userDataPath, { ...config, addons: [] }, plan, {
    kind: "addon",
    title: plan.name,
    onProgress: options.onProgress,
    signal: options.signal,
  });
  const reports = Array.isArray(job.driverResult?.addons) ? job.driverResult.addons : [];
  const enabled = [];
  for (const report of reports) {
    if (report?.module && (report.enabled || report.installed)) enabled.push(String(report.module));
    for (const module of report?.modules || []) if (module) enabled.push(String(module));
  }
  const disabled = (spec.disable || []).concat(spec.module && spec.enable === false ? [spec.module] : []);
  if (job.status === "succeeded" && (enabled.length || disabled.length)) {
    const current = Array.isArray(config?.addons) ? config.addons : [];
    const next = Array.from(new Set([...current.filter((module) => !disabled.includes(module)), ...enabled])).slice(0, 60);
    const plugin = await store.getPlugin(userDataPath, PLUGIN_ID);
    if (plugin) {
      await store.updatePlugin(userDataPath, PLUGIN_ID, {
        config: { ...plugin.config, addons: next },
      });
    }
  }
  return { ...job, addonsEnabled: Array.from(new Set(enabled)) };
}

async function probe(userDataPath, config) {
  const blender = requireBlender(config);
  const modules = Array.isArray(config?.addons)
    ? config.addons.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const cacheKey = `${blender.executable}::${blender.version}::${modules.join(",")}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cv-blender-probe-"));
  try {
    const modulesPath = path.join(dir, "addons.json");
    await fs.promises.writeFile(modulesPath, JSON.stringify(modules), "utf8");
    const args = [
      "--factory-startup",
      "-b",
      "--python-exit-code",
      "3",
      "--python",
      DRIVER,
      "--",
      "--probe",
      "--out",
      dir,
      "--check-addons",
      modulesPath,
    ];
    execFileSync(blender.executable, args, {
      timeout: 120000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.promises.readFile(path.join(dir, "result.json"), "utf8"));
    } catch {
      parsed = null;
    }
    const value = {
      ok: Boolean(parsed?.ok),
      executable: blender.executable,
      version: parsed?.blenderVersion || blender.version,
      engines: Array.isArray(parsed?.engines) ? parsed.engines : [],
      operators: parsed?.operators || {},
      addons: Array.isArray(parsed?.addons) ? parsed.addons.slice(0, 60) : [],
      addonChecks: Array.isArray(parsed?.addonChecks) ? parsed.addonChecks : [],
      userAddons: parsed?.userAddons || "",
      userExtensions: parsed?.userExtensions || "",
    };
    probeCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    return {
      ok: false,
      executable: blender.executable,
      version: blender.version,
      engines: [],
      operators: {},
      addons: [],
      addonChecks: modules.map((module) => ({
        module,
        requested: module,
        enabled: false,
        installed: false,
        error: "probe failed",
      })),
      userAddons: "",
      userExtensions: "",
      error: err?.stderr ? String(err.stderr).slice(-2000) : err?.message || String(err),
    };
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function cancelJob(jobId) {
  const entry = active.get(String(jobId));
  if (!entry) return { canceled: false, reason: "not-running" };
  entry.cancel();
  return { canceled: true };
}

function listRunning() {
  return Array.from(active.keys());
}

async function readPreviewDataUrl(userDataPath, jobId, name) {
  const job = await store.getJob(userDataPath, jobId);
  if (!job) throw new Error("Задача не найдена.");
  let file = "";
  if (name) {
    const candidate = path.join(job.dir, path.basename(String(name)));
    if (candidate.startsWith(job.dir) && isFile(candidate)) file = candidate;
  }
  if (!file && job.previewPath && isFile(job.previewPath)) file = job.previewPath;
  if (!file) {
    const found = job.renders.find((render) => isFile(render.path));
    if (found) file = found.path;
  }
  if (!file) throw new Error("У задачи нет превью.");
  const stat = await fs.promises.stat(file);
  if (stat.size > 24 * 1024 * 1024) throw new Error("Превью слишком большое.");
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const base64 = (await fs.promises.readFile(file)).toString("base64");
  return { dataUrl: `data:${mime};base64,${base64}`, path: file, bytes: stat.size };
}

async function openInBlender(config, blendPath) {
  const blender = requireBlender(config);
  const target = String(blendPath || "").trim();
  if (!target || !isFile(target)) throw new Error("Файл .blend не найден.");
  const child = spawn(blender.executable, [target], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
  return { ok: true, executable: blender.executable, file: target };
}

async function deleteJob(userDataPath, jobId) {
  const entry = active.get(String(jobId));
  if (entry) throw new Error("Нельзя удалить выполняющуюся задачу.");
  return store.deleteJob(userDataPath, jobId);
}

function isBlenderInstalled(config) {
  return detect(config);
}

module.exports = {
  PLUGIN_ID,
  DRIVER,
  setProgressSink,
  detect,
  probe,
  isBlenderInstalled,
  runPlan,
  runPython,
  runAddonJob,
  cancelJob,
  listRunning,
  readPreviewDataUrl,
  openInBlender,
  deleteJob,
  requireBlender,
};
