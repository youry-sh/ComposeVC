const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const MAX_OUTPUT = 30000;
const DEFAULT_TIMEOUT = 300000;
const IGNORE = new Set(["node_modules", ".git", ".backup", "dist", "build", "coverage", "out", "target", "vendor"]);

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

async function commandAvailable(command, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.platform === "win32" ? "where.exe" : "which", [command], { cwd, windowsHide: true, stdio: "ignore" });
    child.on("close", code => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function run(command, args, cwd, timeout) {
  return new Promise(resolve => {
    const started = Date.now();
    const shell = process.platform === "win32";
    const child = spawn(shell ? "cmd.exe" : command, shell ? ["/d", "/s", "/c", [command, ...args].join(" ")] : args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const append = (target, value) => (target + String(value)).slice(-MAX_OUTPUT);
    child.stdout?.on("data", data => { stdout = append(stdout, data); });
    child.stderr?.on("data", data => { stderr = append(stderr, data); });
    const timer = setTimeout(() => { killed = true; child.kill("SIGTERM"); }, Math.max(1000, timeout));
    child.on("error", error => { clearTimeout(timer); resolve({ ok: false, code: null, signal: null, stdout, stderr: String(error.message || error), durationMs: Date.now() - started, timedOut: killed }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut: killed });
    });
  });
}

function result(name, category, command, data, optional = false, outputLimit = 4000) {
  const limit = Math.max(500, Number(outputLimit) || 4000);
  const next = { name, category, command, optional, ...data };
  for (const key of ["stdout", "stderr"]) {
    if (typeof next[key] !== "string") continue;
    if (next[key].length > limit) {
      next[`${key}Truncated`] = true;
      next[key] = next[key].slice(-limit);
    }
  }
  return next;
}

async function collectFiles(root, extensions) {
  const found = [];
  const visit = async dir => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async entry => {
      if (IGNORE.has(entry.name) || entry.name.startsWith(".")) return;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return visit(file);
      if (extensions.some(ext => entry.name.toLowerCase().endsWith(ext))) found.push(file);
    }));
  };
  await visit(root);
  return found;
}

