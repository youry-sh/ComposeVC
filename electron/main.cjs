const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeImage, session, webContents } = require("electron");
// Broken GPU drivers (e.g. nouveau on Linux) can render a black window.
// Must be set before app is ready / any window is created.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const http = require("http");
const { pathToFileURL } = require("url");
const {
  buildSystemPrompt,
  buildSystemPromptWithCustomTools,
  invalidateContextCache,
} = require("./context.cjs");
const { runAgentLoop } = require("./agentLoop.cjs");
const { trackExternalUsage } = require("./externalUsage.cjs");
const { countTokens } = require("./tokenCount.cjs");
const { compactMessages, isRealUserMessage } = require("./compact.cjs");
const { contentToText: contentPartsToText } = require("./adapters/contentParts.cjs");
const memory = require("./memory.cjs");
const gitService = require("./gitService.cjs");
const storageStore = require("./storageStore.cjs");
const webEngineStore = require("./webEngineStore.cjs");
const multiIdeStore = require("./multiIdeStore.cjs");
const workTimerStore = require("./workTimerStore.cjs");
const backgroundTasks = require("./backgroundTasks.cjs");
const telegramTool = require("./tools/telegram.cjs");
const customTools = require("./customTools.cjs");
const mcpManager = require("./mcpManager.cjs");
const instructions = require("./instructions.cjs");
const agentPrompts = require("./agentPrompts.cjs");
const { THINKING_MAX_PROMPT } = require("./thinkingMaxPrompt.cjs");
const autoInsert = require("./autoInsert.cjs");
const inlineHint = require("./inlineHint.cjs");
const { LAB_IN_MODE_ID, runLabInPipeline } = require("./labIn/index.cjs");
const {
  FORTANI_MODE_ID,
  resolveFortaniModel,
  collectChangePacket,
  reviewExclusions,
  buildReviewMessage,
  buildFixMessage,
} = require("./fortani/index.cjs");
const knowledgeStore = require("./labIn/knowledgeStore.cjs");
const knowledgeArchive = require("./labIn/knowledgeArchive.cjs");
const docsStore = require("./docs/docsStore.cjs");
const promptsStore = require("./promptsStore.cjs");
const pluginsRegistry = require("./plugins/registry.cjs");
const blenderPlugin = require("./plugins/blender/index.cjs");
const cfMailConfig = require("./cfMailConfig.cjs");

const { TOOLS, getToolSchemas, getToolSchemasAsync } = require("./tools/registry.cjs");
const { createTelegramBot, normalizeTelegramConfig } = require("./telegramBot.cjs");
const telegramSlots = require("./telegramSlots.cjs");
const { resolveUserAnswer, rejectAllPending } = require("./askUserBridge.cjs");
const { registerProxyHandlers } = require("./proxy/index.cjs");
const { registerLocalAgentHandlers } = require("./localAgentMcp.cjs");
const runnerEngine = require("./runners/runnerEngine.cjs");
const { showAgentToast } = require("./agentToast.cjs");
const { runtime: sizeworkout } = require("./sizeworkout.cjs");
const workerPool = require("./workerPool.cjs");
const terminalManager = require("./terminalManager.cjs");
const usageStore = require("./usageStore.cjs");
const screenshot = require("./screenshot.cjs");
terminalManager.register(ipcMain, app);
sizeworkout.on("changed", (workspace) => {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send("sizeworkout:changed", { ok: true, workspace });
    } catch {
      /* ignore */
    }
  }
});
	// When packaged (asar), app files live under resources/app.asar — project root is resources/.// Dev: electron/main.cjs → parent is repo root.
const appRootPath = app.isPackaged
  ? path.resolve(process.resourcesPath || path.dirname(app.getAppPath()))
  : path.resolve(__dirname, "..");
const sanitizeIdentityPart = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "");
const appRootName = sanitizeIdentityPart(path.basename(appRootPath).toLowerCase());
const appRootHash = crypto.createHash("sha1").update(appRootPath).digest("hex").slice(0, 8);
const defaultCopyId = appRootName ? `${appRootName}-${appRootHash}` : appRootHash;
const appCopyId = sanitizeIdentityPart(process.env.LOPSTER_COPY_ID) || defaultCopyId;
const appName = process.env.LOPSTER_APP_NAME || "ComposeVC";
const appIconIcoPath = app.isPackaged
  ? path.join(process.resourcesPath, "public", "logo", "app-icon.ico")
  : path.join(__dirname, "..", "public", "logo", "app-icon.ico");
const appIconPngPath = app.isPackaged
  ? path.join(process.resourcesPath, "public", "logo", "app-icon.png")
  : path.join(__dirname, "..", "public", "logo", "app-icon.png");
const appInstanceId = sanitizeIdentityPart(process.env.LOPSTER_INSTANCE_ID);
const appIdentitySuffix = appInstanceId || appCopyId;
// Stable product id for installs (not path-hash of install folder).
const appUserDataBaseName = app.isPackaged
  ? "composevc"
  : `lopster-ide-copy-${appCopyId}`;
const appUserDataName = appInstanceId ? `${appUserDataBaseName}-${appInstanceId}` : appUserDataBaseName;
const appUserModelId = app.isPackaged
  ? "com.composevc.app"
  : appIdentitySuffix
    ? `com.lopster.ide.copy.${appIdentitySuffix}`
    : "com.lopster.ide.copy";

/**
 * ChatGPT "Trusted Access for Cyber" protection flag (surfaced by the proxy as
 * code cyber_flag / "cybersecurity risk" text). Content-based rejection — the
 * chat should show the flag as-is, without the misleading "after multiple
 * retries" prefix (the proxy failed fast on purpose).
 */
function isCyberFlagErrorText(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("cyber_flag") ||
    m.includes("trusted access for cyber") ||
    m.includes("cybersecurity risk") ||
    m.includes("🛡️ защита openai")
  );
}

const DEFAULT_MAX_CONTEXT_TOKENS = 500000;
const DEFAULT_AUTO_COMPACT_TOKENS = 400000;
const ABSOLUTE_MAX_CONTEXT_TOKENS = 2_000_000;
/** @deprecated use DEFAULT_MAX_CONTEXT_TOKENS — kept for older call sites */
const MAX_MODEL_CONTEXT_TOKENS = DEFAULT_MAX_CONTEXT_TOKENS;
app.setName(appName);
app.setPath("userData", path.join(app.getPath("appData"), appUserDataName));
if (process.platform === "win32") {
  app.setAppUserModelId(appUserModelId);
}

/** Persistent crash log next to project + in userData (survives when bat/console closes). */
function appendCrashLog(kind, error) {
  const lines = [
    "",
    `========== ${new Date().toISOString()} [${kind}] ==========`,
    String(error?.stack || error?.message || error),
    "",
  ];
  const text = lines.join("\n");
  console.error(text);
  const targets = [
    path.join(appRootPath, "crash.log"),
    path.join(app.getPath("userData"), "crash.log"),
  ];
  for (const file of targets) {
    fs.promises.appendFile(file, text, "utf8").catch(() => {});
  }
  return targets[0];
}

process.on("uncaughtException", (error) => {
  const logPath = appendCrashLog("uncaughtException", error);
  try {
    dialog.showErrorBox(
      "ComposeVC crash (main process)",
      `${error?.message || error}\n\nSaved to:\n${logPath}\n\n(Also userData/crash.log)`
    );
  } catch {
    /* */
  }
});

process.on("unhandledRejection", (reason) => {
  appendCrashLog("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
});

const ignoredNames = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  "coverage",
]);

const searchableExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".json",
  ".html",
  ".css",
  ".scss",
  ".md",
  ".txt",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".cpp",
  ".c",
  ".cs",
  ".php",
  ".rb",
  ".yaml",
  ".yml",
  ".xml",
  ".sql",
]);

const imageMimeTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

const audioMimeTypes = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/opus",
  ".webm": "audio/webm",
};

function getMediaMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return imageMimeTypes[ext] || audioMimeTypes[ext] || null;
}

const defaultProviderConfig = {
  tokenCountingMode: "provider",
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
    },
  ],
  models: [
    { id: "gpt-4o", name: "gpt-4o", providerId: "openai", contextLimit: MAX_MODEL_CONTEXT_TOKENS },
  ],
  selectedModelId: "gpt-4o",
  telegram: {
    enabled: false,
    botToken: "",
    allowedChatIds: [],
  },
  aiRuntime: {
    agentCompletionNotifications: true,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    autoCompactTokens: DEFAULT_AUTO_COMPACT_TOKENS,
    labInPromptModelId: "",
    labInSearchModelId: "",
    fortaniModelId: "",
    cloudflareAccountId: "",
    cloudflareApiToken: "",
    inlineHintEnabled: false,
    inlineHintModelId: "",
  },
};

function getProviderConfigPath() {
  return path.join(app.getPath("userData"), "providers_config.json");
}

function getProjectTaskPath(rootPath) {
  return path.join(rootPath, ".lopster", "task.json");
}

function normalizeProjectTasks(value) {
  const tasks = Array.isArray(value?.tasks) ? value.tasks : Array.isArray(value) ? value : [];
  return tasks
    .filter((task) => task && typeof task === "object" && typeof task.text === "string" && task.text.trim())
    .map((task) => ({
      id: typeof task.id === "string" && task.id ? task.id : crypto.randomUUID(),
      text: task.text.trim(),
      completed: Boolean(task.completed),
      createdAt: Number.isFinite(task.createdAt) ? task.createdAt : Date.now(),
      updatedAt: Number.isFinite(task.updatedAt) ? task.updatedAt : Date.now(),
    }));
}

async function readProjectTasks(rootPath) {
  if (!rootPath) return [];
  try {
    const raw = await fs.promises.readFile(getProjectTaskPath(rootPath), "utf8");
    return normalizeProjectTasks(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function saveProjectTasks(rootPath, tasks) {
  if (!rootPath) throw new Error("Project folder is required");
  const normalized = normalizeProjectTasks({ tasks });
  const taskPath = getProjectTaskPath(rootPath);
  await fs.promises.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.promises.writeFile(taskPath, JSON.stringify({ tasks: normalized }, null, 2), "utf8");
  return normalized;
}

async function readProviderConfig() {
  const configPath = getProviderConfigPath();
  try {
    const raw = await fs.promises.readFile(configPath, "utf8");
    return normalizeProviderConfig(JSON.parse(raw));
  } catch {
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, JSON.stringify(defaultProviderConfig, null, 2));
    return normalizeProviderConfig(defaultProviderConfig);
  }
}

async function writeProviderConfig(config) {
  const configPath = getProviderConfigPath();
  const normalized = normalizeProviderConfig(config);
  await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
  await fs.promises.writeFile(configPath, JSON.stringify(normalized, null, 2));
  configureTelegramFromProviderConfig(normalized);
  return normalized;
}

function normalizeProviderType(type) {
  return "openai";
}

function isOpenAIProviderType(type) {
  return !type || type === "openai" || type === "openai-compat" || type === "openai-compatible";
}

function normalizeTokenCountingMode(mode) {
  return mode === "auto" ? "auto" : "provider";
}

function clampTokenSetting(value, fallback, { min = 1_000, max = ABSOLUTE_MAX_CONTEXT_TOKENS } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function normalizeAiRuntimeConfig(config) {
  // Context is resolved from the selected model/catalog at request time.
  // Keep legacy fields normalized for old config files, but do not use their values.
  const maxContextTokens = DEFAULT_MAX_CONTEXT_TOKENS;
  const autoCompactTokens = DEFAULT_AUTO_COMPACT_TOKENS;
  const labInPromptModelId =
    typeof config?.labInPromptModelId === "string"
      ? config.labInPromptModelId.trim()
      : typeof config?.lab_in_prompt_model_id === "string"
        ? config.lab_in_prompt_model_id.trim()
        : "";
  const labInSearchModelId =
    typeof config?.labInSearchModelId === "string"
      ? config.labInSearchModelId.trim()
      : typeof config?.lab_in_search_model_id === "string"
        ? config.lab_in_search_model_id.trim()
        : "";
  const fortaniModelId =
    typeof config?.fortaniModelId === "string"
      ? config.fortaniModelId.trim()
      : typeof config?.fortani_model_id === "string"
        ? config.fortani_model_id.trim()
        : "";
  const cloudflareAccountId =
    typeof config?.cloudflareAccountId === "string" ? config.cloudflareAccountId.trim() : "";
  const cloudflareApiToken =
    typeof config?.cloudflareApiToken === "string" ? config.cloudflareApiToken.trim() : "";
  const inlineHintModelId =
    typeof config?.inlineHintModelId === "string"
      ? config.inlineHintModelId.trim()
      : typeof config?.inline_hint_model_id === "string"
        ? config.inline_hint_model_id.trim()
        : "";
  return {
    agentCompletionNotifications: config?.agentCompletionNotifications !== false,
    maxContextTokens,
    autoCompactTokens,
    labInPromptModelId,
    labInSearchModelId,
    fortaniModelId,
    cloudflareAccountId,
    cloudflareApiToken,
    inlineHintEnabled: config?.inlineHintEnabled === true,
    inlineHintModelId,
  };
}

function normalizeContextLimit(value, fallback = DEFAULT_MAX_CONTEXT_TOKENS) {
  // Model metadata is the runtime source when a provider/catalog supplies it.
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return clampTokenSetting(fallback, DEFAULT_MAX_CONTEXT_TOKENS, {
      min: 8_000,
      max: ABSOLUTE_MAX_CONTEXT_TOKENS,
    });
  }
  return clampTokenSetting(numeric, DEFAULT_MAX_CONTEXT_TOKENS, {
    min: 8_000,
    max: ABSOLUTE_MAX_CONTEXT_TOKENS,
  });
}

const MODEL_LIMIT_CACHE = new Map();
const MODEL_LIMIT_CACHE_TTL = 10 * 60 * 1000;
let MODELS_DEV_CACHE = null;
let MODELS_DEV_CACHE_AT = 0;
let MODELS_DEV_LOADING = null;

function modelCatalogUrl(baseUrl) {
  const root = String(baseUrl || "").replace(/\/$/, "").replace(/\/(chat\/completions|responses|messages)$/i, "");
  return root.endsWith("/models") ? root : `${root}${root.endsWith("/v1") ? "" : "/v1"}/models`;
}

function extractModelLimits(row) {
  const limits = row?.limit || row?.limits || row?.capabilities?.limits || {};
  const context =
    row?.context_length ?? row?.context_window ?? row?.contextWindow ?? row?.max_context_length ??
    row?.maxContextLength ?? row?.max_tokens ?? row?.maxTokens ?? row?.input_token_limit ??
    row?.inputTokenLimit ?? row?.input_tokens ?? limits.context ?? limits.input ?? limits.max_tokens;
  const output =
    row?.max_output_tokens ?? row?.maxOutputTokens ?? row?.output_token_limit ?? row?.outputTokenLimit ??
    row?.output_tokens ?? limits.output ?? limits.max_output_tokens;
  const contextNumber = Number(context);
  const outputNumber = Number(output);
  return {
    context: Number.isFinite(contextNumber) && contextNumber > 0 ? contextNumber : null,
    output: Number.isFinite(outputNumber) && outputNumber > 0 ? outputNumber : null,
  };
}

function modelIdCandidates(model) {
  const raw = String(model?.name || model?.id || "").trim();
  if (!raw) return [];
  const candidates = new Set([raw]);
  let bare = raw;
  try {
    const { bareModelId } = require("./proxy/modelValidate.cjs");
    bare = bareModelId(raw) || raw;
  } catch {
    bare = raw;
  }
  candidates.add(bare);
  const parts = bare.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) candidates.add(parts.slice(index).join("/"));
  return [...candidates].filter(Boolean);
}

function modelCatalogProviderKeys(provider, model) {
  const names = [provider?.id, provider?.name, String(provider?.baseUrl || "").match(/https?:\/\/([^/]+)/i)?.[1]];
  const modelParts = String(model?.name || "").split("/").filter(Boolean);
  if (modelParts.length > 1) names.push(...modelParts.slice(0, -1));
  return [...new Set(
    names
      .filter(Boolean)
      .flatMap((value) => {
        const raw = String(value).trim();
        const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        return [raw, raw.toLowerCase(), normalized];
      })
  )];
}

function findCatalogModelRow(rows, model) {
  const list = Array.isArray(rows) ? rows : [];
  const candidates = modelIdCandidates(model).map((value) => value.toLowerCase());
  for (const candidate of candidates) {
    const exact = list.find((item) => String(item?.id || item?.name || item?.model || "").toLowerCase() === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const suffix = list.find((item) => {
      const id = String(item?.id || item?.name || item?.model || "").toLowerCase();
      return id.endsWith(`/${candidate}`) || candidate.endsWith(`/${id}`);
    });
    if (suffix) return suffix;
  }
  return null;
}

async function loadModelsDevCatalog() {
  if (MODELS_DEV_CACHE && Date.now() - MODELS_DEV_CACHE_AT <= 60 * 60 * 1000) return MODELS_DEV_CACHE;
  if (!MODELS_DEV_LOADING) {
    MODELS_DEV_LOADING = fetch("https://models.dev/api.json", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((catalog) => {
        if (catalog && typeof catalog === "object") {
          MODELS_DEV_CACHE = catalog;
          MODELS_DEV_CACHE_AT = Date.now();
        }
        return MODELS_DEV_CACHE;
      })
      .catch(() => MODELS_DEV_CACHE)
      .finally(() => {
        MODELS_DEV_LOADING = null;
      });
  }
  return MODELS_DEV_LOADING;
}

async function modelsDevLimits(provider, model) {
  try {
    const catalog = (await loadModelsDevCatalog()) || {};
    const candidates = modelIdCandidates(model);
    const providerKeys = modelCatalogProviderKeys(provider, model);
    const findLimits = (rows) => {
      if (!rows || typeof rows !== "object") return { context: null, output: null };
      for (const candidate of candidates) {
        const key = Object.keys(rows).find((value) => value.toLowerCase() === candidate.toLowerCase());
        const limits = extractModelLimits(key ? rows[key] : null);
        if (limits.context || limits.output) return limits;
      }
      return { context: null, output: null };
    };
    for (const key of providerKeys) {
      const limits = findLimits(catalog[key]?.models);
      if (limits.context || limits.output) return limits;
    }
    for (const entry of Object.values(catalog)) {
      const limits = findLimits(entry?.models);
      if (limits.context || limits.output) return limits;
    }
  } catch {
    // Public metadata is optional; caller keeps the safe model fallback.
  }
  return { context: null, output: null };
}

async function resolveAutomaticModelLimits(model, provider) {
  const fallback = normalizeContextLimit(model.contextLimit, DEFAULT_MAX_CONTEXT_TOKENS);
  const key = `${provider.id}|${provider.baseUrl}|${model.id}|${model.name || ""}`;
  const cached = MODEL_LIMIT_CACHE.get(key);
  if (cached && Date.now() - cached.at < MODEL_LIMIT_CACHE_TTL) {
    return { context: cached.context || fallback, output: cached.output || null };
  }

  const publicCatalogPromise = modelsDevLimits(provider, model);
  let endpointLimits = { context: null, output: null };
  try {
    const response = await fetch(modelCatalogUrl(provider.baseUrl), {
      headers: { Accept: "application/json", Authorization: `Bearer ${provider.apiKey || ""}` },
      signal: AbortSignal.timeout(2500),
    });
    if (response.ok) {
      const payload = await response.json();
      const rows = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : Array.isArray(payload)
            ? payload
            : [];
      endpointLimits = extractModelLimits(findCatalogModelRow(rows, model));
    }
  } catch {
    // The local proxy's /models can be unavailable or slow. The public catalog stays independent.
  }

  const publicLimits = await publicCatalogPromise;
  const limits = {
    context: endpointLimits.context || publicLimits.context || null,
    output: endpointLimits.output || publicLimits.output || null,
  };
  MODEL_LIMIT_CACHE.set(key, { ...limits, at: Date.now() });
  return { context: limits.context || fallback, output: limits.output || null };
}

function normalizeProviderConfig(config) {
  if (!config || typeof config !== "object") return defaultProviderConfig;
  const aiRuntime = normalizeAiRuntimeConfig(config.aiRuntime || config.ai_runtime);

  if (Array.isArray(config.providers)) {
    const providers = config.providers
      .filter((provider) => isOpenAIProviderType(provider?.type))
      .map((provider) => ({
        ...provider,
        type: normalizeProviderType(provider.type),
        baseUrl: provider.baseUrl || provider.base_url || "",
        apiKey: provider.apiKey || provider.api_key || "",
      }));
    const providerIds = new Set(providers.map((provider) => provider.id));
    const models = Array.isArray(config.models)
      ? config.models
          .filter((model) => providerIds.has(model.providerId))
          .map((model) => ({
            ...model,
            name: model.name || model.id,
            contextLimit: normalizeContextLimit(model.contextLimit || model.context_limit, aiRuntime.maxContextTokens),
          }))
      : [];
    if (providers.length === 0 || models.length === 0) return defaultProviderConfig;
    const selectedModelId = models.some((model) => model.id === config.selectedModelId)
      ? config.selectedModelId
      : models[0]?.id || defaultProviderConfig.selectedModelId;
    return {
      providers,
      models,
      selectedModelId,
      tokenCountingMode: normalizeTokenCountingMode(config.tokenCountingMode),
      telegram: normalizeTelegramConfig(config.telegram),
      aiRuntime,
    };
  }

  const providers = [];
  const models = [];
  for (const [providerId, provider] of Object.entries(config.providers || {})) {
    if (!provider || typeof provider !== "object") continue;
    if (!isOpenAIProviderType(provider.type)) continue;
    providers.push({
      id: providerId,
      name: provider.name || providerId,
      type: normalizeProviderType(provider.type),
      baseUrl: provider.baseUrl || provider.base_url || "",
      apiKey: provider.apiKey || provider.api_key || "",
    });
    for (const model of provider.models || []) {
      if (!model || typeof model !== "object") continue;
      models.push({
        id: model.id || model.name,
        name: model.id || model.name,
        providerId,
        contextLimit: normalizeContextLimit(
          model.contextLimit || model.context_limit || provider.contextLimit || provider.context_limit,
          aiRuntime.maxContextTokens
        ),
      });
    }
  }

  return {
    providers: providers.length ? providers : defaultProviderConfig.providers,
    models: models.length ? models : defaultProviderConfig.models,
    selectedModelId: config.selectedModelId || config.selected_model_id || models[0]?.id || defaultProviderConfig.selectedModelId,
    tokenCountingMode: normalizeTokenCountingMode(config.tokenCountingMode || config.token_counting_mode),
    telegram: normalizeTelegramConfig(config.telegram),
    aiRuntime,
  };
}

function getLanguage(filePath) {
  const mediaMimeType = getMediaMimeType(filePath);
  if (mediaMimeType?.startsWith("image/")) return "image";
  if (mediaMimeType?.startsWith("audio/")) return "audio";
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const map = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    php: "php",
    rb: "ruby",
    yaml: "yaml",
    yml: "yaml",
    xml: "xml",
    sql: "sql",
  };
  return map[ext] || "plaintext";
}

async function buildTree(rootPath, currentPath = rootPath, depth = 0) {
  const stat = await fs.promises.stat(currentPath);
  const name = path.basename(currentPath);
  const node = {
    id: currentPath,
    name,
    path: currentPath,
    type: stat.isDirectory() ? "folder" : "file",
  };

  if (stat.isDirectory()) {
    if (depth > 5) {
      node.children = [];
      return node;
    }

    let dirents;
    try {
      dirents = await fs.promises.readdir(currentPath, { withFileTypes: true });
    } catch {
      node.children = [];
      return node;
    }

    const entries = dirents
      .filter((entry) => !ignoredNames.has(entry.name) && !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, 250);

    node.children = await Promise.all(
      entries.map((entry) => buildTree(rootPath, path.join(currentPath, entry.name), depth + 1))
    );
  } else {
    node.language = getLanguage(currentPath);
  }

  return node;
}

function fuzzyScore(value, query) {
  const source = value.toLowerCase();
  const target = query.toLowerCase();
  if (!target) return 1;
  if (source.includes(target)) return 100 + target.length / Math.max(source.length, 1);

  let score = 0;
  let targetIndex = 0;
  let streak = 0;

  for (let i = 0; i < source.length && targetIndex < target.length; i += 1) {
    if (source[i] === target[targetIndex]) {
      streak += 1;
      score += 3 + streak;
      targetIndex += 1;
    } else {
      streak = 0;
    }
  }

  return targetIndex === target.length ? score - source.length * 0.01 : 0;
}

async function collectFiles(rootPath, currentPath = rootPath, depth = 0, files = []) {
  if (depth > 10 || files.length > 1500) return files;

  const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredNames.has(entry.name) || entry.name.startsWith(".")) continue;

    const entryPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootPath, entryPath, depth + 1, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function searchProject(rootPath, query) {
  if (!rootPath) return [];

  const normalizedQuery = query.trim().toLowerCase();
  const files = await collectFiles(rootPath);
  const results = [];

  for (const filePath of files) {
    const relativePath = path.relative(rootPath, filePath);
    const name = path.basename(filePath);
    const pathScore = fuzzyScore(relativePath, normalizedQuery);

    if (!normalizedQuery || pathScore > 0) {
      results.push({
        id: `${filePath}:file`,
        type: "file",
        name,
        path: filePath,
        relativePath,
        line: 0,
        preview: relativePath,
        score: pathScore,
      });
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!normalizedQuery || !searchableExtensions.has(ext)) continue;

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 1024 * 1024) continue;

      const content = await fs.promises.readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const lineIndex = line.toLowerCase().indexOf(normalizedQuery);
        if (lineIndex === -1) continue;

        results.push({
          id: `${filePath}:${index + 1}:${lineIndex}`,
          type: "content",
          name,
          path: filePath,
          relativePath,
          line: index + 1,
          preview: line.trim().slice(0, 180),
          score: 200 + normalizedQuery.length - Math.min(index, 50) * 0.1,
        });

        if (results.length > 250) break;
      }
    } catch {
      continue;
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
    .slice(0, 80);
}

/**
 * Windows taskbar / alt-tab need a real multi-resolution .ico path when possible.
 * nativeImage from a single-size ico often looks blank/blurry in the taskbar when
 * launching unpackaged `electron .` via start.bat.
 */
let cachedIconPath = null;
function getAppIconPath() {
  if (cachedIconPath) return cachedIconPath;
  try {
    if (fs.existsSync(appIconIcoPath)) {
      cachedIconPath = appIconIcoPath;
      return cachedIconPath;
    }
  } catch {
    /* ignore */
  }
  try {
    if (fs.existsSync(appIconPngPath)) {
      cachedIconPath = appIconPngPath;
      return cachedIconPath;
    }
  } catch {
    /* ignore */
  }
  // Fallback: logo/Compose.jpg directly
  try {
    const jpgFallback = path.join(__dirname, "..", "logo", "Compose.jpg");
    if (fs.existsSync(jpgFallback)) {
      cachedIconPath = jpgFallback;
      return cachedIconPath;
    }
  } catch {
    /* ignore */
  }
  cachedIconPath = null;
  return null;
}

let cachedAppIcon = null;
function getAppIcon() {
  if (cachedAppIcon) return cachedAppIcon;
  // Try all icon candidates in order: PNG → ICO → JPG
  const candidates = [
    appIconPngPath,
    appIconIcoPath,
    path.join(__dirname, "..", "logo", "Compose.jpg"),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        cachedAppIcon = img.resize({ width: 256, height: 256 });
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!cachedAppIcon) cachedAppIcon = nativeImage.createEmpty();
  return cachedAppIcon;
}

/** Force-set the app icon on a window using nativeImage (more reliable than path string on Windows). */
function forceWindowIcon(win) {
  const img = getAppIcon();
  if (!img.isEmpty()) {
    try { win.setIcon(img); } catch { /* */ }
  }
}

const DEFAULT_DEV_SERVER_URL = "http://localhost:3004";

function isDevServerReachable(url, timeoutMs = 350) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const target = new URL(url);
      const lib = target.protocol === "https:" ? require("https") : require("http");
      const req = lib.get(
        {
          hostname: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: target.pathname || "/",
          timeout: timeoutMs,
        },
        (res) => {
          res.resume();
          finish(true);
        }
      );
      req.on("timeout", () => {
        req.destroy();
        finish(false);
      });
      req.on("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

let cachedDistHtmlPath = null;
function resolveDistIndexHtml() {
  if (cachedDistHtmlPath) return cachedDistHtmlPath;
  const candidates = [
    path.join(__dirname, "..", "dist", "index.html"),
    path.join(appRootPath, "dist", "index.html"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        cachedDistHtmlPath = p;
        return p;
      }
    } catch {
      /* ignore */
    }
  }
  cachedDistHtmlPath = candidates[0];
  return candidates[0];
}

async function resolveRendererEntry() {
  if (app.isPackaged || process.env.LOPSTER_FORCE_DIST === "1") {
    return { type: "file", path: resolveDistIndexHtml() };
  }

  const envUrl = String(process.env.LOPSTER_DEV_SERVER || process.env.VITE_DEV_SERVER_URL || "").trim();
  // Only auto-detect default Vite when explicitly in a dev launch; otherwise prefer dist.
  const preferDev =
    process.env.LOPSTER_DEV_MODE === "1" ||
    Boolean(envUrl) ||
    process.env.npm_lifecycle_event === "dev:app";
  const candidates = preferDev
    ? [...new Set([envUrl, DEFAULT_DEV_SERVER_URL].filter(Boolean))]
    : envUrl
      ? [envUrl]
      : [];

  for (const url of candidates) {
    if (await isDevServerReachable(url)) {
      return { type: "url", url };
    }
  }

  return { type: "file", path: resolveDistIndexHtml() };
}

async function loadWindowContent(win, options = {}) {
  const entry = await resolveRendererEntry();
  const query = options.query || null;
  if (entry.type === "url") {
    let url = entry.url;
    if (query && typeof query === "object") {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value != null) qs.set(key, String(value));
      }
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    console.log(`[dev] loading renderer from ${url}`);
    await win.loadURL(url);
    // Re-apply icon after content loads (taskbar reliability on Windows)
    forceWindowIcon(win);
    return;
  }

  await win.loadFile(entry.path, query && typeof query === "object" ? { query } : undefined);
  // Re-apply icon after page load
  forceWindowIcon(win);
}

