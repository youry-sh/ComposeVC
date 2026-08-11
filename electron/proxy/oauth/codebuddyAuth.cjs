const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const API_ENDPOINT = "https://www.codebuddy.ai";
const API_PREFIX = "/v2/plugin";
const STATE_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/state`;
const TOKEN_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/token`;
const REFRESH_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/token/refresh`;
const ACCOUNT_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/login/account`;
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 400;
const REQUEST_TIMEOUT_MS = 30000;

function text(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function pick(root, ...keys) {
  for (const key of keys) { const value = root?.[key]; if (value !== undefined && value !== null && value !== "") return value; }
  return null;
}
function number(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function expiry(data, fallback = 3600) {
  const value = pick(data, "expiresAt", "expires_at");
  if (number(value)) return number(value) < 100000000000 ? number(value) * 1000 : number(value);
  const seconds = number(pick(data, "expiresIn", "expires_in"));
  return Date.now() + (seconds || fallback) * 1000;
}
async function requestJson(url, init = {}) {
  const response = await fetch(url, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const raw = await response.text().catch(() => "");
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok) throw new Error(`CodeBuddy request failed (${response.status}): ${raw.slice(0, 300)}`);
  return data;
}
function tokenData(data) {
  const root = object(data);
  const source = object(root.data || root.token || root);
  const accessToken = text(pick(source, "accessToken", "access_token", "token", "key"));
  if (!accessToken) throw new Error("CodeBuddy access token missing");
  return { access_token: accessToken, refresh_token: text(pick(source, "refreshToken", "refresh_token")), token_type: text(pick(source, "tokenType", "token_type")) || "Bearer", expires_in: number(pick(source, "expiresIn", "expires_in")) || 3600, expires_at: expiry(source), domain: text(source.domain), raw: source };
}
function okResponse(data) { const code = number(data?.code); return code === null || code === 0 || code === 200; }
function homePaths() {
  const home = os.homedir();
  return [process.env.CODEBUDDY_AUTH_FILE, path.join(home, ".codebuddy", "auth.json"), path.join(home, ".config", "codebuddy", "auth.json"), path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "CodeBuddy", "auth.json")].filter(Boolean);
}
function extractFromAuthInput(input) {
  let value = input;
  if (typeof value === "string") { const raw = value.trim(); try { value = JSON.parse(raw); } catch { const parts = raw.split(":"); const access = parts.find((part) => part.startsWith("eyJ") || part.startsWith("cb_") || part.startsWith("sk-")); if (!access) throw new Error("Expected CodeBuddy token or JSON"); return { accessToken: access, refreshToken: parts[parts.indexOf(access) + 1] || null, meta: { source: "pasted_token" } }; } }
  const root = object(value); const nested = object(root.data || root.credentials || root.oauth || root.token); const source = Object.keys(nested).length ? nested : root;
  const accessToken = text(pick(source, "accessToken", "access_token", "token", "key", "access"));
  if (!accessToken) throw new Error("CodeBuddy access token missing");
  return { accessToken, refreshToken: text(pick(source, "refreshToken", "refresh_token", "refresh")), expiresAt: pick(source, "expiresAt", "expires_at", "expires"), email: text(pick(source, "email", "mail")), uid: text(pick(source, "uid", "userId", "user_id")), name: text(pick(source, "nickname", "name")), domain: text(source.domain), meta: source };
}
function localAuthPaths() { return homePaths(); }
function readLocalAuthFile() {
  for (const file of homePaths()) { try { const parsed = JSON.parse(fs.readFileSync(file, "utf8")); return { ok: true, path: file, ...extractFromAuthInput(parsed) }; } catch (error) { if (error.code !== "ENOENT") continue; } }
  return { ok: false, error: `CodeBuddy local authentication was not found. Checked ${homePaths().length} paths.` };
}
async function startDeviceAuth({ platform = "ide", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const data = await requestJson(`${STATE_ENDPOINT}?platform=${encodeURIComponent(platform)}`, { method: "POST", body: "{}", signal: AbortSignal.timeout(timeoutMs) });
  if (!okResponse(data) || !data.data?.state) throw new Error("CodeBuddy auth/state response missing state");
  const state = String(data.data.state); const authorizeUrl = text(pick(data.data, "authUrl", "auth_url", "url")) || `${API_ENDPOINT}/login?state=${encodeURIComponent(state)}`;
  return { state, authorizeUrl, expires_in: 600, interval: POLL_INTERVAL_MS / 1000 };
}
async function pollDeviceAuth(state, { signal, intervalMs = POLL_INTERVAL_MS, maxPolls = MAX_POLLS } = {}) {
  if (!state) throw new Error("CodeBuddy state required");
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const response = await fetch(`${TOKEN_ENDPOINT}?state=${encodeURIComponent(state)}`, { headers: { Accept: "application/json" }, signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const raw = await response.text().catch(() => ""); let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch {}
    if (response.ok && okResponse(data) && (data.data?.accessToken || data.data?.access_token || data.access_token)) return tokenData(data);
    if (attempt + 1 < maxPolls) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("CodeBuddy OAuth timed out");
}
async function refreshAccessToken(accessToken, refreshToken, { domain, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!refreshToken) throw new Error("refresh_token required");
  const headers = { Authorization: `Bearer ${accessToken || ""}`, "X-Refresh-Token": refreshToken };
  if (domain) headers["X-Domain"] = domain;
  const data = await requestJson(REFRESH_ENDPOINT, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(timeoutMs) });
  if (!okResponse(data)) throw new Error("CodeBuddy token refresh failed");
  const result = tokenData(data); result.refresh_token = result.refresh_token || refreshToken; return result;
}
async function fetchAccountInfo(accessToken, state, domain) {
  const headers = { Authorization: `Bearer ${accessToken}` }; if (domain) headers["X-Domain"] = domain;
  const data = await requestJson(`${ACCOUNT_ENDPOINT}?state=${encodeURIComponent(state || "")}`, { headers });
  return object(data.data || data);
}
async function buildAccountPayload(tokens, extra = {}) {
  const normalized = tokenData(tokens); let profile = object(extra.profile);
  if (extra.state) { try { profile = await fetchAccountInfo(normalized.access_token, extra.state, normalized.domain); } catch {} }
  const email = text(pick(extra, "email")) || text(pick(profile, "email", "mail")) || text(pick(normalized.raw, "email")) || text(pick(profile, "nickname", "uid")) || "codebuddy";
  return { providerId: extra.providerId || "codebuddy", authType: "oauth", name: text(pick(extra, "name")) || text(pick(profile, "nickname", "name")) || email, email, accessToken: normalized.access_token, refreshToken: normalized.refresh_token || null, idToken: null, expiresAt: normalized.expires_at, apiKey: "", baseUrl: extra.baseUrl || API_ENDPOINT, defaultModel: extra.defaultModel || "auto", enabled: true, usage: extra.usage || null, usageError: null, usageUpdatedAt: null, createdAt: Date.now(), uid: text(pick(extra, "uid")) || text(pick(profile, "uid", "userId", "user_id")), enterpriseId: text(pick(profile, "enterpriseId", "enterprise_id")), domain: normalized.domain || text(pick(extra, "domain")), providerMeta: { source: extra.source || "codebuddy_oauth", authRaw: normalized.raw, profileRaw: profile } };
}
async function buildPayloadFromToken(value, extra = {}) { return buildAccountPayload(extractFromAuthInput(value), { ...extra, source: extra.source || "codebuddy_import" }); }
async function refreshPayloadForAccount(account) { const tokens = await refreshAccessToken(account.accessToken, account.refreshToken, { domain: account.domain }); return buildAccountPayload(tokens, { ...account, providerId: account.providerId || "codebuddy", email: account.email, name: account.name, source: "codebuddy_refresh" }); }
async function startLogin(options = {}) { return startDeviceAuth(options); }
async function completeLogin(state, options = {}) { const tokens = await pollDeviceAuth(state, options); return buildAccountPayload(tokens, { ...options, state, source: options.source || "codebuddy_oauth" }); }
async function refreshToken(accessToken, refreshTokenValue, options = {}) { return refreshAccessToken(accessToken, refreshTokenValue, options); }
function cancelLogin() { return true; }
module.exports = { API_ENDPOINT, API_PREFIX, STATE_ENDPOINT, TOKEN_ENDPOINT, REFRESH_ENDPOINT, ACCOUNT_ENDPOINT, POLL_INTERVAL_MS, MAX_POLLS, localAuthPaths, extractFromAuthInput, readLocalAuthFile, startDeviceAuth, pollDeviceAuth, startLogin, completeLogin, cancelLogin, refreshAccessToken, refreshToken, fetchAccountInfo, buildAccountPayload, buildPayloadFromToken, refreshPayloadForAccount };
