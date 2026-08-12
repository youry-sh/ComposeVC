const readFile = require("./readFile.cjs");
const editFile = require("./editFile.cjs");
const createFile = require("./createFile.cjs");
const listDir = require("./listDir.cjs");
const grepTool = require("./grepTool.cjs");
const bash = require("./bash.cjs");
const wsl = require("./wsl.cjs");
const compactHistory = require("./compactHistory.cjs");
const workTimer = require("./workTimer.cjs");
const think = require("./think.cjs");
const webSearch = require("./webSearch.cjs");
const webFetch = require("./webFetch.cjs");
const askUser = require("./askUser.cjs");
const askOtp = require("./askOtp.cjs");
const cfMail = require("./cfMail.cjs");
const spawnSubagent = require("./spawnSubagent.cjs");
const spawnSubagentBatch = require("./spawnSubagentBatch.cjs");
const waitSubagents = require("./waitSubagents.cjs");
const restoreBackup = require("./restoreBackup.cjs");
const customTool = require("./customTool.cjs");
const httpTool = require("./httpTool.cjs");const proxyManager = require("./proxyManager.cjs");const telegram = require("./telegram.cjs");
const shodanTool = require("./shodanTool.cjs");
const mcpManagerTool = require("./mcpManagerTool.cjs");
const gitTool = require("./gitTool.cjs");
const postsTool = require("./postsTool.cjs");
const booksTool = require("./booksTool.cjs");

const TOOLS = [
  readFile,
  editFile,
  createFile,
  listDir,
  grepTool,
  bash,
  wsl,
  compactHistory,
  workTimer,
  think,
  webSearch,
  webFetch,
  httpTool,
		  askUser,  askOtp,  cfMail,
  spawnSubagent,
  spawnSubagentBatch,
  waitSubagents,
  restoreBackup,
	  customTool,
		  proxyManager,
				telegram,
        shodanTool,
        mcpManagerTool,
        gitTool,
        postsTool,
        booksTool,
				];/** Common aliases the model may emit */const TOOL_ALIASES = {  timer: "work_timer",  worktimer: "work_timer",
  minimum_work_timer: "work_timer",
  glob: "grep",
  search: "grep",
  find: "grep",
  shodan_search: "shodan",
  shodan_search_api: "shodan",
  passive_shodan: "shodan",
  // OTP / verification code pause
  ask_code: "ask_otp",
  ask_code_otp: "ask_otp",
  request_otp: "ask_otp",
  otp: "ask_otp",
  verification_code: "ask_otp",
  enter_otp: "ask_otp",
  wait_otp: "ask_otp",
  generate_identity: "ask_otp",
  generate_dob: "ask_otp",
  generate_address: "ask_otp",
  fake_email: "ask_otp",
  fake_phone: "ask_otp",
  fake_name: "ask_otp",
  fake_identity: "ask_otp",
  // CF Worker temp-mail (runtime-app)
  cfmail: "cf_mail",
  temp_mail: "cf_mail",
  tempmail: "cf_mail",
  mail_tool: "cf_mail",
  email_tool: "cf_mail",
  create_email: "cf_mail",
  generate_mailbox: "cf_mail",
  wait_mail: "cf_mail",
  wait_email: "cf_mail",
  // Per-project .backup restore / diff / cleanup
  restore_file: "restore_backup",
  restore_file_backup: "restore_backup",
  backup_restore: "restore_backup",
  undo_file: "restore_backup",
  file_backup: "restore_backup",
  list_backups: "restore_backup",
  backups: "restore_backup",
  file_diff: "restore_backup",
  backup_diff: "restore_backup",
  diff_backup: "restore_backup",
  rollback: "restore_backup",
  roll_back: "restore_backup",
  file_rollback: "restore_backup",
  cleanup_backups: "restore_backup",
  prune_backups: "restore_backup",
  backup_cleanup: "restore_backup",
  backup_status: "restore_backup",
  receive_mail: "cf_mail",
  receive_email: "cf_mail",
  inbox: "cf_mail",
  mailbox: "cf_mail",
  // batch / wave subagents
  spawn_batch: "spawn_subagent_batch",
  subagent_batch: "spawn_subagent_batch",
  batch_subagents: "spawn_subagent_batch",
  batch_spawn: "spawn_subagent_batch",
  mass_spawn: "spawn_subagent_batch",
  wave_subagents: "spawn_subagent_batch",
  parallel_batch: "spawn_subagent_batch",
  wait_subagents: "wait_subagents",
  wait_background_subagents: "wait_subagents",
  await_subagents: "wait_subagents",
  // custom tools (folder tools)
  customtools: "custom_tool",
  custom_tools: "custom_tool",
  ctl: "custom_tool",
  ctl_tool: "custom_tool",
  manage_custom_tools: "custom_tool",
  user_tool: "custom_tool",
  user_tools: "custom_tool",
  // HTTP API client (JSON/raw; prefer over web_fetch for APIs / folder tools)
  http_request: "http",
  http_client: "http",
  fetch_json: "http",
  api_request: "http",
  request: "http",
  curl: "http",
  // proxy management (providers, accounts, custom providers, routing)
  proxy_management: "proxy_manager",
  manage_proxy: "proxy_manager",
  proxy_tool: "proxy_manager",
  proxymanager: "proxy_manager",
  proxy_manager: "proxy_manager",
	  // Telegram user client (MTProto / tdata)
	  tg: "telegram",
	  telegram_tool: "telegram",
	  tg_tool: "telegram",
	  telegram_client: "telegram",
	  telethon: "telegram",
	  gramjs: "telegram",
	  teleproto: "telegram",
	  tdata: "telegram",
	  tg_login: "telegram",
  send_tg: "telegram",
};
// Longest-name-first, built once — used by fuzzy tool-name recovery.
const TOOLS_BY_NAME_LENGTH = TOOLS.slice().sort((a, b) => b.name.length - a.name.length);

