/**
 * Gemini CLI browser OAuth (Google) — localhost callback.
 */

const http = require("http");
const crypto = require("crypto");
const creds = require("./geminiCliCreds.cjs");
const { enrichWithBackend, toAccountPayload } = require("./geminiCliAuth.cjs");

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 56141;
const REDIRECT_PATH = "/oauth/callback";

/** @type {Map<string, any>} */
const sessions = new Map();

function startSession() {
  const id = `gemini_cli_oauth_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  sessions.set(id, {
    id,
    providerId: "gemini-cli",
    status: "starting",
    authorizeUrl: null,
    redirectUri: null,
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
  if (s) {
    s.abort = true;
    try {
      s.closeServer?.();
    } catch {
      /* */
    }
  }
  sessions.delete(id);
}

function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: creds.CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: creds.SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${creds.AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: creds.CLIENT_ID,
    client_secret: creds.CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": creds.geminiCliUserAgent(),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return res.json();
}

async function runBrowserOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");

  try {
    session.status = "waiting_callback";
    const state = crypto.randomUUID().replace(/-/g, "");
    const redirectUri = `http://${REDIRECT_HOST}:${REDIRECT_PORT}${REDIRECT_PATH}`;
    session.redirectUri = redirectUri;
    session.authorizeUrl = buildAuthUrl(redirectUri, state);

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const u = new URL(req.url || "/", `http://${REDIRECT_HOST}`);
          if (u.pathname !== REDIRECT_PATH) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }
          const err = u.searchParams.get("error");
          if (err) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<html><body><h3>OAuth error: ${err}</h3></body></html>`);
            reject(new Error(err));
            return;
          }
          const gotState = u.searchParams.get("state");
          const authCode = u.searchParams.get("code");
          if (gotState !== state || !authCode) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body><h3>Invalid OAuth callback</h3></body></html>");
            reject(new Error("invalid oauth callback"));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body><h3>Gemini CLI connected</h3><p>You can close this window.</p></body></html>"
          );
          resolve(authCode);
        } catch (e) {
          reject(e);
        }
      });
      session.closeServer = () => {
        try {
          server.close();
        } catch {
          /* */
        }
      };
      server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
        try {
          openExternal?.(session.authorizeUrl);
        } catch {
          /* */
        }
      });
      server.on("error", (e) => reject(e));
      const timer = setTimeout(() => {
        reject(new Error("OAuth timed out (5 min)"));
      }, 5 * 60 * 1000);
      const origResolve = resolve;
      const origReject = reject;
      resolve = (v) => {
        clearTimeout(timer);
        session.closeServer?.();
        origResolve(v);
      };
      reject = (e) => {
        clearTimeout(timer);
        session.closeServer?.();
        origReject(e);
      };
    });

    if (session.abort) throw new Error("aborted");
    session.status = "exchanging";
    const tokens = await exchangeCode(code, redirectUri);
    // Optional: caller can attach sibling accounts via session.accounts for project reuse
    const enr = await enrichWithBackend(tokens.access_token, {
      accounts: session.accounts || [],
      preferredProjectId: session.preferredProjectId || null,
    });
    const payload = toAccountPayload(tokens, {
      ...enr,
      source: "gemini_cli_browser",
    });
    session.status = "done";
    session.result = payload;
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
};
