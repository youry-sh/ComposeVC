const customTools = require("../customTools.cjs");

function requireUserData(context) {
  const userDataPath = context?.userDataPath || null;
  if (!userDataPath) {
    throw new Error("Custom tools storage is unavailable (no userDataPath in tool context)");
  }
  return userDataPath;
}

function notifyChanged(context, payload) {
  if (typeof context?.onCustomToolsChanged === "function") {
    try {
      context.onCustomToolsChanged(payload);
    } catch {
      /* UI notify best-effort */
    }
  }
}

function resolveIdOrName(input) {
  const id = input.id != null ? String(input.id).trim() : "";
  const name =
    input.name != null
      ? String(input.name).trim()
      : input.tool != null
        ? String(input.tool).trim()
        : "";
  return { id: id || undefined, name: name || undefined };
}

function parseBodyInput(input) {
  if (input.body != null) return input.body;
  if (input.source != null) return input.source;
  if (input.definition != null) return input.definition;
  return null;
}

function parseArgs(input) {
  if (input.args != null && typeof input.args === "object") return input.args;
  if (input.input != null && typeof input.input === "object") return input.input;
  if (input.params != null && typeof input.params === "object") return input.params;
  const skip = new Set([
    "action",
    "id",
    "name",
    "tool",
    "title",
    "description",
    "body",
    "ctl",
    "source",
    "definition",
    "inputSchema",
    "schema",
    "enabled",
    "tags",
    "query",
    "limit",
    "includeDisabled",
    "args",
    "input",
    "params",
    "code",
    "content",
    "files",
    "runtime",
    "lang",
    "language",
    "entry",
    "kind",
    "folder",
    "timeout_ms",
    "timeoutMs",
    "file",
    "rel",
    "relative",
  ]);
  const rest = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (!skip.has(k)) rest[k] = v;
  }
  return rest;
}

