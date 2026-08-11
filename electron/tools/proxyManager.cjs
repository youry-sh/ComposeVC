/**
 * ProxyManager — управление прокси-провайдерами, аккаунтами, API ключами,
 * кастомными провайдерами, разблокировка акков, поиск и рефреш лимитов.
 *
 * Tool для LLM: напрямую использует storeApi и proxy API (main process).
 */

const storeApi = require("../proxy/store.cjs");
const accountsApi = require("../proxy/accounts.cjs");
const { listProviders, bootstrap, registerCustomProvidersFromStore, getProvider } = require("../proxy/providers/registry.cjs");
const { createCustomProviderModule, slugifyProviderId } = require("../proxy/providers/customFactory.cjs");
const accountRouter = require("../proxy/routing/accountRouter.cjs");

function findApiKeyDuplicates(store, apiKey) {
  const normalizedKey = String(apiKey || "").trim();
  if (!normalizedKey) return [];
  const accountDuplicates = (store.accounts || []).filter(
    (account) => String(account.apiKey || "").trim() === normalizedKey
  );
  const accountIds = new Set(accountDuplicates.map((account) => account.id));
  const legacyDuplicates = (store.connections || [])
    .filter((connection) => String(connection.apiKey || "").trim() === normalizedKey)
    .filter((connection) => !accountIds.has(connection.id))
    .map((connection) => ({ ...connection, authType: "apikey" }));
  return [...accountDuplicates, ...legacyDuplicates];
}

function toPublicProvider(p) {
  return {
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
        (p.id === "openai" || p.id === "grok" || p.id === "antigravity" ||
         p.id === "gemini-cli" || p.id === "claude-code" || p.id === "kiro")
    ),
    supportsApiKey: p.supportsApiKey !== false,
    supportsCliImport: Boolean(p.supportsCliImport),
    consoleUrl: p.consoleUrl || null,
    balanceUrl: p.balanceUrl || null,
    isCustom: Boolean(p.custom || p.isCustom),
  };
}

function toPublicAccount(a, store) {
  let routing = null;
  try {
    accountRouter.hydrateFromAccount(a);
    routing = accountRouter.getStatus(a.id);
  } catch { /* */ }
  return {
    id: a.id,
    providerId: a.providerId,
    authType: a.authType || "apikey",
    name: a.name || a.email || a.providerId,
    email: a.email || null,
    planType: a.planType || null,
    workspaceId: a.workspaceId || null,
    enabled: a.enabled !== false,
    hasCredentials: Boolean(a.accessToken || a.apiKey),
    baseUrl: a.baseUrl || "",
    defaultModel: a.defaultModel || "",
    expiresAt: a.expiresAt || null,
    usage: a.usage || null,
    usageError: a.usageError || null,
    usageUpdatedAt: a.usageUpdatedAt || null,
    routing: routing ? {
      status: routing.status,
      blockedUntil: routing.blockedUntil,
      lastError: routing.lastError,
      available: routing.available,
      failStreak: routing.failStreak,
    } : null,
    priority: a.priority != null ? a.priority : null,
    createdAt: a.createdAt,
  };
}

