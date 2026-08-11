/**
 * Code Impact Engine (production) — structural index for agent multi-file discipline.
 *
 * Wired by: codeImpactHost.cjs (lifecycle/session) + agentLoop.cjs
 * (after-write cards + beforeFinal blocker nudges). NOT a full LSP — regex outline only.
 * Never eval user project code. Query tokens are structural (paths/tools/ipc), never chat prose.
 *
 * A) Protocol: short ranked impact cards for the model (context budget).
 * C) Loop: after write → impact → inject; open blockers → nudge before "done".
 *
 * Designed for 10k+ file codebases:
 *  - cheap file walk + per-file parse
 *  - mtime/size digest incremental updates
 *  - inverted indexes (exports, symbols, strings, ipc, registers)
 *  - hard caps on obligations / card size (context must not float)
 *  - structural + convention edges beat noisy user-word matches
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec: executeWorkerTask } = require("./workerPool.cjs");

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  "coverage",
  ".backup",
  ".cache",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".turbo",
  ".idea",
  ".vscode",
  // bundled runtime data can hold generated JavaScript caches
  "profiles",
  // generated packaging output (harden-electron.mjs obfuscated bundle) — never index
  "release-assets",
  "Code Cache",
  "GPUCache",
  "logs",
  "tmp",
  "temp",
  ".tmp",
  ".temp",
  "runtime-app",
  "storybook-static",
  "dist-ssr",
  ".venv",
  "venv",
  "Pods",
  ".pnpm-store",
]);

/** Common export/symbol names that must not create cross-file symbol_ref obligations. */
const SYMBOL_NOISE = new Set([
  "default",
  "name",
  "exports",
  "module",
  "require",
  "execute",
  "init",
  "run",
  "main",
  "start",
  "stop",
  "close",
  "open",
  "get",
  "set",
  "create",
  "update",
  "delete",
  "dispatch",
  "handler",
  "handle",
  "render",
  "load",
  "save",
  "parse",
  "format",
  "toString",
  "value",
  "data",
  "error",
  "result",
  "config",
  "options",
  "setup",
  "test",
  "describe",
  "it",
  "before",
  "after",
]);

const SOURCE_EXT = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".go",
  ".json",
  ".md",
  ".py",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".vue",
  ".svelte",
]);

const SEVERITY_RANK = { blocker: 0, should: 1, info: 2 };

const DEFAULT_BUDGET = {
  maxObligations: 12,
  maxBlockers: 6,
  maxCardChars: 2200,
  maxCardLines: 48,
  maxNeighborsDepth: 2,
  maxStringHitFiles: 40,
  maxParseBytes: 512 * 1024,
};

// ─── path helpers ───────────────────────────────────────────────────────────

function normPath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function relToRoot(root, abs) {
  return normPath(path.relative(root, abs));
}

function isIgnoredName(name) {
  if (!name) return true;
  if (DEFAULT_IGNORE.has(name)) return true;
  // secret / env material — never index
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".pem") || name.endsWith(".key")) {
    return true;
  }
  // hide most dotdirs; allow .env.example only for docs
  if (name.startsWith(".") && name !== ".env.example") return true;
  return false;
}

function isSourceFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SOURCE_EXT.has(ext);
}

// ─── parse one file ─────────────────────────────────────────────────────────

/**
 * Lightweight multi-lang outline. Not a full AST — enough for agent impact.
 * @returns {{ imports: string[], exports: string[], symbols: string[], strings: string[],
 *   ipcHandlers: string[], ipcInvokes: string[], registers: string[], requires: string[],
 *   toolNames: string[], kindHints: string[] }}
 */
