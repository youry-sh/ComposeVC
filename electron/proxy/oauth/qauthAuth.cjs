const fs = require("fs");
const os = require("os");
const path = require("path");

const API_ENDPOINT = "https://api.cline.bot";
const API_PREFIX = "/api/v1";
const CHAT_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}`;
const MODELS_ENDPOINT = `${CHAT_ENDPOINT}/models`;
const RECOMMENDED_MODELS_ENDPOINT = `${API_ENDPOINT}/api/v1/ai/cline/recommended-models`;
const AUTH_REGISTER_ENDPOINT = `${CHAT_ENDPOINT}/auth/register`;
const AUTH_REFRESH_ENDPOINT = `${CHAT_ENDPOINT}/auth/refresh`;
const WORKOS_ENDPOINT = "https://api.workos.com";
const WORKOS_DEVICE_ENDPOINT = `${WORKOS_ENDPOINT}/user_management/authorize/device`;
const WORKOS_AUTHENTICATE_ENDPOINT = `${WORKOS_ENDPOINT}/user_management/authenticate`;
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const REQUEST_TIMEOUT_MS = 30000;
const DEVICE_EXPIRES_SECONDS = 300;
const DEVICE_POLL_SECONDS = 5;

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function pick(root, ...keys) {
  for (const key of keys) {
    const value = root?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}
function expiry(value, fallback = 3600) {
  const n = Number(value);
  if (Number.isFinite(n)) return n < 100000000000 ? n * 1000 : n;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : Date.now() + fallback * 1000;
}
function authPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return [
    process.env.CLINE_AUTH_FILE,
    process.env.CLINE_PROVIDER_SETTINGS_PATH,
    path.join(appData, "Cline", "User", "globalStorage", "cline.cline", "state", "settings", "providers.json"),
    path.join(appData, "Cline", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "providers.json"),
    path.join(xdg, "cline", "settings", "providers.json"),
    path.join(home, ".cline", "data", "settings", "providers.json"),
  ].filter(Boolean);
}
function extractFromAuthInput(input) {
  let value = input;
  if (typeof value === "string") {
    const raw = value.trim();
    try { value = JSON.parse(raw); } catch { return { accessToken: raw, refreshToken: null, expiresAt: null, meta: { source: "pasted_token" } }; }
  }
  const root = object(value);
  const candidates = [root, root.cline, root.auth, root.credentials, root.providers, root.clineAccount, root.Cline, root.clineOAuth, root.oauth, root.cline?.oauth, root.cline?.credentials].filter(Boolean);
  for (const candidate of candidates) {
    const source = object(candidate);
    const accessToken = text(pick(source, "accessToken", "access_token", "access", "token", "apiKey", "key"));
    if (accessToken) {
      return {
        accessToken,
        refreshToken: text(pick(source, "refreshToken", "refresh_token")),
        expiresAt: pick(source, "expiresAt", "expires_at", "expiresIn", "expires_in"),
        email: text(pick(source, "email", "mail")),
        uid: text(pick(source, "id", "userId", "user_id", "clineUserId")),
        name: text(pick(source, "name", "displayName")),
        meta: source,
      };
    }
  }
  throw new Error("Cline access token missing");
}
function readLocalAuthFile() {
  for (const file of authPaths()) {
    try { return { ok: true, path: file, ...extractFromAuthInput(JSON.parse(fs.readFileSync(file, "utf8"))) }; } catch (error) { if (error.code !== "ENOENT") continue; }
  }
  return { ok: false, error: "Cline local authentication was not found" };
}
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const raw = await response.text().catch(() => "");
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`Cline request failed (${response.status}): ${raw.slice(0, 300)}`);
  return data;
}
async function fetchModels(accessToken) {
  return requestJson(MODELS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${String(accessToken).toLowerCase().startsWith("workos:") ? accessToken : `workos:${accessToken}`}`,
      "User-Agent": "Cline/3.0.48",
      "X-Client-Version": "3.0.48",
    },
  });
}
async function fetchRecommendedModels() {
  return requestJson(RECOMMENDED_MODELS_ENDPOINT, {
    headers: { "User-Agent": "Cline/3.0.48", "X-Client-Version": "3.0.48" },
  });
}
async function buildAccountPayload(tokens, extra = {}) {
  const normalized = extractFromAuthInput(tokens);
  let models = null;
  try { models = await fetchModels(normalized.accessToken); } catch {}
  if (!models) {
    try { models = await fetchRecommendedModels(); } catch {}
  }
  const email = text(pick(extra, "email")) || normalized.email || "cline";
  return {
    providerId: "qauth",
    authType: "oauth",
    name: text(pick(extra, "name")) || normalized.name || email,
    email,
    accessToken: normalized.accessToken,
    refreshToken: normalized.refreshToken,
    idToken: null,
    expiresAt: expiry(normalized.expiresAt),
    apiKey: "",
    baseUrl: CHAT_ENDPOINT,
    defaultModel: extra.defaultModel || "anthropic/claude-sonnet-4-6",
    enabled: true,
    usage: null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    userId: normalized.uid || normalized.meta?.userInfo?.clineUserId || normalized.meta?.userInfo?.id || null,
    providerMeta: { source: extra.source || "cline_import", modelsRaw: models, authRaw: normalized.meta },
  };
}
async function buildPayloadFromToken(value, extra = {}) { return buildAccountPayload(extractFromAuthInput(value), { ...extra, source: extra.source || "cline_import" }); }
async function startDeviceAuth({ requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(WORKOS_DEVICE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Cline device authorization failed (${response.status}): ${data.error_description || data.error || "unknown error"}`);
  if (!data.device_code || !data.user_code || !data.verification_uri) throw new Error("Cline device authorization response is incomplete");
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete || null,
    expiresInSeconds: Number(data.expires_in) > 0 ? Number(data.expires_in) : DEVICE_EXPIRES_SECONDS,
    pollIntervalSeconds: Number(data.interval) > 0 ? Number(data.interval) : DEVICE_POLL_SECONDS,
  };
}
async function pollDeviceAuth(deviceCode, { expiresInSeconds = DEVICE_EXPIRES_SECONDS, pollIntervalSeconds = DEVICE_POLL_SECONDS, requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!deviceCode) throw new Error("Cline device code is required");
  const deadline = Date.now() + expiresInSeconds * 1000;
  let interval = Math.max(1, pollIntervalSeconds);
  while (Date.now() < deadline) {
    const response = await fetch(WORKOS_AUTHENTICATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: WORKOS_CLIENT_ID }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.access_token && data.refresh_token) {
      return registerTokens({ accessToken: data.access_token, refreshToken: data.refresh_token, tokenType: data.token_type || "Bearer" }, { requestTimeoutMs });
    }
    if (!["authorization_pending", "slow_down"].includes(data.error)) {
      throw new Error(`Cline device authorization failed: ${data.error_description || data.error || response.status}`);
    }
    if (data.error === "slow_down") interval += 1;
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
  throw new Error("Cline device authorization timed out");
}
async function registerTokens(tokens, { requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const response = await fetch(AUTH_REGISTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  const source = object(data.data || data);
  if (!response.ok || !source.accessToken) throw new Error(`Cline token registration failed (${response.status})`);
  return { accessToken: source.accessToken, refreshToken: source.refreshToken || tokens.refreshToken, expiresAt: source.expiresAt, email: source.userInfo?.email, uid: source.accountId, name: source.userInfo?.name, meta: source };
}
async function refreshAccessToken(refreshToken, { requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!refreshToken) throw new Error("Cline refresh token is required");
  const response = await fetch(AUTH_REFRESH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const data = await response.json().catch(() => ({}));
  const source = object(data.data || data);
  if (!response.ok || !source.accessToken) throw new Error(`Cline token refresh failed (${response.status})`);
  return registerTokens({
    accessToken: source.accessToken,
    refreshToken: source.refreshToken || refreshToken,
  }, { requestTimeoutMs });
}
async function refreshPayloadForAccount(account) {
  if (!account?.refreshToken) throw new Error("Cline account has no refresh token; re-authenticate");
  const tokens = await refreshAccessToken(account.refreshToken);
  return buildAccountPayload(tokens, { ...account, source: "cline_refresh" });
}
function startLogin(options = {}) { return startDeviceAuth(options); }
function completeLogin(started, options = {}) { return pollDeviceAuth(started?.deviceCode, { ...started, ...options }); }
function cancelLogin() { return true; }
module.exports = { API_ENDPOINT, API_PREFIX, CHAT_ENDPOINT, MODELS_ENDPOINT, RECOMMENDED_MODELS_ENDPOINT, AUTH_REGISTER_ENDPOINT, AUTH_REFRESH_ENDPOINT, WORKOS_ENDPOINT, WORKOS_DEVICE_ENDPOINT, WORKOS_AUTHENTICATE_ENDPOINT, WORKOS_CLIENT_ID, authPaths, localAuthPaths: authPaths, extractFromAuthInput, readLocalAuthFile, fetchModels, fetchRecommendedModels, buildAccountPayload, buildPayloadFromToken, startDeviceAuth, pollDeviceAuth, registerTokens, startLogin, completeLogin, refreshAccessToken, refreshPayloadForAccount, cancelLogin };
