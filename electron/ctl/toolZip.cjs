const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const ZIP_PACK_FORMAT = "lopster-custom-tools-zip";
const ZIP_PACK_VERSION = 1;
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".backup",
  "__MACOSX",
  "work",
  "tmp",
  "temp",
  ".cache",
]);

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function runCmd(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: Boolean(opts.shell),
      cwd: opts.cwd || process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c) => {
      stdout += c;
    });
    child.stderr?.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else {
        const err = new Error(
          (stderr || stdout || `Command failed (${code})`).trim().slice(0, 2000)
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function rmrf(p) {
  try {
    await fs.promises.rm(p, { recursive: true, force: true });
  } catch {
    /* */
  }
}

async function copyDirFiltered(src, dest, { skipWork = true } = {}) {
  await ensureDir(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (ent.name === "." || ent.name === "..") continue;
    if (SKIP_DIR_NAMES.has(ent.name) && ent.isDirectory()) {
      if (skipWork || ent.name !== "work") continue;
      if (ent.name !== "work") continue;
    }
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "__MACOSX") continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      await copyDirFiltered(from, to, { skipWork });
    } else if (ent.isFile()) {
      await ensureDir(path.dirname(to));
      await fs.promises.copyFile(from, to);
    }
  }
}

async function listFilesRecursive(rootDir, base = "") {
  const out = [];
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(rootDir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      out.push(...(await listFilesRecursive(rootDir, rel)));
    } else if (ent.isFile()) {
      out.push(rel.replace(/\\/g, "/"));
    }
  }
  return out;
}

async function compressDirToZip(sourceDir, zipPath) {
  await ensureDir(path.dirname(zipPath));
  if (await pathExists(zipPath)) await fs.promises.unlink(zipPath);

  if (process.platform === "win32") {
    const ps = `
$ErrorActionPreference = 'Stop'
$src = ${JSON.stringify(sourceDir)}
$dst = ${JSON.stringify(zipPath)}
if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Force }
Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dst -Force
`;
    await runCmd(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      {}
    );
    return;
  }

  try {
    await runCmd("zip", ["-r", "-q", zipPath, "."], { cwd: sourceDir });
    return;
  } catch {
    /* fallback */
  }
  throw new Error("zip compress failed: need PowerShell Compress-Archive (Windows) or zip CLI");
}

async function expandZipToDir(zipPath, destDir) {
  await rmrf(destDir);
  await ensureDir(destDir);

  if (process.platform === "win32") {
    const ps = `
$ErrorActionPreference = 'Stop'
$zip = ${JSON.stringify(zipPath)}
$dst = ${JSON.stringify(destDir)}
if (-not (Test-Path -LiteralPath $dst)) { New-Item -ItemType Directory -Path $dst | Out-Null }
Expand-Archive -LiteralPath $zip -DestinationPath $dst -Force
`;
    await runCmd(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      {}
    );
    return;
  }

  try {
    await runCmd("unzip", ["-q", "-o", zipPath, "-d", destDir], {});
    return;
  } catch {
    /* */
  }
  throw new Error("zip expand failed: need PowerShell Expand-Archive (Windows) or unzip CLI");
}