async function execute(input, context) {
  const action = String(input.action || "").trim().toLowerCase();
  const userDataPath = context?.userDataPath || null;

  if (!userDataPath) {
    return { ok: false, error: "userDataPath required" };
  }

  try {
    bootstrap();
  } catch { /* */ }

  switch (action) {

    // ── Список провайдеров ─────────────────────────────────
    case "list_providers":
    case "providers":
    case "list_providers_all": {
      try { bootstrap(); } catch { /* */ }
      const raw = listProviders();
      const providers = raw.map(toPublicProvider);
      return {
        ok: true,
        providers,
        count: providers.length,
      };
    }

    // ── Список аккаунтов ───────────────────────────────────
    case "list_accounts":
    case "accounts": {
      const store = await storeApi.load(userDataPath);
      const providerFilter = String(input.providerId || "").trim().toLowerCase();
      const searchQuery = String(input.search || "").trim().toLowerCase();
      const includeDisabled = input.includeDisabled === true;

      let accounts = (store.accounts || []).map((a) => toPublicAccount(a, store));

      if (providerFilter) {
        accounts = accounts.filter((a) => a.providerId.toLowerCase() === providerFilter);
      }

      if (searchQuery) {
        accounts = accounts.filter((a) =>
          (a.name && a.name.toLowerCase().includes(searchQuery)) ||
          (a.email && a.email.toLowerCase().includes(searchQuery)) ||
          (a.id && a.id.toLowerCase().includes(searchQuery)) ||
          (a.providerId && a.providerId.toLowerCase().includes(searchQuery))
        );
      }

      if (!includeDisabled) {
        accounts = accounts.filter((a) => a.enabled);
      }

      return {
        ok: true,
        accounts,
        count: accounts.length,
        total: (store.accounts || []).length,
      };
    }

    // ── Поиск по аккаунтам и провайдерам ──────────────────
    case "search": {
      const query = String(input.query || input.search || "").trim().toLowerCase();
      if (!query) return { ok: false, error: "query required" };

      const store = await storeApi.load(userDataPath);
      try { bootstrap(); } catch { /* */ }

      const providerResults = (listProviders() || []).filter((p) =>
        (p.id && p.id.toLowerCase().includes(query)) ||
        (p.name && p.name.toLowerCase().includes(query)) ||
        (p.alias && p.alias.toLowerCase().includes(query)) ||
        (p.description && p.description.toLowerCase().includes(query))
      ).map(toPublicProvider);

      const accountResults = (store.accounts || []).filter((a) =>
        (a.name && a.name.toLowerCase().includes(query)) ||
        (a.email && a.email.toLowerCase().includes(query)) ||
        (a.id && a.id.toLowerCase().includes(query)) ||
        (a.providerId && a.providerId.toLowerCase().includes(query)) ||
        (a.planType && a.planType.toLowerCase().includes(query))
      ).map((a) => toPublicAccount(a, store));

      const customProviders = (store.customProviders || []).filter((p) =>
        (p.id && p.id.toLowerCase().includes(query)) ||
        (p.name && p.name.toLowerCase().includes(query)) ||
        (p.baseUrl && p.baseUrl.toLowerCase().includes(query))
      );

      return {
        ok: true,
        query,
        providers: providerResults,
        accounts: accountResults,
        customProviders,
        providerCount: providerResults.length,
        accountCount: accountResults.length,
        customProviderCount: customProviders.length,
      };
    }

    // ── Добавить API key аккаунт ───────────────────────────
    case "add_account":
    case "add_api_key_account": {
      const providerId = String(input.providerId || "").trim();
      const apiKey = String(input.apiKey || "").trim();
      if (!providerId) return { ok: false, error: "providerId required" };
      if (!apiKey) return { ok: false, error: "apiKey required" };

      const store = await storeApi.load(userDataPath);
      const duplicateAccounts = findApiKeyDuplicates(store, apiKey);
      if (duplicateAccounts.length > 0 && input.confirmDuplicate !== true) {
        return {
          ok: false,
          duplicateKey: true,
          duplicateCount: duplicateAccounts.length,
          duplicateProviders: [...new Set(duplicateAccounts.map((a) => a.providerId).filter(Boolean))],
          error: "This API key already exists. Confirm to add it again.",
        };
      }

      const account = {
        id: storeApi.newId("acc"),
        providerId,
        authType: "apikey",
        name: input.name || providerId,
        email: input.email || null,
        planType: null,
        workspaceId: null,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        expiresAt: null,
        apiKey,
        baseUrl: input.baseUrl || "",
        defaultModel: input.defaultModel || "",
        enabled: true,
        usage: null,
        usageError: null,
        usageUpdatedAt: null,
        createdAt: Date.now(),
        priority: input.priority != null ? Number(input.priority) : undefined,
      };
      store.accounts.push(account);
      store.connections.push({
        id: account.id,
        providerId,
        name: account.name,
        baseUrl: account.baseUrl,
        apiKey: account.apiKey,
        defaultModel: account.defaultModel,
        enabled: true,
        createdAt: account.createdAt,
      });
      const next = await storeApi.save(userDataPath, store);

      // Попробовать сразу отрефрешить usage
      try {
        await accountsApi.refreshAccountUsage(userDataPath, account.id);
        const refreshed = await storeApi.load(userDataPath);
        const refAccount = refreshed.accounts.find((a) => a.id === account.id);
        return {
          ok: true,
          accountId: account.id,
          account: refAccount ? toPublicAccount(refAccount, refreshed) : null,
          message: `Account ${account.name} (${providerId}) added and usage refreshed`,
        };
      } catch {
        return {
          ok: true,
          accountId: account.id,
          account: toPublicAccount(account, next),
          message: `Account ${account.name} (${providerId}) added`,
        };
      }
    }

    // ── Добавить OAuth аккаунт по токенам (JWT / refresh) ──
    case "add_oauth_account":
    case "add_token_account":
    case "import_oauth_token": {
      const oauthImport = require("../proxy/oauthImport.cjs");
      const providerId = String(input.providerId || "").trim();
      if (!providerId) return { ok: false, error: "providerId required" };
      const accessToken = String(input.accessToken || input.token || input.jwt || "").trim();
      if (!accessToken) return { ok: false, error: "accessToken (JWT) required" };

      const result = await oauthImport.importOauthTokens(userDataPath, {
        providerId,
        accessToken,
        refreshToken: String(input.refreshToken || "").trim() || undefined,
        idToken: String(input.idToken || "").trim() || undefined,
        email: String(input.email || "").trim() || undefined,
        name: String(input.name || "").trim() || undefined,
        planType: String(input.planType || "").trim() || undefined,
        workspaceId: String(input.workspaceId || "").trim() || undefined,
        baseUrl: String(input.baseUrl || "").trim() || undefined,
        defaultModel: String(input.defaultModel || "").trim() || undefined,
        expiresAt: input.expiresAt ? Number(input.expiresAt) : undefined,
      });

      if (!result.ok) return { ok: false, error: result.error || "import failed" };
      const store = await storeApi.load(userDataPath);
      const acc = store.accounts.find((a) => a.id === result.accountId);
      return {
        ok: true,
        mode: result.mode,
        accountId: result.accountId,
        email: result.email || acc?.email || null,
        planType: acc?.planType || null,
        account: acc ? toPublicAccount(acc, store) : null,
        message:
          result.mode === "updated"
            ? `OAuth account updated (${providerId})`
            : `OAuth account added (${providerId})`,
      };
    }

    // ── Добавить OAuth аккаунты пачкой (text: JWT / JWT:refresh построчно) ──
    case "add_oauth_accounts_text":
    case "import_oauth_tokens_text":
    case "import_oauth_token_text": {
      const oauthImport = require("../proxy/oauthImport.cjs");
      const providerId = String(input.providerId || "").trim();
      const text = String(input.text || input.tokens || "").trim();
      if (!providerId) return { ok: false, error: "providerId required" };
      if (!text) return { ok: false, error: "text required (JWT / JWT:refresh per line)" };

      const result = await oauthImport.importOauthTokensText(userDataPath, providerId, text);
      return {
        ok: result.ok,
        providerId,
        added: result.added || 0,
        updated: result.updated || 0,
        skipped: result.skipped || 0,
        failed: result.failed || 0,
        total: result.total || 0,
        errors: result.errors || [],
        error: result.ok ? null : result.error || (result.errors?.[0]?.error) || "import failed",
        message: result.ok
          ? `Imported ${result.added || 0} new, ${result.updated || 0} updated, ${result.failed || 0} failed (${providerId})`
          : (result.error || "import failed"),
      };
    }

    // ── Удалить аккаунт ────────────────────────────────────
    case "delete_account":
    case "remove_account": {
      const accountId = String(input.accountId || input.id || "").trim();
      if (!accountId) return { ok: false, error: "accountId required" };
      const store = await storeApi.load(userDataPath);
      const idx = store.accounts.findIndex((a) => a.id === accountId);
      if (idx < 0) return { ok: false, error: "account not found" };
      const removed = store.accounts[idx];
      store.accounts.splice(idx, 1);
      store.connections = (store.connections || []).filter((c) => c.id !== accountId);
      await storeApi.save(userDataPath, store);
      return {
        ok: true,
        deletedAccountId: accountId,
        deletedProviderId: removed.providerId,
        deletedName: removed.name || removed.providerId,
      };
    }

    // ── Включить/выключить аккаунт ─────────────────────────
    case "toggle_account":
    case "enable_account":
    case "disable_account": {
      const accId = String(input.accountId || input.id || "").trim();
      if (!accId) return { ok: false, error: "accountId required" };
      const store = await storeApi.load(userDataPath);
      const idx = store.accounts.findIndex((a) => a.id === accId);
      if (idx < 0) return { ok: false, error: "account not found" };
      const currentEnabled = store.accounts[idx].enabled !== false;
      const wantEnabled = action === "enable_account" ? true : action === "disable_account" ? false : !currentEnabled;
      store.accounts[idx].enabled = wantEnabled;
      // sync connections
      const connIdx = (store.connections || []).findIndex((c) => c.id === accId);
      if (connIdx >= 0) store.connections[connIdx].enabled = wantEnabled;
      await storeApi.save(userDataPath, store);
      return {
        ok: true,
        accountId: accId,
        enabled: wantEnabled,
        wasEnabled: currentEnabled,
        name: store.accounts[idx].name || store.accounts[idx].providerId,
      };
    }

    // ── Разблокировать аккаунт (снять quota/rate-limit блок) ─
    case "unblock_account":
    case "clear_quota":
    case "unlock_account": {
      const uid = String(input.accountId || input.id || "").trim();
      if (!uid) return { ok: false, error: "accountId required" };
      const store = await storeApi.load(userDataPath);
      const aidx = store.accounts.findIndex((a) => a.id === uid);
      if (aidx < 0) return { ok: false, error: "account not found" };
      const account = store.accounts[aidx];
      accountRouter.hydrateFromAccount(account);
      const cleared = accountRouter.clearQuotaBlock(uid, account);
      if (!cleared?.ok) return { ok: false, error: cleared?.error || "clear failed" };
      store.accounts[aidx] = account;
      await storeApi.save(userDataPath, store);
      const fresh = await storeApi.load(userDataPath);
      const freshAccount = fresh.accounts.find((a) => a.id === uid);
      if (freshAccount) accountRouter.hydrateFromAccount(freshAccount);
      const status = accountRouter.getStatus(uid);
      return {
        ok: true,
        accountId: uid,
        status: cleared.status,
        routing: status ? {
          status: status.status,
          blockedUntil: status.blockedUntil,
          available: status.available,
          lastError: status.lastError,
        } : null,
        message: `Account ${account.name || account.providerId} unblocked`,
      };
    }

    // ── Рефреш лимитов (usage) ─────────────────────────────
    case "refresh_usage":
    case "refresh_limits":
    case "refresh_account": {
      const rid = String(input.accountId || input.id || "").trim();
      if (rid) {
        const result = await accountsApi.refreshAccountUsage(userDataPath, rid);
        const store = await storeApi.load(userDataPath);
        const acc = store.accounts.find((a) => a.id === rid);
        return {
          ok: result.ok,
          accountId: rid,
          account: acc ? toPublicAccount(acc, store) : null,
          error: result.error || null,
          message: result.ok ? "Usage refreshed" : result.error || "refresh failed",
        };
      }
      // refresh all
      const results = await accountsApi.refreshAllUsage(userDataPath);
      const store = await storeApi.load(userDataPath);
      return {
        ok: true,
        refreshed: (results || []).filter((r) => r.ok).length,
        failed: (results || []).filter((r) => !r.ok).length,
        total: (results || []).length,
        accounts: storeApi.publicView(store).accounts,
        message: `Refreshed ${(results || []).filter((r) => r.ok).length}/${(results || []).length} accounts`,
      };
    }

    // ── Кастомные провайдеры ───────────────────────────────
    case "list_custom_providers": {
      const store = await storeApi.load(userDataPath);
      return {
        ok: true,
        customProviders: (store.customProviders || []).map((p) => ({
          id: p.id,
          name: p.name || p.id,
          baseUrl: p.baseUrl || "",
          modelTag: p.modelTag || p.id,
          description: p.description || "",
          createdAt: p.createdAt || null,
        })),
        count: (store.customProviders || []).length,
      };
    }

    case "add_custom_provider": {
      const name = String(input.name || "").trim();
      const baseUrl = String(input.baseUrl || "").trim();
      if (!name) return { ok: false, error: "name required" };
      if (!baseUrl) return { ok: false, error: "baseUrl required" };
      const store = await storeApi.load(userDataPath);
      const id = input.id || slugifyProviderId(name);
      if ((store.customProviders || []).find((p) => p.id === id)) {
        return { ok: false, error: `Custom provider "${id}" already exists` };
      }
      const provider = {
        id,
        name,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        modelTag: input.modelTag || id,
        description: input.description || "",
        createdAt: Date.now(),
      };
      store.customProviders = [...(store.customProviders || []), provider];
      await storeApi.save(userDataPath, store);
      // Register the new provider immediately
      try {
        registerCustomProvidersFromStore({ customProviders: store.customProviders });
      } catch { /* */ }
      return { ok: true, provider, message: `Custom provider "${name}" added` };
    }

    case "update_custom_provider": {
      const pid = String(input.id || input.providerId || "").trim();
      if (!pid) return { ok: false, error: "id required" };
      const store = await storeApi.load(userDataPath);
      const cidx = (store.customProviders || []).findIndex((p) => p.id === pid);
      if (cidx < 0) return { ok: false, error: `Custom provider "${pid}" not found` };
      const patch = {};
      if (input.name) patch.name = String(input.name).trim();
      if (input.baseUrl) patch.baseUrl = String(input.baseUrl).trim().replace(/\/+$/, "");
      if (input.modelTag) patch.modelTag = String(input.modelTag).trim();
      if (input.description !== undefined) patch.description = String(input.description).trim();
      if (input.apiKey) {
        // If apiKey provided, also create/find account for this provider
        patch.apiKey = String(input.apiKey).trim();
      }
      store.customProviders[cidx] = { ...store.customProviders[cidx], ...patch, id: pid };
      await storeApi.save(userDataPath, store);
      // Re-register
      try {
        registerCustomProvidersFromStore({ customProviders: store.customProviders });
      } catch { /* */ }
      return { ok: true, provider: store.customProviders[cidx], message: `Custom provider "${pid}" updated` };
    }

    case "delete_custom_provider": {
      const did = String(input.id || input.providerId || "").trim();
      if (!did) return { ok: false, error: "id required" };
      const store = await storeApi.load(userDataPath);
      const before = (store.customProviders || []).length;
      store.customProviders = (store.customProviders || []).filter((p) => p.id !== did);
      if (store.customProviders.length === before) {
        return { ok: false, error: `Custom provider "${did}" not found` };
      }
      // Also remove associated accounts
      store.accounts = (store.accounts || []).filter((a) => a.providerId !== did);
      store.connections = (store.connections || []).filter((c) => c.providerId !== did);
      await storeApi.save(userDataPath, store);
      // Unregister
      const reg = require("../proxy/providers/registry.cjs");
      if (typeof reg.unregisterProvider === "function") reg.unregisterProvider(did);
      return {
        ok: true,
        deletedProviderId: did,
        message: `Custom provider "${did}" and its accounts deleted`,
      };
    }

    // ── Статус роутинга ────────────────────────────────────
    case "routing_status":
    case "routing": {
      const store = await storeApi.load(userDataPath);
      const statuses = {};
      for (const a of store.accounts || []) {
        try {
          accountRouter.hydrateFromAccount(a);
          const st = accountRouter.getStatus(a.id);
          if (st) {
            statuses[a.id] = {
              accountId: a.id,
              name: a.name || a.providerId,
              providerId: a.providerId,
              status: st.status,
              blockedUntil: st.blockedUntil,
              blockedForMs: st.blockedUntil ? Math.max(0, st.blockedUntil - Date.now()) : 0,
              lastError: st.lastError,
              available: st.available,
              failStreak: st.failStreak,
              inFlightCount: st.inFlightCount,
              lastUsedAt: st.lastUsedAt,
              lastSuccessAt: st.lastSuccessAt,
            };
          }
        } catch { /* */ }
      }
      return { ok: true, statuses: Object.values(statuses) };
    }

    // ── Инфо о провайдере ──────────────────────────────────
    case "get_provider": {
      const pid = String(input.providerId || input.id || "").trim();
      if (!pid) return { ok: false, error: "providerId required" };
      try { bootstrap(); } catch { /* */ }
      const p = getProvider(pid);
      if (!p) return { ok: false, error: `Provider "${pid}" not found` };
      const store = await storeApi.load(userDataPath);
      const providerAccounts = (store.accounts || [])
        .filter((a) => a.providerId === pid)
        .map((a) => toPublicAccount(a, store));
      return {
        ok: true,
        provider: toPublicProvider(p),
        accounts: providerAccounts,
        accountCount: providerAccounts.length,
      };
    }

    // ── Полный конфиг прокси ───────────────────────────────
    case "get_config":
    case "config": {
      const store = await storeApi.load(userDataPath);
      return {
        ok: true,
        config: storeApi.publicView(store),
      };
    }

    // ── Неизвестное действие ──────────────────────────────
    default: {
      return {
        ok: false,
        error: `Unknown action: "${action}". Available actions: list_providers, list_accounts, list_custom_providers, search, add_account, add_oauth_account, add_oauth_accounts_text, delete_account, toggle_account, enable_account, disable_account, unblock_account, clear_quota, refresh_usage, refresh_limits, add_custom_provider, update_custom_provider, delete_custom_provider, routing_status, get_provider, get_config`,
        availableActions: [
          "list_providers",
          "list_accounts",
          "list_custom_providers",
          "search",
          "add_account",
          "add_oauth_account (providerId + accessToken + refreshToken; Nous: providerId=nous)",
          "add_oauth_accounts_text (providerId + text; Nous: one access:refresh pair per line)",
          "delete_account",
          "toggle_account / enable_account / disable_account",
          "unblock_account / clear_quota",
          "refresh_usage / refresh_limits",
          "add_custom_provider",
          "update_custom_provider",
          "delete_custom_provider",
          "routing_status",
          "get_provider",
          "get_config",
        ],
      };
    }
  }
}

