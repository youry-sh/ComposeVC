/**
 * Provider module registry.
 *
 * To add a provider:
 * 1. Create providers/<id>.cjs exporting { id, name, wireFormat, defaultBaseUrl, buildUrl, buildHeaders, parseStream }
 * 2. require + registerProvider() here
 * 3. Ensure convert/registry has openai → wireFormat converters
 */

const providers = new Map();
/** tag (alias) → providerId  e.g. xai → grok, openai → openai */
const tagToProvider = new Map();
/** ids of dynamically registered custom providers (store.customProviders) */
const dynamicCustomIds = new Set();

function registerProvider(mod) {
  if (!mod?.id) throw new Error("provider module requires id");
  providers.set(mod.id, mod);
  const tags = new Set([
    mod.id,
    mod.alias,
    mod.modelTag,
    ...(Array.isArray(mod.modelTags) ? mod.modelTags : []),
  ]);
  for (const t of tags) {
    if (t) tagToProvider.set(String(t).toLowerCase(), mod.id);
  }
  return mod;
}

function unregisterProvider(id) {
  if (!id || !providers.has(id)) return false;
  const mod = providers.get(id);
  providers.delete(id);
  dynamicCustomIds.delete(id);
  // Drop tags that pointed at this provider
  for (const [tag, pid] of [...tagToProvider.entries()]) {
    if (pid === id) tagToProvider.delete(tag);
  }
  // Re-bind tags from remaining providers if any shared aliases (shouldn't for custom)
  void mod;
  return true;
}

function getProvider(id) {
  if (!id) return null;
  const key = String(id);
  if (providers.has(key)) return providers.get(key);
  const viaTag = tagToProvider.get(key.toLowerCase());
  if (viaTag) return providers.get(viaTag) || null;
  return null;
}

/** Resolve provider id from a model tag prefix (openai, xai, grok, antigravity). */
function resolveProviderIdFromTag(tag) {
  if (!tag) return null;
  // bareModelId / taggedModelId may run before server bootstrap — ensure tags exist
  if (!providers.size) bootstrap();
  return tagToProvider.get(String(tag).toLowerCase()) || null;
}

function listProviders() {
  return [...providers.values()].map((p) => ({
    id: p.id,
    name: p.name,
    alias: p.alias || p.id,
    modelTag: p.modelTag || p.alias || p.id,
    modelTags: p.modelTags || [p.modelTag || p.alias || p.id],
    wireFormat: p.wireFormat,
    defaultBaseUrl: p.defaultBaseUrl,
    description: p.description || "",
    supportsOauth: Boolean(
      p.supportsOauth ??
        (p.id === "openai" ||
          p.id === "grok" ||
          p.id === "antigravity" ||
          p.id === "gemini-cli" ||
          p.id === "claude-code" ||
          p.id === "kiro")
    ),
    supportsApiKey: p.supportsApiKey !== false,
    supportsCliImport: Boolean(p.supportsCliImport),
    consoleUrl: p.consoleUrl || null,
    failoverOnAnyError: Boolean(p.failoverOnAnyError),
    maxFailoverAttempts: p.maxFailoverAttempts || null,
    custom: Boolean(p.custom || p.isCustom),
    isCustom: Boolean(p.custom || p.isCustom),
  }));
}

/**
 * Register / refresh user-defined OpenAI-compatible providers from store.customProviders.
 * Safe to call often (e.g. after load / after add/delete).
 */
function registerCustomProvidersFromStore(store) {
  bootstrap();
  const { createCustomProviderModule } = require("./customFactory.cjs");
  const list = Array.isArray(store?.customProviders) ? store.customProviders : [];
  const wanted = new Set();

  for (const rec of list) {
    if (!rec?.id || !rec?.baseUrl) continue;
    const id = String(rec.id).trim();
    if (!id) continue;
    // Never override built-in provider ids
    if (providers.has(id) && !dynamicCustomIds.has(id)) continue;
    try {
      const mod = createCustomProviderModule(rec);
      registerProvider(mod);
      dynamicCustomIds.add(id);
      wanted.add(id);
    } catch {
      /* skip invalid entry */
    }
  }

  // Unregister customs no longer in store
  for (const id of [...dynamicCustomIds]) {
    if (!wanted.has(id)) unregisterProvider(id);
  }

  return listProviders().filter((p) => p.custom);
}

