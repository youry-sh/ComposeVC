const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MANIFEST_NAMES = ["tool.json", "manifest.json", "tool.manifest.json"];
const ENTRY_CANDIDATES = [
  "main.js",
  "main.cjs",
  "main.mjs",
  "index.js",
  "index.cjs",
  "index.mjs",
  "run.js",
  "run.cjs",
  "run.mjs",
  "tool.js",
  "tool.cjs",
  "main.py",
  "run.py",
  "tool.py",
  "main.ps1",
  "run.ps1",
  "tool.ps1",
  "main.sh",
  "run.sh",
  "tool.sh",
  "main.bat",
  "run.bat",
];

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const MAX_STDOUT_CHARS = 500000;
const MAX_STDERR_CHARS = 100000;
const MAX_DESCRIPTION_LEN = 400;
const MAX_NAME_LEN = 64;
const JSON_IDLE_MS = 400;
const KILL_GRACE_MS = 800;
const NO_OUTPUT_WARN_MS = 15000;

function normalizeDependencies(raw, ownName = "") {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map(normalizeToolName).filter((name) => name && name !== ownName))].slice(0, 50);
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function normalizeToolName(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NAME_LEN);
}

function getToolsRoot(userDataPath) {
  if (!userDataPath) throw new Error("userDataPath required for folder tools");
  return path.join(userDataPath, "custom-tools");
}

function getToolDir(userDataPath, name) {
  const n = normalizeToolName(name);
  if (!n) throw new Error("Tool name is required");
  return path.join(getToolsRoot(userDataPath), n);
}

function safeResolveInside(rootDir, relOrAbs) {
  const root = path.resolve(rootDir);
  const target = path.isAbsolute(relOrAbs)
    ? path.resolve(relOrAbs)
    : path.resolve(root, relOrAbs);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes tool folder: ${relOrAbs}`);
  }
  return target;
}

async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJsonFile(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeInputSchema(raw) {
  if (!raw || typeof raw !== "object") {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  const schema = { ...raw };
  if (!schema.type) schema.type = "object";
  if (!schema.properties || typeof schema.properties !== "object") {
    schema.properties = {};
  }
  return schema;
}

function detectRuntimeFromEntry(entry) {
  const ext = path.extname(String(entry || "")).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".ps1") return "powershell";
  if (ext === ".sh") return "bash";
  if (ext === ".bat" || ext === ".cmd") return "cmd";
  if (ext === ".mjs") return "node-esm";
  return "node";
}

async function findEntryFile(toolDir, preferred) {
  if (preferred) {
    const p = safeResolveInside(toolDir, preferred);
    if (await pathExists(p)) return { entry: path.relative(toolDir, p).replace(/\\/g, "/"), abs: p };
  }
  for (const name of ENTRY_CANDIDATES) {
    const abs = path.join(toolDir, name);
    if (await pathExists(abs)) {
      return { entry: name, abs };
    }
  }
  return null;
}

async function loadManifest(toolDir) {
  for (const name of MANIFEST_NAMES) {
    const p = path.join(toolDir, name);
    if (await pathExists(p)) {
      try {
        const raw = await readJsonFile(p);
        return { path: p, raw: isPlainObject(raw) ? raw : {} };
      } catch {
        return { path: p, raw: {} };
      }
    }
  }
  return { path: path.join(toolDir, "tool.json"), raw: {} };
}

function defaultJsTemplate(name) {
  return `const fs = require("fs");
const path = require("path");

async function main(args, ctx) {
  return {
    ok: true,
    tool: ${JSON.stringify(name)},
    message: "folder tool works — edit main.js",
    args,
    toolDir: ctx.toolDir,
  };
}

async function run() {
  const raw = fs.readFileSync(0, "utf8");
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(String(err && err.message ? err.message : err));
    process.exit(2);
  }
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const ctx = payload.ctx && typeof payload.ctx === "object" ? payload.ctx : {};
  try {
    const result = await main(args, ctx);
    process.stdout.write(JSON.stringify(result == null ? null : result));
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.exit(1);
  }
}

