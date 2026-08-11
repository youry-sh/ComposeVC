/**
 * Kiro OAuth session — AWS Builder ID device-code flow.
 */

const {
  registerClient,
  startDeviceAuthorization,
  pollDeviceToken,
  discoverProfileArn,
  toAccountPayload,
} = require("./kiroAuth.cjs");
const creds = require("./kiroCreds.cjs");

/** @type {Map<string, any>} */
const sessions = new Map();

function startSession(opts = {}) {
  const id = `kiro_oauth_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 8)}`;
  const region = String(opts.region || "us-east-1").toLowerCase();
  const startUrl = opts.startUrl || creds.KIRO_CONFIG.startUrl;
  sessions.set(id, {
    id,
    providerId: "kiro",
    status: "starting",
    region,
    startUrl,
    userCode: null,
    verificationUri: null,
    verificationUriComplete: null,
    authorizeUrl: null,
    error: null,
    abort: false,
    accountPayload: null,
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
 * Run device-code OAuth: register client → device auth → open browser → poll.
 */
async function runDeviceOauth(sessionId, { openExternal } = {}) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("session not found");

  try {
    session.status = "registering";
    const client = await registerClient(session.region);
    session.clientId = client.clientId;
    session.clientSecret = client.clientSecret;

    session.status = "device_auth";
    const device = await startDeviceAuthorization(
      client.clientId,
      client.clientSecret,
      session.startUrl,
      session.region
    );
    session.userCode = device.userCode;
    session.verificationUri = device.verificationUri;
    session.verificationUriComplete = device.verificationUriComplete;
    session.authorizeUrl = device.verificationUriComplete || device.verificationUri;
    session.deviceCode = device.deviceCode;
    session.interval = Math.max(2, Number(device.interval) || 5);
    session.expiresAt = Date.now() + (Number(device.expiresIn) || 600) * 1000;
    session.status = "waiting_user";

    if (typeof openExternal === "function" && session.authorizeUrl) {
      try {
        openExternal(session.authorizeUrl);
      } catch {
        /* */
      }
    }

    // Poll until authorized
    while (!session.abort) {
      if (Date.now() > session.expiresAt) {
        throw new Error("Kiro device authorization expired");
      }
      await new Promise((r) => setTimeout(r, session.interval * 1000));
      if (session.abort) throw new Error("cancelled");

      const polled = await pollDeviceToken(
        client.clientId,
        client.clientSecret,
        session.deviceCode,
        session.region
      );
      if (polled.pending) {
        if (polled.error === "slow_down") session.interval = Math.min(30, session.interval + 2);
        continue;
      }
      if (!polled.ok) {
        throw new Error(polled.errorDescription || polled.error || "device auth failed");
      }

      session.status = "exchanging";
      let profileArn = null;
      try {
        profileArn = await discoverProfileArn(polled.tokens.access_token, session.region);
      } catch {
        /* */
      }

      const payload = toAccountPayload(polled.tokens, {
        region: session.region,
        profileArn,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authMethod: "builder-id",
        source: "kiro_device_oauth",
        email: `kiro-builder-${String(device.userCode || "").replace(/[^A-Z0-9]/gi, "").slice(0, 8) || "acc"}`,
      });
      session.accountPayload = payload;
      session.status = "done";
      return payload;
    }
    throw new Error("cancelled");
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
  runDeviceOauth,
};
