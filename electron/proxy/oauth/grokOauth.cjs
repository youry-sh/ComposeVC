/**
 * Grok Build / xAI OAuth2 PKCE (browser login — Google / X / email).
 * Same flow as official Grok CLI and pi-xai-oauth:
 *   discovery → authorize → localhost callback → token exchange
 */

const http = require("http");
const crypto = require("crypto");
const { GROK_CLIENT_ID, CLI_PROXY_BASE, parseJwtPayload, toAccountPayload } = require("./grokAuth.cjs");

const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = 56121;
const REDIRECT_PATH = "/callback";

/** @type {Map<string, any>} */
const sessions = new Map();

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function discover() {
  const res = await fetch(DISCOVERY_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`xAI discovery failed: ${res.status}`);
  const data = await res.json();
  if (!data.authorization_endpoint || !data.token_endpoint) {
    throw new Error("xAI discovery missing endpoints");
  }
  return {
    authorization_endpoint: data.authorization_endpoint,
    token_endpoint: data.token_endpoint,
  };
}

function startSession() {
  const id = `grok_oauth_${Date.now().toString(16)}_${crypto.randomBytes(3).toString("hex")}`;
  sessions.set(id, {
    id,
    status: "starting",
    authorizeUrl: null,
    error: null,
    result: null,
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

async function exchangeToken(tokenEndpoint, body) {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${t.slice(0, 240)}`);
  }
  return res.json();
}

/**
 * Full browser OAuth. Opens authorize URL; waits for localhost callback.
 * @returns account payload for store
 */
async function runBrowserOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");

  try {
    session.status = "discovery";
    const discovery = await discover();
    if (session.abort) throw new Error("aborted");

    const { verifier, challenge } = pkcePair();
    const state = crypto.randomUUID().replace(/-/g, "");
    const nonce = crypto.randomUUID().replace(/-/g, "");

    session.status = "waiting_callback";
    const { redirectUri, waitForCode, closeServer } = await listenCallback(state);
    session.closeServer = closeServer;
    session.redirectUri = redirectUri;

    const params = new URLSearchParams({
      response_type: "code",
      client_id: GROK_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    const authorizeUrl = `${discovery.authorization_endpoint}?${params.toString()}`;
    session.authorizeUrl = authorizeUrl;

    if (typeof openExternal === "function") {
      try {
        await openExternal(authorizeUrl);
      } catch {
        /* user can open manually */
      }
    }

    const callback = await waitForCode(180_000);
    if (session.abort) throw new Error("aborted");
    if (callback.error) {
      throw new Error(callback.error_description || callback.error || "authorization failed");
    }
    if (!callback.code) throw new Error("No authorization code");

    session.status = "exchanging";
    const tokens = await exchangeToken(discovery.token_endpoint, {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: redirectUri,
      client_id: GROK_CLIENT_ID,
      code_verifier: verifier,
    });

    if (!tokens.access_token) throw new Error("No access_token");

    const extracted = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt: new Date(
        Date.now() + (Number(tokens.expires_in) || 21600) * 1000
      ).toISOString(),
      meta: { oidcClientId: GROK_CLIENT_ID, source: "browser_oauth" },
      email: null,
    };
    const jwt = parseJwtPayload(tokens.access_token);
    if (jwt.email) extracted.email = jwt.email;
    if (jwt.claims?.team_id) extracted.meta.teamId = jwt.claims.team_id;

    const account = toAccountPayload(extracted);
    session.result = account;
    session.status = "done";
    try {
      closeServer();
    } catch {
      /* */
    }
    return account;
  } catch (e) {
    session.status = "error";
    session.error = e.message || String(e);
    try {
      session.closeServer?.();
    } catch {
      /* */
    }
    throw e;
  }
}

function listenCallback(expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let codeResolve;
    const codePromise = new Promise((r) => {
      codeResolve = r;
    });

    const server = http.createServer((req, res) => {
      const origin = req.headers.origin;
      if (origin === "https://accounts.x.ai" || origin === "https://auth.x.ai") {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${REDIRECT_HOST}`);
      if (url.pathname !== REDIRECT_PATH) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const result = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description: url.searchParams.get("error_description") || undefined,
      };

      if (result.state && result.state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<html><body><h1>State mismatch</h1><p>Close and retry from ComposeVC.</p></body></html>");
        return;
      }

      codeResolve(result);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        result.error
          ? "<html><body><h1>Grok login failed</h1><p>You can close this tab.</p></body></html>"
          : "<html><body><h1>Grok login OK</h1><p>You can close this tab and return to ComposeVC.</p></body></html>"
      );
    });

    const closeServer = () => {
      try {
        server.close();
      } catch {
        /* */
      }
    };

    const tryListen = (port) => {
      server.once("error", (err) => {
        if (port === REDIRECT_PORT) {
          // fallback random port
          server.listen(0, REDIRECT_HOST);
        } else {
          reject(err);
        }
      });
      server.listen(port, REDIRECT_HOST, () => {
        const addr = server.address();
        const p = typeof addr === "object" && addr ? addr.port : port;
        const redirectUri = `http://${REDIRECT_HOST}:${p}${REDIRECT_PATH}`;
        resolve({
          redirectUri,
          closeServer,
          waitForCode: (timeoutMs = 180000) =>
            Promise.race([
              codePromise,
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error("Timed out waiting for Grok OAuth (3 min)")), timeoutMs)
              ),
            ]),
        });
      });
    };

    tryListen(REDIRECT_PORT);
  });
}

module.exports = {
  DISCOVERY_URL,
  SCOPE,
  startSession,
  getSession,
  cancelSession,
  runBrowserOauth,
};
