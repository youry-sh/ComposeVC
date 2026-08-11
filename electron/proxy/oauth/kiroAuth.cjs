/**
 * Kiro OAuth auth helpers: device code (Builder ID), refresh, import token, account payload.
 * OmniRoute parity (src/lib/oauth/services/kiro.ts + providers/kiro.ts).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const creds = require("./kiroCreds.cjs");

function nonEmpty(v) {
  const s = String(v || "").trim();
  return s || null;
}

async function registerClient(region = "us-east-1") {
  const r = creds.assertValidAwsRegion(region);
  const endpoint = `https://oidc.${r}.amazonaws.com/client/register`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientName: creds.KIRO_CONFIG.clientName,
      clientType: creds.KIRO_CONFIG.clientType,
      scopes: creds.KIRO_CONFIG.scopes,
      grantTypes: creds.KIRO_CONFIG.grantTypes,
      issuerUrl: creds.KIRO_CONFIG.issuerUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`Kiro client registration failed: ${await response.text()}`);
  }
  const data = await response.json();
  return {
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    clientSecretExpiresAt: data.clientSecretExpiresAt,
  };
}

async function startDeviceAuthorization(clientId, clientSecret, startUrl, region = "us-east-1") {
  const r = creds.assertValidAwsRegion(region);
  const endpoint = `https://oidc.${r}.amazonaws.com/device_authorization`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      startUrl: startUrl || creds.KIRO_CONFIG.startUrl,
    }),
  });
  if (!response.ok) {
    throw new Error(`Kiro device authorization failed: ${await response.text()}`);
  }
  const data = await response.json();
  return {
    deviceCode: data.deviceCode,
    userCode: data.userCode,
    verificationUri: data.verificationUri,
    verificationUriComplete: data.verificationUriComplete,
    expiresIn: data.expiresIn,
    interval: data.interval || 5,
  };
}

async function pollDeviceToken(clientId, clientSecret, deviceCode, region = "us-east-1") {
  const r = creds.assertValidAwsRegion(region);
  const endpoint = `https://oidc.${r}.amazonaws.com/token`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { error: "invalid_response", error_description: await response.text() };
  }
  if (data.accessToken) {
    return {
      ok: true,
      pending: false,
      tokens: {
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
        expires_in: data.expiresIn || 3600,
      },
    };
  }
  const err = data.error || "authorization_pending";
  return {
    ok: false,
    pending: err === "authorization_pending" || err === "slow_down",
    error: err,
    errorDescription: data.error_description || data.message,
  };
}

async function discoverProfileArn(accessToken, region = "us-east-1") {
  try {
    const r = String(region || "us-east-1").toLowerCase();
    const host = creds.runtimeHost(r);
    const res = await fetch(`${host}/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.0",
        Accept: "application/json",
        "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    const matched =
      profiles.find((p) => typeof p?.arn === "string" && p.arn.includes(`:${r}:`)) ||
      profiles[0];
    return typeof matched?.arn === "string" ? matched.arn : null;
  } catch {
    return null;
  }
}

/**
 * Refresh access token. Supports Builder ID/IDC (clientId+secret) and social import path.
 */
async function refreshAccessToken(refreshToken, providerMeta = {}) {
  if (!refreshToken) throw new Error("Kiro refresh token missing");
  const authMethod = providerMeta.authMethod || providerMeta.auth_method;
  const clientId = providerMeta.clientId;
  const clientSecret = providerMeta.clientSecret;
  const region = creds.resolveRegion(providerMeta);

  // OIDC refresh (Builder ID / IDC) — not for social "imported"
  if (clientId && clientSecret && authMethod !== "imported") {
    const endpoint = `https://oidc.${region}.amazonaws.com/token`;
    let response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken,
        grantType: "refresh_token",
      }),
    });

    if (!response.ok) {
      // Re-register client once (OmniRoute #2524)
      try {
        const reg = await registerClient(region);
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: reg.clientId,
            clientSecret: reg.clientSecret,
            refreshToken,
            grantType: "refresh_token",
          }),
        });
        if (response.ok) {
          const data = await response.json();
          return {
            access_token: data.accessToken,
            refresh_token: data.refreshToken || refreshToken,
            expires_in: data.expiresIn || 3600,
            _newClientId: reg.clientId,
            _newClientSecret: reg.clientSecret,
          };
        }
      } catch {
        /* fall through */
      }
      throw new Error(`Kiro token refresh failed: ${await response.text()}`);
    }

    const data = await response.json();
    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken || refreshToken,
      expires_in: data.expiresIn || 3600,
    };
  }

  // Social / imported refresh
  const response = await fetch(creds.KIRO_CONFIG.socialRefreshUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    throw new Error(`Kiro social token refresh failed: ${await response.text()}`);
  }
  const data = await response.json();
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken || refreshToken,
    expires_in: data.expiresIn || 3600,
    profileArn: data.profileArn,
  };
}

