/**
 * Provider model catalog:
 * - catalog (built-in)
 * - manual (user-added, persisted)
 * - live (API / OAuth fetch)
 * Models are exposed as bare ids AND tagged provider/model (xai/grok-4.5).
 */

const storeApi = require("./store.cjs");
const {
  getProvider,
  taggedModelId,
  listProviders,
  registerCustomProvidersFromStore,
} = require("./providers/registry.cjs");
const { catalogFor: antigravityCatalog } = require("./oauth/antigravityUsage.cjs");
const { modelsFromQauthPayload, normalizeQauthModelId } = require("./qauthModels.cjs");

/** OpenAI Platform API key catalog (api.openai.com). NOT for ChatGPT OAuth/Codex. */
const OPENAI_PLATFORM_FALLBACK_MODELS = [
  { id: "gpt-4o", owned_by: "openai", kind: "chat" },
  { id: "gpt-4o-mini", owned_by: "openai", kind: "chat" },
  { id: "gpt-4.1", owned_by: "openai", kind: "chat" },
  { id: "gpt-4.1-mini", owned_by: "openai", kind: "chat" },
  { id: "gpt-4.1-nano", owned_by: "openai", kind: "chat" },
  { id: "o3", owned_by: "openai", kind: "reasoning" },
  { id: "o3-mini", owned_by: "openai", kind: "reasoning" },
  { id: "o4-mini", owned_by: "openai", kind: "reasoning" },
  { id: "gpt-5", owned_by: "openai", kind: "chat" },
  { id: "gpt-5-mini", owned_by: "openai", kind: "chat" },
  { id: "gpt-5-nano", owned_by: "openai", kind: "chat" },
  { id: "gpt-5-codex", owned_by: "openai", kind: "codex" },
  { id: "gpt-5.1-codex", owned_by: "openai", kind: "codex" },
  { id: "gpt-5.1-codex-mini", owned_by: "openai", kind: "codex" },
];

/**
 * ChatGPT OAuth → Codex backend (chatgpt.com/backend-api/codex).
 * ChatGPT accounts reject platform-only ids like chatgpt-4o-latest / plain gpt-4o.
 * Keep this list Codex-safe only (Codex CLI / ChatGPT subscription models).
 */
