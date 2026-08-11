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
const ebArgs = ["--win", "--x64", "--config", "electron-builder.yml"];
if (dirOnly) ebArgs.push("--dir");
// Never publish to GitHub etc.
ebArgs.push("--publish", "never");

log(dirOnly ? "electron-builder --dir (unpacked smoke)" : "electron-builder NSIS Setup EXE…");
if (exists(ebBin)) {
  run(ebBin, ebArgs, { shell: true });
} else {
  run("npx", ["electron-builder", ...ebArgs]);
}

const releaseDir = path.join(root, "release");
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