run();
`;
}

function defaultPyTemplate(name) {
  return `import json, sys

def main(args, ctx):
    return {
        "ok": True,
        "tool": ${JSON.stringify(name)},
        "message": "folder tool works — edit main.py",
        "args": args,
        "toolDir": ctx.get("toolDir"),
    }

if __name__ == "__main__":
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    args = payload.get("args") or {}
    ctx = payload.get("ctx") or {}
    try:
        result = main(args, ctx)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)
`;
}

function defaultPs1Template(name) {
  return `$ErrorActionPreference = "Stop"
$raw = [Console]::In.ReadToEnd()
$payload = if ([string]::IsNullOrWhiteSpace($raw)) { @{} } else { $raw | ConvertFrom-Json }
$argsObj = if ($null -ne $payload.args) { $payload.args } else { @{} }
$ctx = if ($null -ne $payload.ctx) { $payload.ctx } else { @{} }
$result = [ordered]@{
  ok = $true
  tool = ${JSON.stringify(name)}
  message = "folder tool works — edit main.ps1"
  args = $argsObj
  toolDir = $ctx.toolDir
}
$result | ConvertTo-Json -Depth 20 -Compress
`;
}

async function ensureToolScaffold(userDataPath, input = {}) {
  const name = normalizeToolName(input.name);
  if (!name) throw new Error("Tool name is required");
  const toolDir = getToolDir(userDataPath, name);
  await fs.promises.mkdir(toolDir, { recursive: true });

  const runtimeRaw = String(input.runtime || input.lang || input.language || "node")
    .trim()
    .toLowerCase();
  let runtime = "node";
  let entry = "main.js";
  let template = defaultJsTemplate(name);
  if (runtimeRaw === "python" || runtimeRaw === "py") {
    runtime = "python";
    entry = "main.py";
    template = defaultPyTemplate(name);
  } else if (runtimeRaw === "powershell" || runtimeRaw === "ps1" || runtimeRaw === "pwsh") {
    runtime = "powershell";
    entry = "main.ps1";
    template = defaultPs1Template(name);
  } else if (runtimeRaw === "node-esm" || runtimeRaw === "esm" || runtimeRaw === "mjs") {
    runtime = "node-esm";
    entry = "main.mjs";
    template = defaultJsTemplate(name).replace(
      'const fs = require("fs");\nconst path = require("path");',
      'import fs from "fs";\nimport path from "path";'
    );
  }

  if (input.entry) {
    entry = String(input.entry).replace(/\\/g, "/");
    if (!input.runtime && !input.lang && !input.language) {
      runtime = detectRuntimeFromEntry(entry);
    }
  }

  const entryAbs = safeResolveInside(toolDir, entry);
  if (!(await pathExists(entryAbs))) {
    await fs.promises.mkdir(path.dirname(entryAbs), { recursive: true });
    const code =
      input.code != null
        ? String(input.code)
        : input.content != null
          ? String(input.content)
          : input.source != null
            ? String(input.source)
            : template;
    await fs.promises.writeFile(entryAbs, code, "utf8");
  } else if (input.code != null || input.content != null || input.source != null) {
    const code = String(input.code != null ? input.code : input.content != null ? input.content : input.source);
    await fs.promises.writeFile(entryAbs, code, "utf8");
  }

  const now = Date.now();
  const existingManifest = await loadManifest(toolDir);
  const prev = existingManifest.raw || {};
  const description =
    input.description != null && String(input.description).trim()
      ? String(input.description).trim().slice(0, MAX_DESCRIPTION_LEN)
      : prev.description || `Folder tool ${name} (${runtime})`;
  const title =
    input.title != null && String(input.title).trim()
      ? String(input.title).trim()
      : prev.title || name;
  const inputSchema = normalizeInputSchema(
    input.inputSchema != null ? input.inputSchema : input.schema != null ? input.schema : prev.inputSchema
  );
  const enabled =
    input.enabled === false ? false : input.enabled === true ? true : prev.enabled === false ? false : true;
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20)
    : Array.isArray(prev.tags)
      ? prev.tags
      : ["folder"];
  const id = String(prev.id || input.id || `folder-${name}`).trim() || `folder-${name}`;

  const manifest = {
    id,
    name,
    title,
    description,
    kind: "folder",
    runtime,
    entry: entry.replace(/\\/g, "/"),
    inputSchema,
    enabled,
    tags,
    dependencies: normalizeDependencies(input.dependencies != null ? input.dependencies : prev.dependencies, name),
    timeout_ms:
      Number(input.timeout_ms || input.timeoutMs || prev.timeout_ms || prev.timeoutMs) ||
      DEFAULT_TIMEOUT_MS,
    createdAt: Number(prev.createdAt) || now,
    updatedAt: now,
    toolDir,
  };

  await writeJsonFile(path.join(toolDir, "tool.json"), {
    ...manifest,
    toolDir: undefined,
  });

  return {
    ...manifest,
    path: toolDir,
    folder: toolDir,
    manifestPath: path.join(toolDir, "tool.json"),
    entryPath: entryAbs,
    body: {
      kind: "folder",
      runtime,
      entry: manifest.entry,
      timeout_ms: manifest.timeout_ms,
      toolDir,
    },
  };
}

async function readFolderTool(userDataPath, folderName) {
  const name = normalizeToolName(folderName);
  if (!name) return null;
  const toolDir = getToolDir(userDataPath, name);
  if (!(await pathExists(toolDir))) return null;
  const st = await fs.promises.stat(toolDir);
  if (!st.isDirectory()) return null;

  const { raw } = await loadManifest(toolDir);
  const entryInfo = await findEntryFile(toolDir, raw.entry || raw.main || raw.script);
  if (!entryInfo && !raw.entry) {
    return null;
  }
  const entry = entryInfo
    ? entryInfo.entry
    : String(raw.entry || raw.main || "main.js").replace(/\\/g, "/");
  const runtime = String(raw.runtime || raw.lang || detectRuntimeFromEntry(entry))
    .trim()
    .toLowerCase();
  const id = String(raw.id || `folder-${name}`).trim() || `folder-${name}`;
  const title = String(raw.title || raw.label || name).trim() || name;
  const description = String(raw.description || `Folder tool ${name}`)
    .trim()
    .slice(0, MAX_DESCRIPTION_LEN);
  const enabled = raw.enabled === false ? false : true;
  const inputSchema = normalizeInputSchema(raw.inputSchema || raw.schema);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20)
    : ["folder"];
  const createdAt = Number(raw.createdAt) || (st.birthtimeMs ? Math.floor(st.birthtimeMs) : Date.now());
  const updatedAt = Number(raw.updatedAt) || (st.mtimeMs ? Math.floor(st.mtimeMs) : createdAt);
  const timeout_ms = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(raw.timeout_ms || raw.timeoutMs) || DEFAULT_TIMEOUT_MS)
  );

  return {
    id,
    name,
    title,
    description,
    enabled,
    tags,
    dependencies: normalizeDependencies(raw.dependencies, name),
    createdAt,
    updatedAt,
    path: toolDir,
    folder: toolDir,
    kind: "folder",
    inputSchema,
    body: {
      kind: "folder",
      runtime,
      entry,
      timeout_ms,
      toolDir,
    },
    runtime,
    entry,
    timeout_ms,
    entryPath: entryInfo ? entryInfo.abs : path.join(toolDir, entry),
    manifestPath: path.join(toolDir, "tool.json"),
  };
}

async function listFolderTools(userDataPath) {
  if (!userDataPath) return [];
  const root = getToolsRoot(userDataPath);
  let entries = [];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const tools = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const tool = await readFolderTool(userDataPath, ent.name);
    if (tool) tools.push(tool);
  }
  tools.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return tools;
}

async function removeFolderTool(userDataPath, name) {
  const n = normalizeToolName(name);
  if (!n) return { deleted: false };
  const toolDir = getToolDir(userDataPath, n);
  if (!(await pathExists(toolDir))) return { deleted: false };
  await fs.promises.rm(toolDir, { recursive: true, force: true });
  return { deleted: true, name: n, path: toolDir };
}

async function updateFolderManifest(userDataPath, name, patch = {}) {
  const tool = await readFolderTool(userDataPath, name);
  if (!tool) throw new Error(`Folder tool not found: ${name}`);
  const nextName = patch.name != null ? normalizeToolName(patch.name) : tool.name;
  if (!nextName) throw new Error("Tool name is required");

  let toolDir = tool.path;
  if (nextName !== tool.name) {
    const dest = getToolDir(userDataPath, nextName);
    if (await pathExists(dest)) throw new Error(`Custom tool name already exists: ${nextName}`);
    await fs.promises.rename(toolDir, dest);
    toolDir = dest;
  }

  const { raw } = await loadManifest(toolDir);
  const now = Date.now();
  const entry =
    patch.entry != null
      ? String(patch.entry).replace(/\\/g, "/")
      : raw.entry || tool.entry;
  const runtime =
    patch.runtime != null || patch.lang != null || patch.language != null
      ? String(patch.runtime || patch.lang || patch.language)
          .trim()
          .toLowerCase()
      : raw.runtime || tool.runtime;

  if (patch.code != null || patch.content != null || patch.source != null) {
    const code = String(patch.code != null ? patch.code : patch.content != null ? patch.content : patch.source);
    const entryAbs = safeResolveInside(toolDir, entry);
    await fs.promises.mkdir(path.dirname(entryAbs), { recursive: true });
    await fs.promises.writeFile(entryAbs, code, "utf8");
  }

  const files = Array.isArray(patch.files) ? patch.files : [];
  for (const file of files) {
    if (!file || typeof file !== "object") continue;
    const rel = String(file.path || file.name || "").trim();
    if (!rel) continue;
    const abs = safeResolveInside(toolDir, rel);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, file.content != null ? String(file.content) : "", "utf8");
  }

  const manifest = {
    id: String(raw.id || tool.id || `folder-${nextName}`),
    name: nextName,
    title:
      patch.title != null
        ? String(patch.title).trim() || nextName
        : String(raw.title || tool.title || nextName),
    description:
      patch.description != null
        ? String(patch.description).trim().slice(0, MAX_DESCRIPTION_LEN)
        : String(raw.description || tool.description || nextName).slice(0, MAX_DESCRIPTION_LEN),
    kind: "folder",
    runtime,
    entry,
    inputSchema: normalizeInputSchema(
      patch.inputSchema != null
        ? patch.inputSchema
        : patch.schema != null
          ? patch.schema
          : raw.inputSchema || tool.inputSchema
    ),
    enabled:
      patch.enabled === true || patch.enabled === false
        ? patch.enabled
        : raw.enabled === false
          ? false
          : true,
    tags: Array.isArray(patch.tags)
      ? patch.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20)
      : Array.isArray(raw.tags)
        ? raw.tags
        : tool.tags || ["folder"],
    dependencies: normalizeDependencies(
      patch.dependencies != null ? patch.dependencies : raw.dependencies || tool.dependencies,
      nextName
    ),
    timeout_ms: Math.min(
      MAX_TIMEOUT_MS,
      Math.max(
        1000,
        Number(
          patch.timeout_ms != null
            ? patch.timeout_ms
            : patch.timeoutMs != null
              ? patch.timeoutMs
              : raw.timeout_ms || tool.timeout_ms || DEFAULT_TIMEOUT_MS
        ) || DEFAULT_TIMEOUT_MS
      )
    ),
    createdAt: Number(raw.createdAt || tool.createdAt) || now,
    updatedAt: now,
  };

  await writeJsonFile(path.join(toolDir, "tool.json"), manifest);
  return readFolderTool(userDataPath, nextName);
}

function buildSpawn(runtime, entryAbs, toolDir) {
  const rt = String(runtime || detectRuntimeFromEntry(entryAbs)).toLowerCase();
  if (rt === "python" || rt === "py") {
    const cmd = process.platform === "win32" ? "python" : "python3";
    return { command: cmd, args: [entryAbs], shell: false };
  }
  if (rt === "powershell" || rt === "ps1" || rt === "pwsh") {
    return {
      command: process.platform === "win32" ? "powershell" : "pwsh",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", entryAbs],
      shell: false,
    };
  }
  if (rt === "bash" || rt === "sh") {
    return { command: "bash", args: [entryAbs], shell: false };
  }
  if (rt === "cmd" || rt === "bat") {
    return { command: entryAbs, args: [], shell: true };
  }
  if (rt === "node-esm" || rt === "esm" || rt === "mjs") {
    return { command: process.execPath, args: [entryAbs], shell: false };
  }
  return { command: process.execPath, args: [entryAbs], shell: false };
}

function tryParseJson(text) {
  if (text == null) return undefined;
  const s = String(text).trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    const startObj = s.indexOf("{");
    const startArr = s.indexOf("[");
    let start = -1;
    if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
    else start = startObj >= 0 ? startObj : startArr;
    if (start < 0) return undefined;
    const slice = s.slice(start);
    try {
      return JSON.parse(slice);
    } catch {
      return undefined;
    }
  }
}

function extractBalancedJson(text) {
  if (text == null) return null;
  const s = String(text);
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  let start = -1;
  let openChar = "{";
  let closeChar = "}";
  if (startObj >= 0 && (startArr < 0 || startObj <= startArr)) {
    start = startObj;
    openChar = "{";
    closeChar = "}";
  } else if (startArr >= 0) {
    start = startArr;
    openChar = "[";
    closeChar = "]";
  } else {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        const raw = s.slice(start, i + 1);
        try {
          return { value: JSON.parse(raw), raw, end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function forceKillTree(child) {
  return new Promise((resolve) => {
    if (!child) {
      resolve(false);
      return;
    }
    const pid = child.pid;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    const onExit = () => finish(true);
    try {
      child.once("exit", onExit);
      child.once("close", onExit);
    } catch {
      /* */
    }

    try {
      if (process.platform === "win32" && pid) {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("close", () => {
          setTimeout(() => finish(true), 50).unref?.();
        });
        killer.on("error", () => {
          try {
            child.kill();
          } catch {
            /* */
          }
          setTimeout(() => finish(false), KILL_GRACE_MS).unref?.();
        });
      } else {
        try {
          child.kill("SIGTERM");
        } catch {
          /* */
        }
        setTimeout(() => {
          try {
            if (!child.killed) child.kill("SIGKILL");
          } catch {
            /* */
          }
          finish(true);
        }, KILL_GRACE_MS).unref?.();
      }
    } catch {
      try {
        child.kill();
      } catch {
        /* */
      }
      finish(false);
    }

    setTimeout(() => finish(false), Math.max(KILL_GRACE_MS * 2, 2000)).unref?.();
  });
}

function runProcess({
  command,
  args,
  shell,
  cwd,
  env,
  inputText,
  timeoutMs,
  signal,
  completeOnJson = true,
  jsonIdleMs = JSON_IDLE_MS,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("Stopped by user");
      err.aborted = true;
      reject(err);
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env,
      shell: Boolean(shell),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let earlyComplete = false;
    let earlyParsed = null;
    let lastOutputAt = Date.now();
    let jsonIdleTimer = null;
    let noOutputTimer = null;
    const startedAt = Date.now();

    const cleanup = () => {
      clearTimeout(timer);
      if (jsonIdleTimer) clearTimeout(jsonIdleTimer);
      if (noOutputTimer) clearTimeout(noOutputTimer);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finish = (payload, isError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (isError) reject(payload);
      else resolve(payload);
    };

    const killChild = async (reason) => {
      killed = true;
      try {
        await forceKillTree(child);
      } catch {
        /* */
      }
      return reason;
    };

    const tryEarlyJsonComplete = () => {
      if (!completeOnJson || settled || earlyComplete) return;
      const extracted = extractBalancedJson(stdout);
      if (!extracted) return;
      earlyParsed = extracted.value;
      earlyComplete = true;
      if (jsonIdleTimer) clearTimeout(jsonIdleTimer);
      jsonIdleTimer = setTimeout(() => {
        if (settled) return;
        void killChild("json_complete").then(() => {
          finish(
            {
              code: 0,
              stdout,
              stderr,
              earlyComplete: true,
              parsed: earlyParsed,
              killedAfterJson: true,
              duration_ms: Date.now() - startedAt,
            },
            false
          );
        });
      }, Math.max(50, Number(jsonIdleMs) || JSON_IDLE_MS));
      jsonIdleTimer.unref?.();
    };

    const onAbort = () => {
      void killChild("abort").then(() => {
        const err = new Error("Stopped by user");
        err.aborted = true;
        finish(err, true);
      });
    };

    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      if (earlyComplete && earlyParsed != null) {
        void killChild("timeout_after_json").then(() => {
          finish(
            {
              code: 0,
              stdout,
              stderr,
              earlyComplete: true,
              parsed: earlyParsed,
              killedAfterJson: true,
              timedOut: true,
              duration_ms: Date.now() - startedAt,
            },
            false
          );
        });
        return;
      }
      void killChild("timeout").then(() => {
        if (settled) return;
        const idle = Date.now() - lastOutputAt;
        const err = new Error(
          `Folder tool timed out after ${timeoutMs}ms` +
            (stdout || stderr
              ? ` (last output ${idle}ms ago; stdout ${stdout.length}b stderr ${stderr.length}b)`
              : " (no stdout/stderr — process hung or never started)")
        );
        err.timedOut = true;
        err.stdout = stdout;
        err.stderr = stderr;
        err.duration_ms = Date.now() - startedAt;
        finish(err, true);
      });
    }, timeoutMs);

    noOutputTimer = setTimeout(() => {
      if (settled || stdout || stderr) return;
    }, NO_OUTPUT_WARN_MS);
    noOutputTimer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      if (stdout.length < MAX_STDOUT_CHARS) stdout += chunk;
      else if (stdout.length === MAX_STDOUT_CHARS) stdout += "\n…";
      tryEarlyJsonComplete();
    });
    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
      else if (stderr.length === MAX_STDERR_CHARS) stderr += "\n…";
    });

    child.on("error", (err) => {
      if (settled) return;
      if (earlyComplete && earlyParsed != null) {
        finish(
          {
            code: 0,
            stdout,
            stderr,
            earlyComplete: true,
            parsed: earlyParsed,
            spawnError: String(err && err.message ? err.message : err),
            duration_ms: Date.now() - startedAt,
          },
          false
        );
        return;
      }
      finish(err, true);
    });

    child.on("close", (code) => {
      if (settled) return;
      if (signal?.aborted) {
        const err = new Error("Stopped by user");
        err.aborted = true;
        finish(err, true);
        return;
      }
      if (earlyComplete && earlyParsed != null) {
        finish(
          {
            code: code == null ? 0 : code,
            stdout,
            stderr,
            earlyComplete: true,
            parsed: earlyParsed,
            duration_ms: Date.now() - startedAt,
          },
          false
        );
        return;
      }
      if (killed) {
        const err = new Error(`Folder tool timed out after ${timeoutMs}ms`);
        err.timedOut = true;
        err.stdout = stdout;
        err.stderr = stderr;
        err.duration_ms = Date.now() - startedAt;
        finish(err, true);
        return;
      }
      const parsed = tryParseJson(stdout) ?? extractBalancedJson(stdout)?.value;
      finish(
        {
          code: code == null ? 1 : code,
          stdout,
          stderr,
          earlyComplete: false,
          parsed: parsed !== undefined ? parsed : null,
          duration_ms: Date.now() - startedAt,
        },
        false
      );
    });

    try {
      child.stdin.write(inputText || "");
      child.stdin.end();
    } catch (err) {
      if (!settled) {
        killChild("stdin_error");
        finish(err, true);
      }
    }
  });
}

async function executeFolderTool(tool, input = {}, context = {}) {
  if (!tool || tool.body?.kind !== "folder" && tool.kind !== "folder") {
    throw new Error("Not a folder tool");
  }
  if (tool.enabled === false) throw new Error(`Custom tool is disabled: ${tool.name}`);

  const toolDir = tool.path || tool.folder || tool.body?.toolDir;
  if (!toolDir) throw new Error("Folder tool missing toolDir");
  const entryRel = tool.entry || tool.body?.entry || "main.js";
  const entryAbs = safeResolveInside(toolDir, entryRel);
  if (!(await pathExists(entryAbs))) {
    throw new Error(`Folder tool entry not found: ${entryAbs}`);
  }
  const runtime = tool.runtime || tool.body?.runtime || detectRuntimeFromEntry(entryAbs);
  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(tool.timeout_ms || tool.body?.timeout_ms) || DEFAULT_TIMEOUT_MS)
  );

  const payload = {
    args: input && typeof input === "object" ? input : {},
    ctx: {
      toolDir,
      toolName: tool.name,
      entry: entryRel,
      runtime,
      rootPath: context.rootPath || null,
      projectName: context.projectName || null,
      userDataPath: context.userDataPath || null,
      toolsRoot: context.userDataPath ? getToolsRoot(context.userDataPath) : null,
      dependencies: Array.isArray(tool.dependencies) ? tool.dependencies : [],
      callTool: {
        bridgePath: path.join(__dirname, "toolBridge.cjs"),
        nodePath: process.execPath,
        stack: Array.isArray(context.__customToolStack) ? context.__customToolStack : [],
        usage: "spawnSync(ctx.callTool.nodePath, [ctx.callTool.bridgePath], {input: JSON.stringify({caller:ctx.toolName,name,args,userDataPath:ctx.userDataPath,rootPath:ctx.rootPath,projectName:ctx.projectName,stack:ctx.callTool.stack}),encoding:'utf8',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}})",
      },
    },
  };

  const spawnSpec = buildSpawn(runtime, entryAbs, toolDir);
  const env = {
    ...process.env,
    COMPOSEVC_TOOL_DIR: toolDir,
    COMPOSEVC_TOOL_NAME: tool.name || "",
    COMPOSEVC_ROOT_PATH: context.rootPath || "",
    COMPOSEVC_USER_DATA: context.userDataPath || "",
  };

  const started = Date.now();
  let proc;
  try {
    proc = await runProcess({
      command: spawnSpec.command,
      args: spawnSpec.args,
      shell: spawnSpec.shell,
      cwd: toolDir,
      env,
      inputText: JSON.stringify(payload),
      timeoutMs,
      signal: context.signal,
      completeOnJson: true,
      jsonIdleMs: JSON_IDLE_MS,
    });
  } catch (err) {
    if (err && err.aborted) throw err;
    const stdout = err?.stdout != null ? String(err.stdout) : "";
    const stderr = err?.stderr != null ? String(err.stderr) : "";
    const partial = tryParseJson(stdout) ?? extractBalancedJson(stdout)?.value;
    const msg =
      (partial && (partial.error || partial.message)) ||
      (err instanceof Error ? err.message : String(err)) ||
      "Folder tool failed";
    const error = new Error(String(msg));
    error.code = err?.code;
    error.timedOut = Boolean(err?.timedOut);
    error.stdout = stdout;
    error.stderr = stderr;
    error.partial = partial != null ? partial : undefined;
    error.duration_ms = err?.duration_ms || Date.now() - started;
    error.__toolText =
      `Custom tool ${tool.name} FAILED (folder/${runtime})\n` +
      `path: ${toolDir}\n` +
      `error: ${msg}\n` +
      (err?.timedOut ? `timedOut: true (limit ${timeoutMs}ms)\n` : "") +
      (stderr ? `stderr: ${stderr.slice(0, 1500)}\n` : "") +
      (stdout ? `stdout: ${stdout.slice(0, 1500)}\n` : "") +
      (partial != null ? `partialJson: ${safeJson(partial)}\n` : "");
    throw error;
  }

  const parsed =
    proc.parsed !== undefined && proc.parsed !== null
      ? proc.parsed
      : tryParseJson(proc.stdout) ?? extractBalancedJson(proc.stdout)?.value;

  if (proc.code !== 0 && !proc.earlyComplete) {
    const errMsg =
      (parsed && (parsed.error || parsed.message)) ||
      (proc.stderr && String(proc.stderr).trim()) ||
      (proc.stdout && String(proc.stdout).trim()) ||
      `Folder tool exited with code ${proc.code}`;
    const error = new Error(String(errMsg));
    error.code = proc.code;
    error.stderr = proc.stderr;
    error.stdout = proc.stdout;
    error.duration_ms = proc.duration_ms || Date.now() - started;
    error.__toolText =
      `Custom tool ${tool.name} FAILED (folder/${runtime}) exit=${proc.code}\n` +
      `path: ${toolDir}\n` +
      `error: ${errMsg}\n` +
      (proc.stderr ? `stderr: ${String(proc.stderr).slice(0, 1500)}\n` : "") +
      (proc.stdout ? `stdout: ${String(proc.stdout).slice(0, 1500)}\n` : "");
    throw error;
  }

  if (parsed != null && typeof parsed === "object" && parsed.ok === false) {
    const errMsg = parsed.error || parsed.message || "Tool returned ok:false";
    const error = new Error(String(errMsg));
    error.code = proc.code;
    error.result = parsed;
    error.stdout = proc.stdout;
    error.stderr = proc.stderr;
    error.duration_ms = proc.duration_ms || Date.now() - started;
    throw error;
  }

  const result =
    parsed !== undefined && parsed !== null
      ? parsed
      : { ok: true, stdout: proc.stdout, text: proc.stdout };
  const duration = proc.duration_ms || Date.now() - started;
  return {
    tool: tool.name,
    id: tool.id,
    kind: "folder",
    path: toolDir,
    folder: toolDir,
    entry: entryRel,
    runtime,
    duration_ms: duration,
    earlyComplete: Boolean(proc.earlyComplete),
    killedAfterJson: Boolean(proc.killedAfterJson),
    exitCode: proc.code,
    result,
    stdout: proc.stdout.length > 4000 ? `${proc.stdout.slice(0, 4000)}\n…` : proc.stdout,
    stderr: proc.stderr
      ? proc.stderr.length > 2000
        ? `${proc.stderr.slice(0, 2000)}\n…`
        : proc.stderr
      : "",
    __toolText:
      typeof result === "string"
        ? result
        : `Custom tool ${tool.name} ok (folder/${runtime}` +
          (proc.earlyComplete ? ", early-json" : "") +
          `)\n` +
          `path: ${toolDir}\n` +
          `duration_ms: ${duration}\n` +
          `result: ${safeJson(result)}`,
  };
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v, null, 2);
    if (s == null) return String(v);
    return s.length > 6000 ? `${s.slice(0, 6000)}\n…` : s;
  } catch {
    return String(v);
  }
}

function isFolderTool(tool) {
  if (!tool) return false;
  if (tool.kind === "folder") return true;
  if (tool.body && tool.body.kind === "folder") return true;
  return false;
}

module.exports = {
  MANIFEST_NAMES,
  ENTRY_CANDIDATES,
  DEFAULT_TIMEOUT_MS,
  JSON_IDLE_MS,
  normalizeToolName,
  getToolsRoot,
  getToolDir,
  safeResolveInside,
  ensureToolScaffold,
  readFolderTool,
  listFolderTools,
  removeFolderTool,
  updateFolderManifest,
  executeFolderTool,
  isFolderTool,
  detectRuntimeFromEntry,
  tryParseJson,
  extractBalancedJson,
  runProcess,
  forceKillTree,
};
