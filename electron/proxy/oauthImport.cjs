const storeApi = require("./store.cjs");
const accountsApi = require("./accounts.cjs");
const { getProvider, bootstrap } = require("./providers/registry.cjs");
const grokAuth = require("./oauth/grokAuth.cjs");

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;
const RT_RE = /rt(?:[._][A-Za-z0-9_-]+)+/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function trimToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
}

function looksLikeJwt(value) {
  return JWT_RE.test(String(value || ""));
}

function pickJwt(value) {
  const t = trimToken(value);
  const m = t.match(JWT_RE);
  return m ? m[0] : null;
}

function pickRefresh(value, exclude) {
  const t = trimToken(value);
  const m = t.match(RT_RE);
  if (m) return m[0];
  const re = new RegExp(JWT_RE.source, "g");
  let mm;
  while ((mm = re.exec(t)) !== null) {
    if (mm[0] !== exclude) return mm[0];
  }
  return null;
}

function pickEmail(value) {
  const t = trimToken(value);
  const m = t.match(EMAIL_RE);
  return m ? m[0] : null;
}

function looksLikeRtToken(value) {
  return RT_RE.test(String(value || ""));
}

function parseCredentialLines(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^```/.test(line)) continue;
    if (/^(code|json|text)\b/i.test(line) && !line.includes("@") && !looksLikeJwt(line)) continue;
    if (/^(Copy|Codex refresh token|Codex JWT|Supabase)\b/i.test(line)) continue;

    const access = pickJwt(line);
    if (!access) {
      if (looksLikeRtToken(line) && out.length && !out[out.length - 1].refreshToken) {
        out[out.length - 1].refreshToken = trimToken(line);
      }
      continue;
    }

    let refresh = pickRefresh(line, access);
    let email = pickEmail(line);

    if (!refresh && i + 1 < lines.length && looksLikeRtToken(lines[i + 1])) {
      refresh = trimToken(lines[i + 1]);
      i += 1;
    }

    if (!refresh) {
      const colonParts = line.split(":");
      const rt = colonParts.find((p) => looksLikeRtToken(p));
      if (rt) refresh = trimToken(rt);
    }

    const key = `${email || ""}|${access}|${refresh || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      accessToken: access,
      refreshToken: refresh || null,
      email: email || null,
    });
  }

  return out;
}

function parseNousCredentialLines(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^```/.test(line));
  const items = [];
  const seen = new Set();

  for (const line of lines) {
    const refresh = pickRefresh(line);
    if (!refresh) continue;
    const jwt = pickJwt(line);
    const beforeRefresh = line.slice(0, line.indexOf(refresh)).replace(/[:\s]+$/, "");
    const accessToken = jwt || trimToken(beforeRefresh.split(/[:\s]+/).pop());
    if (!accessToken) continue;
    const key = `${accessToken}|${refresh}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ accessToken, refreshToken: refresh, email: pickEmail(line) || null });
  }

  return items;
}

