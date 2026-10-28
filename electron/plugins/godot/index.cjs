const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const store = require("../store.cjs");

/**
 * Godot plugin bridge (second ComposeVC plugin).
 *
 * Detection: explicit config path → GODOT_BIN/GODOT/GODOT4 → PATH → platform
 * install dirs (LOCALAPPDATA, Program Files, scoop/choco, /usr/bin, flatpak,
 * /Applications).
 *
 * Execution: Godot itself is headless, so every operation is a plain spawn:
 *
 *   godot --headless --path <projectDir> --import
 *   godot --headless --path <projectDir> --export-release "<preset>" "<out>"
 *   godot --headless --path <projectDir> --quit-after <frames>
 *
 * Scenes are written as text `.tscn` resources (Node3D + MeshInstance3D +
 * StandardMaterial3D), no GDScript runtime is involved. Jobs live under
 * <userData>/plugins/jobs/<id>/job.json and stream progress through
 * `setProgressSink` exactly like the Blender plugin.
 */

const PLUGIN_ID = "godot";
const active = new Map();
const detectCache = new Map();
const probeCache = new Map();
let progressSink = null;

const PRESETS = {
  windows: { name: "Windows Desktop", platform: "Windows Desktop", extension: ".exe" },
  linux: { name: "Linux", platform: "Linux/X11", extension: "" },
  macos: { name: "macOS", platform: "macOS", extension: ".zip" },
  web: { name: "Web", platform: "Web", extension: "/index.html" },
  android: { name: "Android", platform: "Android", extension: ".apk" },
};

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

function isDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function tailAppend(buffer, chunk, limit = 24000) {
  const next = buffer + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function whichGodot() {
  const command = process.platform === "win32" ? "where" : "which";
  const found = [];
  for (const name of process.platform === "win32" ? ["godot", "godot4", "Godot"] : ["godot", "godot4", "godot4-bin"]) {
    try {
      const output = execFileSync(command, [name], {
        timeout: 6000,
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of output.split(/\r?\n/)) {
        const value = line.trim();
        if (value) found.push(value);
      }
    } catch {
      /* not on PATH */
    }
  }
  return found;
}

function versionWeight(name) {
  const match = String(name).match(/(\d+)[._-](\d+)(?:[._-](\d+))?/);
  if (!match) return 0;
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3] || 0);
}

function scanDir(dir, pattern) {
  const found = [];
  if (!dir) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  const sortable = entries.slice().sort((a, b) => versionWeight(b.name) - versionWeight(a.name));
  for (const entry of sortable) {
    if (!pattern.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) found.push(full);
    else if (entry.isDirectory()) {
      for (const inner of ["godot.exe", "Godot.exe", "godot", "Godot"]) {
        const candidate = path.join(full, inner);
        if (isFile(candidate)) found.push(candidate);
      }
    }
  }
  return found;
}

function windowsCandidates() {
  const found = [];
  const roots = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null,
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "C:\\ProgramData\\chocolatey\\bin",
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "scoop", "apps") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Steam", "steamapps", "common") : null,
  ].filter(Boolean);
  for (const root of roots) {
    if (!root) continue;
    if (isDir(path.join(root, "Godot"))) found.push(...scanDir(path.join(root, "Godot"), /^godot.*\.exe$/i));
    if (isDir(path.join(root, "Godot Engine"))) {
      found.push(...scanDir(path.join(root, "Godot Engine"), /^godot.*\.exe$/i));
    }
    found.push(...scanDir(root, /^godot.*\.exe$/i));
  }
  return found;
}

function unixCandidates() {
  const found = [
    "/usr/bin/godot",
    "/usr/local/bin/godot",
    "/snap/bin/godot",
    "/var/lib/flatpak/exports/bin/org.godotengine.Godot",
    "/Applications/Godot.app/Contents/MacOS/Godot",
    path.join(os.homedir(), ".local", "bin", "godot"),
    path.join(os.homedir(), "Applications", "Godot.app", "Contents", "MacOS", "Godot"),
  ];
  for (const dir of [path.join(os.homedir(), "Applications"), "/Applications", "/opt", os.homedir()]) {
    found.push(...scanDir(dir, /^godot/i));
  }
  return found;
}

