/**
 * harden-renderer.mjs — obfuscate the built React bundle (dist/assets/*.js).
 *
 * Vite already minifies, but minified JS beautifies straight back to readable
 * logic. This scrambles it: RC4 string array + wrappers, control-flow
 * flattening, hex identifiers, console stripped.
 *
 * Deliberately NOT enabled:
 *  - selfDefending / debugProtection: they insert anti-tamper traps that can
 *    freeze a Chromium renderer or spin the CPU; DevTools are already blocked
 *    in packaged windows, so the payoff is not worth the breakage risk.
 *  - deadCodeInjection / transformObjectKeys: size + subtle-break risk for a
 *    2.5 MB React graph, for little extra deterrence.
 *
 * Safe because the Vite output is a SINGLE self-contained module with no
 * dynamic import()s — there are no cross-chunk identifier bindings to break,
 * and asset URLs are runtime-decoded back to their exact strings.
 *
 * Usage:
 *   node scripts/harden-renderer.mjs [--light] [--dir dist]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const light = process.argv.includes("--light");
const dirFlagIdx = process.argv.indexOf("--dir");
const distDir =
  dirFlagIdx >= 0 && process.argv[dirFlagIdx + 1]
    ? path.resolve(root, process.argv[dirFlagIdx + 1])
    : path.join(root, "dist");

const BANNER = "/*cvc-rh*/"; // marker: already hardened, never double-process

function log(m) {
  console.log(`[harden-renderer] ${m}`);
}
function fail(m, c = 1) {
  console.error(`[harden-renderer] ERROR: ${m}`);
  process.exit(c);
}

async function ensureObfuscator() {
  try {
    return (await import("javascript-obfuscator")).default;
  } catch {
    log("installing javascript-obfuscator…");
    const r = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "--save-dev", "javascript-obfuscator@^4.1.1", "--no-fund", "--no-audit"],
      { cwd: root, stdio: "inherit", shell: true }
    );
    if (r.status !== 0) fail("failed to install javascript-obfuscator");
    return (await import("javascript-obfuscator")).default;
  }
}

function options() {
  if (light) {
    return {
      compact: true,
      target: "browser",
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: true,
      identifierNamesGenerator: "hexadecimal",
      numbersToExpressions: false,
      renameGlobals: false,
      selfDefending: false,
      simplify: true,
      splitStrings: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.7,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    };
  }
  return {
    compact: true,
    target: "browser",
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.6,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: true,
    identifierNamesGenerator: "hexadecimal",
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayEncoding: ["rc4"],
    stringArrayThreshold: 0.75,
    stringArrayCallsTransform: true,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    stringArrayWrappersType: "function",
    stringArrayRotate: true,
    stringArrayShuffle: true,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
  };
}

async function main() {
  const assets = path.join(distDir, "assets");
  if (!fs.existsSync(assets)) fail(`no ${assets} — run the web build first`);

  const jsFiles = fs
    .readdirSync(assets)
    .filter((n) => n.endsWith(".js"))
    .map((n) => path.join(assets, n));

  if (jsFiles.length === 0) fail("no .js files in dist/assets");

  const JavaScriptObfuscator = await ensureObfuscator();
  log(`obfuscating ${jsFiles.length} renderer bundle(s) (${light ? "light" : "heavy"})…`);

  let ok = 0;
  let total = 0;
  let outBytes = 0;
  for (const file of jsFiles) {
    const source = fs.readFileSync(file, "utf8");
    total += source.length;
    if (source.startsWith(BANNER)) {
      log(`skip ${path.basename(file)} (already hardened)`);
      ok += 1;
      outBytes += source.length;
      continue;
    }
    const result = JavaScriptObfuscator.obfuscate(source, options());
    const code = result.getObfuscatedCode();
    if (!code || code.length < 100) fail(`obfuscation produced empty output for ${file}`);
    const withBanner = BANNER + code;
    fs.writeFileSync(file, withBanner, "utf8");
    outBytes += withBanner.length;
    ok += 1;
    log(
      `  ${path.basename(file)}: ${(source.length / 1024).toFixed(0)}KB → ${(withBanner.length / 1024).toFixed(0)}KB`
    );
  }

  log(
    `done: ${ok}/${jsFiles.length} bundle(s), ${(total / 1024 / 1024).toFixed(1)}MB → ${(outBytes / 1024 / 1024).toFixed(1)}MB`
  );
}

main().catch((e) => fail(e?.stack || e?.message || String(e)));
