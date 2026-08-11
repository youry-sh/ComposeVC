/**
 * Claude Code OAuth helpers:
 *  - PKCE
 *  - token exchange / refresh
 *  - bootstrap (email, org, accountUUID)
 *  - CLI credentials import (~/.claude/.credentials.json)
 *  - request identity cloak for user:sessions:claude_code
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const creds = require("./claudeCodeCreds.cjs");

function toRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function nonEmpty(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  return { codeVerifier, codeChallenge, state };
}

function generateCliUserID() {
  return crypto.randomBytes(32).toString("hex");
}

function buildAuthUrl({ codeChallenge, state } = {}) {
  const params = new URLSearchParams({
    code: "true",
    client_id: creds.CLIENT_ID,
    response_type: "code",
    redirect_uri: creds.REDIRECT_URI,
    scope: creds.SCOPES.join(" "),
    code_challenge: codeChallenge,
    code_challenge_method: creds.CODE_CHALLENGE_METHOD,
    state: state || "",
    // Force re-auth so multi-account does not silently reuse browser session
    prompt: "login",
  });
  return `${creds.AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Anthropic callback often returns `code#state` as a single pasted string.
 */
function splitPastedCode(raw) {
  let authCode = String(raw || "").trim();
  let codeState = "";
  if (authCode.includes("#")) {
    const parts = authCode.split("#");
    authCode = parts[0];
    codeState = parts.slice(1).join("#") || "";
  }
  // Allow full callback URL paste
  try {
    if (/^https?:\/\//i.test(authCode) || authCode.includes("code=")) {
      const u = new URL(authCode, "https://platform.claude.com");
      authCode = u.searchParams.get("code") || authCode;
      codeState = u.searchParams.get("state") || codeState;
      if (authCode.includes("#")) {
        const p = authCode.split("#");
        authCode = p[0];
        codeState = codeState || p[1] || "";
      }
    }
  } catch {
    /* */
  }
  return { code: authCode.trim(), state: String(codeState || "").trim() };
}

