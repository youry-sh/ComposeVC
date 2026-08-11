const fs = require("fs").promises;
const os = require("os");
const path = require("path");

const API_VERSION = "2025-04-01";
const USER_AGENT = "antigravity-cockpit-tools";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenFrom(value) {
  const root = record(value);
  const nested = record(root.token || root.credentials || root.auth || root.github);
  const source = Object.keys(nested).length ? nested : root;
  return {
    accessToken: text(source.access_token) || text(source.accessToken) || text(source.token),
    refreshToken: text(source.refresh_token) || text(source.refreshToken),
    tokenType: text(source.token_type) || text(source.tokenType) || "Bearer",
    scope: text(source.scope),
    expiresAt: expiry(source),
  };
}

function expiry(source) {
  const value = source.expires_at ?? source.expiresAt ?? source.expiry_date;
  if (typeof value === "number" && Number.isFinite(value)) return value < 100000000000 ? value * 1000 : value;
  const date = text(value) || text(source.expiry);
  if (date) {
    const parsed = Date.parse(date);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Number.isFinite(Number(source.expires_in))) return Date.now() + Number(source.expires_in) * 1000;
  return null;
}

function localAuthPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const userData = process.env.VSCODE_PORTABLE
    ? path.join(process.env.VSCODE_PORTABLE, "user-data")
    : path.join(appData, "Code", "User");
  return [
    process.env.GITHUB_COPILOT_TOKEN_FILE,
    path.join(userData, "globalStorage", "github.copilot", "github.copilot-auth.json"),
    path.join(userData, "globalStorage", "github.copilot-chat", "github.copilot-auth.json"),
    path.join(home, ".config", "Code", "User", "globalStorage", "github.copilot", "github.copilot-auth.json"),
    path.join(home, ".vscode", "extensions", "github.copilot", "auth.json"),
  ].filter(Boolean);
}

async function parseLocalTokenFile(raw) {
  const parsed = tokenFrom(raw);
  if (!parsed.accessToken) throw new Error("GitHub access token missing in local auth file");
  return parsed;
}

async function readLocalAuthFile() {
  const paths = localAuthPaths();
  for (const file of paths) {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      const token = await parseLocalTokenFile(raw);
      return { ok: true, path: file, ...token };
    } catch (error) {
      if (error && error.code !== "ENOENT") continue;
    }
  }
  return { ok: false, error: `GitHub Copilot local authentication was not found. Checked ${paths.length} paths.` };
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(15000),
  });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { message: body.slice(0, 300) }; }
  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${text(data.message) || body.slice(0, 240)}`);
  return data;
}

async function fetchGithubUser(accessToken) {
  return requestJson(GITHUB_USER_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function fetchGithubEmail(accessToken) {
  try {
    const emails = await requestJson(GITHUB_EMAILS_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const verified = Array.isArray(emails) ? emails.filter((item) => item.verified) : [];
    return (verified.find((item) => item.primary) || verified[0])?.email || null;
  } catch (error) {
    if (/\((401|403|404)\)/.test(error.message)) return null;
    throw error;
  }
}

async function fetchCopilotToken(githubAccessToken) {
  const data = await requestJson(COPILOT_TOKEN_URL, { headers: { Authorization: `token ${githubAccessToken}` } });
  if (!text(data.token)) throw new Error(text(data.message) || "Copilot token missing");
  let user = {};
  try { user = await requestJson(COPILOT_USER_URL, { headers: { Authorization: `token ${githubAccessToken}` } }); } catch {}
  return {
    token: data.token,
    plan: text(user.copilot_plan) || text(data.sku),
    chatEnabled: typeof data.chat_enabled === "boolean" ? data.chat_enabled : null,
    expiresAt: number(data.expires_at),
    refreshIn: number(data.refresh_in),
    quotaSnapshots: user.quota_snapshots ?? null,
    quotaResetDate: text(user.quota_reset_date),
    limitedUserQuotas: data.limited_user_quotas ?? null,
    limitedUserResetDate: number(data.limited_user_reset_date),
  };
}

async function enrich(accessToken) {
  const user = await fetchGithubUser(accessToken);
  const email = text(user.email) || await fetchGithubEmail(accessToken);
  const copilot = await fetchCopilotToken(accessToken);
  return { user, email, copilot };
}

async function refreshCopilotToken(githubAccessToken) {
  if (!text(githubAccessToken)) throw new Error("GitHub access token required");
  return fetchCopilotToken(githubAccessToken);
}

async function buildAccountPayload(tokens, extra = {}) {
  const normalized = tokenFrom(tokens);
  if (!normalized.accessToken) throw new Error("GitHub access token required");
  const data = extra.user ? extra : await enrich(normalized.accessToken);
  const user = record(data.user);
  const copilot = data.copilot || await fetchCopilotToken(normalized.accessToken);
  return {
    providerId: "github-copilot",
    authType: "oauth",
    id: `ghcp_${String(user.id || user.login || "account")}`,
    name: text(user.name) || text(user.login) || "GitHub Copilot",
    email: data.email || text(user.email),
    githubLogin: text(user.login),
    githubId: user.id || null,
    githubName: text(user.name),
    githubEmail: data.email || text(user.email),
    githubAccessToken: normalized.accessToken,
    githubTokenType: normalized.tokenType,
    githubScope: normalized.scope,
    accessToken: copilot.token,
    refreshToken: normalized.refreshToken,
    expiresAt: copilot.expiresAt,
    copilotToken: copilot.token,
    copilotPlan: copilot.plan,
    copilotChatEnabled: copilot.chatEnabled,
    copilotExpiresAt: copilot.expiresAt,
    copilotRefreshIn: copilot.refreshIn,
    copilotQuotaSnapshots: copilot.quotaSnapshots,
    copilotQuotaResetDate: copilot.quotaResetDate,
    copilotLimitedUserQuotas: copilot.limitedUserQuotas,
    copilotLimitedUserResetDate: copilot.limitedUserResetDate,
    createdAt: Date.now(),
    enabled: true,
  };
}

module.exports = {
  API_VERSION,
  localAuthPaths,
  parseLocalTokenFile,
  readLocalAuthFile,
  fetchGithubUser,
  fetchGithubEmail,
  fetchCopilotToken,
  refreshCopilotToken,
  enrich,
  buildAccountPayload,
  normalizeToken: tokenFrom,
};