function looksLikeZipPath(p) {
  return typeof p === "string" && /\.zip$/i.test(p.trim());
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.promises.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

async function readJsonSafe(file) {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a staging dir with tools/ + manifest, then zip it.
 * @param {object[]} tools full tool defs from readCustomTools
 * @param {string} zipPath output .zip
 * @param {object} opts
 */
async function exportToolsToZip(userDataPath, tools, zipPath, opts = {}) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  if (!list.length) throw new Error("No tools to export");
  if (!looksLikeZipPath(zipPath)) {
    throw new Error("export zip path must end with .zip");
  }

  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ct-zip-export-"));
  const toolsRoot = path.join(staging, "tools");
  await ensureDir(toolsRoot);

  const packTools = [];
  const folderToolsMod = require("./folderTools.cjs");
  const skipWork = opts.includeWork !== true;

  for (const tool of list) {
    const name = folderToolsMod.normalizeToolName(tool.name);
    if (!name) continue;
    const isFolder =
      tool.kind === "folder" ||
      tool.body?.kind === "folder" ||
      folderToolsMod.isFolderTool(tool);
    const entry = {
      name,
      title: tool.title || name,
      description: tool.description || "",
      kind: isFolder ? "folder" : tool.body?.kind || tool.kind || "pipeline",
      enabled: tool.enabled !== false,
      tags: Array.isArray(tool.tags) ? tool.tags : [],
      inputSchema: tool.inputSchema || {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      runtime: tool.runtime || tool.body?.runtime || null,
      entry: tool.entry || tool.body?.entry || null,
    };

    if (isFolder) {
      const srcDir =
        tool.path ||
        tool.folder ||
        tool.body?.toolDir ||
        folderToolsMod.getToolDir(userDataPath, name);
      if (!(await pathExists(srcDir))) {
        throw new Error(`Folder tool directory missing: ${name} (${srcDir})`);
      }
      const destDir = path.join(toolsRoot, name);
      await copyDirFiltered(srcDir, destDir, { skipWork });
      const files = await listFilesRecursive(destDir);
      entry.files = files;
      entry.hasFolder = true;
    } else {
      entry.body = tool.body;
      entry.hasFolder = false;
      const legacyDir = path.join(toolsRoot, name);
      await ensureDir(legacyDir);
      await writeJson(path.join(legacyDir, "legacy-tool.json"), {
        name,
        title: entry.title,
        description: entry.description,
        body: tool.body,
        inputSchema: entry.inputSchema,
        enabled: entry.enabled,
        tags: entry.tags,
        kind: entry.kind,
      });
      entry.files = ["legacy-tool.json"];
    }
    packTools.push(entry);
  }

  const manifest = {
    format: ZIP_PACK_FORMAT,
    version: ZIP_PACK_VERSION,
    exportedAt: Date.now(),
    count: packTools.length,
    tools: packTools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      kind: t.kind,
      enabled: t.enabled,
      tags: t.tags,
      runtime: t.runtime,
      entry: t.entry,
      hasFolder: t.hasFolder,
      files: t.files,
      inputSchema: t.inputSchema,
      body: t.hasFolder ? undefined : t.body,
    })),
  };
  await writeJson(path.join(staging, "manifest.json"), manifest);

  const absZip = path.resolve(zipPath);
  await compressDirToZip(staging, absZip);
  await rmrf(staging);

  const st = await fs.promises.stat(absZip);
  return {
    ok: true,
    format: ZIP_PACK_FORMAT,
    version: ZIP_PACK_VERSION,
    path: absZip,
    count: packTools.length,
    names: packTools.map((t) => t.name),
    bytes: st.size,
    tools: packTools.map((t) => ({
      name: t.name,
      kind: t.kind,
      files: (t.files || []).length,
    })),
  };
}

function findToolDirs(extractRoot) {
  const dirs = [];
  const manifestPath = path.join(extractRoot, "manifest.json");
  const toolsSub = path.join(extractRoot, "tools");

  async function collect() {
    if (await pathExists(toolsSub)) {
      const ents = await fs.promises.readdir(toolsSub, { withFileTypes: true });
      for (const ent of ents) {
        if (ent.isDirectory()) {
          dirs.push({ name: ent.name, dir: path.join(toolsSub, ent.name) });
        }
      }
      return;
    }
    const ents = await fs.promises.readdir(extractRoot, { withFileTypes: true });
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      if (ent.name === "__MACOSX") continue;
      const dir = path.join(extractRoot, ent.name);
      const hasToolJson = await pathExists(path.join(dir, "tool.json"));
      const hasMain =
        (await pathExists(path.join(dir, "main.js"))) ||
        (await pathExists(path.join(dir, "main.py"))) ||
        (await pathExists(path.join(dir, "main.ps1"))) ||
        (await pathExists(path.join(dir, "legacy-tool.json")));
      if (hasToolJson || hasMain) {
        dirs.push({ name: ent.name, dir });
      }
    }
    if (!dirs.length) {
      const hasToolJson = await pathExists(path.join(extractRoot, "tool.json"));
      const hasMain =
        (await pathExists(path.join(extractRoot, "main.js"))) ||
        (await pathExists(path.join(extractRoot, "main.py")));
      if (hasToolJson || hasMain) {
        const base = path.basename(extractRoot);
        dirs.push({ name: base === "extract" ? "imported_tool" : base, dir: extractRoot });
      }
    }
  }

  return { manifestPath, collect, dirs };
}

/**
 * Preview tools inside a .zip without installing them.
 */