async function exchangeCode({ code, codeVerifier, state }) {
  const split = splitPastedCode(code);
  const body = {
    code: split.code,
    state: split.state || state || "",
    grant_type: "authorization_code",
    client_id: creds.CLIENT_ID,
    redirect_uri: creds.REDIRECT_URI,
    code_verifier: codeVerifier,
  };
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${t.slice(0, 280)}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.CLIENT_ID,
  });
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "anthropic-beta": creds.ANTHROPIC_BETA_OAUTH,
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Claude token refresh failed (${res.status}): ${t.slice(0, 240)}`);
    if (/invalid_grant|invalid_request/i.test(t)) {
      err.code = "unrecoverable_refresh_error";
    }
    throw err;
  }
  return res.json();
}

async function fetchClaudeBootstrap(accessToken) {
  try {
    const res = await fetch(creds.BOOTSTRAP_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": creds.claudeCliUserAgent(),
        "anthropic-beta": creds.ANTHROPIC_BETA_OAUTH,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const acct = data?.oauth_account;
    if (!acct || typeof acct !== "object") return null;
    return {
      account_uuid: acct.account_uuid || null,
      account_email: acct.account_email || null,
      organization_uuid: acct.organization_uuid || null,
      organization_name: acct.organization_name || null,
      organization_type: acct.organization_type || null,
      organization_rate_limit_tier: acct.organization_rate_limit_tier || null,
    };
  } catch {
    return null;
  }
}

function extractPlan(tokens, bootstrap) {
  const t = toRecord(tokens);
  const b = toRecord(bootstrap);
  const billing = toRecord(t.billing);
  const candidates = [
    t.account_tier,
    t.plan,
    t.subscription_type,
    billing.plan,
    b.organization_rate_limit_tier,
  ];
  for (const c of candidates) {
    const s = nonEmpty(c);
    if (s && s.toLowerCase() !== "claude code" && s.toLowerCase() !== "unknown") return s;
  }
  return null;
}

async function enrichWithBackend(accessToken, tokens = {}) {
  const bootstrap = await fetchClaudeBootstrap(accessToken);
  const plan = extractPlan(tokens, bootstrap);
  return {
    email: nonEmpty(bootstrap?.account_email),
    plan,
    accountUUID: nonEmpty(bootstrap?.account_uuid),
    organizationUUID: nonEmpty(bootstrap?.organization_uuid),
    organizationName: nonEmpty(bootstrap?.organization_name),
    organizationType: nonEmpty(bootstrap?.organization_type),
    rateLimitTier: nonEmpty(bootstrap?.organization_rate_limit_tier) || plan,
    bootstrap,
  };
}

function toAccountPayload(tokens, extra = {}) {
  const accessToken = nonEmpty(tokens.access_token) || nonEmpty(tokens.accessToken);
  const refreshToken = nonEmpty(tokens.refresh_token) || nonEmpty(tokens.refreshToken);
  if (!accessToken) throw new Error("access_token missing");
  if (!refreshToken) throw new Error("refresh_token missing");

  let expiresAt = null;
  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)) {
    expiresAt = Date.now() + tokens.expires_in * 1000;
  } else if (typeof tokens.expiresAt === "number" && Number.isFinite(tokens.expiresAt)) {
    expiresAt = tokens.expiresAt;
  } else if (nonEmpty(tokens.expiresAt)) {
    const ms = Date.parse(tokens.expiresAt);
    expiresAt = Number.isFinite(ms) ? ms : null;
  }

  const email = nonEmpty(extra.email);
  const plan = nonEmpty(extra.plan) || nonEmpty(extra.rateLimitTier);
  const cliUserID = nonEmpty(extra.cliUserID) || generateCliUserID();

  return {
    providerId: "claude-code",
    authType: "oauth",
    name: email || "Claude Code",
    email: email || null,
    planType: plan || "Claude Code",
    workspaceId: nonEmpty(extra.organizationUUID) || null,
    accessToken,
    refreshToken,
    idToken: null,
    expiresAt,
    apiKey: "",
    baseUrl: creds.API_BASE,
    defaultModel: "",
    enabled: true,
    usage: null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: {
      source: extra.source || "claude_code_oauth",
      cliUserID,
      accountUUID: nonEmpty(extra.accountUUID) || null,
      organizationUUID: nonEmpty(extra.organizationUUID) || null,
      organizationName: nonEmpty(extra.organizationName) || null,
      organizationType: nonEmpty(extra.organizationType) || null,
      rateLimitTier: nonEmpty(extra.rateLimitTier) || plan || null,
      scopes: Array.isArray(extra.scopes) ? extra.scopes : creds.SCOPES.slice(),
      subscriptionType: plan || null,
    },
  };
}

/** Common Claude CLI credential locations */
function candidateAuthPaths() {
  const home = os.homedir();
  const list = [
    process.env.CLAUDE_CREDENTIALS_PATH,
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".config", "claude", "credentials.json"),
    path.join(home, ".claude", "credentials.json"),
  ];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    list.push(path.join(appData, "claude", "credentials.json"));
    list.push(path.join(appData, ".claude", ".credentials.json"));
  }
  return list.filter(Boolean);
}

function parseClaudeAuthDoc(raw) {
  const doc = toRecord(raw);
  const oauth = toRecord(doc.claudeAiOauth);
  const accessToken =
    nonEmpty(oauth.accessToken) ||
    nonEmpty(oauth.access_token) ||
    nonEmpty(doc.accessToken) ||
    nonEmpty(doc.access_token);
  const refreshToken =
    nonEmpty(oauth.refreshToken) ||
    nonEmpty(oauth.refresh_token) ||
    nonEmpty(doc.refreshToken) ||
    nonEmpty(doc.refresh_token);
  if (!accessToken) throw new Error("accessToken missing in Claude credentials");
  if (!refreshToken) throw new Error("refreshToken missing in Claude credentials");

  let expiresAt = null;
  const rawExp = oauth.expiresAt ?? oauth.expires_at ?? doc.expiresAt ?? doc.expires_at;
  if (typeof rawExp === "number" && Number.isFinite(rawExp)) {
    // ms epoch if large, else seconds
    expiresAt = rawExp > 1e12 ? rawExp : rawExp * 1000;
  } else if (typeof rawExp === "string" && rawExp.trim()) {
    const ms = Date.parse(rawExp);
    expiresAt = Number.isFinite(ms) ? ms : null;
  }

  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((s) => typeof s === "string")
    : creds.SCOPES.slice();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiresAt,
    scopes,
    subscriptionType: nonEmpty(oauth.subscriptionType) || nonEmpty(oauth.subscription_type),
    rateLimitTier: nonEmpty(oauth.rateLimitTier) || nonEmpty(oauth.rate_limit_tier),
  };
}

function readLocalClaudeAuthFile() {
  const tried = [];
  for (const p of candidateAuthPaths()) {
    tried.push(p);
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const parsed = parseClaudeAuthDoc(raw);
      return { ok: true, path: p, ...parsed };
    } catch (e) {
      return { ok: false, error: e.message || String(e), path: p };
    }
  }
  return {
    ok: false,
    error: `Claude credentials not found. Tried: ${tried.join(", ")}. Run claude login, then Import CLI.`,
    path: tried[0] || null,
  };
}

function parseClaudeAuthJsonText(text) {
  let raw;
  try {
    raw = JSON.parse(String(text || ""));
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}`);
  }
  return parseClaudeAuthDoc(raw);
}