// Dispose handler (no live resources)
function disposeAll() {
  return { ok: true };
}

module.exports = {
  name: "proxy_manager",
  description:
    "Manage the proxy system: providers, accounts, API keys, custom providers, routing, and usage limits. " +
    "Actions: list_providers (all providers), list_accounts (filter by providerId/search), " +
    "list_custom_providers, search (accounts and providers), " +
    "add_account (API-key account: providerId + apiKey), " +
    "add_oauth_account (OAuth account: providerId + accessToken + refreshToken; Nous requires both), " +
    "add_oauth_accounts_text (bulk token import; Nous accepts one access:refresh pair per line), " +
    "delete_account, toggle_account/enable_account/disable_account, unblock_account/clear_quota, " +
    "refresh_usage/refresh_limits (one account or all), " +
    "add_custom_provider (name + baseUrl), update_custom_provider, delete_custom_provider, " +
    "routing_status, get_provider, and get_config.",
  isReadOnly: false,
  disposeAll,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "list_providers | list_accounts | list_custom_providers | search | add_account | add_oauth_account | " +
          "add_oauth_accounts_text | delete_account | " +
          "toggle_account | enable_account | disable_account | unblock_account | clear_quota | " +
          "refresh_usage | refresh_limits | add_custom_provider | update_custom_provider | " +
          "delete_custom_provider | routing_status | get_provider | get_config",
      },
      providerId: {
        type: "string",
        description: "Provider ID for filtering, lookup, or creating an account or custom provider.",
      },
      accountId: { type: "string", description: "Account ID for deletion, unblocking, or usage refresh." },
      id: { type: "string", description: "Alias for accountId or providerId." },
      apiKey: { type: "string", description: "API key for add_account." },
      confirmDuplicate: {
        type: "boolean",
        description: "Allow adding an API key that already exists under any provider.",
      },
      accessToken: {
        type: "string",
        description: "Access token for add_oauth_account. Hermes Agent requires providerId=nous, a live access token, and refreshToken.",
      },
      token: { type: "string", description: "Alias for accessToken." },
      jwt: { type: "string", description: "Alias for accessToken." },
      refreshToken: {
        type: "string",
        description: "Refresh token for add_oauth_account. Required for Nous Research Hermes Agent (rt_...).",
      },
      idToken: { type: "string", description: "Optional ID token for add_oauth_account." },
      text: {
        type: "string",
        description:
          "Bulk input for add_oauth_accounts_text: one JWT or JWT:refresh pair per line (email:password:JWT:refresh is also accepted), " +
          "or complete JSON from ~/.codex/auth.json or Claude credentials.json (tokens.access_token / refresh_token / account_id / last_refresh).",
      },
      tokens: { type: "string", description: "Alias for text." },
      name: { type: "string", description: "Name for add_account or add_custom_provider." },
      email: { type: "string", description: "Email for add_account." },
      baseUrl: { type: "string", description: "Base URL for add_account or add_custom_provider." },
      defaultModel: { type: "string", description: "Default model for add_account." },
      modelTag: { type: "string", description: "Model tag for a custom provider." },
      description: { type: "string", description: "Description for a custom provider." },
      search: { type: "string", description: "Search query for list_accounts or search." },
      query: { type: "string", description: "Alias search query for search." },
      priority: { type: "number", description: "Account priority; lower values are higher priority." },
      includeDisabled: { type: "boolean", description: "Include disabled accounts in list_accounts." },
    },
    required: ["action"],
  },
  execute,
};
