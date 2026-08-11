/**
 * Antigravity / agy auth helpers (OmniRoute parity):
 *  - token refresh (Google OAuth)
 *  - loadCodeAssist → projectId + tier
 *  - local CLI import (~/.gemini/antigravity-cli/antigravity-oauth-token)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const creds = require("./antigravityCreds.cjs");

function toRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function nonEmpty(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function localTokenPath() {
  if (process.env.AGY_TOKEN_FILE && process.env.AGY_TOKEN_FILE.trim()) {
    return process.env.AGY_TOKEN_FILE.trim();
  }
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

/**
 * Parse agy CLI token file. Nested under `.token` or flat.
 */
function parseAgyTokenFile(raw) {
  const doc = toRecord(raw);
  const token = doc.token && typeof doc.token === "object" ? toRecord(doc.token) : doc;
  const accessToken = nonEmpty(token.access_token);
  const refreshToken = nonEmpty(token.refresh_token);
  if (!accessToken) throw new Error("access_token missing in agy token file");
  if (!refreshToken) throw new Error("refresh_token missing in agy token file");

  let expiresAt = null;
  const iso = nonEmpty(token.expiry) || nonEmpty(token.expires_at);
  if (iso) {
    const ms = Date.parse(iso);
    expiresAt = Number.isFinite(ms) ? ms : null;
  } else if (typeof token.expiry_date === "number" && Number.isFinite(token.expiry_date)) {
    expiresAt = token.expiry_date;
  }

  return {
    accessToken,
    refreshToken,
    tokenType: nonEmpty(token.token_type) || "Bearer",
    expiresAt,
    authMethod: nonEmpty(doc.auth_method) || nonEmpty(token.auth_method),
  };
}

function readLocalAgyAuthFile() {
  const p = localTokenPath();
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      error: `Not found: ${p}. Run agy, sign in with Google, then Import CLI.`,
      path: p,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const parsed = parseAgyTokenFile(raw);
    return { ok: true, path: p, ...parsed };
  } catch (e) {
    return { ok: false, error: e.message || String(e), path: p };
  }
}

async function fetchFirstOk(urls, init, timeoutMs = 8000) {
  let lastErr = null;
  const signal = AbortSignal.timeout(timeoutMs);
  for (const url of urls) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      lastErr = new Error(`${res.status} ${await res.text().catch(() => "")}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Antigravity endpoints unavailable");
}

/**
 * Best-effort: userinfo + loadCodeAssist → email, projectId, tier.
 */
async function enrichWithBackend(accessToken) {
  let email = null;
  let projectId = null;
  let tier = null;
  let name = null;

  try {
    const res = await fetch(`${creds.USERINFO_URL}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const j = await res.json();
      email = nonEmpty(j.email);
      name = nonEmpty(j.name) || nonEmpty(j.given_name);
    }
  } catch {
    /* */
  }

  try {
    const res = await fetchFirstOk(
      creds.loadCodeAssistUrls(),
      {
        method: "POST",
        headers: creds.headers("loadCodeAssist", accessToken),
        body: JSON.stringify({ metadata: creds.loadCodeAssistMetadata() }),
      },
      8000
    );
    const data = toRecord(await res.json());
    const project = data.cloudaicompanionProject;
    projectId =
      (typeof project === "string" ? nonEmpty(project) : null) ||
      nonEmpty(toRecord(project).id);
    // tier id
    const onboard = toRecord(data.allowedTiers || data.currentTier || data);
    tier =
      nonEmpty(data.tierId) ||
      nonEmpty(toRecord(data.currentTier).id) ||
      nonEmpty(toRecord(data.currentTier).name) ||
      nonEmpty(toRecord(onboard).id) ||
      null;
    if (!tier && Array.isArray(data.allowedTiers) && data.allowedTiers[0]) {
      tier = nonEmpty(toRecord(data.allowedTiers[0]).id);
    }
  } catch {
    /* */
  }

  return { email, name, projectId, tier };
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("refresh_token required");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.CLIENT_ID,
    client_secret: creds.CLIENT_SECRET,
  });
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": creds.antigravityNativeOAuthUserAgent(),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Antigravity token refresh failed (${res.status}): ${t.slice(0, 200)}`);
    if (/invalid_grant/i.test(t)) err.code = "invalid_grant";
    throw err;
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in refresh response");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 3600,
  };
}

function toAccountPayload(providerId = "antigravity", tokens, extra = {}) {
  const email = extra.email || "antigravity";
  const expiresAt =
    tokens.expiresAt != null
      ? Number(tokens.expiresAt)
      : Date.now() + (Number(tokens.expires_in) || 3600) * 1000;

  return {
    providerId: "antigravity",
    authType: "oauth",
    name: extra.name || email,
    email,
    planType: extra.tier || extra.plan || "Free",
    workspaceId: extra.projectId || null,
    accessToken: tokens.accessToken || tokens.access_token,
    refreshToken: tokens.refreshToken || tokens.refresh_token,
    idToken: null,
    expiresAt,
    apiKey: "",
    baseUrl: creds.BASE_URLS[0],
    defaultModel: "gemini-3.1-pro-high",
    enabled: true,
    usage: null,
    usageError: null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: {
      source: extra.source || "antigravity_oauth",
      projectId: extra.projectId || null,
      tier: extra.tier || null,
      authMethod: extra.authMethod || null,
    },
  };
}

module.exports = {
  localTokenPath,
  parseAgyTokenFile,
  readLocalAgyAuthFile,
  enrichWithBackend,
  refreshAccessToken,
  toAccountPayload,
  fetchFirstOk,
};