function executableCandidates(config) {
  const entries = [];
  const add = (candidate, source) => {
    const value = String(candidate || "").trim();
    if (!value) return;
    if (entries.some((entry) => entry.path === value)) return;
    entries.push({ path: value, source });
  };

  add(config?.executable, "config");
  for (const key of ["GODOT_BIN", "GODOT", "GODOT4"]) {
    add(process.env[key], "env");
  }
  for (const candidate of whichGodot()) add(candidate, "path");
  const scanned = process.platform === "win32" ? windowsCandidates() : unixCandidates();
  for (const candidate of scanned) add(candidate, "scan");
  return entries;
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
  let full = "";
  let error = "";
  const parse = (text) => {
    const line = String(text || "").split(/\r?\n/).find((entry) => /\d+\.\d+/.test(entry)) || "";
    const match = line.match(/(\d+\.\d+(?:\.\d+)?[.\w-]*)/);
    if (!match) return "";
    full = line.trim().slice(0, 120);
    return match[1].replace(/[.-]+$/, "");
  };
  try {
    const output = execFileSync(executable, ["--version"], {
      timeout: 20000,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    version = parse(output);
    if (!version) error = "Godot не сообщил версию.";
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : "";
    const stderr = err?.stderr ? String(err.stderr) : "";
    version = parse(stdout) || parse(stderr);
    if (!version) error = (err?.message || String(err)).slice(0, 400);
  }
  const result = { executable, version, full, error, at: Date.now() };
  detectCache.set(key, result);
  return result;
}

function detect(config) {
  const candidates = executableCandidates(config);
  const checked = [];
  for (const candidate of candidates) {
    if (!isFile(candidate.path)) {
      checked.push({ path: candidate.path, ok: false, error: "не найден" });
      continue;
    }
    const info = readVersion(candidate.path);
    checked.push({
      path: candidate.path,
      ok: !info.error,
      version: info.version,
      error: info.error || "",
    });
    if (!info.error) {
      return {
        found: true,
        executable: candidate.path,
        version: info.version,
        source: candidate.source,
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
      ? "Godot не найден ни по одному известному пути. Укажите путь к godot.exe в настройках плагина (вкладка Плагины → Godot) или установите Godot: https://godotengine.org/download"
      : "Godot не найден. Установите Godot (https://godotengine.org/download) или укажите путь вручную.",
  };
}

function requireGodot(config) {
  const info = detect(config);
  if (!info.found) {
    const error = new Error(info.error);
    error.code = "GODOT_NOT_FOUND";
    error.checked = info.checked;
    throw error;
  }
  return info;
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

function emitProgress(payload) {
  if (!payload) return;
  try {
    if (progressSink) progressSink(payload);
  } catch {
    /* renderer gone */
  }
}

async function appendLog(logPath, text) {
  if (!logPath || !text) return;
  try {
    await fs.promises.appendFile(logPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } catch {
    /* log is best effort */
  }
}

/**
 * Run one Godot invocation. Never throws for process failures: a timeout or a
 * missing binary comes back as { ok:false, error } so callers can branch.
 */
async function runCommand(executable, args, options = {}) {
  const timeoutSec = Math.max(5, Number(options.timeoutSec) || 1800);
  const jobId = options.jobId || "";
  let stdout = "";
  let stderr = "";
  let stdoutTail = "";
  let stderrTail = "";
  let timedOut = false;
  let canceled = false;
  let spawnError = null;
  let lineBuffer = "";
  const onLine = typeof options.onLine === "function" ? options.onLine : null;

  if (options.logPath) {
    await appendLog(
      options.logPath,
      `\n$ ${path.basename(executable)} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ")}`
    );
  }

  let child;
  try {
    child = spawn(executable, args, {
      cwd: options.cwd || undefined,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: { ...process.env, ...(options.env || {}) },
    });
  } catch (error) {
    return {
      ok: false,
      code: -1,
      stdout: "",
      stderr: "",
      stdoutTail: "",
      stderrTail: "",
      timedOut: false,
      canceled: false,
      error: error?.message || String(error),
    };
  }

  if (jobId) {
    active.set(jobId, {
      child,
      cancel: () => {
        canceled = true;
        killTree(child);
      },
    });
  }

  const consume = (text, stream) => {
    if (options.logPath) void appendLog(options.logPath, text);
    if (stream === "out") stdout += text;
    else stderr += text;
    if (!onLine) return;
    lineBuffer += text;
    let index = lineBuffer.indexOf("\n");
    while (index >= 0) {
      const line = lineBuffer.slice(0, index).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(index + 1);
      try {
        onLine(line);
      } catch {
        /* ignore marker parsing errors */
      }
      index = lineBuffer.indexOf("\n");
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stdoutTail = tailAppend(stdoutTail, text);
    consume(text, "out");
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrTail = tailAppend(stderrTail, text);
    consume(text, "err");
  });

  let resolveExit = () => {};
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  child.on("close", (exitCode) => resolveExit(exitCode == null ? -1 : exitCode));
  child.on("error", (error) => {
    spawnError = error;
    stderrTail = tailAppend(stderrTail, String(error?.stack || error?.message || error));
    resolveExit(-1);
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
    const fallback = setTimeout(() => resolveExit(-1), 5000);
    if (typeof fallback.unref === "function") fallback.unref();
  }, timeoutSec * 1000);

  const code = await exitPromise;
  clearTimeout(timer);
  if (jobId) active.delete(jobId);

  let error = "";
  if (spawnError) error = spawnError.message || String(spawnError);
  else if (timedOut) error = `Godot не завершился за ${timeoutSec} с и был остановлен.`;
  else if (canceled) error = "Задача отменена.";
  else if (code !== 0) {
    const lines = stderrTail.split(/\r?\n/).filter(Boolean);
    error = lines.slice(-6).join("\n") || `Godot завершился с кодом ${code}.`;
  }

  return {
    ok: !spawnError && !timedOut && !canceled && code === 0,
    code,
    stdout,
    stderr,
    stdoutTail,
    stderrTail,
    timedOut,
    canceled,
    error,
  };
}

// ── Project scaffolding ──────────────────────────────────────────────────────

function defaultProjectDir(userDataPath) {
  return path.join(userDataPath, "plugins", "godot", "project");
}

function resolveProjectDir(userDataPath, config) {
  const configured = String(config?.projectDir || "").trim();
  return configured ? path.resolve(configured) : defaultProjectDir(userDataPath);
}

function exportTemplatesRoot(version) {
  const key = String(version || "").trim();
  if (!key) return "";
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Godot", "export_templates", key);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Godot", "export_templates", key);
  }
  return path.join(os.homedir(), ".local", "share", "godot", "export_templates", key);
}

function projectTemplate(version) {
  const feature = String(version || "").match(/^(\d+\.\d+)/);
  const features = feature ? `config/features=PackedStringArray("${feature[1]}", "Forward Plus")\n` : "";
  return [
    "; Engine configuration file.",
    "; Generated by ComposeVC — edit freely in the Godot editor.",
    "",
    "config_version=5",
    "",
    "[application]",
    "",
    'config/name="ComposeVC Project"',
    'run/main_scene="res://scenes/main.tscn"',
    features.trimEnd(),
    "",
    "[display]",
    "",
    "window/size/viewport_width=1280",
    "window/size/viewport_height=720",
    "",
    "[rendering]",
    "",
    'renderer/rendering_method="forward_plus"',
    "",
  ]
    .filter((line, index, all) => !(line === "" && all[index - 1] === ""))
    .join("\n");
}

const DEFAULT_SCENE = [
  "[gd_scene format=3]",
  "",
  '[node name="Main" type="Node3D"]',
  "",
  '[node name="Camera3D" type="Camera3D" parent="."]',
  "transform = Transform3D(1, 0, 0, 0, 0.94, 0.34, 0, -0.34, 0.94, 0, 3, 6)",
  "",
  '[node name="Sun" type="DirectionalLight3D" parent="."]',
  "transform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 5, 0)",
  "light_energy = 1.2",
  "",
].join("\n");

async function ensureMainSceneSetting(projectFile, sceneRel) {
  let text = "";
  try {
    text = await fs.promises.readFile(projectFile, "utf8");
  } catch {
    return;
  }
  if (/^\s*run\/main_scene\s*=/m.test(text)) return;
  if (/\[application\]/.test(text)) {
    text = text.replace(/\[application\]\s*\r?\n/, (match) => `${match}run/main_scene="${sceneRel}"\n`);
  } else {
    text += `\n[application]\n\nrun/main_scene="${sceneRel}"\n`;
  }
  await fs.promises.writeFile(projectFile, text, "utf8");
}

async function ensureProject(userDataPath, config, options = {}) {
  const projectDir = resolveProjectDir(userDataPath, config);
  await fs.promises.mkdir(path.join(projectDir, "assets"), { recursive: true });
  await fs.promises.mkdir(path.join(projectDir, "scenes"), { recursive: true });

  const projectFile = path.join(projectDir, "project.godot");
  let created = false;
  if (!isFile(projectFile)) {
    await fs.promises.writeFile(projectFile, projectTemplate(options.version), "utf8");
    created = true;
  }

  const mainScene = path.join(projectDir, "scenes", "main.tscn");
  let sceneCreated = false;
  if (!isFile(mainScene)) {
    await fs.promises.writeFile(mainScene, DEFAULT_SCENE, "utf8");
    sceneCreated = true;
  }
  if (created || sceneCreated) {
    await ensureMainSceneSetting(projectFile, "res://scenes/main.tscn");
  }

  return { projectDir, projectFile, mainScene, created, sceneCreated };
}

// ── Export presets ───────────────────────────────────────────────────────────

function presetOptions(presetId) {
  if (presetId === "windows") {
    return [
      'custom_template/debug=""',
      'custom_template/release=""',
      "debug/export_console_wrapper=1",
      "binary_format/embed_pck=false",
      "texture_format/s3tc_bptc=true",
      "texture_format/etc2_astc=false",
      'binary_format/architecture="x86_64"',
      "codesign/enable=false",
      "application/modify_resources=false",
      'application/icon=""',
      'application/console_wrapper_icon=""',
      'application/icon_interpolation=4',
      'application/file_version=""',
      'application/product_version=""',
      'application/company_name=""',
      'application/product_name=""',
      'application/file_description=""',
      'application/copyright=""',
      'application/trademarks=""',
      'application/export_angle=0',
      'application/export_d3d12=0',
      'application/d3d12_agility_sdk_multiarch=true',
    ];
  }
  if (presetId === "linux") {
    return [
      'custom_template/debug=""',
      'custom_template/release=""',
      "debug/export_console_wrapper=1",
      "binary_format/embed_pck=false",
      "texture_format/s3tc_bptc=true",
      "texture_format/etc2_astc=false",
      'binary_format/architecture="x86_64"',
    ];
  }
  if (presetId === "macos") {
    return [
      'custom_template/debug=""',
      'custom_template/release=""',
      'binary_format/architecture="universal"',
      'application/icon=""',
      'application/icon_interpolation=4',
      'application/bundle_identifier="com.composevc.game"',
      'application/signature=""',
      'application/app_category="Adventure"',
      'application/short_version=""',
      'application/version=""',
      'application/copyright=""',
      "application/copyright_localized={}",
      "application/min_macos_version_x86_64=\"10.12\"",
      "application/min_macos_version_arm64=\"11.00\"",
      "display/high_res=true",
      'codesign/codesign=0',
      'notarization/notarization=0',
    ];
  }
  if (presetId === "web") {
    return [
      'custom_template/debug=""',
      'custom_template/release=""',
      "variant/extensions_support=false",
      "variant/thread_support=false",
      "vram_texture_compression/for_desktop=true",
      "vram_texture_compression/for_mobile=false",
      "html/export_icon=true",
      'html/custom_html_shell=""',
      'html/head_include=""',
      "html/canvas_resize_policy=2",
      "html/focus_canvas_on_start=true",
      "html/experimental_virtual_keyboard=false",
      "progressive_web_app/enabled=false",
    ];
  }
  return [];
}

function presetBlock(index, presetId) {
  const preset = PRESETS[presetId];
  return [
    `[preset.${index}]`,
    "",
    `name="${preset.name}"`,
    `platform="${preset.platform}"`,
    "runnable=true",
    "advanced_options=false",
    "dedicated_server=false",
    'custom_features=""',
    'export_filter="all_resources"',
    'include_filter=""',
    'exclude_filter=""',
    'export_path=""',
    'encryption_include_filters=""',
    'encryption_exclude_filters=""',
    "seed=0",
    "encrypt_pck=false",
    "encrypt_directory=false",
    'script_export_mode=2',
    "",
    `[preset.${index}.options]`,
    "",
    ...presetOptions(presetId),
    "",
  ].join("\n");
}

function parsePresets(text) {
  const rows = [];
  const sections = String(text || "").split(/^\[preset\.(\d+)\]\s*$/m);
  // split() with a capture alternates: [before, index, body, index, body, …]
  for (let index = 1; index < sections.length; index += 2) {
    const id = Number(sections[index]);
    const body = sections[index + 1] || "";
    const name = (body.match(/^name="(.*)"$/m) || [])[1] || "";
    const platformMatch = body.match(/^platform="(.*)"$/m);
    rows.push({ id, name, platform: platformMatch ? platformMatch[1] : "", body });
  }
  return rows.sort((a, b) => a.id - b.id);
}

function platformMatches(presetId, platform) {
  const wanted = PRESETS[presetId].platform;
  if (presetId === "linux") return /^Linux/i.test(platform);
  return platform === wanted;
}

async function ensureExportPreset(projectDir, presetId, options = {}) {
  const file = path.join(projectDir, "export_presets.cfg");
  let text = "";
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    text = "";
  }
  const rows = parsePresets(text);
  const existing = rows.find((row) => platformMatches(presetId, row.platform));
  if (existing && existing.name) {
    return { ok: true, file, name: existing.name, platform: existing.platform, created: false };
  }
  const index = rows.length ? Math.max(...rows.map((row) => row.id)) + 1 : 0;
  const block = presetBlock(index, presetId);
  text = text.trim() ? `${text.replace(/\s*$/, "")}\n\n${block}` : block;
  await fs.promises.writeFile(file, text, "utf8");
  return {
    ok: true,
    file,
    name: PRESETS[presetId].name,
    platform: PRESETS[presetId].platform,
    created: true,
  };
}

/** Godot 4.4 renamed the Linux export platform; repair the file on that error. */
async function repairLinuxPlatform(file) {
  try {
    const text = await fs.promises.readFile(file, "utf8");
    const next = text.includes('platform="Linux/X11"')
      ? text.replace('platform="Linux/X11"', 'platform="Linux"')
      : text.replace('platform="Linux"', 'platform="Linux/X11"');
    if (next === text) return false;
    await fs.promises.writeFile(file, next, "utf8");
    return true;
  } catch {
    return false;
  }
}

function normalizePreset(value) {
  const key = String(value || "").trim().toLowerCase();
  return PRESETS[key] ? key : "windows";
}

function resolveExportPath(projectDir, presetId, configured) {
  const preset = PRESETS[presetId];
  const raw = String(configured || "").trim();
  if (raw) {
    const resolved = path.isAbsolute(raw) ? raw : path.resolve(projectDir, raw);
    if (presetId === "windows" && !/\.exe$/i.test(resolved)) return `${resolved}.exe`;
    if (presetId === "web" && !/\.html?$/i.test(resolved)) {
      const base = /[\\/]$/.test(resolved) ? resolved : `${resolved}${path.sep}`;
      return path.join(base, "index.html");
    }
    if (presetId === "macos" && !/\.(zip|app)$/i.test(resolved)) return `${resolved}.zip`;
    if (presetId === "android" && !/\.apk$/i.test(resolved)) return `${resolved}.apk`;
    return resolved;
  }
  const dir = path.join(projectDir, "build", presetId);
  if (presetId === "web") return path.join(dir, "index.html");
  return path.join(dir, `game${preset.extension || ""}`);
}

// ── File helpers ─────────────────────────────────────────────────────────────

const GLB_EXTENSIONS = new Set([".glb", ".gltf"]);

async function findGlbFiles(dir, limit = 200, depth = 0) {
  const found = [];
  if (!dir || depth > 4) return found;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (found.length >= limit) break;
    if (entry.name === ".godot" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findGlbFiles(full, limit - found.length, depth + 1)));
      continue;
    }
    if (GLB_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.slice(0, limit);
}

async function collectGlbSources(userDataPath, config, input) {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  const files = [];
  const dirs = [];
  for (const entry of raw) {
    const value = String(entry && typeof entry === "object" ? entry.path : entry || "").trim();
    if (!value) continue;
    const resolved = path.resolve(value);
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.isDirectory()) dirs.push(resolved);
      else if (stat.isFile() && GLB_EXTENSIONS.has(path.extname(resolved).toLowerCase())) files.push(resolved);
    } catch {
      /* missing path is reported by the caller */
    }
  }
  if (!files.length && !dirs.length) {
    const configured = String(config?.glbDir || "").trim();
    if (configured) {
      const resolved = path.resolve(configured);
      if (isDir(resolved)) dirs.push(resolved);
      else if (isFile(resolved)) files.push(resolved);
    } else {
      let blenderConfig = store.DEFAULT_BLENDER_CONFIG;
      try {
        const record = await store.getPlugin(userDataPath, "blender");
        if (record?.config) blenderConfig = record.config;
      } catch {
        /* store unavailable — fall back to the default output dir */
      }
      dirs.push(store.resolveOutputDir(userDataPath, blenderConfig));
    }
  }
  for (const dir of dirs) {
    files.push(...(await findGlbFiles(dir)));
  }
  if (!files.length && !raw.length && !String(config?.glbDir || "").trim()) {
    // Blender keeps exports inside its job folders; fall back to the job store
    // so the default pipeline (blender export → godot import) works with no args.
    files.push(...(await findGlbFiles(store.jobsRoot(userDataPath), 60)));
  }
  return Array.from(new Set(files)).slice(0, 200);
}

