const crypto = require("crypto");
const auth = require("./qoderAuth.cjs");
const sessions = new Map();
function id() { return `qoder_oauth_${Date.now().toString(16)}_${crypto.randomBytes(5).toString("hex")}`; }
function startSession(options = {}) { const sessionId = id(); sessions.set(sessionId, { id: sessionId, providerId: "qoder", status: "starting", result: null, error: null, cancelled: false, startedAt: Date.now(), ...options }); return sessionId; }
function getSession(sessionId) { return sessions.get(sessionId) || null; }
function cancelSession(sessionId) { const session = sessions.get(sessionId); if (session) session.cancelled = true; sessions.delete(sessionId); }
async function runBrowserOauth(sessionId, { openExternal, intervalMs = auth.POLL_INTERVAL_MS, maxPolls = auth.MAX_POLLS, machineId } = {}) { const session = sessions.get(sessionId); if (!session) throw new Error("Qoder OAuth session not found"); try { const started = await auth.startDeviceAuth({ machineId }); Object.assign(session, started, { status: "waiting_user" }); if (typeof openExternal === "function") await Promise.resolve(openExternal(started.authorizeUrl)); const tokens = await auth.pollDeviceAuth(started.nonce, started.codeVerifier, { intervalMs, maxPolls }); if (session.cancelled) throw new Error("cancelled"); session.result = await auth.buildAccountPayload(tokens, { source: "qoder_browser_oauth" }); session.status = "done"; return session.result; } catch (error) { session.status = session.cancelled ? "cancelled" : "error"; session.error = error.message || String(error); throw error; } }
module.exports = { startSession, getSession, cancelSession, runBrowserOauth, runDeviceOauth: runBrowserOauth, buildAuthUrl: auth.buildAuthUrl };