const OPENAI_CODEX_FALLBACK_MODELS = [
  { id: "gpt-5.6", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.6-sol", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.6-terra", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.6-luna", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.4", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.4-mini", owned_by: "openai", kind: "chat" },
  { id: "gpt-5.3-codex", owned_by: "openai", kind: "codex" },
  { id: "gpt-5.2-codex", owned_by: "openai", kind: "codex" },
  { id: "gpt-5.1-codex", owned_by: "openai", kind: "codex" },
  { id: "gpt-5.1-codex-mini", owned_by: "openai", kind: "codex" },
  { id: "gpt-5-codex", owned_by: "openai", kind: "codex" },
  { id: "codex-mini-latest", owned_by: "openai", kind: "codex" },
  { id: "gpt-5", owned_by: "openai", kind: "chat" },
  { id: "gpt-5-mini", owned_by: "openai", kind: "chat" },
];

/** @deprecated use OPENAI_PLATFORM_FALLBACK_MODELS — kept for require() compatibility */
const OPENAI_FALLBACK_MODELS = OPENAI_PLATFORM_FALLBACK_MODELS;

/** Models that ChatGPT Codex backend rejects (platform/web-only aliases). */
const OPENAI_CODEX_BLOCKED_IDS = new Set(
  [
    "chatgpt-4o-latest",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4.1-nano",
    "gpt-4-turbo",
    "gpt-4",
    "gpt-3.5-turbo",
  ].map((id) => id.toLowerCase())
);

function isOpenAICodexAccount(account) {
  if (!account) return false;
  if (account.providerId && account.providerId !== "openai") return false;
  return account.authType === "oauth" || account.mode === "codex" || account.wireMode === "codex";
}

/** Grok Build CLI + xAI platform defaults */
const GROK_FALLBACK_MODELS = [
  { id: "grok-4.5", owned_by: "xai", kind: "chat" },
  { id: "grok-composer-2.5-fast", owned_by: "xai", kind: "chat" },
  { id: "grok-build", owned_by: "xai", kind: "chat" },
  { id: "grok-3", owned_by: "xai", kind: "chat" },
  { id: "grok-3-mini", owned_by: "xai", kind: "chat" },
  { id: "grok-2", owned_by: "xai", kind: "chat" },
  { id: "grok-2-vision-1212", owned_by: "xai", kind: "chat" },
];

function classifyModel(id) {
  const s = String(id || "").toLowerCase();
  if (s.includes("embed") || s.includes("rerank") || s.includes("reranker") || s.includes("bge-") || s.includes("bge_"))
    return "embedding";
  if (s.includes("tts") || s.includes("audio") || s.includes("whisper") || s.includes("transcri"))
    return "audio";
  if (s.includes("dall") || s.includes("image") || s.includes("gpt-image")) return "image";
  if (s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4") || s.includes("reason"))
    return "reasoning";
  if (s.includes("codex")) return "codex";
  if (s.includes("moderation")) return "moderation";
  if (s.includes("thinking") || s.includes("claude-opus")) return "reasoning";
  return "chat";
}

function isChatRelevant(id) {
  // Only strip known provider tags — keep org/model paths (deepseek/…)
  const { bareModelId } = require("./modelValidate.cjs");
  const bare = bareModelId(id);
  const k = classifyModel(bare);
  return k === "chat" || k === "reasoning" || k === "codex";
}

/** Strip known provider tags from model id for storage of bare id */
function normalizeId(id) {
  // Only strip ComposeVC provider tags; keep deepseek/… for OrcaRouter free models
  let s = String(id || "").trim();
  s = s.replace(
    /^(openai|grok|xai|antigravity|a6api|a6|j3gb|vip|deepseek|ds|gemini-cli|gc|gemini|claude-code|cc|claude|anthropic|perplexity|pplx|kiro|kr|orcarouter|orca|oracle|openrouter|zai|z-ai|glm|google-ai-studio|ai-studio|github-copilot|copilot|windsurf|cursor|codebuddy|codebuddy-cn|qoder|qauth|opencode-go|opencode_go|opencode|opencode-zen|zen|go)\//i,
    ""
  );
  // Second peel if nested tags (oracle/orcarouter/…)
  s = s.replace(
    /^(openai|grok|xai|antigravity|a6api|a6|j3gb|vip|deepseek|ds|gemini-cli|gc|gemini|claude-code|cc|claude|anthropic|perplexity|pplx|kiro|kr|orcarouter|orca|oracle|openrouter|zai|z-ai|glm|google-ai-studio|ai-studio|github-copilot|copilot|windsurf|cursor|codebuddy|codebuddy-cn|qoder|qauth|opencode-go|opencode_go|opencode|opencode-zen|zen|go)\//i,
    ""
  );
  return s;
}

function withTags(models, providerId) {
  const provider = getProvider(providerId);
  const tag = (provider?.modelTag || provider?.alias || providerId || "").toLowerCase();
  return (models || []).map((m) => {
    const bare = normalizeId(m.id);
    const tagged = tag ? `${tag}/${bare}` : bare;
    return {
      ...m,
      id: bare,
      bareId: bare,
      taggedId: tagged,
      /** Preferred client id for routing (provider/model) */
      name: m.name || bare,
      providerId,
      owned_by: m.owned_by || tag || providerId,
    };
  });
}

async function fetchOpenAIModels(baseUrl, token) {
  const root = String(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = root.endsWith("/models")
    ? root
    : root.endsWith("/v1")
      ? `${root}/models`
      : `${root}/v1/models`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`models ${res.status}: ${t.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : Array.isArray(data.data?.models)
          ? data.data.models
          : [];
  return list.map((m) => {
    const id = typeof m === "string" ? m : m.id || m.model || m.name;
    return {
      id,
      object: typeof m === "object" ? m.object || "model" : "model",
      created: typeof m === "object" ? m.created || null : null,
      owned_by: typeof m === "object" ? m.owned_by || m.provider || "openai" : "openai",
      kind: typeof m === "object" && m.kind ? m.kind : classifyModel(id),
      source: "live",
    };
  }).filter((m) => m.id);
}

function customModelsFor(store, providerId) {
  const all = store.customModels && typeof store.customModels === "object" ? store.customModels : {};
  const list = Array.isArray(all[providerId]) ? all[providerId] : [];
  return list
    .map((m) => {
      const id = normalizeId(m.id || m);
      if (!id) return null;
      return {
        id,
        object: "model",
        created: m.created || null,
        owned_by: m.owned_by || providerId,
        kind: m.kind || classifyModel(id),
        source: "manual",
      };
    })
    .filter(Boolean);
}

function mergeModels(parts, chatOnly) {
  const byId = new Map();
  const priority = { catalog: 1, grok_cli_cache: 2, live: 3, manual: 4 };
  for (const m of parts) {
    if (!m?.id) continue;
    if (chatOnly && !isChatRelevant(m.id)) continue;
    const prev = byId.get(m.id);
    if (!prev || (priority[m.source] || 0) >= (priority[prev.source] || 0)) {
      byId.set(m.id, m);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

const CODEBUDDY_FALLBACK_MODELS = [
  { id: "claude-3-7-sonnet", owned_by: "codebuddy", kind: "chat" },
  { id: "claude-3-5-sonnet", owned_by: "codebuddy", kind: "chat" },
  { id: "deepseek-v3", owned_by: "codebuddy", kind: "chat" },
  { id: "deepseek-r1", owned_by: "codebuddy", kind: "reasoning" },
  { id: "qwen2.5-coder", owned_by: "codebuddy", kind: "chat" },
  { id: "glm-4", owned_by: "codebuddy", kind: "chat" },
];

const QODER_FALLBACK_MODELS = [
  { id: "qoder-2", owned_by: "qoder", kind: "chat" },
  { id: "qoder-2-mini", owned_by: "qoder", kind: "chat" },
  { id: "claude-3-7-sonnet", owned_by: "qoder", kind: "chat" },
  { id: "deepseek-v3", owned_by: "qoder", kind: "chat" },
  { id: "qwen2.5-coder", owned_by: "qoder", kind: "chat" },
];

const QAUTH_FALLBACK_MODELS = [
  { id: "anthropic/claude-sonnet-4-6", owned_by: "qauth", kind: "chat" },
  { id: "anthropic/claude-opus-4-6", owned_by: "qauth", kind: "chat" },
  { id: "openai/gpt-5", owned_by: "qauth", kind: "chat" },
  { id: "google/gemini-2.5-pro", owned_by: "qauth", kind: "chat" },
];

function catalogFor(providerId) {
  if (providerId === "grok") return GROK_FALLBACK_MODELS;
  if (providerId === "codebuddy" || providerId === "codebuddy-cn") {
    return CODEBUDDY_FALLBACK_MODELS;
  }
  if (providerId === "qoder") return QODER_FALLBACK_MODELS;
  if (providerId === "qauth") return QAUTH_FALLBACK_MODELS;
  if (providerId === "opencode-go" || providerId === "opencode") {
    return getProvider(providerId)?.catalogModels || [];
  }
  if (providerId === "antigravity") {
    return antigravityCatalog("antigravity").map((m) => ({
      id: m.id,
      owned_by: "google",
      kind: m.kind || "chat",
      name: m.name,
    }));
  }
  if (providerId === "gemini-cli") {
    try {
      const { catalogFor } = require("./oauth/geminiCliUsage.cjs");
      return catalogFor().map((m) => ({
        id: m.id,
        owned_by: "google",
        kind: m.kind || "chat",
        name: m.name,
      }));
    } catch {
      return [];
    }
  }
  if (providerId === "claude-code") {
    try {
      const { catalogFor } = require("./oauth/claudeCodeUsage.cjs");
      return catalogFor().map((m) => ({
        id: m.id,
        owned_by: "anthropic",
        kind: m.kind || "chat",
        name: m.name,
      }));
    } catch {
      return [];
    }
  }
  if (providerId === "kiro") {
    try {
      const { catalogFor } = require("./oauth/kiroUsage.cjs");
      return catalogFor().map((m) => ({
        id: m.id,
        owned_by: "kiro",
        kind: m.kind || "chat",
        name: m.name,
      }));
    } catch {
      return [];
    }
  }
  // API gateways with manual model lists.
  if (providerId === "a6api" || providerId === "j3gb") return [];
  const provider = getProvider(providerId);
  if (provider?.emptyCatalog) return [];
  // Providers with a static catalog (e.g. OrcaRouter free models).
  if (Array.isArray(provider?.catalogModels) && provider.catalogModels.length) {
    return provider.catalogModels.map((m) => ({
      id: m.id,
      owned_by: m.owned_by || providerId,
      kind: m.kind || "chat",
      name: m.name || m.id,
      source: "catalog",
    }));
  }
  // Default OpenAI catalog is Platform API — Codex OAuth uses OPENAI_CODEX_FALLBACK_MODELS in listModelsFor.
  return OPENAI_PLATFORM_FALLBACK_MODELS;
}

/**
 * @param {string} userDataPath
 * @param {{ providerId?: string, accountId?: string, chatOnly?: boolean, refreshLive?: boolean }} opts
 */
async function listModelsFor(userDataPath, opts = {}) {
  const store = await storeApi.load(userDataPath);
  const providerId = opts.providerId || "openai";
  const chatOnly = opts.chatOnly !== false;
  const refreshLive = opts.refreshLive !== false;

  // Resolve account early so OpenAI catalog can switch Platform vs Codex.
  let account = null;
  if (opts.accountId) {
    account = (store.accounts || []).find((a) => a.id === opts.accountId) || null;
  }
  const providerAccounts = (store.accounts || []).filter(
    (a) => (a.providerId === providerId || (providerId === "qauth" && a.providerId === "cline")) && a.enabled !== false
  );
  if (!account) {
    // Prefer OAuth (Codex) when listing openai without accountId if any oauth exists —
    // ChatGPT users hit invalid_model with platform-only ids like chatgpt-4o-latest.
    account =
      (providerId === "openai" &&
        providerAccounts.find((a) => a.authType === "oauth" && (a.accessToken || a.refreshToken))) ||
      providerAccounts.find((a) => a.authType === "apikey" && a.apiKey) ||
      providerAccounts.find((a) => a.authType === "oauth" && a.accessToken) ||
      null;
  }

  const codexMode = providerId === "openai" && isOpenAICodexAccount(account);
  const catalogBase = codexMode
    ? OPENAI_CODEX_FALLBACK_MODELS
    : catalogFor(providerId);
  const catalog = catalogBase.map((m) => ({
    ...m,
    object: "model",
    created: null,
    source: "catalog",
  }));
  let manual = customModelsFor(store, providerId);
  if (codexMode) {
    manual = manual.filter((m) => !OPENAI_CODEX_BLOCKED_IDS.has(String(m.id || "").toLowerCase()));
  }

  let cliCache = [];
  if (providerId === "grok") {
    try {
      const grokAuth = require("./oauth/grokAuth.cjs");
      const cache = grokAuth.readLocalModelsCache();
      if (cache.ok && cache.models?.length) {
        cliCache = cache.models.map((m) => ({
          id: m.id,
          object: "model",
          created: null,
          owned_by: m.owned_by || "xai",
          kind: m.kind || "chat",
          source: "grok_cli_cache",
          name: m.name,
        }));
      }
    } catch {
      /* */
    }
  }

  let live = [];
  let liveWarning = null;
  let liveAccountId = null;
  const sources = ["catalog"];
  if (cliCache.length) sources.push("grok_cli_cache");
  if (manual.length) sources.push("manual");
  if (providerId === "qauth" && refreshLive) {
    const auth = require("./oauth/qauthAuth.cjs");
    const discovered = [];
    const discoveryErrors = [];
    if (account?.accessToken) {
      liveAccountId = account.id;
      try {
        try {
          const { ensureFreshToken } = require("./accounts.cjs");
          account = await ensureFreshToken(userDataPath, account);
        } catch {
          /* Try the current token; the models request will report a real auth error. */
        }
        discovered.push(...modelsFromQauthPayload(await auth.fetchModels(account.accessToken)));
      } catch (e) {
        discoveryErrors.push(e.message || String(e));
      }
    }
    try {
      // Always merge Cline's public categories. The authenticated endpoint can be
      // successful yet omit free, recommended, or Cline Pass entries.
      discovered.push(...modelsFromQauthPayload(await auth.fetchRecommendedModels()));
    } catch (e) {
      discoveryErrors.push(e.message || String(e));
    }
    // Registration/import stores the last successful payload. Keep it as an
    // offline source so a transient Cline outage does not collapse the list.
    discovered.push(...modelsFromQauthPayload(account?.providerMeta?.modelsRaw));
    const seenQauthIds = new Set();
    live = discovered
      .map((model) => {
        const id = normalizeQauthModelId(model.id || model.model || model.name);
        const key = String(id || "").toLowerCase();
        if (!id || seenQauthIds.has(key)) return null;
        seenQauthIds.add(key);
        return {
          id,
          object: model.object || "model",
          created: model.created || null,
          owned_by: model.owned_by || model.provider || "qauth",
          kind: model.kind || classifyModel(id),
          source: "live",
          name: model.name || id,
        };
      })
      .filter(Boolean);
    if (live.length) sources.push("live");
    liveWarning = discoveryErrors.length && !live.length
      ? `Cline model discovery failed: ${discoveryErrors.join("; ")}`
      : null;
  }

  if (refreshLive && account && account.authType === "apikey" && account.apiKey) {
    liveAccountId = account.id;
    try {
      const provider = getProvider(providerId);
      const baseUrl =
        account.baseUrl ||
        provider?.defaultBaseUrl ||
        (providerId === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1");
      live = await fetchOpenAIModels(baseUrl, account.apiKey);
      if (live.length) sources.push("live");
    } catch (e) {
      liveWarning =
        e.status === 403
          ? "API key cannot list models (missing api.model.read). Using catalog + manual models."
          : e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    account.providerId === "grok" &&
    account.accessToken
  ) {
    liveAccountId = account.id;
    try {
      const grokUsage = require("./oauth/grokUsage.cjs");
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
        /* */
      }
      const liveRes = await grokUsage.fetchGrokModels(account.accessToken);
      if (liveRes.ok && liveRes.models?.length) {
        live = liveRes.models;
        sources.push("live");
      } else if (cliCache.length) {
        liveWarning = "Live models failed; using CLI cache + catalog.";
      } else {
        liveWarning = liveRes.error || "Could not load live Grok models.";
      }
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    account.providerId === "antigravity" &&
    account.accessToken
  ) {
    liveAccountId = account.id;
    try {
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
        /* */
      }
      const antigravityUsage = require("./oauth/antigravityUsage.cjs");
      const liveRes = await antigravityUsage.fetchAntigravityModels(
        account.accessToken,
        account.providerMeta?.projectId || account.workspaceId
      );
      if (liveRes.ok && liveRes.models?.length) {
        live = liveRes.models;
        sources.push("live");
      }
      if (liveRes.warning) liveWarning = liveRes.warning;
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    account.providerId === "gemini-cli" &&
    account.accessToken
  ) {
    liveAccountId = account.id;
    try {
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
        /* */
      }
      const geminiCliUsage = require("./oauth/geminiCliUsage.cjs");
      let siblingAccounts = [];
      try {
        const st = await storeApi.load(userDataPath);
        siblingAccounts = st.accounts || [];
      } catch {
        /* */
      }
      const liveRes = await geminiCliUsage.fetchGeminiCliUsage({
        accessToken: account.accessToken,
        projectId: account.providerMeta?.projectId || account.workspaceId,
        email: account.email,
        accounts: siblingAccounts,
      });
      if (liveRes.ok && liveRes.models?.length) {
        live = liveRes.models.map((m) => ({
          id: m.id,
          object: "model",
          created: null,
          owned_by: "google",
          kind: m.kind || "chat",
          source: "live",
          name: m.name,
        }));
        sources.push("live");
      }
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    account.providerId === "kiro" &&
    account.accessToken
  ) {
    // Live ListAvailableModels — per-account entitlement (OmniRoute parity).
    // Static FALLBACK_MODELS alone caused "Invalid model" storms when ids
    // were not on this Builder ID tier.
    liveAccountId = account.id;
    try {
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
        /* */
      }
      const kiroUsage = require("./oauth/kiroUsage.cjs");
      const liveRes = await kiroUsage.fetchLiveModels({
        accessToken: account.accessToken,
        providerMeta: account.providerMeta || {},
      });
      if (liveRes.models?.length) {
        live = liveRes.models.map((m) => ({
          id: m.id,
          object: "model",
          created: null,
          owned_by: "kiro",
          kind: m.kind || "chat",
          source: liveRes.source === "api" ? "live" : "catalog",
          name: m.name,
        }));
        if (liveRes.source === "api") {
          sources.push("live");
          // Persist per-account allowlist so pipeline preflight can use it without
          // re-hitting ListAvailableModels on every chat completion.
          try {
            const storeApi = require("./store.cjs");
            if (userDataPath && account?.id) {
              const st = await storeApi.load(userDataPath);
              const ix = (st.accounts || []).findIndex((a) => a.id === account.id);
              if (ix >= 0) {
                const ids = live.map((m) => m.id).filter(Boolean);
                st.accounts[ix].providerMeta = {
                  ...(st.accounts[ix].providerMeta || {}),
                  availableModels: ids,
                  availableModelsAt: Date.now(),
                  availableModelsSource: "live",
                };
                await storeApi.save(userDataPath, st);
                account.providerMeta = st.accounts[ix].providerMeta;
              }
            }
          } catch {
            /* cache is best-effort */
          }
        } else {
          liveWarning = "Kiro live model list unavailable; using static catalog.";
        }
      }
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    ["github-copilot", "windsurf", "cursor", "codebuddy", "codebuddy-cn", "qoder", "qauth"].includes(
      account.providerId
    ) &&
    account.accessToken
  ) {
    liveAccountId = account.id;
    try {
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
      }
      const provider = getProvider(providerId);
      const root = String(account.baseUrl || provider?.defaultBaseUrl || "").replace(/\/$/, "");
      const modelsUrl = provider?.modelsUrl
        ? provider.modelsUrl(root)
        : root.endsWith("/v1")
          ? `${root}/models`
          : `${root}/v1/models`;
      const liveRes = await fetchOpenAIModels(modelsUrl, account.accessToken);      if (liveRes.length) {
        live = liveRes.map((model) => ({ ...model, source: "live", owned_by: model.owned_by || providerId }));
        sources.push("live");
      }
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    account.providerId === "nous" &&
    (account.accessToken || account.refreshToken)
  ) {
    liveAccountId = account.id;
    try {
      try {
        const { ensureFreshToken } = require("./accounts.cjs");
        account = await ensureFreshToken(userDataPath, account);
      } catch {
      }
      const provider = getProvider(providerId);
      const root = String(account.baseUrl || provider?.defaultBaseUrl || "").replace(/\/$/, "");
      const modelsUrl = root.endsWith("/v1") ? `${root}/models` : `${root}/v1/models`;
      const liveRes = await fetchOpenAIModels(modelsUrl, account.accessToken);
      if (liveRes.length) {
        live = liveRes.map((model) => ({ ...model, source: "live", owned_by: model.owned_by || providerId }));
        sources.push("live");
      }
    } catch (e) {
      liveWarning = e.message || String(e);
    }
  } else if (
    refreshLive &&
    account &&
    account.authType === "oauth" &&
    (account.accessToken || account.refreshToken)
  ) {
    liveAccountId = account.id;
    liveWarning =
      account.providerId === "claude-code"
        ? "Claude Code uses built-in catalog (no live model list API)."
        : account.providerId === "openai" || isOpenAICodexAccount(account)
          ? "ChatGPT OAuth (Codex): showing Codex-safe models only. Platform ids like chatgpt-4o-latest / gpt-4o are blocked. Add an API key for full Platform catalog."
          : "OAuth account has no live model-list API. Showing provider catalog + manual models.";
  } else if (refreshLive && !account) {
    liveWarning =
      providerId === "antigravity"
        ? "Sign in with Google to live-sync models."
        : providerId === "kiro"
          ? "Sign in with Kiro (Builder ID) to live-sync account models."
          : providerId === "a6api"
            ? "Add models manually (a6api has no live catalog)."
            : providerId === "orcarouter"
              ? "Add OrcaRouter API keys (sk-orca-…) for multi-key rotation. Free models are in catalog."
              : "Add an API key account to live-sync models.";
  }

  // When a per-account live catalog succeeded, do NOT union static catalog ids
  // that the account does not have (Kiro free tier vs Pro — static list caused
  // "Invalid model" on ids that were only in FALLBACK_MODELS).
  // Codex OAuth: catalog is already Codex-safe and authoritative for ChatGPT accounts.
  const liveIsAuthoritative =
    (providerId === "kiro" &&
      live.length > 0 &&
      live.some((m) => m.source === "live")) ||
    (codexMode && catalog.length > 0 && live.length === 0);
  const merged = mergeModels(
    liveIsAuthoritative
      ? codexMode
        ? [...catalog, ...manual]
        : [...live, ...manual]
      : [...catalog, ...cliCache, ...live, ...manual],
    chatOnly
  );
  // Final safety: never surface Codex-blocked ids when any openai account is OAuth/Codex.
  const filtered =
    codexMode ||
    (providerId === "openai" &&
      providerAccounts.some((a) => isOpenAICodexAccount(a)))
      ? merged.filter((m) => !OPENAI_CODEX_BLOCKED_IDS.has(String(m.id || "").toLowerCase()))
      : merged;
  const models = withTags(filtered, providerId);

  return {
    ok: true,
    source: sources.join("+"),
    sources,
    providerId,
    modelTag: getProvider(providerId)?.modelTag || providerId,
    accountId: liveAccountId,
    count: models.length,
    models,
    warning: liveWarning,
  };
}

async function addCustomModel(userDataPath, providerId, modelId, meta = {}) {
  const id = normalizeId(modelId);
  if (!id) throw new Error("model id required");
  const store = await storeApi.load(userDataPath);
  if (!store.customModels || typeof store.customModels !== "object") store.customModels = {};
  if (!Array.isArray(store.customModels[providerId])) store.customModels[providerId] = [];
  const list = store.customModels[providerId];
  if (list.some((m) => normalizeId(m.id || m) === id)) {
    throw new Error(`Model already exists: ${id}`);
  }
  list.push({
    id,
    kind: meta.kind || classifyModel(id),
    owned_by: meta.owned_by || providerId,
    created: Date.now(),
    source: "manual",
  });
  await storeApi.save(userDataPath, store);
  return listModelsFor(userDataPath, { providerId, refreshLive: false });
}

async function removeCustomModel(userDataPath, providerId, modelId) {
  const id = normalizeId(modelId);
  const store = await storeApi.load(userDataPath);
  if (!store.customModels?.[providerId]) {
    return listModelsFor(userDataPath, { providerId, refreshLive: false });
  }
  store.customModels[providerId] = store.customModels[providerId].filter(
    (m) => normalizeId(m.id || m) !== id
  );
  await storeApi.save(userDataPath, store);
  return listModelsFor(userDataPath, { providerId, refreshLive: false });
}

/** OpenAI-compatible model objects for /v1/models (all providers, tagged + bare) */
async function modelsForOpenAIEndpoint(userDataPath) {
  const now = Math.floor(Date.now() / 1000);
  const data = [];
  const seen = new Set();
  // Ensure customs from store are registered before listing
  try {
    const st = await storeApi.load(userDataPath);
    registerCustomProvidersFromStore(st);
  } catch {
    /* */
  }
  // Built-ins + any dynamic custom providers currently registered
  const providerIds = [
    ...new Set([
      "openai",
      "grok",
      "antigravity",
      "a6api",
      "j3gb",
      "orcarouter",
      "gemini-cli",
      "claude-code",
      "kiro",
      ...listProviders().map((p) => p.id),
    ]),
  ];
  for (const providerId of providerIds) {
    const listed = await listModelsFor(userDataPath, {
      providerId,
      chatOnly: false,
      refreshLive: true,
    });
    for (const m of listed.models || []) {
      const bare = m.bareId || m.id;
      const tagged = m.taggedId || taggedModelId(providerId, bare);
      // Prefer tagged id as primary listing (unique across providers)
      if (!seen.has(tagged)) {
        seen.add(tagged);
        data.push({
          id: tagged,
          object: "model",
          created: m.created ? Math.floor(Number(m.created) / 1000) || now : now,
          owned_by: m.owned_by || providerId,
        });
      }
      // Also bare for convenience when only one provider owns it
      if (!seen.has(bare)) {
        seen.add(bare);
        data.push({
          id: bare,
          object: "model",
          created: now,
          owned_by: m.owned_by || providerId,
        });
      }
    }
  }
  return data;
}

module.exports = {
  listModelsFor,
  addCustomModel,
  removeCustomModel,
  modelsForOpenAIEndpoint,
  OPENAI_FALLBACK_MODELS,
  OPENAI_PLATFORM_FALLBACK_MODELS,
  OPENAI_CODEX_FALLBACK_MODELS,
  OPENAI_CODEX_BLOCKED_IDS,
  isOpenAICodexAccount,
  GROK_FALLBACK_MODELS,
  classifyModel,
  normalizeId,
  withTags,
  taggedModelId,
};