function parseFileContent(content, filePath) {
  const text = String(content || "");
  const rel = normPath(filePath);
  const ext = path.extname(rel).toLowerCase();

  const imports = [];
  const exports = [];
  const symbols = [];
  const strings = [];
  const ipcHandlers = [];
  const ipcInvokes = [];
  const registers = [];
  const requires = [];
  const toolNames = [];
  const kindHints = [];

  const pushUnique = (arr, v) => {
    if (!v) return;
    const s = String(v).trim();
    if (!s || s.length > 200) return;
    if (!arr.includes(s)) arr.push(s);
  };

  // require / import paths
  const reRequire = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reImportFrom = /import\s+(?:type\s+)?(?:[^'"\n]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const reExportFrom = /export\s+.+?\s+from\s+['"]([^'"]+)['"]/g;
  const reDynamicImport = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const reGoImport = /^\s*"([^"]+)"\s*$/gm;

  let m;
  while ((m = reRequire.exec(text))) {
    pushUnique(requires, m[1]);
    pushUnique(imports, m[1]);
  }
  while ((m = reImportFrom.exec(text))) pushUnique(imports, m[1]);
  while ((m = reExportFrom.exec(text))) pushUnique(imports, m[1]);
  while ((m = reDynamicImport.exec(text))) pushUnique(imports, m[1]);
  if (ext === ".go") {
    while ((m = reGoImport.exec(text))) {
      if (m[1].includes(".") || m[1].includes("/")) pushUnique(imports, m[1]);
    }
  }

  // exports / symbols
  const reModuleExport = /(?:module\.exports|exports)\s*=\s*\{([^}]{0,2000})\}/g;
  const reExportsDot = /exports\.([A-Za-z_$][\w$]*)/g;
  const reExportNamed =
    /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const reExportDefault = /export\s+default\s+(?:async\s+)?(?:function|class)?\s*([A-Za-z_$][\w$]*)?/g;
  const reFunc = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  const reClass = /class\s+([A-Za-z_$][\w$]*)/g;
  const reConstFn =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  const reGoFunc = /^func\s+(?:\([^)]*\)\s*)?([A-Z][\w]*)/gm;

  while ((m = reModuleExport.exec(text))) {
    const body = m[1];
    for (const part of body.split(",")) {
      const name = part.split(":")[0].trim().replace(/['"]/g, "");
      if (/^[A-Za-z_$][\w$]*$/.test(name)) {
        pushUnique(exports, name);
        pushUnique(symbols, name);
      }
    }
  }
  while ((m = reExportsDot.exec(text))) {
    pushUnique(exports, m[1]);
    pushUnique(symbols, m[1]);
  }
  while ((m = reExportNamed.exec(text))) {
    pushUnique(exports, m[1]);
    pushUnique(symbols, m[1]);
  }
  while ((m = reExportDefault.exec(text))) {
    if (m[1]) {
      pushUnique(exports, m[1]);
      pushUnique(symbols, m[1]);
    } else {
      pushUnique(exports, "default");
    }
  }
  while ((m = reFunc.exec(text))) pushUnique(symbols, m[1]);
  while ((m = reClass.exec(text))) pushUnique(symbols, m[1]);
  while ((m = reConstFn.exec(text))) pushUnique(symbols, m[1]);
  if (ext === ".go") {
    while ((m = reGoFunc.exec(text))) {
      pushUnique(exports, m[1]);
      pushUnique(symbols, m[1]);
    }
  }

  // TOOLS = [ readFile, editFile ] style registers
  const reToolsArray = /\bTOOLS\s*=\s*\[([^\]]{0,4000})\]/g;
  while ((m = reToolsArray.exec(text))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(name)) pushUnique(registers, name);
    }
  }
  // ALL_TOOL_NAMES = [ "read_file", ... ]
  const reToolNamesArr = /\bALL_TOOL_NAMES\s*=\s*\[([^\]]{0,8000})\]/g;
  while ((m = reToolNamesArr.exec(text))) {
    const reStr = /['"]([a-z][a-z0-9_]{1,64})['"]/g;
    let sm;
    while ((sm = reStr.exec(m[1]))) pushUnique(toolNames, sm[1]);
  }
  // name: "cf_mail" / name = "edit_file" in tool modules
  const reToolNameField =
    /\bname\s*[:=]\s*['"]([a-z][a-z0-9_]{1,64})['"]/g;
  while ((m = reToolNameField.exec(text))) {
    // only count if looks like tool module path or near execute
    if (/tools\//.test(rel) || /\bexecute\s*[:(]/.test(text)) {
      pushUnique(toolNames, m[1]);
    }
  }

  // IPC — require ipcRenderer.invoke / ipc.invoke (not arbitrary SDK .invoke).
  // Skip tests/fixtures so sample source strings do not pollute the real graph.
  const skipIpcIndex = /(^|\/)(tests|test|__tests__|fixtures)\//i.test(rel);
  if (!skipIpcIndex) {
    const reIpcHandle = /ipcMain\.handle\s*\(\s*['"]([^'"]+)['"]/g;
    const reIpcOn = /ipcMain\.on\s*\(\s*['"]([^'"]+)['"]/g;
    const reInvoke =
      /(?:ipcRenderer|ipc)\.invoke\s*\(\s*['"]([^'"]+)['"]/g;
    // also window.api / electronAPI style bridges that pass channel string first
    const reBridgeInvoke =
      /(?:window\.)?(?:api|electronAPI|lopster|kitsune)\.\w+\s*\(\s*['"]([a-zA-Z][\w.-]*:[\w.-]+)['"]/g;
    while ((m = reIpcHandle.exec(text))) pushUnique(ipcHandlers, m[1]);
    while ((m = reIpcOn.exec(text))) pushUnique(ipcHandlers, m[1]);
    while ((m = reInvoke.exec(text))) pushUnique(ipcInvokes, m[1]);
    while ((m = reBridgeInvoke.exec(text))) pushUnique(ipcInvokes, m[1]);
  }

  // meaningful strings (identifiers, channels, tool-like) — NOT free user prose
  const reString = /['"`]([^'"`\n]{2,80})['"`]/g;
  const seenStr = new Set();
  while ((m = reString.exec(text))) {
    const s = m[1];
    if (seenStr.has(s)) continue;
    if (!isIndexableString(s)) continue;
    seenStr.add(s);
    pushUnique(strings, s);
    if (seenStr.size > 80) break;
  }

  // kind hints for convention rules
  // Agent tool modules ONLY under electron/tools/* (never tests/tools, proxy/*, etc.)
  if (/(^|\/)electron\/tools\/[^/]+\.(cjs|js|ts|mjs)$/.test(rel)) {
    if (!/\/registry\.(cjs|js|ts|mjs)$/i.test(rel)) {
      kindHints.push("tool_module");
    }
  }
  // Agent tool registry ONLY — not proxy/providers/registry or convert/registry.
  if (
    /(^|\/)electron\/tools\/registry\.(cjs|js|ts)$/.test(rel) ||
    /(^|\/)tools\/registry\.(cjs|js|ts)$/.test(rel)
  ) {
    kindHints.push("tool_registry");
  }
  // Prefer electron/ roots so random package main.ts is not treated as Electron main/preload
  if (/(^|\/)electron\/preload\.(cjs|js|ts)$/.test(rel) || /(^|\/)preload\.(cjs|js|ts)$/.test(rel)) {
    kindHints.push("preload");
  }
  if (/(^|\/)electron\/main\.(cjs|js|ts)$/.test(rel) || /(^|\/)main\.(cjs|js|ts)$/.test(rel)) {
    kindHints.push("main");
  }
  if (/(^|\/)context\.(cjs|js|ts)$/.test(rel)) kindHints.push("context_prompt");
  if (/(^|\/)lopsterHo\.(cjs|js|ts)$/.test(rel)) kindHints.push("ho_prompt");

  return {
    imports,
    exports,
    symbols,
    strings,
    ipcHandlers,
    ipcInvokes,
    registers,
    requires,
    toolNames,
    kindHints,
  };
}

/**
 * Reject chatty / noisy user words. Keep structural identifiers.
 * "сопли", "привет", random prose must NOT become edges.
 */
function isIndexableString(s) {
  if (!s || s.length < 2 || s.length > 80) return false;
  // paths / modules
  if (s.startsWith(".") || s.startsWith("/") || s.includes("/")) return true;
  // ipc-like a:b or a:b:c
  if (/^[a-zA-Z][\w.-]*:[\w.-]+$/.test(s)) return true;
  // snake tool names
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(s)) return true;
  // camel / Pascal identifiers
  if (/^[A-Za-z_$][\w$]{1,64}$/.test(s) && /[A-Z]/.test(s[0] + s.slice(1))) return true;
  if (/^[a-z][a-zA-Z0-9]{2,64}$/.test(s) && /[A-Z]/.test(s)) return true;
  // pure lower single words (user chat) — reject unless tool-like length with underscore already handled
  if (/^[a-zа-яёїієґ]+$/i.test(s) && !s.includes("_") && s.length < 24) return false;
  // spaces / punctuation prose
  if (/\s/.test(s)) return false;
  if (/[.,!?;:]/.test(s) && !s.includes(":")) return false;
  // hex hashes noise
  if (/^[a-f0-9]{16,}$/i.test(s)) return false;
  return false;
}

function resolveImport(fromRel, spec, fileIndex) {
  if (!spec) return null;
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    // bare package — not a project file edge
    return null;
  }
  const fromDir = path.posix.dirname(fromRel);
  let base = normPath(path.posix.normalize(path.posix.join(fromDir, spec)));
  const candidates = [
    base,
    base + ".cjs",
    base + ".js",
    base + ".mjs",
    base + ".ts",
    base + ".tsx",
    base + ".jsx",
    base + ".mts",
    base + ".cts",
    base + ".json",
    base + "/index.cjs",
    base + "/index.js",
    base + "/index.mjs",
    base + "/index.ts",
    base + "/index.tsx",
    base + "/index.jsx",
  ];
  for (const c of candidates) {
    if (fileIndex.has(c)) return c;
  }
  // Do not invent ghost edges for unresolved relatives
  return null;
}

/**
 * Resolve path seeds for impact: exact match first; basename only if unique;
 * path suffix only with / boundary. Never bare endsWith on short fragments.
 */
function resolveTouchedPaths(filesMap, paths) {
  const touched = new Set();
  const keys = [...filesMap.keys()];
  for (const p of paths || []) {
    const n = normPath(p);
    if (!n) continue;
    if (filesMap.has(n)) {
      touched.add(n);
      continue;
    }
    // suffix with directory boundary
    if (n.includes("/")) {
      const hits = keys.filter((rel) => rel === n || rel.endsWith("/" + n));
      for (const h of hits) touched.add(h);
      continue;
    }
    // basename-only: unique match required
    const baseHits = keys.filter((rel) => {
      const base = path.posix.basename(rel);
      return base === n || base === n + path.posix.extname(base) || rel.endsWith("/" + n);
    });
    // also exact basename without forcing ext
    const exactBase = keys.filter((rel) => path.posix.basename(rel) === n);
    const pool = exactBase.length ? exactBase : baseHits;
    if (pool.length === 1) touched.add(pool[0]);
    else if (pool.length > 1 && n.length >= 8) {
      // long unique-ish names: only if single endsWith("/"+n)
      const strict = keys.filter((rel) => rel.endsWith("/" + n));
      if (strict.length === 1) touched.add(strict[0]);
    }
  }
  return touched;
}

// ─── Engine ─────────────────────────────────────────────────────────────────

class CodeImpactEngine {
  /**
   * @param {{ root: string, budget?: Partial<typeof DEFAULT_BUDGET>, ignore?: Set<string> }} opts
   */
  constructor(opts) {
    if (!opts || !opts.root) throw new Error("CodeImpactEngine: root required");
    this.root = path.resolve(opts.root);
    this.budget = { ...DEFAULT_BUDGET, ...(opts.budget || {}) };
    this.ignore = opts.ignore || DEFAULT_IGNORE;

    /** @type {Map<string, FileRecord>} */
    this.files = new Map();
    /** @type {Map<string, Set<string>>} */
    this.exportIndex = new Map(); // symbol -> files
    /** @type {Map<string, Set<string>>} */
    this.symbolIndex = new Map();
    /** @type {Map<string, Set<string>>} */
    this.stringIndex = new Map();
    /** @type {Map<string, Set<string>>} */
    this.ipcHandleIndex = new Map();
    /** @type {Map<string, Set<string>>} */
    this.ipcInvokeIndex = new Map();
    /** @type {Map<string, Set<string>>} */
    this.toolNameIndex = new Map();
    /** @type {Map<string, Set<string>>} */
    this.registerIndex = new Map(); // register name -> registry files
    /** @type {Map<string, Set<string>>} */
    this.importEdge = new Map(); // from -> Set(to)
    /** @type {Map<string, Set<string>>} */
    this.importedBy = new Map(); // to -> Set(from)

    /** session obligations for loop C */
    this.session = {
      open: new Map(), // id -> obligation
      closed: new Set(),
      lastInject: null,
      writeCount: 0,
    };

    this.stats = {
      files: 0,
      bytes: 0,
      parseMs: 0,
      lastFullIndexMs: 0,
      lastImpactMs: 0,
    };
  }

  // ── index ───────────────────────────────────────────────────────────────

  async fullIndex() {
    const t0 = Date.now();
    this._clearIndexes();
    const list = [];
    await this._walk(this.root, list);
    // Bounded concurrency — large monorepos pay serial IO otherwise
    const concurrency = Math.min(24, Math.max(4, require("os").cpus?.()?.length || 8));
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const my = idx;
        idx += 1;
        await this._indexFile(list[my], { skipRebuild: true });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, () => worker()));
    this._rebuildInverted();
    this.stats.files = this.files.size;
    this.stats.lastFullIndexMs = Date.now() - t0;
    return {
      files: this.files.size,
      ms: this.stats.lastFullIndexMs,
      bytes: this.stats.bytes,
    };
  }

  async reindexPaths(paths) {
    const t0 = Date.now();
    const rels = [];
    for (const p of paths || []) {
      const abs = path.isAbsolute(p) ? p : path.join(this.root, p);
      const rel = relToRoot(this.root, abs);
      if (!fs.existsSync(abs)) {
        // subtract previous stats contribution when possible
        const prev = this.files.get(rel);
        if (prev) {
          this.stats.bytes = Math.max(0, this.stats.bytes - (prev.size || 0));
        }
        this._removeFile(rel);
        rels.push(rel);
        continue;
      }
      const prev = this.files.get(rel);
      if (prev) {
        this.stats.bytes = Math.max(0, this.stats.bytes - (prev.size || 0));
      }
      await this._indexFile(abs, { skipRebuild: true });
      rels.push(rel);
    }
    this._rebuildInverted();
    this.stats.files = this.files.size;
    return { files: rels.length, ms: Date.now() - t0 };
  }

  async _walk(dir, out) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (isIgnoredName(ent.name) || this.ignore.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await this._walk(abs, out);
      } else if (ent.isFile() && isSourceFile(abs)) {
        out.push(abs);
      }
    }
  }

  async _indexFile(abs, { skipRebuild } = {}) {
    const rel = relToRoot(this.root, abs);
    let st;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      this._removeFile(rel);
      return null;
    }
    const prev = this.files.get(rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      return prev;
    }

    let content = "";
    let bytes = st.size;
    try {
      if (st.size > this.budget.maxParseBytes) {
        const fh = await fs.promises.open(abs, "r");
        try {
          const buf = Buffer.alloc(this.budget.maxParseBytes);
          const { bytesRead } = await fh.read(buf, 0, this.budget.maxParseBytes, 0);
          content = buf.slice(0, bytesRead).toString("utf8");
        } finally {
          await fh.close();
        }
      } else {
        content = await fs.promises.readFile(abs, "utf8");
      }
    } catch {
      content = "";
    }

    const t0 = Date.now();
    const parsed = await executeWorkerTask("parseFileContent", { content, filePath: rel });
    this.stats.parseMs += Date.now() - t0;
    this.stats.bytes += bytes;

    const digest = await executeWorkerTask("hashContent", { content });

    const rec = {
      rel,
      abs,
      mtimeMs: st.mtimeMs,
      size: st.size,
      digest,
      ...parsed,
    };
    this.files.set(rel, rec);
    if (!skipRebuild) this._rebuildInverted();
    return rec;
  }

  _removeFile(rel) {
    this.files.delete(rel);
  }

  _clearIndexes() {
    this.files.clear();
    this.exportIndex.clear();
    this.symbolIndex.clear();
    this.stringIndex.clear();
    this.ipcHandleIndex.clear();
    this.ipcInvokeIndex.clear();
    this.toolNameIndex.clear();
    this.registerIndex.clear();
    this.importEdge.clear();
    this.importedBy.clear();
    this.stats.bytes = 0;
    this.stats.parseMs = 0;
  }

  _addInv(map, key, file) {
    if (!key) return;
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(file);
  }

  _rebuildInverted() {
    this.exportIndex.clear();
    this.symbolIndex.clear();
    this.stringIndex.clear();
    this.ipcHandleIndex.clear();
    this.ipcInvokeIndex.clear();
    this.toolNameIndex.clear();
    this.registerIndex.clear();
    this.importEdge.clear();
    this.importedBy.clear();

    for (const [rel, rec] of this.files) {
      for (const e of rec.exports) this._addInv(this.exportIndex, e, rel);
      for (const s of rec.symbols) this._addInv(this.symbolIndex, s, rel);
      for (const s of rec.strings) this._addInv(this.stringIndex, s, rel);
      for (const h of rec.ipcHandlers) this._addInv(this.ipcHandleIndex, h, rel);
      for (const h of rec.ipcInvokes) this._addInv(this.ipcInvokeIndex, h, rel);
      for (const t of rec.toolNames) this._addInv(this.toolNameIndex, t, rel);
      for (const r of rec.registers) this._addInv(this.registerIndex, r, rel);

      const outs = new Set();
      for (const spec of rec.imports) {
        const to = resolveImport(rel, spec, this.files);
        if (to) outs.add(to);
      }
      this.importEdge.set(rel, outs);
      for (const to of outs) {
        if (!this.importedBy.has(to)) this.importedBy.set(to, new Set());
        this.importedBy.get(to).add(rel);
      }
    }
  }

  // ── impact ──────────────────────────────────────────────────────────────

  /**
   * Core A: exact relations for touched paths / symbols.
   * Never depends on free-form user chat words.
   */
  impact(input = {}) {
    const t0 = Date.now();
    const paths = (input.paths || []).map((p) => normPath(p));
    const symbols = input.symbols || [];
    const query = String(input.query || "").trim();

    const touched = resolveTouchedPaths(this.files, paths);
    for (const sym of symbols) {
      for (const f of this.exportIndex.get(sym) || []) touched.add(f);
      for (const f of this.symbolIndex.get(sym) || []) touched.add(f);
    }

    // query is ONLY for explicit symbol/path tokens — not prose
    if (query) {
      const tokens = tokenizeQuery(query);
      for (const tok of tokens) {
        if (this.files.has(tok)) touched.add(tok);
        for (const f of this.exportIndex.get(tok) || []) touched.add(f);
        for (const f of this.symbolIndex.get(tok) || []) touched.add(f);
        for (const f of this.toolNameIndex.get(tok) || []) touched.add(f);
        for (const f of this.ipcHandleIndex.get(tok) || []) touched.add(f);
        // path substring only if token looks like path fragment
        if (tok.includes("/") || tok.includes(".")) {
          for (const rel of this.files.keys()) {
            if (rel.includes(tok)) touched.add(rel);
          }
        }
      }
    }

    const obligations = [];
    const seen = new Set();

    const addOb = (ob) => {
      const key = `${ob.severity}|${ob.path}|${ob.reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      obligations.push(ob);
    };

    for (const rel of touched) {
      const rec = this.files.get(rel);
      if (!rec) continue;

      // importers
      for (const from of this.importedBy.get(rel) || []) {
        addOb({
          id: `imp:${from}->${rel}`,
          path: from,
          severity: "should",
          kind: "imported_by",
          reason: `imports ${rel}`,
          edge: "imports",
        });
      }
      // import targets
      for (const to of this.importEdge.get(rel) || []) {
        if (!this.files.has(to)) continue;
        addOb({
          id: `out:${rel}->${to}`,
          path: to,
          severity: "should",
          kind: "imports",
          reason: `${rel} imports this module`,
          edge: "imports",
        });
      }

      // tool module conventions — only real agent tool modules + tools registry
      if (rec.kindHints.includes("tool_module")) {
        const base = path.posix.basename(rel).replace(/\.(cjs|js|ts|mjs)$/i, "");
        // camelCase base often registered as same identifier
        for (const [regFile, regRec] of this.files) {
          // Strict: only files tagged tool_registry (electron/tools/registry), never proxy/* registries
          if (!regRec.kindHints.includes("tool_registry")) {
            continue;
          }
          const registered =
            regRec.registers.includes(base) ||
            regRec.registers.some((r) => r.toLowerCase() === base.toLowerCase());
          // also require() path contains this tool file
          const required = [...(this.importEdge.get(regFile) || [])].some(
            (t) => t === rel || t.endsWith("/" + path.posix.basename(rel))
          );
          if (!registered && !required) {
            addOb({
              id: `reg-missing:${rel}`,
              path: regFile,
              severity: "blocker",
              kind: "registers",
              reason: `tool module ${rel} may be missing from TOOLS registry`,
              edge: "registers",
            });
          }
          // reg-ok: silent — registered tools must not crowd card budget
        }

        for (const tn of rec.toolNames) {
          // prompt / ho lists should know tool name
          for (const [f, frec] of this.files) {
            if (frec.kindHints.includes("ho_prompt") || frec.kindHints.includes("context_prompt")) {
              const has =
                frec.toolNames.includes(tn) ||
                frec.strings.includes(tn) ||
                (frec.symbols && frec.strings.some((s) => s === tn));
              if (!has && frec.strings.includes(tn) === false) {
                // check raw string index
                const hit = (this.stringIndex.get(tn) || new Set()).has(f);
                if (!hit && !frec.toolNames.includes(tn)) {
                  addOb({
                    id: `prompt:${tn}:${f}`,
                    path: f,
                    severity: "should",
                    kind: "strings_ref",
                    reason: `tool name "${tn}" not referenced in ${f}`,
                    edge: "strings_ref",
                  });
                }
              }
            }
          }
          // reverse: who mentions this tool name
          for (const f of this.stringIndex.get(tn) || []) {
            if (f === rel) continue;
            addOb({
              id: `str:${tn}:${f}`,
              path: f,
              severity: "info",
              kind: "strings_ref",
              reason: `mentions tool "${tn}"`,
              edge: "strings_ref",
            });
          }
        }
      }

      // IPC symmetry — blocker only for true asymmetry; healthy peers are should/info
      for (const ch of rec.ipcHandlers) {
        const invokers = this.ipcInvokeIndex.get(ch) || new Set();
        if (invokers.size === 0) {
          addOb({
            id: `ipc-orphan-handle:${ch}`,
            path: rel,
            severity: "info",
            kind: "ipc",
            reason: `ipc handler "${ch}" has no invoke() callers indexed`,
            edge: "handles",
          });
        } else {
          for (const f of invokers) {
            if (f === rel) continue;
            addOb({
              id: `ipc-inv:${ch}:${f}`,
              path: f,
              severity: "should",
              kind: "ipc",
              reason: `invokes channel "${ch}" handled in ${rel} — verify contract`,
              edge: "exposes",
            });
          }
        }
      }
      for (const ch of rec.ipcInvokes) {
        const handlers = this.ipcHandleIndex.get(ch) || new Set();
        if (handlers.size === 0) {
          addOb({
            id: `ipc-missing-handle:${ch}`,
            path: rel,
            severity: "blocker",
            kind: "ipc",
            reason: `invoke("${ch}") has no ipcMain.handle indexed`,
            edge: "handles",
          });
        } else {
          for (const f of handlers) {
            if (f === rel) continue;
            addOb({
              id: `ipc-h:${ch}:${f}`,
              path: f,
              severity: "should",
              kind: "ipc",
              reason: `handles channel "${ch}" invoked from ${rel} — verify contract`,
              edge: "handles",
            });
          }
        }
      }

      // export consumers: only when import edge exists OR non-noise name + import connectivity
      for (const ex of rec.exports) {
        if (SYMBOL_NOISE.has(ex) || ex.length < 3) continue;
        const importers = this.importedBy.get(rel) || new Set();
        for (const f of this.symbolIndex.get(ex) || []) {
          if (f === rel) continue;
          // require import graph link to avoid global name collisions
          if (!importers.has(f) && !(this.importEdge.get(f) || new Set()).has(rel)) {
            continue;
          }
          addOb({
            id: `sym:${ex}:${f}`,
            path: f,
            severity: "info",
            kind: "symbol_ref",
            reason: `references symbol ${ex} (import-linked)`,
            edge: "symbol_ref",
          });
        }
      }

      // test ↔ source convention pairs
      const testPair = this._testPairFor(rel);
      if (testPair) {
        addOb({
          id: `test:${rel}->${testPair}`,
          path: testPair,
          severity: "should",
          kind: "test_pair",
          reason: `likely test/source pair for ${rel}`,
          edge: "test_pair",
        });
      }
    }

    // rank + cap (reserve min should slots so blockers never hide real importers)
    obligations.sort((a, b) => {
      const ds = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (ds !== 0) return ds;
      const edgeRank = {
        handles: 0,
        exposes: 0,
        registers: 1,
        imports: 2,
        test_pair: 2,
        strings_ref: 3,
        symbol_ref: 4,
      };
      return (edgeRank[a.edge] ?? 9) - (edgeRank[b.edge] ?? 9);
    });

    const blockers = obligations.filter((o) => o.severity === "blocker");
    const should = obligations.filter((o) => o.severity === "should");
    const info = obligations.filter((o) => o.severity === "info");

    const maxB = this.budget.maxBlockers;
    const maxO = this.budget.maxObligations;
    const minShould = Math.min(3, should.length, Math.max(0, maxO - 1));
    const blockerSlots = Math.min(blockers.length, maxB, Math.max(0, maxO - minShould));
    const shouldSlots = Math.min(should.length, maxO - blockerSlots);
    const infoSlots = Math.min(2, Math.max(0, maxO - blockerSlots - shouldSlots));
    const capped = [
      ...blockers.slice(0, blockerSlots),
      ...should.slice(0, shouldSlots),
      ...info.slice(0, infoSlots),
    ].slice(0, maxO);

    // drop self-touch only noise
    const finalObs = capped.filter((o) => !touched.has(o.path) || o.severity === "blocker");

    const result = {
      touched: [...touched].sort(),
      obligations: finalObs,
      openBlockers: finalObs.filter((o) => o.severity === "blocker").length,
      openShould: finalObs.filter((o) => o.severity === "should").length,
      truncated: obligations.length > finalObs.length,
      totalCandidates: obligations.length,
      ms: 0,
      stats: {
        filesIndexed: this.files.size,
      },
    };
    result.ms = Date.now() - t0;
    this.stats.lastImpactMs = result.ms;
    return result;
  }

  /**
   * Format budgeted card for model context (A).
   * Hard char/line caps — context must not float.
   */
  formatImpactCard(impactResult, { header = "## code_impact (auto)" } = {}) {
    const lines = [header];
    const touched = impactResult.touched || [];
    lines.push(`touched: ${touched.length ? touched.join(", ") : "(none)"}`);
    lines.push(
      `open: blockers=${impactResult.openBlockers || 0} should=${impactResult.openShould || 0}` +
        (impactResult.truncated ? " truncated=true" : "")
    );

    const obs = impactResult.obligations || [];
    if (!obs.length) {
      lines.push("obligations: (none)");
    } else {
      lines.push("must_check:");
      for (const o of obs) {
        const idHint = o.id ? ` id=${o.id}` : "";
        lines.push(`- [${o.severity}] ${o.path} — ${o.reason}${idHint}`);
      }
    }
    if (impactResult.truncated && impactResult.totalCandidates) {
      lines.push(
        `truncated: ${impactResult.totalCandidates - obs.length} more hidden; narrow the affected paths for the full set`
      );
    }
    lines.push(
      "rule: close blockers before final answer; read/edit listed paths after verification; do not invent extra files from user chat words."
    );

    // enforce line budget
    let outLines = lines.slice(0, this.budget.maxCardLines);
    let text = outLines.join("\n");
    if (text.length > this.budget.maxCardChars) {
      text = text.slice(0, this.budget.maxCardChars - 20) + "\n…(card truncated)";
    }
    return text;
  }

  // ── loop C simulation ───────────────────────────────────────────────────

  /**
   * Call after edit_file / create_file simulation.
   * Reindexes paths, computes impact, stores open obligations, returns inject card.
   */
  async afterWrite(paths, opts = {}) {
    this.session.writeCount += 1;
    await this.reindexPaths(paths);
    const imp = this.impact({ paths, symbols: opts.symbols || [], query: opts.query || "" });
    // Drop any stale false blockers from older index rules (tests/* as tools)
    this.purgeInvalidObligations();

    // merge open obligations
    for (const o of imp.obligations) {
      if (this.session.closed.has(o.id)) continue;
      // never open register-blockers for test files
      if (
        (o.kind === "registers" || o.edge === "registers") &&
        /tests\/|\.test\.(cjs|js|mjs|ts)/i.test(String(o.reason || "") + String(o.id || ""))
      ) {
        this.session.closed.add(o.id);
        continue;
      }
      // auto-close if path was just written
      const written = new Set((paths || []).map(normPath));
      if (written.has(o.path) && o.severity !== "blocker") {
        this.session.closed.add(o.id);
        this.session.open.delete(o.id);
        continue;
      }
      if (written.has(o.path) && o.kind === "registers") {
        // if we wrote registry, close register obligations for that path
        this.session.closed.add(o.id);
        this.session.open.delete(o.id);
        continue;
      }
      this.session.open.set(o.id, { ...o, sinceWrite: this.session.writeCount });
    }

    // close obligations whose path was written this turn
    for (const [id, o] of [...this.session.open]) {
      if ((paths || []).map(normPath).includes(o.path)) {
        this.session.closed.add(id);
        this.session.open.delete(id);
      }
    }

    const card = this.formatImpactCard({
      ...imp,
      obligations: [...this.session.open.values()]
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        .slice(0, this.budget.maxObligations),
      openBlockers: [...this.session.open.values()].filter((o) => o.severity === "blocker").length,
      openShould: [...this.session.open.values()].filter((o) => o.severity === "should").length,
    });
    this.session.lastInject = card;
    return { impact: imp, card, open: this.getOpenObligations() };
  }

  /**
   * Close open obligations by exact path (or unique basename) / optional obligation ids.
   * Never substring-match reason prose or obligation id fragments (spoof-safe).
   * @param {string[]} paths
   * @param {{ ids?: string[] }} [opts]
   */
  markReviewed(paths, opts = {}) {
    const set = new Set((paths || []).map((p) => normPath(p)).filter(Boolean));
    const ids = new Set(
      (opts.ids || []).map((x) => String(x || "").trim()).filter(Boolean)
    );

    // basename → open paths (only when unique among open)
    const openByBase = new Map();
    for (const o of this.session.open.values()) {
      const base = path.posix.basename(normPath(o.path));
      if (!openByBase.has(base)) openByBase.set(base, []);
      openByBase.get(base).push(normPath(o.path));
    }

    const matchesPath = (oPath) => {
      const op = normPath(oPath);
      if (set.has(op)) return true;
      for (const p of set) {
        if (!p) continue;
        if (op === p) return true;
        // suffix only with path boundary when reviewed path has a directory
        if (p.includes("/") && (op.endsWith("/" + p) || op === p)) return true;
        // basename: only if exactly one open obligation has that basename
        if (!p.includes("/")) {
          const candidates = openByBase.get(p) || openByBase.get(path.posix.basename(p));
          if (candidates && candidates.length === 1 && candidates[0] === op) return true;
          if (path.posix.basename(op) === p) {
            const sameBase = openByBase.get(p);
            if (sameBase && sameBase.length === 1 && sameBase[0] === op) return true;
          }
        }
      }
      return false;
    };

    for (const [id, o] of [...this.session.open]) {
      const hit = (ids.size && ids.has(id)) || matchesPath(o.path);
      if (hit) {
        this.session.closed.add(id);
        this.session.open.delete(id);
      }
    }
    return this.getOpenObligations();
  }

  /** Convention: foo.cjs ↔ foo.test.cjs / tests/foo.cjs / __tests__/foo.* */
  _testPairFor(rel) {
    const n = normPath(rel);
    if (!n) return null;
    const base = path.posix.basename(n);
    const dir = path.posix.dirname(n);
    const ext = path.posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    if (/\.(test|spec)$/i.test(stem) || /(^|\/)(__tests__|tests)\//i.test(n)) {
      // test file → source
      const srcStem = stem.replace(/\.(test|spec)$/i, "");
      const candidates = [
        path.posix.join(dir, srcStem + ext),
        path.posix.join(dir, "..", srcStem + ext),
        path.posix.join(dir.replace(/\/(__tests__|tests)$/i, ""), srcStem + ext),
        path.posix.join("electron", srcStem + ext),
        srcStem + ext,
      ].map(normPath);
      for (const c of candidates) {
        if (c !== n && this.files.has(c)) return c;
      }
      return null;
    }
    // source → test
    const candidates = [
      path.posix.join(dir, `${stem}.test${ext}`),
      path.posix.join(dir, `${stem}.spec${ext}`),
      path.posix.join(dir, "__tests__", `${stem}${ext}`),
      path.posix.join(dir, "__tests__", `${stem}.test${ext}`),
      path.posix.join("tests", `${stem}${ext}`),
      path.posix.join("tests", `${stem}.test${ext}`),
      path.posix.join("tests", path.posix.basename(dir), `${stem}.test${ext}`),
    ].map(normPath);
    for (const c of candidates) {
      if (c !== n && this.files.has(c)) return c;
    }
    return null;
  }

  /**
   * Drop false-positive register blockers (e.g. tests/* never belong in TOOLS registry).
   * Also clears stale obligations from older engine versions that tagged tests/tools as tool_module.
   */
  purgeInvalidObligations() {
    for (const [id, o] of [...this.session.open]) {
      const reason = String(o.reason || "");
      const idN = String(id || "");
      // tests/ or *.test.cjs mentioned as "tool module … missing from TOOLS registry"
      const falseTool =
        (o.kind === "registers" || o.edge === "registers") &&
        (/tool module\s+(tests\/|.*\.test\.(cjs|js|mjs|ts))/i.test(reason) ||
          /reg-missing:tests\//i.test(idN) ||
          /reg-missing:.*\.test\./i.test(idN) ||
          /tests\/tools\//i.test(reason) ||
          /tests\/tools\//i.test(idN));
      if (falseTool) {
        this.session.closed.add(id);
        this.session.open.delete(id);
      }
    }
  }

  getOpenObligations() {
    this.purgeInvalidObligations();
    return [...this.session.open.values()].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    );
  }

  /**
   * Before model finalizes without tools — nudge if blockers remain.
   * @returns {{ allowFinal: boolean, nudge: string|null, openBlockers: number }}
   */
  beforeFinal() {
    this.purgeInvalidObligations();
    const open = this.getOpenObligations();
    const blockers = open.filter((o) => o.severity === "blocker");
    if (blockers.length === 0) {
      return { allowFinal: true, nudge: null, openBlockers: 0, openShould: open.length };
    }
    const lines = [
      "## code_impact_nudge",
      `open blockers: ${blockers.length} — do NOT finish yet`,
      "required:",
    ];
    for (const o of blockers.slice(0, this.budget.maxBlockers)) {
      lines.push(`- ${o.path} — ${o.reason}`);
    }
    lines.push("action: read_file/edit_file these paths or mark reviewed after verify");
    let nudge = lines.join("\n");
    if (nudge.length > this.budget.maxCardChars) {
      nudge = nudge.slice(0, this.budget.maxCardChars - 20) + "\n…(nudge truncated)";
    }
    return {
      allowFinal: false,
      nudge,
      openBlockers: blockers.length,
      openShould: open.filter((o) => o.severity === "should").length,
    };
  }

  resetSession() {
    this.session = { open: new Map(), closed: new Set(), lastInject: null, writeCount: 0 };
  }

  // ── diagnostics / missing edges ─────────────────────────────────────────

  findMissingToolRegistrations() {
    const issues = [];
    let registryFiles = [];
    for (const [rel, rec] of this.files) {
      if (rec.kindHints.includes("tool_registry")) {
        registryFiles.push(rel);
      }
    }
    for (const [rel, rec] of this.files) {
      if (!rec.kindHints.includes("tool_module")) {
        continue;
      }
      if (/registry\./.test(rel) || /harness\./.test(rel)) continue;
      const base = path.posix.basename(rel).replace(/\.(cjs|js|ts|mjs)$/i, "");
      let ok = false;
      for (const reg of registryFiles) {
        const regRec = this.files.get(reg);
        if (!regRec) continue;
        if (regRec.registers.some((r) => r.toLowerCase() === base.toLowerCase())) ok = true;
        if ([...(this.importEdge.get(reg) || [])].some((t) => t === rel || t.endsWith("/" + path.posix.basename(rel))))
          ok = true;
      }
      if (!ok && registryFiles.length) {
        issues.push({ tool: rel, registry: registryFiles[0], kind: "unregistered_tool" });
      }
    }
    return issues;
  }

  findIpcAsymmetries() {
    const issues = [];
    for (const [ch, handlers] of this.ipcHandleIndex) {
      if (!this.ipcInvokeIndex.has(ch) || this.ipcInvokeIndex.get(ch).size === 0) {
        issues.push({ channel: ch, kind: "handle_without_invoke", files: [...handlers] });
      }
    }
    for (const [ch, invokers] of this.ipcInvokeIndex) {
      if (!this.ipcHandleIndex.has(ch) || this.ipcHandleIndex.get(ch).size === 0) {
        issues.push({ channel: ch, kind: "invoke_without_handle", files: [...invokers] });
      }
    }
    return issues;
  }

  /**
   * Neighbors view for tool-style API.
   * @param {string} filePath
   * @param {number} depth
   * @param {{ kinds?: string[] }} [opts] kinds: imports|imported_by|ipc|registers|strings_ref|test_pair|all
   */
  neighbors(filePath, depth = 1, opts = {}) {
    const rel = normPath(filePath);
    const maxD = Math.min(depth, this.budget.maxNeighborsDepth);
    const kindsRaw = opts.kinds;
    const all = !kindsRaw || kindsRaw.includes("all");
    const want = new Set(
      all
        ? ["imports", "imported_by", "ipc", "registers", "strings_ref", "test_pair"]
        : (kindsRaw || ["imports", "imported_by"]).map(String)
    );
    const out = [];
    const visited = new Set([rel]);
    let frontier = [rel];

    const pushEdge = (to, d, via, next) => {
      if (!to || visited.has(to) || !this.files.has(to)) return;
      visited.add(to);
      next.push(to);
      out.push({ path: to, depth: d, via });
    };

    for (let d = 1; d <= maxD; d++) {
      const next = [];
      for (const f of frontier) {
        const rec = this.files.get(f);
        if (want.has("imports")) {
          for (const to of this.importEdge.get(f) || []) {
            pushEdge(to, d, "imports", next);
          }
        }
        if (want.has("imported_by")) {
          for (const from of this.importedBy.get(f) || []) {
            pushEdge(from, d, "imported_by", next);
          }
        }
        if (want.has("ipc") && rec) {
          for (const ch of rec.ipcHandlers || []) {
            for (const inv of this.ipcInvokeIndex.get(ch) || []) {
              pushEdge(inv, d, "ipc", next);
            }
          }
          for (const ch of rec.ipcInvokes || []) {
            for (const h of this.ipcHandleIndex.get(ch) || []) {
              pushEdge(h, d, "ipc", next);
            }
          }
        }
        if (want.has("registers") && rec) {
          if (rec.kindHints.includes("tool_module")) {
            for (const [regFile, regRec] of this.files) {
              if (regRec.kindHints.includes("tool_registry")) {
                pushEdge(regFile, d, "registers", next);
              }
            }
          }
          if (rec.kindHints.includes("tool_registry")) {
            for (const to of this.importEdge.get(f) || []) {
              const tRec = this.files.get(to);
              if (tRec?.kindHints.includes("tool_module")) {
                pushEdge(to, d, "registers", next);
              }
            }
          }
        }
        if (want.has("strings_ref") && rec) {
          for (const tn of rec.toolNames || []) {
            for (const hit of this.stringIndex.get(tn) || []) {
              pushEdge(hit, d, "strings_ref", next);
            }
          }
        }
        if (want.has("test_pair")) {
          const pair = this._testPairFor(f);
          if (pair) pushEdge(pair, d, "test_pair", next);
        }
      }
      frontier = next;
    }
    return out;
  }
}

function tokenizeQuery(q) {
  // extract only path-like / identifier / tool-like tokens — drop prose & cyrillic chat
  const raw = String(q || []).split(/[\s,;|]+/);
  const out = [];
  for (let t of raw) {
    t = t.trim().replace(/^['"`]+|['"`]+$/g, "");
    if (!t || t.length < 2) continue;
    // skip pure cyrillic user words
    if (/^[а-яёїієґА-ЯЁЇІЄҐ]+$/.test(t)) continue;
    // skip stop-ish english chat
    if (/^(the|and|with|from|that|this|please|fix|add|make|сделай|додай)$/i.test(t)) continue;
    if (t.includes("/") || t.includes(".") || t.includes(":") || t.includes("_") || /[A-Z]/.test(t)) {
      out.push(t);
      continue;
    }
    // camel or long ascii id
    if (/^[A-Za-z_$][\w$]{2,}$/.test(t)) out.push(t);
  }
  return out;
}

module.exports = {
  CodeImpactEngine,
  parseFileContent,
  isIndexableString,
  tokenizeQuery,
  resolveImport,
  resolveTouchedPaths,
  DEFAULT_BUDGET,
  DEFAULT_IGNORE,
  SYMBOL_NOISE,
  normPath,
};
