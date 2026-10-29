const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

/**
 * FFmpeg detection + portable auto-install for the Motion Studio plugin.
 *
 * Resolution order:
 *   1. config.ffmpegPath (validated with `ffmpeg -version`)
 *   2. PATH (`where` / `which`)
 *   3. well-known install locations (%LOCALAPPDATA%, winget shims, <userData>/plugins/motion/bin)
 *   4. install: winget on Windows, then a portable archive downloaded into
 *      <userData>/plugins/motion/bin and extracted with platform tools.
 *
 * Everything is async spawn based; nothing blocks the Electron event loop and
 * every failure is returned as { found:false, error } instead of throwing.
 */

const PLUGIN_ID = "motion";

function report(onProgress, stage, percent, extra = {}) {
  if (typeof onProgress !== "function") return;
  const payload = { pluginId: PLUGIN_ID, stage, done: false, ...extra };
  if (Number.isFinite(Number(percent))) {
    payload.percent = Math.max(0, Math.min(100, Math.round(Number(percent))));
  }
  try {
    onProgress(payload);
  } catch {
    /* renderer gone */
  }
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

function binaryName(base) {
  return process.platform === "win32" ? `${base}.exe` : base;
}

function clean(value) {
  return String(value == null ? "" : value)
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
}

function which(binary) {
  const command = process.platform === "win32" ? "where" : "which";
  try {
    const result = spawnSync(command, [binary], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 6000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = String(result.stdout || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(Boolean);
    return line || "";
  } catch {
    return "";
  }
}

const versionCache = new Map();

function readVersion(executable) {
  if (!executable || !isFile(executable)) return { ok: false, version: "", executable, error: "не найден" };
  let stamp = 0;
  try {
    stamp = Math.round(fs.statSync(executable).mtimeMs);
  } catch {
    stamp = 0;
  }
  const key = `${executable}::${stamp}`;
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return { ...cached.value };
  const value = probeVersion(executable);
  versionCache.set(key, { at: Date.now(), value });
  return { ...value };
}

function probeVersion(executable) {
  try {
    const result = spawnSync(executable, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    const match = text.match(/ffmpeg version\s+([^\s]+)/i);
    if (result.error) return { ok: false, version: "", executable, error: result.error.message || String(result.error) };
    if (!match) {
      return {
        ok: result.status === 0,
        version: "",
        executable,
        error: result.status === 0 ? "FFmpeg не сообщил версию." : `ffmpeg завершился с кодом ${result.status}`,
      };
    }
    return { ok: true, version: String(match[1]).slice(0, 80), executable, error: "" };
  } catch (error) {
    return { ok: false, version: "", executable, error: error?.message || String(error) };
  }
}

function scanForBinary(root, base, depth = 4) {
  if (!root || depth < 0 || !isDir(root)) return "";
  const wanted = binaryName(base);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === wanted.toLowerCase()) return path.join(root, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/^(\.git|node_modules|__MACOSX)$/i.test(entry.name)) continue;
    const found = scanForBinary(path.join(root, entry.name), base, depth - 1);
    if (found) return found;
  }
  return "";
}

function bundledBinDir(userDataPath) {
  return path.join(path.resolve(userDataPath), "plugins", "motion", "bin");
}

function candidateEntries(userDataPath, config, base) {
  const entries = [];
  const add = (candidate, source) => {
    const value = clean(candidate);
    if (!value) return;
    if (entries.some((entry) => entry.path.toLowerCase() === value.toLowerCase())) return;
    entries.push({ path: value, source });
  };
  const configured = base === "ffmpeg" ? config?.ffmpegPath : config?.ffprobePath;
  add(configured, "config");
  if (base === "ffmpeg" && configured && isDir(configured)) {
    add(scanForBinary(configured, base), "config");
  }
  add(which(base), "path");
  const binDir = bundledBinDir(userDataPath);
  add(path.join(binDir, binaryName(base)), "bundled");
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      add(path.join(local, "Programs", "ffmpeg", "bin", "ffmpeg.exe"), "scan");
      add(path.join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"), "scan");
      add(path.join(local, "Microsoft", "WinGet", "Links", "ffprobe.exe"), "scan");
      const packages = path.join(local, "Microsoft", "WinGet", "Packages");
      if (base === "ffmpeg" && isDir(packages)) add(scanForBinary(packages, base, 4), "scan");
    }
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      // Only real FFmpeg installs — never pick up ffmpeg.exe bundled inside
      // unrelated players (LAVFilters, KMPlayer, …): those builds often have
      // no ffprobe and no drawtext.
      add(path.join(root, "ffmpeg", "bin", "ffmpeg.exe"), "scan");
    }
    add("C:\\ffmpeg\\bin\\ffmpeg.exe", "scan");
  } else {
    if (base === "ffmpeg") {
      for (const dir of ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin", path.join(os.homedir(), ".local", "bin")]) {
        add(path.join(dir, base), "scan");
      }
    }
    add("/opt/homebrew/bin/" + base, "scan");
  }
  return entries;
}

