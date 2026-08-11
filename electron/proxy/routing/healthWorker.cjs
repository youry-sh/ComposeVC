/**
 * Background health-check worker.
 *
 * Periodically checks all accounts in parallel and feeds live status to accountRouter.
 * The router then only picks accounts marked alive — no wasted requests on dead keys.
 *
 * - Runs every 60s (configurable)
 * - Parallel with concurrency cap (default 20) to avoid hammering provider APIs
 * - Calls provider usage APIs directly (no store load/save per account)
 * - On quota-exhausted → accountRouter marks blocked (10 min)
 * - On token expired/auth → marks blocked longer
 * - On success → marks ok, available for routing
 */

const storeApi = require("../store.cjs");
const accountRouter = require("./accountRouter.cjs");

let _timer = null;
let _running = false;
let _lastRunAt = 0;

/**
 * Check a single account by calling its provider usage API directly.
 * Does NOT load/save the store — only updates accountRouter runtime state.
 * Returns { id, alive, error? }
 */
async function checkOne(account, userDataPath) {
  if (!account || account.enabled === false) return { id: account?.id, alive: false, skipped: true };
  if (!account.accessToken && !account.apiKey) return { id: account.id, alive: false, skipped: true };

  try {
    let result = null;
    let acc = account;

    if (acc.authType === "oauth" && userDataPath && acc.refreshToken) {
      try {
        const { ensureFreshToken } = require("../accounts.cjs");
        const force = /token expired|re-authenticate|token refresh failed/i.test(
          String(acc.usageError || "")
        );
        acc = await ensureFreshToken(userDataPath, { ...acc }, { force });
      } catch {
      }
    }

    if (acc.authType === "oauth" && acc.providerId === "openai") {
      const codexUsage = require("../oauth/codexUsage.cjs");
      result = await codexUsage.fetchCodexUsage({
        accessToken: acc.accessToken,
        workspaceId: acc.workspaceId,
      });
    } else if (acc.authType === "oauth" && acc.providerId === "grok") {
      const grokUsage = require("../oauth/grokUsage.cjs");
      result = await grokUsage.fetchGrokUsage({ accessToken: acc.accessToken });
      if (!result.ok && result.expired && acc.refreshToken && userDataPath) {
        try {
          const { ensureFreshToken } = require("../accounts.cjs");
          acc = await ensureFreshToken(userDataPath, { ...acc }, { force: true });
          result = await grokUsage.fetchGrokUsage({ accessToken: acc.accessToken });
        } catch {
        }
      }
    } else if (acc.authType === "oauth" && acc.providerId === "antigravity") {
      const antigravityUsage = require("../oauth/antigravityUsage.cjs");
      result = await antigravityUsage.fetchAntigravityUsage({
        accessToken: acc.accessToken,
        projectId: acc.providerMeta?.projectId || acc.workspaceId,
      });
    } else if (acc.authType === "oauth" && acc.providerId === "claude-code") {
      const claudeCodeUsage = require("../oauth/claudeCodeUsage.cjs");
      result = await claudeCodeUsage.fetchClaudeCodeUsage({ accessToken: acc.accessToken });
    } else if (acc.authType === "oauth" && acc.providerId === "gemini-cli") {
      const geminiCliUsage = require("../oauth/geminiCliUsage.cjs");
      result = await geminiCliUsage.fetchGeminiCliUsage({
        accessToken: acc.accessToken,
        projectId: acc.providerMeta?.projectId || acc.workspaceId,
        email: acc.email,
      });
    } else {
      return { id: acc.id, alive: true, skipped: true };
    }

    if (!result || !result.ok) {
      if (result?.expired) {
        accountRouter.markLimited(acc.id, {
          kind: "auth",
          message: result?.error,
          resetAfterSec: 10 * 60,
        });
      }
      return { id: acc.id, alive: false, error: result?.error };
    }

    accountRouter.syncFromUsage(acc.id, result.usage);
    const status = accountRouter.getStatus(acc.id);
    return {
      id: acc.id,
      alive: status.available !== false,
      status: status.status,
    };
  } catch (e) {
    return { id: account.id, alive: false, error: e.message };
  }
}

/**
 * Run one health-check pass over all accounts.
 * @param {string} userDataPath
 * @param {{ concurrency?: number, onLog?: Function }} opts
 */
async function runHealthCheck(userDataPath, opts = {}) {
  if (_running) return;
  _running = true;
  _lastRunAt = Date.now();

  const concurrency = Math.max(1, Math.min(50, opts.concurrency || 20));
  const onLog = opts.onLog;

  try {
    const store = await storeApi.load(userDataPath);
    const accounts = (store.accounts || []).filter(
      (a) => a.enabled !== false && (a.accessToken || a.apiKey)
    );

    if (!accounts.length) {
      _running = false;
      return;
    }

    let alive = 0;
    let dead = 0;
    let checked = 0;

    // Process in batches of `concurrency`
    for (let i = 0; i < accounts.length; i += concurrency) {
      const batch = accounts.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((acc) => checkOne(acc, userDataPath))
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          checked++;
          if (r.value?.alive) alive++;
          else dead++;
        } else {
          dead++;
        }
      }
    }

    onLog?.({
      level: "info",
      msg: `health-check: ${alive} alive, ${dead} dead, ${checked} checked`,
    });
  } catch {
    /* ignore */
  } finally {
    _running = false;
  }
}

/**
 * Start the background health-check loop.
 * @param {() => string} getUserDataPath
 * @param {number} intervalMs - default 60s
 * @param {{ onLog?: Function }} opts
 * @returns {() => void} stop function
 */
function startHealthWorker(getUserDataPath, intervalMs = 60 * 1000, opts = {}) {
  if (_timer) return () => {}; // already running

  const tick = () => {
    const ud = getUserDataPath();
    if (ud) runHealthCheck(ud, opts);
  };

  // First check after 5s, then every intervalMs
  setTimeout(tick, 5000);
  _timer = setInterval(tick, intervalMs);
  if (typeof _timer.unref === "function") _timer.unref();

  return () => {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
  };
}

function stopHealthWorker() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function isRunning() {
  return _running;
}

function lastRunAt() {
  return _lastRunAt;
}

module.exports = {
  startHealthWorker,
  stopHealthWorker,
  runHealthCheck,
  isRunning,
  lastRunAt,
};