function bootstrap() {
  if (providers.size) return;
  registerProvider(require("./openai.cjs"));
  registerProvider(require("./grok.cjs"));
  registerProvider(require("./antigravity.cjs"));
  registerProvider(require("./a6api.cjs"));
  registerProvider(require("./j3gb.cjs"));
  registerProvider(require("./orcarouter.cjs"));
  registerProvider(require("./openrouter.cjs"));
  registerProvider(require("./zai.cjs"));
  registerProvider(require("./deepseek.cjs"));
  registerProvider(require("./gemini-cli.cjs"));
  registerProvider(require("./claude-code.cjs"));
  registerProvider(require("./kiro.cjs"));
  registerProvider(require("./google-ai-studio.cjs"));
  registerProvider(require("./github-copilot.cjs"));
  registerProvider(require("./windsurf.cjs"));
  registerProvider(require("./cursor.cjs"));
  registerProvider(require("./codebuddy.cjs"));
  registerProvider(require("./codebuddy-cn.cjs"));
  registerProvider(require("./qoder.cjs"));
  registerProvider(require("./qauth.cjs"));
  registerProvider(require("./opencode-go.cjs"));
  registerProvider(require("./opencode.cjs"));
  registerProvider(require("./anthropic.cjs"));
  registerProvider(require("./perplexity.cjs"));
  registerProvider(require("./nous.cjs"));
  // registerProvider(require("./gemini.cjs"));
}

/** All modules that exist on disk (for future enable) */
function listAvailableProviderModules() {
  return [
    { id: "openai", enabled: true },
    { id: "grok", enabled: true },
    { id: "antigravity", enabled: true },
    { id: "a6api", enabled: true },
    { id: "j3gb", enabled: true },
    { id: "orcarouter", enabled: true },
    { id: "openrouter", enabled: true },
    { id: "zai", enabled: true },
    { id: "deepseek", enabled: true },
    { id: "gemini-cli", enabled: true },
    { id: "claude-code", enabled: true },
    { id: "kiro", enabled: true },
    { id: "google-ai-studio", enabled: true },
    { id: "github-copilot", enabled: true },
    { id: "windsurf", enabled: true },
    { id: "cursor", enabled: true },
    { id: "codebuddy", enabled: true },
    { id: "codebuddy-cn", enabled: true },
    { id: "qoder", enabled: true },
    { id: "qauth", enabled: true },
    { id: "opencode-go", enabled: true },
    { id: "opencode", enabled: true },
    { id: "anthropic", enabled: true },
    { id: "perplexity", enabled: true },
    { id: "nous", enabled: true },
    { id: "gemini", enabled: false },
  ];
}

/**
 * Tag a bare model id for a provider: xai/grok-4.5
 */
function taggedModelId(providerId, modelId) {
  const p = getProvider(providerId);
  const tag = (p?.modelTag || p?.alias || providerId || "model").toLowerCase();
  // Strip only known provider tags — keep org/model ids (deepseek/deepseek-v4-flash-free)
  let bare = String(modelId || "").trim();
  while (bare.includes("/")) {
    const idx = bare.indexOf("/");
    const prefix = bare.slice(0, idx).toLowerCase();
    if (!resolveProviderIdFromTag(prefix)) break;
    bare = bare.slice(idx + 1);
  }
  return `${tag}/${bare}`;
}

/**
 * Parse "xai/grok-4.5" → { providerId, tag, bareModel }
 */
function parseTaggedModel(modelName) {
  const model = String(modelName || "").trim();
  if (!model.includes("/")) {
    return { providerId: null, tag: null, bareModel: model, tagged: false };
  }
  const [tag, ...rest] = model.split("/");
  const bareModel = rest.join("/");
  const providerId = resolveProviderIdFromTag(tag);
  return {
    providerId,
    tag: tag.toLowerCase(),
    bareModel,
    tagged: Boolean(providerId && bareModel),
  };
}

module.exports = {
  registerProvider,
  unregisterProvider,
  getProvider,
  listProviders,
  listAvailableProviderModules,
  bootstrap,
  registerCustomProvidersFromStore,
  resolveProviderIdFromTag,
  taggedModelId,
  parseTaggedModel,
  tagToProvider,
};
