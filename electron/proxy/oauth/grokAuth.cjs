/**
 * Grok Build (xAI) auth — same as OmniRoute grok-cli + official CLI ~/.grok/auth.json
 *
 * Auth flow for users:
 *   1. irm https://x.ai/cli/install.ps1 | iex
 *   2. grok   (browser Google / X login)
 *   3. ComposeVC imports %USERPROFILE%\.grok\auth.json
 *
 * Token refresh: POST https://auth.x.ai/oauth2/token (public client_id from Grok CLI)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

/** Public OAuth client id embedded in Grok Build CLI / OmniRoute */
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

function grokHome() {
  return path.join(os.homedir(), ".grok");
}

function authJsonPath() {
  return path.join(grokHome(), "auth.json");
}

function modelsCachePath() {
  return path.join(grokHome(), "models_cache.json");
}

function parseJwtPayload(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return { email: null, exp: null, claims: null };
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return {
      email: payload.email || null,
      exp: typeof payload.exp === "number" ? payload.exp : null,
      claims: payload,
    };
  } catch {
    return { email: null, exp: null, claims: null };
  }
}

function looksLikeJwt(value) {
  return /^eyJ[^\s:]+\.[^\s:]+\.[^\s:]+$/.test(String(value || "").trim());
}

function extractTxtCredentialLines(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set();
  const extracted = [];

  for (const line of lines) {
    let item = null;

    // JWT only
    if (looksLikeJwt(line)) {
      item = { accessToken: line, refreshToken: null, expiresAt: null, meta: { source: "pasted_jwt" } };
    } else {
      // email:password:accessJWT[:refreshToken]
      // email:accessJWT[:refreshToken]
      // accessJWT:refreshToken
      const parts = line.split(":");
      const jwtIdx = parts.findIndex((p) => looksLikeJwt(p));
      if (jwtIdx >= 0) {
        const accessToken = parts[jwtIdx];
        const after = parts.slice(jwtIdx + 1).join(":");
        const refreshToken = after && looksLikeJwt(after) ? after : after && after.length > 20 ? after : null;
        const before = parts.slice(0, jwtIdx);
        const email =
          before.find((p) => p.includes("@")) ||
          (before[0] && before[0].includes("@") ? before[0] : null);

        item = {
          accessToken,
          refreshToken: refreshToken || null,
          expiresAt: null,
          meta: {
            email: email || null,
            source: refreshToken ? "pasted_txt_refresh" : "pasted_txt",
            // Password (if present between email and JWT) is intentionally ignored — xAI has no password grant.
            hasPasswordField: Boolean(email && before.length >= 2 && before.some((p) => p && !p.includes("@"))),
          },
        };
      }
    }

    if (item) {
      const dedupeKey = `${item.meta?.email || ""}|${item.accessToken}|${item.refreshToken || ""}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        extracted.push(item);
      }
    }
  }

  return extracted;
}

function extractTxtCredentialLine(input) {
  return extractTxtCredentialLines(input)[0] || null;
}

/**
 * Parse ~/.grok/auth.json, pasted JSON, JWT, or email:password:JWT TXT lines.
 */
function extractFromAuthInput(input) {
  if (typeof input === "string") {
    const t = input.trim();
    const txt = extractTxtCredentialLine(t);
    if (txt) return txt;
    try {
      input = JSON.parse(t);
    } catch {
      throw new Error("Expected JWT, email:password:JWT TXT line, or full auth.json JSON");
    }
  }
  if (!input || typeof input !== "object") {
    throw new Error("Invalid auth payload");
  }

  // Already flattened
  if (typeof input.accessToken === "string" && input.accessToken.startsWith("eyJ")) {
    return {
      accessToken: input.accessToken,
      refreshToken: input.refreshToken || null,
      expiresAt: input.expiresAt || null,
      meta: input.meta || {},
    };
  }

  // auth.json: { "https://auth.x.ai::uuid": { key, refresh_token, email, ... } }
  for (const [k, entry] of Object.entries(input)) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.key === "string" && entry.key.startsWith("eyJ")) {
      return {
        accessToken: entry.key,
        refreshToken: typeof entry.refresh_token === "string" ? entry.refresh_token : null,
        expiresAt: entry.expires_at || null,
        meta: {
          email: entry.email || null,
          userId: entry.user_id || null,
          teamId: entry.team_id || null,
          principalType: entry.principal_type || null,
          oidcClientId: entry.oidc_client_id || GROK_CLIENT_ID,
          authKey: k,
        },
      };
    }
  }
  throw new Error("No JWT found in auth.json (expected entry.key)");
}

function readLocalAuthFile() {
  const p = authJsonPath();
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      error: `Not found: ${p}. Install CLI (irm https://x.ai/cli/install.ps1 | iex) and run "grok" once to sign in with Google/X.`,
      path: p,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const extracted = extractFromAuthInput(raw);
    const jwt = parseJwtPayload(extracted.accessToken);
    return {
      ok: true,
      path: p,
      ...extracted,
      email: extracted.meta.email || jwt.email,
      exp: jwt.exp,
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), path: p };
  }
}

function readLocalModelsCache() {
  const p = modelsCachePath();
  if (!fs.existsSync(p)) return { ok: false, models: [], path: p };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const map = raw.models || {};
    const models = Object.entries(map).map(([id, v]) => {
      const info = v.info || v || {};
      return {
        id: info.id || id,
        name: info.name || id,
        owned_by: "xai",
        kind: "chat",
        source: "grok_cli_cache",
        context_window: info.context_window || null,
        api_backend: info.api_backend || "responses",
        base_url: info.base_url || CLI_PROXY_BASE,
        description: info.description || "",
      };
    });
    return {
      ok: true,
      models,
      path: p,
      fetched_at: raw.fetched_at,
      grok_version: raw.grok_version,
    };
  } catch (e) {
    return { ok: false, models: [], error: e.message, path: p };
  }
}

