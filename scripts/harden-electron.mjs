/**
 * harden-electron.mjs — obfuscate Electron main-process .cjs before packaging.
 *
 * Strategy (defense-in-depth, not perfect DRM):
 *  1. Copy electron/ → release-assets/electron-hard/
 *  2. javascript-obfuscator on every .cjs (control-flow + string array + dead code)
 *  3. Keep plain preload.cjs readable enough for Electron (still obfuscated lightly)
 *  4. package-dist points electron-builder at the hardened tree
 *
 * Usage:
 *   node scripts/harden-electron.mjs
 *   node scripts/harden-electron.mjs --light   # faster / less aggressive
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcElectron = path.join(root, "electron");
const outElectron = path.join(root, "release-assets", "electron-hard");

const light = process.argv.includes("--light");
const skip = process.argv.includes("--skip");

function log(m) {
  console.log(`[harden] ${m}`);
}
function fail(m, c = 1) {
  console.error(`[harden] ERROR: ${m}`);
  process.exit(c);
}
function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
function rmrf(p) {
  if (exists(p)) fs.rmSync(p, { recursive: true, force: true });
}
function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}
function isMarkdown(name) {
  return /\.(md|markdown|mdx)$/i.test(name);
}

function copyRecursive(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    mkdirp(dest);
    for (const name of fs.readdirSync(src)) {
      if (isMarkdown(name)) continue;
      copyRecursive(path.join(src, name), path.join(dest, name));
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

function listCjs(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listCjs(p, acc);
    else if (ent.isFile() && ent.name.endsWith(".cjs")) acc.push(p);
  }
  return acc;
}

async function ensureObfuscator() {
  try {
    await import("javascript-obfuscator");
    return true;
  } catch {
    log("installing javascript-obfuscator…");
    const r = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--save-dev", "javascript-obfuscator@^4.1.1", "--no-fund", "--no-audit"],
      { cwd: root, stdio: "inherit", shell: true }
    );
    if (r.status !== 0) fail("failed to install javascript-obfuscator");
    return true;
  }
}

function obfuscateOptions(filePath, isPreload) {
  // Preload must stay valid CommonJS for Electron sandbox; still scramble strings.
  if (isPreload || light) {
    return {
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      selfDefending: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.75,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      target: "node",
      // Keep require/module.exports intact
      reservedNames: ["^require$", "^module$", "^exports$", "^__dirname$", "^__filename$", "^process$", "^Buffer$", "^global$"],
      reservedStrings: [],
    };
  }

  // Heavy main-process options — still CommonJS-safe (no renameGlobals / selfDefending
  // that break Electron require graph).
  return {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.25,
    debugProtection: false, // true can hang Electron main; block DevTools at runtime instead
    disableConsoleOutput: true,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ["rc4"],
    stringArrayIndexShift: true,
    stringArrayRotate: true,
    stringArrayShuffle: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function",
    stringArrayThreshold: 0.85,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
    target: "node",
    reservedNames: [
      "^require$",
      "^module$",
      "^exports$",
      "^__dirname$",
      "^__filename$",
      "^process$",
      "^Buffer$",
      "^global$",
      "^setImmediate$",
      "^clearImmediate$",
    ],
    seed: crypto.createHash("sha256").update(filePath).digest().readUInt32BE(0),
  };
}

async function main() {
  if (skip) {
    log("--skip: leave previous release-assets/electron-hard if any");
    process.exit(0);
  }

  if (!exists(srcElectron)) fail(`missing ${srcElectron}`);

  await ensureObfuscator();
  const JavaScriptObfuscator = (await import("javascript-obfuscator")).default;

  log(`copy electron → ${outElectron}`);
  rmrf(outElectron);
  copyRecursive(srcElectron, outElectron);
  const mdStripped = stripMarkdown(outElectron);
  if (mdStripped) log(`stripped ${mdStripped} markdown file(s)`);

  // Drop runtime companion from the ship tree (belt + suspenders; builder also excludes)
  for (const drop of ["runtimeApp.cjs", "runtimeMain.cjs"]) {
    const p = path.join(outElectron, drop);
    if (exists(p)) {
      fs.unlinkSync(p);
      log(`removed ${drop}`);
    }
  }

  const files = listCjs(outElectron);
  log(`obfuscating ${files.length} .cjs files (${light ? "light" : "heavy"})…`);

  // Wire-format / JSON-critical paths: heavy control-flow + selfDefending has
  // caused subtle runtime corruption on packaged builds (Codex 400 hex-escape
  // on function_call_output). Always use light options for these files.
  const lightAlways = new Set([
    "proxy/openaiFormat.cjs",
    "proxy/pipeline.cjs",
    "proxy/convert/openai-to-responses.cjs",
    "proxy/convert/responses-to-openai.cjs",
    "proxy/sse.cjs",
    "adapters/openai.cjs",
    "adapters/utils.cjs",
    "agentLoop.cjs",
  ]);

  let ok = 0;
  let failN = 0;
  for (const file of files) {
    const rel = path.relative(outElectron, file).replace(/\\/g, "/");
    const isPreload = /preload\.cjs$/i.test(rel);
    const forceLight = isPreload || light || lightAlways.has(rel);
    // Skip huge generated-looking files if any — none expected
    let source;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch (e) {
      log(`skip read ${rel}: ${e.message}`);
      failN += 1;
      continue;
    }
    if (source.length < 20) {
      ok += 1;
      continue;
    }
    try {
      const result = JavaScriptObfuscator.obfuscate(
        source,
        obfuscateOptions(rel, forceLight)
      );
      const code = result.getObfuscatedCode();
      // Sanity: must still look like CommonJS entry
      if (!code || code.length < 10) throw new Error("empty obfuscated output");
      fs.writeFileSync(file, code, "utf8");
      ok += 1;
      if (ok % 25 === 0) log(`  … ${ok}/${files.length}`);
    } catch (e) {
      // Keep original on failure so packaging still works
      log(`WARN obfuscate failed ${rel}: ${e.message} (keeping plain)`);
      failN += 1;
    }
  }

  // Marker for package-dist
  fs.writeFileSync(
    path.join(outElectron, ".hardened"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        files: files.length,
        ok,
        fail: failN,
        mode: light ? "light" : "heavy",
      },
      null,
      2
    ),
    "utf8"
  );

  log(`done: obfuscated ${ok}/${files.length} (kept plain on fail: ${failN})`);
  log(`output: ${outElectron}`);
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