function detect(userDataPath, config, base = "ffmpeg") {
  const checked = [];
  const entries = candidateEntries(userDataPath, config, base);
  for (const entry of entries) {
    if (!entry.path) continue;
    if (!isFile(entry.path)) {
      checked.push({ path: entry.path, ok: false, error: "не найден" });
      continue;
    }
    const info = readVersion(entry.path);
    checked.push({ path: entry.path, ok: info.ok, version: info.version, error: info.error });
    if (info.ok) {
      return { found: true, executable: entry.path, version: info.version, source: entry.source, error: "", checked };
    }
  }
  return {
    found: false,
    executable: "",
    version: "",
    source: "",
    error: base === "ffmpeg" ? "FFmpeg не найден." : "FFprobe не найден.",
    checked,
  };
}

function detectProbe(userDataPath, config) {
  const explicit = detect(userDataPath, config, "ffprobe");
  if (explicit.found) return explicit;
  const ffmpeg = detect(userDataPath, config, "ffmpeg");
  if (!ffmpeg.found) return explicit;
  const sibling = path.join(path.dirname(ffmpeg.executable), binaryName("ffprobe"));
  const info = readVersion(sibling);
  if (info.ok) {
    return { found: true, executable: sibling, version: info.version, source: ffmpeg.source, error: "", checked: explicit.checked };
  }
  return explicit;
}

function run(command, args, options = {}) {
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 15 * 60 * 1000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, cwd: options.cwd || undefined });
    } catch (error) {
      resolve({ ok: false, code: -1, output: error?.message || String(error) });
      return;
    }
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      settled = true;
      resolve({ ok: false, code: -1, output: `${output}\nтаймаут операции` });
    }, timeoutMs);
    const append = (chunk) => {
      output += chunk.toString("utf8");
      // `ffmpeg -filters` / `-encoders` print a few hundred KB; the tail is
      // what matters for errors, so only very large outputs are trimmed.
      if (output.length > 512000) output = output.slice(output.length - 512000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: `${output}\n${error?.message || String(error)}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
}

function download(url, target, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "user-agent": "ComposeVC-Motion/1.0", accept: "*/*" }, timeout: 30000 },
      (response) => {
        const status = Number(response.statusCode) || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirects > 5) {
            reject(new Error("Слишком много перенаправлений при скачивании FFmpeg."));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          download(next, target, onProgress, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Скачивание не удалось: HTTP ${status}`));
          return;
        }
        const total = Number(response.headers["content-length"]) || 0;
        let received = 0;
        const file = fs.createWriteStream(target);
        let failed = false;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (total > 0 && typeof onProgress === "function") {
            onProgress(Math.min(99, Math.round((received / total) * 100)), received, total);
          }
        });
        response.on("error", (error) => {
          failed = true;
          file.destroy();
          reject(error);
        });
        file.on("error", (error) => {
          failed = true;
          reject(error);
        });
        file.on("finish", () => {
          file.close(() => {
            if (!failed) resolve({ bytes: received, total });
          });
        });
        response.pipe(file);
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("Таймаут скачивания FFmpeg."));
    });
    request.on("error", reject);
  });
}

function portableSpec() {
  if (process.platform === "win32") {
    return {
      file: "ffmpeg-portable.zip",
      urls: [
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
      ],
      kind: "zip",
    };
  }
  if (process.platform === "darwin") {
    return {
      file: "ffmpeg-osx.zip",
      urls: ["https://evermeet.cx/ffmpeg/getrelease/zip"],
      kind: "zip",
    };
  }
  const arm = process.arch === "arm64" ? "arm64" : "amd64";
  return {
    file: `ffmpeg-linux-${arm}.tar.xz`,
    urls: [`https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${arm}-static.tar.xz`],
    kind: "tarxz",
  };
}

