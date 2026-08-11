/**
 * Antigravity Google OAuth (authorization_code, NO PKCE).
 * OmniRoute pattern: plain client_secret exchange + localhost callback.
 */

const http = require("http");
const crypto = require("crypto");
const creds = require("./antigravityCreds.cjs");
const { enrichWithBackend, toAccountPayload } = require("./antigravityAuth.cjs");

const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 56131;
const REDIRECT_PATH = "/oauth/callback";

/** @type {Map<string, any>} */
const sessions = new Map();

function startSession() {
  const id = `antigravity_oauth_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  sessions.set(id, {
    id,
    providerId: "antigravity",
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
      "User-Agent": creds.antigravityNativeOAuthUserAgent(),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return res.json();
}

/**
 * Full browser OAuth → account payload for store.
 * @param {string} sessionId
 * @param {{ openExternal?: (url: string) => void }} opts
 */
async function runBrowserOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");
  const providerId = "antigravity";

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
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body><h3>OAuth error: ${err}</h3></body></html>`);
            reject(new Error(err));
            return;
          }
          const gotState = u.searchParams.get("state");
          const authCode = u.searchParams.get("code");
          if (gotState !== state) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<html><body><h3>Invalid state</h3></body></html>");
            reject(new Error("Invalid OAuth state"));
            return;
          }
          if (!authCode) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<html><body><h3>Missing code</h3></body></html>");
            reject(new Error("Missing authorization code"));
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            "<html><body style='font-family:system-ui;padding:2rem'><h2>Signed in</h2><p>You can close this window and return to ComposeVC.</p></body></html>"
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
        if (openExternal && session.authorizeUrl) {
          try {
            openExternal(session.authorizeUrl);
          } catch {
            /* */
          }
        }
      });

      server.on("error", (e) => reject(e));

      const timer = setTimeout(() => {
        reject(new Error("OAuth timeout (5 min)"));
      }, 5 * 60 * 1000);

      const cleanup = () => {
        clearTimeout(timer);
        session.closeServer?.();
      };
      const origResolve = resolve;
      const origReject = reject;
      resolve = (v) => {
        cleanup();
        origResolve(v);
      };
      reject = (e) => {
        cleanup();
        origReject(e);
      };
    });

    if (session.abort) throw new Error("aborted");
    session.status = "exchanging";

    const tokens = await exchangeCode(code, redirectUri);
    if (!tokens.access_token) throw new Error("No access_token from Google");

    session.status = "enriching";
    const extra = await enrichWithBackend(tokens.access_token);

    const payload = toAccountPayload(
      providerId,
      {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_in: tokens.expires_in,
      },
      {
        ...extra,
        source: "antigravity_browser",
      }
    );

    session.status = "done";
    session.result = { email: payload.email };
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
  buildAuthUrl,
};
