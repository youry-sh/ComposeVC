/**
 * Resolve model → provider + ordered account candidates (smart routing).
 * Supports tagged models: openai/gpt-4o, xai/grok-4.5, antigravity/gemini-3.1-pro-high
 */

const {
  getProvider,
  parseTaggedModel,
  resolveProviderIdFromTag,
} = require("./providers/registry.cjs");
const accountRouter = require("./routing/accountRouter.cjs");

function listEnabledAccounts(store) {
  const fromAccounts = (store.accounts || []).filter((a) => a.enabled !== false);
  // Legacy connections are duplicates of accounts in newer stores.
  // Only process them if accounts list is empty or there are connections not in accounts.
  const accountIds = new Set(fromAccounts.map((a) => a.id));
  const extraConn = (store.connections || []).filter(
    (c) => c.enabled !== false && c.apiKey && !accountIds.has(c.id)
  );
  if (!extraConn.length) return fromAccounts;
  const mapped = extraConn.map((c) => ({
    id: c.id,
    providerId: c.providerId,
    authType: "apikey",
    apiKey: c.apiKey,
    baseUrl: c.baseUrl,
    defaultModel: c.defaultModel,
    accessToken: null,
    enabled: true,
    createdAt: c.createdAt || 0,
  }));
  return [...fromAccounts, ...mapped];
}

function resolveProviderAndModel(store, modelName, accounts) {
  const model = String(modelName || "").trim();
  if (!model) return { ok: false, error: "model is required" };

  const routes = store.routes || {};
  let route = routes[model] || routes[model.toLowerCase()];

  // Explicit provider/model or provider:model (tags: xai/grok-4.5, antigravity/…)
  if (!route) {
    const parsed = parseTaggedModel(model);
    if (parsed.tagged && parsed.providerId) {
      route = { providerId: parsed.providerId, upstreamModel: parsed.bareModel, tag: parsed.tag };
    }
  }
  if (!route && model.includes(":")) {
    const idx = model.indexOf(":");
    const tag = model.slice(0, idx);
    const upstreamModel = model.slice(idx + 1);
    const providerId = resolveProviderIdFromTag(tag) || (getProvider(tag) ? tag : null);
    if (providerId && upstreamModel) {
      route = { providerId, upstreamModel, tag };
    }
  }

  if (!route) {
    const byName = accounts.find((a) => a.name === model || a.id === model || a.email === model);
    if (byName) {
      route = {
        providerId: byName.providerId,
        upstreamModel: byName.defaultModel || model,
        accountId: byName.id,
      };
    }
  }

  // Heuristic bare ids → provider when an account exists
  // Build provider sets once to avoid 8× O(N) scans over 170 accounts
  const providerIds = new Set();
  const providerIdsWithCreds = new Set();
  for (const a of accounts) {
    providerIds.add(a.providerId);
    if (a.accessToken || a.apiKey) providerIdsWithCreds.add(a.providerId);
  }

  if (!route && /^(grok-|grok$)/i.test(model) && providerIds.has("grok")) {
    route = { providerId: "grok", upstreamModel: model };
  }
  // Prefer Claude Code OAuth for bare claude-* when that provider is connected
  if (
    !route &&
    /^claude-/i.test(model) &&
    providerIdsWithCreds.has("claude-code")
  ) {
    route = { providerId: "claude-code", upstreamModel: model };
  }
  // Kiro catalog ids (sonnet/haiku/deepseek/minimax/glm/qwen) when only Kiro is connected
  if (
    !route &&
    providerIdsWithCreds.has("kiro") &&
    /^(claude-(sonnet|haiku)|deepseek|minimax|glm-|qwen3-coder)/i.test(model)
  ) {
    route = { providerId: "kiro", upstreamModel: model };
  }
  if (
    !route &&
    /^(gemini-|claude-|gpt-oss)/i.test(model) &&
    providerIds.has("antigravity")
  ) {
    route = { providerId: "antigravity", upstreamModel: model };
  }

  // a6api tagged or account default only — no bare-id guess (user adds models manually)

  // OrcaRouter free DeepSeek models (deepseek/...-free) when keys present
  if (
    !route &&
    providerIdsWithCreds.has("orcarouter") &&
    /^deepseek\/deepseek-v4-(flash|pro)-free$/i.test(model)
  ) {
    route = { providerId: "orcarouter", upstreamModel: model };
  }

  if (!route && /^deepseek-(?:v4-(?:pro|flash)|chat|reasoner)/i.test(model) && providerIdsWithCreds.has("deepseek")) {
    route = { providerId: "deepseek", upstreamModel: model };
  }

  if (!route) {
    if (/^(gpt-|o[0-9]|chatgpt-|codex)/i.test(model) && providerIdsWithCreds.has("openai")) {
      route = { providerId: "openai", upstreamModel: model };
    } else if (/^grok/i.test(model) && providerIdsWithCreds.has("grok")) {
      route = { providerId: "grok", upstreamModel: model };
    } else if (providerIdsWithCreds.has("openai")) {
      route = { providerId: "openai", upstreamModel: model };
    } else if (providerIdsWithCreds.has("grok")) {
      route = { providerId: "grok", upstreamModel: model };
    } else if (providerIdsWithCreds.has("antigravity")) {
      route = { providerId: "antigravity", upstreamModel: model };
    } else if (
      /^(gemini-)/i.test(model) &&
      providerIdsWithCreds.has("gemini-cli")
    ) {
      route = { providerId: "gemini-cli", upstreamModel: model };
    } else if (
      /^(gemini-)/i.test(model) &&
      providerIdsWithCreds.has("google-ai-studio")
    ) {
      route = { providerId: "google-ai-studio", upstreamModel: model };
    } else if (providerIdsWithCreds.has("gemini-cli")) {
      route = { providerId: "gemini-cli", upstreamModel: model };
    } else if (providerIdsWithCreds.has("google-ai-studio")) {
      route = { providerId: "google-ai-studio", upstreamModel: model };
    } else if (providerIdsWithCreds.has("orcarouter")) {
      route = { providerId: "orcarouter", upstreamModel: model };
    } else if (providerIdsWithCreds.has("deepseek")) {
      route = { providerId: "deepseek", upstreamModel: model };
    } else {
      // Find first enabled account with credentials
      const first = accounts.find((a) => a.accessToken || a.apiKey);
      if (first) {
        route = { providerId: first.providerId, upstreamModel: model };
      }
    }
  }

  if (!route) {
    return {
      ok: false,
      error: `No route for model "${model}". Use tags like xai/grok-4.5, openai/gpt-4o, antigravity/gemini-3.1-pro-high, gemini-cli/gemini-2.5-pro, google-ai-studio/gemini-3.6-flash, kiro/claude-sonnet-4.5, orcarouter/deepseek/deepseek-v4-flash-free.`,
    };
  }

  const provider = getProvider(route.providerId);
  if (!provider) return { ok: false, error: `Unknown provider: ${route.providerId}` };

  return {
    ok: true,
    provider,
    providerId: route.providerId,
    upstreamModel: route.upstreamModel || model,
    pinnedAccountId: route.accountId || null,
    wireFormat: provider.resolveWireFormat
      ? provider.resolveWireFormat(route.upstreamModel || model)
      : provider.wireFormat,
    tag: route.tag || provider.modelTag || provider.id,
  };
}

