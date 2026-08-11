const crypto = require("crypto");

const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_ENDPOINT = "https://api2.cursor.sh/auth/poll";
const REFRESH_ENDPOINT = "https://api2.cursor.sh/auth/refresh";
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

function generateUuid() {
  return crypto.randomUUID();
}

function buildAuthUrl({ codeChallenge, uuid, mode = "login" } = {}) {
  if (!codeChallenge || !uuid) throw new Error("codeChallenge and uuid are required");
  const params = new URLSearchParams({ challenge: codeChallenge, uuid, mode });
  return `${LOGIN_URL}?${params}`;
}

async function readJson(response) {
  const text = await response.text().catch(() => "");
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Cursor request failed (${response.status}): ${text.slice(0, 300)}`);
  return data;
}

async function pollCursor(uuid, codeVerifier, { signal, timeoutMs = 15000 } = {}) {
  if (!uuid || !codeVerifier) throw new Error("uuid and codeVerifier are required");
  const url = `${POLL_ENDPOINT}?${new URLSearchParams({ uuid, verifier: codeVerifier })}`;
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: signal || AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return { pending: true };
  const data = await readJson(response);
  if (!data.access_token || !data.refresh_token) return { pending: true, data };
  return { pending: false, tokens: normalizeTokens(data), data };
}

async function refreshAccessToken(refreshToken, { timeoutMs = 15000 } = {}) {
  if (!refreshToken) throw new Error("refresh_token required");
  const response = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await readJson(response);
  if (!data.access_token) throw new Error("Cursor refresh response missing access_token");
  return normalizeTokens(data, refreshToken);
}

function normalizeTokens(data, oldRefreshToken = null) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || oldRefreshToken || null,
    token_type: data.token_type || "Bearer",
    expires_in: Number(data.expires_in) || 3600,
    auth_id: data.auth_id || null,
  };
}

function toAccountPayload(tokens, extra = {}) {
  const accessToken = tokens.access_token || tokens.accessToken;
  const refreshToken = tokens.refresh_token || tokens.refreshToken || null;
  if (!accessToken) throw new Error("Cursor access token missing");
  const email = extra.email || extra.authId || tokens.auth_id || "cursor";
  return {
    providerId: "cursor",
    authType: "oauth",
    name: extra.name || email,
    email,
    planType: extra.membershipType || extra.planType || "unknown",
    accessToken,
    refreshToken,
    idToken: null,
    expiresAt: Number(tokens.expires_at || tokens.expiresAt) || Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    apiKey: "",
    baseUrl: "https://api2.cursor.sh",
    defaultModel: "cursor-small",
    enabled: true,
    usage: extra.usage || null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: { source: extra.source || "cursor_oauth", authId: extra.authId || tokens.auth_id || null, authRaw: extra.authRaw || null },
  };
}

module.exports = { LOGIN_URL, POLL_ENDPOINT, REFRESH_ENDPOINT, POLL_INTERVAL_MS, MAX_POLLS, generatePKCE, generateUuid, buildAuthUrl, pollCursor, refreshAccessToken, normalizeTokens, toAccountPayload };