async function refreshAccessToken(refreshToken, clientId = GROK_CLIENT_ID) {
  if (!refreshToken) throw new Error("refresh_token required");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId || GROK_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Grok token refresh failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in refresh response");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 21600,
  };
}

function toAccountPayload(extracted) {
  const jwt = parseJwtPayload(extracted.accessToken);
  let expiresAt = null;
  if (extracted.expiresAt) {
    const t = Date.parse(extracted.expiresAt);
    if (Number.isFinite(t)) expiresAt = t;
  } else if (jwt.exp) {
    expiresAt = jwt.exp * 1000;
  } else {
    expiresAt = Date.now() + 6 * 3600 * 1000;
  }
  const email = extracted.email || extracted.meta?.email || jwt.email || "grok-cli";
  const expired =
    typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= Date.now();
  return {
    providerId: "grok",
    authType: "oauth",
    name: email,
    email,
    planType: extracted.meta?.principalType || "User",
    workspaceId: extracted.meta?.teamId || null,
    accessToken: extracted.accessToken,
    refreshToken: extracted.refreshToken,
    idToken: null,
    expiresAt,
    apiKey: "",
    baseUrl: CLI_PROXY_BASE,
    defaultModel: "grok-4.5",
    enabled: true,
    usage: null,
    usageError:
      expired && !extracted.refreshToken
        ? "Grok token expired — no refresh_token. Re-auth via browser/CLI or import TXT with refresh."
        : null,
    usageUpdatedAt: null,
    createdAt: Date.now(),
    providerMeta: {
      ...extracted.meta,
      source: extracted.meta?.source || "grok_cli",
      oidcClientId: extracted.meta?.oidcClientId || GROK_CLIENT_ID,
      jwtExpiredOnImport: expired,
    },
  };
}

/**
 * If refresh_token present and access is near/over expiry — refresh before saving.
 * Password-based re-login is NOT supported by xAI OAuth (no resource-owner password grant).
 */
async function ensureExtractedFresh(extracted) {
  if (!extracted?.accessToken) return extracted;
  const jwt = parseJwtPayload(extracted.accessToken);
  const expMs = jwt.exp ? jwt.exp * 1000 : extracted.expiresAt ? Date.parse(extracted.expiresAt) : null;
  const needsRefresh =
    extracted.refreshToken &&
    (!Number.isFinite(expMs) || expMs <= Date.now() + 120_000);

  if (!needsRefresh) return extracted;

  try {
    const tokens = await refreshAccessToken(
      extracted.refreshToken,
      extracted.meta?.oidcClientId || GROK_CLIENT_ID
    );
    const nextJwt = parseJwtPayload(tokens.access_token);
    return {
      ...extracted,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || extracted.refreshToken,
      expiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 21600) * 1000).toISOString(),
      email: extracted.email || extracted.meta?.email || nextJwt.email || null,
      meta: {
        ...(extracted.meta || {}),
        source: extracted.meta?.source || "refreshed",
        autoRefreshed: true,
      },
    };
  } catch (e) {
    return {
      ...extracted,
      meta: {
        ...(extracted.meta || {}),
        refreshError: e.message || String(e),
      },
    };
  }
}

module.exports = {
  GROK_CLIENT_ID,
  TOKEN_URL,
  CLI_PROXY_BASE,
  authJsonPath,
  modelsCachePath,
  grokHome,
  parseJwtPayload,
  extractTxtCredentialLines,
  extractFromAuthInput,
  readLocalAuthFile,
  readLocalModelsCache,
  refreshAccessToken,
  ensureExtractedFresh,
  toAccountPayload,
};