function normalizeToolName(name) {
  if (!name || typeof name !== "string") return name;
  const trimmed = name.trim();
  if (trimmed.startsWith("mcp__")) return trimmed;
  const exact = TOOLS.find((tool) => tool.name === trimmed);
  if (exact) return trimmed;
  const lower = trimmed.toLowerCase();
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  const compact = trimmed.replace(/[^a-zA-Z0-9_]/g, "");
  const compactLower = compact.toLowerCase();
  if (TOOL_ALIASES[compactLower]) return TOOL_ALIASES[compactLower];
  const repeated = TOOLS_BY_NAME_LENGTH.find(
    (tool) => compact.length > tool.name.length && compact.replaceAll(tool.name, "") === ""
  );
  if (repeated) return repeated.name;
  const embedded = TOOLS_BY_NAME_LENGTH.find((tool) => compact.includes(tool.name));
  if (embedded) return embedded.name;
  return trimmed;
}

function getTool(name) {
  const normalized = normalizeToolName(name);
  return TOOLS.find((tool) => tool.name === normalized);
}

function getToolSchemas({ excludeNames } = {}) {
  const excluded = new Set(excludeNames || []);
  return TOOLS.filter((tool) => !excluded.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    isReadOnly: tool.isReadOnly,
  }));
}

async function getToolSchemasAsync({ excludeNames, userDataPath, query = "" } = {}) {
  const base = getToolSchemas({ excludeNames });
  if (!userDataPath) return base;
  try {
    const mcp = require("../mcpManager.cjs");
    const excluded = new Set(excludeNames || []);
    const seen = new Set(base.map((t) => t.name));
    const remote = await mcp.getEnabledToolSchemas(userDataPath);
    for (const tool of remote) {
      if (!tool?.name || excluded.has(tool.name) || seen.has(tool.name)) continue;
      seen.add(tool.name);
      base.push(tool);
    }
  } catch {
    /* MCP servers are optional and isolated per server */
  }
  try {
    const store = getCustomToolsStore();
    const custom = await store.getEnabledCustomToolSchemas(userDataPath, {
      query: typeof query === "string" ? query : "",
    });
    if (!custom.length) return base;
    const excluded = new Set(excludeNames || []);
    const seen = new Set(base.map((t) => t.name));
    for (const tool of custom) {
      if (!tool?.name || excluded.has(tool.name) || seen.has(tool.name)) continue;
      if (store.RESERVED_NAMES.has(tool.name)) continue;
      seen.add(tool.name);
      base.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        isReadOnly: false,
        isCustom: true,
        customId: tool.customId,
      });
    }
  } catch {
    /* custom tools optional */
  }
  return base;
}

function getCustomToolsStore() {
  return require("../customTools.cjs");
}

function makeCustomToolExecutor(toolDef) {
  return {
    name: toolDef.name,
    description: toolDef.description,
    inputSchema: toolDef.inputSchema,
    isReadOnly: false,
    isCustom: true,
    customId: toolDef.id,
    async execute(input, context = {}) {
      const store = getCustomToolsStore();
      const userDataPath = context.userDataPath || null;
      let def = toolDef;
      if (userDataPath) {
        try {
          const fresh = await store.findCustomTool(userDataPath, {
            id: toolDef.id,
            name: toolDef.name,
          });
          if (fresh) {
            if (fresh.enabled === false) {
              throw new Error(`Custom tool is disabled: ${fresh.name || toolDef.name}`);
            }
            def = fresh;
          }
        } catch (err) {
          if (err && /disabled/i.test(String(err.message || err))) throw err;
        }
      }
      return store.executeCustomTool(def, input || {}, {
        ...context,
        userDataPath,
      });
    },
  };
}

