/**
 * OpenAI / Codex OAuth — device-auth flow (as used by Codex CLI & OmniRoute).
 * Runs on the user's machine (auth.openai.com allows this from desktop apps).
 *
 * 1. POST /api/accounts/deviceauth/usercode
 * 2. User opens https://auth.openai.com/codex/device and enters code
 * 3. Poll /api/accounts/deviceauth/token
 * 4. Exchange authorization_code + code_verifier at /oauth/token
 */

const BASE_URL = "https://auth.openai.com";
const API_BASE = `${BASE_URL}/api/accounts`;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const VERIFICATION_URI = `${BASE_URL}/codex/device`;
const REDIRECT_URI = `${BASE_URL}/deviceauth/callback`;
const DEFAULT_INTERVAL_SEC = 5;
const TIMEOUT_MS = 15 * 60 * 1000;

function base64UrlDecode(str) {
  let b64 = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
}

function parseIdToken(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length < 2) return { email: null, authInfo: null };
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return {
      email: payload.email || null,
      authInfo: payload["https://api.openai.com/auth"] || null,
      exp: payload.exp || null,
    };
  } catch {
    return { email: null, authInfo: null, exp: null };
  }
}

function mapAuthMeta(tokens) {
  const { email, authInfo } = parseIdToken(tokens.id_token);
  const planType = String(authInfo?.chatgpt_plan_type || "").toLowerCase() || "unknown";
  let workspaceId = authInfo?.chatgpt_account_id || null;
  const orgs = Array.isArray(authInfo?.organizations) ? authInfo.organizations : [];

  if (orgs.length && (planType === "free" || !planType || planType === "unknown")) {
    const team = orgs.find((o) => !o.is_default);
    if (team?.id) workspaceId = team.id;
  }

  return {
    email,
    planType,
    workspaceId,
    chatgptUserId: authInfo?.chatgpt_user_id || null,
    organizations: orgs,
  };
}

async function requestUserCode(clientId = CLIENT_ID) {
  const res = await fetch(`${API_BASE}/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId }),
  });
  if (res.status === 404) {
    throw new Error(
      "Device login disabled for this account. Enable it in ChatGPT security settings."
    );
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Device code request failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const userCode = data.user_code || data.usercode;
  if (!data.device_auth_id || !userCode) {
    throw new Error("Invalid device code response from OpenAI");
  }
  return {
    deviceAuthId: data.device_auth_id,
    userCode,
    intervalSec:
      typeof data.interval === "number" && data.interval > 0
        ? data.interval
        : DEFAULT_INTERVAL_SEC,
    verificationUri: VERIFICATION_URI,
  };
}

async function pollOnce(deviceAuthId, userCode) {
  const res = await fetch(`${API_BASE}/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });
  if (res.ok) {
    const data = await res.json();
    if (!data.authorization_code || !data.code_verifier) {
      throw new Error("Authorization response incomplete");
    }
    return {
      done: true,
      authorizationCode: data.authorization_code,
      codeVerifier: data.code_verifier,
    };
  }
  if (res.status === 403 || res.status === 404) {
    return { done: false };
  }
  const t = await res.text().catch(() => "");
  throw new Error(`Poll failed (${res.status}): ${t.slice(0, 200)}`);
}

async function exchangeCode(authorizationCode, codeVerifier, clientId = CLIENT_ID) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in token response");
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    id_token: data.id_token || null,
    expires_in: data.expires_in || 3600,
  };
}

async function refreshAccessToken(refreshToken, clientId = CLIENT_ID) {
  const res = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    id_token: data.id_token || null,
    expires_in: data.expires_in || 3600,
  };
}

/** In-flight OAuth sessions (sessionId → state) */
const sessions = new Map();

function startSession() {
  const id = `oauth_${Date.now().toString(16)}_${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(id, {
    id,
    providerId: "openai",
    status: "starting",
    userCode: null,
    verificationUri: VERIFICATION_URI,
    error: null,
    result: null,
    startedAt: Date.now(),
    abort: false,
  });
  return id;
}

function getSession(id) {
  return sessions.get(id) || null;
}

function cancelSession(id) {
  const s = sessions.get(id);
  if (s) s.abort = true;
  sessions.delete(id);
}

/**
 * Run full device flow; updates session; returns account payload on success.
 */
async function runDeviceFlow(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("OAuth session not found");

  try {
    session.status = "usercode";
    const code = await requestUserCode();
    if (session.abort) throw new Error("aborted");
    session.userCode = code.userCode;
    session.deviceAuthId = code.deviceAuthId;
    session.intervalSec = code.intervalSec;
    session.verificationUri = code.verificationUri;
    session.status = "waiting_user";

    if (typeof openExternal === "function") {
      try {
        await openExternal(code.verificationUri);
      } catch {
        /* UI can still open manually */
      }
    }

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (session.abort) throw new Error("aborted");
      await sleep(code.intervalSec * 1000);
      if (session.abort) throw new Error("aborted");
      const poll = await pollOnce(code.deviceAuthId, code.userCode);
      if (!poll.done) continue;

      session.status = "exchanging";
      const tokens = await exchangeCode(poll.authorizationCode, poll.codeVerifier);
      const meta = mapAuthMeta(tokens);
      const account = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
        email: meta.email,
        planType: meta.planType,
        workspaceId: meta.workspaceId,
        chatgptUserId: meta.chatgptUserId,
        organizations: meta.organizations,
      };
      session.result = account;
      session.status = "done";
      return account;
    }
    throw new Error("Authorization timed out (15 min). Start again.");
  } catch (e) {
    session.status = "error";
    session.error = e.message || String(e);
    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  CLIENT_ID,
  VERIFICATION_URI,
  parseIdToken,
  mapAuthMeta,
  requestUserCode,
  pollOnce,
  exchangeCode,
  refreshAccessToken,
  startSession,
  getSession,
  cancelSession,
  runDeviceFlow,
};