const SOURCE_EXTENSIONS = [".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".cs", ".php", ".rb", ".sql", ".vue", ".svelte"];

function sourceLine(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanSource(file, text) {
  const findings = [];
  const rules = [
    ["security", "high", "XSS risk: direct HTML injection", /(?:innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML)\s*=/g],
    ["security", "high", "Command injection risk: user input reaches a process command", /(?:exec|execSync|spawn|spawnSync)\s*\([^\n]*(?:input|query|param|body|argv|request|req\.)/gi],
    ["security", "high", "SQL injection risk: dynamic SQL string construction", /(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)[^\n]*(?:\+|`[^`]*\$\{|%s|format\s*\()/gi],
    ["security", "high", "SSRF risk: request URL is derived from input", /(?:fetch|axios\.(?:get|post|request)|http\.request|https\.request)\s*\([^\n]*(?:url|input|query|param|req\.)/gi],
    ["security", "medium", "CSRF risk: state-changing route without visible CSRF protection", /(?:app|router)\.(?:post|put|patch|delete)\s*\(/gi],
    ["security", "high", "Unsafe deserialization or dynamic code execution", /(?:eval|Function|vm\.(?:runInNewContext|runInThisContext)|deserialize|pickle\.loads)\s*\(/gi],
    ["secrets", "high", "Possible hardcoded secret or token", /(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*["'][^"']{8,}["']/gi],
    ["logic", "medium", "Suspicious empty catch block can hide logical failures", /catch\s*\([^)]*\)\s*\{\s*\}/g],
    ["logic", "medium", "Possible assignment inside conditional", /\bif\s*\([^)]*=[^=][^)]*\)/g],
    ["performance", "medium", "Synchronous filesystem or IPC operation can block the event loop", /(?:readFileSync|writeFileSync|readdirSync|statSync|sendSync|execFileSync)\s*\(/g],
    ["performance", "medium", "Potential unbounded loop or recursion", /\b(?:while\s*\(\s*true|for\s*\(\s*;;|setInterval\s*\([^,]+,\s*0)/g],
    ["memory", "medium", "Possible listener or timer leak; verify cleanup on disposal", /(?:addEventListener|on|setInterval|setTimeout)\s*\(/g],
    ["architecture", "high", "Renderer/main boundary risk: remote module or synchronous IPC", /(?:require\s*\(\s*["']remote["']|ipcRenderer\.sendSync|\bremote\.)/g],
    ["architecture", "medium", "Large collection rendered without obvious virtualization", /(?:\.map\s*\(|Array\s*\(\s*(?:50|[6-9]\d|\d{3,})\s*\))/g],
  ];
  for (const [category, severity, message, regex] of rules) {
    let match;
    while ((match = regex.exec(text)) && findings.length < 500) {
      findings.push({ file, line: sourceLine(text, match.index), category, severity, message, evidence: match[0].slice(0, 180) });
    }
  }
  const optimizationRules = [
    [/for\s*\([^)]*\)[\s\S]{0,500}\.map\s*\(/g, "Nested iteration may reduce TPS", "Move repeated mapping outside the loop or precompute an index"],
    [/JSON\.(?:parse|stringify)\s*\(/g, "JSON serialization may block the event loop", "Use chunking, streams or a worker for large payloads"],
    [/(?:ipcRenderer|webContents)\.(?:send|invoke|sendSync)\s*\(/g, "IPC call may add serialization latency", "Debounce high-frequency calls and paginate payloads"],
    [/(?:mousemove|scroll|resize|input|pointermove)[^\n]{0,160}(?:ipcRenderer|send|invoke)/gi, "High-frequency event crosses a process boundary", "Throttle or debounce the event before IPC"],
    [/(?:requestAnimationFrame|setInterval)\s*\([^,]+,\s*(?:0|1|5|10|15)\s*\)/g, "Very frequent timer may consume frame budget", "Use one scheduler and batch updates within a frame"],
    [/(?:\.map\(|\.filter\(|\.reduce\()[\s\S]{0,600}(?:\.map\(|\.filter\(|\.reduce\()/g, "Multiple collection passes may cause frame drops", "Fuse passes or virtualize large collections"],
    [/(?:new Array|Array\.from|Buffer\.alloc|new Uint8Array)\s*\([^)]{4,}/g, "Potential large allocation", "Bound the allocation and release references after use"],
  ];
  for (const [regex, message, recommendation] of optimizationRules) {
    let match;
    while ((match = regex.exec(text)) && findings.length < 800) {
      findings.push({ file, line: sourceLine(text, match.index), category: "optimization", severity: "medium", message, recommendation, evidence: match[0].slice(0, 180) });
    }
  }
  const lines = text.split(/\r?\n/).length;
  if (lines > 500) findings.push({ file, line: 1, category: "maintainability", severity: "medium", message: "Large module can increase review and execution complexity", recommendation: "Split by responsibility and keep hot paths isolated" });
  return findings;
}

async function staticAnalysis(root, requestedPath) {
  const stat = await fs.stat(requestedPath);
  const files = stat.isFile() ? [requestedPath] : await collectFiles(requestedPath, SOURCE_EXTENSIONS);
  const findings = [];
  let totalBytes = 0;
  let totalLines = 0;
  for (const file of files.slice(0, 10000)) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    totalBytes += Buffer.byteLength(text);
    totalLines += text.split(/\\r?\\n/).length;
    findings.push(...scanSource(file, text));
  }
  const counts = findings.reduce((acc, item) => { acc[item.category] = (acc[item.category] || 0) + 1; return acc; }, {});
  return { filesScanned: files.length, totalBytes, totalLines, findings, counts, truncated: files.length > 10000 };
}

async function mutationAnalysis(root, requestedPath) {
  const stat = await fs.stat(requestedPath);
  const files = stat.isFile() ? [requestedPath] : await collectFiles(requestedPath, [".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
  const mutants = [];
  for (const file of files.slice(0, 500)) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const operators = [
      { from: "===", to: "!==", category: "comparison" },
      { from: ">=", to: ">", category: "boundary" },
      { from: "&&", to: "||", category: "boolean" },
      { from: " + ", to: " - ", category: "arithmetic" },
    ];
    for (const operator of operators) {
      const index = text.indexOf(operator.from);
      if (index >= 0 && mutants.length < 1000) {
        mutants.push({ file, line: sourceLine(text, index), category: operator.category, mutation: `${operator.from} -> ${operator.to}`, status: "candidate" });
      }
    }
  }
  return { filesConsidered: files.length, mutants, executed: 0, killed: 0, survived: 0, status: "candidate-only", reason: "Mutation execution needs an isolated test runner; source files are never modified" };
}

async function runStep(spec, root, timeout, optional = false, outputLimit = 4000) {
  const available = await commandAvailable(spec.command, root);
  if (!available) return result(spec.name, spec.category, [spec.command, ...(spec.args || [])].join(" "), { ok: null, skipped: true, reason: "executable not found" }, optional, outputLimit);
  const data = await run(spec.command, spec.args || [], root, spec.timeout || timeout);
  return result(spec.name, spec.category, [spec.command, ...(spec.args || [])].join(" "), data, optional, outputLimit);
}

async function npmScript(root, name) {
  const pkg = await readJson(path.join(root, "package.json"));
  return Boolean(pkg?.scripts?.[name]);
}

async function buildPlan(root, input) {
  const plan = [];
  const add = (name, category, command, args = [], optional = false, timeout) => plan.push({ name, category, command, args, optional, timeout });
  const pkg = await readJson(path.join(root, "package.json"));
  const scripts = pkg?.scripts || {};
  const has = name => Boolean(scripts[name]);
  const hasFile = async name => exists(path.join(root, name));
  const pm = await hasFile("pnpm-lock.yaml") ? "pnpm" : await hasFile("yarn.lock") ? "yarn" : "npm";
  const runScript = name => [pm, pm === "npm" ? "run" : "run", name];

  if (input.commands && typeof input.commands === "object") {
    for (const [name, value] of Object.entries(input.commands)) {
      if (!Array.isArray(value) || !value.length) continue;
      plan.push({ name, category: "custom", command: value[0], args: value.slice(1), optional: false });
    }
  }
  if (input.skipDefault !== true) {
    if (has("lint")) { const c = runScript("lint"); add("project lint", "lint", c[0], c.slice(1)); }
    if (has("typecheck")) { const c = runScript("typecheck"); add("project typecheck", "type", c[0], c.slice(1)); }
    if (has("check")) { const c = runScript("check"); add("project check", "static", c[0], c.slice(1)); }
    if (has("test")) { const c = runScript("test"); add("unit tests", "unit", c[0], c.slice(1), false, input.testTimeout); }
    if (has("test:integration")) { const c = runScript("test:integration"); add("integration tests", "integration", c[0], c.slice(1), false, input.testTimeout); }
    if (has("test:e2e")) { const c = runScript("test:e2e"); add("end-to-end tests", "e2e", c[0], c.slice(1), false, input.testTimeout); }
    if (has("test:gherkin")) { const c = runScript("test:gherkin"); add("gherkin tests", "gherkin", c[0], c.slice(1), false, input.testTimeout); }
    if (has("test:fuzz")) { const c = runScript("test:fuzz"); add("fuzz tests", "fuzz", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:mutation")) { const c = runScript("test:mutation"); add("mutation tests", "mutation", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:coverage")) { const c = runScript("test:coverage"); add("coverage", "coverage", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:property")) { const c = runScript("test:property"); add("property tests", "property", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:security")) { const c = runScript("test:security"); add("security tests", "security", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:performance")) { const c = runScript("test:performance"); add("performance regression", "performance", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:contract")) { const c = runScript("test:contract"); add("API contract", "contract", c[0], c.slice(1), true, input.testTimeout); }
    if (has("test:a11y")) { const c = runScript("test:a11y"); add("accessibility", "accessibility", c[0], c.slice(1), true, input.testTimeout); }
    if (has("audit")) { const c = runScript("audit"); add("dependency audit", "dependency", c[0], c.slice(1), true, input.testTimeout); }
    if (has("build")) { const c = runScript("build"); add("build", "build", c[0], c.slice(1), false, input.testTimeout); }
    if (await hasFile("package.json")) add("npm audit", "dependency", pm, pm === "npm" ? ["audit", "--audit-level=moderate"] : ["audit"], true, input.testTimeout);
    if (await hasFile("tsconfig.json") && await commandAvailable("tsc", root)) add("TypeScript", "type", "tsc", ["--noEmit"], false, input.testTimeout);
    if (await hasFile("docker-compose.yml") || await hasFile("docker-compose.yaml")) add("Docker config", "docker", "docker", ["compose", "config"], true);
    if (await hasFile("Dockerfile")) add("Dockerfile", "docker", "docker", ["build", "--check", "."], true, input.testTimeout);
    if (await hasFile("go.mod")) {
      add("Go vet", "lint", "go", ["vet", "./..."], true, input.testTimeout);
      add("Go tests", "unit", "go", ["test", "./..."], true, input.testTimeout);
      add("Go race", "race", "go", ["test", "-race", "./..."], true, input.testTimeout);
    }
    if (await hasFile("Cargo.toml")) {
      add("Clippy", "lint", "cargo", ["clippy", "--all-targets", "--all-features", "--", "-D", "warnings"], true, input.testTimeout);
      add("Rust tests", "unit", "cargo", ["test", "--all-features"], true, input.testTimeout);
    }
    if (await hasFile("pyproject.toml") || await hasFile("requirements.txt")) {
      add("Ruff", "lint", "ruff", ["check", "."], true, input.testTimeout);
      add("Mypy", "type", "mypy", ["."], true, input.testTimeout);
      add("Pytest", "unit", "pytest", ["-q"], true, input.testTimeout);
    }
  }
  return plan;
}

module.exports = {
  name: "chack_code",
  description: "Comprehensive project verifier. Runs available linters, type checks, unit/integration/e2e/BDD/property/fuzz/mutation tests, coverage, security and dependency audits, race checks, container validation, builds and language-specific checks. Uses existing project scripts and never installs dependencies.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Project root or file directory" },
      skipDefault: { type: "boolean", description: "Do not auto-detect standard checks" },
      scan: { type: "boolean", description: "Scan source files for security, logic, performance, memory and architecture risks" },
      scanPath: { type: "string", description: "Specific source file or folder to scan" },
      mutation: { type: "boolean", description: "Generate isolated mutation candidates without modifying source files" },
      benchmark: { type: "boolean", description: "Run optional benchmark and performance scripts" },
      allowFindings: { type: "boolean", description: "Return successful status even when heuristic findings require human or AI review" },
      commands: { type: "object", description: "Extra commands as {name:[executable,arg1,...]}" },
      timeout: { type: "number", description: "Timeout per check in milliseconds" },
      testTimeout: { type: "number", description: "Timeout for test checks in milliseconds" },
      failFast: { type: "boolean", description: "Stop after first required failure" },
      outputLimit: { type: "number", description: "Maximum output characters retained per check" },
      checksOffset: { type: "number", description: "Number of checks to skip in paginated output" },
      checksLimit: { type: "number", description: "Number of checks returned in paginated output" },
      findingsOffset: { type: "number", description: "Number of findings to skip in paginated output" },
      findingsLimit: { type: "number", description: "Number of findings returned in paginated output" },
      reportPath: { type: "string", description: "Optional JSON report file path" },
      reportOnly: { type: "boolean", description: "Write report without returning full check details" }
    },
    additionalProperties: false
  },
  async execute(input = {}, context = {}) {
    const requested = input.path || context.rootPath || process.cwd();
    const root = path.resolve(requested);
    const stat = await fs.stat(root).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new Error(`Project directory does not exist: ${root}`);
    const timeout = Number(input.timeout) > 0 ? Number(input.timeout) : DEFAULT_TIMEOUT;
    const plan = await buildPlan(root, input);
    const scanTarget = input.scanPath ? path.resolve(root, input.scanPath) : root;
    const analysis = input.scan !== false ? await staticAnalysis(root, scanTarget) : null;
    const mutation = input.mutation === true ? await mutationAnalysis(root, scanTarget) : null;
    const checks = [];
    if (analysis) checks.push({ name: "source security and architecture scan", category: "static-analysis", command: "internal", optional: false, ok: input.allowFindings === true || analysis.findings.filter(item => item.severity === "high").length === 0, reviewRequired: analysis.findings.length > 0, ...analysis });
    if (mutation) checks.push({ name: "mutation analysis", category: "mutation", command: "internal", optional: true, ok: null, ...mutation });
    if (input.benchmark === true && (await npmScript(root, "benchmark"))) {
      const pm = await exists(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : await exists(path.join(root, "yarn.lock")) ? "yarn" : "npm";
      checks.push(await runStep({ name: "benchmark", category: "performance", command: pm, args: ["run", "benchmark"], optional: true, timeout: input.testTimeout }, root, timeout, true));
    }
    const outputLimit = Number(input.outputLimit) > 0 ? Number(input.outputLimit) : 4000;
    for (const spec of plan) {
      const item = await runStep(spec, root, timeout, spec.optional, outputLimit);
      checks.push(item);
      if (input.failFast && item.ok === false && !item.optional) break;
    }
    const failed = checks.filter(item => item.ok === false && !item.skipped);
    const skipped = checks.filter(item => item.skipped);
    const report = {
      generatedAt: new Date().toISOString(),
      root,
      ok: failed.length === 0 && checks.filter(item => item.skipped && !item.optional).length === 0,
      checks,
      summary: { total: checks.length, passed: checks.filter(x => x.ok === true).length, failed: failed.length, skipped: skipped.length, requiredSkipped: checks.filter(item => item.skipped && !item.optional).length }
    };
    let savedReport = null;
    if (input.reportPath) {
      savedReport = path.resolve(root, input.reportPath);
      await fs.mkdir(path.dirname(savedReport), { recursive: true });
      await fs.writeFile(savedReport, JSON.stringify(report, null, 2), "utf8");
    }
    const requiredSkipped = checks.filter(item => item.skipped && !item.optional);
    const checksOffset = Math.max(0, Number(input.checksOffset) || 0);
    const checksLimit = Math.min(100, Math.max(1, Number(input.checksLimit) || 20));
    const findingsOffset = Math.max(0, Number(input.findingsOffset) || 0);
    const findingsLimit = Math.min(500, Math.max(1, Number(input.findingsLimit) || 50));
    const pagedChecks = checks.slice(checksOffset, checksOffset + checksLimit).map(item => {
      if (!Array.isArray(item.findings)) return item;
      return { ...item, findings: item.findings.slice(findingsOffset, findingsOffset + findingsLimit), findingsTotal: item.findings.length, findingsOffset, findingsLimit };
    });
    return {
      ok: failed.length === 0 && requiredSkipped.length === 0,
      root,
      reportPath: savedReport,
      reportOnly: input.reportOnly === true,
      checks: input.reportOnly === true ? [] : pagedChecks,
      pagination: {
        checks: { offset: checksOffset, limit: checksLimit, total: checks.length, hasMore: checksOffset + checksLimit < checks.length, nextOffset: checksOffset + checksLimit < checks.length ? checksOffset + checksLimit : null },
        findings: { offset: findingsOffset, limit: findingsLimit, total: analysis?.findings?.length || 0, hasMore: findingsOffset + findingsLimit < (analysis?.findings?.length || 0), nextOffset: findingsOffset + findingsLimit < (analysis?.findings?.length || 0) ? findingsOffset + findingsLimit : null }
      },
      summary: { total: checks.length, passed: checks.filter(x => x.ok === true).length, failed: failed.length, skipped: skipped.length, requiredSkipped: requiredSkipped.length },
      limitations: ["Only tools already installed and project scripts are executed", "Mutation, symbolic execution, formal verification, exhaustive path coverage and millions of fuzz cases require project-specific configuration", "A passing command is evidence from that command, not a proof of correctness"]
    };
  }
};
