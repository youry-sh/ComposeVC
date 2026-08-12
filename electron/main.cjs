const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, nativeImage, session } = require("electron");
// Broken GPU drivers (e.g. nouveau on Linux) can render a black window.
// Must be set before app is ready / any window is created.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
const { spawn } = require("child_process");
const { Worker } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const postsStore = require("./postsStore.cjs");
const booksStore = require("./booksStore.cjs");
const youtubeStore = require("./youtubeStore.cjs");
const storageStore = require("./storageStore.cjs");
const telegramTool = require("./tools/telegram.cjs");
const customTools = require("./customTools.cjs");
const mcpManager = require("./mcpManager.cjs");
const instructions = require("./instructions.cjs");
const agentPrompts = require("./agentPrompts.cjs");
const autoInsert = require("./autoInsert.cjs");
const {
  SOVIET7_MODE_ID,
  SOVIET7_NORMAL_MODE_ID,
  runSoviet7Council,
} = require("./soviet7/index.cjs");

const { TOOLS, getToolSchemas, getToolSchemasAsync } = require("./tools/registry.cjs");
const { createTelegramBot, normalizeTelegramConfig } = require("./telegramBot.cjs");
const telegramSlots = require("./telegramSlots.cjs");
const { resolveUserAnswer, rejectAllPending } = require("./askUserBridge.cjs");
const { registerProxyHandlers } = require("./proxy/index.cjs");
const runnerEngine = require("./runners/runnerEngine.cjs");
const { showAgentToast } = require("./agentToast.cjs");
const { runtime: sizeworkout } = require("./sizeworkout.cjs");
const workerPool = require("./workerPool.cjs");
const terminalManager = require("./terminalManager.cjs");
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
    soviet7ModelId: "",
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
  const soviet7ModelId =
    typeof config?.soviet7ModelId === "string"
      ? config.soviet7ModelId.trim()
      : typeof config?.soviet7_model_id === "string"
        ? config.soviet7_model_id.trim()
        : "";
  return {
    agentCompletionNotifications: config?.agentCompletionNotifications !== false,
    maxContextTokens,
    autoCompactTokens,
    soviet7ModelId,
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

  // The only allowed guest is the isolated in-app YouTube viewer. Renderer
  // markup cannot attach arbitrary privileged webviews or inject a preload.
  wc.on("will-attach-webview", (event, webPreferences, params) => {
    let allowed = false;
    try { allowed = /^https:\/\/(?:www\.)?youtube\.com\/watch\?/i.test(String(params?.src || "")); } catch {}
    if (!allowed) { event.preventDefault(); return; }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  wc.on("did-attach-webview", (_event, guest) => {
    try { guest.setWindowOpenHandler(() => ({ action: "deny" })); } catch {}
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
  void loadWindowContent(win);
  return win;
}

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

ipcMain.handle("config:read", async () => {
  const config = await readProviderConfig();
  configureTelegramFromProviderConfig(config);
  return config;
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

ipcMain.handle("config:write", async (_event, config) => {
  return writeProviderConfig(config);
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
 * Batch high-frequency agent:progress IPC (context_usage / noise) so Soviet-7
 * multi-advisor + multi-chat does not flood the renderer into a freeze.
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

async function executeChatRequest(event, request, overrides = {}) {
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
  // Modes: lopster | soviet-7
  const rawAgentMode = String(overrides.agentMode || request.agentMode || "lopster")
    .trim()
    .toLowerCase();
  const agentMode =
    rawAgentMode === SOVIET7_MODE_ID || rawAgentMode === "soviet7" || rawAgentMode === "soviet_7"
      ? SOVIET7_MODE_ID
      : "lopster";
  const isSoviet7 = agentMode === SOVIET7_MODE_ID;
  /** After soviet-7, execute path reports normal mode (lopster). */
  let effectiveAgentMode = agentMode;
  let soviet7Meta = null;

  const lastUserMsg = [...requestMessages].reverse().find((m) => isRealUserMessage(m)) || null;
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
  if (request.thinkingMax === true) {
    systemPrompt +=
      "\n\n--- Thinking-max is locked ON by the user ---\n" +
      "You MUST complete all runtime-requested Thinking-max cycles before giving the final answer on this turn. " +
      "Each cycle must add new analysis rather than paraphrasing the previous one. Use further fresh think calls whenever new evidence, a contradiction, a risky decision, or an unresolved hypothesis appears. " +
      "Do not substitute ordinary provider reasoning for the think tool. After thinking, validate conclusions with available tools and only then answer.";
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
  try {
    // ── Soviet-7: fan-out 7 identical advisors → handoff → auto-switch to lopster ──
    // Research uses council model (aiRuntime.soviet7ModelId || main). Execution uses main model.
    if (isSoviet7 && typeof lastUserText === "string" && lastUserText.trim()) {
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
      const sendProgress = mainProgress;

      let councilResult;
      try {
        councilResult = await runSoviet7Council({
          runAgentLoop,
          config,
          mainProvider: provider,
          mainModel: model,
          userTask: lastUserText,
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
          onProgress: (progress) => {
            if (!progress) return;
            // Attribute streams; do not forward advisor assistant_text into main chat draft.
            if (progress.type === "assistant_text" && !progress.parentToolCallId) return;
            sendProgress(progress);
          },
          sessionId: runSessionId,
        });
      } catch (s7Err) {
        if (abortController.signal.aborted || s7Err?.name === "AbortError" || s7Err?.stopped) {
          stoppedFlag = true;
          return {
            text: s7Err?.message || "[Stopped by user]",
            provider,
            model,
            sessionId: runSessionId,
            stopped: true,
            agentMode: SOVIET7_NORMAL_MODE_ID,
            soviet7: { ok: false, stopped: true, error: s7Err?.message || "stopped" },
          };
        }
        // Soft-fail: continue main agent with original task + error note
        councilResult = {
          aborted: false,
          okCount: 0,
          errorCount: 7,
          stoppedCount: 0,
          modelId: model?.id,
          warning: s7Err?.message || String(s7Err),
          advices: [],
          handoffUserMessage:
            `【Soviet-7 council failed】\n${s7Err?.message || s7Err}\n\n` +
            `Proceed carefully as main ComposeVC and execute the original user task:\n\n${lastUserText}`,
          runId: `s7-fail-${Date.now().toString(16)}`,
        };
        sendProgress({
          type: "status",
          label: `Soviet-7 · council error — continuing as ComposeVC…`,
          phase: "soviet7-fallback",
          agentMode: SOVIET7_NORMAL_MODE_ID,
        });
      }

      if (councilResult?.aborted || abortController.signal.aborted) {
        stoppedFlag = true;
        return {
          text: "[Stopped by user]",
          provider,
          model,
          sessionId: runSessionId,
          stopped: true,
          agentMode: SOVIET7_NORMAL_MODE_ID,
          soviet7: {
            ok: false,
            stopped: true,
            runId: councilResult?.runId,
            okCount: councilResult?.okCount,
          },
        };
      }

      soviet7Meta = {
        ok: (councilResult?.okCount || 0) > 0,
        runId: councilResult?.runId,
        okCount: councilResult?.okCount ?? 0,
        errorCount: councilResult?.errorCount ?? 0,
        stoppedCount: councilResult?.stoppedCount ?? 0,
        modelId: councilResult?.modelId,
        modelName: councilResult?.modelName,
        displayLabel: councilResult?.displayLabel || councilResult?.modelName || councilResult?.modelId,
        source: councilResult?.source,
        warning: councilResult?.warning || null,
      };

      // Replace last user turn with handoff package (original task + 7 advices).
      const handoff = String(councilResult?.handoffUserMessage || lastUserText);
      let replacedS7 = false;
      requestMessages = requestMessages.map((m, idx, arr) => {
        if (replacedS7) return m;
        const isLastUser =
          m?.role === "user" && !arr.slice(idx + 1).some((x) => x?.role === "user");
        if (!isLastUser) return m;
        replacedS7 = true;
        return { ...m, content: handoff };
      });
      if (!replacedS7) {
        requestMessages = [...requestMessages, { role: "user", content: handoff }];
      }
      historyUserMessages = requestMessages;

      if (persistSession && sessionId) {
        try {
          await memory.saveSession(app, rootPath, sessionId, requestMessages);
        } catch {
          /* */
        }
      }

      // Auto-switch to normal ComposeVC for execution (UI + return path).
      effectiveAgentMode = SOVIET7_NORMAL_MODE_ID;
      const councilLabel =
        soviet7Meta.displayLabel || soviet7Meta.modelName || soviet7Meta.modelId || "main";
      sendProgress({
        type: "status",
        label: `ComposeVC · executing from council (advisors used ${councilLabel})…`,
        phase: "soviet7-execute",
        agentMode: SOVIET7_NORMAL_MODE_ID,
        soviet7: {
          phase: "normal_exec",
          runId: soviet7Meta.runId,
          okCount: soviet7Meta.okCount,
          errorCount: soviet7Meta.errorCount,
          modelId: soviet7Meta.modelId,
          modelName: soviet7Meta.modelName,
          displayLabel: soviet7Meta.displayLabel,
          source: soviet7Meta.source,
        },
      });
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
          onMcpChanged: (payload) => {
            try { event.sender.send("mcp:changed", payload || { type: "changed" }); } catch {}
          },
          onPostsChanged: (payload) => {
            try { broadcastPostsChanged(payload || { type: "changed" }); } catch {}
          },
          onBooksChanged: (payload) => {
            try { broadcastBooksChanged(payload || { type: "changed" }); } catch {}
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
          await memory.saveSession(app, rootPath, sessionId, messages, {
            usage: result?.usage,
            contextTokens: result?.contextTokens,
            throttle: true,
          });
        },
        onProgress: mainProgress,
      });
    } catch (error) {
      // All retries were exhausted (or a non-retryable error occurred). Safety net:
      // never leave the conversation in a broken/lost state — record what happened
      // as the assistant's turn so the user and future turns retain full context.
      const rawFailure = error?.message || error;
      const failureText = isCyberFlagErrorText(rawFailure)
        ? String(rawFailure)
        : `Request failed after multiple retries: ${rawFailure}`;
      const recoveredMessages = Array.isArray(error?.recoveredMessages) ? error.recoveredMessages : requestMessages;
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
      };
    }

    // Prefer agent transcript. Ensure the latest real user request is never missing
    // (compact / tool-heavy turns can push it out of the keep-recent window).
    let fullHistory = Array.isArray(result.messages)
      ? result.messages
      : [...requestMessages, { role: "assistant", content: result.text }];
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
    const responseAgentMode = isSoviet7
      ? SOVIET7_NORMAL_MODE_ID
      : effectiveAgentMode || agentMode;
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
      soviet7: soviet7Meta || undefined,
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
  const soundPath = path.join(__dirname, "..", "logo", "zvuk-opovesheniya-sms.mp3");

  try {
    const focusMain = () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    };

    const theme = String(payload.theme || "signal-black");

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
        onBooksChanged: (payload) => {
          try { broadcastBooksChanged(payload || { type: "changed" }); } catch {}
        },
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

ipcMain.handle("memory:createSession", async (_event, rootPath) => {
  return memory.createSession(app, rootPath || null);
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

function broadcastPostsChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("posts:changed", payload || { type: "changed" });
    } catch {
      // ignore
    }
  }
}

function broadcastBooksChanged(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("books:changed", payload || { type: "changed" }); } catch {}
  }
}

function importBookInWorker(userDataPath, filePath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "bookImportWorker.cjs"), { workerData: { userDataPath, filePath } });
    worker.once("message", (message) => message?.ok ? resolve(message.book) : reject(new Error(message?.error || "Book conversion failed")));
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`Book converter exited with code ${code}`)); });
  });
}

