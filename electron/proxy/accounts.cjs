/**
 * Account helpers: ensure valid tokens + refresh usage quotas.
 */

const storeApi = require("./store.cjs");
const codexAuth = require("./oauth/codexAuth.cjs");
const codexUsage = require("./oauth/codexUsage.cjs");
const grokAuth = require("./oauth/grokAuth.cjs");
const accountRouter = require("./routing/accountRouter.cjs");
const { getProvider } = require("./providers/registry.cjs");
const { balanceProbeUrls, parseGenericBalanceUsage } = require("./balanceProbe.cjs");

/** Per-provider soft backoff after Usage API 429 (avoid openresty storms). */
const balanceUsageBackoffUntil = new Map();

function toNum(v, fb = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  return fb;
}

/**
 * Parse Usage/balance endpoint failures without treating them as inference auth death.
 * J3GB (and similar gateways) often return HTML 429 openresty or JSON
 * API_KEY_DISABLED on GET /v1/usage while chat/completions still works.
 *
 * kind:
 *   rate_limit  — temporary throttle (429 / too many requests / HTML openresty)
 *   usage_only  — usage endpoint rejected key (401 API_KEY_DISABLED etc.) — NOT inference auth
 *   error       — other usage fetch failure
 */
function classifyBalanceUsageError(status, bodyText) {
  const code = Number(status) || 0;
  const raw = String(bodyText || "");
  const lower = raw.toLowerCase();
  const isHtml = /<!doctype\s+html|<html[\s>]|<head[\s>]|<title[\s>]/i.test(raw);

  let jsonMsg = "";
  let jsonCode = "";
  if (!isHtml && raw.trim()) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") {
        jsonCode = String(j.code || j?.error?.code || "").trim();
        jsonMsg = String(
          j.message ||
            j?.error?.message ||
            (typeof j.error === "string" ? j.error : "") ||
            ""
        ).trim();
      }
    } catch {
      /* plain text / HTML fragment */
    }
  }

  // 429 / rate limit — including HTML openresty pages (do not dump HTML into UI)
  if (
    code === 429 ||
    /too many requests|rate[_\s-]?limit|throttl|slow down/.test(lower)
  ) {
    return {
      kind: "rate_limit",
      error: "Usage rate limited (429) — temporary; key not disabled",
    };
  }

  // Usage-endpoint "disabled" — gateway often reports this on /usage only.
  // Do NOT map to router auth/disabled; inference may still work.
  if (
    /api_key_disabled|api key is disabled|key is disabled|key.?disabled/.test(lower) ||
    jsonCode.toUpperCase() === "API_KEY_DISABLED"
  ) {
    const detail = jsonMsg || "API key is disabled";
    return {
      kind: "usage_only",
      error: `Usage endpoint: ${detail} (usage only — not marked disabled for chat)`,
    };
  }

  if (code === 401 || code === 403) {
    const detail = jsonMsg || (isHtml ? `HTTP ${code}` : raw.replace(/\s+/g, " ").trim().slice(0, 80));
    return {
      kind: "usage_only",
      error: `Usage endpoint HTTP ${code}${detail ? `: ${detail}` : ""} (usage only)`,
    };
  }

  if (isHtml) {
    const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
    const label = title ? title[1].replace(/\s+/g, " ").trim() : `HTTP ${code || "?"}`;
    return {
      kind: "error",
      error: `Usage unavailable: ${label}`,
    };
  }

  const short = (jsonMsg || raw.replace(/\s+/g, " ").trim()).slice(0, 120);
  return {
    kind: "error",
    error: `Usage API ${code || "?"}${short ? `: ${short}` : ""}`,
  };
}

/**
 * Clear false-positive router blocks that came from usage-endpoint noise
 * (API_KEY_DISABLED / "API key is disabled" / usage rate limited), without
 * wiping real cooldowns from chat failures that look different.
 *
 * For providers with usagePollNeverBlocks (J3GB): always force-clear any
 * routing block after a usage poll — usage is auxiliary, not a readiness gate.
 */