module.exports = {
  name: "custom_tool",
  description:
    "Create, manage, search and run agent-authored custom tools.\n\n" +
    "MODEL = FOLDER TOOL ONLY (no CTL language). One folder = one tool: <userData>/custom-tools/<name>/ " +
    "(app storage — NOT the open project folder).\n" +
    "Each tool is REAL CODE: entry file (main.js|main.py|main.ps1|…) + tool.json manifest. " +
    "Runtime spawns the entry with JSON on stdin: { args, ctx } (ctx: toolDir, rootPath, userDataPath, toolsRoot). " +
    "The entry MUST print ONE JSON result to stdout and exit 0. Non-zero exit / stderr → tool FAILED.\n\n" +
    "CREATE (one step): action=add name=my_tool code=\"...\" runtime=node|python|powershell inputSchema={…} description=… " +
    "→ scaffolds folder + entry. Or files=[{path:\"main.js\",content:\"…\"},{path:\"lib/x.js\",content:\"…\"}].\n" +
    "MODULAR: split non-trivial logic into helper files (lib/, helpers/) — one file per responsibility; " +
    "write extras with action=write_file. ONE ENTRY RUNS IT ALL: the entry (main.js/main.py/main.ps1) imports its own " +
    "helpers via RELATIVE paths and drives the full flow — `action=run name=… args={…}` must work standalone right after " +
    "creation (smoke it). Any language (node|python|powershell) is fine.\n" +
    "EDIT: action=write_file name=my_tool file=main.js content=… | read_file | list_files | path name=… (absolute folder).\n" +
    "RUN: call the tool BY NAME as a first-class tool, or custom_tool action=run name=my_tool args={…}.\n" +
    "After creating a tool ALWAYS smoke-test it (action=run) before reusing it in the flow.\n\n" +
    "FORBIDDEN: putting custom tools in the project tree, electron/tools/*.cjs, or registry.cjs " +
    "unless user explicitly asks for a built-in runtime change. " +
    "Do NOT grep/read the open project to locate custom-tool storage — use action=path (no name → toolsRoot) " +
    "or action=list. Project scripts are optional reference only; the tool must live under userData/custom-tools.\n\n" +
    "SEARCH: use a short capability phrase, including the object and action (for example `download telegram video`). " +
    "Search is bilingual and typo-tolerant. If the task has independent parts, search each part separately; an empty result means " +
    "try one broader synonym before concluding that no tool exists. Results include coverage and fuzzy confidence.\n\n" +
    "Actions: list|search|get|validate|add|update|remove|run|enable|disable|export|import|" +
    "write_file|read_file|list_files|path (path without name = tools root + inventory)",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "search",
          "get",
          "validate",
          "add",
          "update",
          "remove",
          "run",
          "enable",
          "disable",
          "export",
          "import",
          "write_file",
          "read_file",
          "list_files",
          "path",
        ],
        description: "Custom tool action",
      },
      id: { type: "string", description: "Tool id (get/update/remove/run)" },
      name: {
        type: "string",
        description: "Tool name (snake_case). Required for add; also lookup key for get/run/remove",
      },
      tool: { type: "string", description: "Alias of name for run/get/remove" },
      title: { type: "string", description: "Human title (add/update)" },
      description: { type: "string", description: "Short description shown in catalog/UI" },
      kind: {
        type: "string",
        description: "folder (always — CTL pipeline/script/call removed)",
      },
      runtime: {
        type: "string",
        description: "folder tool runtime: node | python | powershell | bash (default node)",
      },
      lang: { type: "string", description: "Alias of runtime" },
      language: { type: "string", description: "Alias of runtime" },
      entry: {
        type: "string",
        description: "Entry file relative to tool folder (default main.js / main.py / main.ps1)",
      },
      code: {
        type: "string",
        description: "Source code for entry file (folder tool add/update)",
      },
      content: {
        type: "string",
        description: "Alias of code, or file content for write_file",
      },
      files: {
        type: "array",
        description: "Extra files [{path, content}] written inside the tool folder",
      },
      file: {
        type: "string",
        description: "Relative file path inside tool folder (write_file/read_file)",
      },
      rel: { type: "string", description: "Alias of file" },
      body: {
        type: "object",
        description: "Folder meta only: { kind:'folder', runtime, entry, timeout_ms } — NOT a CTL pipeline",
      },
      source: {
        type: "string",
        description: "Raw entry code (add) OR import pack JSON text (import)",
      },
      inputSchema: {
        type: "object",
        description: "JSON Schema for the custom tool's arguments when called by name",
      },
      schema: { type: "object", description: "Alias of inputSchema" },
      enabled: { type: "boolean", description: "Whether tool is active (default true)" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for search",
      },
      timeout_ms: { type: "number", description: "Folder tool run timeout ms" },
      query: { type: "string", description: "For search" },
      limit: { type: "number", description: "Search/list limit" },
      includeDisabled: { type: "boolean", description: "Include disabled tools in list/search" },
      args: { type: "object", description: "Arguments for action=run" },
      input: { type: "object", description: "Alias of args for action=run" },
      ids: {
        type: "array",
        items: { type: "string" },
        description: "export: optional tool ids to include",
      },
      names: {
        type: "array",
        items: { type: "string" },
        description: "export: optional tool names to include",
      },
      mode: {
        type: "string",
        enum: ["skip", "overwrite", "rename"],
        description: "import: conflict mode (default skip)",
      },
      onConflict: {
        type: "string",
        enum: ["skip", "overwrite", "rename"],
        description: "import: alias of mode",
      },
      pack: {
        type: "object",
        description: "import: pack object { format, tools: [...] }",
      },
      text: { type: "string", description: "import/export: pack JSON text" },
      json: { type: "string", description: "import: alias of text/source pack JSON" },
      path: {
        type: "string",
        description:
          "export: output .zip (folder tools + files) or .json; import: .zip or .json path; also absolute tool file path for write/read",
      },
      filePath: { type: "string", description: "export/import: alias of path" },
      zip: {
        description: "export: true or path to force zip; import: zip path alias",
      },
      format: {
        type: "string",
        description: "export/import: zip | json (default: .zip path → zip, else json)",
      },
      includeWork: {
        type: "boolean",
        description: "export zip: include work/ temp dirs (default false)",
      },
    },
    required: ["action"],
  },
  async execute(input, context = {}) {
    const userDataPath = requireUserData(context);
    const action = String(input?.action || "")
      .trim()
      .toLowerCase();

    switch (action) {
      case "list": {
        const all = await customTools.readCustomTools(userDataPath);
        const includeDisabled = input.includeDisabled === true;
        const filtered = includeDisabled ? all : all.filter(customTools.isToolEnabled);
        const toolsRoot = customTools.getCustomToolsDir(userDataPath);
        const tools = filtered.map((t) => {
          const summary = customTools.toolSummary(t);
          const folder =
            summary.path ||
            summary.folder ||
            t.path ||
            t.folder ||
            t.body?.toolDir ||
            (t.name ? customTools.folderTools.getToolDir(userDataPath, t.name) : null);
          return { ...summary, path: folder, folder };
        });
        return {
          count: tools.length,
          totalStored: all.length,
          enabledCount: all.filter(customTools.isToolEnabled).length,
          tools,
          toolsRoot,
          path: toolsRoot,
          hint:
            "Storage is ALWAYS toolsRoot (userData/custom-tools), never the open project. " +
            "action=path (no name) → same root + inventory. action=path name=… → one tool folder. " +
            "Create: action=add name=… code=… runtime=node. Do NOT grep the project for tool storage.",
          __toolText:
            `Custom tools (${tools.length}) root: ${toolsRoot}\n` +
            (tools.length
              ? tools
                  .map(
                    (t, i) =>
                      `${i + 1}. ${t.name} [${t.kind || "folder"}] ${t.enabled === false ? "(disabled) " : ""}→ ${t.path || "(no folder)"}`
                  )
                  .join("\n")
              : "(empty — add with action=add name=… code=…)") +
            `\nDo not search the open project for custom tools.`,
        };
      }

      case "search": {
        const query =
          input.query != null
            ? String(input.query)
            : input.name != null
              ? String(input.name)
              : "";
        if (!String(query).trim()) throw new Error("search requires 'query'");
        const result = await customTools.searchCustomTools(userDataPath, query, {
          limit: input.limit,
          includeDisabled: input.includeDisabled === true,
        });
        return {
          ...result,
          __toolText:
            result.count === 0
              ? `No custom tools matched ${JSON.stringify(result.query)}`
              : `Custom tools search ${JSON.stringify(result.query)} → ${result.count}:\n` +
                result.results
                  .map(
                    (r, i) =>
                      `${i + 1}. ${r.name} — ${r.title || r.description || ""} ` +
                      `(${r.kind}${r.enabled === false ? ", disabled" : ""}) [id=${r.id}]`
                  )
                  .join("\n"),
        };
      }

      case "get": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error("get requires 'id' or 'name'");
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) throw new Error("Custom tool not found");
        return tool;
      }

      case "validate": {
        const body = parseBodyInput(input);
        const kind =
          body && typeof body === "object"
            ? String(body.kind || body.type || "folder").trim().toLowerCase()
            : "folder";
        if (kind && kind !== "folder" && kind !== "code" && kind !== "dir" && kind !== "fs") {
          throw new Error(
            "CTL (pipeline/script/call) tools are no longer supported — folder tools only (code/files/runtime)"
          );
        }
        const hasCode =
          input.code != null ||
          input.content != null ||
          Array.isArray(input.files) ||
          (typeof input.source === "string" && !String(input.source).trim().startsWith("{"));
        if (!hasCode) {
          throw new Error("Folder tool requires entry code: pass code=… or files=[...] (or body with kind:'folder')");
        }
        return { valid: true, kind: "folder", body: body && typeof body === "object" ? body : { kind: "folder" } };
      }

      case "add": {
        if (!input.name) throw new Error("add requires 'name'");
        const body = parseBodyInput(input);
        const isFolder =
          customTools.wantsFolderTool(input) ||
          body == null ||
          (body && typeof body === "object" && ["folder", "code", "dir", "fs"].includes(String(body.kind || body.type || "").toLowerCase()));
        if (!isFolder) {
          throw new Error(
            "CTL (pipeline/script/call) tools are no longer supported — folder tools only. " +
              "Default: action=add name=… code=… runtime=node"
          );
        }
        if (
          input.code == null &&
          input.content == null &&
          !Array.isArray(input.files) &&
          typeof input.source !== "string"
        ) {
          throw new Error(
            "add requires entry code: action=add name=… code=… runtime=node (or files=[...]). " +
              "The code must read JSON {args,ctx} from stdin and print JSON result to stdout."
          );
        }
        const tool = await customTools.addCustomTool(userDataPath, {
          name: input.name,
          title: input.title,
          description: input.description,
          kind: input.kind || (isFolder ? "folder" : undefined),
          body: body && typeof body === "object" ? body : undefined,
          source: typeof body === "string" ? body : input.source,
          code: input.code,
          content: input.content,
          files: input.files,
          runtime: input.runtime || input.lang || input.language,
          entry: input.entry,
          timeout_ms: input.timeout_ms || input.timeoutMs,
          inputSchema: input.inputSchema || input.schema,
          enabled: input.enabled,
          tags: input.tags,
        });
        notifyChanged(context, { type: "added", tool });
        const kind = tool.kind || tool.body?.kind || "folder";
        const toolPath = tool.path || tool.folder || null;
        return {
          created: true,
          tool: customTools.toolSummary(tool),
          definition: tool,
          path: toolPath,
          folder: toolPath,
          entry: tool.entry || tool.body?.entry || null,
          runtime: tool.runtime || tool.body?.runtime || null,
          __toolText:
            kind === "folder"
              ? `Created folder tool ${tool.name} at ${toolPath}\n` +
                `entry: ${tool.entry || tool.body?.entry || "main.js"} runtime: ${tool.runtime || tool.body?.runtime || "node"}\n` +
                `Call it as tool "${tool.name}" or custom_tool action=run name=${tool.name}.\n` +
                `Edit files with custom_tool action=write_file name=${tool.name} file=… content=… ` +
                `or create_file/edit_file using absolute paths under the tool folder.`
              : `Created custom tool ${tool.name} (${kind}). ` +
                `Call it as tool "${tool.name}" or custom_tool action=run name=${tool.name}.`,
        };
      }

      case "update": {
        const hadExplicitId = Boolean(input.id && String(input.id).trim());
        let toolId = hadExplicitId ? String(input.id).trim() : "";
        let existing = null;
        if (!toolId) {
          const key = resolveIdOrName(input);
          existing = await customTools.findCustomTool(userDataPath, key);
          if (!existing) throw new Error("update requires 'id' (or existing name to resolve)");
          toolId = existing.id;
        } else {
          existing = await customTools.findCustomTool(userDataPath, { id: toolId });
        }
        const patch = {};
        if (input.name != null && hadExplicitId) patch.name = input.name;
        if (input.title != null) patch.title = input.title;
        if (input.description != null) patch.description = input.description;
        const body = parseBodyInput(input);
        if (body != null && typeof body === "object") patch.body = body;
        if (input.inputSchema != null || input.schema != null) {
          patch.inputSchema = input.inputSchema != null ? input.inputSchema : input.schema;
        }
        if (input.enabled === true || input.enabled === false) patch.enabled = input.enabled;
        if (Array.isArray(input.tags)) patch.tags = input.tags;
        if (input.code != null) patch.code = input.code;
        if (input.content != null && input.code == null) patch.content = input.content;
        if (input.runtime != null || input.lang != null || input.language != null) {
          patch.runtime = input.runtime || input.lang || input.language;
        }
        if (input.entry != null) patch.entry = input.entry;
        if (Array.isArray(input.files)) patch.files = input.files;
        if (input.timeout_ms != null || input.timeoutMs != null) {
          patch.timeout_ms = input.timeout_ms != null ? input.timeout_ms : input.timeoutMs;
        }
        if (Object.keys(patch).length === 0) {
          throw new Error("update requires at least one field to change");
        }
        const tool = await customTools.updateCustomTool(userDataPath, toolId, patch);
        notifyChanged(context, { type: "updated", tool });
        return {
          updated: true,
          tool: customTools.toolSummary(tool),
          definition: tool,
          path: tool.path || tool.folder || null,
        };
      }

      case "path": {
        const key = resolveIdOrName(input);
        const toolsRoot = customTools.getCustomToolsDir(userDataPath);
        if (!key.id && !key.name) {
          const all = await customTools.readCustomTools(userDataPath);
          const tools = all.map((t) => {
            const folder =
              t.path ||
              t.folder ||
              t.body?.toolDir ||
              (t.name ? customTools.folderTools.getToolDir(userDataPath, t.name) : null);
            return {
              name: t.name,
              id: t.id,
              kind: t.kind || t.body?.kind || null,
              path: folder,
              entry: t.entry || t.body?.entry || null,
              runtime: t.runtime || t.body?.runtime || null,
              enabled: t.enabled !== false,
            };
          });
          return {
            toolsRoot,
            path: toolsRoot,
            folder: toolsRoot,
            count: tools.length,
            tools,
            hint:
              "No name given — returned custom-tools root. " +
              "For one tool: custom_tool action=path name=<snake_case>. " +
              "Tools live ONLY under toolsRoot (userData), never in the open project.",
            __toolText:
              `Custom tools root: ${toolsRoot}\n` +
              (tools.length
                ? tools
                    .map(
                      (t, i) =>
                        `${i + 1}. ${t.name} (${t.kind || "?"}) → ${t.path || "(no folder)"}`
                    )
                    .join("\n")
                : "(no custom tools yet — action=add name=… code=…)") +
              `\nPass name= to resolve a single tool folder.`,
          };
        }
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) {
          throw new Error(
            `Custom tool not found: ${key.name || key.id}. ` +
              `List: action=list. Create under userData only: action=add name=… code=…. ` +
              `Root: ${toolsRoot}`
          );
        }
        const toolPath =
          tool.path ||
          tool.folder ||
          tool.body?.toolDir ||
          (tool.name ? customTools.folderTools.getToolDir(userDataPath, tool.name) : null);
        return {
          name: tool.name,
          id: tool.id,
          kind: tool.kind || tool.body?.kind || null,
          path: toolPath,
          folder: toolPath,
          entry: tool.entry || tool.body?.entry || null,
          runtime: tool.runtime || tool.body?.runtime || null,
          toolsRoot,
          __toolText:
            `Tool ${tool.name} folder: ${toolPath}\n` +
            `toolsRoot: ${toolsRoot}\n` +
            `Edit ONLY under this folder (write_file / create_file|edit_file with absolute path). ` +
            `Do NOT put tool code in the open project.`,
        };
      }

      case "write_file": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error("write_file requires tool 'id' or 'name'");
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) throw new Error("Custom tool not found");
        const toolDir =
          tool.path ||
          tool.folder ||
          tool.body?.toolDir ||
          customTools.folderTools.getToolDir(userDataPath, tool.name);
        const rel =
          input.file ||
          input.rel ||
          input.relative ||
          input.entry ||
          input.path ||
          input.filePath ||
          tool.entry ||
          tool.body?.entry ||
          "main.js";
        const abs = customTools.folderTools.safeResolveInside(toolDir, String(rel));
        const fs = require("fs");
        const pathMod = require("path");
        await fs.promises.mkdir(pathMod.dirname(abs), { recursive: true });
        const content =
          input.content != null
            ? String(input.content)
            : input.code != null
              ? String(input.code)
              : input.text != null
                ? String(input.text)
                : "";
        await fs.promises.writeFile(abs, content, "utf8");
        if (tool.kind === "folder" || tool.body?.kind === "folder") {
          await customTools.folderTools.updateFolderManifest(userDataPath, tool.name, {
            updatedAt: Date.now(),
          });
        }
        notifyChanged(context, { type: "updated", tool, file: abs });
        return {
          ok: true,
          name: tool.name,
          path: abs,
          file: String(rel).replace(/\\/g, "/"),
          bytesWritten: Buffer.byteLength(content, "utf8"),
          folder: toolDir,
        };
      }

      case "read_file": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error("read_file requires tool 'id' or 'name'");
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) throw new Error("Custom tool not found");
        const toolDir =
          tool.path ||
          tool.folder ||
          tool.body?.toolDir ||
          customTools.folderTools.getToolDir(userDataPath, tool.name);
        const rel =
          input.file ||
          input.rel ||
          input.relative ||
          input.entry ||
          input.path ||
          input.filePath ||
          tool.entry ||
          tool.body?.entry ||
          "main.js";
        const abs = customTools.folderTools.safeResolveInside(toolDir, String(rel));
        const fs = require("fs");
        const content = await fs.promises.readFile(abs, "utf8");
        return {
          ok: true,
          name: tool.name,
          path: abs,
          file: String(rel).replace(/\\/g, "/"),
          content,
          length: content.length,
          folder: toolDir,
        };
      }

      case "list_files": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error("list_files requires tool 'id' or 'name'");
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) throw new Error("Custom tool not found");
        const toolDir =
          tool.path ||
          tool.folder ||
          tool.body?.toolDir ||
          customTools.folderTools.getToolDir(userDataPath, tool.name);
        const fs = require("fs");
        const pathMod = require("path");
        const out = [];
        async function walk(dir, prefix) {
          let entries;
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const ent of entries) {
            if (ent.name === "node_modules" || ent.name === ".git") continue;
            const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
            const abs = pathMod.join(dir, ent.name);
            if (ent.isDirectory()) {
              out.push({ path: rel, type: "dir" });
              if (out.length < 200) await walk(abs, rel);
            } else {
              let size = 0;
              try {
                size = (await fs.promises.stat(abs)).size;
              } catch {
                /* */
              }
              out.push({ path: rel, type: "file", size });
            }
            if (out.length >= 200) return;
          }
        }
        await walk(toolDir, "");
        return {
          ok: true,
          name: tool.name,
          folder: toolDir,
          count: out.length,
          files: out,
        };
      }

      case "remove": {
        let toolId = input.id ? String(input.id).trim() : "";
        let removed = null;
        if (!toolId) {
          const key = resolveIdOrName(input);
          removed = await customTools.findCustomTool(userDataPath, key);
          if (!removed) throw new Error("remove requires 'id' or 'name'");
          toolId = removed.id;
        } else {
          removed = await customTools.findCustomTool(userDataPath, { id: toolId });
        }
        const result = await customTools.removeCustomTool(userDataPath, toolId);
        if (result.deleted) {
          notifyChanged(context, { type: "removed", toolId, tool: removed || result.tool });
        }
        return {
          ...result,
          id: toolId,
          name: (removed || result.tool)?.name || null,
        };
      }

      case "enable":
      case "disable": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error(`${action} requires 'id' or 'name'`);
        const existing = await customTools.findCustomTool(userDataPath, key);
        if (!existing) throw new Error("Custom tool not found");
        const tool = await customTools.updateCustomTool(userDataPath, existing.id, {
          enabled: action === "enable",
        });
        notifyChanged(context, { type: "updated", tool });
        return { updated: true, enabled: tool.enabled, tool: customTools.toolSummary(tool) };
      }

      case "run": {
        const key = resolveIdOrName(input);
        if (!key.id && !key.name) throw new Error("run requires 'id' or 'name'");
        const tool = await customTools.findCustomTool(userDataPath, key);
        if (!tool) throw new Error("Custom tool not found");
        const args = parseArgs(input);
        const data = await customTools.executeCustomTool(tool, args, {
          ...context,
          userDataPath,
        });
        return data;
      }

      case "export": {
        const ids = Array.isArray(input.ids)
          ? input.ids
          : input.id
            ? [input.id]
            : undefined;
        const names = Array.isArray(input.names)
          ? input.names
          : input.name || input.tool
            ? [input.name || input.tool]
            : undefined;
        const outPath = input.path || input.filePath || (typeof input.zip === "string" ? input.zip : null);
        const wantZip =
          input.format === "zip" ||
          input.zip === true ||
          (typeof input.zip === "string" && /\.zip$/i.test(input.zip)) ||
          (typeof outPath === "string" && /\.zip$/i.test(outPath)) ||
          (input.format !== "json" && !outPath);
        let exportPath = outPath;
        if (wantZip && !exportPath) {
          const fs = require("fs");
          const pathMod = require("path");
          const os = require("os");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const base =
            names && names.length === 1
              ? `lopster-tool-${names[0]}`
              : `lopster-custom-tools-${stamp}`;
          exportPath = pathMod.join(os.tmpdir(), `${base}.zip`);
        }
        const result = await customTools.exportCustomTools(userDataPath, {
          ids,
          names,
          name: input.name || input.tool,
          tool: input.tool,
          path: exportPath,
          filePath: exportPath,
          zip: wantZip,
          format: wantZip ? "zip" : input.format === "json" ? "json" : undefined,
          includeDisabled: input.includeDisabled !== false,
          includeWork: input.includeWork === true,
        });
        if (result.format === "zip" || (result.saved && result.format !== "json")) {
          return {
            ...result,
            __toolText:
              `Exported ${result.count} custom tool(s) as ZIP → ${result.path}\n` +
              (result.names?.length ? `names: ${result.names.join(", ")}\n` : "") +
              `bytes: ${result.bytes || "?"}\n` +
              `Import: custom_tool action=import path=${result.path}`,
          };
        }
        if (result.saved) {
          return {
            ...result,
            __toolText:
              `Exported ${result.count} custom tool(s) to ${result.path}\n` +
              (result.names?.length ? `names: ${result.names.join(", ")}` : ""),
          };
        }
        return {
          ...result,
          saved: false,
          __toolText:
            `Exported ${result.count} custom tool(s) as JSON pack\n` +
            (result.names?.length ? `names: ${result.names.join(", ")}\n` : "") +
            `Default for folder tools is ZIP. Use path=C:\\\\temp\\\\tools.zip or format=zip.\n` +
            `format=json keeps the folder-tool JSON pack (name/description/code) in result.text.`,
        };
      }

      case "import": {
        const fromPath = input.path || input.filePath || input.zip || null;
        const isZip =
          (typeof fromPath === "string" && /\.zip$/i.test(fromPath)) ||
          input.format === "zip" ||
          input.zip === true;
        const source =
          input.source != null
            ? input.source
            : input.pack != null
              ? input.pack
              : input.text != null
                ? input.text
                : input.json != null
                  ? input.json
                  : input.body != null
                    ? input.body
                    : null;
        let payload = source;
        if (payload == null && fromPath && !isZip) {
          const fs = require("fs");
          payload = await fs.promises.readFile(String(fromPath), "utf8");
        }
        if (payload == null && !fromPath) {
          throw new Error(
            "import requires path=file.zip (folder tools) or source/pack/text/json or path=file.json"
          );
        }
        const names = Array.isArray(input.names)
          ? input.names
          : input.name || input.tool
            ? [input.name || input.tool]
            : undefined;
        const ids = Array.isArray(input.ids)
          ? input.ids
          : input.id
            ? [input.id]
            : undefined;
        const indices = Array.isArray(input.indices)
          ? input.indices
          : input.index != null
            ? [input.index]
            : undefined;
        const result = await customTools.importCustomTools(
          userDataPath,
          isZip ? null : payload,
          {
            mode: input.mode || input.onConflict || "skip",
            names,
            name: input.name || input.tool,
            ids,
            indices,
            onlyOne: input.onlyOne === true,
            path: fromPath,
            filePath: fromPath,
            zip: isZip ? fromPath : undefined,
            zipPath: isZip ? fromPath : undefined,
          }
        );
        if (result.count > 0 || (result.updated && result.updated.length)) {
          notifyChanged(context, { type: "imported", result });
        }
        return {
          ...result,
          path: fromPath || null,
          __toolText:
            (result.format === "lopster-custom-tools-zip" || isZip
              ? `Imported ZIP custom tools (mode=${result.mode}): `
              : `Imported custom tools (mode=${result.mode}): `) +
            `+${result.imported?.length || 0} new, ` +
            `${result.updated?.length || 0} updated, ` +
            `${result.skipped?.length || 0} skipped, ` +
            `${result.errors?.length || 0} errors` +
            (result.totalInPack != null ? ` (pack had ${result.totalInPack})` : "") +
            (result.renamed?.length
              ? `\nrenamed: ${result.renamed.map((r) => `${r.from}→${r.to}`).join(", ")}`
              : "") +
            (result.imported?.length
              ? `\ninstalled: ${result.imported.map((t) => t.name + (t.path ? ` → ${t.path}` : "")).join(", ")}`
              : ""),
        };
      }

      default:
        throw new Error(
          `Unknown custom_tool action: ${action}. Use list|search|get|validate|add|update|remove|run|enable|disable|export|import|write_file|read_file|list_files|path`
        );
    }
  },
};