// ── Posts (POST tab): Telegraph-style markdown, stored as md + json ──────────
ipcMain.handle("posts:list", async (_event, options = {}) => {
  try {
    const ud = app.getPath("userData");
    const query = String(options?.query || "").trim();
    const posts = query ? await postsStore.searchPosts(ud, query) : postsStore.listPosts(ud);
    const folders = postsStore.listFolders(ud);
    return { ok: true, total: posts.length, folders, posts };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:move", async (_event, id, folderId) => {
  try {
    const meta = await postsStore.movePost(app.getPath("userData"), String(id || ""), folderId ?? null);
    broadcastPostsChanged({ type: "moved", id: meta.id });
    return { ok: true, post: meta };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:folderCreate", async (_event, input = {}) => {
  try {
    const folder = await postsStore.createFolder(app.getPath("userData"), input || {});
    broadcastPostsChanged({ type: "folder", id: folder.id });
    return { ok: true, folder };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:folderRename", async (_event, id, name) => {
  try {
    const folder = await postsStore.renameFolder(app.getPath("userData"), String(id || ""), name);
    broadcastPostsChanged({ type: "folder", id: folder.id });
    return { ok: true, folder };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:folderDelete", async (_event, id) => {
  try {
    const res = await postsStore.removeFolder(app.getPath("userData"), String(id || ""));
    if (res.ok) broadcastPostsChanged({ type: "folder", id: res.id });
    return res;
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:get", async (_event, id) => {
  try {
    const post = await postsStore.getPost(app.getPath("userData"), String(id || ""));
    return post ? { ok: true, post } : { ok: false, error: "not-found" };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:create", async (_event, input = {}) => {
  try {
    const post = await postsStore.createPost(app.getPath("userData"), input || {});
    broadcastPostsChanged({ type: "created", id: post.id });
    return { ok: true, post };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:update", async (_event, id, patch = {}) => {
  try {
    const post = await postsStore.updatePost(app.getPath("userData"), String(id || ""), patch || {});
    broadcastPostsChanged({ type: "updated", id: post.id });
    return { ok: true, post };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

ipcMain.handle("posts:delete", async (_event, id) => {
  try {
    const res = await postsStore.removePost(app.getPath("userData"), String(id || ""));
    if (res.ok) broadcastPostsChanged({ type: "deleted", id: res.id });
    return res;
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});

// ── Books: imported once, normalized and cached under userData/books ────────
ipcMain.handle("books:list", async (_event, options = {}) => {
  try { return { ok: true, books: booksStore.listBooks(app.getPath("userData"), options.query) }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("books:get", async (_event, id) => {
  try { const book = await booksStore.getBook(app.getPath("userData"), String(id || "")); return book ? { ok: true, book } : { ok: false, error: "not-found" }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("books:import", async () => {
  try {
    const picked = await dialog.showOpenDialog({ title: "Импорт книги", properties: ["openFile", "multiSelections"], filters: [{ name: "Books", extensions: ["fb2", "fb3", "epub", "pdf", "txt"] }] });
    if (picked.canceled) return { ok: true, canceled: true, books: [] };
    const imported = [];
    for (const filePath of picked.filePaths) imported.push(await importBookInWorker(app.getPath("userData"), filePath));
    broadcastBooksChanged({ type: "imported", ids: imported.map((b) => b.id) });
    return { ok: true, books: imported };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("books:update", async (_event, id, patch = {}) => {
  try { const book = await booksStore.updateBook(app.getPath("userData"), String(id || ""), patch); broadcastBooksChanged({ type: "updated", id: book.id }); return { ok: true, book }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("books:delete", async (_event, id) => {
  try { const ok = await booksStore.removeBook(app.getPath("userData"), String(id || "")); if (ok) broadcastBooksChanged({ type: "deleted", id }); return { ok }; }
  catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("youtube:list", async () => {
  try { return { ok: true, videos: youtubeStore.list(app.getPath("userData")) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("youtube:add", async (_event, input = {}) => {
  try { return { ok: true, video: await youtubeStore.add(app.getPath("userData"), input) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("youtube:update", async (_event, id, patch = {}) => {
  try { return { ok: true, video: await youtubeStore.update(app.getPath("userData"), String(id || ""), patch) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle("youtube:delete", async (_event, id) => {
  try { return { ok: await youtubeStore.remove(app.getPath("userData"), String(id || "")) }; } catch (error) { return { ok: false, error: String(error?.message || error) }; }
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
    if (runtimeSaveTimer) {
      clearInterval(runtimeSaveTimer);
      runtimeSaveTimer = null;
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

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
