/**
 * Deterministic project scan for the Expert workspace.
 *
 * The Expert agent has to know a whole repository, not a folder the user happened
 * to mention. This module walks every text file (bounded), extracts declarations,
 * imports, IPC/HTTP contracts, storage keys and env vars, then builds a compact
 * digest that fits in a model context.
 *
 * The scan is the ground truth: even if every LLM round fails, the Expert still
 * has a real map of the project (files, symbols, couplings, contracts).
 */

const fs = require("fs");
const path = require("path");

const MAX_FILES = 5000;
const MAX_SYMBOLS_PER_FILE = 40;
const MAX_IMPORTS_PER_FILE = 60;
const MAX_READ_BYTES = 26 * 1024 * 1024;
const MAX_FILE_BYTES = 320 * 1024;
const MAX_DIR_ENTRIES = 1200;
const MAX_DEPTH = 12;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "release",
  "release-assets",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  "vendor",
  "target",
  ".idea",
  ".gradle",
  ".dart_tool",
  "Pods",
  ".terraform",
  ".backup",
  ".nyc_output",
]);

const TEXT_EXT = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".md",
  ".mdx",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".vue",
  ".svelte",
  ".astro",
  ".go",
  ".py",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".lua",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".cmd",
  ".xml",
  ".gradle",
  ".properties",
  ".proto",
  ".graphql",
  ".gql",
  ".dockerfile",
  ".env",
]);

const BINARY_EXT = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".pak",
  ".dat",
  ".wasm",
  ".zip",
  ".gz",
  ".tar",
  ".rar",
  ".7z",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".pdf",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".ogg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".node",
  ".pdb",
  ".lib",
  ".a",
  ".o",
  ".obj",
  ".class",
  ".jar",
  ".apk",
  ".dmg",
  ".msi",
  ".iso",
  ".crx",
]);

const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
]);

const KEY_FILE_PATTERNS = [
  /^package\.json$/i,
  /^readme(\.md|\.txt|\.rst)?$/i,
  /^tsconfig.*\.json$/i,
  /^vite\.config\.[a-z]+$/i,
  /^electron-builder\.(yml|yaml|json)$/i,
  /^go\.mod$/i,
  /^cargo\.toml$/i,
  /^pyproject\.toml$/i,
  /^requirements.*\.txt$/i,
  /^dockerfile$/i,
  /^docker-compose.*\.(yml|yaml)$/i,
  /^\.env\.example$/i,
  /^agents?\.md$/i,
  /^contributing\.md$/i,
  /^architecture\.md$/i,
];

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function extOf(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "dockerfile") return ".dockerfile";
  const ext = path.extname(base);
  return ext || "";
}

function looksBinary(buffer) {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function countLines(text) {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

const SYMBOL_RULES = {
  js: [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$])/,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  ],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^\s*type\s+([A-Za-z_]\w*)/],
  py: [/^\s*(?:class|def)\s+([A-Za-z_]\w*)/],
  rs: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
  php: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/, /^\s*(?:public|private|protected)?\s*(?:static\s+)?function\s+([A-Za-z_]\w*)/],
  rb: [/^\s*(?:class|module|def)\s+([A-Za-z_]\w*[!?=]?)/],
  java: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, /^\s*(?:public|private|protected)\s+[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/],
  c: [/^\s*(?:[\w*&:<>\s]+)\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?$/],
};

function symbolRulesFor(ext) {
  if ([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro"].includes(ext)) {
    return SYMBOL_RULES.js;
  }
  if (ext === ".go") return SYMBOL_RULES.go;
  if (ext === ".py") return SYMBOL_RULES.py;
  if (ext === ".rs") return SYMBOL_RULES.rs;
  if (ext === ".php") return SYMBOL_RULES.php;
  if (ext === ".rb") return SYMBOL_RULES.rb;
  if ([".java", ".kt", ".kts", ".cs", ".swift"].includes(ext)) return SYMBOL_RULES.java;
  if ([".c", ".h", ".cc", ".cpp", ".hpp"].includes(ext)) return SYMBOL_RULES.c;
  return [];
}

function extractSymbols(text, ext) {
  const rules = symbolRulesFor(ext);
  if (!rules.length) return [];
  const out = [];
  const seen = new Set();
  const lines = text.split("\n");
  const scanLines = Math.min(lines.length, 4000);
  for (let i = 0; i < scanLines && out.length < MAX_SYMBOLS_PER_FILE; i += 1) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const rule of rules) {
      const match = line.match(rule);
      if (!match) continue;
      const raw = match[1] || "";
      const names = raw.includes(",")
        ? raw.split(",").map((item) => item.split(":").pop().trim())
        : [raw.trim()];
      for (const name of names) {
        if (!name || seen.has(name) || name.length > 60) continue;
        seen.add(name);
        out.push({ n: name.slice(0, 60), l: i + 1 });
        if (out.length >= MAX_SYMBOLS_PER_FILE) break;
      }
      if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    }
  }
  return out;
}

