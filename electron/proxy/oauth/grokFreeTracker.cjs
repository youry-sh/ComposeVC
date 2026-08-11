/**
 * Runtime tracker for Grok free-tier rolling 24h limits.
 *
 * Keeps one state per account id in memory (hot path — no disk I/O per request)
 * and persists debounced into account.providerMeta.freeLimit so the daily window
 * survives app restarts.
 */

const freeLimit = require("./grokFreeLimit.cjs");

const runtime = new Map();
const pendingPersist = new Set();
let persistTimer = null;
let persistPath = null;

function isGrokOauthAccount(account) {
  return Boolean(
    account &&
      account.providerId === "grok" &&
      (account.authType === "oauth" || (account.accessToken && !account.apiKey))
  );
}

function hydrate(account) {
  if (!account || !account.id) return null;
  if (runtime.has(account.id)) return runtime.get(account.id);
  const stored = account.providerMeta && account.providerMeta.freeLimit;
  const state = freeLimit.clearIfWindowPassed(
    stored && typeof stored === "object" ? stored : { samples: [] }
  );
  runtime.set(account.id, state);
  return state;
}

function getState(accountId) {
  if (!accountId) return null;
  const state = runtime.get(accountId);
  if (!state) return null;
  return freeLimit.clearIfWindowPassed(state);
}

function setState(accountId, state) {
  if (!accountId || !state) return null;
  runtime.set(accountId, state);
  schedulePersist(accountId);
  return state;
}

function schedulePersist(accountId) {
  if (!accountId || !persistPath) return;
  pendingPersist.add(accountId);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const ids = [...pendingPersist];
    pendingPersist.clear();
    void flush(ids);
  }, 1500);
  if (typeof persistTimer.unref === "function") persistTimer.unref();
}

async function flush(ids) {
  if (!persistPath || !ids.length) return;
  let storeApi;
  try {
    storeApi = require("../store.cjs");
  } catch {
    return;
  }
  for (const id of ids) {
    const state = runtime.get(id);
    if (!state) continue;
    try {
      const store = await storeApi.load(persistPath);
      const acc = (store.accounts || []).find((a) => a.id === id);
      if (!acc) continue;
      await storeApi.mergeAccount(persistPath, id, {
        providerMeta: { ...(acc.providerMeta || {}), freeLimit: state },
      });
    } catch {
      /* persist is best-effort */
    }
  }
}

function setUserDataPath(ud) {
  if (ud) persistPath = ud;
}

/** Add tokens consumed by one completed request. */
function recordTokens(account, tokens) {
  if (!isGrokOauthAccount(account)) return null;
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  const prev = hydrate(account) || { samples: [] };
  const next = freeLimit.addTokens(freeLimit.clearIfWindowPassed(prev), n);
  return setState(account.id, next);
}

/** Apply an authoritative free-usage 429 payload from the CLI proxy. */
function recordExhausted(account, body) {
  if (!isGrokOauthAccount(account)) return null;
  const prev = hydrate(account) || { samples: [] };
  const applied = freeLimit.applyExhausted(prev, body);
  if (!applied) return null;
  setState(account.id, applied.state);
  return applied;
}

/** Merge the daily window into a usage snapshot ({plan,quotas,detail}). */
function decorateUsage(account, usage) {
  if (!isGrokOauthAccount(account)) return usage;
  const state = hydrate(account);
  const fresh = freeLimit.clearIfWindowPassed(state || { samples: [] });
  if (fresh !== state) setState(account.id, fresh);

  const quota = freeLimit.toQuota(fresh);
  if (!quota) return usage;

  const base = usage && typeof usage === "object" ? usage : { plan: null, quotas: {} };
  const quotas = { ...(base.quotas || {}) };
  quotas.daily = quota;
  if (!quotas.session) quotas.session = quota;

  return {
    ...base,
    limitReached: Boolean(base.limitReached) || freeLimit.isExhausted(fresh),
    quotas,
    detail: {
      ...(base.detail || {}),
      freeDailyUsed: quota.used,
      freeDailyLimit: quota.total,
      freeDailyResetAt: quota.resetAt,
      freeModel: fresh && fresh.model ? fresh.model : null,
    },
  };
}

function clear(accountId) {
  if (!accountId) return;
  runtime.delete(accountId);
  pendingPersist.delete(accountId);
}

function clearAll() {
  runtime.clear();
  pendingPersist.clear();
}

module.exports = {
  setUserDataPath,
  isGrokOauthAccount,
  hydrate,
  getState,
  recordTokens,
  recordExhausted,
  decorateUsage,
  clear,
  clearAll,
};
