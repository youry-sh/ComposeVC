const http = require("http");
const crypto = require("crypto");
const auth = require("./windsurfAuth.cjs");

const sessions = new Map();
const TIMEOUT_MS = 10 * 60 * 1000;

function startSession() {
  const id = `windsurf_oauth_${Date.now().toString(16)}_${crypto.randomBytes(4).toString("hex")}`;
  const state = auth.token();
  const session = { id, providerId: "windsurf", state, status: "starting", authorizeUrl: null, callbackUrl: null, accessToken: null, error: null, result: null, abort: false, server: null, startedAt: Date.now() };
  sessions.set(id, session);
  return id;
}
function getSession(id) { return sessions.get(id) || null; }
function closeServer(session) { if (session.server) { try { session.server.close(); } catch {} session.server = null; } }
function cancelSession(id) { const session = sessions.get(id); if (session) { session.abort = true; closeServer(session); } sessions.delete(id); }
function parseRequest(req) { const url = new URL(req.url || "/", "http://127.0.0.1"); return { path: url.pathname, params: url.searchParams }; }
function callbackHtml(ok, message) { return `<!doctype html><meta charset="utf-8"><title>Windsurf OAuth</title><h2>${ok ? "Authorization complete" : "Authorization failed"}</h2><p>${String(message).replace(/[<>&]/g, "")}</p>`; }
async function listenForCallback(session, host, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const { path, params } = parseRequest(req);
      if (path !== "/windsurf-auth-callback") { res.writeHead(404); res.end("Not found"); return; }
      if (params.get("state") !== session.state) { res.writeHead(400, { "Content-Type": "text/html" }); res.end(callbackHtml(false, "Invalid state")); return; }
      const error = params.get("error");
      if (error) { session.error = params.get("error_description") || error; res.writeHead(400, { "Content-Type": "text/html" }); res.end(callbackHtml(false, session.error)); reject(new Error(session.error)); return; }
      const accessToken = params.get("access_token");
      if (!accessToken) { res.writeHead(400, { "Content-Type": "text/html" }); res.end(callbackHtml(false, "Missing access_token")); reject(new Error("Windsurf callback missing access_token")); return; }
      session.accessToken = accessToken;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(callbackHtml(true, "You can close this window."));
      resolve(accessToken);
    });
    session.server = server;
    server.once("error", reject);
    server.listen(port, host, () => resolve(null));
  });
}
async function runBrowserOauth(sessionId, { openExternal, host = "127.0.0.1", port = 0 } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Windsurf OAuth session not found");
  let callbackPromise;
  try {
    session.status = "starting";
    await new Promise((resolve, reject) => {
      const server = http.createServer();
      session.server = server;
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
    const address = session.server.address();
    const actualPort = typeof address === "object" ? address.port : port;
    session.callbackUrl = `http://${host}:${actualPort}/windsurf-auth-callback`;
    session.authorizeUrl = auth.buildAuthUrl(session.callbackUrl, session.state);
    session.status = "waiting_user";
    closeServer(session);
    callbackPromise = listenForCallback(session, host, actualPort);
    if (typeof openExternal === "function") await Promise.resolve(openExternal(session.authorizeUrl));
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Windsurf OAuth timed out")), TIMEOUT_MS));
    const accessToken = await Promise.race([callbackPromise, timeout]);
    if (session.abort) throw new Error("cancelled");
    session.status = "exchanging";
    session.result = await auth.buildPayloadFromFirebaseToken(accessToken, {});
    session.status = "done";
    return session.result;
  } catch (error) {
    session.status = "error";
    session.error = error.message || String(error);
    throw error;
  } finally { closeServer(session); }
}
function submitCallbackUrl(sessionId, callbackUrl) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Windsurf OAuth session not found");
  const url = new URL(callbackUrl);
  if (url.searchParams.get("state") !== session.state) throw new Error("Invalid OAuth state");
  const token = url.searchParams.get("access_token");
  if (!token) throw new Error("Callback missing access_token");
  session.accessToken = token;
  return true;
}
module.exports = { startSession, getSession, cancelSession, runBrowserOauth, runOAuth: runBrowserOauth, submitCallbackUrl };
