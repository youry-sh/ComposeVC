const crypto = require("crypto");
const auth = require("./qauthAuth.cjs");
const sessions = new Map();
function id() { return `qauth_oauth_${Date.now().toString(16)}_${crypto.randomBytes(5).toString("hex")}`; }
function startSession(options = {}) { const sessionId = id(); sessions.set(sessionId, { id: sessionId, providerId: "qauth", status: "starting", result: null, error: null, cancelled: false, startedAt: Date.now(), ...options }); return sessionId; }
function getSession(sessionId) { return sessions.get(sessionId) || null; }
function cancelSession(sessionId) { const session = sessions.get(sessionId); if (session) session.cancelled = true; sessions.delete(sessionId); }
async function runBrowserOauth(sessionId, { openExternal, requestTimeoutMs } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Cline OAuth session not found");
  try {
    const started = await auth.startDeviceAuth({ requestTimeoutMs });
    Object.assign(session, started, {
      status: "waiting_user",
      authorizeUrl: started.verificationUriComplete || started.verificationUri,
      verificationUri: started.verificationUri,
    });
    if (typeof openExternal === "function") await Promise.resolve(openExternal(session.authorizeUrl));
    const tokens = await auth.pollDeviceAuth(started.deviceCode, { ...started, requestTimeoutMs });
    if (session.cancelled) throw new Error("cancelled");
    session.result = await auth.buildAccountPayload(tokens, { source: "qauth_browser_oauth" });
    session.status = "done";
    return session.result;
  } catch (error) {
    session.status = session.cancelled ? "cancelled" : "error";
    session.error = error.message || String(error);
    throw error;
  }
}
module.exports = { startSession, getSession, cancelSession, runBrowserOauth, runDeviceOauth: runBrowserOauth, buildAuthUrl: auth.startDeviceAuth };