function accountToConnection(account, provider) {
  const authType =
    account.authType || (account.accessToken && !account.apiKey ? "oauth" : "apikey");

  let baseUrl = account.baseUrl || provider.defaultBaseUrl;
  if (authType === "oauth") {
    if (account.providerId === "openai" || provider.id === "openai") {
      baseUrl = provider.codexBaseUrl || "https://chatgpt.com/backend-api/codex";
    } else if (account.providerId === "grok" || provider.id === "grok") {
      baseUrl = provider.cliProxyBaseUrl || "https://cli-chat-proxy.grok.com/v1";
    } else if (account.providerId === "antigravity" || provider.id === "antigravity") {
      baseUrl = provider.defaultBaseUrl || "https://daily-cloudcode-pa.googleapis.com";
    } else if (account.providerId === "gemini-cli" || provider.id === "gemini-cli") {
      baseUrl = provider.defaultBaseUrl || "https://cloudcode-pa.googleapis.com";
    } else if (account.providerId === "claude-code" || provider.id === "claude-code") {
      baseUrl = provider.defaultBaseUrl || "https://api.anthropic.com";
    } else if (account.providerId === "qauth" || provider.id === "qauth" || account.providerId === "cline" || provider.id === "cline") {
      baseUrl = account.baseUrl || "https://api.cline.bot/api/v1";
    } else {
      baseUrl = account.baseUrl || provider.defaultBaseUrl;
    }
  }

  return {
    id: account.id,
    providerId: account.providerId,
    baseUrl,
    apiKey:
      (authType === "oauth" ? account.accessToken : account.apiKey || account.accessToken) || "",
    authType,
    workspaceId: account.workspaceId || account.providerMeta?.projectId || null,
    projectId: account.providerMeta?.projectId || account.workspaceId || null,
    defaultModel: account.defaultModel || "",
    refreshToken: account.refreshToken || null,
    providerMeta: account.providerMeta || {},
    apiBackend:
      authType === "oauth" && (account.providerId === "grok" || provider.id === "grok")
        ? "responses"
        : null,
  };
}

/**
 * Resolve route with smart account ordering.
 */
function resolveRoute(store, modelName) {
  const accounts = listEnabledAccounts(store);
  const base = resolveProviderAndModel(store, modelName, accounts);
  if (!base.ok) return base;

  let candidates = accountRouter.listCandidates(accounts, base.providerId, {
    model: base.upstreamModel,
  });

  if (base.pinnedAccountId) {
    const pinned = candidates.find((c) => c.account.id === base.pinnedAccountId);
    if (pinned) {
      candidates = [pinned, ...candidates.filter((c) => c.account.id !== base.pinnedAccountId)];
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      error: `No account for provider "${base.providerId}". Sign in or add API key in Proxy tab.`,
    };
  }

  // Quick credential check — don't build connection objects for all 170 candidates
  const firstUsable = candidates.find((c) => c.account && (c.account.accessToken || c.account.apiKey));
  if (!firstUsable) {
    return {
      ok: false,
      error: `Account has no credentials for ${base.providerId}`,
    };
  }

  return {
    ok: true,
    provider: base.provider,
    providerId: base.providerId,
    upstreamModel: base.upstreamModel,
    wireFormat: base.wireFormat,
    tag: base.tag,
    candidates,
  };
}

module.exports = {
  listEnabledAccounts,
  resolveProviderAndModel,
  accountToConnection,
  resolveRoute,
};