function extractImports(text, ext) {
  if (![".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte", ".astro", ".go", ".py", ".rs"].includes(ext)) {
    return [];
  }
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const spec = String(value || "").trim();
    if (!spec || seen.has(spec) || out.length >= MAX_IMPORTS_PER_FILE) return;
    seen.add(spec);
    out.push(spec.slice(0, 200));
  };
  const reFrom = /\bfrom\s+["']([^"']+)["']/g;
  const reRequire = /\brequire\(\s*["']([^"']+)["']\s*\)/g;
  const reSide = /\bimport\s+["']([^"']+)["']/g;
  const reGo = /^\s*"([^"]+)"\s*$/gm;
  const rePy = /^\s*(?:from|import)\s+([A-Za-z_.][\w.]*)/gm;
  let match;
  while ((match = reFrom.exec(text))) push(match[1]);
  while ((match = reRequire.exec(text))) push(match[1]);
  while ((match = reSide.exec(text))) push(match[1]);
  if (ext === ".go") while ((match = reGo.exec(text))) push(match[1]);
  if (ext === ".py") while ((match = rePy.exec(text))) push(match[1]);
  return out;
}

function collectMatches(text, regex, limit = 200) {
  const out = [];
  const seen = new Set();
  let match;
  while ((match = regex.exec(text)) && out.length < limit) {
    const value = String(match[1] || match[2] || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value.slice(0, 200));
  }
  return out;
}