function clearUsageOnlyAuthFalsePositive(account, opts = {}) {
  if (!account?.id) return;
  try {
    const force = Boolean(opts.force);
    if (force) {
      // Keep last known balance for UI; never leave key unusable due to usage poll.
      accountRouter.clearQuotaBlock(account.id, account);
      return;
    }
    const st = accountRouter.getStatus(account.id);
    if (!st) return;
    const err = String(st.lastError || "");
    const usageNoise =
      /api_key_disabled|api key is disabled|usage (api|endpoint|rate)|key not disabled/i.test(err);
    if (!usageNoise) return;
    // Auth / rate_limited / error / quota with usage-noise message → unlock for routing.
    if (
      st.status === "auth" ||
      st.status === "rate_limited" ||
      st.status === "error" ||
      st.status === "quota" ||
      st.available === false
    ) {
      accountRouter.clearQuotaBlock(account.id, account);
    }
  } catch {
    /* */
  }
}

function providerUsagePollNeverBlocks(account) {
  try {
    const p = getProvider(account?.providerId);
    return Boolean(p?.usagePollNeverBlocks);
  } catch {
    return false;
  }
}

async function fetchApiKeyBalanceUsage(account) {
  const provider = getProvider(account.providerId);
  if (!provider?.balanceUrl && !provider?.probeBalance) return null;
  const providerKey = String(account.providerId || provider.id || "apikey");
  const now = Date.now();
  const backoffUntil = balanceUsageBackoffUntil.get(providerKey) || 0;
  if (backoffUntil > now) {
    const waitSec = Math.ceil((backoffUntil - now) / 1000);
    return {
      ok: false,
      kind: "rate_limit",
      error: `Usage rate limited — retry in ~${waitSec}s (key not disabled)`,
    };
  }

  const root = String(account.baseUrl || provider.defaultBaseUrl || "").replace(/\/$/, "");
  const primaryUrl = provider.balanceUrl
    ? provider.buildBalanceUrl
      ? provider.buildBalanceUrl(root)
      : root.endsWith("/v1")
        ? `${root}/usage`
        : provider.balanceUrl
    : null;
  const balanceUrls = provider.probeBalance
    ? [...new Set([...(primaryUrl ? [primaryUrl] : []), ...balanceProbeUrls(root)])]
    : primaryUrl
      ? [primaryUrl]
      : [];
  const headers = provider.buildHeaders
    ? provider.buildHeaders(account.apiKey)
    : {
        Authorization: `Bearer ${account.apiKey}`,
        Accept: "application/json",
      };

  let lastFailure = null;
  for (const balanceUrl of balanceUrls) {
    let res;
    try {
      res = await fetch(balanceUrl, { method: "GET", headers });
    } catch (e) {
      lastFailure = { ok: false, kind: "error", error: `Usage network error: ${e.message || e}` };
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const classified = classifyBalanceUsageError(res.status, text);
      if (classified.kind === "rate_limit") {
        balanceUsageBackoffUntil.set(providerKey, Date.now() + 60_000);
        return { ok: false, status: res.status, ...classified };
      }
      lastFailure = { ok: false, status: res.status, ...classified };
      continue;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      lastFailure = { ok: false, kind: "error", error: "Usage API returned non-JSON body" };
      continue;
    }

    const normalized = provider.parseBalanceUsage
      ? provider.parseBalanceUsage(data)
      : parseGenericBalanceUsage(data);
    if (!normalized || !Number.isFinite(Number(normalized.remaining))) {
      lastFailure = { ok: false, kind: "error", error: "Usage API returned an unknown balance schema" };
      continue;
    }

    balanceUsageBackoffUntil.delete(providerKey);
    const remaining = toNum(normalized.remaining);
    const usedToday = toNum(normalized.usedToday);
    const requestsToday = toNum(normalized.requestsToday);
    const unit = String(normalized.unit || "USD");
    return {
      ok: true,
      usage: {
        plan: normalized.plan || "api_key_balance",
        limitReached: normalized.limitReached ?? remaining <= 0,
        balance: remaining,
        remaining,
        unit,
        balanceOnly: Boolean(provider.balanceOnly),
        quotas: {},
        note: normalized.note || `${unit} ${remaining.toFixed(5)}`,
        detail: {
          usedToday,
          requestsToday,
          mode: normalized.mode || null,
          isValid: normalized.isValid ?? true,
          ...(normalized.detail && typeof normalized.detail === "object" ? normalized.detail : {}),
        },
        rawUpdatedAt: Date.now(),
      },
    };
  }
  return lastFailure || { ok: false, kind: "error", error: "Usage API unavailable" };
}

