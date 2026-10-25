/**
 * package-dist.mjs — harden + stage ANTI + electron-builder (Windows NSIS Setup EXE)
 *
 * Ships:
 *   - OBFUSCATED electron main (asar) + minified vite dist renderer
 *   - anti/bin (stripped -ldflags -s -w), engine, extensions, config
 *   - Electron fuses: no RunAsNode / inspect / plain app folder
 *
 * Does NOT ship:
 *   - src/ (React TS sources)
 *   - runtime-app/ + electron/runtime*
 *   - web-ide/, tests/, docs/, scripts/
 *   - anti/cmd, anti/internal, anti/patches, anti/profiles (~2GB)
 *   - node_modules/electron (devDependency)
 *
 * Locked output:
 *   If release/win-unpacked is held by a running app (its resources/app.asar is
 *   open without FILE_SHARE_DELETE — e.g. ComposeVC itself), electron-builder
 *   cannot empty it. The script then packages into release/.build-<ts> and
 *   copies the installer artifacts into release/. It never kills the running app.
 *
 * Usage:
 *   node scripts/package-dist.mjs
 *   node scripts/package-dist.mjs --dir
 *   node scripts/package-dist.mjs --skip-web
 *   node scripts/package-dist.mjs --skip-harden
 *   node scripts/package-dist.mjs --light-harden
 *   node scripts/package-dist.mjs --skip-anti-build
 *   node scripts/package-dist.mjs --stage-only
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stageAnti = path.join(root, "release-assets", "anti");
const hardElectron = path.join(root, "release-assets", "electron-hard");

const args = new Set(process.argv.slice(2));
const skipWeb = args.has("--skip-web");
const skipAntiBuild = args.has("--skip-anti-build");
const skipHarden = args.has("--skip-harden");
const lightHarden = args.has("--light-harden");
const dirOnly = args.has("--dir");
const stageOnly = args.has("--stage-only");
const help = args.has("--help") || args.has("-h");

if (help) {
  console.log(`package-dist.mjs — ComposeVC hardened Windows installer

Options:
  --dir              electron-builder --dir (unpacked, no NSIS)
  --stage-only       only stage release-assets/anti
  --skip-web         skip tsc+vite build
  --skip-harden      use existing release-assets/electron-hard (or fail if missing)
  --light-harden     faster/lighter javascript-obfuscator pass
  --skip-anti-build  do not re-run go build for anti.exe
  --help             this text

Output:
  release/ComposeVC-Setup-<version>-x64.exe
  If release/win-unpacked is in use by a running app, the build is staged in
  release/.build-<ts> and the installer artifacts are copied into release/.
`);
  process.exit(0);
}

function log(msg) {
  console.log(`[package-dist] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[package-dist] ERROR: ${msg}`);
  process.exit(code);
}

function run(cmd, cmdArgs, opts = {}) {
  log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd || root,
    stdio: "inherit",
    shell: opts.shell ?? process.platform === "win32",
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} exited ${r.status}`, r.status || 1);
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function rmrf(p) {
  if (!exists(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Non-destructive lock probe for the previous unpacked build.
 *
 * Windows blocks the delete (and the rename) of a directory while any file
 * inside it is open without FILE_SHARE_DELETE — exactly what a running Electron
 * app does to its resources/app.asar. Opening the file ourselves is not enough
 * (Node shares delete), so rename the directory away and straight back: that
 * needs the same permission a delete needs and touches no contents.
 */
function isDirLocked(dir) {
  if (!exists(dir)) return false;
  const probe = `${dir}.lockprobe`;
  try {
    if (exists(probe)) {
      // Leftover from an interrupted probe — restore/clean it, never guess.
      if (exists(dir)) fs.rmSync(probe, { recursive: true, force: true });
      else fs.renameSync(probe, dir);
    }
  } catch {
    /* the probe below reports the real state */
  }
  try {
    fs.renameSync(dir, probe);
    fs.renameSync(probe, dir);
    return false;
  } catch {
    try {
      if (exists(probe) && !exists(dir)) fs.renameSync(probe, dir);
    } catch {
      fail(`lock probe left ${probe}; rename it back to ${dir} manually`);
    }
    return true;
  }
}

