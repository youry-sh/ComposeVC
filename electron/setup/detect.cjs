const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");
const { COMPONENTS, getComponent } = require("./registry.cjs");

/**
 * Detection is the only place that decides whether a component is installed.
 * It never trusts a previous install run: binary on PATH (or at a known
 * location) that answers --version is the proof.
 *
 * `which`/`runStep` mirror electron/vm/install.cjs. They are duplicated on
 * purpose — the VM engine owns QEMU installs and must not gain a dependency
 * from the toolchain setup path (and vm/** is not to be edited).
 */

const CACHE_MS = 30_000;

const cache = new Map();
let lastScan = { at: 0, platform: null, results: null };

function platform() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function which(binary) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = String(out)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

function runStep(command, args, { timeoutMs = 5000, cwd } = {}) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        cwd,
        shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      resolve({ ok: false, code: -1, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: `${out}\n${error.message}`.slice(-4000) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-4000) });
    });
  });
}

function parseVersion(output) {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(String(output || ""));
  return match ? match[1] : null;
}

const WINDOWS_STORE_ALIAS = /[\\/]Microsoft[\\/]WindowsApps[\\/](python3?|py)\.exe$/i;

/** The python/python3 App Execution Alias is a 0-byte stub that opens the Store. */
function isStoreStub(binPath) {
  return process.platform === "win32" && WINDOWS_STORE_ALIAS.test(String(binPath || ""));
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function blenderWindowsPaths() {
  const roots = [process.env.ProgramFiles || "C:\\Program Files", "C:\\Program Files (x86)"];
  const found = [];
  for (const root of roots) {
    const base = path.join(root, "Blender Foundation");
    for (const entry of listDir(base)) {
      if (!entry.isDirectory()) continue;
      found.push(path.join(base, entry.name, "blender.exe"));
    }
    found.push(path.join(base, "Blender", "blender.exe"));
  }
  return found;
}

function pythonWindowsPaths() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python"),
    process.env.ProgramFiles || "C:\\Program Files",
  ];
  const found = [];
  for (const root of roots) {
    for (const entry of listDir(root)) {
      if (!entry.isDirectory()) continue;
      if (!/^Python\s*3/i.test(entry.name)) continue;
      found.push(path.join(root, entry.name, "python.exe"));
    }
  }
  return found;
}

function knownPaths(id, plat) {
  const home = os.homedir();
  if (plat === "win") {
    if (id === "blender") return blenderWindowsPaths();
    if (id === "git") {
      return [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
      ];
    }
    if (id === "go") {
      return [
        "C:\\Program Files\\Go\\bin\\go.exe",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Go", "bin", "go.exe"),
      ];
    }
    if (id === "python") return pythonWindowsPaths();
    if (id === "rust") {
      return [path.join(process.env.USERPROFILE || home, ".cargo", "bin", "rustc.exe")];
    }
    return [];
  }
  if (id === "blender") {
    return [
      "/usr/bin/blender",
      "/usr/local/bin/blender",
      "/snap/bin/blender",
      "/var/lib/flatpak/exports/bin/org.blender.Blender",
      "/Applications/Blender.app/Contents/MacOS/Blender",
    ];
  }
  if (id === "git") return ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"];
  if (id === "go") return ["/usr/local/go/bin/go", "/opt/homebrew/bin/go", "/usr/bin/go"];
  if (id === "rust") return [path.join(home, ".cargo", "bin", "rustc")];
  if (id === "python") return ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
  return [];
}

function versionArgs(id, plat) {
  const component = getComponent(id);
  const first = component?.version?.[plat]?.[0];
  return first && Array.isArray(first.args) ? first.args : ["--version"];
}

function makeResult(id, installed, version, binPath, source, error) {
  return {
    id,
    installed: installed === true,
    version: version || null,
    path: binPath || null,
    source: source || null,
    error: error || null,
  };
}