async function previewToolsFromZip(zipPath, options = {}) {
  const folderToolsMod = require("./folderTools.cjs");
  const absZip = path.resolve(String(zipPath));
  if (!(await pathExists(absZip))) throw new Error(`Zip not found: ${absZip}`);
  if (!looksLikeZipPath(absZip)) throw new Error("import zip path must end with .zip");

  const extractRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ct-zip-preview-"));
  try {
    await expandZipToDir(absZip, extractRoot);

    let root = extractRoot;
    const top = await fs.promises.readdir(extractRoot, { withFileTypes: true });
    if (
      top.length === 1 &&
      top[0].isDirectory() &&
      top[0].name !== "tools" &&
      !(await pathExists(path.join(extractRoot, "manifest.json")))
    ) {
      const only = path.join(extractRoot, top[0].name);
      if (
        (await pathExists(path.join(only, "manifest.json"))) ||
        (await pathExists(path.join(only, "tools")))
      ) {
        root = only;
      }
    }

    const manifest =
      (await readJsonSafe(path.join(root, "manifest.json"))) ||
      (await readJsonSafe(path.join(extractRoot, "manifest.json")));

    const dirs = [];
    const toolsSub = path.join(root, "tools");
    if (await pathExists(toolsSub)) {
      const ents = await fs.promises.readdir(toolsSub, { withFileTypes: true });
      for (const ent of ents) {
        if (ent.isDirectory()) dirs.push({ name: ent.name, dir: path.join(toolsSub, ent.name) });
      }
    } else {
      const ents = await fs.promises.readdir(root, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isDirectory() || ent.name === "__MACOSX") continue;
        const dir = path.join(root, ent.name);
        const hasToolJson = await pathExists(path.join(dir, "tool.json"));
        const hasLegacy = await pathExists(path.join(dir, "legacy-tool.json"));
        const hasMain =
          (await pathExists(path.join(dir, "main.js"))) ||
          (await pathExists(path.join(dir, "main.py"))) ||
          (await pathExists(path.join(dir, "main.ps1")));
        if (hasToolJson || hasLegacy || hasMain) {
          dirs.push({ name: ent.name, dir });
        }
      }
      if (!dirs.length) {
        const hasToolJson = await pathExists(path.join(root, "tool.json"));
        const hasMain =
          (await pathExists(path.join(root, "main.js"))) ||
          (await pathExists(path.join(root, "main.py")));
        if (hasToolJson || hasMain) {
          const nameFromManifest =
            Array.isArray(manifest?.tools) && manifest.tools[0]?.name
              ? String(manifest.tools[0].name)
              : "imported_tool";
          dirs.push({ name: nameFromManifest, dir: root });
        }
      }
    }

    let selected = dirs;
    const namesFilter = Array.isArray(options.names)
      ? options.names.map((n) => folderToolsMod.normalizeToolName(n)).filter(Boolean)
      : options.name || options.tool
        ? [folderToolsMod.normalizeToolName(options.name || options.tool)].filter(Boolean)
        : null;
    if (namesFilter && namesFilter.length) {
      selected = selected.filter((d) =>
        namesFilter.includes(folderToolsMod.normalizeToolName(d.name))
      );
    }

    const tools = [];
    for (let i = 0; i < selected.length; i += 1) {
      const item = selected[i];
      const name = folderToolsMod.normalizeToolName(item.name) || item.name;
      const manEntry = Array.isArray(manifest?.tools)
        ? manifest.tools.find(
            (t) => folderToolsMod.normalizeToolName(t.name) === folderToolsMod.normalizeToolName(item.name)
          )
        : null;
      const meta = (await readJsonSafe(path.join(item.dir, "tool.json"))) || {};
      const legacy = await pathExists(path.join(item.dir, "legacy-tool.json"));
      const title =
        (manEntry && manEntry.title) ||
        meta.title ||
        name;
      const description =
        (manEntry && manEntry.description) ||
        meta.description ||
        "";
      const kind = legacy
        ? "pipeline"
        : (manEntry && manEntry.kind) || meta.kind || "folder";
      const tags = Array.isArray(manEntry?.tags)
        ? manEntry.tags
        : Array.isArray(meta.tags)
          ? meta.tags
          : [];
      const enabled =
        manEntry && manEntry.enabled === false
          ? false
          : meta.enabled === false
            ? false
            : true;
      tools.push({
        index: i,
        id: meta.id != null ? String(meta.id) : manEntry?.id != null ? String(manEntry.id) : undefined,
        name,
        title: String(title || name).trim() || name,
        description: String(description || "").trim(),
        kind: String(kind || "folder"),
        enabled,
        tags: tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20),
        valid: Boolean(name) && !legacy,
        error: legacy
          ? "Legacy tool entry in zip (no folder manifest) — only folder tools are supported"
          : name
            ? null
            : "Tool name is required",
      });
    }

    return {
      ok: true,
      count: tools.length,
      totalInPack: dirs.length,
      tools,
      format: ZIP_PACK_FORMAT,
      path: absZip,
    };
  } finally {
    await rmrf(extractRoot);
  }
}