/**
 * Clear a build directory with retries. Windows refuses to remove files that a
 * running process (or antivirus) still has open — e.g. the previous app.asar of
 * a running ComposeVC build — so callers fall back to a staged output instead of
 * killing the user's app.
 */
function tryClearDir(dir, attempts = 4) {
  if (!exists(dir)) return true;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
    } catch {
      /* retry below */
    }
    if (!exists(dir)) return true;
    if (attempt < attempts - 1) sleep(300);
  }
  return false;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function isMarkdown(name) {
  return /\.(md|markdown|mdx)$/i.test(name);
}

function copyRecursive(src, dest, { filter } = {}) {
  if (!exists(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    mkdirp(dest);
    for (const name of fs.readdirSync(src)) {
      if (isMarkdown(name)) continue;
      const from = path.join(src, name);
      const to = path.join(dest, name);
      if (filter && !filter(from, name)) continue;
      copyRecursive(from, to, { filter });
    }
    return;
  }
  if (isMarkdown(path.basename(src))) return;
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function stripMarkdown(dir) {
  if (!exists(dir)) return 0;
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) n += stripMarkdown(p);
    else if (ent.isFile() && isMarkdown(ent.name)) {
      fs.unlinkSync(p);
      n += 1;
    }
  }
  return n;
}