async function resolveTool(name, context = {}) {
  const normalized = normalizeToolName(name);
  const builtin = getTool(normalized);
  if (builtin) return { tool: builtin, name: normalized, custom: false };
  const userDataPath = context?.userDataPath || null;
  if (!userDataPath) return { tool: null, name: normalized, custom: false };
  if (String(normalized || "").startsWith("mcp__")) {
    try {
      const mcp = require("../mcpManager.cjs");
      const resolved = await mcp.resolvePublicTool(userDataPath, normalized);
      if (resolved) {
        return {
          name: normalized,
          custom: false,
          mcp: true,
          tool: {
            name: normalized,
            description: resolved.tool.description,
            inputSchema: resolved.tool.inputSchema,
            isReadOnly: false,
            execute(input, ctx) {
              return mcp.callPublicTool(userDataPath, normalized, input || {}, ctx || {});
            },
          },
        };
      }
    } catch {
      /* return normal unknown-tool result below */
    }
  }
  try {
    const store = getCustomToolsStore();
    const def = await store.findCustomTool(userDataPath, { name: normalized });
    if (def && def.enabled !== false) {
      return { tool: makeCustomToolExecutor(def), name: def.name, custom: true };
    }
  } catch {
    /* ignore */
  }
  return { tool: null, name: normalized, custom: false };
}

async function dispatch(name, input, context) {
  const rawToolName = typeof name === "string" ? name : "";
  const normalizedName = normalizeToolName(name);
  const resolved = await resolveTool(normalizedName, context || {});
  const tool = resolved.tool;
  if (!tool) {
    return { ok: false, error: `Unknown tool: ${normalizedName}` };
  }
  const execName = resolved.name || normalizedName;

  const ctx = { ...(context || {}), rawToolName, originalToolName: rawToolName };
  if (ctx.signal?.aborted) {
    return { ok: false, error: "Stopped by user", aborted: true };
  }

  const normalizedInput = resolved.custom
    ? { ...(input || {}) }
    : normalizeToolInput(execName, input || {}, ctx);
  try {
    const data = await tool.execute(normalizedInput, ctx);
    if (ctx.signal?.aborted) {
      return { ok: false, error: "Stopped by user", aborted: true };
    }
    return { ok: true, data };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const aborted =
      error?.name === "AbortError" ||
      ctx.signal?.aborted ||
      /Stopped by user/i.test(msg);
    return { ok: false, error: msg, aborted };
  }
}

/** Dispose side effects from registered tools when a run is stopped. */
function disposeAllToolRuntime() {
  const report = {};
  for (const tool of TOOLS) {
    if (typeof tool.disposeAll !== "function") continue;
    try {
      report[tool.name] = tool.disposeAll() || { ok: true };
    } catch (e) {
      report[tool.name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return report;
}

function isAbsolutePathLike(p) {
  return typeof p === "string" && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\"));
}

function resolveAgainstRoot(p, rootPath) {
  if (typeof p !== "string" || !p || !rootPath) return p;
  if (isAbsolutePathLike(p)) return p;
  // ".", "./", empty-ish relative → project root
  if (p === "." || p === "./" || p === ".\\") return rootPath;
  return require("path").join(rootPath, p);
}

function normalizeToolInput(name, input, context) {
  const next = { ...(input || {}) };
  const rootPath = context?.rootPath || null;

  // grep: query/search aliases are normalized into the regex pattern.
  if (name === "grep") {
    if (next.pattern == null || next.pattern === "") {
      next.pattern = next.query ?? next.q ?? next.regex ?? next.regexp ?? next.search ?? next.text ?? next.needle;
    }
    next.path =
      next.path || next.filePath || next.file_path || next.filepath || next.absolutePath || next.absolute_path ||
      next.directory || next.dir || next.cwd || next.root || next.target_directory;
    if ((!next.path || typeof next.path !== "string") && rootPath) next.path = rootPath;
    if (typeof next.path === "string" && next.path && rootPath) next.path = resolveAgainstRoot(next.path, rootPath);
    if (!next.include && next.file_pattern) next.include = next.file_pattern;
  } else if (["read_file", "edit_file", "create_file", "list_dir"].includes(name)) {
    next.path =
      next.path ||
      next.filePath ||
      next.file_path ||
      next.filepath ||
      next.absolutePath ||
      next.absolute_path ||
      next.filename ||
      next.file ||
      next.query ||
      next.directory ||
      next.dir ||
      next.cwd ||
      next.root ||
      next.target_directory;
    // list_dir: if model omitted path entirely, default to open project root
    if (name === "list_dir" && (!next.path || typeof next.path !== "string") && rootPath) {
      next.path = rootPath;
    }
    if (typeof next.path === "string" && next.path && rootPath) {
      next.path = resolveAgainstRoot(next.path, rootPath);
    }
  }

  // Fast models sometimes emit camelCase / alternate keys for edit payloads.
  if (name === "edit_file") {
    if (next.old_string == null) {
      next.old_string =
        next.oldString ?? next.old ?? next.old_text ?? next.oldText ?? next.before ?? next.search ?? next.target;
    }
    if (next.new_string == null) {
      next.new_string =
        next.newString ?? next.new ?? next.new_text ?? next.newText ?? next.after ?? next.replace ?? next.replacement;
    }
    if (next.replace_all == null && (next.replaceAll === true || next.replaceAll === false)) {
      next.replace_all = next.replaceAll;
    }
  }

  return next;
}

module.exports = {
  TOOLS,
  getTool,
  getToolSchemas,
  getToolSchemasAsync,
  resolveTool,
  dispatch,
  normalizeToolName,
  disposeAllToolRuntime,
};