async function extractArchive(archive, kind, targetDir, onProgress, log) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  let command = "";
  let args = [];
  if (process.platform === "win32") {
    command = "powershell";
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${targetDir.replace(/'/g, "''")}' -Force`,
    ];
  } else if (kind === "tarxz") {
    command = "tar";
    args = ["-xJf", archive, "-C", targetDir];
  } else {
    command = "unzip";
    args = ["-o", archive, "-d", targetDir];
  }
  log(`распаковка: ${command} ${args.join(" ")}`);
  report(onProgress, "unpack", 82);
  const result = await run(command, args, { timeoutMs: 10 * 60 * 1000 });
  if (!result.ok) throw new Error(`Не удалось распаковать архив FFmpeg: ${result.output.slice(-600)}`);
}

async function tryWinget(onProgress, log) {
  if (process.platform !== "win32") return null;
  if (!which("winget")) return null;
  report(onProgress, "winget", 20);
  log("winget install -e --id Gyan.FFmpeg");
  const result = await run(
    "winget",
    [
      "install",
      "-e",
      "--id",
      "Gyan.FFmpeg",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--disable-interactivity",
      "--silent",
    ],
    { timeoutMs: 15 * 60 * 1000 }
  );
  log(result.output.slice(-1200));
  if (!result.ok) return null;
  const found = which("ffmpeg");
  if (!found) return null;
  const info = readVersion(found);
  return info.ok ? info : null;
}

async function ensureFfmpeg(userDataPath, config, onProgress) {
  const log = (text) => {
    if (!text) return;
    report(onProgress, "install", undefined, { log: String(text).slice(0, 600) });
  };
  if (!["win32", "linux", "darwin"].includes(process.platform)) {
    return { found: false, error: "Платформа не поддерживается" };
  }
  const userData = path.resolve(String(userDataPath || ""));
  if (!userData) return { found: false, error: "Не указан каталог приложения." };

  report(onProgress, "detect", 4);
  const current = detect(userData, config, "ffmpeg");
  if (current.found) {
    return { found: true, source: current.source, executable: current.executable, version: current.version, error: "" };
  }

  report(onProgress, "detect", 8);
  const viaWinget = await tryWinget(onProgress, log);
  if (viaWinget) {
    return { found: true, source: "winget", executable: viaWinget.executable, version: viaWinget.version, error: "" };
  }
  // winget adds its Links folder to PATH for new shells only — rescan it now.
  const afterWinget = detect(userData, config, "ffmpeg");
  if (afterWinget.found) {
    return {
      found: true,
      source: afterWinget.source === "path" ? "winget" : afterWinget.source,
      executable: afterWinget.executable,
      version: afterWinget.version,
      error: "",
    };
  }

  const spec = portableSpec();
  const binDir = bundledBinDir(userData);
  const downloadDir = path.join(binDir, "download");
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const archive = path.join(downloadDir, spec.file);
  let lastError = "";
  for (const url of spec.urls) {
    try {
      log(`скачивание: ${url}`);
      report(onProgress, "download", 12);
      await download(url, archive, (percent) => {
        report(onProgress, "download", 12 + percent * 0.65);
      });
      lastError = "";
      break;
    } catch (error) {
      lastError = error?.message || String(error);
      log(`ошибка скачивания: ${lastError}`);
      try {
        await fs.promises.rm(archive, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  if (lastError) {
    return { found: false, error: `Не удалось скачать FFmpeg: ${lastError}` };
  }
  if (!isFile(archive) || (fs.statSync(archive).size || 0) < 1024 * 1024) {
    return { found: false, error: "Скачанный архив FFmpeg пуст или повреждён." };
  }

  const unpackDir = path.join(binDir, "portable");
  try {
    await extractArchive(archive, spec.kind, unpackDir, onProgress, log);
  } catch (error) {
    return { found: false, error: error?.message || String(error) };
  }

  report(onProgress, "validate", 90);
  const executable = scanForBinary(unpackDir, "ffmpeg", 5);
  if (!executable) {
    return { found: false, error: "В архиве FFmpeg не найден исполняемый файл ffmpeg." };
  }
  const finalPath = path.join(binDir, binaryName("ffmpeg"));
  let resolved = executable;
  if (path.resolve(executable) !== path.resolve(finalPath)) {
    try {
      await fs.promises.copyFile(executable, finalPath);
      if (process.platform !== "win32") await fs.promises.chmod(finalPath, 0o755);
      resolved = finalPath;
    } catch {
      resolved = executable;
    }
  }
  const probeSource = scanForBinary(unpackDir, "ffprobe", 5);
  let probePath = "";
  if (probeSource) {
    const probeFinal = path.join(binDir, binaryName("ffprobe"));
    try {
      if (path.resolve(probeSource) !== path.resolve(probeFinal)) {
        await fs.promises.copyFile(probeSource, probeFinal);
        if (process.platform !== "win32") await fs.promises.chmod(probeFinal, 0o755);
        probePath = probeFinal;
      } else {
        probePath = probeSource;
      }
    } catch {
      probePath = probeSource;
    }
  }
  const info = readVersion(resolved);
  if (!info.ok) {
    return { found: false, executable: resolved, error: `FFmpeg установлен, но не запускается: ${info.error || "неизвестная ошибка"}` };
  }
  try {
    await fs.promises.rm(archive, { force: true });
    const insideUnpack = (candidate) =>
      candidate && path.resolve(candidate).startsWith(path.resolve(unpackDir) + path.sep);
    if (!insideUnpack(resolved) && !insideUnpack(probePath)) {
      await fs.promises.rm(unpackDir, { recursive: true, force: true });
    }
  } catch {
    /* disk cleanup is best effort */
  }
  report(onProgress, "done", 100, { done: true, error: "" });
  return { found: true, source: "bundled", executable: resolved, probePath, version: info.version, error: "" };
}

module.exports = {
  PLUGIN_ID,
  which,
  readVersion,
  detect,
  detectProbe,
  ensureFfmpeg,
  bundledBinDir,
  scanForBinary,
  isFile,
  isDir,
  run,
};