function jwtExpiryMs(accessToken) {
  try {
    const jwt = grokAuth.parseJwtPayload(accessToken);
    if (typeof jwt.exp === "number" && Number.isFinite(jwt.exp)) return jwt.exp * 1000;
  } catch {
    /* */
  }
  return 0;
}

function needsTokenRefresh(account, force = false) {
  if (force) return true;
  if (account.authType !== "oauth" || !account.refreshToken) return false;
  const expiresAt = Number(account.expiresAt) || jwtExpiryMs(account.accessToken) || 0;
  if (!expiresAt) return true;
  return expiresAt <= Date.now() + 120_000;
}

async function ensureFreshToken(userDataPath, account, opts = {}) {
  if (account.authType !== "oauth" || !account.refreshToken) return account;
  const force = Boolean(opts.force);
  if (!needsTokenRefresh(account, force)) return account;

  try {
    if (account.providerId === "grok") {
      const clientId =
        account.providerMeta?.oidcClientId || grokAuth.GROK_CLIENT_ID;
      const tokens = await grokAuth.refreshAccessToken(account.refreshToken, clientId);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      const jwt = grokAuth.parseJwtPayload(tokens.access_token);
      const expFromJwt = typeof jwt.exp === "number" ? jwt.exp * 1000 : 0;
      account.expiresAt =
        expFromJwt || Date.now() + (Number(tokens.expires_in) || 21600) * 1000;
      if (jwt.email) account.email = jwt.email;
      if (/token expired|re-authenticate|token refresh failed/i.test(String(account.usageError || ""))) {
        account.usageError = null;
      }
    } else if (account.providerId === "antigravity") {
      const antigravityAuth = require("./oauth/antigravityAuth.cjs");
      const tokens = await antigravityAuth.refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
      if (!account.providerMeta?.projectId) {
        try {
          const enr = await antigravityAuth.enrichWithBackend(tokens.access_token);
          if (enr.projectId) {
            account.providerMeta = {
              ...(account.providerMeta || {}),
              projectId: enr.projectId,
              tier: enr.tier || account.providerMeta?.tier,
            };
            account.workspaceId = enr.projectId;
          }
          if (enr.email) account.email = enr.email;
        } catch {
          /* */
        }
      }
    } else if (account.providerId === "nous") {
      const nousAuth = require("./oauth/nousAuth.cjs");
      const tokens = await nousAuth.refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
    } else if (account.providerId === "gemini-cli") {
      const geminiCliAuth = require("./oauth/geminiCliAuth.cjs");
      const tokens = await geminiCliAuth.refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
      if (!account.providerMeta?.projectId && !account.workspaceId) {
        try {
          // Sibling Antigravity accounts (same Google email) often already have a GCP project
          let siblingAccounts = [];
          try {
            const s = await storeApi.load(userDataPath);
            siblingAccounts = s.accounts || [];
          } catch {
            /* */
          }
          const enr = await geminiCliAuth.enrichWithBackend(tokens.access_token, {
            email: account.email,
            accounts: siblingAccounts,
            preferredProjectId: account.providerMeta?.projectId || account.workspaceId,
          });
          if (enr.projectId) {
            account.providerMeta = {
              ...(account.providerMeta || {}),
              projectId: enr.projectId,
              tier: enr.tier || account.providerMeta?.tier,
            };
            account.workspaceId = enr.projectId;
          }
          if (enr.email) account.email = enr.email;
          // Soft note only — never block the account with Missing GCP usageError (OmniRoute #338)
          if (!enr.projectId && enr.projectNote) {
            account.usage = {
              ...(account.usage || {}),
              plan: account.planType || "Needs GCP project",
              note: enr.projectNote,
            };
          }
        } catch {
          /* */
        }
      }
    } else if (account.providerId === "claude-code") {
      const claudeCodeAuth = require("./oauth/claudeCodeAuth.cjs");
      const tokens = await claudeCodeAuth.refreshAccessToken(account.refreshToken);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
      try {
        const enr = await claudeCodeAuth.enrichWithBackend(tokens.access_token, tokens);
        if (enr.email) account.email = enr.email;
        if (enr.plan) account.planType = enr.plan;
        account.providerMeta = {
          ...(account.providerMeta || {}),
          accountUUID: enr.accountUUID || account.providerMeta?.accountUUID,
          organizationUUID: enr.organizationUUID || account.providerMeta?.organizationUUID,
          organizationName: enr.organizationName || account.providerMeta?.organizationName,
          organizationType: enr.organizationType || account.providerMeta?.organizationType,
          rateLimitTier: enr.rateLimitTier || account.providerMeta?.rateLimitTier,
          cliUserID: account.providerMeta?.cliUserID,
        };
        if (enr.organizationUUID) account.workspaceId = enr.organizationUUID;
      } catch {
        /* */
      }
    } else if (account.providerId === "github-copilot") {
      const auth = require("./oauth/githubCopilotAuth.cjs");
      const refreshed = await auth.refreshCopilotToken(account.githubAccessToken || account.refreshToken);
      account.accessToken = refreshed.token;
      account.copilotToken = refreshed.token;
      account.expiresAt = refreshed.expiresAt || Date.now() + (Number(refreshed.refreshIn) || 1800) * 1000;
      account.copilotPlan = refreshed.plan || account.copilotPlan;
      account.copilotChatEnabled = refreshed.chatEnabled;
      account.copilotQuotaSnapshots = refreshed.quotaSnapshots;
      account.copilotQuotaResetDate = refreshed.quotaResetDate;
    } else if (account.providerId === "cursor") {
      const auth = require("./oauth/cursorAuth.cjs");
      const refreshed = await auth.refreshAccessToken(account.refreshToken);
      Object.assign(account, auth.toAccountPayload(refreshed, { source: "cursor_refresh" }), { id: account.id, providerId: "cursor" });
    } else if (account.providerId === "windsurf") {
      const auth = require("./oauth/windsurfAuth.cjs");
      Object.assign(account, await auth.refreshPayloadForAccount(account), { id: account.id, providerId: "windsurf" });
    } else if (["codebuddy", "codebuddy-cn"].includes(account.providerId)) {
      const auth = require(`./oauth/${account.providerId === "codebuddy-cn" ? "codebuddyCnAuth" : "codebuddyAuth"}.cjs`);
      const refreshed = await auth.refreshPayloadForAccount(account);
      Object.assign(account, refreshed, { id: account.id, providerId: account.providerId });
    } else if (account.providerId === "qoder") {
      const auth = require("./oauth/qoderAuth.cjs");
      const refreshed = await auth.refreshPayloadForAccount(account);
      Object.assign(account, refreshed, { id: account.id, providerId: "qoder" });
    } else if (account.providerId === "qauth") {
      const auth = require("./oauth/qauthAuth.cjs");
      const refreshed = await auth.refreshPayloadForAccount(account);
      Object.assign(account, refreshed, { id: account.id, providerId: "qauth" });
    } else if (account.providerId === "cline") {
      const auth = require("./oauth/qauthAuth.cjs");
      const refreshed = await auth.refreshPayloadForAccount(account);
      Object.assign(account, refreshed, { id: account.id, providerId: "cline" });
    } else if (account.providerId === "kiro") {
      const kiroAuth = require("./oauth/kiroAuth.cjs");
      const tokens = await kiroAuth.refreshAccessToken(
        account.refreshToken,
        account.providerMeta || {}
      );
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
      account.providerMeta = {
        ...(account.providerMeta || {}),
        region: account.providerMeta?.region || "us-east-1",
        clientId: tokens._newClientId || account.providerMeta?.clientId,
        clientSecret: tokens._newClientSecret || account.providerMeta?.clientSecret,
        profileArn: tokens.profileArn || account.providerMeta?.profileArn,
        authMethod: account.providerMeta?.authMethod || "builder-id",
      };
      if (tokens.profileArn) account.workspaceId = tokens.profileArn;
      if (!account.providerMeta?.profileArn && account.accessToken) {
        try {
          const arn = await kiroAuth.discoverProfileArn(
            account.accessToken,
            account.providerMeta.region || "us-east-1"
          );
          if (arn) {
            account.providerMeta.profileArn = arn;
            account.workspaceId = arn;
          }
        } catch {
          /* */
        }
      }
    } else {
      const clientId = account.providerMeta?.clientId || codexAuth.CLIENT_ID;
      const tokens = await codexAuth.refreshAccessToken(account.refreshToken, clientId);
      account.accessToken = tokens.access_token;
      if (tokens.refresh_token) account.refreshToken = tokens.refresh_token;
      if (tokens.id_token) account.idToken = tokens.id_token;
      account.expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;
      const meta = codexAuth.mapAuthMeta(tokens);
      if (meta.email) account.email = meta.email;
      if (meta.planType) account.planType = meta.planType;
      if (meta.workspaceId) account.workspaceId = meta.workspaceId;
    }

    if (account?.id) {
      await storeApi.mergeAccount(userDataPath, account.id, account);
    }
  } catch (e) {
    account.usageError = e.message || "token refresh failed";
  }
  return account;
}