/**
 * Import refresh token (paste). Prefer OIDC client registration + refresh.
 */
async function validateImportToken(refreshToken, region = "us-east-1") {
  const r = creds.assertValidAwsRegion(region);
  const token = String(refreshToken || "").trim();
  if (!token) throw new Error("Refresh token required");

  // Try social refresh first if token doesn't look like Builder ID aorAAAAAG
  const trySocial = async () => {
    const tokens = await refreshAccessToken(token, { authMethod: "imported" });
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || token,
      expiresIn: tokens.expires_in || 3600,
      profileArn: tokens.profileArn || null,
      authMethod: "imported",
      region: r,
    };
  };

  try {
    const reg = await registerClient(r);
    const tokens = await refreshAccessToken(token, {
      clientId: reg.clientId,
      clientSecret: reg.clientSecret,
      authMethod: "builder-id",
      region: r,
    });
    let profileArn = null;
    try {
      profileArn = await discoverProfileArn(tokens.access_token, r);
    } catch {
      /* */
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || token,
      expiresIn: tokens.expires_in || 3600,
      profileArn,
      authMethod: "builder-id",
      clientId: tokens._newClientId || reg.clientId,
      clientSecret: tokens._newClientSecret || reg.clientSecret,
      region: r,
    };
  } catch {
    return trySocial();
  }
}

function toAccountPayload(tokens, extra = {}) {
  const accessToken = tokens.access_token || tokens.accessToken;
  const refreshToken = tokens.refresh_token || tokens.refreshToken;
  const expiresIn = Number(tokens.expires_in || tokens.expiresIn || 3600);
  const region = extra.region || tokens._region || "us-east-1";
  const profileArn = extra.profileArn || tokens.profileArn || null;
  const clientId = extra.clientId || tokens._clientId || tokens.clientId;
  const clientSecret = extra.clientSecret || tokens._clientSecret || tokens.clientSecret;
  const authMethod = extra.authMethod || "builder-id";
  const email =
    nonEmpty(extra.email) ||
    nonEmpty(extra.name) ||
    `kiro-${String(accessToken || "").slice(-8) || crypto.randomBytes(3).toString("hex")}`;

  return {
    providerId: "kiro",
    authType: "oauth",
    name: email,
    email,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    planType: extra.plan || "Kiro",
    workspaceId: profileArn || null,
    baseUrl: creds.runtimeHost(region),
    enabled: true,
    providerMeta: {
      region,
      profileArn: profileArn || undefined,
      clientId: clientId || undefined,
      clientSecret: clientSecret || undefined,
      authMethod,
      source: extra.source || "kiro_oauth",
    },
  };
}

/** Best-effort read of kiro-cli / AWS SSO cache (optional). */
function readLocalKiroAuthFile() {
  const candidates = [
    path.join(os.homedir(), ".aws", "sso", "cache"),
    path.join(os.homedir(), ".kiro", "auth.json"),
    path.join(os.homedir(), ".kiro-cli", "auth.json"),
  ];
  // Only support explicit JSON file with refreshToken if present
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        const refresh =
          raw.refreshToken || raw.refresh_token || raw.claudeAiOauth?.refreshToken;
        const access = raw.accessToken || raw.access_token;
        if (refresh || access) {
          return {
            ok: true,
            path: p,
            refreshToken: refresh,
            accessToken: access,
            expiresAt: raw.expiresAt || raw.expires_at,
            region: raw.region || "us-east-1",
            profileArn: raw.profileArn,
            clientId: raw.clientId,
            clientSecret: raw.clientSecret,
          };
        }
      }
    } catch {
      /* */
    }
  }
  return {
    ok: false,
    error:
      "No local Kiro credentials found. Use Builder ID device login or paste a refresh token.",
  };
}

module.exports = {
  registerClient,
  startDeviceAuthorization,
  pollDeviceToken,
  discoverProfileArn,
  refreshAccessToken,
  validateImportToken,
  toAccountPayload,
  readLocalKiroAuthFile,
};