function detectContracts(text, ext, relPath) {
  const result = {};
  if ([".js", ".cjs", ".mjs", ".ts", ".tsx"].includes(ext)) {
    const ipcHandlers = collectMatches(text, /ipcMain\.(?:handle|on)\(\s*["'`]([^"'`]+)/g);
    const ipcCalls = collectMatches(text, /ipcRenderer\.(?:invoke|send|on)\(\s*["'`]([^"'`]+)/g);
    const routes = collectMatches(
      text,
      /(?:app|router|server)\.(?:get|post|put|patch|delete|use)\(\s*["'`]([^"'`]+)/g
    );
    const events = collectMatches(
      text,
      /(?:addEventListener|dispatchEvent)\(\s*["'`]([^"'`]+)|new\s+CustomEvent\(\s*["'`]([^"'`]+)/g
    );
    const storageKeys = collectMatches(
      text,
      /(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*["'`]([^"'`]+)/g
    );
    const env = collectMatches(text, /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, 120);
    const channels = collectMatches(text, /(?:send|invoke|handle|on)\(\s*["'`]([a-zA-Z][\w:.-]{2,60})["'`]/g, 120);
    if (ipcHandlers.length) result.ipcHandlers = ipcHandlers;
    if (ipcCalls.length) result.ipcCalls = ipcCalls;
    if (routes.length) result.routes = routes;
    if (events.length) result.events = events;
    if (storageKeys.length) result.storageKeys = storageKeys;
    if (env.length) result.env = env;
    if (channels.length) result.channels = channels;
  } else if (ext === ".go") {
    const routes = collectMatches(text, /(?:HandleFunc|Handle)\(\s*"([^"]+)"/g);
    const env = collectMatches(text, /os\.Getenv\(\s*"([^"]+)"/g);
    if (routes.length) result.routes = routes;
    if (env.length) result.env = env;
  } else if (ext === ".py") {
    const routes = collectMatches(text, /@(?:app|router)\.(?:get|post|put|patch|delete)\(\s*["']([^"']+)/g);
    const env = collectMatches(text, /os\.(?:environ\.get|getenv)\(\s*["']([^"']+)/g);
    if (routes.length) result.routes = routes;
    if (env.length) result.env = env;
  }
  if (!Object.keys(result).length) return null;
  return { ...result, file: relPath };
}

function isKeyFile(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (KEY_FILE_PATTERNS.some((re) => re.test(base))) return true;
  return false;
}

function gradeFile(relPath, ext, lines) {
  const p = relPath.toLowerCase();
  let score = Math.min(18, Math.log2(Math.max(1, lines)) * 2.2);
  if (/(^|\/)(main|index|app|server|cli|entry|bootstrap)\.(c|m)?(t|j)sx?$/.test(p)) score += 26;
  if (/^electron\/(main|preload|agentloop|context)\.cjs$/.test(p)) score += 30;
  if (p.startsWith("src/")) score += 6;
  if (p.includes("/components/")) score += 4;
  if (/(store|db|persist|schema|migration|router|ipc|provider|adapter|agent)/.test(p)) score += 8;
  if (/(test|spec)\.(c|m)?(t|j)sx?$/.test(p) || p.includes("__tests__")) score += 2;
  if (/(\.d\.ts|lock|\.min\.)/.test(p)) score -= 20;
  if (ext === ".md") score -= 8;
  if (ext === ".css" || ext === ".scss") score -= 6;
  return score;
}

function resolveImport(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const baseDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  return joined.startsWith(".") ? null : joined;
}

function makeCandidate(joined, known) {
  const options = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.cjs`,
    `${joined}.mjs`,
    `${joined}.jsx`,
    `${joined}/index.ts`,
    `${joined}/index.tsx`,
    `${joined}/index.js`,
    `${joined}/index.cjs`,
  ];
  for (const option of options) {
    if (known.has(option)) return option;
  }
  return null;
}

function walk(rootPath) {
  const files = [];
  const skippedDirs = [];
  let totalRead = 0;
  let binarySkipped = 0;
  let sizeSkipped = 0;
  let truncated = false;

  const stack = [{ dir: rootPath, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length > MAX_DIR_ENTRIES) {
      skippedDirs.push(toPosix(path.relative(rootPath, dir)) || ".");
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(rootPath, abs));
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower) || lower.startsWith(".git")) continue;
        stack.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      const base = entry.name.toLowerCase();
      if (LOCK_FILES.has(entry.name)) continue;
      if (/\.(min)\.(js|css)$/.test(base)) continue;
      const ext = extOf(abs);
      if (BINARY_EXT.has(ext)) {
        binarySkipped += 1;
        continue;
      }
      if (!TEXT_EXT.has(ext) && base !== "dockerfile" && !base.startsWith(".env")) {
        binarySkipped += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      const record = { p: rel, ext: ext || ".txt", size: stat.size, lines: 0, symbols: [], imports: [] };
      if (stat.size > MAX_FILE_BYTES) {
        sizeSkipped += 1;
        record.lines = Math.max(1, Math.round(stat.size / 40));
        files.push(record);
        continue;
      }
      if (totalRead + stat.size > MAX_READ_BYTES) {
        truncated = true;
        continue;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buffer)) {
        binarySkipped += 1;
        continue;
      }
      totalRead += stat.size;
      const text = buffer.toString("utf8");
      record.lines = countLines(text);
      record.symbols = extractSymbols(text, ext);
      record.imports = extractImports(text, ext);
      record.text = text;
      files.push(record);
    }
  }
  return { files, skippedDirs, truncated, binarySkipped, sizeSkipped, totalRead };
}

function scanProject(rootPath) {
  const root = typeof rootPath === "string" ? rootPath.trim() : "";
  if (!root || !fs.existsSync(root)) {
    throw new Error("Choose a project folder first");
  }
  const startedAt = Date.now();
  const { files, skippedDirs, truncated, binarySkipped, sizeSkipped, totalRead } = walk(root);
  const projectName = path.basename(root) || root;

  const known = new Set(files.map((file) => file.p));
  const usedBy = new Map();
  for (const file of files) {
    for (const spec of file.imports) {
      const target = resolveImport(file.p, spec);
      if (!target) continue;
      const resolved = makeCandidate(target, known);
      if (!resolved) continue;
      const list = usedBy.get(resolved) || [];
      if (!list.includes(file.p)) list.push(file.p);
      usedBy.set(resolved, list);
    }
  }

  const languages = new Map();
  const contracts = {
    ipcHandlers: [],
    ipcCalls: [],
    routes: [],
    events: [],
    storageKeys: [],
    env: [],
    channels: [],
  };
  const keyFiles = [];
  let totalLines = 0;

  for (const file of files) {
    totalLines += file.lines;
    const lang = languages.get(file.ext) || { ext: file.ext, files: 0, lines: 0 };
    lang.files += 1;
    lang.lines += file.lines;
    languages.set(file.ext, lang);

    const consumers = usedBy.get(file.p);
    if (consumers?.length) {
      file.usedBy = consumers.slice(0, 30);
    }
    if (file.text && [".js", ".cjs", ".mjs", ".ts", ".tsx", ".go", ".py", ".jsx"].includes(file.ext)) {
      const found = detectContracts(file.text, file.ext, file.p);
      if (found) {
        for (const key of Object.keys(found)) {
          if (key === "file") continue;
          for (const value of found[key]) {
            if (contracts[key].length < 300 && !contracts[key].includes(value)) contracts[key].push(value);
          }
        }
      }
    }
    if (file.text && isKeyFile(file.p)) {
      keyFiles.push({ p: file.p, text: file.text.slice(0, 6000) });
    }
    file.score = gradeFile(file.p, file.ext, file.lines) + (file.usedBy?.length || 0) * 3;
  }

  keyFiles.sort((a, b) => {
    const depth = a.p.split("/").length - b.p.split("/").length;
    if (depth !== 0) return depth;
    return a.p.localeCompare(b.p);
  });
  const keyFilesTop = keyFiles.slice(0, 26);

  const entrypoints = [];
  for (const file of files) {
    const p = file.p.toLowerCase();
    if (
      /(^|\/)(main|index|app|server|cli|preload|bootstrap)\.(c|m)?(t|j)sx?$/.test(p) &&
      file.lines > 20
    ) {
      entrypoints.push(file.p);
    }
  }

  // Manifests: package.json + go.mod + pyproject etc. are parsed for the digest.
  let manifest = null;
  const pkg = files.find((file) => file.p === "package.json");
  if (pkg?.text) {
    try {
      const parsed = JSON.parse(pkg.text);
      manifest = {
        name: parsed.name || null,
        version: parsed.version || null,
        main: parsed.main || null,
        module: parsed.module || null,
        scripts: parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {},
        dependencies: parsed.dependencies && typeof parsed.dependencies === "object" ? parsed.dependencies : {},
        devDependencies:
          parsed.devDependencies && typeof parsed.devDependencies === "object" ? parsed.devDependencies : {},
        workspaces: parsed.workspaces || null,
        packageManager: parsed.packageManager || null,
      };
    } catch {
      manifest = { error: "package.json is not valid JSON" };
    }
  }

  const files_compact = files
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((file, index) => ({
      p: file.p,
      ext: file.ext,
      size: file.size,
      lines: file.lines,
      score: Math.round(file.score * 10) / 10,
      symbols: file.symbols.slice(0, MAX_SYMBOLS_PER_FILE),
      // Persisting the full import graph for thousands of files makes the study
      // file huge; the top 600 carry every edge the digest and focus lists use.
      imports: index < 600 ? file.imports.slice(0, MAX_IMPORTS_PER_FILE) : [],
      ...(index < 600 && file.usedBy ? { usedBy: file.usedBy } : {}),
    }));

  // Strip text bodies before persisting: the digest below carries the excerpts.
  const scan = {
    rootPath: root,
    projectName,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    stats: {
      files: files.length,
      lines: totalLines,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      readBytes: totalRead,
      binarySkipped,
      sizeSkipped,
      skippedDirs: skippedDirs.slice(0, 40),
      truncated,
    },
    languages: [...languages.values()].sort((a, b) => b.lines - a.lines),
    manifest,
    entrypoints: [...new Set(entrypoints)].slice(0, 40),
    hotspots: files_compact.slice(0, 80).map((file) => file.p),
    contracts,
    keyFiles: keyFilesTop,
    files: files_compact,
  };

  return { scan, digest: buildDigestText(scan) };
}

function pct(part, total) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function topDir(filePath) {
  const parts = toPosix(filePath).split("/");
  return parts.length > 1 ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Compact, model-readable digest. Everything here is verified from the files on
 * disk — never from memory or guesses.
 */
function buildDigestText(scan, maxChars = 30000) {
  if (!scan) return "";
  const lines = [];
  const stats = scan.stats || {};
  lines.push(`PROJECT: ${scan.projectName || "?"} · ${stats.files || 0} files · ${stats.lines || 0} lines`);
  const langs = (scan.languages || [])
    .slice(0, 8)
    .map((lang) => `${lang.ext || ".?"}:${lang.files}f/${lang.lines}l`)
    .join(" ");
  if (langs) lines.push(`LANG: ${langs}`);

  const dirs = new Map();
  for (const file of scan.files || []) {
    const key = topDir(file.p);
    const entry = dirs.get(key) || { files: 0, lines: 0 };
    entry.files += 1;
    entry.lines += file.lines || 0;
    dirs.set(key, entry);
  }
  const dirText = [...dirs.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, 18)
    .map(([dir, info]) => `${dir}(${info.files})`)
    .join(" · ");
  if (dirText) lines.push(`FOLDERS: ${dirText}`);

  if (scan.manifest && !scan.manifest.error) {
    const scripts = Object.entries(scan.manifest.scripts || {})
      .slice(0, 14)
      .map(([name, cmd]) => `${name}=${String(cmd).slice(0, 90)}`)
      .join(" | ");
    if (scripts) lines.push(`SCRIPTS: ${scripts}`);
    const deps = Object.keys(scan.manifest.dependencies || {});
    if (deps.length) lines.push(`DEPS: ${deps.slice(0, 45).join(", ")}`);
    const devDeps = Object.keys(scan.manifest.devDependencies || {});
    if (devDeps.length) lines.push(`DEVDEPS: ${devDeps.slice(0, 30).join(", ")}`);
  }
  if ((scan.entrypoints || []).length) lines.push(`ENTRY: ${scan.entrypoints.slice(0, 18).join(", ")}`);

  lines.push("");
  lines.push("HOTSPOTS (most central files, with exact symbols):");
  for (const file of (scan.files || []).slice(0, 55)) {
    const symbols = (file.symbols || []).slice(0, 10).map((symbol) => symbol.n).join(", ");
    const usedBy = (file.usedBy || []).length;
    lines.push(
      `- ${file.p} · ${file.lines}l · usedBy ${usedBy}` + (symbols ? ` · ${symbols}` : "")
    );
  }

  const contracts = scan.contracts || {};
  const contractBlock = [];
  const addContracts = (label, list, limit = 40) => {
    if (!list?.length) return;
    contractBlock.push(`${label}: ${list.slice(0, limit).join(", ")}`);
  };
  addContracts("IPC handlers", contracts.ipcHandlers, 60);
  addContracts("IPC calls", contracts.ipcCalls, 60);
  addContracts("HTTP routes", contracts.routes, 40);
  addContracts("events", contracts.events, 40);
  addContracts("storage keys", contracts.storageKeys, 40);
  addContracts("env", contracts.env, 40);
  if (contractBlock.length) {
    lines.push("");
    lines.push("CONTRACTS:");
    lines.push(...contractBlock);
  }

  if ((scan.keyFiles || []).length) {
    lines.push("");
    lines.push("KEY FILES:");
    for (const file of scan.keyFiles) {
      lines.push(`--- ${file.p} ---`);
      lines.push(file.text.slice(0, 2200));
    }
  }

  lines.push("");
  lines.push("FILE INDEX (path · lines · symbols):");
  for (const file of (scan.files || []).slice(0, 260)) {
    const symbols = (file.symbols || []).slice(0, 5).map((symbol) => symbol.n).join(",");
    lines.push(`${file.p} · ${file.lines}l${symbols ? ` · ${symbols}` : ""}`);
  }

  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[digest truncated]` : text;
}

function fileCountByExt(scan) {
  const map = new Map();
  for (const file of scan?.files || []) {
    map.set(file.ext, (map.get(file.ext) || 0) + 1);
  }
  return map;
}

module.exports = {
  scanProject,
  buildDigestText,
  projectKeyHints: { toPosix, extOf },
  fileCountByExt,
  MAX_FILES,
  pct,
};