function fileSizeMb(p) {
  try {
    return (fs.statSync(p).size / (1024 * 1024)).toFixed(1);
  } catch {
    return "?";
  }
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    if (!exists(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return (total / (1024 * 1024)).toFixed(1);
}

// --- 1) Ensure anti binary ---
const antiRoot = path.join(root, "anti");
const isWin = process.platform === "win32";
const antiName = isWin ? "anti.exe" : "anti";
const chromeName = isWin ? "chrome.exe" : "chrome";
const antiBin = path.join(antiRoot, "bin", antiName);
const antiRootExe = path.join(antiRoot, antiName);
const chromeExe = path.join(antiRoot, "engine", "chromium", chromeName);

if (!skipAntiBuild) {
  const goMod = path.join(antiRoot, "go.mod");
  if (exists(goMod)) {
    // -s -w strip symbol/debug tables (harder strings/debug dump of anti)
    log(`building ${antiName} (go build -ldflags "-s -w")…`);
    mkdirp(path.join(antiRoot, "bin"));
    // shell:false keeps "-s -w" as a single argv (cmd.exe would re-split it).
    run(
      "go",
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join("bin", antiName), "./cmd/anti"],
      { cwd: antiRoot, shell: false }
    );
    // Keep root-level copy for resolveAntiExe fallback
    if (exists(antiBin)) {
      try {
        fs.copyFileSync(antiBin, antiRootExe);
      } catch {
        /* ignore */
      }
    }
  } else {
    log("anti/go.mod missing — skipping go build");
  }
}

if (!exists(antiBin) && !exists(antiRootExe)) {
  fail(`${antiName} not found at ${antiBin} (or anti/${antiName}). Build anti first or drop --skip-anti-build.`);
}
if (!exists(chromeExe)) {
  // Linux/macOS may use a system Chromium; engine dir is only required on Windows.
  if (isWin) {
    fail(`Chromium engine missing: ${chromeExe}. Ship anti/engine/chromium before packaging.`);
  } else {
    log(`warn: no engine/${chromeName} — packaged anti will fall back to system chromium on target machines.`);
  }
}

// --- 2) Stage anti runtime (NO source, NO profiles) ---
log(`staging anti → ${stageAnti}`);
rmrf(stageAnti);
mkdirp(stageAnti);

// bin/
mkdirp(path.join(stageAnti, "bin"));
const exeSrc = exists(antiBin) ? antiBin : antiRootExe;
fs.copyFileSync(exeSrc, path.join(stageAnti, "bin", antiName));
// also root-level copy for findProjectRoot layouts
fs.copyFileSync(exeSrc, path.join(stageAnti, antiName));

// engine/ (full chromium — required on Windows; optional elsewhere)
if (exists(path.join(antiRoot, "engine"))) {
  copyRecursive(path.join(antiRoot, "engine"), path.join(stageAnti, "engine"));
} else if (isWin) {
  fail("anti/engine missing — Windows builds require the chromium engine.");
} else {
  log("warn: no anti/engine dir — staged anti will use a system chromium.");
}

// extensions/ (fp-inject, captcha-helper, speech-locale)
copyRecursive(path.join(antiRoot, "extensions"), path.join(stageAnti, "extensions"));
{
  const mdN = stripMarkdown(stageAnti);
  if (mdN) log(`stripped ${mdN} markdown file(s) from staged anti`);
}

// config/ — captcha defaults only; strip real API keys for customer builds
mkdirp(path.join(stageAnti, "config"));
const captchaSrc = path.join(antiRoot, "config", "captcha.json");
const captchaDst = path.join(stageAnti, "config", "captcha.json");
if (exists(captchaSrc)) {
  try {
    const raw = JSON.parse(fs.readFileSync(captchaSrc, "utf8"));
    const scrubbed = {
      ...raw,
      api_key: "",
      // keep provider / timeouts / local mode defaults
    };
    fs.writeFileSync(captchaDst, JSON.stringify(scrubbed, null, 2), "utf8");
    log("captcha.json staged with api_key scrubbed");
  } catch {
    fs.copyFileSync(captchaSrc, captchaDst);
  }
} else {
  fs.writeFileSync(
    captchaDst,
    JSON.stringify(
      {
        provider: "capsolver",
        api_key: "",
        timeout_sec: 120,
        turnstile_mode: "provider",
      },
      null,
      2
    ),
    "utf8"
  );
}

// Empty profiles skeleton (writable at runtime via userData bootstrap)
mkdirp(path.join(stageAnti, "profiles", "data"));
fs.writeFileSync(
  path.join(stageAnti, "profiles", ".gitkeep"),
  "# profiles created at runtime under %APPDATA%/composevc/anti/profiles\n",
  "utf8"
);

// Explicitly DO NOT copy: cmd/, internal/, patches/, profiles/data/*, go.mod, .agent-memory, .backup
const banned = ["cmd", "internal", "patches", "profiles", ".agent-memory", ".backup", "go.mod", "go.sum"];
for (const b of banned) {
  // profiles skeleton already created; ensure we never re-copied data
  if (b === "profiles") continue;
  const p = path.join(stageAnti, b);
  if (exists(p)) rmrf(p);
}
// Wipe any accidental profile data if copyRecursive ever expanded
const stagedProfileData = path.join(stageAnti, "profiles", "data");
if (exists(stagedProfileData)) {
  for (const name of fs.readdirSync(stagedProfileData)) {
    rmrf(path.join(stagedProfileData, name));
  }
}

log(`staged anti size ≈ ${dirSizeMb(stageAnti)} MB (profiles empty; engine included)`);
log(`  ${antiName} ${fileSizeMb(path.join(stageAnti, "bin", antiName))} MB`);
log(`  chrome   ${fileSizeMb(path.join(stageAnti, "engine", "chromium", chromeName))} MB`);

// Guardrails: never stage secrets / sources / fat profile data
const mustNotExist = [
  path.join(stageAnti, "cmd"),
  path.join(stageAnti, "internal"),
  path.join(stageAnti, "patches"),
  path.join(stageAnti, "go.mod"),
  path.join(stageAnti, "go.sum"),
];
for (const p of mustNotExist) {
  if (exists(p)) fail(`staging leaked forbidden path: ${p}`);
}
const profileData = path.join(stageAnti, "profiles", "data");
if (exists(profileData)) {
  const leftover = fs.readdirSync(profileData);
  if (leftover.length) fail(`profiles/data not empty after stage: ${leftover.slice(0, 5).join(", ")}`);
}
const mustExist = [
  path.join(stageAnti, "bin", antiName),
  path.join(stageAnti, "extensions", "fp-inject", "manifest.json"),
  path.join(stageAnti, "config", "captcha.json"),
];
if (isWin) {
  mustExist.push(path.join(stageAnti, "engine", "chromium", chromeName));
} else if (!exists(path.join(stageAnti, "engine"))) {
  log("warn: no engine dir staged — Linux/macOS will use a system chromium.");
}
for (const p of mustExist) {
  if (!exists(p)) fail(`staging missing required file: ${p}`);
}

if (stageOnly) {
  log("--stage-only: skip vite + electron-builder");
  process.exit(0);
}

// --- 3) Web / renderer build ---
// Production installer uses vite-only (build:web:dist). Full `tsc && vite` may fail on
// non-blocking UI type drift; Electron already ships the same runtime without tsc gate.
if (!skipWeb) {
  log("building renderer (vite production minify)…");
  run("npm", ["run", "build:web:dist"], {
    env: { ...process.env, NODE_ENV: "production" },
  });
} else {
  if (!exists(path.join(root, "dist", "index.html"))) {
    fail("dist/index.html missing — run without --skip-web");
  }
  log("skipping web build (--skip-web)");
}

// --- 4) Harden electron main (javascript-obfuscator → release-assets/electron-hard) ---
const hardMain = path.join(hardElectron, "main.cjs");
if (skipHarden) {
  if (!exists(hardMain)) {
    fail(
      `release-assets/electron-hard/main.cjs missing — run without --skip-harden first`
    );
  }
  log("skipping harden (--skip-harden); using existing electron-hard");
} else {
  const hardenArgs = ["scripts/harden-electron.mjs"];
  if (lightHarden) hardenArgs.push("--light");
  log(lightHarden ? "hardening electron (light)…" : "hardening electron (heavy obfuscation)…");
  run(process.execPath, hardenArgs, { shell: false });
  if (!exists(hardMain)) fail(`harden did not produce ${hardMain}`);
}

// Guard: never ship plain runtime companion even if present in hard tree
for (const drop of ["runtimeApp.cjs", "runtimeMain.cjs"]) {
  const p = path.join(hardElectron, drop);
  if (exists(p)) {
    fs.unlinkSync(p);
    log(`stripped ${drop} from electron-hard`);
  }
}
{
  const mdN = stripMarkdown(hardElectron);
  if (mdN) log(`stripped ${mdN} markdown file(s) from electron-hard`);
}

// --- 4b) Optional auto-update token (read-only, shipped in resources) ---
// Private GitHub repo → electron-updater needs a token to read the feed.
// Provide it at build time:  LOPSTER_UPDATE_TOKEN=github_pat_… node scripts/package-dist.mjs
// The value is never logged and never written into project sources.
{
  const tokenFile = path.join(root, "release-assets", "update-token.txt");
  const updateToken = String(process.env.LOPSTER_UPDATE_TOKEN || "").trim();
  mkdirp(path.dirname(tokenFile));
  fs.writeFileSync(tokenFile, updateToken, "utf8");
  log(
    updateToken
      ? "auto-update token staged (resources/update-token.txt)"
      : "no LOPSTER_UPDATE_TOKEN — installer will use the public feed / runtime token"
  );
}

// --- 5) Ensure electron-builder present ---
const ebLocal = path.join(root, "node_modules", "electron-builder", "cli.js");
const ebBin = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);
if (!exists(ebLocal) && !exists(ebBin)) {
  log("installing electron-builder (devDependency)…");
  run("npm", ["install", "--save-dev", "electron-builder@^25.1.8"]);
}
if (!exists(path.join(root, "node_modules", "@electron", "fuses"))) {
  log("installing @electron/fuses…");
  run("npm", ["install", "--save-dev", "@electron/fuses"]);
}

