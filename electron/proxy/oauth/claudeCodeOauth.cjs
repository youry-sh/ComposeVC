/**
 * Claude Code OAuth session — PKCE browser login with paste-back code.
 * Anthropic redirect is fixed (platform.claude.com); user pastes code#state.
 */

const creds = require("./claudeCodeCreds.cjs");
const {
  generatePKCE,
  buildAuthUrl,
  exchangeCode,
  enrichWithBackend,
  toAccountPayload,
} = require("./claudeCodeAuth.cjs");

/** @type {Map<string, any>} */
const sessions = new Map();

function startSession() {
  const id = `claude_code_oauth_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`;
  const pkce = generatePKCE();
  const authorizeUrl = buildAuthUrl({
    codeChallenge: pkce.codeChallenge,
    state: pkce.state,
  });
  sessions.set(id, {
    id,
    providerId: "claude-code",
    status: "waiting_code",
    authorizeUrl,
    redirectUri: creds.REDIRECT_URI,
    codeVerifier: pkce.codeVerifier,
    state: pkce.state,
    error: null,
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
 * Open browser authorize URL; UI collects pasted code separately via completeSession.
 */
async function runBrowserOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");
  try {
    session.status = "waiting_code";
    if (typeof openExternal === "function" && session.authorizeUrl) {
      openExternal(session.authorizeUrl);
    }
    // Wait until completeSession or cancel
    const started = Date.now();
    const TIMEOUT_MS = 15 * 60 * 1000;
    while (!session.abort && !session.accountPayload && !session.error) {
      if (Date.now() - started > TIMEOUT_MS) {
        throw new Error("Claude OAuth timed out waiting for authorization code");
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (session.abort) throw new Error("cancelled");
    if (session.error) throw new Error(session.error);
    if (!session.accountPayload) throw new Error("no account payload");
    session.status = "done";
    return session.accountPayload;
  } catch (e) {
    session.status = "error";
    session.error = e.message || String(e);
    throw e;
  }
}

/**
 * User pastes `code` or `code#state` from Anthropic callback page.
 */
async function completeSession(sessionId, pastedCode) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");
  if (session.abort) throw new Error("cancelled");
  if (!pastedCode || !String(pastedCode).trim()) {
    throw new Error("Paste the authorization code from the browser (code#state)");
  }
  session.status = "exchanging";
  try {
    const tokens = await exchangeCode({
      code: pastedCode,
      codeVerifier: session.codeVerifier,
      state: session.state,
    });
    let enr = {};
    try {
      enr = await enrichWithBackend(tokens.access_token, tokens);
    } catch {
      /* */
    }
    const payload = toAccountPayload(tokens, {
      ...enr,
      source: "claude_code_oauth",
    });
    session.accountPayload = payload;
    session.status = "done";
    return payload;
  } catch (e) {
    session.status = "error";
    session.error = e.message || String(e);
    throw e;
  }
}

module.exports = {
  startSession,
  getSession,
  cancelSession,
  runBrowserOauth,
  completeSession,
  REDIRECT_URI: creds.REDIRECT_URI,
};
