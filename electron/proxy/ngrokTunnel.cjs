/**
 * ngrok public tunnel for the local ComposeVC proxy.
 * Starts/stops with the proxy lifecycle when enabled in store.
 */

let listener = null;
let lastError = null;
let lastUrl = null;
let starting = null;

function emit(serverApi, entry) {
  try {
    if (serverApi && typeof serverApi.emitLog === "function") {
      serverApi.emitLog(entry);
    }
  } catch {
    /* */
  }
}

function publicBaseFromUrl(url) {
  if (!url) return null;
  const base = String(url).replace(/\/+$/, "");
  return `${base}/v1`;
}

function status() {
  return {
    running: Boolean(listener && lastUrl),
    url: lastUrl || null,
    publicBaseUrl: publicBaseFromUrl(lastUrl),
    error: lastError,
  };
}

async function stop(serverApi) {
  if (starting) {
    try {
      await starting;
    } catch {
      /* */
    }
  }
  starting = null;

  const prev = listener;
  listener = null;
  const url = lastUrl;
  lastUrl = null;
  lastError = null;

  if (!prev && !url) return status();

  try {
    if (prev && typeof prev.close === "function") {
      await prev.close();
    }
  } catch {
    /* */
  }

  try {
    const ngrok = require("@ngrok/ngrok");
    if (url) {
      try {
        await ngrok.disconnect(url);
      } catch {
        /* */
      }
    }
    try {
      await ngrok.disconnect();
    } catch {
      /* */
    }
  } catch {
    /* module missing or already closed */
  }

  emit(serverApi, { level: "info", msg: "ngrok tunnel stopped" });
  return status();
}

/**
 * @param {{ host: string, port: number, authtoken: string, domain?: string, region?: string }} opts
 * @param {*} serverApi
 */
async function start(opts, serverApi) {
  if (starting) return starting;

  starting = (async () => {
    const host = String(opts.host || "127.0.0.1").trim() || "127.0.0.1";
    const port = Number(opts.port) || 8787;
    const authtoken = String(opts.authtoken || "").trim();
    const domain = String(opts.domain || "").trim();
    const region = String(opts.region || "").trim();

    if (!authtoken) {
      lastError = "ngrok authtoken is empty";
      emit(serverApi, { level: "error", msg: lastError });
      throw new Error(lastError);
    }

    // Restart cleanly if already open
    if (listener || lastUrl) {
      await stop(serverApi);
    }

    let ngrok;
    try {
      ngrok = require("@ngrok/ngrok");
    } catch (e) {
      lastError = `@ngrok/ngrok not installed: ${e.message || e}`;
      emit(serverApi, { level: "error", msg: lastError });
      throw new Error(lastError);
    }

    const addr =
      host === "0.0.0.0" || host === "::" || host === "[::]"
        ? port
        : `${host}:${port}`;

    const forwardOpts = {
      addr,
      authtoken,
      // API clients hit /v1/* — no browser interstitial helpers needed here
    };
    if (domain) forwardOpts.domain = domain;
    if (region) forwardOpts.region = region;

    emit(serverApi, {
      level: "info",
      msg: `ngrok starting → ${typeof addr === "number" ? `localhost:${addr}` : addr}${domain ? ` (${domain})` : ""}`,
    });

    try {
      listener = await ngrok.forward(forwardOpts);
      lastUrl = typeof listener.url === "function" ? listener.url() : listener.url || null;
      lastError = null;
      if (!lastUrl) {
        throw new Error("ngrok returned no public URL");
      }
      emit(serverApi, {
        level: "info",
        msg: `ngrok tunnel online: ${publicBaseFromUrl(lastUrl)}`,
      });
      return status();
    } catch (e) {
      listener = null;
      lastUrl = null;
      lastError = e?.message || String(e);
      emit(serverApi, { level: "error", msg: `ngrok failed: ${lastError}` });
      throw new Error(lastError);
    }
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * Start tunnel from proxy store if enabled + token present.
 * Non-throwing for lifecycle hooks — errors land in status/logs.
 */
async function startFromStore(store, serverApi) {
  const cfg = store?.ngrok || {};
  if (!cfg.enabled) {
    await stop(serverApi);
    return { ...status(), skipped: true };
  }
  if (!String(cfg.authtoken || "").trim()) {
    lastError = "ngrok enabled but authtoken is empty";
    emit(serverApi, { level: "error", msg: lastError });
    return { ...status(), skipped: true };
  }
  try {
    return await start(
      {
        host: store.host,
        port: store.port,
        authtoken: cfg.authtoken,
        domain: cfg.domain,
        region: cfg.region,
      },
      serverApi
    );
  } catch (e) {
    return { ...status(), error: e.message || String(e) };
  }
}

module.exports = {
  start,
  stop,
  status,
  startFromStore,
  publicBaseFromUrl,
};