// --- 6) electron-builder ---
const releaseDir = path.join(root, "release");
const primaryAppOut = path.join(releaseDir, "win-unpacked");

// A running ComposeVC (or anything that mapped the previous app.asar) makes
// Windows refuse to clear release/win-unpacked, and electron-builder aborts in
// EnsureEmptyDir before packaging a single file. Never kill the user's running
// app — build into a sibling output and publish the artifacts into release/.
let buildOutput = releaseDir;
let stagedOutput = isDirLocked(primaryAppOut);
if (!stagedOutput && exists(primaryAppOut) && !tryClearDir(primaryAppOut)) {
  stagedOutput = true;
}
if (stagedOutput) {
  buildOutput = path.join(releaseDir, `.build-${Date.now().toString(36)}`);
  mkdirp(buildOutput);
  log("release/win-unpacked is locked by a running app (usually ComposeVC itself).");
  log(`packaging into ${path.relative(root, buildOutput)} and copying artifacts to release/…`);
}

const ebArgs = ["--win", "--x64", "--config", "electron-builder.yml"];
if (dirOnly) ebArgs.push("--dir");
if (stagedOutput) {
  // Relative path — no spaces/quoting issues, resolved against the project root.
  ebArgs.push(`--config.directories.output=${path.relative(root, buildOutput)}`);
}
// Never publish to GitHub etc.
ebArgs.push("--publish", "never");