async function refreshAccountUsage(userDataPath, accountId, opts = {}) {
  const store = await storeApi.load(userDataPath);
  const idx = store.accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) return { ok: false, error: "account not found" };
  let account = store.accounts[idx];

  if (account.authType === "oauth" && account.providerId === "openai") {
    account = await ensureFreshToken(userDataPath, account);
    // reload after potential save
    const store2 = await storeApi.load(userDataPath);
    const i2 = store2.accounts.findIndex((a) => a.id === accountId);
    account = i2 >= 0 ? store2.accounts[i2] : account;

    const result = await codexUsage.fetchCodexUsage({
      accessToken: account.accessToken,
      workspaceId: account.workspaceId,
    });

    if (!result.ok) {
      account.usageError = result.error || "usage failed";
      if (result.expired) account.usageError = "Token expired — sign in again";
      account.usageUpdatedAt = Date.now();
    } else {
      account.usage = result.usage;
      account.usageError = null;
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan && result.usage.plan !== "unknown") {
        account.planType = result.usage.plan;
      }
      // Feed smart router so exhausted windows block this account until reset
      accountRouter.syncFromUsage(account.id, result.usage);
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // Antigravity OAuth — fetchAvailableModels + retrieveUserQuota
  if (account.authType === "oauth" && account.providerId === "antigravity") {
    account = await ensureFreshToken(userDataPath, account);
    const storeA = await storeApi.load(userDataPath);
    const ia = storeA.accounts.findIndex((a) => a.id === accountId);
    account = ia >= 0 ? storeA.accounts[ia] : account;

    const antigravityUsage = require("./oauth/antigravityUsage.cjs");
    const result = await antigravityUsage.fetchAntigravityUsage({
      accessToken: account.accessToken,
      projectId: account.providerMeta?.projectId || account.workspaceId,
    });

    if (!result.ok) {
      account.usageError = result.error || "usage failed";
      if (result.expired) account.usageError = "Token expired — re-authenticate";
      account.usageUpdatedAt = Date.now();
    } else {
      account.usage = result.usage;
      account.usageError = null;
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan) account.planType = result.usage.plan;
      if (result.usage?.detail?.projectId && !account.providerMeta?.projectId) {
        account.providerMeta = {
          ...(account.providerMeta || {}),
          projectId: result.usage.detail.projectId,
        };
        account.workspaceId = result.usage.detail.projectId;
      }
      accountRouter.syncFromUsage(account.id, result.usage);
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // Gemini CLI OAuth — Cloud Code loadCodeAssist + retrieveUserQuota
  if (account.authType === "oauth" && account.providerId === "gemini-cli") {
    account = await ensureFreshToken(userDataPath, account);
    const storeG = await storeApi.load(userDataPath);
    const ig = storeG.accounts.findIndex((a) => a.id === accountId);
    account = ig >= 0 ? storeG.accounts[ig] : account;

    const geminiCliUsage = require("./oauth/geminiCliUsage.cjs");
    const result = await geminiCliUsage.fetchGeminiCliUsage({
      accessToken: account.accessToken,
      projectId: account.providerMeta?.projectId || account.workspaceId,
      email: account.email,
      accounts: storeG.accounts || [],
    });

    if (!result.ok) {
      // Auth/token failures stay as usageError; project-pending is soft
      const err = result.error || "usage failed";
      if (/missing.*project|GCP project|projectId pending|discontinued/i.test(err)) {
        account.usage = {
          ...(account.usage || { plan: account.planType || "Needs GCP project", quotas: {} }),
          note: err,
        };
        account.usageError = null;
      } else {
        account.usageError = err;
      }
      account.usageUpdatedAt = Date.now();
    } else {
      account.usage = result.usage;
      // Do not surface project-pending as red usageError
      const soft = result.error || result.usage?.detail?.error || result.usage?.note || null;
      if (soft && /missing.*project|GCP project|projectId|discontinued|Antigravity first/i.test(soft)) {
        account.usageError = null;
        if (account.usage && !account.usage.note) account.usage.note = soft;
      } else {
        account.usageError = result.error || null;
      }
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan) account.planType = result.usage.plan;
      if (result.projectId) {
        account.providerMeta = {
          ...(account.providerMeta || {}),
          projectId: result.projectId,
          tier: result.tier || account.providerMeta?.tier,
        };
        account.workspaceId = result.projectId;
        account.usageError = null;
      }
      accountRouter.syncFromUsage(account.id, result.usage);
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // Claude Code OAuth — /api/oauth/usage (5h + weekly)
  if (account.authType === "oauth" && account.providerId === "claude-code") {
    account = await ensureFreshToken(userDataPath, account);
    const storeC = await storeApi.load(userDataPath);
    const ic = storeC.accounts.findIndex((a) => a.id === accountId);
    account = ic >= 0 ? storeC.accounts[ic] : account;

    const claudeCodeUsage = require("./oauth/claudeCodeUsage.cjs");
    const result = await claudeCodeUsage.fetchClaudeCodeUsage({
      accessToken: account.accessToken,
    });

    if (!result.ok) {
      account.usageError = result.error || "usage failed";
      if (result.expired) account.usageError = "Token expired — re-authenticate Claude Code";
      account.usageUpdatedAt = Date.now();
    } else {
      account.usage = result.usage;
      account.usageError = null;
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan) account.planType = result.usage.plan;
      accountRouter.syncFromUsage(account.id, result.usage);
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // Kiro OAuth — CodeWhisperer GetUsageLimits (quota)
  if (account.authType === "oauth" && account.providerId === "kiro") {
    account = await ensureFreshToken(userDataPath, account);
    const storeK = await storeApi.load(userDataPath);
    const ik = storeK.accounts.findIndex((a) => a.id === accountId);
    account = ik >= 0 ? storeK.accounts[ik] : account;

    const kiroUsage = require("./oauth/kiroUsage.cjs");
    const result = await kiroUsage.fetchKiroUsage({
      accessToken: account.accessToken,
      providerMeta: account.providerMeta || {},
    });

    if (!result.ok) {
      account.usageError = result.error || "usage failed";
      if (result.expired) account.usageError = "Token expired — re-authenticate Kiro";
      account.usageUpdatedAt = Date.now();
    } else {
      account.usage = result.usage;
      // Soft miss (no profileArn / empty breakdown): keep ready, but show note as usageError
      // so UI is not silent "—" with no explanation.
      const softNote = result.usage?.note || null;
      const hasQuotas = result.usage && Object.keys(result.usage.quotas || {}).length > 0;
      if (!hasQuotas && softNote) {
        account.usageError = softNote;
      } else {
        account.usageError = null;
      }
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan) account.planType = result.usage.plan;
      if (result.profileArn) {
        account.providerMeta = {
          ...(account.providerMeta || {}),
          profileArn: result.profileArn,
          region: result.region || account.providerMeta?.region || "us-east-1",
        };
        account.workspaceId = result.profileArn;
      }
      if (hasQuotas) {
        accountRouter.syncFromUsage(account.id, result.usage);
      }
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // Grok OAuth / CLI: /v1/user + /v1/billing (+ format=credits weekly SuperGrok)
  if (account.authType === "oauth" && account.providerId === "grok") {
    const forceFirst =
      Boolean(opts.forceRefresh) ||
      /token expired|re-authenticate|token refresh failed/i.test(String(account.usageError || ""));
    account = await ensureFreshToken(userDataPath, account, { force: forceFirst });
    const store2 = await storeApi.load(userDataPath);
    const i2 = store2.accounts.findIndex((a) => a.id === accountId);
    account = i2 >= 0 ? store2.accounts[i2] : account;

    const grokUsage = require("./oauth/grokUsage.cjs");
    const grokFreeTracker = require("./oauth/grokFreeTracker.cjs");
    grokFreeTracker.setUserDataPath(userDataPath);
    grokFreeTracker.hydrate(account);

    let result = await grokUsage.fetchGrokUsage({
      accessToken: account.accessToken,
    });

    if (!result.ok && result.expired && account.refreshToken) {
      account = await ensureFreshToken(userDataPath, account, { force: true });
      const storeRetry = await storeApi.load(userDataPath);
      const ir = storeRetry.accounts.findIndex((a) => a.id === accountId);
      account = ir >= 0 ? storeRetry.accounts[ir] : account;
      result = await grokUsage.fetchGrokUsage({
        accessToken: account.accessToken,
      });
    }

    if (!result.ok) {
      const stillExpired = Boolean(result.expired);
      if (stillExpired && account.refreshToken) {
        account.usageError =
          account.usageError && /token refresh failed/i.test(account.usageError)
            ? account.usageError
            : "Token refresh failed — re-authenticate";
      } else if (stillExpired) {
        account.usageError = "Token expired — re-authenticate";
      } else {
        account.usageError = result.error || "usage failed";
      }
      account.usageUpdatedAt = Date.now();
      const decorated = grokFreeTracker.decorateUsage(account, account.usage);
      if (decorated && decorated !== account.usage) {
        account.usage = decorated;
      }
      if (stillExpired) {
        accountRouter.markLimited(account.id, {
          kind: "auth",
          message: account.usageError,
          resetAfterSec: 10 * 60,
        });
      } else if (account.usage) {
        accountRouter.syncFromUsage(account.id, account.usage);
      }
      accountRouter.applyToAccount(account);
    } else {
      account.usage = grokFreeTracker.decorateUsage(account, result.usage);
      account.usageError = null;
      account.usageUpdatedAt = Date.now();
      if (result.usage?.plan) account.planType = result.usage.plan;
      if (result.usage?.detail?.email) account.email = result.usage.detail.email;
      accountRouter.syncFromUsage(account.id, account.usage);
      accountRouter.applyToAccount(account);
    }

    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  if (account.authType === "oauth" && account.providerId === "qauth") {
    account = await ensureFreshToken(userDataPath, account);
    const storeQauth = await storeApi.load(userDataPath);
    const iq = storeQauth.accounts.findIndex((a) => a.id === accountId);
    account = iq >= 0 ? storeQauth.accounts[iq] : account;
    try {
      const qauthUsage = require("./oauth/qauthUsage.cjs");
      const result = await qauthUsage.fetchClineUsage({
        accessToken: account.accessToken,
        userId: account.userId || account.providerMeta?.authRaw?.userInfo?.clineUserId || account.providerMeta?.authRaw?.userInfo?.id || account.providerMeta?.authRaw?.meta?.userInfo?.clineUserId || account.providerMeta?.authRaw?.meta?.userInfo?.id || account.providerMeta?.authRaw?.meta?.userInfo?.subject,
      });
      account.usage = result;
      account.usageError = null;
      account.usageUpdatedAt = Date.now();
      if (result.plan) account.planType = result.plan;
      accountRouter.syncFromUsage(account.id, result);
      accountRouter.applyToAccount(account);
    } catch (error) {
      account.usageError = error.message || "Cline usage failed";
      account.usageUpdatedAt = Date.now();
    }
    await storeApi.mergeAccount(userDataPath, accountId, account);
    return { ok: true, account: storeApi.publicAccount(account) };
  }

  // API-key accounts with provider balance endpoints (for gateways such as J3GB)
  if (account.authType === "apikey") {
    const result = await fetchApiKeyBalanceUsage(account);
    if (result) {
      const neverBlock = providerUsagePollNeverBlocks(account);
      if (!result.ok) {
        // Usage-only failures: keep last known balance, never mark key disabled/auth
        // and never remove the key from chat routing (usage 429 ≠ inference limit).
        // 429 → temporary usage message; API_KEY_DISABLED → usage-endpoint note.
        account.usageError = result.error || "usage failed";
        account.usageUpdatedAt = Date.now();
        // J3GB (usagePollNeverBlocks): force-clear any routing block after usage fail.
        // Other balance providers: only clear usage-noise auth false positives.
        clearUsageOnlyAuthFalsePositive(account, { force: neverBlock });
        accountRouter.applyToAccount(account);
      } else {
        account.usage = result.usage;
        account.usageError = null;
        account.usageUpdatedAt = Date.now();
        if (result.usage?.plan) account.planType = result.usage.plan;
        // J3GB: usage is informational for UI. Do not let limitReached/empty balance
        // from a flaky /usage response block the key for chat rotation.
        if (!neverBlock) {
          accountRouter.syncFromUsage(account.id, result.usage);
        } else if (result.usage && Number(result.usage.remaining ?? result.usage.balance) <= 0) {
          // Still record zero balance on the account object for UI, but keep routing ready.
          // Real empty balance is handled by chat 402/insufficient responses + failover.
        } else {
          // Positive balance: clear stale quota/rate blocks so UI shows ready.
          clearUsageOnlyAuthFalsePositive(account, { force: true });
        }
        // Always clear usage-noise auth false positives after a successful poll.
        clearUsageOnlyAuthFalsePositive(account, { force: neverBlock });
        accountRouter.applyToAccount(account);
      }
      await storeApi.mergeAccount(userDataPath, accountId, account);
      return { ok: true, account: storeApi.publicAccount(account) };
    }
  }

  // API-key accounts: platform billing (no subscription windows)
  account.usage = account.usage || {
    plan: "api_key",
    limitReached: false,
    quotas: {},
    note: "API keys use platform billing - rate limits via 429 headers / smart routing",
  };
  account.usageUpdatedAt = Date.now();
  await storeApi.mergeAccount(userDataPath, accountId, account);
  return { ok: true, account: storeApi.publicAccount(account) };
}

/**
 * Parallel pool map — run up to `concurrency` tasks at once.
 * Network-bound usage fetches benefit massively vs sequential + 300ms delays.
 */
async function mapPool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  async function run() {
    while (true) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await worker(list[i], i);
      } catch (e) {
        results[i] = { ok: false, error: e?.message || String(e) };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, list.length || 1) }, () => run());
  await Promise.all(workers);
  return results;
}

function isRefreshableAccount(acc) {
  if (!acc || acc.enabled === false) return false;
  const provider = getProvider(acc.providerId);
  const refreshableOauth =
    acc.authType === "oauth" &&
    (acc.providerId === "openai" ||
      acc.providerId === "grok" ||
      acc.providerId === "antigravity" ||
      acc.providerId === "gemini-cli" ||
      acc.providerId === "nous" ||
      acc.providerId === "claude-code" ||
      acc.providerId === "qauth");
  const refreshableApiKey =
    acc.authType === "apikey" && Boolean(provider?.balanceUrl || provider?.probeBalance);
  return refreshableOauth || refreshableApiKey;
}

async function refreshAllUsage(userDataPath, opts = {}) {
  const store = await storeApi.load(userDataPath);
  const accountIds = (store.accounts || [])
    .filter((a) => isRefreshableAccount(a))
    .map((a) => a.id);

  // High concurrency for network-bound quota polls. Default 16; cap 32.
  // Store writes are serialized via mergeAccount/save lock so parallel is safe.
  const n = accountIds.length;
  const concurrency = Math.max(
    1,
    Math.min(
      Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 16,
      32,
      n || 1
    )
  );

  if (!n) return [];

  const results = await mapPool(accountIds, concurrency, async (accId) => {
    try {
      return await refreshAccountUsage(userDataPath, accId);
    } catch (e) {
      return { ok: false, id: accId, error: e?.message || String(e) };
    }
  });
  return results;
}

function startQuotaLoop(getUserDataPath, intervalMs = 5 * 60 * 1000) {
  let timer = null;
  const tick = async () => {
    try {
      const ud = getUserDataPath();
      if (ud) await refreshAllUsage(ud);
    } catch {
      /* ignore */
    }
  };
  timer = setInterval(tick, intervalMs);
  // first refresh shortly after boot
  setTimeout(tick, 8000);
  return () => clearInterval(timer);
}

module.exports = {
  ensureFreshToken,
  refreshAccountUsage,
  refreshAllUsage,
  startQuotaLoop,
};