async function probe(userDataPath, id, { force = false } = {}) {
  const component = getComponent(id);
  if (!component) return makeResult(id, false, null, null, null, "Неизвестный компонент");

  const plat = platform();
  const probes = [];
  const seen = new Set();
  for (const spec of [...(component.check[plat] || []), ...(component.version[plat] || [])]) {
    const key = `${spec.bin}\u0000${spec.args.join("\u0000")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push(spec);
  }

  let presence = null;
  let lastError = null;

  for (const spec of probes) {
    const binPath = which(spec.bin);
    if (!binPath) continue;
    if (isStoreStub(binPath)) continue;
    const result = await runStep(spec.bin, spec.args, { timeoutMs: 5000 });
    const output = String(result.output || "").trim();
    if (!result.ok) {
      const hint = output
        ? output.split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 300)
        : `${spec.bin} завершился с кодом ${result.code}`;
      lastError = hint;
      continue;
    }
    if (!presence) presence = { binPath, output };
    const version = parseVersion(output);
    if (version) {
      const required = await checkRequires(userDataPath, component, force);
      if (!required.ok) return makeResult(id, false, null, null, null, required.error);
      return makeResult(id, true, version, binPath, "PATH");
    }
  }

  // Known install locations (Blender is the common "installed but not on PATH" case).
  for (const candidate of knownPaths(id, plat)) {
    if (!fs.existsSync(candidate)) continue;
    if (isStoreStub(candidate)) continue;
    const result = await runStep(candidate, versionArgs(id, plat), { timeoutMs: 5000 });
    const output = String(result.output || "").trim();
    const version = parseVersion(output);
    if (!result.ok && !version) {
      lastError = `${candidate}: ${output.slice(0, 200) || `код ${result.code}`}`;
      continue;
    }
    const required = await checkRequires(userDataPath, component, force);
    if (!required.ok) return makeResult(id, false, null, null, null, required.error);
    return makeResult(id, true, version, candidate, "known-path");
  }

  if (presence) {
    const required = await checkRequires(userDataPath, component, force);
    if (!required.ok) return makeResult(id, false, null, null, null, required.error);
    return makeResult(id, true, null, presence.binPath, "PATH");
  }

  return makeResult(id, false, null, null, null, lastError);
}

async function checkRequires(userDataPath, component, force) {
  if (!component.requires.length) return { ok: true, error: null };
  const missing = [];
  for (const depId of component.requires) {
    const dep = await detectComponent(userDataPath, depId, { force });
    if (!dep.installed) missing.push(getComponent(depId)?.name || depId);
  }
  if (!missing.length) return { ok: true, error: null };
  return { ok: false, error: `Требуется: ${missing.join(", ")}` };
}

async function detectComponent(userDataPath, id, { force = false } = {}) {
  const component = getComponent(id);
  if (!component) return makeResult(id, false, null, null, null, "Неизвестный компонент");
  const cached = cache.get(component.id);
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  let result;
  try {
    result = await probe(userDataPath, component.id, { force });
  } catch (error) {
    result = makeResult(
      component.id,
      false,
      null,
      null,
      null,
      error instanceof Error ? error.message : String(error)
    );
  }
  cache.set(component.id, { at: Date.now(), result });
  // A forced single-component probe makes the aggregate scan snapshot stale.
  if (force) lastScan.results = null;
  return result;
}

async function detectAll(userDataPath, { force = false } = {}) {
  const plat = platform();
  if (!force && lastScan.results && lastScan.platform === plat && Date.now() - lastScan.at < CACHE_MS) {
    return lastScan.results;
  }

  // Two waves: components without cross-checks first, then those that need
  // another component's verdict. Keeps watcher/lookup spawns to a minimum.
  const base = COMPONENTS.filter((component) => component.requires.length === 0);
  const dependent = COMPONENTS.filter((component) => component.requires.length > 0);
  const results = await Promise.all(base.map((component) => detectComponent(userDataPath, component.id, { force })));
  for (const component of dependent) {
    results.push(await detectComponent(userDataPath, component.id, { force }));
  }

  for (const result of results) {
    const component = getComponent(result.id);
    if (!component || !component.requires.length || !result.installed) continue;
    const missing = component.requires
      .filter((depId) => !results.find((entry) => entry.id === depId)?.installed)
      .map((depId) => getComponent(depId)?.name || depId);
    if (missing.length) {
      result.installed = false;
      result.version = null;
      result.path = null;
      result.source = null;
      result.error = `Требуется: ${missing.join(", ")}`;
    }
  }

  lastScan = { at: Date.now(), platform: plat, results };
  return results;
}

module.exports = {
  platform,
  which,
  runStep,
  parseVersion,
  knownPaths,
  detectComponent,
  detectAll,
};