log(dirOnly ? "electron-builder --dir (unpacked smoke)" : "electron-builder NSIS Setup EXE…");
if (exists(ebBin)) {
  run(ebBin, ebArgs, { shell: true });
} else {
  run("npx", ["electron-builder", ...ebArgs]);
}

// --- 6b) staged output → release/ (installer artifacts only) ---
if (stagedOutput) {
  const moved = [];
  const unpackedKept = [];
  for (const name of fs.readdirSync(buildOutput)) {
    const from = path.join(buildOutput, name);
    let st;
    try {
      st = fs.statSync(from);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name.endsWith("-unpacked")) unpackedKept.push(from);
      continue;
    }
    if (name === "builder-debug.yml") continue;
    const to = path.join(releaseDir, name);
    try {
      if (exists(to)) fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
      moved.push(name);
    } catch (error) {
      try {
        fs.copyFileSync(from, to);
        moved.push(name);
      } catch {
        fail(
          `cannot write ${name} into release/ — close the process using it (${
            error instanceof Error ? error.message : String(error)
          })`
        );
      }
    }
  }
  if (moved.length) log(`artifacts published to release/: ${moved.join(", ")}`);
  if (dirOnly && unpackedKept.length) {
    for (const p of unpackedKept) {
      log(`unpacked build kept at ${p} (release/win-unpacked is locked)`);
    }
    log("— run it from there, or close the app holding release/win-unpacked and rebuild.");
  } else {
    // NSIS build: the staged unpacked tree is disposable.
    if (!tryClearDir(buildOutput, 2)) {
      log(`note: staged build dir could not be removed yet: ${buildOutput}`);
    }
  }
}

log("done.");
if (exists(releaseDir)) {
  log(`artifacts in ${releaseDir}:`);
  for (const name of fs.readdirSync(releaseDir)) {
    const p = path.join(releaseDir, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) log(`  ${name}  (${(st.size / (1024 * 1024)).toFixed(1)} MB)`);
      else log(`  ${name}/`);
    } catch {
      log(`  ${name}`);
    }
  }
}

log(`
What the user gets:
  release/ComposeVC-Setup-*.exe  — one hardened installer
  Installs app.asar (OBFUSCATED main + minified UI, no src/) + resources/anti

Protection layers:
  1. No TypeScript/React/Go sources in the tree
  2. javascript-obfuscator on every electron/*.cjs (control-flow + RC4 strings)
  3. asar pack + Electron fuses (no RunAsNode / inspect / plain app folder)
  4. DevTools blocked in packaged windows (F12 / Ctrl+Shift+I)
  5. anti.exe stripped (-s -w), no profiles, captcha api_key scrubbed

Runtime anti root (writable):
  %APPDATA%/composevc/anti  (bootstrapped from resources/anti on first launch)
`);
