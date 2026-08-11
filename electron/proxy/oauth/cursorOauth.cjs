const crypto = require("crypto");
const auth = require("./cursorAuth.cjs");

const sessions = new Map();

function startSession() {
  const id = `cursor_oauth_${Date.now().toString(16)}_${crypto.randomBytes(4).toString("hex")}`;
  const { codeVerifier, codeChallenge } = auth.generatePKCE();
  const uuid = auth.generateUuid();
  const session = { id, providerId: "cursor", status: "starting", uuid, codeVerifier, codeChallenge, authorizeUrl: auth.buildAuthUrl({ codeChallenge, uuid }), error: null, result: null, abort: false, startedAt: Date.now() };
  sessions.set(id, session);
  return id;
}

function getSession(id) { return sessions.get(id) || null; }

function cancelSession(id) {
  const session = sessions.get(id);
  if (session) session.abort = true;
  sessions.delete(id);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runBrowserOauth(sessionId, { openExternal, intervalMs = auth.POLL_INTERVAL_MS, maxPolls = auth.MAX_POLLS } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Cursor OAuth session not found");
  try {
    session.status = "waiting_user";
    if (typeof openExternal === "function") await Promise.resolve(openExternal(session.authorizeUrl));
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (session.abort) throw new Error("cancelled");
      session.attempt = attempt + 1;
      const result = await auth.pollCursor(session.uuid, session.codeVerifier);
      if (result.pending) { await sleep(intervalMs); continue; }
      session.status = "done";
      session.result = auth.toAccountPayload(result.tokens, { authId: result.tokens.auth_id, source: "cursor_browser_oauth" });
      return session.result;
    }
    throw new Error("Cursor OAuth timed out");
  } catch (error) {
    session.status = "error";
    session.error = error.message || String(error);
    throw error;
  }
}

module.exports = { startSession, getSession, cancelSession, runBrowserOauth, runDeviceOauth: runBrowserOauth, buildAuthUrl: auth.buildAuthUrl };
