const http = require("http");
const crypto = require("crypto");
const auth = require("./githubCopilotAuth.cjs");

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const CLIENT_ID = "01ab8ac9400c4e429b23";
const CLIENT_SECRET = "2af589bb2ffd03a29cc0df83f767e3f6693f14cd";
const REDIRECT_URI = "https://vscode.dev/redirect";
const SCOPE = "read:user repo user:email workflow";
const sessions = new Map();

function startSession() {
  const id = `github_copilot_oauth_${Date.now().toString(16)}_${crypto.randomBytes(8).toString("hex")}`;
  sessions.set(id, { id, providerId: "github-copilot", status: "starting", authorizeUrl: null, redirectUri: null, error: null, result: null, abort: false });
  return id;
}

function getSession(id) { return sessions.get(id) || null; }

function cancelSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.abort = true;
    try { session.closeServer?.(); } catch {}
  }
  sessions.delete(id);
}

function challenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function buildAuthUrl(redirectUri, state, verifier) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
    get_started_with: "copilot-vscode",
    prompt: "select_account",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function exchangeCode(code, verifier) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "antigravity-cockpit-tools" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: REDIRECT_URI, code_verifier: verifier }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text();
  let data = {};
  try { data = body ? JSON.parse(body) : {}; } catch { data = { error_description: body.slice(0, 300) }; }
  if (!response.ok || data.error) throw new Error(`GitHub OAuth token exchange failed (${response.status}): ${data.error_description || data.error || body.slice(0, 240)}`);
  if (!data.access_token) throw new Error("GitHub OAuth response did not include access_token");
  return data;
}

function callbackPage(ok, message) {
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  return `<html><body style="font-family:system-ui;padding:2rem"><h2>${ok ? "GitHub Copilot authorized" : "Authorization failed"}</h2><p>${safe}</p><p>You can close this window.</p></body></html>`;
}

function receiveCallback(session, timeoutMs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url || "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") { response.writeHead(404); response.end("Not found"); return; }
        if (url.searchParams.get("state") !== session.state) { response.writeHead(400); response.end(callbackPage(false, "Invalid OAuth state")); return reject(new Error("Invalid OAuth state")); }
        const error = url.searchParams.get("error");
        if (error) { const detail = url.searchParams.get("error_description") || error; response.writeHead(400, { "Content-Type": "text/html" }); response.end(callbackPage(false, detail)); return reject(new Error(`GitHub authorization failed: ${detail}`)); }
        const code = url.searchParams.get("code");
        if (!code) { response.writeHead(400); response.end(callbackPage(false, "Missing authorization code")); return reject(new Error("Missing authorization code")); }
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(callbackPage(true, "GitHub Copilot authorization completed.")); resolve(code);
      } catch (error) { reject(error); }
    });
    session.closeServer = () => { try { server.close(); } catch {} };
    const timer = setTimeout(() => reject(new Error("GitHub OAuth timeout (5 min)")), timeoutMs);
    const cleanup = () => { clearTimeout(timer); session.closeServer?.(); };
    const originalResolve = resolve;
    const originalReject = reject;
    resolve = (value) => { cleanup(); originalResolve(value); };
    reject = (error) => { cleanup(); originalReject(error); };
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      session.redirectUri = `http://127.0.0.1:${address.port}/callback`;
      session.authorizeUrl = buildAuthUrl(session.redirectUri, session.state, session.verifier);
      session.status = "waiting_callback";
    });
  });
}

async function runBrowserOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("GitHub Copilot OAuth session not found");
  session.verifier = crypto.randomBytes(48).toString("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  session.state = state;
  try {
    const codePromise = receiveCallback(session, 5 * 60 * 1000);
    while (!session.authorizeUrl && !session.error) await new Promise((resolve) => setTimeout(resolve, 10));
    if (session.abort) throw new Error("aborted");
    if (typeof openExternal === "function") await Promise.resolve(openExternal(session.authorizeUrl));
    const code = await codePromise;
    if (session.abort) throw new Error("aborted");
    session.status = "exchanging";
    const tokens = await exchangeCode(code, session.verifier);
    session.status = "enriching";
    const payload = await auth.buildAccountPayload(tokens, {});
    session.result = payload;
    session.status = "done";
    return payload;
  } catch (error) {
    session.status = "error";
    session.error = error.message || String(error);
    throw error;
  } finally {
    try { session.closeServer?.(); } catch {}
  }
}

module.exports = { startSession, getSession, cancelSession, runBrowserOauth, buildAuthUrl, exchangeCode };