/** Block DevTools, inspect, and view-source shortcuts. */
function installPackagedWindowHardening(win) {
  const wc = win.webContents;

  // Physical key code → workspace tab, for the Ctrl/Cmd+1…9 panel shortcuts.
  const PANEL_BY_DIGIT = {
    Digit1: "multiide",
    Digit2: "webengine",
    Digit3: "proxy",
    Digit4: "runner",
    Digit5: "terminal",
    Digit6: "customtools",
    Digit7: "knowledge",
    Digit8: "docs",
    Digit9: "usage",
    Digit0: "plugins",
  };

  // In-app guests are allowed for the aside media dock only, and only on plain
  // http(s). Whatever the markup asks for, the guest gets no preload and no
  // node access — it stays a sandboxed page, never a bridge into the app.
  wc.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.devTools = false;

    const src = String(params?.src || "");
    // An empty src is the not-yet-navigated guest — the dock sets it right after.
    if (src && !/^https?:\/\//i.test(src) && !/^about:blank$/i.test(src)) {
      event.preventDefault();
    }
  });

  // A guest player going fullscreen must NOT drag the app window with it — the
  // dock expands inside its own column instead (see .aside-web.is-expanded).
  const keepWindowed = () => {
    try {
      if (!win.isDestroyed() && win.isFullScreen()) win.setFullScreen(false);
    } catch {
      /* ignore */
    }
  };
  wc.on("enter-html-full-screen", keepWindowed);

  // Popups from a guest page ("open in new tab", player overlays) load in the
  // same view instead of spawning an unhardened window.
  wc.on("did-attach-webview", (_event, guest) => {
    try {
      guest.on("enter-html-full-screen", keepWindowed);
    } catch {
      /* ignore */
    }

    // While a guest page has focus (a video playing over the rail) it owns the
    // keyboard, so the app's own shortcuts never reach the renderer. Forward
    // the ones the shell needs: Ctrl+H → chat switcher, Ctrl+Shift+W → fold,
    // plus the workspace tab / search / settings hotkeys below.
    try {
      guest.on("before-input-event", (event, input) => {
        if (!input || input.type !== "keyDown") return;
        const ctrl = Boolean(input.control || input.meta);
        if (!ctrl || input.alt) return;
        const code = String(input.code || "");
        const shift = Boolean(input.shift);
        let channel = null;
        let hotkey = null;
        if (code === "KeyH" && !shift) channel = "chat:switcher-toggle";
        else if (code === "KeyW" && shift) channel = "web:dock-fold";
        else if (code === "KeyF" && shift) hotkey = { type: "toggle", target: "search" };
        else if (code === "KeyP" && shift) hotkey = { type: "toggle", target: "prompts" };
        else if (!shift) {
          if (Object.prototype.hasOwnProperty.call(PANEL_BY_DIGIT, code)) {
            hotkey = { type: "panel", panel: PANEL_BY_DIGIT[code] };
          } else if (code === "Backquote") {
            hotkey = { type: "panel", panel: "terminal" };
          } else if (code === "Comma") {
            hotkey = { type: "toggle", target: "settings" };
          }
        }
        if (!channel && !hotkey) return;
        event.preventDefault();
        try {
          if (wc.isDestroyed()) return;
          if (channel) wc.send(channel, {});
          if (hotkey) wc.send("shell:hotkey", hotkey);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    try {
      guest.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(String(url || ""))) {
          // Out of the handler's synchronous frame before navigating.
          setImmediate(() => {
            try {
              if (!guest.isDestroyed()) void guest.loadURL(url);
            } catch {
              /* ignore */
            }
          });
        }
        return { action: "deny" };
      });
    } catch {
      /* ignore */
    }
  });

  // Keep DevTools closed.
  try {
    wc.closeDevTools();
  } catch {
    /* ignore */
  }
  wc.on("devtools-opened", () => {
    try {
      wc.closeDevTools();
    } catch {
      /* ignore */
    }
  });

  wc.on("before-input-event", (event, input) => {
    if (!input) return;
    const key = String(input.key || "");
    const code = String(input.code || "");
    const ctrl = Boolean(input.control || input.meta);
    const shift = Boolean(input.shift);
    const alt = Boolean(input.alt);
    // Ctrl+R → Runner send modal (stops Electron default reload accelerator).
    if (ctrl && !shift && !alt && code === "KeyR") {
      event.preventDefault();
      try {
        if (!wc.isDestroyed()) {
          wc.send("runner:open-send", {});
        }
      } catch {
        /* ignore */
      }
      return;
    }
    if (ctrl && !shift && !alt && code === "KeyT") {
      event.preventDefault();
      try { if (!wc.isDestroyed()) wc.send("storage:open", {}); } catch {}
      return;
    }
    // Workspace hotkeys: Ctrl/Cmd+1…9 (tabs), Ctrl+Shift+F (search files),
    // Ctrl+, (settings), Ctrl+` (terminal). Handled here so they keep working
    // while the terminal or a webview guest owns the keyboard.
    if (ctrl && !shift && !alt) {
      let payload = null;
      if (Object.prototype.hasOwnProperty.call(PANEL_BY_DIGIT, code)) {
        payload = { type: "panel", panel: PANEL_BY_DIGIT[code] };
      } else if (code === "Backquote") {
        payload = { type: "panel", panel: "terminal" };
      } else if (code === "Comma") {
        payload = { type: "toggle", target: "settings" };
      }
      if (payload) {
        event.preventDefault();
        try { if (!wc.isDestroyed()) wc.send("shell:hotkey", payload); } catch {}
        return;
      }
    }
    // Ctrl+Shift+F is a separate chord (Shift is part of it); kept off Ctrl+P so
    // the terminal keeps its readline "previous command" binding.
    if (ctrl && shift && !alt && code === "KeyF") {
      event.preventDefault();
      try { if (!wc.isDestroyed()) wc.send("shell:hotkey", { type: "toggle", target: "search" }); } catch {}
      return;
    }
    // Ctrl+Shift+P → prompt copy modal (prompt palette). Ctrl+Shift+P is unused
    // elsewhere, so it never clashes with the terminal/DevTools blocks above.
    if (ctrl && shift && !alt && code === "KeyP") {
      event.preventDefault();
      try { if (!wc.isDestroyed()) wc.send("shell:hotkey", { type: "toggle", target: "prompts" }); } catch {}
      return;
    }
    // F12, Ctrl+Shift+I/J/C, Ctrl+Shift+U, Ctrl+U (view source)
    const block =
      key === "F12" ||
      code === "F12" ||
      (ctrl && shift && ["I", "J", "C", "K", "U"].includes(key.toUpperCase())) ||
      (ctrl && !shift && !alt && key.toUpperCase() === "U");
    if (block) {
      event.preventDefault();
    }
  });

  // Block navigation to chrome:// / devtools:// and unexpected window.open
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, url) => {
    const u = String(url || "");
    if (/^devtools:/i.test(u) || /^chrome-devtools:/i.test(u) || /^chrome:/i.test(u)) {
      event.preventDefault();
    }
  });
}

function createWindow(options = {}) {
  const appIconImage = getAppIcon();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#000000",
    title: appName,
    frame: false,
    show: false,
    icon: !appIconImage.isEmpty() ? appIconImage : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      devTools: false,
      spellcheck: false,
    },
  });

  // Always force-set via nativeImage (most reliable on Windows)
  forceWindowIcon(win);

  installPackagedWindowHardening(win);

  win.lopsterWindowId = options.windowId || crypto.randomUUID();
  mainWindow = win;
  win.on("focus", () => {
    mainWindow = win;
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed()) || null;
  });
  let revealed = false;
  const reveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    if (!win.isMaximized()) win.maximize();
    win.show();
  };
  if (!win.isDestroyed() && !win.isMaximized()) win.maximize();
  if (options.intro) {
    win.__introPending = true;
    const revealTimer = setTimeout(reveal, 500);
    win.once("closed", () => clearTimeout(revealTimer));
    void win.loadFile(path.join(__dirname, "splash.html"));
  } else {
    win.once("ready-to-show", reveal);
    void loadWindowContent(win, options);
  }
  return win;
}

ipcMain.on("intro:ready", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.__introPending) return;
  if (!win.isMaximized()) win.maximize();
  if (!win.isVisible()) win.show();
});