function existingArtifact(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { path: filePath, bytes: stat.size } : null;
  } catch {
    return null;
  }
}

// ── Scene builder (.tscn) ────────────────────────────────────────────────────

function formatNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0";
  const rounded = Math.abs(num) < 1e-6 ? 0 : Math.round(num * 1e6) / 1e6;
  return String(rounded);
}

function vector3(value, fallback = [0, 0, 0]) {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  if (value && typeof value === "object") {
    return [Number(value.x) || 0, Number(value.y) || 0, Number(value.z) || 0];
  }
  if (Number.isFinite(Number(value))) return [Number(value), Number(value), Number(value)];
  return fallback;
}

function colorFrom(value, fallback = [0.62, 0.64, 0.68, 1]) {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0, value.length > 3 ? Number(value[3]) || 1 : 1];
  }
  const text = String(value || "").trim();
  const match = text.match(/^#?([0-9a-f]{6})$/i);
  if (match) {
    const int = parseInt(match[1], 16);
    return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255, 1];
  }
  return fallback;
}

/** Basis columns for Godot's default YXZ Euler order. */
function basisFromEuler(rotationDeg, scale) {
  const [rx, ry, rz] = vector3(rotationDeg).map((value) => (value * Math.PI) / 180);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  // M = Ry * Rx * Rz
  const m = [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
  const [sxScale, syScale, szScale] = vector3(scale, [1, 1, 1]);
  const column = (index) => [m[0][index] * sxScale, m[1][index] * syScale, m[2][index] * szScale];
  return [column(0), column(1), column(2)];
}

function sanitizeName(value, fallback) {
  const text = String(value || "")
    .replace(/["\r\n]/g, "")
    .trim()
    .slice(0, 80);
  return text || fallback;
}

function meshType(value) {
  const key = String(value || "box").toLowerCase().replace(/[\s-]/g, "_");
  if (["sphere", "uv_sphere", "spheremesh"].includes(key)) return "SphereMesh";
  if (["cylinder", "cylindermesh"].includes(key)) return "CylinderMesh";
  if (["plane", "floor", "planemesh"].includes(key)) return "PlaneMesh";
  if (["capsule", "capsulemesh"].includes(key)) return "CapsuleMesh";
  if (["prism", "prismmesh", "wedge"].includes(key)) return "PrismMesh";
  return "BoxMesh";
}

function meshProps(type, node) {
  const size = vector3(node.size, [1, 1, 1]);
  const radius = Number(node.radius) || Math.max(size[0], size[2]) / 2 || 0.5;
  const height = Number(node.height) || size[1] || radius * 2;
  if (type === "BoxMesh") {
    if (Array.isArray(node.size) && node.size.length >= 3) {
      return [`size = Vector3(${size.map(formatNumber).join(", ")})`];
    }
    if (Number.isFinite(Number(node.size))) {
      const value = Number(node.size);
      return [`size = Vector3(${formatNumber(value)}, ${formatNumber(value)}, ${formatNumber(value)})`];
    }
    return ["size = Vector3(1, 1, 1)"];
  }
  if (type === "SphereMesh") {
    const value = Number(node.radius) || 0.5;
    return [`radius = ${formatNumber(value)}`, `height = ${formatNumber(value * 2)}`];
  }
  if (type === "CylinderMesh") {
    return [
      `top_radius = ${formatNumber(Number(node.top_radius) || radius)}`,
      `bottom_radius = ${formatNumber(Number(node.bottom_radius) || radius)}`,
      `height = ${formatNumber(height)}`,
    ];
  }
  if (type === "PlaneMesh") {
    const plane = Array.isArray(node.size) ? [size[0] || 1, size[2] || 1] : [10, 10];
    return [`size = Vector2(${formatNumber(plane[0])}, ${formatNumber(plane[1])})`];
  }
  if (type === "CapsuleMesh") {
    return [`radius = ${formatNumber(radius)}`, `height = ${formatNumber(Math.max(height, radius * 2))}`];
  }
  if (type === "PrismMesh") {
    return [`size = Vector3(${size.map(formatNumber).join(", ")})`];
  }
  return [];
}

/**
 * Build a text .tscn scene from a declarative plan.
 * plan = { name, nodes: [{ name, type, mesh, transform:{location,rotation,scale}, material:{albedo_color,metallic,roughness} }] }
 */
function buildSceneText(plan) {
  const source = plan && typeof plan === "object" ? plan : {};
  const nodes = (Array.isArray(source.nodes) ? source.nodes : Array.isArray(source.objects) ? source.objects : []).filter(
    (node) => node && typeof node === "object"
  );
  const rootName = sanitizeName(source.name || source.root || "Scene", "Scene");

  const subResources = [];
  const nodeBlocks = [];
  const materials = new Map();
  let meshIndex = 0;

  const materialFor = (spec) => {
    if (!spec || typeof spec !== "object") return "";
    const albedo = colorFrom(spec.albedo_color || spec.color || spec.base_color);
    const metallic = Number.isFinite(Number(spec.metallic)) ? Number(spec.metallic) : 0;
    const roughness = Number.isFinite(Number(spec.roughness)) ? Number(spec.roughness) : 0.6;
    const key = `${albedo.join(",")}|${metallic}|${roughness}|${spec.emission || ""}|${spec.emission_energy || ""}`;
    if (materials.has(key)) return materials.get(key);
    const id = `StandardMaterial3D_${materials.size + 1}`;
    const lines = [
      `[sub_resource type="StandardMaterial3D" id="${id}"]`,
      `albedo_color = Color(${albedo.map(formatNumber).join(", ")})`,
      `metallic = ${formatNumber(metallic)}`,
      `roughness = ${formatNumber(roughness)}`,
    ];
    if (spec.emission) {
      const emission = colorFrom(spec.emission);
      lines.push("emission_enabled = true");
      lines.push(`emission = Color(${emission.map(formatNumber).join(", ")})`);
      lines.push(`emission_energy_multiplier = ${formatNumber(Number(spec.emission_energy) || 1)}`);
    }
    lines.push("");
    materials.set(key, id);
    subResources.push(lines.join("\n"));
    return id;
  };

  for (const node of nodes) {
    const name = sanitizeName(node.name, `Node${nodeBlocks.length + 1}`);
    const type = /^[A-Za-z][A-Za-z0-9_]*$/.test(String(node.type || "")) ? String(node.type) : "MeshInstance3D";
    const transform = node.transform && typeof node.transform === "object" ? node.transform : {};
    const location = vector3(node.location || transform.location || node.position, [0, 0, 0]);
    const rotation = vector3(node.rotation || transform.rotation, [0, 0, 0]);
    const scale = vector3(node.scale || transform.scale, [1, 1, 1]);
    const basis = basisFromEuler(rotation, scale);
    const lines = [`[node name="${name}" type="${type}" parent="."]`];
    if (location.some((value) => value !== 0) || rotation.some((value) => value !== 0) || scale.some((value) => value !== 1)) {
      const numbers = [...basis[0], ...basis[1], ...basis[2], ...location].map(formatNumber);
      lines.push(`transform = Transform3D(${numbers.join(", ")})`);
    }
    if (type === "MeshInstance3D" || node.mesh) {
      const mType = meshType(node.mesh || node.mesh_type);
      meshIndex += 1;
      const id = `${mType}_${meshIndex}`;
      subResources.push([`[sub_resource type="${mType}" id="${id}"]`, ...meshProps(mType, node), ""].join("\n"));
      lines.push(`mesh = SubResource("${id}")`);
      const materialId = materialFor(node.material);
      if (materialId) lines.push(`material_override = SubResource("${materialId}")`);
    }
    if (type === "Camera3D" && node.current !== false) lines.push("current = true");
    if (type === "DirectionalLight3D" && node.energy != null) lines.push(`light_energy = ${formatNumber(node.energy)}`);
    lines.push("");
    nodeBlocks.push(lines.join("\n"));
  }

  const hasCamera = nodes.some((node) => String(node.type || "") === "Camera3D");
  const hasLight = nodes.some((node) => /Light3D$/.test(String(node.type || "")));
  if (!hasCamera && source.camera !== false) {
    nodeBlocks.push(
      [
        '[node name="Camera3D" type="Camera3D" parent="."]',
        "transform = Transform3D(1, 0, 0, 0, 0.94, 0.34, 0, -0.34, 0.94, 0, 3, 6)",
        "current = true",
        "",
      ].join("\n")
    );
  }
  if (!hasLight && source.lighting !== false) {
    nodeBlocks.push(
      [
        '[node name="Sun" type="DirectionalLight3D" parent="."]',
        "transform = Transform3D(1, 0, 0, 0, 0.7, 0.7, 0, -0.7, 0.7, 0, 5, 0)",
        "light_energy = 1.2",
        "",
      ].join("\n")
    );
  }

  const subResourceText = subResources.length ? `${subResources.join("\n")}\n` : "";
  return [
    `[gd_scene load_steps=${subResources.length + 1} format=3]`,
    "",
    subResourceText,
    `[node name="${rootName}" type="${/^[A-Za-z][A-Za-z0-9_]*$/.test(String(source.root_type || "")) ? source.root_type : "Node3D"}"]`,
    "",
    nodeBlocks.join("\n"),
  ].join("\n");
}

// ── Job plumbing ─────────────────────────────────────────────────────────────

function summarizeBuild(preset, exportPath, bytes) {
  const size = bytes ? ` · ${(bytes / (1024 * 1024)).toFixed(1)} МБ` : "";
  return `экспорт ${preset}: ${exportPath}${size}`;
}

async function startJob(userDataPath, input, godot) {
  const job = await store.createJob(userDataPath, {
    pluginId: PLUGIN_ID,
    kind: input.kind || "build",
    title: String(input.title || "Godot"),
  });
  const startedAt = Date.now();
  const running = await store.updateJob(userDataPath, job.id, {
    status: "running",
    startedAt,
    stage: "starting",
    progress: 0,
    godot: { path: godot.executable, version: godot.version, preset: normalizePreset(input.preset) },
  });
  emitProgress({ jobId: running.id, pluginId: PLUGIN_ID, stage: "starting", percent: 0, status: "running" });
  return running;
}

async function finishJob(userDataPath, job, patch, stats = {}) {
  const finishedAt = Date.now();
  const status = patch.status || (patch.error ? "failed" : "succeeded");
  const updated = await store.updateJob(userDataPath, job.id, {
    ...patch,
    status,
    finishedAt,
    durationMs: finishedAt - (job.startedAt || job.createdAt || finishedAt),
  });
  try {
    const record = await store.getPlugin(userDataPath, PLUGIN_ID);
    await store.updatePlugin(userDataPath, PLUGIN_ID, {
      stats: {
        runs: (record?.stats?.runs || 0) + 1,
        failures: (record?.stats?.failures || 0) + (status === "succeeded" ? 0 : 1),
        lastRunAt: finishedAt,
        lastError: status === "succeeded" ? "" : String(updated.error || "").slice(0, 700),
      },
      config: stats.config || undefined,
    });
  } catch {
    /* stats are best effort */
  }
  emitProgress({
    jobId: updated.id,
    pluginId: PLUGIN_ID,
    status: updated.status,
    stage: updated.stage,
    percent: updated.progress,
    done: true,
    error: updated.error || "",
  });
  return updated;
}

function logTail(logPath, lines = 40) {
  try {
    const text = fs.readFileSync(logPath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

async function performImport(userDataPath, config, sources, project, godot, ctx) {
  if (!sources.length) {
    return {
      ok: false,
      imported: [],
      error: "Не найдено ни одного .glb/.gltf. Экспортируйте модель из Blender (export.preset=godot) или укажите каталог/файл явно.",
    };
  }
  const copied = [];
  for (const source of sources) {
    const name = path.basename(source);
    const target = path.join(project.projectDir, "assets", name);
    try {
      await fs.promises.copyFile(source, target);
      copied.push({ source, target, bytes: existingArtifact(target)?.bytes || 0 });
    } catch (error) {
      copied.push({ source, target, error: error?.message || String(error) });
    }
  }
  ctx.stage("import", 55);
  const result = await runCommand(godot.executable, ["--headless", "--path", project.projectDir, "--import"], {
    timeoutSec: config.timeoutSec,
    logPath: ctx.logPath,
    jobId: ctx.jobId,
    cwd: project.projectDir,
  });
  const imported = [];
  for (const entry of copied) {
    if (entry.error) continue;
    const importFile = `${entry.target}.import`;
    const exists = isFile(importFile) || isDir(path.join(project.projectDir, ".godot", "imported"));
    imported.push({ ...entry, importFile: isFile(importFile) ? importFile : "", ok: exists });
  }
  const failed = imported.filter((entry) => !entry.ok);
  const outputErrors = `${result.stdoutTail}\n${result.stderrTail}`
    .split(/\r?\n/)
    .filter((line) => /ERROR|Failed|error:/i.test(line))
    .slice(-6);
  const ok = result.ok && copied.every((entry) => !entry.error);
  return {
    ok,
    imported,
    copied: copied.length,
    stdout: result.stdoutTail,
    stderr: result.stderrTail,
    errors: outputErrors,
    log: result.stdoutTail || result.stderrTail,
    error: ok
      ? ""
      : result.error ||
        outputErrors.join("\n") ||
        (failed.length ? `Не импортировано: ${failed.map((entry) => path.basename(entry.target)).join(", ")}` : ""),
  };
}

async function performBuild(config, project, godot, presetId, exportPath, ctx) {
  const preset = await ensureExportPreset(project.projectDir, presetId, { version: godot.version });

  // Always re-import: a scene written or a GLB copied since the last build must
  // be registered before --export-release can pack it.
  ctx.stage("import project", 35);
  await runCommand(godot.executable, ["--headless", "--path", project.projectDir, "--import"], {
    timeoutSec: Math.min(Number(config.timeoutSec) || 1800, 600),
    logPath: ctx.logPath,
    jobId: ctx.jobId,
    cwd: project.projectDir,
  });

  ctx.stage("export", 60);
  const attempt = async () =>
    runCommand(godot.executable, ["--headless", "--path", project.projectDir, "--export-release", preset.name, exportPath], {
      timeoutSec: config.timeoutSec,
      logPath: ctx.logPath,
      jobId: ctx.jobId,
      cwd: project.projectDir,
    });

  let result = await attempt();
  let output = `${result.stdout}\n${result.stderr}`;
  if (!result.ok && presetId === "linux" && /invalid platform|Unknown export platform|unknown platform/i.test(output)) {
    if (await repairLinuxPlatform(preset.file)) {
      ctx.stage("export (linux platform retry)", 65);
      result = await attempt();
      output = `${result.stdout}\n${result.stderr}`;
      preset.platform = preset.platform === "Linux/X11" ? "Linux" : "Linux/X11";
    }
  }

  const artifact = existingArtifact(exportPath);
  const missingTemplate = /export template[s]? (?:not found|are missing|not installed)|No export template|Couldn't find export template/i.test(
    output
  );
  const noPreset = /export preset .* not found|No export preset/i.test(output);
  let error = "";
  let hint = "";
  if (missingTemplate) {
    error = "Export-шаблоны Godot не установлены.";
    hint = "Установите export templates в Godot: Editor → Manage Export Templates.";
  } else if (noPreset) {
    error = `Пресет экспорта "${preset.name}" не найден в project.godot.`;
    hint = "Откройте проект в Godot → Project → Export и создайте пресет, либо удалите export_presets.cfg и повторите.";
  } else if (!result.ok) {
    error = result.error || "Godot не смог экспортировать проект.";
  } else if (!artifact) {
    error = `Godot завершился без ошибки, но файл экспорта не создан: ${exportPath}`;
    hint = "Проверьте export_presets.cfg и путь экспорта.";
  }

  return {
    ok: !error,
    error,
    hint,
    preset: presetId,
    presetName: preset.name,
    exportPath,
    bytes: artifact?.bytes || 0,
    stdout: result.stdoutTail,
    stderr: result.stderrTail,
    log: result.stdoutTail || result.stderrTail,
  };
}

async function performRun(config, project, godot, frames, ctx) {
  const quitAfter = Math.max(1, Math.min(60, Number(frames) || 3));
  ctx.stage("run", 85);
  const startedAt = Date.now();
  const result = await runCommand(
    godot.executable,
    ["--headless", "--path", project.projectDir, "--quit-after", String(quitAfter)],
    {
      timeoutSec: Math.min(Number(config.timeoutSec) || 1800, 180),
      logPath: ctx.logPath,
      jobId: ctx.jobId,
      cwd: project.projectDir,
    }
  );
  const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  const errors = `${result.stdoutTail}\n${result.stderrTail}`
    .split(/\r?\n/)
    .filter((line) => /ERROR|SCRIPT ERROR|Failed/i.test(line))
    .slice(-8);
  return {
    ok: result.ok && errors.length === 0,
    seconds,
    frames: quitAfter,
    log: result.stdoutTail || result.stderrTail,
    errors,
    error: result.error || errors.join("\n"),
  };
}

/** Thin wrapper that keeps stage/progress/live updates in one place. */
async function withJob(userDataPath, options, work) {
  const config = options.config || {};
  const godot = requireGodot(config);
  const project = await ensureProject(userDataPath, config, { version: godot.version });
  const job = await startJob(userDataPath, { ...options, preset: config.preset }, godot);
  const setStage = async (stage, percent) => {
    emitProgress({ jobId: job.id, pluginId: PLUGIN_ID, stage, percent, status: "running" });
    try {
      await store.updateJob(userDataPath, job.id, { stage, progress: percent });
    } catch {
      /* keep going: job file write failures must not abort the build */
    }
  };
  const ctx = {
    jobId: job.id,
    logPath: job.logPath,
    stage: (stage, percent) => {
      void setStage(stage, percent);
    },
  };
  await appendLog(job.logPath, `проект: ${project.projectDir}\nGodot ${godot.version} · ${godot.executable}\n`);
  try {
    const outcome = await work({ job, project, godot, ctx, setStage, config });
    const failed = !outcome.ok;
    const updated = await finishJob(
      userDataPath,
      job,
      {
        progress: failed ? Number(outcome.progress) || 0 : 100,
        stage: failed ? "failed" : "done",
        error: outcome.error || "",
        warnings: Array.isArray(outcome.warnings) ? outcome.warnings : [],
        summary: outcome.summary || "",
        scenePath: outcome.scenePath || "",
        exportPath: outcome.exportPath || "",
        exports: Array.isArray(outcome.exports) ? outcome.exports : [],
        stats: outcome.stats || {},
        godot: { path: godot.executable, version: godot.version, preset: normalizePreset(config.preset) },
      },
      {}
    );
    return { ...outcome, job: updated };
  } catch (error) {
    const message = error?.message || String(error);
    const updated = await finishJob(userDataPath, job, {
      status: "failed",
      stage: "failed",
      error: message,
      summary: message,
      godot: { path: godot.executable, version: godot.version, preset: normalizePreset(config.preset) },
    });
    return { ok: false, error: message, job: updated };
  } finally {
    await store.pruneJobs(userDataPath, store.MAX_JOBS).catch(() => {});
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

async function probe(userDataPath, config) {
  const detected = detect(config);
  if (!detected.found) {
    return {
      ok: false,
      found: false,
      executable: "",
      version: "",
      engines: [],
      operators: {},
      checked: detected.checked,
      error: detected.error,
    };
  }
  const cacheKey = `${detected.executable}::${detected.version}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;

  const run = await runCommand(detected.executable, ["--version"], { timeoutSec: 15 });
  const output = `${run.stdout}\n${run.stderr}`.trim();
  const version = (output.match(/(\d+\.\d+(?:\.\d+)?[.\w-]*)/) || [])[1] || detected.version;
  const templates = exportTemplatesRoot(version) || exportTemplatesRoot(detected.version);
  const templatesFound = Boolean(templates) && isDir(templates);
  const engines = ["headless", "gltf_import", "export_release"];
  if (templatesFound) engines.push("export_templates");
  const value = {
    ok: run.ok,
    executable: detected.executable,
    version,
    engines,
    operators: {
      export_windows: true,
      export_linux: true,
      export_macos: true,
      export_web: true,
      export_android: false,
      "gltf.import": true,
    },
    templates: { found: templatesFound, path: templates || "" },
    checked: detected.checked,
    error: run.ok ? "" : run.error || output.slice(-600),
  };
  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function runScene(userDataPath, config, plan, options = {}) {
  return withJob(userDataPath, { kind: "scene", title: options.title || (plan?.name ? `Сцена: ${plan.name}` : "Godot сцена"), config }, async ({ job, project, godot, ctx, setStage }) => {
    await setStage("scene", 25);
    const name = sanitizeName(plan?.name, "scene").replace(/[^\w.-]+/g, "_").toLowerCase() || "scene";
    const file = path.join(project.projectDir, "scenes", `${name}.tscn`);
    const text = buildSceneText(plan);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, text, "utf8");
    const relative = path.relative(project.projectDir, file).split(path.sep).join("/");
    if (plan?.main_scene !== false) {
      await fs.promises.writeFile(
        project.projectFile,
        (await fs.promises.readFile(project.projectFile, "utf8")).replace(
          /^\s*run\/main_scene\s*=.*$/m,
          `run/main_scene="res://${relative}"`
        ),
        "utf8"
      );
      const check = await fs.promises.readFile(project.projectFile, "utf8");
      if (!/run\/main_scene\s*=/.test(check)) await ensureMainSceneSetting(project.projectFile, `res://${relative}`);
    }
    const nodes = (Array.isArray(plan?.nodes) ? plan.nodes : Array.isArray(plan?.objects) ? plan.objects : []).length;
    await appendLog(job.logPath, `сцена: ${file} (${nodes} узлов)\n`);
    await setStage("scene written", 55);
    let importInfo = null;
    if (config.importGlb !== false) {
      await setStage("import", 70);
      const sources = await collectGlbSources(userDataPath, config, []);
      if (sources.length) {
        importInfo = await performImport(userDataPath, config, sources, project, godot, ctx);
        if (!importInfo.ok) await appendLog(job.logPath, `импорт GLB с замечаниями: ${importInfo.error}\n`);
      }
    }
    return {
      ok: true,
      scenePath: file,
      summary: `сцена ${path.basename(file)} · ${nodes} узлов${importInfo?.imported?.length ? ` · ${importInfo.imported.length} GLB` : ""}`,
      stats: { objects: nodes + (importInfo?.imported?.length || 0) },
      warnings: importInfo && !importInfo.ok ? [`glb: ${importInfo.error}`] : [],
    };
  });
}

async function importGlb(userDataPath, config, files, options = {}) {
  const sources = await collectGlbSources(userDataPath, config, files);
  return withJob(
    userDataPath,
    { kind: "import", title: options.title || "Импорт GLB в Godot", config },
    async ({ job, project, godot, ctx, setStage }) => {
      await setStage("copy", 20);
      const result = await performImport(userDataPath, config, sources, project, godot, ctx);
      await appendLog(job.logPath, result.error ? `ошибка: ${result.error}\n` : `импортировано: ${result.imported.length}\n`);
      return {
        ...result,
        progress: result.ok ? 100 : 60,
        summary: result.ok
          ? `импортировано ${result.imported.length} файл(ов) в ${path.join(project.projectDir, "assets")}`
          : result.error,
        exports: result.imported
          .filter((entry) => entry.ok)
          .map((entry) => ({
            format: path.extname(entry.target).slice(1).toUpperCase() || "GLB",
            path: entry.target,
            bytes: entry.bytes || 0,
          })),
        stats: { objects: result.imported.length },
      };
    }
  );
}

async function build(userDataPath, config, options = {}) {
  const presetId = normalizePreset(options.preset || config.preset);
  if (presetId === "android") {
    return {
      ok: false,
      preset: presetId,
      error: "Android-экспорт требует Android SDK, NDK и Java (keytool). Соберите windows/linux/web/macos.",
      hint: "Установите Android Studio, укажите SDK в Godot: Editor → Editor Settings → Export → Android, затем повторите.",
    };
  }
  if (!PRESETS[presetId]) {
    return { ok: false, preset: presetId, error: `Неизвестный пресет "${presetId}".` };
  }
  const detected = detect(config);
  if (!detected.found) return { ok: false, preset: presetId, error: detected.error, checked: detected.checked };

  const projectDir = resolveProjectDir(userDataPath, config);
  const exportPath = resolveExportPath(projectDir, presetId, options.exportPath || config.exportPath);
  const timeoutSec = Math.max(10, Math.min(7200, Number(options.timeoutSec) || Number(config.timeoutSec) || 1800));

  return withJob(
    userDataPath,
    { kind: "build", title: options.title || `Сборка Godot (${presetId})`, config: { ...config, preset: presetId, timeoutSec } },
    async ({ job, project, godot, ctx, setStage }) => {
      await setStage("prepare", 15);
      const result = await performBuild({ ...config, preset: presetId, timeoutSec }, project, godot, presetId, exportPath, ctx);
      await setStage(result.ok ? "done" : "failed", result.ok ? 100 : 80);
      return {
        ...result,
        progress: result.ok ? 100 : 80,
        summary: result.ok ? summarizeBuild(presetId, exportPath, result.bytes) : result.error,
        stats: { objects: result.ok ? 1 : 0 },
        warnings: [],
      };
    }
  );
}

async function runProject(userDataPath, config, options = {}) {
  const detected = detect(config);
  if (!detected.found) return { ok: false, error: detected.error, checked: detected.checked };
  return withJob(
    userDataPath,
    { kind: "run", title: options.title || "Запуск Godot", config },
    async ({ ctx, project, godot, setStage }) => {
      await setStage("run", 40);
      const result = await performRun(config, project, godot, options.frames, ctx);
      await setStage(result.ok ? "done" : "failed", result.ok ? 100 : 80);
      return {
        ...result,
        progress: result.ok ? 100 : 80,
        summary: result.ok ? `проект отработал ${result.seconds} с (${result.frames} кадров)` : result.error,
        stats: {},
      };
    }
  );
}

async function runDemo(userDataPath, config, options = {}) {
  const detected = detect(config);
  if (!detected.found) return { ok: false, error: detected.error, checked: detected.checked };
  const demoPlan = {
    name: "ComposeVC demo",
    nodes: [
      {
        name: "Floor",
        type: "MeshInstance3D",
        mesh: "plane",
        size: [12, 0.1, 12],
        location: [0, 0, 0],
        material: { albedo_color: "#2b3038", metallic: 0.05, roughness: 0.85 },
      },
      {
        name: "Pedestal",
        type: "MeshInstance3D",
        mesh: "cylinder",
        radius: 1,
        height: 0.8,
        location: [0, 0.4, 0],
        material: { albedo_color: "#3a3f48", metallic: 0.15, roughness: 0.6 },
      },
      {
        name: "Crystal",
        type: "MeshInstance3D",
        mesh: "box",
        size: [0.9, 0.9, 0.9],
        rotation: [0, 45, 0],
        location: [0, 1.4, 0],
        material: { albedo_color: "#2ee6ff", metallic: 0.1, roughness: 0.15, emission: "#18d7ff", emission_energy: 2.2 },
      },
    ],
  };
  const presetId = normalizePreset(options.preset || config.preset);
  if (presetId === "android") {
    return { ok: false, error: "Демо не поддерживает Android-экспорт (нужен Android SDK)." };
  }
  const projectDir = resolveProjectDir(userDataPath, config);
  const exportPath = resolveExportPath(projectDir, presetId, options.exportPath || config.exportPath);

  return withJob(
    userDataPath,
    { kind: "demo", title: options.title || "Демо Godot", config: { ...config, preset: presetId } },
    async ({ job, ctx, setStage }) => {
      await setStage("project", 10);
      const project = await ensureProject(userDataPath, config, { version: detected.version });
      await setStage("scene", 30);
      const sceneName = "composevc_demo";
      const sceneFile = path.join(project.projectDir, "scenes", `${sceneName}.tscn`);
      await fs.promises.writeFile(sceneFile, buildSceneText(demoPlan), "utf8");
      await fs.promises.writeFile(
        project.projectFile,
        (await fs.promises.readFile(project.projectFile, "utf8")).replace(
          /^\s*run\/main_scene\s*=.*$/m,
          'run/main_scene="res://scenes/composevc_demo.tscn"'
        ),
        "utf8"
      );
      await appendLog(job.logPath, `демо-сцена: ${sceneFile}\n`);

      let importInfo = { ok: true, imported: [] };
      if (config.importGlb !== false) {
        await setStage("import glb", 45);
        const sources = await collectGlbSources(userDataPath, config, options.files || []);
        if (sources.length) {
          importInfo = await performImport(userDataPath, config, sources, project, detected, ctx);
          if (!importInfo.ok) {
            await appendLog(job.logPath, `импорт GLB с замечаниями: ${importInfo.error}\n`);
          }
        }
      }

      await setStage("build", 65);
      const built = await performBuild({ ...config, preset: presetId }, project, detected, presetId, exportPath, ctx);
      await setStage("run", 90);
      const ran = built.ok ? await performRun(config, project, detected, options.frames || 3, ctx) : { ok: false, error: "" };

      const warnings = [];
      if (ran.error && built.ok) warnings.push(`запуск: ${ran.error}`);
      if (importInfo.error) warnings.push(`glb: ${importInfo.error}`);

      const ok = built.ok;
      return {
        ok,
        progress: ok ? 100 : 80,
        scenePath: sceneFile,
        exportPath: built.ok ? built.exportPath : "",
        error: built.error || "",
        hint: built.hint || "",
        exports: built.ok
          ? [{ format: presetId.toUpperCase(), path: built.exportPath, bytes: built.bytes || 0 }]
          : [],
        summary: ok
          ? `${summarizeBuild(presetId, built.exportPath, built.bytes)} · сцена + ${importInfo.imported?.length || 0} GLB · run ${ran.seconds || 0} с`
          : built.error,
        stats: { objects: demoPlan.nodes.length + (importInfo.imported?.length || 0) },
        warnings,
        run: { ok: ran.ok, seconds: ran.seconds || 0, log: ran.log || "" },
        import: { ok: importInfo.ok !== false, imported: importInfo.imported || [] },
      };
    }
  );
}

async function readPreviewDataUrl(userDataPath, jobId, name) {
  const job = await store.getJob(userDataPath, jobId);
  if (!job) throw new Error("Задача не найдена.");
  const candidates = [];
  if (name) candidates.push(path.join(job.dir, path.basename(String(name))));
  if (job.previewPath) candidates.push(job.previewPath);
  try {
    for (const entry of await fs.promises.readdir(job.dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(entry.name)) candidates.push(path.join(job.dir, entry.name));
    }
  } catch {
    /* job dir is gone */
  }
  const file = candidates.find((candidate) => candidate && candidate.startsWith(job.dir) && isFile(candidate));
  if (!file) {
    throw new Error(
      "Godot не даёт превью без рендера сцены. Запустите сборку/игру и передайте path=/abs/frame.png (или сделайте скриншот)."
    );
  }
  const stat = await fs.promises.stat(file);
  if (stat.size > 24 * 1024 * 1024) throw new Error("Превью слишком большое.");
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const base64 = (await fs.promises.readFile(file)).toString("base64");
  return { dataUrl: `data:${mime};base64,${base64}`, path: file, bytes: stat.size };
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

async function deleteJob(userDataPath, jobId) {
  const entry = active.get(String(jobId));
  if (entry) throw new Error("Нельзя удалить выполняющуюся задачу.");
  return store.deleteJob(userDataPath, jobId);
}

module.exports = {
  PLUGIN_ID,
  PRESETS,
  setProgressSink,
  detect,
  probe,
  ensureProject,
  ensureExportPreset,
  resolveProjectDir,
  resolveExportPath,
  normalizePreset,
  importGlb,
  build,
  runProject,
  runScene,
  runDemo,
  cancelJob,
  listRunning,
  readPreviewDataUrl,
  deleteJob,
  requireGodot,
};