function parseTokenPair(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty input");

  if (raw.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON: ${e.message}`);
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      if (data.tokens && typeof data.tokens === "object") data = { ...data, ...data.tokens };
      if (data.claudeAiOauth && typeof data.claudeAiOauth === "object") {
        data = { ...data, ...data.claudeAiOauth };
      }
      if (data.oauth && typeof data.oauth === "object") data = { ...data, ...data.oauth };
      if (data.auth && typeof data.auth === "object") data = { ...data, ...data.auth };
      if (data.account && typeof data.account === "object") data = { ...data, ...data.account };
      const accessToken =
        trimToken(data.accessToken) || trimToken(data.access_token) || trimToken(data.token) || null;
      const refreshToken =
        trimToken(data.refreshToken) || trimToken(data.refresh_token) || null;
      if (!accessToken) throw new Error("accessToken missing in JSON");
      let expiresAt = data.expiresAt ?? data.expires_at ?? data.exp ?? null;
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt < 1e12) {
        expiresAt = expiresAt * 1000;
      } else if (typeof expiresAt === "string" && expiresAt.trim()) {
        const ms = Date.parse(expiresAt);
        expiresAt = Number.isFinite(ms) ? ms : null;
      }
      const scopes = Array.isArray(data.scopes)
        ? data.scopes.filter((s) => typeof s === "string")
        : undefined;
      return {
        accessToken,
        refreshToken,
        email: trimToken(data.email) || null,
        expiresAt,
        planType: trimToken(data.planType) || trimToken(data.plan_type) || null,
        workspaceId:
          trimToken(data.workspaceId) ||
          trimToken(data.workspace_id) ||
          trimToken(data.account_id) ||
          trimToken(data.chatgpt_account_id) ||
          null,
        clientId: trimToken(data.client_id) || null,
        userId:
          trimToken(data.user_id) || trimToken(data.chatgpt_user_id) || null,
        poid: trimToken(data.poid) || null,
        sessionId: trimToken(data.session_id) || null,
        sub: trimToken(data.sub) || null,
        lastRefresh:
          trimToken(data.last_refresh) || trimToken(data.lastRefresh) || null,
        accountUUID:
          trimToken(data.account_uuid) || trimToken(data.accountUUID) || null,
        organizationUUID:
          trimToken(data.organization_uuid) ||
          trimToken(data.organizationUUID) ||
          trimToken(data.org_uuid) ||
          null,
        organizationName:
          trimToken(data.organization_name) || trimToken(data.organizationName) || null,
        organizationType:
          trimToken(data.organization_type) || trimToken(data.organizationType) || null,
        rateLimitTier:
          trimToken(data.rate_limit_tier) || trimToken(data.rateLimitTier) || null,
        cliUserID: trimToken(data.cli_user_id) || trimToken(data.cliUserID) || null,
        subscriptionType:
          trimToken(data.subscription_type) || trimToken(data.subscriptionType) || null,
        scopes,
      };
    }
    throw new Error("JSON must be an object with accessToken/refreshToken");
  }

  const parts = raw
    .split(/\s+/)
    .map((p) => trimToken(p))
    .filter(Boolean);
  const access = pickJwt(raw) || parts[0];
  if (!access) throw new Error("accessToken (JWT) not found");
  let refresh = pickRefresh(raw, access);
  if (!refresh && parts.length > 1) refresh = parts[1];
  return {
    accessToken: access,
    refreshToken: refresh || null,
    email: pickEmail(raw) || null,
  };
}

function jwtMeta(accessToken) {
  try {
    const jwt = grokAuth.parseJwtPayload(accessToken);
    const claims = jwt.claims || {};
    const auth = claims["https://api.openai.com/auth"] || {};
    const profile = claims["https://api.openai.com/profile"] || {};
    const planType = String(
      auth.chatgpt_plan_type || claims.chatgpt_plan_type || ""
    ).toLowerCase();
    let workspaceId = auth.chatgpt_account_id || claims.chatgpt_account_id || null;
    const orgs = Array.isArray(auth.organizations) ? auth.organizations : [];
    if (!workspaceId && orgs.length && (!planType || planType === "free" || planType === "unknown")) {
      const team = orgs.find((o) => !o.is_default);
      if (team?.id) workspaceId = team.id;
    }
    return {
      email: profile.email || jwt.email || null,
      planType: planType || "unknown",
      workspaceId,
      chatgptUserId: auth.chatgpt_user_id || null,
      chatgptAccountUserID: auth.chatgpt_account_user_id || null,
      poid: auth.poid || null,
      clientId: claims.client_id || null,
      sub: claims.sub || null,
      sessionId: claims.session_id || null,
      organizations: orgs,
      emailVerified: Boolean(profile.email_verified),
      exp: typeof jwt.exp === "number" ? jwt.exp * 1000 : null,
    };
  } catch {
    return null;
  }
}

function buildOpenaiCodexAccount(input) {
  const accessToken = trimToken(input.accessToken);
  if (!accessToken) throw new Error("accessToken required");
  const meta = jwtMeta(accessToken);
  const email = trimToken(input.email) || meta?.email || null;
  const expiresAt = Number(input.expiresAt) || meta?.exp || null;
  const planType = trimToken(input.planType) || meta?.planType || "unknown";
  const workspaceId =
    trimToken(input.workspaceId) ||
    trimToken(input.accountId) ||
    meta?.workspaceId ||
    null;
  return {
    providerId: "openai",
    authType: "oauth",
    name: email || input.name || "ChatGPT",
    email,
    planType,
    workspaceId,
    accessToken,
    refreshToken: trimToken(input.refreshToken) || null,
    idToken: trimToken(input.idToken) || null,
    expiresAt,
    apiKey: "",
    baseUrl: trimToken(input.baseUrl) || "https://chatgpt.com/backend-api/codex",
    defaultModel: trimToken(input.defaultModel) || "",
    enabled: true,
    usage: null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: {
      source: input.source || "codex_jwt_import",
      clientId: trimToken(input.clientId) || meta?.clientId || null,
      chatgptUserId: trimToken(input.userId) || meta?.chatgptUserId || null,
      chatgptAccountUserID: meta?.chatgptAccountUserID || null,
      chatgptAccountId: workspaceId,
      poid: trimToken(input.poid) || meta?.poid || null,
      sub: trimToken(input.sub) || meta?.sub || null,
      sessionId: trimToken(input.sessionId) || meta?.sessionId || null,
      organizations: meta?.organizations || [],
      lastRefresh: trimToken(input.lastRefresh) || null,
    },
  };
}

async function buildClaudeCodeAccount(input) {
  const claudeCodeAuth = require("./oauth/claudeCodeAuth.cjs");
  const accessToken = trimToken(input.accessToken);
  const refreshToken = trimToken(input.refreshToken);
  if (!accessToken) throw new Error("accessToken required");
  if (!refreshToken) throw new Error("refreshToken required for Claude Code");

  let enr = {};
  try {
    enr = await claudeCodeAuth.enrichWithBackend(accessToken, {
      access_token: accessToken,
      refresh_token: refreshToken,
    });
  } catch {
    /* */
  }
  const email = trimToken(input.email) || enr.email || null;
  const payload = claudeCodeAuth.toAccountPayload(
    {
      access_token: accessToken,
      refresh_token: refreshToken,
      expiresAt: input.expiresAt || null,
    },
    {
      ...enr,
      email,
      plan: trimToken(input.planType) || enr.plan || null,
      rateLimitTier: trimToken(input.rateLimitTier) || enr.rateLimitTier || null,
      accountUUID: trimToken(input.accountUUID) || enr.accountUUID || null,
      organizationUUID: trimToken(input.organizationUUID) || enr.organizationUUID || null,
      organizationName: trimToken(input.organizationName) || enr.organizationName || null,
      organizationType: trimToken(input.organizationType) || enr.organizationType || null,
      cliUserID: trimToken(input.cliUserID) || enr.cliUserID || undefined,
      scopes: Array.isArray(input.scopes) ? input.scopes : undefined,
      source: input.source || "claude_code_token_import",
    }
  );
  if (trimToken(input.baseUrl)) payload.baseUrl = trimToken(input.baseUrl);
  if (trimToken(input.defaultModel)) payload.defaultModel = trimToken(input.defaultModel);
  if (payload.providerMeta) {
    payload.providerMeta.lastRefresh = trimToken(input.lastRefresh) || null;
    if (trimToken(input.subscriptionType)) {
      payload.providerMeta.subscriptionType = trimToken(input.subscriptionType);
    }
  }
  return payload;
}

async function buildQauthAccount(input) {
  const auth = require("./oauth/qauthAuth.cjs");
  const accessToken = trimToken(input.accessToken);
  const refreshToken = trimToken(input.refreshToken);
  if (!accessToken) throw new Error("accessToken required");
  const payload = await auth.buildAccountPayload(
    { accessToken, refreshToken },
    {
      name: input.name,
      baseUrl: input.baseUrl,
      source: "manual_cline_token_import",
    }
  );
  return payload;
}

function buildNousAccount(input) {
  const accessToken = trimToken(input.accessToken);
  const refreshToken = trimToken(input.refreshToken);
  if (!accessToken) throw new Error("accessToken required for Nous Research");
  if (!refreshToken) throw new Error("refreshToken required for Nous Research");
  return buildGenericAccount({
    ...input,
    accessToken,
    refreshToken,
    baseUrl: trimToken(input.baseUrl) || "https://inference-api.nousresearch.com/v1",
    source: input.source || "nous_hermes_token_import",
  });
}

function buildGenericAccount(input) {
  const accessToken = trimToken(input.accessToken);
  if (!accessToken) throw new Error("accessToken required");
  return {
    providerId: input.providerId,
    authType: "oauth",
    name: trimToken(input.name) || input.providerId,
    email: trimToken(input.email) || null,
    planType: trimToken(input.planType) || null,
    workspaceId: trimToken(input.workspaceId) || null,
    accessToken,
    refreshToken: trimToken(input.refreshToken) || null,
    idToken: trimToken(input.idToken) || null,
    expiresAt: Number(input.expiresAt) || null,
    apiKey: "",
    baseUrl: trimToken(input.baseUrl) || (getProvider(input.providerId)?.defaultBaseUrl || ""),
    defaultModel: trimToken(input.defaultModel) || "",
    enabled: true,
    usage: null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: { source: input.source || "manual_oauth_import" },
  };
}

async function buildAccountPayload(providerId, input) {
  const pid = String(providerId || "").trim();
  if (!pid) throw new Error("providerId required");
  try {
    bootstrap();
  } catch {
    /* */
  }
  if (!getProvider(pid)) throw new Error("provider not registered");
  if (pid === "openai") return buildOpenaiCodexAccount(input);
  if (pid === "nous") return buildNousAccount(input);
  if (pid === "claude-code") return buildClaudeCodeAccount(input);
  if (pid === "qauth" || pid === "cline") return buildQauthAccount(input);
  return buildGenericAccount({ ...input, providerId: pid });
}

function findDuplicate(store, payload) {
  const pid = payload.providerId;
  const email = payload.email;
  const access = payload.accessToken;
  const refresh = payload.refreshToken;
  return (store.accounts || []).find((a) => {
    if (a.providerId !== pid || a.authType !== "oauth") return false;
    if (access && a.accessToken === access) return true;
    if (refresh && a.refreshToken === refresh) return true;
    if (email && pid === "openai" && a.email === email) return true;
    if (email && pid === "claude-code" && a.email === email) return true;
    return false;
  });
}

async function importOauthTokens(userDataPath, input = {}) {
  const store = await storeApi.load(userDataPath);
  const payload = await buildAccountPayload(input.providerId, input || {});

  const existing = findDuplicate(store, payload);
  let accountId;
  if (existing) {
    Object.assign(existing, payload, {
      id: existing.id,
      providerId: existing.providerId,
      authType: "oauth",
      providerMeta: {
        ...(existing.providerMeta || {}),
        ...(payload.providerMeta || {}),
      },
      enabled: true,
      usageError: null,
    });
    accountId = existing.id;
    await storeApi.save(userDataPath, store);
  } else {
    const account = { id: storeApi.newId("acc"), ...payload };
    store.accounts.push(account);
    accountId = account.id;
    await storeApi.save(userDataPath, store);
  }

  let config = null;
  try {
    await accountsApi.refreshAccountUsage(userDataPath, accountId);
    const refreshed = await storeApi.load(userDataPath);
    config = storeApi.publicView(refreshed);
  } catch {
    const next = await storeApi.load(userDataPath);
    config = storeApi.publicView(next);
  }

  return {
    ok: true,
    mode: existing ? "updated" : "created",
    accountId,
    email: payload.email,
    config,
  };
}

async function importOauthTokensText(userDataPath, providerId, text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "text required" };

  const pid = String(providerId || "").trim();
  if (!pid) return { ok: false, error: "providerId required" };
  try {
    bootstrap();
  } catch {
    /* */
  }
  if (!getProvider(pid)) return { ok: false, error: "provider not registered" };

  let items;
  if (raw.startsWith("{")) {
    try {
      items = [parseTokenPair(raw)];
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  } else if (pid === "nous") {
    items = parseNousCredentialLines(raw);
    if (!items.length) {
      return {
        ok: false,
        error: "No Nous credentials found. Paste access:refresh per line.",
      };
    }
  } else if (pid === "claude-code") {
    try {
      const pair = parseTokenPair(raw);
      items = pair.refreshToken ? [pair] : parseCredentialLines(raw);
    } catch {
      items = parseCredentialLines(raw);
    }
    if (!items.length) {
      return {
        ok: false,
        error: "No Claude tokens found. Paste access:refresh (or credentials JSON).",
      };
    }
  } else {
    items = parseCredentialLines(raw);
    if (!items.length) {
      try {
        items = [parseTokenPair(raw)];
      } catch {
        return {
          ok: false,
          error: "No JWT / refresh token lines found. Paste JWT or JWT:refresh per line (email:pass:JWT:refresh also works).",
        };
      }
    }
  }

  const result = { ok: true, added: 0, updated: 0, skipped: 0, failed: 0, errors: [] };
  for (const item of items) {
    try {
      const r = await importOauthTokens(userDataPath, {
        providerId: pid,
        ...item,
      });
      if (r.mode === "updated") result.updated += 1;
      else result.added += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push({
        email: item.email || null,
        token: item.accessToken ? `${item.accessToken.slice(0, 18)}…` : null,
        error: e.message || String(e),
      });
    }
  }
  result.total = items.length;
  result.skipped = items.length - result.added - result.updated - result.failed;
  if (!result.added && !result.updated && result.failed) result.ok = false;
  result.config = storeApi.publicView(await storeApi.load(userDataPath));
  return result;
}

module.exports = {
  parseCredentialLines,
  parseNousCredentialLines,
  parseTokenPair,
  buildAccountPayload,
  importOauthTokens,
  importOauthTokensText,
};