ipcMain.on("intro:finished", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || !win.__introPending) return;
  win.__introPending = false;
  void loadWindowContent(win);
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.handle("window:toggleMaximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// ── Git for the chat shell ────────────────────────────────────────────────
// Read-only snapshots for the rail badge plus the four safe actions the
// popover offers. Anything history-rewriting stays out of here on purpose;
// the agent's `git` tool refuses those too.
const GIT_UI_ACTIONS = new Set(["fetch", "pull", "push", "checkout"]);

ipcMain.handle("git:status", async (_event, rootPath) => {
  try {
    return await gitService.getStatus(rootPath || null);
  } catch (error) {
    return { isRepo: false, reason: "error", error: String(error?.message || error) };
  }
});

ipcMain.handle("git:details", async (_event, rootPath, options = {}) => {
  try {
    if (!rootPath || !(await gitService.isRepo(rootPath))) return { ok: false, error: "not-a-repo" };
    const limit = Math.max(10, Math.min(200, Number(options?.limit) || 60));
    const [branches, files, graph, total] = await Promise.all([
      gitService.listBranches(rootPath),
      gitService.listChangedFiles(rootPath, 120),
      gitService.graphLog(rootPath, limit),
      gitService.commitCount(rootPath),
    ]);
    return { ok: true, branches, files, graph, totalCommits: total, shown: graph.length };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

/**
 * Stage everything and commit it, with the guards an unattended commit needs:
 * never commit into a conflict or a half-finished merge/rebase, and never turn
 * a missing .gitignore into a thousand-file commit.
 */
const AUTOCOMMIT_MAX_FILES = 400;

ipcMain.handle("git:autocommit", async (_event, rootPath, options = {}) => {
  try {
    if (!rootPath || !(await gitService.isRepo(rootPath))) {
      return { ok: false, committed: false, reason: "not-a-repo" };
    }

    // A commit in the middle of a merge/rebase would silently finish it.
    const gitDir = await gitService.execGit(["rev-parse", "--git-dir"], rootPath, { timeout: 5000 });
    if (gitDir.ok) {
      const dir = path.resolve(rootPath, gitDir.stdout);
      const busy = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
      for (const marker of busy) {
        if (fs.existsSync(path.join(dir, marker))) {
          return { ok: true, committed: false, reason: "merge-in-progress" };
        }
      }
    }

    const before = await gitService.getStatus(rootPath);
    if (!before.isRepo) return { ok: false, committed: false, reason: "not-a-repo" };
    if (before.conflicted > 0) return { ok: true, committed: false, reason: "conflicts" };

    const changed = before.staged + before.modified + before.untracked;
    if (changed === 0) return { ok: true, committed: false, reason: "clean" };
    if (changed > AUTOCOMMIT_MAX_FILES) {
      return { ok: true, committed: false, reason: "too-many", files: changed };
    }

    const add = await gitService.execGit(["add", "-A"], rootPath, { timeout: 30000 });
    if (!add.ok) return { ok: false, committed: false, reason: "add-failed", error: add.stderr || add.error };

    // Everything may have been ignored — nothing to commit after staging.
    const staged = await gitService.execGit(["diff", "--cached", "--name-only"], rootPath, { timeout: 15000 });
    const stagedFiles = staged.ok ? staged.stdout.split("\n").filter(Boolean) : [];
    if (stagedFiles.length === 0) return { ok: true, committed: false, reason: "nothing-staged" };

    const summary = [
      before.modified ? `${before.modified} modified` : null,
      before.untracked ? `${before.untracked} new` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const prefix = String(options?.prefix || "auto").trim() || "auto";
    const message = `${prefix}: ${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}${summary ? ` (${summary})` : ""}`;

    const commit = await gitService.execGit(["commit", "-m", message], rootPath, { timeout: 60000 });
    if (!commit.ok) {
      return {
        ok: false,
        committed: false,
        reason: "commit-failed",
        error: [commit.stdout, commit.stderr].filter(Boolean).join("\n").slice(0, 400),
      };
    }

    const head = await gitService.execGit(["rev-parse", "--short", "HEAD"], rootPath, { timeout: 5000 });
    return {
      ok: true,
      committed: true,
      hash: head.ok ? head.stdout : null,
      message,
      files: stagedFiles.length,
    };
  } catch (error) {
    return { ok: false, committed: false, reason: "error", error: String(error?.message || error) };
  }
});

/**
 * Push the commits this branch is ahead by — nothing else.
 *
 * `git push` only ever sends commits the remote does not have, so files that
 * were already pushed are never re-sent. Never forces: if the branch is behind
 * the push would be rejected anyway, so it is skipped with a reason instead of
 * failing every few seconds.
 */
ipcMain.handle("git:autopush", async (_event, rootPath) => {
  try {
    if (!rootPath || !(await gitService.isRepo(rootPath))) {
      return { ok: false, pushed: false, reason: "not-a-repo" };
    }

    const status = await gitService.getStatus(rootPath);
    if (!status.isRepo) return { ok: false, pushed: false, reason: "not-a-repo" };
    if (status.detached || !status.branch) return { ok: true, pushed: false, reason: "detached" };
    if (status.ahead === 0) return { ok: true, pushed: false, reason: "nothing-to-push" };
    if (status.behind > 0) return { ok: true, pushed: false, reason: "behind", behind: status.behind };

    const args = status.upstream
      ? ["push"]
      : ["push", "--set-upstream", "origin", status.branch];

    const res = await gitService.execGit(args, rootPath, { timeout: 120000 });
    if (!res.ok) {
      return {
        ok: false,
        pushed: false,
        reason: "push-failed",
        error: [res.stdout, res.stderr].filter(Boolean).join("\n").slice(0, 400),
      };
    }
    return {
      ok: true,
      pushed: true,
      commits: status.ahead,
      branch: status.branch,
      output: [res.stdout, res.stderr].filter(Boolean).join("\n").slice(0, 400),
    };
  } catch (error) {
    return { ok: false, pushed: false, reason: "error", error: String(error?.message || error) };
  }
});

ipcMain.handle("git:action", async (_event, rootPath, action, payload = {}) => {
  try {
    if (!GIT_UI_ACTIONS.has(action)) return { ok: false, error: `Unsupported action: ${action}` };
    if (!rootPath || !(await gitService.isRepo(rootPath))) return { ok: false, error: "not-a-repo" };

    let args;
    if (action === "checkout") {
      const branch = String(payload?.branch || "").trim();
      if (!branch) return { ok: false, error: "branch is required" };
      args = ["checkout", branch];
    } else if (action === "push") {
      args = ["push"];
    } else {
      args = [action];
    }

    const destructive = gitService.findDestructive(args);
    if (destructive) return { ok: false, error: `Refused: ${destructive}` };

    const res = await gitService.execGit(args, rootPath, { timeout: 60000 });
    return {
      ok: res.ok,
      output: [res.stdout, res.stderr].filter(Boolean).join("\n").trim(),
      error: res.ok ? null : res.error || `git exited with code ${res.code}`,
    };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// Detached movable popup windows: Proxy workspace sub-views (Usage / Settings).
// One popup per view — reopening focuses the existing window.
const proxyPopupWindows = new Map(); // "usage" | "settings" -> BrowserWindow

function createProxySubviewWindow(view) {
  const existing = proxyPopupWindows.get(view);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  const appIconImage = getAppIcon();
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#000000",
    title: `${appName} · Proxy ${view === "settings" ? "Settings" : "Usage"}`,
    frame: false,
    icon: !appIconImage.isEmpty() ? appIconImage : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: true,
      devTools: false,
      spellcheck: false,
    },
  });
  forceWindowIcon(win);
  installPackagedWindowHardening(win);
  win.lopsterProxyPopupView = view;
  proxyPopupWindows.set(view, win);
  win.on("closed", () => {
    if (proxyPopupWindows.get(view) === win) proxyPopupWindows.delete(view);
  });
  void loadWindowContent(win, { query: { proxyPopup: view } });
  return win;
}

ipcMain.handle("proxy:openSubview", (event, view) => {
  const v = view === "settings" ? "settings" : view === "usage" ? "usage" : null;
  if (!v) return { ok: false, error: "invalid view" };
  try {
    createProxySubviewWindow(v);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("sizeworkout:snapshot", async (_event, workspaceId) => {
  return { ok: true, workspaces: sizeworkout.snapshot(workspaceId || null) };
});

ipcMain.handle("sizeworkout:update", async (_event, input = {}) => {
  const workspace = sizeworkout.update(input);
  return { ok: true, workspace };
});

ipcMain.handle("sizeworkout:reset", async (_event, workspaceId) => {
  return { ok: true, workspace: sizeworkout.reset(workspaceId || "default") };
});

ipcMain.handle("workerPool:stats", async () => {
  return { ok: true, stats: workerPool.stats() };
});

ipcMain.handle("system:getMetrics", async () => {
  try {
    const mem = process.memoryUsage();
    let appMetrics = [];
    try {
      appMetrics = typeof app.getAppMetrics === "function" ? app.getAppMetrics() : [];
    } catch {
      appMetrics = [];
    }
    const workingSet = Array.isArray(appMetrics)
      ? appMetrics.reduce((sum, m) => {
          const kb = Number(m?.memory?.workingSetSize) || 0;
          return sum + kb;
        }, 0)
      : 0;
    return {
      ok: true,
      rss: mem.rss || 0,
      heapUsed: mem.heapUsed || 0,
      heapTotal: mem.heapTotal || 0,
      external: mem.external || 0,
      workingSetBytes: workingSet > 0 ? workingSet * 1024 : mem.rss || 0,
      uptimeSec: Math.floor(process.uptime()),
      totalRuntimeSec: currentTotalRuntimeSec(),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("usage:getSnapshot", async () => {
  try {
    return {
      ok: true,
      usage: usageStore.snapshot(),
      runtime: {
        totalRuntimeSec: currentTotalRuntimeSec(),
        uptimeSec: Math.floor(process.uptime()),
        sessions: runtimeSessions + (runtimeQuitSaved ? 0 : 1),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || appRootPath,
      env: options.env || process.env,
      stdio: options.stdio || "inherit",
      shell: options.shell === true || process.platform === "win32",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function rebuildRendererForFreshInstance() {
  if (app.isPackaged) return { rebuilt: false, reason: "packaged" };

  // Same as `npm run app` frontend step — vite only (skip tsc so type errors don't block preview).
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  console.log("[new-window] rebuilding renderer (vite build) for a fresh app instance...");
  await runCommand(npxCmd, ["vite", "build"], {
    cwd: appRootPath,
    env: {
      ...process.env,
      // Force production-like dist so the new process loads fresh files, not Vite HMR.
      NODE_ENV: "production",
    },
  });
  console.log("[new-window] renderer rebuild complete");
  return { rebuilt: true };
}

async function copyUserDataFile(parentUserData, childUserData, relativePath) {
  const src = path.join(parentUserData, relativePath);
  const dest = path.join(childUserData, relativePath);
  try {
    await fs.promises.access(src);
  } catch {
    return false;
  }
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(src, dest);
  return true;
}

async function copyProxyConfigToChild(parentUserData, childUserData) {
  // Prefer loading via proxy store API so accounts/keys/routes/tokens all transfer.
  const proxyStore = require("./proxy/store.cjs");
  try {
    const parentStore = await proxyStore.load(parentUserData);
    const accountCount = Array.isArray(parentStore.accounts) ? parentStore.accounts.length : 0;
    const keyCount = Array.isArray(parentStore.keys) ? parentStore.keys.length : 0;
    console.log(
      `[new-window] copying proxy store from ${parentUserData} → ${childUserData} (accounts=${accountCount}, keys=${keyCount})`
    );

    // Keep credentials/accounts, but don't auto-bind the child to the parent's listening proxy.
    const childStore = {
      ...parentStore,
      enabled: false,
      autoStart: false,
      updatedAt: Date.now(),
    };
    await proxyStore.save(childUserData, childStore);

    // Verify accounts landed on disk (empty child stores were the previous bug report).
    const verify = await proxyStore.load(childUserData);
    const verifyAccounts = Array.isArray(verify.accounts) ? verify.accounts.length : 0;
    if (accountCount > 0 && verifyAccounts === 0) {
      throw new Error(
        `proxy accounts failed to copy (source had ${accountCount}, dest has ${verifyAccounts})`
      );
    }
    console.log(`[new-window] proxy store ready in child (accounts=${verifyAccounts})`);
    return { copied: true, accounts: verifyAccounts, keys: keyCount };
  } catch (error) {
    console.error("[new-window] proxy store API copy failed, trying raw file copy:", error?.message || error);
  }

  // Fallback: raw file copy of proxy/store.json
  const relative = path.join("proxy", "store.json");
  const copied = await copyUserDataFile(parentUserData, childUserData, relative);
  if (!copied) {
    console.warn("[new-window] no proxy store found at", path.join(parentUserData, relative));
    return { copied: false, accounts: 0 };
  }
  try {
    const dest = path.join(childUserData, relative);
    const raw = await fs.promises.readFile(dest, "utf8");
    const store = JSON.parse(raw);
    store.enabled = false;
    store.autoStart = false;
    store.updatedAt = Date.now();
    await fs.promises.writeFile(dest, JSON.stringify(store, null, 2), "utf8");
    return {
      copied: true,
      accounts: Array.isArray(store.accounts) ? store.accounts.length : 0,
      keys: Array.isArray(store.keys) ? store.keys.length : 0,
    };
  } catch (error) {
    console.warn("[new-window] proxy store tweak failed:", error?.message || error);
    return { copied: true, accounts: null };
  }
}

// Runtime companion is a fully separate Electron app:
// electron/runtimeMain.cjs · npm run runtime · start-runtime.bat

ipcMain.handle("window:new", async () => {
  // Launch a real separate app process (own userData) with current provider + proxy configs.
  // In dev, rebuild dist first so the new instance shows the latest UI without relying on HMR.
  try {
    await rebuildRendererForFreshInstance();
  } catch (error) {
    console.error("[new-window] rebuild failed:", error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  }

  const instanceId = crypto.randomUUID().slice(0, 8);
  const parentUserDataPath = app.getPath("userData");
  const childUserDataName = `${appUserDataBaseName}-${instanceId}`;
  const childUserDataPath = path.join(app.getPath("appData"), childUserDataName);
  const inheritedConfig = await readProviderConfig();
  const childConfig = normalizeProviderConfig({
    ...inheritedConfig,
    telegram: { enabled: false, botToken: "", allowedChatIds: [] },
  });
  await fs.promises.mkdir(childUserDataPath, { recursive: true });
  await fs.promises.writeFile(
    path.join(childUserDataPath, "providers_config.json"),
    JSON.stringify(childConfig, null, 2),
    "utf8"
  );

  let proxyCopy = { copied: false, accounts: 0 };
  try {
    proxyCopy = await copyProxyConfigToChild(parentUserDataPath, childUserDataPath);
  } catch (error) {
    console.error("[new-window] proxy copy failed:", error?.message || error);
    return { ok: false, error: `Proxy config copy failed: ${error?.message || error}` };
  }

  // Fresh app instance: load dist only (no shared Vite/HMR), same copy identity + configs.
  const childEnv = {
    ...process.env,
    LOPSTER_COPY_ID: appCopyId,
    LOPSTER_APP_NAME: process.env.LOPSTER_APP_NAME || appName,
    LOPSTER_INSTANCE_ID: instanceId,
    ELECTRON_FORCE_NEW_INSTANCE: "1",
    LOPSTER_FORCE_DIST: "1",
  };
  delete childEnv.LOPSTER_DEV_SERVER;
  delete childEnv.VITE_DEV_SERVER_URL;
  delete childEnv.LOPSTER_DEV_MODE;

  const child = spawn(process.execPath, app.isPackaged ? [] : [app.getAppPath()], {
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  child.unref();
  return {
    ok: true,
    instanceId,
    proxyAccounts: proxyCopy.accounts ?? 0,
    proxyCopied: Boolean(proxyCopy.copied),
  };
});

ipcMain.handle("shell:openExternal", (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

// ── Web Engine: per-chat URL binding + localhost probe + clipboard ──────────

ipcMain.handle("webengine:getBinding", async (_event, chatKey) => {
  try {
    return webEngineStore.get(app.getPath("userData"), chatKey);
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("webengine:setBinding", async (_event, chatKey, url) => {
  try {
    return await webEngineStore.set(app.getPath("userData"), chatKey, url);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("webengine:copyText", (_event, text) => {
  if (typeof text !== "string" || !text) return { ok: false, error: "empty" };
  try {
    clipboard.writeText(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// ── MultiIDE layout: workspaces (with names) + their chat panels ────────────
// The renderer keeps its synchronous initializers by reading the JSON file once
// through a sync bridge; every change then writes a patch (slots OR workspaces)
// so the two independent save effects can never overwrite each other.
ipcMain.handle("multiide:loadState", () => {
  try {
    return multiIdeStore.readState(app.getPath("userData"));
  } catch {
    return multiIdeStore.emptyState();
  }
});

ipcMain.on("multiide:loadStateSync", (event) => {
  try {
    event.returnValue = multiIdeStore.readState(app.getPath("userData"));
  } catch {
    event.returnValue = multiIdeStore.emptyState();
  }
});

ipcMain.handle("multiide:saveState", (_event, patch) => {
  try {
    return { ok: true, state: multiIdeStore.savePatch(app.getPath("userData"), patch) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

/** Used on pagehide so a rename is on disk before the window disappears. */
ipcMain.on("multiide:saveStateSync", (event, patch) => {
  try {
    event.returnValue = { ok: true, state: multiIdeStore.savePatch(app.getPath("userData"), patch) };
  } catch (error) {
    event.returnValue = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Probe common dev-server ports on localhost and return the first one that is
// actually listening. Bounded parallel connect attempts — never blocks the UI.
const WEBENGINE_DEV_PORTS = [
  3000, 5173, 4173, 8080, 8000, 4200, 5000, 5001, 9000, 3001, 3002, 3003,
  4000, 1234, 7777, 8787, 8888, 8008, 5500, 4321, 3333, 6060, 7000, 10000,
];

function probePort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Confirm the port actually serves HTTP — a TCP listener is not enough. */
function probeHttp(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: "/", method: "HEAD", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Pull the project's own dev port from package.json scripts / vite config / .env,
 *  so "this project's localhost" wins over any other open port on the machine. */
function detectProjectPorts(rootPath) {
  const ports = new Set();
  if (typeof rootPath !== "string" || !rootPath) return [];
  try {
    const pkgPath = path.join(rootPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      for (const cmd of Object.values(scripts)) {
        const m = String(cmd).match(/(?:--port|--port=|-p)\s+['"]?(\d{2,5})/);
        if (m) ports.add(Number(m[1]));
      }
    }
  } catch {
    /* ignore */
  }
  try {
    for (const name of ["vite.config.js", "vite.config.ts", "vite.config.mjs", "vite.config.cjs"]) {
      const cfg = path.join(rootPath, name);
      if (!fs.existsSync(cfg)) continue;
      const text = fs.readFileSync(cfg, "utf8");
      const m = text.match(/(?:port\s*:|port\s*=|port)\s*['"]?(\d{2,5})/);
      if (m) ports.add(Number(m[1]));
    }
  } catch {
    /* ignore */
  }
  try {
    const envPath = path.join(rootPath, ".env");
    if (fs.existsSync(envPath)) {
      const text = fs.readFileSync(envPath, "utf8");
      const m = text.match(/^PORT\s*=\s*['"]?(\d{2,5})/m);
      if (m) ports.add(Number(m[1]));
    }
  } catch {
    /* ignore */
  }
  return [...ports];
}

ipcMain.handle("webengine:probeLocalhost", async (_event, rootPath) => {
  try {
    const projectPorts = detectProjectPorts(rootPath);
    const candidates = [
      ...projectPorts,
      ...WEBENGINE_DEV_PORTS.filter((p) => !projectPorts.includes(p)),
    ];
    // TCP-open ports in priority order, then confirm they answer HTTP.
    const openResults = await Promise.all(
      candidates.map((port) => probePort("127.0.0.1", port, 250))
    );
    const openPorts = candidates.filter((_, i) => openResults[i]);
    const tried = openPorts.map((port) => ({ port, http: null }));
    const httpResults = await Promise.all(openPorts.map((port) => probeHttp(port, 700)));
    for (let i = 0; i < openPorts.length; i += 1) {
      tried[i].http = httpResults[i];
      if (httpResults[i]) return { ok: true, url: `http://localhost:${openPorts[i]}`, tried };
    }
    return { ok: true, url: null, tried };
  } catch (error) {
    return {
      ok: false,
      url: null,
      tried: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

// Capture the guest page and put it on the clipboard (image). The renderer hands
// over the webview's guest webContents id — never a path or arbitrary JS.
ipcMain.handle("webengine:captureScreenshot", async (_event, webContentsId) => {
  try {
    const id = Number(webContentsId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "bad-webcontents-id" };
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return { ok: false, error: "page-not-found" };
    const image = await wc.capturePage();
    if (!image || image.isEmpty()) return { ok: false, error: "empty-capture" };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Full virtual desktop screenshot (all monitors) → clipboard, with watermark.
ipcMain.handle("screenshot:captureFull", async () => {
  try {
    return await screenshot.captureFullDesktop();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Clear the Web Engine guest partition's cache + storage, so the renderer can
// follow with a hard (cache-bypassing) reload.
ipcMain.handle("webengine:clearCache", async () => {
  try {
    const ses = session.fromPartition("persist:composevc-webengine");
    await ses.clearCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("worktimer:get", () => workTimerStore.get());

let backgroundTasksReady = false;
function broadcastBackgroundTasks(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("bgterm:changed", payload); } catch { /* ignore */ }
  }
}
function ensureBackgroundTasks() {
  if (!backgroundTasksReady) {
    backgroundTasks.init({
      userDataPath: app.getPath("userData"),
      broadcast: broadcastBackgroundTasks,
    });
    backgroundTasksReady = true;
  }
  return backgroundTasks;
}

ipcMain.handle("bgterm:list", async (_event, sessionId) => {
  ensureBackgroundTasks();
  return { ok: true, tasks: backgroundTasks.list(sessionId || null) };
});

ipcMain.handle("bgterm:kill", async (_event, id) => {
  ensureBackgroundTasks();
  return backgroundTasks.kill(id);
});

ipcMain.handle("config:read", async () => {
  const config = await readProviderConfig();
  configureTelegramFromProviderConfig(config);
  return config;
});

/**
 * Composer ghost-text autocomplete.
 * Renderer sends the whole draft + caret; this never writes config or sessions.
 */
ipcMain.handle("inline-hint:suggest", async (_event, request = {}) => {
  try {
    const config = await readProviderConfig();
    return await inlineHint.requestInlineHint({ config, request });
  } catch (error) {
    return { ok: false, error: error?.message || "Autocomplete failed" };
  }
});

ipcMain.handle("telegram:runtimeContext", (event, context) => {
  const rootPath = context?.rootPath || null;
  const projectName = context?.projectName || (rootPath ? path.basename(rootPath) : "No folder");
  // Always keep window-level fallback for legacy callers
  event.sender.lopsterRootPath = rootPath;
  event.sender.lopsterProjectName = projectName;
  const slotId = typeof context?.slotId === "string" ? context.slotId.trim() : "";
  if (slotId) {
    telegramSlotContexts.set(slotId, { rootPath, projectName });
  }
  return true;
});


registerProxyHandlers(ipcMain, () => app.getPath("userData"));
registerLocalAgentHandlers(ipcMain, () => app.getPath("userData"));
try {
  require("./updater.cjs").register(ipcMain);
} catch (error) {
  console.error("[updater] register failed:", error?.message || error);
}

ipcMain.handle("config:write", async (_event, config) => {
  return writeProviderConfig(config);
});

// CF Mail (cf_mail tool) credentials — shared JSON store under runtime-app/data/config.json.
ipcMain.handle("cfmail:read", async () => {
  const cfg = await cfMailConfig.readConfig();
  return {
    ...cfg,
    configured: Boolean(cfg.cfworker_api_url && cfg.cfworker_admin_token),
    config_path: cfMailConfig.configPath(),
  };
});

ipcMain.handle("cfmail:write", async (_event, patch) => {
  const cfg = await cfMailConfig.writeConfig(patch && typeof patch === "object" ? patch : {});
  return {
    ...cfg,
    configured: Boolean(cfg.cfworker_api_url && cfg.cfworker_admin_token),
    config_path: cfMailConfig.configPath(),
  };
});

ipcMain.handle("cfmail:test", async () => {
  const cfg = await cfMailConfig.readConfig();
  return cfMailConfig.testConfig(cfg);
});

global.__lopsterReadProviderConfig = async () => {
  try {
    return await readProviderConfig();
  } catch {
    return null;
  }
};

ipcMain.handle("runner:list", async () => {
  try {
    const runners = await runnerEngine.listRunners();
    return { ok: true, runners };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), runners: [] };
  }
});

ipcMain.handle("runner:get", async (_event, id) => {
  try {
    const runner = await runnerEngine.getRunner(id);
    if (!runner) return { ok: false, error: "not found" };
    return { ok: true, runner };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:create", async (_event, input = {}) => {
  try {
    const runner = await runnerEngine.createRunner(input || {});
    return { ok: true, runner };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:update", async (_event, id, patch = {}) => {
  try {
    const runner = await runnerEngine.updateRunner(id, patch || {});
    return { ok: true, runner };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:delete", async (_event, id) => {
  try {
    return await runnerEngine.deleteRunner(id);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:run", async (_event, id, opts = {}) => {
  try {
    return await runnerEngine.runRunner(id, { ...(opts || {}), manual: true, trigger: "manual" });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:stop", async (_event, id) => {
  try {
    return await runnerEngine.stopRunner(id);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:reports:list", async (_event, opts = {}) => {
  try {
    const reports = await runnerEngine.listRunnerReports(opts || {});
    return { ok: true, reports };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), reports: [] };
  }
});

ipcMain.handle("runner:reports:get", async (_event, runnerId, reportId) => {
  try {
    const report = await runnerEngine.getRunnerReport(runnerId, reportId);
    if (!report) return { ok: false, error: "not found" };
    return { ok: true, report };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle("runner:reports:delete", async (_event, runnerId, reportId) => {
  try {
    return await runnerEngine.deleteRunnerReport(runnerId, reportId);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

/** Per Telegram-chat session binding, keyed by `${slotId}::${telegramChatId}` */
const telegramChatSessions = new Map();
/** Per MultiIDE-slot runtime context (folder / project name) for that slot's bot */
const telegramSlotContexts = new Map();
/** Live bot instances keyed by MultiIDE slotId (multi-1 … multi-4) */
const telegramBotsBySlot = new Map();
let mainWindow = null;

function getMainSender() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
}

function telegramSessionKey(slotId, chatId) {
  return `${String(slotId || "")}::${String(chatId || "")}`;
}

function getTelegramSlotContext(slotId) {
  const ctx = telegramSlotContexts.get(String(slotId || ""));
  if (ctx) return ctx;
  const sender = getMainSender();
  return {
    rootPath: sender?.lopsterRootPath || null,
    projectName: sender?.lopsterProjectName || "No folder",
  };
}

function getTelegramRootPath(slotId) {
  return getTelegramSlotContext(slotId).rootPath || null;
}

function getTelegramProjectName(slotId, rootPath) {
  const ctx = getTelegramSlotContext(slotId);
  if (ctx.projectName) return ctx.projectName;
  return rootPath ? path.basename(rootPath) : "No folder";
}

async function ensureTelegramSession(slotId, chatId) {
  const rootPath = getTelegramRootPath(slotId);
  const key = telegramSessionKey(slotId, chatId);
  let sessionId = telegramChatSessions.get(key) || null;
  if (sessionId) {
    // Load without stealing UI active pointer. If the file is gone, loadSession
    // may create a replacement — always trust the returned sessionId.
    try {
      const loaded = await memory.loadSession(app, rootPath, sessionId, { setActive: false });
      const resolvedId = loaded?.sessionId || sessionId;
      if (resolvedId !== sessionId) telegramChatSessions.set(key, resolvedId);
      return { rootPath, sessionId: resolvedId, key };
    } catch {
      telegramChatSessions.delete(key);
      sessionId = null;
    }
  }
  // Always create a dedicated TG session — never bind to the user's current UI active chat.
  const session = await memory.createSession(app, rootPath, {
    setActive: false,
    title: `Telegram · ${chatId}`,
  });
  sessionId = session.sessionId;
  telegramChatSessions.set(key, sessionId);
  return { rootPath, sessionId, key };
}

async function buildTelegramRequest(slotId, chatId, text) {
  const { rootPath, sessionId } = await ensureTelegramSession(slotId, chatId);
  const config = await readProviderConfig();
  // Prefer model selected in this MultiIDE slot's runtime if we ever store it; else global.
  const modelId = config.selectedModelId || config.models[0]?.id;
  if (!modelId) throw new Error("No model configured");
  return {
    modelId,
    rootPath,
    projectName: getTelegramProjectName(slotId, rootPath),
    sessionId,
    messages: [{ role: "user", content: text }],
  };
}

function emptyTelegramStatus(extra = {}) {
  return {
    enabled: false,
    botToken: "",
    allowedChatIds: [],
    running: false,
    botUsername: "",
    lastError: null,
    lastOkAt: 0,
    reason: "stopped",
    slotId: null,
    ...extra,
  };
}

function createSlotTelegramBot(slotId) {
  const id = String(slotId || "").trim();
  if (!id) throw new Error("slotId is required");
  if (telegramBotsBySlot.has(id)) return telegramBotsBySlot.get(id);

  const bot = createTelegramBot({
    onUserMessage: async ({ chatId, text }) => {
      const sender = getMainSender();
      if (!sender) throw new Error("Open ComposeVC window before using Telegram control");
      const request = await buildTelegramRequest(id, chatId, text);
      const result = await executeChatRequest(
        { sender },
        request,
        { telegramChatId: chatId, telegramSlotId: id }
      );
      const key = telegramSessionKey(id, chatId);
      if (result.sessionId) telegramChatSessions.set(key, result.sessionId);
      await bot.sendMessage(chatId, `Final answer:\n${result.text || "[empty]"}`);
    },
    onNewSession: async (chatId) => {
      // Fresh dedicated TG session — do not become the IDE's active UI chat.
      const session = await memory.createSession(app, getTelegramRootPath(id), {
        setActive: false,
        title: `Telegram · ${chatId}`,
      });
      telegramChatSessions.set(telegramSessionKey(id, chatId), session.sessionId);
      return session;
    },
    onStop: async () => {
      // Telegram global stop — still full stop (no multi-session context here).
      rejectAllPending("Stopped by user");
      const aborted = abortAllChatSessions();
      hardKillAgentRuntime();
      return aborted;
    },
    // Bridge Telegram ask_user / ask_otp free-text + buttons into the agent wait queue.
    onAskUserAnswer: async (payload) => {
      const toolCallId = payload?.toolCallId;
      if (!toolCallId) return { ok: false, error: "toolCallId is required" };
      return resolveUserAnswer(toolCallId, {
        answer: payload?.answer,
        selected: payload?.selected,
      });
    },
  });

  telegramBotsBySlot.set(id, bot);
  return bot;
}

function getSlotTelegramBot(slotId) {
  const id = String(slotId || "").trim();
  if (!id) return null;
  return telegramBotsBySlot.get(id) || createSlotTelegramBot(id);
}

function getTelegramStatusForSlot(slotId) {
  const id = String(slotId || "").trim();
  if (!id) return emptyTelegramStatus({ reason: "no_slot", lastError: "slotId is required" });
  try {
    const bot = getSlotTelegramBot(id);
    return { ...bot.getStatus(), slotId: id };
  } catch (error) {
    return emptyTelegramStatus({
      slotId: id,
      lastError: error?.message || String(error),
      reason: "error",
    });
  }
}

async function configureTelegramSlot(slotId, config) {
  const id = String(slotId || "").trim();
  if (!id) throw new Error("slotId is required");
  const normalized = normalizeTelegramConfig(config);
  await telegramSlots.setSlotConfig(app.getPath("userData"), id, normalized);
  const bot = getSlotTelegramBot(id);
  return { ...bot.configure(normalized), slotId: id };
}

async function loadAndStartAllTelegramSlots() {
  const userDataPath = app.getPath("userData");
  let providerConfig = null;
  try {
    providerConfig = await readProviderConfig();
  } catch {
    providerConfig = null;
  }
  const slots = await telegramSlots.migrateGlobalTelegramIfNeeded(
    userDataPath,
    providerConfig?.telegram
  );
  const statuses = {};
  for (const [slotId, cfg] of Object.entries(slots)) {
    try {
      const bot = getSlotTelegramBot(slotId);
      statuses[slotId] = { ...bot.configure(cfg), slotId };
    } catch (error) {
      console.error(`Telegram configure failed for ${slotId}:`, error);
      statuses[slotId] = emptyTelegramStatus({
        slotId,
        ...normalizeTelegramConfig(cfg),
        lastError: error?.message || String(error),
        reason: "error",
      });
    }
  }
  return statuses;
}

/**
 * Global Settings → Telegram still works as fallback for slot multi-1 only.
 * Other MultiIDE slots (multi-2..4) are configured exclusively via the per-chat modal.
 * Full multi-slot load happens on app ready; this only mirrors the global form into multi-1.
 */
function configureTelegramFromProviderConfig(config) {
  try {
    const tg = normalizeTelegramConfig(config?.telegram);
    // Fire-and-forget: persist + start multi-1 without blocking config:write.
    void (async () => {
      try {
        await telegramSlots.setSlotConfig(app.getPath("userData"), "multi-1", tg);
        const bot = getSlotTelegramBot("multi-1");
        bot.configure(tg);
      } catch (error) {
        console.error("Telegram multi-1 fallback configure failed:", error?.message || error);
      }
    })();
    return null;
  } catch (error) {
    console.error("Telegram configure failed:", error);
    return null;
  }
}

ipcMain.handle("telegram:status", async (_event, slotId) => {
  if (slotId) return getTelegramStatusForSlot(slotId);
  // Legacy: first running slot, else multi-1
  for (const [id, bot] of telegramBotsBySlot) {
    const status = bot.getStatus();
    if (status.running) return { ...status, slotId: id };
  }
  return getTelegramStatusForSlot("multi-1");
});

ipcMain.handle("telegram:slotStatus", async (_event, slotId) => {
  return getTelegramStatusForSlot(slotId);
});

ipcMain.handle("telegram:slotConfig", async (_event, slotId) => {
  const id = String(slotId || "").trim();
  if (!id) return telegramSlots.EMPTY();
  return telegramSlots.getSlotConfig(app.getPath("userData"), id);
});

ipcMain.handle("telegram:configureSlot", async (_event, slotId, config) => {
  return configureTelegramSlot(slotId, config);
});

ipcMain.handle("telegram:listSlots", async () => {
  const slots = await telegramSlots.readTelegramSlots(app.getPath("userData"));
  const out = {};
  for (const [id, cfg] of Object.entries(slots)) {
    out[id] = getTelegramStatusForSlot(id);
    // ensure status reflects saved config even if bot not yet started
    if (!out[id].botToken && cfg.botToken) {
      try {
        const bot = getSlotTelegramBot(id);
        out[id] = { ...bot.configure(cfg), slotId: id };
      } catch {
        /* keep */
      }
    }
  }
  return out;
});

// Per-session abort controllers — multiple chats can run in parallel; switching
// sessions must NOT kill background agents. Stop only aborts the given sessionId
// (or all if omitted). Hard cap: MAX_PARALLEL_CHAT_SESSIONS (see chatSessionRegistry).
const chatSessions = require("./chatSessionRegistry.cjs");

const PROGRESS_FLUSH_MS = 50;
const PROGRESS_IMMEDIATE_TYPES = new Set([
  "tool_start",
  "tool_end",
  "tool_limit",
  "status",
  "retry",
  "compact_start",
  "compact_end",
  "subagent_status",
  "assistant_text",
  "assistant_thinking",
  "ask_user",
  "ask_otp",
]);
const PROGRESS_COALESCE_TYPES = new Set([
  "context_usage",
]);

/**
 * Batch high-frequency agent:progress IPC (context_usage / noise) so multi-chat
 * does not flood the renderer into a freeze.
 * Lifecycle events (tools / status / text) always deliver immediately —
 * never coalesce into a single pending slot (that dropped tool_start/tool_end).
 */
function createThrottledProgressSender(event, opts = {}) {
  const channel = opts.progressChannel || "agent:progress";
  const sessionId = opts.sessionId;
  const agentId = opts.agentId;
  const telegramChatId = opts.telegramChatId;
  const telegramSlotId = opts.telegramSlotId;
  const onProgressHook = typeof opts.onProgress === "function" ? opts.onProgress : null;
  let timer = null;
  let pendingCoalesce = null;
  let pendingNested = new Map();
  let closed = false;

  const deliver = (progress) => {
    if (closed || !progress) return;
    const payload = {
      ...progress,
      sessionId: progress.sessionId || sessionId,
      ...(agentId ? { agentId: progress.agentId || agentId } : {}),
    };
    try {
      if (event?.sender && !event.sender.isDestroyed?.()) {
        event.sender.send(channel, payload);
      }
    } catch {
      /* window gone */
    }
    if (onProgressHook) {
      try {
        onProgressHook(payload);
      } catch {
        /* */
      }
    }
    if (telegramChatId) {
      const slotBot =
        (telegramSlotId && telegramBotsBySlot.get(String(telegramSlotId))) || null;
      if (slotBot) {
        slotBot
          .notifyProgress(telegramChatId, progress)
          .catch((error) => console.error("Telegram progress failed:", error?.message || error));
      }
    }
  };

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingCoalesce) {
      const p = pendingCoalesce;
      pendingCoalesce = null;
      deliver(p);
    }
    if (pendingNested.size) {
      const updates = [...pendingNested.values()];
      pendingNested = new Map();
      for (const update of updates) deliver(update);
    }
  };

  const scheduleFlush = () => {
    if (!timer) timer = setTimeout(flush, PROGRESS_FLUSH_MS);
  };

  const send = (progress) => {
    if (closed || !progress) return;
    const type = progress.type || "";
    const nested = Boolean(progress.parentToolCallId);

    if (PROGRESS_IMMEDIATE_TYPES.has(type) || !type) {
      flush();
      deliver(progress);
      return;
    }

    if (nested) {
      if (
        type === "tool_end" ||
        (type === "subagent_status" &&
          ["done", "error", "stopped"].includes(String(progress.status || "")))
      ) {
        flush();
        deliver(progress);
        return;
      }
      const key = `${progress.parentToolCallId}:${progress.agentId || progress.index || "unit"}:${type}`;
      pendingNested.set(key, progress);
      scheduleFlush();
      return;
    }

    if (PROGRESS_COALESCE_TYPES.has(type)) {
      pendingCoalesce = progress;
      scheduleFlush();
      return;
    }

    flush();
    deliver(progress);
  };

  send.flush = flush;
  send.close = () => {
    closed = true;
    flush();
  };
  return send;
}

function abortChatSession(sessionId) {
  return chatSessions.abort(sessionId);
}

function abortAllChatSessions() {
  return chatSessions.abortAll();
}

/** Dispose registered tool side effects immediately when a chat is stopped. */
function hardKillAgentRuntime() {
  try {
    return require("./tools/registry.cjs").disposeAllToolRuntime();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

ipcMain.handle("chat:stop", (_event, sessionId) => {
  const sid = sessionId ? String(sessionId) : null;

  // Per-session stop: only abort THIS loop. ask_user waiters for this session
  // already listen to the AbortSignal — do NOT rejectAllPending (that kills other chats).
  // Dispose shared tool side effects only when no other MultiIDE sessions still run.
  if (sid) {
    const aborted = abortChatSession(sid);
    const othersRunning = chatSessions.hasOtherRunning(sid);
    let killReport = { skipped: true, reason: "other_sessions_running" };
    if (!othersRunning) {
      // Sole remaining / last session — safe to wipe hung side processes.
      rejectAllPending("Stopped by user");
      killReport = hardKillAgentRuntime();
    }
    return { ok: true, aborted, killReport, scoped: true, othersRunning };
  }

  // No sessionId: stop everything (legacy / global stop)
  rejectAllPending("Stopped by user");
  const aborted = abortAllChatSessions();
  const killReport = hardKillAgentRuntime();
  return { ok: true, aborted, killReport, scoped: false };
});

ipcMain.handle("chat:runningSessions", () => chatSessions.listIds());

/** Count tool-bearing rows (assistant.toolCalls or role=tool). */
function transcriptToolCount(messages) {
  let count = 0;
  for (const message of messages || []) {
    if (!message) continue;
    if (message.role === "tool") count += 1;
    else if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) count += 1;
  }
  return count;
}

/**
 * Merge UI-projected history with the on-disk agent transcript.
 * The renderer often sends a collapsed view (no role=tool rows). Never let that
 * wipe tool calls/results that were already persisted for the session.
 */
function mergeSessionMessages(storedMessages, incomingMessages) {
  const stored = Array.isArray(storedMessages) ? storedMessages : [];
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  if (stored.length === 0) return incoming;
  if (incoming.length === 0) return stored;

  const incomingLast = incoming[incoming.length - 1];
  const storedLast = stored[stored.length - 1];
  const isNewUserTurn =
    incomingLast?.role === "user" &&
    (storedLast?.role !== "user" || storedLast?.content !== incomingLast?.content);

  const storedTools = transcriptToolCount(stored);
  const incomingTools = transcriptToolCount(incoming);

  if (isNewUserTurn) {
    // Keep the authoritative tool-rich transcript, append only the new user turn.
    return [...stored, incomingLast];
  }

  // Same turn / resend / UI rehydrate: prefer whichever still carries tools.
  if (storedTools > incomingTools) return stored;
  if (incomingTools > storedTools) return incoming;
  // Equal tool richness — prefer the longer (usually the agent transcript).
  return stored.length >= incoming.length ? stored : incoming;
}

function buildLabInConversationContext(messages, currentUserMessage) {
  const rows = [];
  const list = Array.isArray(messages) ? messages : [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    if (message === currentUserMessage) continue;
    const text = contentPartsToText(message.content).trim();
    if (!text) continue;
    rows.push(`${message.role === "user" ? "USER" : "ASSISTANT"}: ${text.slice(0, 5000)}`);
  }
  let value = rows.slice(-12).join("\n\n");
  if (value.length > 24000) value = value.slice(value.length - 24000);
  return value;
}

function restoreLabInUserMessage(messages, originalMessage) {
  if (!Array.isArray(messages) || !originalMessage) return messages;
  const segmentedIndexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = contentPartsToText(message?.content);
    const segmentedUser = message?.role === "user" && (
      text.includes("[LAB-IN KNOWLEDGE PART ") ||
      text.includes("[LAB-IN EXECUTE AFTER KNOWLEDGE PARTS]")
    );
    const segmentedAck = message?.role === "assistant" && text.startsWith("[LAB-IN PART ACK ");
    if (segmentedUser || segmentedAck) segmentedIndexes.push(index);
  }
  if (segmentedIndexes.length) {
    const firstSynthetic = segmentedIndexes[0];
    const syntheticSet = new Set(segmentedIndexes);
    const insertionIndex = messages.slice(0, firstSynthetic).filter((_message, index) => !syntheticSet.has(index)).length;
    const restored = {
      role: "user",
      content: originalMessage.content,
      ...(Array.isArray(originalMessage.images) && originalMessage.images.length
        ? { images: originalMessage.images }
        : {}),
    };
    const clean = messages.filter((_message, index) => !syntheticSet.has(index));
    return [...clean.slice(0, insertionIndex), restored, ...clean.slice(insertionIndex)];
  }
  let targetIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && contentPartsToText(message.content).includes("[LAB-IN EXECUTION PACKAGE]")) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) return messages;
  return messages.map((message, index) => {
    if (index !== targetIndex) return message;
    return {
      ...message,
      content: originalMessage.content,
      ...(Array.isArray(originalMessage.images) && originalMessage.images.length
        ? { images: originalMessage.images }
        : {}),
    };
  });
}

async function executeChatRequest(event, request, overrides = {}) {
  ensureBackgroundTasks();
  const config = await readProviderConfig();
  const modelId = overrides.modelId || request.modelId;
  let model = config.models.find((item) => item.id === modelId);
  if (!model) {
    throw new Error("Selected model not found");
  }

  const providerId = overrides.providerId || model.providerId;
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error("Provider for selected model not found");
  }

  const automaticLimits = await resolveAutomaticModelLimits(model, provider);
  const resolvedModelContext = normalizeContextLimit(automaticLimits.context, model.contextLimit);
  const hasFreshModelLimits =
    automaticLimits.context != null && automaticLimits.context !== model.contextLimit;
  const modelLimitsChanged =
    hasFreshModelLimits &&
    (model.contextLimit !== resolvedModelContext ||
      (automaticLimits.output != null && model.outputLimit !== automaticLimits.output));
  const modelContextTokens = clampTokenSetting(
    overrides.maxContextTokens,
    resolvedModelContext,
    { min: 8_000, max: ABSOLUTE_MAX_CONTEXT_TOKENS }
  );
  const modelCompactTokens = clampTokenSetting(
    overrides.autoCompactTokens,
    Math.floor(modelContextTokens * 0.8),
    { min: 4_000, max: Math.max(4_000, modelContextTokens - 1_000) }
  );
  model = {
    ...model,
    contextLimit: modelContextTokens,
    outputLimit: automaticLimits.output || model.outputLimit || undefined,
  };
  if (modelLimitsChanged) {
    const models = config.models.map((item) =>
      item.id === model.id ? { ...item, contextLimit: modelContextTokens, outputLimit: model.outputLimit } : item
    );
    await writeProviderConfig({ ...config, models });
  }

  if (!provider.apiKey) {
    throw new Error(`API key is empty for ${provider.name}`);
  }

  const rootPath = request.rootPath || null;

  const persistSession = overrides.persistSession !== false;
  const isTelegramRun = Boolean(overrides.telegramChatId);
  const isExternalRun = isTelegramRun;
  let sessionId = request.sessionId || null;
  const incomingMessages = Array.isArray(request.messages) ? request.messages : [];
  // Usage metric: characters the user typed in their prompt. Count only the
  // latest real user turn (never assistant/tool output) and only genuine in-chat
  // sends — Telegram/remote channels and automated Runner ticks are not "typed
  // by the user in the IDE".
  const isRunnerRun =
    typeof overrides.agentId === "string" && overrides.agentId.startsWith("runner:");
  if (!isTelegramRun && !isRunnerRun) {
    try {
      const lastUser = [...incomingMessages].reverse().find(
        (m) => m && m.role === "user" && isRealUserMessage(m)
      );
      if (lastUser) {
        const text = (contentPartsToText(lastUser.content) || "").trim();
        usageStore.recordUserPrompt(text.length);
      }
    } catch {
      /* usage tracking must never break chat send */
    }
  }
  let requestMessages = incomingMessages;
  if (persistSession) {
    if (!sessionId) {
      const created = await memory.createSession(app, rootPath, {
        setActive: !isExternalRun,
        title: isTelegramRun
          ? `Telegram · ${overrides.telegramChatId}`
          : undefined,
      });
      sessionId = created.sessionId;
    }

    let storedSession = await memory.loadSession(app, rootPath, sessionId, {
      setActive: !isExternalRun,
    });
    // One-shot: second (or later) user send wipes prior transcript/compile completely.
    // Only the newest user turn may remain as context for this request.
    let oneShotWiped = false;
    if (storedSession?.oneShot === true) {
      const priorCount = Array.isArray(storedSession.messages) ? storedSession.messages.length : 0;
      if (priorCount > 0) {
        oneShotWiped = true;
        try {
          storedSession = await memory.clearSessionTranscript(app, rootPath, sessionId, {
            oneShot: true,
            title: storedSession.title,
          });
        } catch (clearErr) {
          console.warn("oneShot clearSessionTranscript failed:", clearErr?.message || clearErr);
          storedSession = {
            ...storedSession,
            messages: [],
            contextTokens: undefined,
            usage: undefined,
          };
        }
      }
    }
    const storedMessages = Array.isArray(storedSession?.messages) ? storedSession.messages : [];
    if (oneShotWiped) {
      // Never re-merge a stale UI transcript after wipe — keep only the latest user turn.
      let lastUser = null;
      for (let i = incomingMessages.length - 1; i >= 0; i -= 1) {
        const msg = incomingMessages[i];
        if (msg && msg.role === "user") {
          lastUser = msg;
          break;
        }
      }
      requestMessages = lastUser ? [lastUser] : [];
    } else {
      // Prefer on-disk agent transcript (with tool calls/results) over UI projection.
      requestMessages = mergeSessionMessages(storedMessages, incomingMessages);
    }
    await memory.saveSession(app, rootPath, sessionId, requestMessages, {});
  }

  const excludeToolNames = [];
  let systemPrompt;
  // Removed modes normalize to the default lopster mode.
  // Modes: lopster | lab-in | fortani (LAB-IN, then a follow-up agent)
  const rawAgentMode = String(overrides.agentMode || request.agentMode || "lopster")
    .trim()
    .toLowerCase();
  const agentMode =
    rawAgentMode === FORTANI_MODE_ID ||
    rawAgentMode === "fortani+lab-in" ||
    rawAgentMode === "fortani-lab" ||
    rawAgentMode === "fortani_lab"
      ? FORTANI_MODE_ID
      : rawAgentMode === LAB_IN_MODE_ID || rawAgentMode === "labin" || rawAgentMode === "lab_in"
        ? LAB_IN_MODE_ID
        : "lopster";
  const isFortani = agentMode === FORTANI_MODE_ID;
  const isLabIn = agentMode === LAB_IN_MODE_ID || isFortani;
  let effectiveAgentMode = agentMode;

  const lastUserMsg = [...requestMessages].reverse().find((m) => isRealUserMessage(m)) || null;
  const originalLastUserMsg = lastUserMsg ? { ...lastUserMsg } : null;
  // Multimodal: extract plain text only (images stay on the message for adapters).
  const lastUserText = lastUserMsg
    ? contentPartsToText(lastUserMsg.content) ||
      (typeof lastUserMsg.content === "string" ? lastUserMsg.content : "")
    : "";
  const customToolQueryText = String(lastUserText || "");
  const baseSystemPrompt = await buildSystemPromptWithCustomTools({
    rootPath,
    projectName: request.projectName,
    userDataPath: app.getPath("userData"),
    customToolQuery: customToolQueryText,
  });
  const activeSystemPrompts = [
    overrides.systemPrompt,
  ].filter((prompt) => typeof prompt === "string" && prompt.trim());
  systemPrompt =
    activeSystemPrompts.length > 0
      ? `${activeSystemPrompts.join("\n\n")}\n\n--- Injected ComposeVC context ---\n${baseSystemPrompt}`
      : baseSystemPrompt;
  systemPrompt +=
    "\n\n## Shared LAB-IN knowledge memory\n" +
    "The knowledge tool is a persistent global memory shared across projects. " +
    "Only write to it when the user explicitly asks to remember, save, replenish, or update memory. " +
    "When asked, preserve the useful substance, provenance, tags, and known links; the tool safely chunks large content. " +
    "Never silently store ordinary conversations or secrets. For updates, read the existing chunk first and update by ID.";
  if (request.thinkingMax === true) {
    systemPrompt += `\n\n${THINKING_MAX_PROMPT}`;
  }

  const runSessionId = sessionId || `ephemeral-${Date.now().toString(16)}`;
  const abortController = new AbortController();
  const slotCheck = chatSessions.tryRegister(runSessionId, abortController);
  if (!slotCheck.ok) {
    if (slotCheck.reason === "already_running") {
      throw new Error("This chat session is already running. Wait for it to finish or press Stop.");
    }
    if (slotCheck.reason === "max_parallel") {
      throw new Error(
        `Too many chats running at once (${slotCheck.running}/${slotCheck.limit}). ` +
          `Wait for one to finish or press Stop — max ${chatSessions.MAX_PARALLEL_CHAT_SESSIONS} parallel chats.`
      );
    }
    throw new Error("Cannot start chat session.");
  }
  try {
    event.sender.send("agent:run-state", { sessionId: runSessionId, running: true });
  } catch {
    // ignore
  }

  let result;
  let stoppedFlag = false;
  let mainProgress = null;
  let historyUserMessages = requestMessages;
  let labInMeta = null;
  let fortaniMeta = null;
  try {
    // ── LAB-IN: prompt refiner → audited shared-memory search → main execution ──
    if (isLabIn && typeof lastUserText === "string" && lastUserText.trim()) {
      mainProgress = createThrottledProgressSender(event, {
        sessionId: runSessionId,
        agentId: overrides.agentId,
        progressChannel: overrides.progressChannel,
        telegramChatId: overrides.telegramChatId,
        telegramSlotId: overrides.telegramSlotId,
        onProgress: (progress) => {
          if (typeof overrides.onProgress === "function") {
            try {
              overrides.onProgress(progress);
            } catch {
              /* */
            }
          }
        },
      });
      let pipeline;
      try {
        pipeline = await runLabInPipeline({
          runAgentLoop,
          config,
          mainModel: model,
          mainProvider: provider,
          originalTask: lastUserText,
          conversationContext: buildLabInConversationContext(requestMessages, lastUserMsg),
          projectName: request.projectName || null,
          userDataPath: app.getPath("userData"),
          signal: abortController.signal,
          tokenCountingMode: config.tokenCountingMode || "provider",
          onProgress: mainProgress,
          sessionId: runSessionId,
        });
      } catch (labError) {
        if (abortController.signal.aborted || labError?.name === "AbortError" || labError?.stopped) {
          stoppedFlag = true;
          return {
            text: labError?.message || "[Stopped by user]",
            provider,
            model,
            sessionId: runSessionId,
            stopped: true,
            agentMode: LAB_IN_MODE_ID,
            labIn: { ok: false, stopped: true, error: labError?.message || "stopped" },
          };
        }
        pipeline = {
          handoffUserMessage:
            `[LAB-IN pipeline warning: ${labError?.message || labError}]\n\n` +
            `Execute the original user request carefully as the main ComposeVC agent:\n\n${lastUserText}`,
          meta: { ok: false, warnings: [labError?.message || String(labError)], coverage: false },
        };
        mainProgress({
          type: "status",
          phase: "lab-in-fallback",
          label: "LAB-IN · preparation failed · main agent continuing…",
          agentMode: LAB_IN_MODE_ID,
        });
      }

      labInMeta = {
        ok: true,
        ...(pipeline?.meta || {}),
      };
      const stagedHandoff = Array.isArray(pipeline?.handoffMessages)
        ? pipeline.handoffMessages.filter((message) =>
            (message?.role === "user" || message?.role === "assistant") &&
            typeof message?.content === "string" &&
            message.content.trim()
          )
        : [];
      if (stagedHandoff.length > 1) {
        let lastUserIndex = -1;
        for (let index = requestMessages.length - 1; index >= 0; index -= 1) {
          if (requestMessages[index]?.role === "user") {
            lastUserIndex = index;
            break;
          }
        }
        const staged = stagedHandoff.map((message, index) => {
          const isFinalUser = message.role === "user" &&
            !stagedHandoff.slice(index + 1).some((later) => later?.role === "user");
          return isFinalUser && Array.isArray(lastUserMsg?.images) && lastUserMsg.images.length
            ? { ...message, images: lastUserMsg.images }
            : { ...message };
        });
        requestMessages = lastUserIndex >= 0
          ? [
              ...requestMessages.slice(0, lastUserIndex),
              ...staged,
              ...requestMessages.slice(lastUserIndex + 1),
            ]
          : [...requestMessages, ...staged];
        mainProgress({
          type: "status",
          phase: "lab-in-handoff",
          label: `LAB-IN · staged handoff · ${pipeline?.meta?.handoffPartCount || Math.floor(staged.length / 2)} knowledge parts acknowledged · main agent executing…`,
          agentMode: LAB_IN_MODE_ID,
        });
      } else {
        const handoff = String(pipeline?.handoffUserMessage || lastUserText);
        let replacedLab = false;
        requestMessages = requestMessages.map((message, index, all) => {
          if (replacedLab) return message;
          const isLastUser =
            message?.role === "user" && !all.slice(index + 1).some((item) => item?.role === "user");
          if (!isLastUser) return message;
          replacedLab = true;
          return { ...message, content: handoff };
        });
        if (!replacedLab) requestMessages = [...requestMessages, { role: "user", content: handoff }];
      }
      historyUserMessages = requestMessages;
      effectiveAgentMode = isFortani ? FORTANI_MODE_ID : LAB_IN_MODE_ID;
    }

    if (!mainProgress) {
      mainProgress = createThrottledProgressSender(event, {
        sessionId: runSessionId,
        agentId: overrides.agentId,
        progressChannel: overrides.progressChannel,
        telegramChatId: overrides.telegramChatId,
        telegramSlotId: overrides.telegramSlotId,
        onProgress: (progress) => {
          if (typeof overrides.onProgress === "function") {
            try {
              overrides.onProgress(progress);
            } catch {
              /* */
            }
          }
        },
      });
    }
    try {
      result = await runAgentLoop({
        provider,
        model,
        messages: requestMessages,
        systemPrompt,
        sessionId: runSessionId,
        customToolQuery: customToolQueryText,
        thinkingMax: request.thinkingMax === true,
        toolContext: {
          rootPath,
          projectName: request.projectName || null,
          userDataPath: app.getPath("userData"),
          customToolQuery: customToolQueryText,
          invalidateContext: () => invalidateContextCache(rootPath),
          onCustomToolsChanged: (payload) => {
            try {
              event.sender.send("customTools:changed", payload || { type: "changed" });
            } catch {
              // window may be gone
            }
          },
          onKnowledgeChanged: (payload) => broadcastKnowledgeChanged(payload),
          onMcpChanged: (payload) => {
            try { event.sender.send("mcp:changed", payload || { type: "changed" }); } catch {}
          },
        },
        signal: abortController.signal,
        tokenCountingMode: config.tokenCountingMode || "provider",
         maxContextTokens: modelContextTokens,
         autoCompactTokens: modelCompactTokens,
        rootPath,
        userDataPath: app.getPath("userData"),
        excludeToolNames,
        onMessagesChange: async (messages) => {
          if (!persistSession) return;
          const messagesToSave = isLabIn
            ? restoreLabInUserMessage(messages, originalLastUserMsg)
            : messages;
          await memory.saveSession(app, rootPath, sessionId, messagesToSave, {
            usage: result?.usage,
            contextTokens: result?.contextTokens,
            throttle: true,
          });
        },
        onProgress: mainProgress,
      });
      if (isFortani && result && !result.stopped && !abortController.signal.aborted) {
        const picked = resolveFortaniModel(config, model, provider);
        const fortaniContext = clampTokenSetting(
          picked.model?.contextLimit,
          modelContextTokens,
          { min: 8_000, max: ABSOLUTE_MAX_CONTEXT_TOKENS }
        );
        const fortaniModel = { ...picked.model, contextLimit: fortaniContext };
        try {
          mainProgress({
            type: "status",
            phase: "fortani",
            label: `FoRtani · checking what changed · ${picked.model?.name || picked.model?.id || "main"}…`,
            agentMode: FORTANI_MODE_ID,
          });
          const changes = await collectChangePacket(rootPath);
          const priorMessages = Array.isArray(result.messages) ? result.messages : requestMessages;
          const reviewRun = await runAgentLoop({
            provider: picked.provider,
            model: fortaniModel,
            messages: [
              ...priorMessages,
              { role: "user", content: buildReviewMessage(lastUserText, result.text, changes) },
            ],
            systemPrompt,
            sessionId: runSessionId,
            customToolQuery: customToolQueryText,
            thinkingMax: false,
            toolContext: {
              rootPath,
              projectName: request.projectName || null,
              userDataPath: app.getPath("userData"),
              customToolQuery: customToolQueryText,
              invalidateContext: () => invalidateContextCache(rootPath),
            },
            signal: abortController.signal,
            tokenCountingMode: config.tokenCountingMode || "provider",
            maxContextTokens: fortaniContext,
            autoCompactTokens: Math.max(4000, Math.floor(fortaniContext * 0.8)),
            rootPath,
            userDataPath: app.getPath("userData"),
            excludeToolNames: reviewExclusions(),
            onProgress: mainProgress,
          });
          if (reviewRun?.stopped || abortController.signal.aborted) {
            fortaniMeta = {
              ok: false,
              modelId: fortaniModel.id || null,
              modelName: fortaniModel.name || null,
              source: picked.source,
              warning: picked.warning,
              stopped: true,
            };
            result = { ...result, stopped: true };
          } else {
            const reviewText = String(reviewRun?.text || "").trim();
            mainProgress({
              type: "status",
              phase: "fortani-fix",
              label: "FoRtani · main agent applying the review…",
              agentMode: FORTANI_MODE_ID,
            });
            const fixRun = await runAgentLoop({
              provider,
              model,
              messages: [
                ...(Array.isArray(reviewRun?.messages) ? reviewRun.messages : priorMessages),
                { role: "user", content: buildFixMessage(lastUserText, reviewText) },
              ],
              systemPrompt,
              sessionId: runSessionId,
              customToolQuery: customToolQueryText,
              thinkingMax: request.thinkingMax === true,
              toolContext: {
                rootPath,
                projectName: request.projectName || null,
                userDataPath: app.getPath("userData"),
                customToolQuery: customToolQueryText,
                invalidateContext: () => invalidateContextCache(rootPath),
                onCustomToolsChanged: (payload) => {
                  try { event.sender.send("customTools:changed", payload || { type: "changed" }); } catch { /* window may be gone */ }
                },
                onKnowledgeChanged: (payload) => broadcastKnowledgeChanged(payload),
                onMcpChanged: (payload) => {
                  try { event.sender.send("mcp:changed", payload || { type: "changed" }); } catch { /* ignore */ }
                },
              },
              signal: abortController.signal,
              tokenCountingMode: config.tokenCountingMode || "provider",
              maxContextTokens: modelContextTokens,
              autoCompactTokens: modelCompactTokens,
              rootPath,
              userDataPath: app.getPath("userData"),
              excludeToolNames,
              onProgress: mainProgress,
            });
            fortaniMeta = {
              ok: !fixRun?.stopped,
              modelId: fortaniModel.id || null,
              modelName: fortaniModel.name || null,
              source: picked.source,
              warning: picked.warning,
              stopped: Boolean(fixRun?.stopped),
            };
            if (fixRun) result = fixRun;
          }
        } catch (fortaniError) {
          const aborted = abortController.signal.aborted || fortaniError?.name === "AbortError" || fortaniError?.stopped;
          fortaniMeta = {
            ok: false,
            modelId: fortaniModel.id || null,
            modelName: fortaniModel.name || null,
            source: picked.source,
            warning: picked.warning,
            stopped: Boolean(aborted),
            error: fortaniError?.message || String(fortaniError),
          };
          if (aborted) {
            result = { ...result, stopped: true };
          }
        }
      }
    } catch (error) {
      // All retries were exhausted (or a non-retryable error occurred). Safety net:
      // never leave the conversation in a broken/lost state — record what happened
      // as the assistant's turn so the user and future turns retain full context.
      const rawFailure = error?.message || error;
      const failureText = isCyberFlagErrorText(rawFailure)
        ? String(rawFailure)
        : `Request failed after multiple retries: ${rawFailure}`;
      let recoveredMessages = Array.isArray(error?.recoveredMessages) ? error.recoveredMessages : requestMessages;
      if (isLabIn) recoveredMessages = restoreLabInUserMessage(recoveredMessages, originalLastUserMsg);
      const fullHistory = [...recoveredMessages, { role: "assistant", content: failureText }];
      let saved = null;
      if (persistSession) {
        saved = await memory.saveSession(app, rootPath, sessionId, fullHistory, {
          usage: error?.usage || result?.usage,
          contextTokens: error?.contextTokens || result?.contextTokens,
          force: true,
        });
      }
      stoppedFlag = Boolean(error?.stopped);
      return {
        text: failureText,
        provider,
        model,
        sessionId: saved?.sessionId || runSessionId,
        sessionTitle: saved?.title,
        usage: error?.usage || result?.usage,
        contextTokens: error?.contextTokens || result?.contextTokens,
        stopped: stoppedFlag,
        labIn: labInMeta || undefined,
      };
    }

    // Prefer agent transcript. Ensure the latest real user request is never missing
    // (compact / tool-heavy turns can push it out of the keep-recent window).
    let fullHistory = Array.isArray(result.messages)
      ? result.messages
      : [...requestMessages, { role: "assistant", content: result.text }];
    if (isLabIn) fullHistory = restoreLabInUserMessage(fullHistory, originalLastUserMsg);
    {
      const lastUserWanted =
        typeof lastUserText === "string" && lastUserText.trim() ? lastUserText : null;
      if (lastUserWanted && Array.isArray(fullHistory)) {
        const wantedText = String(lastUserWanted).trim();
        // Multimodal content is string | ChatContentPart[] — never String(array) compare
        // (that becomes "[object Object],…" and falsely re-injects a second user bubble).
        const userTextOf = (m) => contentPartsToText(m?.content).trim();
        const hasUser = fullHistory.some(
          (m) => m?.role === "user" && userTextOf(m) === wantedText
        );
        // Image-only turns: lastUserText may be empty while lastUserMsg still exists.
        const hasImageOnlyUser =
          !wantedText &&
          lastUserMsg &&
          fullHistory.some(
            (m) =>
              m?.role === "user" &&
              ((Array.isArray(m.images) && m.images.length > 0) ||
                (Array.isArray(m.content) &&
                  m.content.some(
                    (p) =>
                      p &&
                      typeof p === "object" &&
                      (p.type === "image_url" || p.type === "image")
                  )))
          );
        if (!hasUser && !hasImageOnlyUser) {
          const inject = lastUserMsg
                ? {
                    role: "user",
                    content: lastUserMsg.content,
                    ...(Array.isArray(lastUserMsg.images) && lastUserMsg.images.length
                      ? { images: lastUserMsg.images }
                      : {}),
                  }
                : { role: "user", content: String(lastUserWanted) };
          // Insert before the first assistant/tool block of the last turn if possible,
          // otherwise append before trailing assistant text.
          let insertAt = fullHistory.length;
          for (let i = fullHistory.length - 1; i >= 0; i--) {
            if (fullHistory[i]?.role === "user") {
              insertAt = i + 1;
              break;
            }
            if (fullHistory[i]?.role === "assistant" || fullHistory[i]?.role === "tool") {
              insertAt = i;
            }
          }
          // If no user at all, put inject at the start of the trailing assistant/tool run.
          const anyUser = fullHistory.some((m) => m?.role === "user");
          if (!anyUser) {
            let i = fullHistory.length - 1;
            while (i >= 0 && (fullHistory[i]?.role === "assistant" || fullHistory[i]?.role === "tool")) i--;
            insertAt = i + 1;
          }
          fullHistory = [
            ...fullHistory.slice(0, insertAt),
            inject,
            ...fullHistory.slice(insertAt),
          ];
        }
      }
    }
    let saved = null;
    if (persistSession) {
      saved = await memory.saveSession(app, rootPath, sessionId, fullHistory, {
        usage: result.usage,
        contextTokens: result.contextTokens,
        force: true,
      });
    }

    // File restore is handled by per-project .backup (edit_file/create_file + restore_backup tool).
    // No full-tree timeline snapshots after each turn.

    stoppedFlag = Boolean(result.stopped);
    const responseAgentMode = effectiveAgentMode || agentMode;
    return {
      text: result.text,
      provider,
      model,
      sessionId: saved?.sessionId,
      sessionTitle: saved?.title,
      usage: result.usage,
      contextTokens: result.contextTokens,
      contextLimit: model.contextLimit,
      outputLimit: model.outputLimit,
      images:
        Array.isArray(result.images) && result.images.length ? result.images : undefined,
      stopped: result.stopped,
      agentMode: responseAgentMode,
      labIn: labInMeta || undefined,
      fortani: fortaniMeta || undefined,
      compactedMessages: result.compactionResult ? result.compactionResult.compactedMessages : undefined,
      compactionInfo: result.compactionResult
        ? {
            tokensBefore: result.compactionResult.tokensBefore,
            tokensAfter: result.compactionResult.tokensAfter,
            removedCount: result.compactionResult.removedCount,
          }
        : undefined,
    };
  } finally {
    try {
      if (typeof mainProgress?.flush === "function") mainProgress.flush();
      if (typeof mainProgress?.close === "function") mainProgress.close();
    } catch {
      /* */
    }
    chatSessions.unregister(runSessionId, abortController);
    try {
      event.sender.send("agent:run-state", {
        sessionId: runSessionId,
        running: false,
        stopped: stoppedFlag || Boolean(result?.stopped),
      });
    } catch {
      // ignore
    }
  }
}

ipcMain.handle("chat:send", async (event, request) => executeChatRequest(event, request));

ipcMain.handle("model:limits", async (_event, modelId) => {
  const config = await readProviderConfig();
  const model = config.models.find((item) => item.id === modelId);
  if (!model) return { context: null, output: null };
  const provider = config.providers.find((item) => item.id === model.providerId);
  if (!provider) return { context: normalizeContextLimit(model.contextLimit), output: model.outputLimit || null };

  const limits = await resolveAutomaticModelLimits(model, provider);
  const context = normalizeContextLimit(limits.context, model.contextLimit);
  const output = limits.output || model.outputLimit || null;
  const hasFreshLimits = limits.context != null && limits.context !== model.contextLimit;
  if (hasFreshLimits && (model.contextLimit !== context || (model.outputLimit || null) !== output)) {
    const models = config.models.map((item) =>
      item.id === model.id ? { ...item, contextLimit: context, outputLimit: output || undefined } : item
    );
    await writeProviderConfig({ ...config, models });
  }
  return { context, output };
});

ipcMain.handle("agent:answerUser", (_event, payload = {}) => {
  const id = payload.toolCallId || payload.id;
  if (!id) return { ok: false, error: "toolCallId is required" };
  return resolveUserAnswer(id, {
    answer: payload.answer,
    selected: payload.selected,
  });
});

ipcMain.handle("agent:notifyComplete", (event, payload = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const force = Boolean(payload.force);
  const isFocused = Boolean(win && !win.isDestroyed() && win.isFocused());
  if (isFocused && !force) return { shown: false, reason: "focused" };

  const body = String(payload.body || "Main agent finished working.");
  const soundPath = path.join(__dirname, "..", "logo", "notify-sms.wav");

  try {
    const focusMain = () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    };

    const theme = String(payload.theme || "mono");

    showAgentToast({
      appName,
      body,
      theme,
      anchorWin: win && !win.isDestroyed() ? win : mainWindow,
      onClick: focusMain,
    });

    if (win && !win.isDestroyed()) {
      win.webContents.send("agent:playCompleteSound", pathToFileURL(soundPath).toString());
      if (process.platform === "win32") {
        win.flashFrame(true);
        setTimeout(() => {
          if (!win.isDestroyed()) win.flashFrame(false);
        }, 5000);
      }
    }

    return { shown: true, mode: "custom-toast" };
  } catch (error) {
	    return { shown: false, reason: error instanceof Error ? error.message : "notify failed" };
	  }
	});

		ipcMain.handle("chat:send:legacy-disabled", async (event, request) => {  const config = await readProviderConfig();  let model = config.models.find((item) => item.id === request.modelId);
  if (!model) {
    throw new Error("Selected model not found");
  }

  const provider = config.providers.find((item) => item.id === model.providerId);
  if (!provider) {
    throw new Error("Provider for selected model not found");
  }

  if (!provider.apiKey) {
    throw new Error(`API key is empty for ${provider.name}`);
  }

  const automaticLimits = await resolveAutomaticModelLimits(model, provider);
  model = { ...model, contextLimit: automaticLimits.context, outputLimit: automaticLimits.output || undefined };
  const modelContextTokens = automaticLimits.context;
  const modelCompactTokens = Math.max(4_000, Math.floor(modelContextTokens * 0.8));

  const rootPath = request.rootPath || null;

  // Persist the user's message before contacting the network. If the request
  // below ultimately fails (after all retries), the conversation is never lost.
  let sessionId = request.sessionId;
  if (!sessionId) {
    const created = await memory.createSession(app, rootPath);
    sessionId = created.sessionId;
  }

  const storedSession = await memory.loadSession(app, rootPath, sessionId);
  const storedMessages = Array.isArray(storedSession?.messages) ? storedSession.messages : [];
  const incomingMessages = Array.isArray(request.messages) ? request.messages : [];
  // Prefer on-disk agent transcript (with tool calls/results) over UI projection.
  let requestMessages = mergeSessionMessages(storedMessages, incomingMessages);
  await memory.saveSession(app, rootPath, sessionId, requestMessages);

  const baseSystemPrompt = await buildSystemPrompt({ rootPath, projectName: request.projectName, userDataPath: app.getPath("userData") });
  const systemPrompt = baseSystemPrompt;

  const runSessionId = sessionId || `ephemeral-legacy-${Date.now().toString(16)}`;
  const abortController = new AbortController();
  const slotCheckLegacy = chatSessions.tryRegister(runSessionId, abortController);
  if (!slotCheckLegacy.ok) {
    if (slotCheckLegacy.reason === "already_running") {
      throw new Error("This chat session is already running. Wait for it to finish or press Stop.");
    }
    if (slotCheckLegacy.reason === "max_parallel") {
      throw new Error(
        `Too many chats running at once (${slotCheckLegacy.running}/${slotCheckLegacy.limit}). ` +
          `Wait for one to finish or press Stop — max ${chatSessions.MAX_PARALLEL_CHAT_SESSIONS} parallel chats.`
      );
    }
    throw new Error("Cannot start chat session.");
  }
  try {
    event.sender.send("agent:run-state", { sessionId: runSessionId, running: true });
  } catch {
    // ignore
  }

  let result;
  const legacyProgress = createThrottledProgressSender(event, { sessionId: runSessionId });
  try {
    result = await runAgentLoop({
      provider,
      model,
      messages: requestMessages,
      systemPrompt,
      sessionId: runSessionId,
      toolContext: {
        rootPath,
        projectName: request.projectName || null,
        userDataPath: app.getPath("userData"),
        invalidateContext: () => invalidateContextCache(rootPath),
      },
      signal: abortController.signal,
      tokenCountingMode: config.tokenCountingMode || "provider",
      maxContextTokens: modelContextTokens,
      autoCompactTokens: modelCompactTokens,
      onMessagesChange: async (messages) => {
        await memory.saveSession(app, rootPath, sessionId, messages, {
          usage: result?.usage,
          contextTokens: result?.contextTokens,
          throttle: true,
        });
      },
      onProgress: legacyProgress,
    });
  } catch (error) {
    // All retries were exhausted (or a non-retryable error occurred). Safety net:
    // never leave the conversation in a broken/lost state — record what happened
    // as the assistant's turn so the user and future turns retain full context.
    const rawFailureLegacy = error?.message || error;
    const failureText = isCyberFlagErrorText(rawFailureLegacy)
      ? String(rawFailureLegacy)
      : `Request failed after multiple retries: ${rawFailureLegacy}`;
    const recoveredMessages = Array.isArray(error?.recoveredMessages) ? error.recoveredMessages : requestMessages;
    const fullHistory = [...recoveredMessages, { role: "assistant", content: failureText }];
    const saved = await memory.saveSession(app, rootPath, sessionId, fullHistory, {
      usage: error?.usage || result?.usage,
      contextTokens: error?.contextTokens || result?.contextTokens,
    });
    return {
      text: failureText,
      provider,
      model,
      sessionId: saved?.sessionId,
      sessionTitle: saved?.title,
      failed: true,
    };
  } finally {
    try {
      if (typeof legacyProgress?.flush === "function") legacyProgress.flush();
      if (typeof legacyProgress?.close === "function") legacyProgress.close();
    } catch {
      /* */
    }
    chatSessions.unregister(runSessionId, abortController);
    try {
      event.sender.send("agent:run-state", { sessionId: runSessionId, running: false });
    } catch {
      // ignore
    }
  }

  const baseMessages = result.compactionResult ? result.compactionResult.compactedMessages : requestMessages;
  const fullHistory = Array.isArray(result.messages) ? result.messages : [...baseMessages, { role: "assistant", content: result.text }];
  const saved = await memory.saveSession(app, rootPath, sessionId, fullHistory, {
    usage: result.usage,
    contextTokens: result.contextTokens,
    force: true,
  });

  // File restore: project .backup via edit_file/create_file + restore_backup tool (no timeline).

  return {
    text: result.text,
    provider,
    model,
    sessionId: saved?.sessionId,
    sessionTitle: saved?.title,
    usage: result.usage,
    contextTokens: result.contextTokens,
    images:
      Array.isArray(result.images) && result.images.length ? result.images : undefined,
    stopped: result.stopped,
    compactedMessages: result.compactionResult ? result.compactionResult.compactedMessages : undefined,
    compactionInfo: result.compactionResult
      ? {
          tokensBefore: result.compactionResult.tokensBefore,
          tokensAfter: result.compactionResult.tokensAfter,
          removedCount: result.compactionResult.removedCount,
        }
      : undefined,
  };
});

ipcMain.handle("chat:compact", async (_event, request) => {
  const config = await readProviderConfig();
  const model = config.models.find((item) => item.id === request.modelId);
  if (!model) {
    throw new Error("Selected model not found");
  }

  const provider = config.providers.find((item) => item.id === model.providerId);
  if (!provider) {
    throw new Error("Provider for selected model not found");
  }

  if (!provider.apiKey) {
    throw new Error(`API key is empty for ${provider.name}`);
  }

  const sessionId = request.sessionId || null;
  const rootPath = request.rootPath || null;
  const userDataPath = app.getPath("userData");
  const messages = Array.isArray(request.messages) ? request.messages : [];

  const result = await compactMessages({
    provider,
    model,
    messages,
    keepRecent: request.keepRecent,
    tokenCountingMode: config.tokenCountingMode || "provider",
  });
  trackExternalUsage({
    userDataPath,
    provider,
    model,
    usage: result.usage,
  });

  if (sessionId) {
    await memory.saveSession(app, rootPath, sessionId, result.compactedMessages, {
      contextTokens:
        typeof result.tokensAfter === "number" && result.tokensAfter > 0
          ? result.tokensAfter
          : undefined,
      force: true,
    });
  }

  return result;
});

ipcMain.handle("memory:loadSession", async (_event, rootPath, sessionId) => {
  return memory.loadSession(app, rootPath || null, sessionId || null);
});

ipcMain.handle("memory:listSessions", async (_event, rootPath) => {
  return memory.listSessions(app, rootPath || null);
});

ipcMain.handle("memory:listSessionsPage", async (_event, rootPath, options) => {
  return memory.listSessionsPage(app, rootPath || null, options || {});
});

ipcMain.handle("memory:createSession", async (_event, rootPath, options) => {
  return memory.createSession(app, rootPath || null, options || {});
});

ipcMain.handle("memory:listChatBookmarks", async () => {
  return memory.listChatBookmarks(app);
});

ipcMain.handle("memory:saveChatBookmark", async (_event, input) => {
  return memory.saveChatBookmark(app, input || {});
});

ipcMain.handle("memory:deleteChatBookmark", async (_event, bookmarkId) => {
  return memory.deleteChatBookmark(app, bookmarkId);
});

ipcMain.handle("memory:copySession", async (_event, rootPath, sessionId) => {
  const result = await memory.copySession(app, rootPath || null, sessionId);
  if (result.copied && result.sessionId) clipboard.writeText(result.sessionId);
  return result;
});

ipcMain.handle("memory:pasteSession", async (_event, rootPath) => {
  const sourceSessionId = clipboard.readText().trim();
  return memory.pasteSession(app, rootPath || null, sourceSessionId);
});

ipcMain.handle("memory:deleteSession", async (_event, rootPath, sessionId) => {
  return memory.deleteSession(app, rootPath || null, sessionId);
});

ipcMain.handle("memory:updateSessionMeta", async (_event, rootPath, sessionId, patch) => {
  return memory.updateSessionMeta(app, rootPath || null, sessionId, patch || {});
});

ipcMain.handle("memory:clearSessionTranscript", async (_event, rootPath, sessionId, options) => {
  return memory.clearSessionTranscript(app, rootPath || null, sessionId, options || {});
});

ipcMain.handle("knowledge:list", async () => {
  const userDataPath = app.getPath("userData");
  const [manifest, stats] = await Promise.all([
    knowledgeStore.readManifest(userDataPath),
    knowledgeStore.knowledgeStats(userDataPath),
  ]);
  return {
    ...stats,
    chunks: manifest.chunks.slice().sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
  };
});

ipcMain.handle("knowledge:read", async (_event, id) => {
  return knowledgeStore.getKnowledgeChunk(app.getPath("userData"), id);
});

ipcMain.handle("knowledge:create", async (_event, input) => {
  const result = await knowledgeStore.addKnowledge(app.getPath("userData"), {
    ...(input || {}),
    source: input?.source || "knowledge-workspace",
  });
  broadcastKnowledgeChanged({ type: "added", chunks: result.created || [] });
  return result;
});

ipcMain.handle("knowledge:update", async (_event, id, patch) => {
  const chunk = await knowledgeStore.updateKnowledge(app.getPath("userData"), {
    ...(patch || {}),
    id,
  });
  broadcastKnowledgeChanged({ type: "updated", chunk });
  return chunk;
});

ipcMain.handle("knowledge:delete", async (_event, id) => {
  const result = await knowledgeStore.deleteKnowledge(app.getPath("userData"), id);
  broadcastKnowledgeChanged({ type: "deleted", chunkId: id });
  return result;
});

ipcMain.handle("knowledge:export", async (_event, payload = {}) => {
  return knowledgeArchive.exportKnowledgeArchive(app.getPath("userData"), {
    desktopPath: app.getPath("desktop"),
    rootPath: typeof payload?.rootPath === "string" ? payload.rootPath : null,
  });
});

ipcMain.handle("knowledge:import", async (event, payload = {}) => {
  let zipPath = typeof payload?.zipPath === "string" ? payload.zipPath.trim() : "";
  if (!zipPath) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const parent = win && !win.isDestroyed() ? win : mainWindow;
    const options = {
      title: "Import knowledge archive",
      buttonLabel: "Import ZIP",
      properties: ["openFile"],
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
    zipPath = picked.filePaths[0];
  }

  const result = await knowledgeArchive.importKnowledgeArchive(
    app.getPath("userData"),
    zipPath
  );
  broadcastKnowledgeChanged({ type: "imported", chunks: result.created || [] });
  return result;
});

ipcMain.handle("docs:list", async () => {
  await docsStore.seedIfEmpty(app.getPath("userData"));
  return docsStore.listDocs(app.getPath("userData"));
});

ipcMain.handle("docs:read", async (_event, id) => {
  await docsStore.seedIfEmpty(app.getPath("userData"));
  return docsStore.getDocsSection(app.getPath("userData"), id);
});

ipcMain.handle("docs:all", async () => {
  await docsStore.seedIfEmpty(app.getPath("userData"));
  return docsStore.getAllDocs(app.getPath("userData"));
});

ipcMain.handle("docs:create", async (_event, input) => {
  const section = await docsStore.upsertDocsSection(app.getPath("userData"), input || {});
  broadcastDocsChanged({ type: "changed" });
  return section;
});

ipcMain.handle("docs:update", async (_event, id, patch) => {
  const section = await docsStore.upsertDocsSection(app.getPath("userData"), { ...(patch || {}), id });
  broadcastDocsChanged({ type: "changed" });
  return section;
});

ipcMain.handle("docs:delete", async (_event, id) => {
  const result = await docsStore.deleteDocsSection(app.getPath("userData"), id);
  broadcastDocsChanged({ type: "changed" });
  return result;
});

// ── Prompts: user prompt snippets for the Шторы "Prompts" tab ─────────────

ipcMain.handle("prompts:list", async () => {
  try {
    return await promptsStore.readAll(app.getPath("userData"));
  } catch (error) {
    return {
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      prompts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
});

ipcMain.handle("prompts:create", async (_event, input) => {
  const prompt = await promptsStore.create(app.getPath("userData"), input || {});
  broadcastPromptsChanged({ type: "changed" });
  return prompt;
});

ipcMain.handle("prompts:update", async (_event, id, patch) => {
  const prompt = await promptsStore.update(app.getPath("userData"), id, patch || {});
  broadcastPromptsChanged({ type: "changed" });
  return prompt;
});

ipcMain.handle("prompts:delete", async (_event, id) => {
  const result = await promptsStore.remove(app.getPath("userData"), id);
  broadcastPromptsChanged({ type: "changed" });
  return result;
});

ipcMain.handle("prompts:copy", async (_event, id) => {
  try {
    if (typeof id !== "string" || !id) return { ok: false, error: "Не указан id промта." };
    const store = await promptsStore.readAll(app.getPath("userData"));
    const prompt = store.prompts.find((entry) => entry.id === id);
    if (!prompt) return { ok: false, error: "Промт не найден." };
    if (!prompt.text) return { ok: false, error: "Текст промта пуст." };
    clipboard.writeText(prompt.text);
    return { ok: true, title: prompt.title };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Real token count of the current system prompt (project tree, git status, etc.)
// for this rootPath — used by the renderer for context-usage estimate.
ipcMain.handle("context:estimateTokens", async (_event, rootPath, projectName) => {
  const prompt = await buildSystemPrompt({ rootPath: rootPath || null, projectName, userDataPath: app.getPath("userData") });
  return countTokens(prompt);
});

function broadcastCustomToolsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("customTools:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

function broadcastKnowledgeChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("knowledge:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

function broadcastDocsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("docs:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

function broadcastPromptsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("prompts:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

// ── PLUGINS: built-in capabilities with their own AI tools (Blender first) ──

blenderPlugin.setProgressSink((payload) => broadcastPluginJob(payload));

function broadcastPluginsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("plugins:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

function broadcastPluginJob(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("plugins:job", payload || {});
    } catch {
      // ignore
    }
  }
}

function pluginsUserData() {
  return app.getPath("userData");
}

/** Jobs travel over IPC without heavy internal fields (driverResult, logs, scene dumps). */
function publicPluginJob(job) {
  if (!job) return null;
  const stats = job.stats || {};
  const addons = Array.isArray(job.addons) ? job.addons : [];
  return {
    id: job.id,
    pluginId: job.pluginId,
    kind: job.kind,
    title: job.title,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    dir: job.dir,
    blendPath: job.blendPath,
    previewPath: job.previewPath,
    renders: job.renders || [],
    bakes: job.bakes || [],
    exports: job.exports || [],
    logPath: job.logPath,
    error: job.error,
    warnings: job.warnings || [],
    addons,
    quality: job.quality || null,
    summary: job.summary,
    stats: {
      objects: stats.objects || 0,
      meshes: stats.meshes || 0,
      polygons: stats.polygons || 0,
      vertices: stats.vertices || 0,
      materials: stats.materials || 0,
      lights: stats.lights || 0,
      cameras: stats.cameras || 0,
      images: stats.images || 0,
    },
    blender: job.blender || { path: "", version: "", engine: "" },
  };
}

function buildBlenderDemoPlan(config) {
  const resolution = config?.resolution || { width: 1400, height: 900 };
  const width = Math.max(640, Math.min(1400, Number(resolution.width) || 1400));
  const height = Math.max(480, Math.min(900, Number(resolution.height) || 900));
  return {
    name: "Демо: энергетический кристалл",
    reset: true,
    materials: [
      {
        name: "CV Stone",
        preset: "stone",
        base_color: "#2b2e35",
        texture: {
          type: "noise",
          scale: 9,
          detail: 10,
          color_a: "#15181d",
          color_b: "#3f4652",
          bump: 0.35,
          roughness_map: true,
          roughness_min: 0.35,
          roughness_max: 0.85,
        },
      },
      { name: "CV Gold", preset: "gold", roughness: 0.2, anisotropic: 0.35 },
      {
        name: "CV Crystal",
        preset: "glass",
        base_color: "#2ee6ff",
        roughness: 0.08,
        transmission: 0.85,
        ior: 1.45,
        coat: 0.4,
        emission: "#18d7ff",
        emission_strength: 2.4,
      },
    ],
    objects: [
      { name: "Floor", type: "cylinder", radius: 3.4, depth: 0.16, location: [0, 0, -0.08], material: "CV Stone", uv: { margin: 0.02 } },
      {
        name: "Pedestal",
        type: "cylinder",
        radius: 0.9,
        depth: 0.9,
        vertices: 64,
        bevel: { width: 0.035, segments: 3 },
        location: [0, 0, 0.45],
        material: "CV Stone",
        smooth: true,
        uv: { margin: 0.02 },
      },
      {
        name: "Ring",
        type: "torus",
        major_radius: 0.95,
        minor_radius: 0.05,
        major_segments: 64,
        minor_segments: 16,
        location: [0, 0, 0.92],
        material: "CV Gold",
        smooth: true,
      },
      {
        name: "Crystal",
        type: "ico_sphere",
        subdivisions: 1,
        radius: 0.62,
        location: [0, 0, 1.75],
        scale: [0.72, 0.72, 1.5],
        rotation: [0, 0, 18],
        material: "CV Crystal",
        animation: {
          rotation: [
            { frame: 1, value: [0, 0, 18] },
            { frame: 120, value: [0, 0, 378] },
          ],
          interpolation: "LINEAR",
        },
      },
    ],
    lighting: "dramatic",
    camera: { view: "hero", lens: 58, look_at: [0, 0, 0.95] },
    animation: { frame_start: 1, frame_end: 120, fps: 30 },
    optimize: { apply_scale: true, origin: "center_floor" },
    quality: { require_textures: true, require_uv: true },
    render: {
      engine: config?.engine || "EEVEE",
      resolution: [resolution.width, resolution.height],
      samples: Math.min(96, config?.samples || 64),
      views: ["hero", "three_quarter"],
      turntable: { frames: 3 },
      effects: { bloom: { type: "Fog Glow", threshold: 0.8, strength: 0.7, size: 0.7 }, chromatic: 0.02 },
    },
    export: { preset: "unity", filepath: "crystal.glb" },
    save: "crystal.blend",
  };
}

ipcMain.handle("plugins:list", async () => {
  try {
    const state = await pluginsRegistry.listPlugins(pluginsUserData());
    return {
      ...state,
      plugins: state.plugins.map((plugin) => ({ ...plugin, lastJob: publicPluginJob(plugin.lastJob) })),
    };
  } catch (error) {
    return { ok: false, plugins: [], jobsRoot: "", error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:get", async (_event, id) => {
  try {
    return { ok: true, plugin: await pluginsRegistry.getPlugin(pluginsUserData(), String(id || "blender")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:update", async (_event, id, patch) => {
  try {
    const plugin = await pluginsRegistry.updatePlugin(pluginsUserData(), String(id || "blender"), patch || {});
    broadcastPluginsChanged({ type: "updated", pluginId: plugin.id });
    return { ok: true, plugin };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:probe", async (_event, id) => {
  try {
    const pluginId = String(id || "blender");
    if (pluginId !== "blender") return { ok: false, error: "Для этого плагина нет опроса возможностей." };
    const config = await pluginsRegistry.configForBlender(pluginsUserData());
    const probe = await blenderPlugin.probe(pluginsUserData(), config);
    return { ok: Boolean(probe.ok), probe };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:jobs", async (_event, options) => {
  try {
    const jobs = await pluginsRegistry.jobs(pluginsUserData(), {
      limit: Number(options?.limit) || 40,
      pluginId: options?.pluginId || undefined,
    });
    return { ok: true, jobs: jobs.map(publicPluginJob), running: blenderPlugin.listRunning() };
  } catch (error) {
    return { ok: false, jobs: [], error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:job", async (_event, jobId) => {
  try {
    const job = await pluginsRegistry.job(pluginsUserData(), String(jobId || ""));
    if (!job) return { ok: false, error: "Задача не найдена." };
    return { ok: true, job: publicPluginJob(job) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:cancel", async (_event, jobId) => {
  try {
    const result = pluginsRegistry.cancel(String(jobId || ""));
    if (result.canceled) broadcastPluginsChanged({ type: "job-canceled", jobId });
    return { ok: result.canceled, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:log", async (_event, jobId) => {
  try {
    const job = await pluginsRegistry.job(pluginsUserData(), String(jobId || ""));
    if (!job) return { ok: false, error: "Задача не найдена." };
    const logPath = job.logPath || require("path").join(job.dir, "log.txt");
    const stat = await fs.promises.stat(logPath).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, error: "Лог пока пуст." };
    const size = Number(stat.size) || 0;
    const take = Math.min(size, 64000);
    const handle = await fs.promises.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(take);
      await handle.read(buffer, 0, take, Math.max(0, size - take));
      return { ok: true, log: buffer.toString("utf8"), path: logPath, size };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:deleteJob", async (_event, jobId) => {
  try {
    const result = await pluginsRegistry.deleteJob(pluginsUserData(), String(jobId || ""));
    broadcastPluginsChanged({ type: "job-deleted", jobId });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:preview", async (_event, jobId, name) => {
  try {
    const preview = await blenderPlugin.readPreviewDataUrl(pluginsUserData(), String(jobId || ""), name || "");
    return { ok: true, ...preview };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:pickExecutable", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: "Путь к Blender",
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [{ name: "Blender", extensions: ["exe"] }]
          : [{ name: "Все файлы", extensions: ["*"] }],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:pickDirectory", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = { title: "Папка результатов", properties: ["openDirectory", "createDirectory"] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.length) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:copyArtifacts", async (_event, jobId, targetDir) => {
  try {
    const result = await pluginsRegistry.copyArtifacts(pluginsUserData(), String(jobId || ""), targetDir || "");
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:openPath", async (_event, jobId, target) => {
  try {
    const root = require("path").join(app.getPath("userData"), "plugins");
    let dir = String(target || "");
    if (jobId) {
      const job = await pluginsRegistry.job(pluginsUserData(), String(jobId));
      dir = job?.dir || dir;
    }
    if (!dir) return { ok: false, error: "Папка не найдена." };
    const resolved = require("path").resolve(dir);
    const relative = require("path").relative(root, resolved);
    if (relative.startsWith("..") || require("path").isAbsolute(relative)) {
      return { ok: false, error: "Можно открывать только папки плагинов." };
    }
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true, path: resolved };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:openInBlender", async (_event, jobId, blendPath) => {
  try {
    const config = await pluginsRegistry.configForBlender(pluginsUserData());
    let file = String(blendPath || "");
    if (!file && jobId) {
      const job = await pluginsRegistry.job(pluginsUserData(), String(jobId));
      file = job?.blendPath || "";
    }
    if (!file) return { ok: false, error: "У задачи нет .blend файла." };
    const opened = await blenderPlugin.openInBlender(config, file);
    return { ok: true, ...opened };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("plugins:runDemo", async (_event, id) => {
  try {
    const pluginId = String(id || "blender");
    if (pluginId !== "blender") return { ok: false, error: "Демо есть только для Blender." };
    const plugin = await pluginsRegistry.getPlugin(pluginsUserData(), "blender");
    if (!plugin.enabled) return { ok: false, error: "Плагин Blender выключен." };
    const job = await blenderPlugin.runPlan(pluginsUserData(), plugin.config, buildBlenderDemoPlan(plugin.config), {
      title: "Демо: энергетический кристалл",
      kind: "demo",
    });
    broadcastPluginsChanged({ type: "job-finished", jobId: job.id, status: job.status });
    return { ok: job.status === "succeeded", job: publicPluginJob(job), error: job.error || "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message, checked: error?.checked || [] };
  }
});

// ── STORAGE: Telegram Saved Messages cloud drive ───────────────────────────
ipcMain.handle("storage:accounts", async () => {
  try {
    const context = { userDataPath: app.getPath("userData") };
    const listed = await telegramTool.execute({ action: "list_accounts" }, context);
    const accounts = [];
    for (const account of listed.accounts || []) {
      try {
        const me = await telegramTool.execute({ action: "get_me", phone: account.phone }, context);
        accounts.push({ phone: account.phone, name: me.name || account.name, username: me.username || account.username, isPremium: Boolean(me.isPremium) });
      } catch { accounts.push({ ...account, isPremium: false, error: "session unavailable" }); }
    }
    return { ok: true, accounts };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("storage:pick", async () => {
  const result = await dialog.showOpenDialog({ title: "Добавить в Telegram STORAGE", properties: ["openFile", "multiSelections"] });
  if (result.canceled) return { ok: true, canceled: true, files: [] };
  const files = [];
  for (const filePath of result.filePaths) { const stat = await fs.promises.stat(filePath); files.push({ path: filePath, name: path.basename(filePath), size: stat.size }); }
  return { ok: true, files };
});
ipcMain.handle("storage:upload", async (_event, input = {}) => {
  try {
    const ud = app.getPath("userData"); const phone = String(input.phone || ""); const filePath = String(input.filePath || input.path || "");
    if (!phone) throw new Error("Select a Telegram account");
    const me = await telegramTool.execute({ action: "get_me", phone }, { userDataPath: ud });
    const isPremium = Boolean(me.isPremium);
    const stat = await fs.promises.stat(filePath); const max = isPremium ? 4 * 1024 ** 3 : 2 * 1024 ** 3;
    if (!stat.isFile()) throw new Error("Файл не найден");
    if (stat.size > max) throw new Error(`Лимит аккаунта: ${isPremium ? "4 ГБ" : "2 ГБ"}`);
    const queued = await telegramTool.execute({ action: "send_file", phone, chat: "me", path: filePath, premium: isPremium, caption: input.caption }, { userDataPath: ud });
    if (!queued.ok) throw new Error(queued.error || "Не удалось поставить загрузку в очередь");
    const item = await storageStore.add(ud, { phone, name: path.basename(filePath), path: filePath, size: stat.size, jobId: queued.jobId, status: "queued", progress: 0 });
    return { ok: true, item };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("storage:list", async () => {
  const ud = app.getPath("userData"); const items = storageStore.read(ud);
  for (const item of items.filter((entry) => entry.jobId && ["queued", "uploading"].includes(entry.status))) {
    try {
      const status = await telegramTool.execute({ action: "upload_status", jobId: item.jobId }, { userDataPath: ud });
      await storageStore.update(ud, item.id, { status: status.status, progress: status.progress ?? (status.status === "completed" ? 1 : item.progress), uploaded: status.uploaded || 0, error: status.error || null, resultId: status.resultId || null });
    } catch {}
  }
  return { ok: true, items: storageStore.read(ud) };
});
ipcMain.handle("storage:deleteHistory", async (_event, id) => ({ ok: await storageStore.remove(app.getPath("userData"), String(id || "")) }));

ipcMain.handle("mcp:list", async () => mcpManager.listServers(app.getPath("userData")));
ipcMain.handle("mcp:add", async (_event, input = {}) => {
  const server = await mcpManager.addServer(app.getPath("userData"), input);
  broadcastMcpChanged({ type: "added", server });
  return server;
});
ipcMain.handle("mcp:update", async (_event, id, patch = {}) => {
  const server = await mcpManager.updateServer(app.getPath("userData"), id, patch);
  broadcastMcpChanged({ type: "updated", server });
  return server;
});
ipcMain.handle("mcp:remove", async (_event, id) => {
  const result = await mcpManager.removeServer(app.getPath("userData"), id);
  broadcastMcpChanged({ type: "removed", server: result.server });
  return result;
});
ipcMain.handle("mcp:connect", async (_event, id) => {
  const entry = await mcpManager.connect(app.getPath("userData"), id, { force: true });
  broadcastMcpChanged({ type: "status", name: entry.server.name });
  return { server: entry.server, tools: entry.tools };
});
ipcMain.handle("mcp:disconnect", async (_event, id) => {
  const result = await mcpManager.disconnect(app.getPath("userData"), id);
  broadcastMcpChanged({ type: "status", name: result.name });
  return result;
});
ipcMain.handle("mcp:refresh", async (_event, id) => {
  const result = await mcpManager.refresh(app.getPath("userData"), id);
  broadcastMcpChanged({ type: "status", name: result.server.name });
  return result;
});
ipcMain.handle("mcp:inspect", async (_event, id) => mcpManager.inspectServer(app.getPath("userData"), id));
ipcMain.handle("mcp:import", async (_event, config, options = {}) => {
  const result = await mcpManager.importConfig(app.getPath("userData"), config, options);
  broadcastMcpChanged({ type: "changed" });
  return result;
});
ipcMain.handle("mcp:registrySearch", async (_event, options = {}) => {
  const { searchRegistry } = require("./mcpRegistry.cjs");
  return searchRegistry(options || {});
});
ipcMain.handle("mcp:registryInstall", async (_event, raw, overrides = {}) => {
  const result = await mcpManager.installRegistryServer(app.getPath("userData"), raw, overrides || {});
  broadcastMcpChanged({ type: result.already ? "status" : "added", server: result.server });
  return result;
});
ipcMain.handle("mcp:projectList", async (_event, rootPath) => {
  return mcpManager.listProjectServers(app.getPath("userData"), rootPath || null);
});
ipcMain.handle("mcp:projectSet", async (_event, rootPath, serverId, enabled) => {
  const result = await mcpManager.setProjectServer(app.getPath("userData"), rootPath || null, serverId, enabled === true);
  broadcastMcpChanged({ type: "project", server: result.server, rootPath: result.rootPath });
  return result;
});

function broadcastMcpChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("mcp:changed", payload || { type: "changed" }); } catch {}
  }
}

ipcMain.handle("customTools:read", async () => {
  return customTools.readCustomTools(app.getPath("userData"));
});

ipcMain.handle("customTools:add", async (_event, toolData) => {
  const tool = await customTools.addCustomTool(app.getPath("userData"), toolData || {});
  broadcastCustomToolsChanged({ type: "added", tool });
  return tool;
});

ipcMain.handle("customTools:update", async (_event, toolId, toolData) => {
  const tool = await customTools.updateCustomTool(app.getPath("userData"), toolId, toolData || {});
  broadcastCustomToolsChanged({ type: "updated", tool });
  return tool;
});

ipcMain.handle("customTools:readFile", async (_event, toolId) => {
  const userDataPath = app.getPath("userData");
  const tool = await customTools.findCustomTool(userDataPath, { id: String(toolId || "") });
  if (!tool) throw new Error("Custom tool not found");
  const toolDir =
    tool.path ||
    tool.folder ||
    tool.body?.toolDir ||
    customTools.folderTools.getToolDir(userDataPath, tool.name);
  const rel = tool.entry || tool.body?.entry || "main.js";
  const abs = customTools.folderTools.safeResolveInside(toolDir, String(rel));
  const fsMod = require("fs");
  const content = await fsMod.promises.readFile(abs, "utf8");
  return {
    ok: true,
    id: tool.id,
    name: tool.name,
    path: abs,
    file: String(rel).replace(/\\/g, "/"),
    runtime: tool.runtime || tool.body?.runtime || "node",
    content,
  };
});

ipcMain.handle("customTools:remove", async (_event, toolId) => {
  const result = await customTools.removeCustomTool(app.getPath("userData"), toolId);
  if (result?.deleted) {
    broadcastCustomToolsChanged({ type: "removed", toolId, tool: result.tool });
  }
  return result;
});

ipcMain.handle("customTools:export", async (_event, options = {}) => {
  const userDataPath = app.getPath("userData");
  const opts = options && typeof options === "object" ? options : {};
  const saveToFile = opts.saveToFile === true || opts.dialog === true;
  const forceJson = opts.format === "json" || opts.json === true;
  const forceZip =
    opts.format === "zip" ||
    opts.zip === true ||
    (typeof opts.path === "string" && customTools.toolZip.looksLikeZipPath(opts.path)) ||
    (typeof opts.filePath === "string" && customTools.toolZip.looksLikeZipPath(opts.filePath));

  if (saveToFile) {
    const stamp = new Date().toISOString().slice(0, 10);
    const nameHint =
      Array.isArray(opts.names) && opts.names.length === 1
        ? String(opts.names[0])
        : typeof opts.name === "string" && opts.name
          ? String(opts.name)
          : Array.isArray(opts.ids) && opts.ids.length === 1
            ? "tool"
            : null;
    const useZip = !forceJson;
    const defaultName = useZip
      ? nameHint
        ? `lopster-tool-${nameHint}.zip`
        : `lopster-custom-tools-${stamp}.zip`
      : nameHint
        ? `lopster-tool-${nameHint}.json`
        : `lopster-custom-tools-${stamp}.json`;
    const win = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showSaveDialog(win || undefined, {
      title: "Export custom tools",
      defaultPath: defaultName,
      filters: useZip
        ? [
            { name: "ZIP (folder tools)", extensions: ["zip"] },
            { name: "JSON (custom tools pack)", extensions: ["json"] },
            { name: "All files", extensions: ["*"] },
          ]
        : [
            { name: "JSON", extensions: ["json"] },
            { name: "ZIP (folder tools)", extensions: ["zip"] },
            { name: "All files", extensions: ["*"] },
          ],
    });
    if (picked.canceled || !picked.filePath) {
      return { ok: false, saved: false, canceled: true, count: 0, format: useZip ? "zip" : "json" };
    }
    let outPath = String(picked.filePath);
    const pickedJson = /\.json$/i.test(outPath);
    let pickedZip = customTools.toolZip.looksLikeZipPath(outPath);
    if (useZip && !pickedZip && !pickedJson) {
      outPath = `${outPath}.zip`;
      pickedZip = true;
    }
    const wantZipOut = pickedZip || (useZip && !pickedJson);
    const result = await customTools.exportCustomTools(userDataPath, {
      ...opts,
      path: outPath,
      filePath: outPath,
      format: wantZipOut ? "zip" : "json",
      zip: wantZipOut,
    });
    return { ...result, saved: true, path: result.path || outPath, canceled: false };
  }

  if (forceZip) {
    const result = await customTools.exportCustomTools(userDataPath, {
      ...opts,
      format: "zip",
      zip: true,
    });
    return { ...result, canceled: false };
  }

  const result = await customTools.exportCustomTools(userDataPath, opts);
  return { ...result, saved: Boolean(result.saved), canceled: false };
});

ipcMain.handle("customTools:importPreview", async (_event, payload = {}) => {
  let source = payload?.source ?? payload?.text ?? payload?.json ?? payload?.pack ?? null;
  let fromPath = payload?.path || payload?.filePath || payload?.zip || null;
  if (payload?.dialog === true || payload?.openDialog === true) {
    const win = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: "Import custom tools",
      properties: ["openFile"],
      filters: [
        { name: "ZIP / JSON", extensions: ["zip", "json"] },
        { name: "ZIP (folder tools)", extensions: ["zip"] },
        { name: "JSON (custom tools pack)", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || !picked.filePaths?.length) {
      return {
        ok: false,
        canceled: true,
        count: 0,
        totalInPack: 0,
        tools: [],
        path: null,
        text: null,
        format: null,
      };
    }
    fromPath = picked.filePaths[0];
  }

  const isZip =
    (typeof fromPath === "string" && customTools.toolZip.looksLikeZipPath(fromPath)) ||
    payload?.format === "zip" ||
    payload?.zip === true;

  if (isZip && fromPath) {
    const preview = await customTools.toolZip.previewToolsFromZip(String(fromPath), {
      names: payload?.names,
      name: payload?.name,
      tool: payload?.tool,
    });
    return {
      ...preview,
      canceled: false,
      path: fromPath,
      text: null,
      format: "zip",
    };
  }

  if (fromPath && !source) {
    source = await fs.promises.readFile(String(fromPath), "utf8");
  }
  if (source == null) {
    throw new Error("importPreview requires source/text/json or path/dialog (.zip or .json)");
  }
  const preview = customTools.previewCustomToolsImport(source, {
    names: payload?.names,
    name: payload?.name,
    tool: payload?.tool,
    ids: payload?.ids,
    indices: payload?.indices,
    onlyOne: payload?.onlyOne === true,
  });
  const text = typeof source === "string" ? source : JSON.stringify(source, null, 2);
  return {
    ...preview,
    canceled: false,
    path: fromPath || null,
    text,
    format: "json",
  };
});

ipcMain.handle("customTools:import", async (_event, payload = {}) => {
  const userDataPath = app.getPath("userData");
  let source = payload?.source ?? payload?.text ?? payload?.json ?? payload?.pack ?? null;
  let fromPath = payload?.path || payload?.filePath || payload?.zip || null;
  if (payload?.dialog === true || payload?.openDialog === true) {
    const win = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showOpenDialog(win || undefined, {
      title: "Import custom tools",
      properties: ["openFile"],
      filters: [
        { name: "ZIP / JSON", extensions: ["zip", "json"] },
        { name: "ZIP (folder tools)", extensions: ["zip"] },
        { name: "JSON (custom tools pack)", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (picked.canceled || !picked.filePaths?.length) {
      return {
        ok: false,
        canceled: true,
        count: 0,
        imported: [],
        updated: [],
        skipped: [],
        renamed: [],
        errors: [],
      };
    }
    fromPath = picked.filePaths[0];
  }

  const isZip =
    (typeof fromPath === "string" && customTools.toolZip.looksLikeZipPath(fromPath)) ||
    (typeof source === "string" && customTools.toolZip.looksLikeZipPath(source) && !String(source).trim().startsWith("{")) ||
    payload?.format === "zip" ||
    payload?.zip === true;

  if (isZip) {
    const zipPath = fromPath || (typeof source === "string" ? source : null);
    if (!zipPath) throw new Error("import zip requires path to .zip file");
    const result = await customTools.importCustomTools(userDataPath, null, {
      mode: payload?.mode || payload?.onConflict || "skip",
      names: payload?.names,
      name: payload?.name,
      tool: payload?.tool,
      ids: payload?.ids,
      indices: payload?.indices,
      onlyOne: payload?.onlyOne === true,
      path: zipPath,
      filePath: zipPath,
      zip: zipPath,
      zipPath,
    });
    if (result.count > 0 || (result.updated && result.updated.length)) {
      broadcastCustomToolsChanged({ type: "imported", result });
    }
    return { ...result, canceled: false, path: zipPath, format: result.format || "zip" };
  }

  if (fromPath && !source) {
    source = await fs.promises.readFile(String(fromPath), "utf8");
  }
  if (source == null) {
    throw new Error("import requires path=.zip (folder tools) or source/text/json or path=.json");
  }
  const result = await customTools.importCustomTools(userDataPath, source, {
    mode: payload?.mode || payload?.onConflict || "skip",
    names: payload?.names,
    name: payload?.name,
    tool: payload?.tool,
    ids: payload?.ids,
    indices: payload?.indices,
    onlyOne: payload?.onlyOne === true,
  });
  if (result.count > 0 || (result.updated && result.updated.length)) {
    broadcastCustomToolsChanged({ type: "imported", result });
  }
  return { ...result, canceled: false, path: fromPath || null, format: "json" };
});

ipcMain.handle("instructions:read", async (_event, rootPath) => {
  return instructions.readAllInstructions(app.getPath("userData"), rootPath || null);
});

ipcMain.handle("instructions:saveGlobal", async (_event, content) => {
  await instructions.saveGlobalInstructions(app.getPath("userData"), content);
  invalidateContextCache(null);
  return true;
});

ipcMain.handle("instructions:saveProject", async (_event, rootPath, content) => {
  await instructions.saveProjectInstructions(rootPath, content);
  invalidateContextCache(rootPath || null);
  return true;
});

ipcMain.handle("agentPrompts:read", async () => {
  const userDataPath = app.getPath("userData");
  const registry = require("./tools/registry.cjs");
  const tools = registry.TOOLS || [];

  // Collect default tool prompts
  const defaults = {};
  for (const tool of tools) {
    if (tool.name && tool.description) {
      defaults[tool.name] = tool.description;
    }
  }

  // Read overrides
  const overrides = await agentPrompts.readPromptOverrides(userDataPath);

  // Build system prompt default
  const { buildSystemPrompt } = require("./context.cjs");
  const systemDefault = await buildSystemPrompt({
    rootPath: null,
    projectName: null,
    userDataPath,
  });

  return {
    system: {
      name: "System prompt",
      default: systemDefault,
      custom: overrides.system || "",
    },
    tools: Object.entries(defaults).map(([name, desc]) => ({
      name,
      default: desc,
      custom: overrides.tools[name] || "",
    })),
  };
});

ipcMain.handle("agentPrompts:saveTool", async (_event, toolName, content) => {
  await agentPrompts.saveToolPrompt(app.getPath("userData"), toolName, content);
  return true;
});

ipcMain.handle("agentPrompts:saveSystem", async (_event, content) => {
  await agentPrompts.saveSystemPrompt(app.getPath("userData"), content);
  return true;
});

ipcMain.handle("agentPrompts:resetTool", async (_event, toolName) => {
  await agentPrompts.resetToolPrompt(app.getPath("userData"), toolName);
  return true;
});

ipcMain.handle("agentPrompts:resetSystem", async () => {
  await agentPrompts.resetSystemPrompt(app.getPath("userData"));
  return true;
});

ipcMain.handle("autoInsert:read", async () => {
  return autoInsert.readAutoInsertStore(app.getPath("userData"));
});

ipcMain.handle("autoInsert:save", async (_event, data) => {
  await autoInsert.saveAutoInsert(app.getPath("userData"), data);
  return true;
});

ipcMain.handle("folder:open", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Select workspace folder",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const rootPath = result.filePaths[0];
  const stat = await fs.promises.stat(rootPath);
  if (!stat.isDirectory()) {
    throw new Error("Selected path is not a directory");
  }

  // The chat slot only needs its workspace identity. Building a recursive file
  // tree here makes folder switching fail on an unreadable nested entry or a
  // broken symlink, even though the selected root itself is valid.
  invalidateContextCache(rootPath);
  return {
    id: rootPath,
    name: path.basename(rootPath) || rootPath,
    path: rootPath,
    type: "folder",
    children: [],
  };
});

ipcMain.handle("folder:read", async (_event, rootPath) => {
  invalidateContextCache(rootPath);
  return await buildTree(rootPath);
});

ipcMain.handle("project:search", async (_event, rootPath, query) => {
  return searchProject(rootPath, query || "");
});

ipcMain.handle("tasks:read", async (_event, rootPath) => {
  return readProjectTasks(rootPath);
});

ipcMain.handle("tasks:save", async (_event, rootPath, tasks) => {
  return saveProjectTasks(rootPath, tasks);
});

ipcMain.handle("file:read", async (_event, filePath) => {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    return "";
  }
  return fs.promises.readFile(filePath, "utf8");
});

ipcMain.handle("file:readMedia", async (_event, filePath) => {
  const stat = await fs.promises.stat(filePath);
  const mimeType = getMediaMimeType(filePath);
  if (!stat.isFile() || !mimeType) {
    throw new Error("Unsupported media file");
  }
  // Keep previews bounded so accidentally opening a huge recording/image does not
  // freeze the renderer with a massive data URL.
  if (stat.size > 50 * 1024 * 1024) {
    throw new Error("Media file is too large to preview (max 50 MB)");
  }
  const buffer = await fs.promises.readFile(filePath);
  return {
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    mimeType,
    size: stat.size,
  };
});

ipcMain.handle("file:write", async (_event, filePath, content) => {
  await fs.promises.writeFile(filePath, content, "utf8");
  return true;
});

ipcMain.handle("file:create", async (_event, parentPath, name) => {
  const targetPath = path.join(parentPath, name);
  await fs.promises.writeFile(targetPath, "", { flag: "wx" });
  try {
    usageStore.recordFileCreate(0);
  } catch {
    /* usage tracking must never break file creation */
  }
  return targetPath;
});

ipcMain.handle("folder:create", async (_event, parentPath, name) => {
  const targetPath = path.join(parentPath, name);
  await fs.promises.mkdir(targetPath);
  return targetPath;
});

ipcMain.handle("path:delete", async (_event, targetPath) => {
  await fs.promises.rm(targetPath, { recursive: true, force: true });
  return true;
});

ipcMain.handle("path:move", async (_event, sourcePath, targetFolderPath) => {
  const targetPath = path.join(targetFolderPath, path.basename(sourcePath));
  await fs.promises.rename(sourcePath, targetPath);
  return targetPath;
});

let quitSavePromise = null;

// ── Cumulative app runtime ─────────────────────────────────────────────
// Total time the app has been running across ALL sessions, persisted to
// runtime.json in userData on quit and on a periodic checkpoint. Never
// capped — the counter just keeps accumulating ("до бесконечности").
const RUNTIME_PERSIST_MS = 60 * 1000;
let runtimeBaseSec = 0;
let runtimeSessions = 0;
let runtimeSessionStartMs = Date.now();
let runtimeSaveTimer = null;
let runtimeQuitSaved = false;

function runtimeFilePath() {
  return path.join(app.getPath("userData"), "runtime.json");
}

function loadRuntimeFile() {
  try {
    const raw = fs.readFileSync(runtimeFilePath(), "utf8");
    const data = JSON.parse(raw);
    runtimeBaseSec = Math.max(0, Math.floor(Number(data?.totalSec) || 0));
    runtimeSessions = Math.max(0, Math.floor(Number(data?.sessions) || 0));
  } catch {
    runtimeBaseSec = 0;
    runtimeSessions = 0;
  }
}

function currentTotalRuntimeSec() {
  return runtimeBaseSec + Math.max(0, Math.floor((Date.now() - runtimeSessionStartMs) / 1000));
}

function saveRuntimeFile({ incrementSession = false } = {}) {
  try {
    if (incrementSession) runtimeSessions += 1;
    const payload = {
      totalSec: currentTotalRuntimeSec(),
      sessions: runtimeSessions,
      lastSavedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(runtimeFilePath()), { recursive: true });
    fs.writeFileSync(runtimeFilePath(), JSON.stringify(payload, null, 2), "utf8");
  } catch (error) {
    console.error("[runtime] save failed:", error?.message || error);
  }
}


app.on("before-quit", (event) => {
  if (!quitSavePromise) {
    // First pass — persist cumulative runtime before the final quit cycle.
    try {
      if (!runtimeQuitSaved) {
        saveRuntimeFile({ incrementSession: true });
        runtimeQuitSaved = true;
      }
    } catch {
      /* ignore */
    }
    try {
      usageStore.flushSync();
    } catch {
      /* ignore */
    }
    if (runtimeSaveTimer) {
      clearInterval(runtimeSaveTimer);
      runtimeSaveTimer = null;
    }
    try {
      terminalManager.dispose();
    } catch {
      /* ignore */
    }
    event.preventDefault();
    quitSavePromise = memory
      .flushAllPendingSaves(app)
      .catch(() => {})
      .finally(() => {
        app.quit();
      });
    return;
  }
  try {
    runnerEngine.stop();
  } catch {
    /* ignore */
  }
  try {
    terminalManager.dispose();
  } catch {
    /* ignore */
  }
  try {
    abortAllChatSessions();
  } catch {
    /* ignore */
  }
  try {
    sizeworkout.dispose();
  } catch {
    /* ignore */
  }
  try {
    workerPool.terminate();
  } catch {
    /* ignore */
  }
  try {
    void mcpManager.disposeAll();
  } catch {
    /* ignore */
  }
  try {
    // Proxy gateway child process — stop it on app quit (it also exits when
    // its stdin closes, this is the explicit fallback).
    require("./proxy/index.cjs").process.kill();
  } catch {
    /* ignore */
  }
  for (const bot of telegramBotsBySlot.values()) {
    try {
      bot.stop();
    } catch {
      // ignore
    }
  }
});

app.whenReady().then(async () => {
  app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
  app.commandLine.appendSwitch("disk-cache-dir", path.join(app.getPath("userData"), "cache"));

  // Cumulative runtime: load the stored base, then checkpoint every minute so
  // a hard kill loses at most ~1 minute of the current session.
  try {
    loadRuntimeFile();
  } catch {
    /* ignore */
  }
  try {
    usageStore.init(app.getPath("userData"));
  } catch (error) {
    console.error("[usage] init failed:", error?.message || error);
  }
  runtimeSaveTimer = setInterval(() => {
    try {
      saveRuntimeFile();
    } catch {
      /* ignore */
    }
  }, RUNTIME_PERSIST_MS);

  // Start per-slot Telegram bots from telegram_slots.json (migrate global once if needed).
  try {
    await loadAndStartAllTelegramSlots();
  } catch (error) {
    console.error("Telegram bootstrap failed:", error?.message || error);
  }

  // Proxy gateway runs as a SEPARATE child process (proxy/standalone.cjs) so
  // heavy streaming + log volume never freezes the app. Auto-start it on launch
  // (the child is also runnable manually from a terminal).
  try {
    const { process: proxyProcess } = require("./proxy/index.cjs");
    // Packaged builds force the managed proxy up on every launch so a freshly
    // installed machine never faces a dead gateway. In dev the store toggle is
    // respected (a proxy may already be running in a terminal).
    const boot = await proxyProcess.autoStartIfNeeded(app.getPath("userData"), {
      force: app.isPackaged,
    });
    if (boot.started) console.log("[proxy] auto-started on", boot.status?.baseUrl);
  } catch (error) {
    console.error("Proxy auto-start failed:", error?.message || error);
  }

  try {
    runnerEngine.start({
      userDataPath: app.getPath("userData"),
      executeChatRequest,
      getMainSender,
      readProviderConfig,
    });
    const broadcastRunner = (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) win.webContents.send(channel, payload);
        } catch {
          /* */
        }
      }
    };
    runnerEngine.on("runners", (runnersList) =>
      broadcastRunner("runner:changed", { runners: runnersList })
    );
    runnerEngine.on("report", (report) =>
      broadcastRunner("runner:report-changed", { report })
    );
    runnerEngine.on("report-deleted", (payload) =>
      broadcastRunner("runner:report-changed", { deleted: true, ...payload })
    );
    runnerEngine.on("status", (payload) => broadcastRunner("runner:status", payload));
    runnerEngine.on("progress", (payload) => broadcastRunner("runner:progress", payload));
    runnerEngine.on("runner-deleted", (payload) =>
      broadcastRunner("runner:changed", { deleted: true, id: payload?.id })
    );
  } catch (error) {
    console.error("Runner engine failed:", error?.message || error);
  }

  try {
    require("./deskBridge.cjs").start(() => {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) return focused;
      return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
    });
  } catch (error) {
    console.error("[desk] bridge failed:", error?.message || error);
  }

  // Auto-update feed (GitHub Releases of the project repo). Safe in dev: the
  // module reports status "dev" and never touches the network there.
  try {
    const updater = require("./updater.cjs");
    updater.init(app.getPath("userData"));
    updater.startAutoCheck();
  } catch (error) {
    console.error("[updater] init failed:", error?.message || error);
  }

  createWindow({ intro: true });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ intro: true });
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