// ── Identity cloak for Messages API (OmniRoute claudeIdentity) ───────────

const sessionCache = new Map();
const IDENTITY_CACHE_LIMIT = 2000;

function setBounded(map, key, value) {
  if (!map.has(key) && map.size >= IDENTITY_CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function getSessionId(seed) {
  let id = sessionCache.get(seed);
  if (id) return id;
  id = crypto.randomUUID();
  setBounded(sessionCache, seed, id);
  return id;
}

function uuidV4FromHash(hex64) {
  return [
    hex64.slice(0, 8),
    hex64.slice(8, 12),
    "4" + hex64.slice(13, 16),
    ((parseInt(hex64.charAt(16), 16) & 0x3) | 0x8).toString(16) + hex64.slice(17, 20),
    hex64.slice(20, 32),
  ].join("-");
}

function resolveCliUserID(providerMeta, seed) {
  const psd = toRecord(providerMeta);
  const existing = nonEmpty(psd.cliUserID) || nonEmpty(psd.cli_user_id);
  if (existing && /^[a-f0-9]{64}$/i.test(existing)) return existing;
  return crypto.createHash("sha256").update("cliUser:" + seed).digest("hex");
}

function resolveAccountUUID(providerMeta, seed) {
  const psd = toRecord(providerMeta);
  const camel = nonEmpty(psd.accountUUID);
  if (camel && camel.length >= 32) return camel;
  const snake = nonEmpty(psd.account_uuid);
  if (snake && snake.length >= 32) return snake;
  return uuidV4FromHash(
    crypto.createHash("sha256").update("account:" + seed).digest("hex")
  );
}

function buildUserIdJson({ deviceId, accountUUID, sessionId }) {
  return JSON.stringify({
    device_id: deviceId,
    account_uuid: accountUUID,
    session_id: sessionId,
  });
}

function buildHashFor(version, dayStamp) {
  return crypto.createHash("sha256").update(`${dayStamp}${version}`).digest("hex").slice(0, 3);
}

function selectBetaFlags(body, model) {
  const b = body || {};
  const hasSystem =
    !!b.system &&
    (typeof b.system === "string" || (Array.isArray(b.system) && b.system.length > 0));
  const tools = b.tools;
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const isFullAgent = hasTools && hasSystem;
  const m = String(model || b.model || "").toLowerCase();
  const isHeavy = /claude-opus|claude-sonnet/.test(m);
  const isContext1m = /claude-opus/.test(m);

  const flags = [];
  if (isFullAgent) flags.push("claude-code-20250219");
  flags.push(creds.ANTHROPIC_BETA_OAUTH);
  if (isFullAgent && isContext1m) {
    flags.push("context-1m-2025-08-07", "mid-conversation-system-2026-04-07");
  }
  flags.push(
    "interleaved-thinking-2025-05-14",
    "redact-thinking-2026-02-12",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05"
  );
  if (isFullAgent) {
    flags.push("advisor-tool-2026-03-01", "extended-cache-ttl-2025-04-11", "cache-diagnosis-2026-04-07");
  }
  if (isFullAgent && isHeavy) {
    flags.push("advanced-tool-use-2025-11-20", "effort-2025-11-24");
  }
  return flags.join(",");
}

/**
 * Mutate Anthropic Messages body + return headers for Claude Code OAuth.
 */
function cloakClaudeCodeRequest(body, account = {}) {
  const tb = body && typeof body === "object" ? body : {};
  const seed =
    nonEmpty(account.id) ||
    nonEmpty(account.email) ||
    nonEmpty(account.accessToken)?.slice(-24) ||
    "claude";

  const sessionId = getSessionId(seed);
  const deviceId = resolveCliUserID(account.providerMeta, seed);
  const accountUUID = resolveAccountUUID(account.providerMeta, seed);

  const dayStamp = new Date().toISOString().slice(0, 10);
  const buildHash = buildHashFor(creds.CLAUDE_CODE_VERSION, dayStamp);
  const billingLine = `x-anthropic-billing-header: cc_version=${creds.CLAUDE_CODE_VERSION}.${buildHash}; cc_entrypoint=cli; cch=00000;`;
  const SENTINEL = "You are Claude Code, Anthropic's official CLI for Claude.";

  let sysBlocks = Array.isArray(tb.system)
    ? tb.system.map((x) => (typeof x === "object" ? { ...x } : { type: "text", text: String(x) }))
    : typeof tb.system === "string"
      ? [{ type: "text", text: tb.system }]
      : [];

  for (let i = sysBlocks.length - 1; i >= 0; i--) {
    const t = sysBlocks[i]?.text;
    if (typeof t === "string" && (t.startsWith("x-anthropic-billing-header:") || t.startsWith(SENTINEL))) {
      sysBlocks.splice(i, 1);
    }
  }
  sysBlocks.unshift({ type: "text", text: billingLine }, { type: "text", text: SENTINEL });
  tb.system = sysBlocks;

  if (!tb.metadata || typeof tb.metadata !== "object") tb.metadata = {};
  tb.metadata.user_id = buildUserIdJson({ deviceId, accountUUID, sessionId });

  // Real CLI never sets cache_control on tools
  if (Array.isArray(tb.tools)) {
    for (const t of tb.tools) {
      if (t && typeof t === "object") delete t.cache_control;
    }
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${account.accessToken || ""}`,
    "anthropic-version": creds.ANTHROPIC_VERSION,
    "anthropic-beta": selectBetaFlags(tb, tb.model),
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "User-Agent": creds.claudeCliUserAgent(),
    "X-Stainless-Package-Version": creds.CLAUDE_CODE_STAINLESS_VERSION,
    "X-Stainless-Timeout": "600",
    "X-Stainless-Arch": creds.stainlessArch(),
    "X-Stainless-Lang": "js",
    "X-Stainless-OS": creds.stainlessOS(),
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": process.version,
    "x-client-request-id": crypto.randomUUID(),
    "X-Claude-Code-Session-Id": sessionId,
  };

  return { body: tb, headers, sessionId };
}

module.exports = {
  generatePKCE,
  generateCliUserID,
  buildAuthUrl,
  splitPastedCode,
  exchangeCode,
  refreshAccessToken,
  fetchClaudeBootstrap,
  enrichWithBackend,
  toAccountPayload,
  readLocalClaudeAuthFile,
  parseClaudeAuthJsonText,
  parseClaudeAuthDoc,
  candidateAuthPaths,
  cloakClaudeCodeRequest,
  selectBetaFlags,
};