/**
 * Import tools from a .zip into userData/custom-tools
 */
async function importToolsFromZip(userDataPath, zipPath, options = {}) {
  const folderToolsMod = require("./folderTools.cjs");
  const absZip = path.resolve(String(zipPath));
  if (!(await pathExists(absZip))) throw new Error(`Zip not found: ${absZip}`);
  if (!looksLikeZipPath(absZip)) throw new Error("import zip path must end with .zip");

  const modeRaw = String(options.mode || options.onConflict || "skip")
    .trim()
    .toLowerCase();
  const mode =
    modeRaw === "overwrite" || modeRaw === "replace" || modeRaw === "update"
      ? "overwrite"
      : modeRaw === "rename" || modeRaw === "copy"
        ? "rename"
        : "skip";

  const extractRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ct-zip-import-"));
  const imported = [];
  const updated = [];
  const skipped = [];
  const renamed = [];
  const errors = [];

  try {
    await expandZipToDir(absZip, extractRoot);

    let root = extractRoot;
    const top = await fs.promises.readdir(extractRoot, { withFileTypes: true });
    if (
      top.length === 1 &&
      top[0].isDirectory() &&
      top[0].name !== "tools" &&
      !(await pathExists(path.join(extractRoot, "manifest.json")))
    ) {
      const only = path.join(extractRoot, top[0].name);
      if (
        (await pathExists(path.join(only, "manifest.json"))) ||
        (await pathExists(path.join(only, "tools")))
      ) {
        root = only;
      }
    }

    const manifest =
      (await readJsonSafe(path.join(root, "manifest.json"))) ||
      (await readJsonSafe(path.join(extractRoot, "manifest.json")));

    const { collect } = findToolDirs(root);
    const holder = { dirs: [] };
    const toolsSub = path.join(root, "tools");
    if (await pathExists(toolsSub)) {
      const ents = await fs.promises.readdir(toolsSub, { withFileTypes: true });
      for (const ent of ents) {
        if (ent.isDirectory()) holder.dirs.push({ name: ent.name, dir: path.join(toolsSub, ent.name) });
      }
    } else {
      const ents = await fs.promises.readdir(root, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isDirectory() || ent.name === "__MACOSX") continue;
        const dir = path.join(root, ent.name);
        const hasToolJson = await pathExists(path.join(dir, "tool.json"));
        const hasLegacy = await pathExists(path.join(dir, "legacy-tool.json"));
        const hasMain =
          (await pathExists(path.join(dir, "main.js"))) ||
          (await pathExists(path.join(dir, "main.py"))) ||
          (await pathExists(path.join(dir, "main.ps1")));
        if (hasToolJson || hasLegacy || hasMain) {
          holder.dirs.push({ name: ent.name, dir });
        }
      }
      if (!holder.dirs.length) {
        const hasToolJson = await pathExists(path.join(root, "tool.json"));
        const hasMain =
          (await pathExists(path.join(root, "main.js"))) ||
          (await pathExists(path.join(root, "main.py")));
        if (hasToolJson || hasMain) {
          const nameFromManifest =
            Array.isArray(manifest?.tools) && manifest.tools[0]?.name
              ? String(manifest.tools[0].name)
              : "imported_tool";
          holder.dirs.push({ name: nameFromManifest, dir: root });
        }
      }
    }

    let selected = holder.dirs;
    const namesFilter = Array.isArray(options.names)
      ? options.names.map((n) => folderToolsMod.normalizeToolName(n)).filter(Boolean)
      : options.name || options.tool
        ? [folderToolsMod.normalizeToolName(options.name || options.tool)].filter(Boolean)
        : null;
    if (namesFilter && namesFilter.length) {
      selected = selected.filter((d) => namesFilter.includes(folderToolsMod.normalizeToolName(d.name)));
    }

    const existing = await folderToolsMod.listFolderTools(userDataPath);
    const existingNames = new Set(existing.map((t) => t.name));
    const usedInBatch = new Set();

    function uniqueName(base) {
      let name = folderToolsMod.normalizeToolName(base) || "imported_tool";
      if (!existingNames.has(name) && !usedInBatch.has(name)) return name;
      let i = 2;
      while (i < 1000) {
        const c = folderToolsMod.normalizeToolName(`${name}_${i}`) || `imported_tool_${i}`;
        if (!existingNames.has(c) && !usedInBatch.has(c)) return c;
        i += 1;
      }
      return folderToolsMod.normalizeToolName(`${name}_${Date.now().toString(16)}`);
    }

    for (const item of selected) {
      try {
        let name = folderToolsMod.normalizeToolName(item.name);
        if (!name) {
          errors.push({ name: item.name, error: "Invalid tool name" });
          continue;
        }

        const legacyPath = path.join(item.dir, "legacy-tool.json");
        if (await pathExists(legacyPath)) {
          const raw = await readJsonSafe(legacyPath);
          if (!raw) {
            errors.push({ name, error: "Invalid legacy-tool.json" });
            continue;
          }
          errors.push({
            name,
            error:
              "Legacy tool entry in zip (no folder manifest) — only folder tools are supported. Skipped.",
          });
          skipped.push({ name, reason: "legacy_ctl_in_zip" });
          continue;
        }

        const dest = folderToolsMod.getToolDir(userDataPath, name);
        const exists = await pathExists(dest);

        if (exists) {
          if (mode === "skip") {
            skipped.push({ name, reason: "exists" });
            continue;
          }
          if (mode === "rename") {
            const next = uniqueName(name);
            renamed.push({ from: name, to: next });
            name = next;
          } else if (mode === "overwrite") {
            await rmrf(dest);
          }
        }

        const finalDest = folderToolsMod.getToolDir(userDataPath, name);
        await copyDirFiltered(item.dir, finalDest, { skipWork: true });

        const toolJsonPath = path.join(finalDest, "tool.json");
        let meta = (await readJsonSafe(toolJsonPath)) || {};
        const manEntry = Array.isArray(manifest?.tools)
          ? manifest.tools.find((t) => folderToolsMod.normalizeToolName(t.name) === folderToolsMod.normalizeToolName(item.name))
          : null;
        if (manEntry && isPlainObject(manEntry)) {
          meta = {
            ...meta,
            name,
            title: manEntry.title || meta.title || name,
            description: manEntry.description || meta.description || "",
            kind: "folder",
            runtime: manEntry.runtime || meta.runtime || "node",
            entry: manEntry.entry || meta.entry || "main.js",
            inputSchema: manEntry.inputSchema || meta.inputSchema,
            enabled: manEntry.enabled === false ? false : meta.enabled !== false,
            tags: Array.isArray(manEntry.tags) ? manEntry.tags : meta.tags || ["folder"],
          };
        } else {
          meta = {
            ...meta,
            name,
            title: meta.title || name,
            kind: "folder",
            enabled: meta.enabled === false ? false : true,
          };
        }
        meta.name = name;
        meta.kind = "folder";
        meta.updatedAt = Date.now();
        if (!meta.createdAt) meta.createdAt = Date.now();
        if (!meta.id) meta.id = `folder-${name}`;
        await writeJson(toolJsonPath, meta);

        const installed = await folderToolsMod.readFolderTool(userDataPath, name);
        if (!installed) {
          errors.push({ name, error: "Installed folder but readFolderTool failed (missing entry?)" });
          continue;
        }
        usedInBatch.add(name);
        existingNames.add(name);
        const summary = {
          id: installed.id,
          name: installed.name,
          title: installed.title,
          description: installed.description,
          kind: "folder",
          path: installed.path,
          enabled: installed.enabled !== false,
        };
        if (exists && mode === "overwrite") updated.push(summary);
        else imported.push(summary);
      } catch (err) {
        errors.push({
          name: item.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      ok: errors.length === 0,
      mode,
      format: ZIP_PACK_FORMAT,
      path: absZip,
      imported,
      updated,
      skipped,
      renamed,
      errors,
      count: imported.length + updated.length,
      totalInPack: holder.dirs.length,
      manifest: manifest
        ? { format: manifest.format, version: manifest.version, count: manifest.count }
        : null,
    };
  } finally {
    await rmrf(extractRoot);
  }
}

module.exports = {
  ZIP_PACK_FORMAT,
  ZIP_PACK_VERSION,
  looksLikeZipPath,
  exportToolsToZip,
  importToolsFromZip,
  previewToolsFromZip,
  compressDirToZip,
  expandZipToDir,
  copyDirFiltered,
};
