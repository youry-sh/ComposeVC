/**
 * Smart multi-account router (provider-agnostic module).
 *
 * Policy:
 *  1. API keys (authType=apikey): sticky — keep using the last successful key until it
 *     is rate/quota/auth blocked or disabled. Failover walks remaining keys in stable
 *     priority/createdAt order (no LRU skip, no round-robin jump).
 *  2. OAuth accounts: priority, then least in-flight, then LRU; model-scoped cursor
 *     spreads load across accounts under parallel clients.
 *  3. Soft lease (inFlightCount) does NOT exclusive-lock; only rate/quota/auth blocks.
 *  4. On rate_limit / quota → mark blockedUntil (max 10 min); next request picks next available.
 *  5. When blockedUntil elapses (or usage refresh says ok) → account returns to pool.
 *
 * State is in-memory + mirrored onto account.routing for persistence across restarts.
 */

const { fromUsageSnapshot, classifyUpstreamError } = require("./limitDetect.cjs");

/** Max time any account stays out of rotation (quota / rate / auth / etc.). */
const MAX_BLOCK_MS = 10 * 60 * 1000;

/**
 * Soft per-account parallel cap. Beyond this, account is still "available" for
 * failover but pickNext prefers less-loaded keys so 20+ client requests spread
 * across the pool instead of stampeding one sticky key.
 */
const DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT = 6;

/** @type {Map<string, AccountRuntimeState>} */
const runtime = new Map();
const cursors = new Map();

function capBlockUntil(until, now = Date.now()) {
  const t = Number(until);
  if (!Number.isFinite(t) || t <= now) return now + MAX_BLOCK_MS;
  return Math.min(t, now + MAX_BLOCK_MS);
}

/**
 * @typedef {object} AccountRuntimeState
 * @property {string} status  ok|rate_limited|quota|auth|error
 * @property {number|null} blockedUntil
 * @property {string|null} lastError
 * @property {number} lastUsedAt
 * @property {number} lastSuccessAt
 * @property {number} failStreak
 */

function getRuntime(accountId) {
  if (!runtime.has(accountId)) {
    runtime.set(accountId, {
      status: "ok",
      blockedUntil: null,
      lastError: null,
      lastUsedAt: 0,
      lastSuccessAt: 0,
      failStreak: 0,
      // Soft concurrency: allow multiple parallel requests on the same account.
      // inFlightCount prefers less-busy accounts for rotation without exclusive locks.
      // inFlightUntil is only used as a short transient cooldown (not exclusive busy).
      inFlightCount: 0,
      inFlightUntil: 0,
      _usageRef: null,
      _usageSnap: null,
    });
  }
  const st = runtime.get(accountId);
  if (typeof st.inFlightCount !== "number" || st.inFlightCount < 0) st.inFlightCount = 0;
  return st;
}

function providerUsagePollNeverBlocks(account) {
  // Hard fallback: J3GB usage is always UI-only (even if registry not bootstrapped yet).
  if (account?.providerId === "j3gb") return true;
  try {
    const registry = require("../providers/registry.cjs");
    if (typeof registry.bootstrap === "function") registry.bootstrap();
    return Boolean(registry.getProvider(account?.providerId)?.usagePollNeverBlocks);
  } catch {
    return false;
  }
}

function isUsagePollNoiseError(err) {
  return /api_key_disabled|api key is disabled|usage (api|endpoint|rate)|key not disabled|usage unavailable|usage network|usage only/i.test(
    String(err || "")
  );
}

function hydrateFromAccount(account) {
  const st = getRuntime(account.id);
  const r = account.routing || {};
  const usagePollNeverBlocks = providerUsagePollNeverBlocks(account);
  // Restore sticky success timestamp so API keys keep the same key after restart.
  if (r.lastSuccessAt && Number(r.lastSuccessAt) > (st.lastSuccessAt || 0)) {
    st.lastSuccessAt = Number(r.lastSuccessAt);
  }
  if (r.lastUsedAt && Number(r.lastUsedAt) > (st.lastUsedAt || 0)) {
    st.lastUsedAt = Number(r.lastUsedAt);
  }
  if (r.blockedUntil && Number(r.blockedUntil) > Date.now()) {
    // J3GB: never restore blocks that only came from usage/balance polling.
    // Real chat rate/auth blocks still restore (error text won't match usage noise).
    const usageDerived =
      usagePollNeverBlocks &&
      (isUsagePollNoiseError(r.lastError) ||
        r.status === "quota" ||
        /balance:empty|usage exhausted|limitReached/i.test(String(r.lastError || "")));
    if (usageDerived) {
      // drop stale usage-derived block so key stays in rotation
    } else {
      // Cap restored blocks to max 10 minutes from now
      st.blockedUntil = capBlockUntil(Number(r.blockedUntil));
      st.status = r.status || "rate_limited";
      st.lastError = r.lastError || st.lastError;
    }
  }
  // Usage-based preflight — cached by reference to avoid re-parsing 170 usage objects per request.
  // Important: when account.usage is null, _usageRef is also null at init — `null !== null` is false,
  // so we must still build a snapshot or u.blocked throws (Cannot read properties of null).
  // Providers with usagePollNeverBlocks (J3GB): usage is UI-only — never preflight-block routing.
  const usageRef = account.usage;
  if (st._usageRef !== usageRef || !st._usageSnap) {
    st._usageRef = usageRef;
    st._usageSnap = usagePollNeverBlocks
      ? { blocked: false, until: null, reason: null }
      : fromUsageSnapshot(usageRef);
  } else if (usagePollNeverBlocks) {
    // Force non-blocking snap even if a previous hydrate cached a blocked snap before flag existed.
    st._usageSnap = { blocked: false, until: null, reason: null };
  }
  const u = st._usageSnap || { blocked: false, until: null, reason: null };
  if (!usagePollNeverBlocks && u.blocked && u.until && u.until > Date.now()) {
    const capped = capBlockUntil(u.until);
    if (!st.blockedUntil || capped > st.blockedUntil) {
      st.blockedUntil = capped;
      st.status = "quota";
      st.lastError = u.reason || "usage exhausted";
    }
  }
  // Cap any existing block (e.g. restored 24h from disk) to max 10 minutes
  if (st.blockedUntil && st.blockedUntil > Date.now() + MAX_BLOCK_MS) {
    st.blockedUntil = Date.now() + MAX_BLOCK_MS;
  }
  return st;
}

function isAvailable(st, now = Date.now()) {
  // Transient soft-cooldown (e.g. brief 5xx) — still skip for NEW picks,
  // but never treat "already in flight" as unavailable (parallel OK).
  if (st.inFlightUntil && st.inFlightUntil > now) return false;
  if (st.blockedUntil && st.blockedUntil > now) return false;
  // expired block -> auto clear (no 24h re-extend — max block is 10 minutes)
  if (st.blockedUntil && st.blockedUntil <= now) {
    st.blockedUntil = null;
    st.status = "ok";
    st.lastError = null;
    st.failStreak = 0;
  }
  // Expired transient cooldown
  if (st.inFlightUntil && st.inFlightUntil <= now) st.inFlightUntil = 0;
  return st.status === "ok" || !st.blockedUntil;
}

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    // explicit priority (lower = first)
    const pa = a.priority != null ? Number(a.priority) : 1000;
    const pb = b.priority != null ? Number(b.priority) : 1000;
    if (pa !== pb) return pa - pb;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
}

function cursorKey(providerId, model) {
  return `${providerId || ""}:${String(model || "").trim().toLowerCase()}`;
}

function rotateByCursor(items, key) {
  if (!items.length) return items;
  const cursor = cursors.get(key) || 0;
  const start = Math.abs(cursor) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function advanceCursor(key) {
  const next = (cursors.get(key) || 0) + 1;
  cursors.set(key, next >= 2_147_483_640 ? 0 : next);
}

/** Pure API-key credential (not OAuth token masquerading as key). */
function isApiKeyAccount(account) {
  if (!account) return false;
  const authType =
    account.authType || (account.accessToken && !account.apiKey ? "oauth" : "apikey");
  return authType === "apikey" && Boolean(account.apiKey);
}

function isOauthAccount(account) {
  if (!account) return false;
  const authType =
    account.authType || (account.accessToken && !account.apiKey ? "oauth" : "apikey");
  return authType === "oauth" || (Boolean(account.accessToken) && !account.apiKey);
}

/**
 * Ordered candidates for a provider: live accounts first, blocked accounts last.
 *
 * API keys: sticky — last successful key stays first while available; failover order
 * is priority then createdAt (stable, no skip). Round-robin cursor is NOT applied.
 *
 * OAuth: least-busy + LRU + model-scoped cursor spreads load across accounts.
 *
 * @returns {Array<{ account, state, available: boolean }>}
 */
function listCandidates(accounts, providerId, { onlyAvailable = false, model = "" } = {}) {
  const now = Date.now();

  // Filter by provider + enabled + has credentials, then hydrate in one pass
  const out = [];
  for (const account of accounts || []) {
    if (account.providerId !== providerId) continue;
    if (account.enabled === false) continue;
    if (!account.accessToken && !account.apiKey) continue;
    const state = hydrateFromAccount(account);
    const available = isAvailable(state, now);
    if (onlyAvailable && !available) continue;
    out.push({ account, state, available });
  }

  const live = [];
  const blocked = [];
  for (const cand of out) {
    if (cand.available) live.push(cand);
    else blocked.push(cand);
  }

  const liveKeys = [];
  const liveOauth = [];
  for (const cand of live) {
    if (isApiKeyAccount(cand.account) && !isOauthAccount(cand.account)) liveKeys.push(cand);
    else liveOauth.push(cand);
  }

  // API keys under parallel load: least in-flight first, then sticky last-success.
  // Without inFlight tie-break, 20 clients all pin the same sticky key and starve the pool.
  liveKeys.sort((a, b) => {
    const fa = a.state.inFlightCount || 0;
    const fb = b.state.inFlightCount || 0;
    if (fa !== fb) return fa - fb;
    const sa = a.state.lastSuccessAt || 0;
    const sb = b.state.lastSuccessAt || 0;
    if (sa !== sb) return sb - sa; // sticky among equally free keys
    const pa = a.account.priority != null ? Number(a.account.priority) : 1000;
    const pb = b.account.priority != null ? Number(b.account.priority) : 1000;
    if (pa !== pb) return pa - pb;
    return (a.account.createdAt || 0) - (b.account.createdAt || 0);
  });

  // OAuth: spread parallel load (least busy → LRU → stable order).
  liveOauth.sort((a, b) => {
    const pa = a.account.priority != null ? Number(a.account.priority) : 1000;
    const pb = b.account.priority != null ? Number(b.account.priority) : 1000;
    if (pa !== pb) return pa - pb;
    const fa = a.state.inFlightCount || 0;
    const fb = b.state.inFlightCount || 0;
    if (fa !== fb) return fa - fb;
    const ua = a.state.lastUsedAt || 0;
    const ub = b.state.lastUsedAt || 0;
    if (ua !== ub) return ua - ub;
    return (a.account.createdAt || 0) - (b.account.createdAt || 0);
  });
  const orderedOauth =
    model && liveOauth.length ? rotateByCursor(liveOauth, cursorKey(providerId, model)) : liveOauth;

  // Prefer sticky API key pool, then OAuth accounts (provider hybrid keeps keys sticky).
  // When keys are saturated (inFlight high), OAuth still participates after free keys.
  const freeKeys = liveKeys.filter(
    (c) => (c.state.inFlightCount || 0) < DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT
  );
  const busyKeys = liveKeys.filter(
    (c) => (c.state.inFlightCount || 0) >= DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT
  );
  const orderedLive = [...freeKeys, ...orderedOauth, ...busyKeys];

  blocked.sort((a, b) => {
    const ba = a.state.blockedUntil || 0;
    const bb = b.state.blockedUntil || 0;
    if (ba !== bb) return ba - bb;
    const pa = a.account.priority != null ? Number(a.account.priority) : 1000;
    const pb = b.account.priority != null ? Number(b.account.priority) : 1000;
    if (pa !== pb) return pa - pb;
    return (a.account.createdAt || 0) - (b.account.createdAt || 0);
  });

  return [...orderedLive, ...blocked];
}

/**
 * Pick best single account for provider (first available in priority order).
 */
function selectAccount(accounts, providerId, { model = "" } = {}) {
  const cands = listCandidates(accounts, providerId, { onlyAvailable: true, model });
  if (cands.length) return cands[0];
  // All blocked — pick the one that unblocks soonest (soft fallback)
  const all = listCandidates(accounts, providerId, { onlyAvailable: false, model });
  if (!all.length) return null;
  all.sort(
    (a, b) => (a.state.blockedUntil || 0) - (b.state.blockedUntil || 0)
  );
  return all[0];
}

function advanceSelection(providerId, model) {
  if (!model) return;
  advanceCursor(cursorKey(providerId, model));
}

/**
 * Mark account after success — clear blocks, record usage.
 */
function markSuccess(accountId) {
  const st = getRuntime(accountId);
  st.status = "ok";
  st.blockedUntil = null;
  st.inFlightUntil = 0;
  // One lease ends on success
  st.inFlightCount = Math.max(0, (st.inFlightCount || 0) - 1);
  st.lastError = null;
  st.lastUsedAt = Date.now();
  st.lastSuccessAt = Date.now();
  st.failStreak = 0;
  return snapshot(st);
}

/**
 * Soft-lease an account for an in-flight request.
 * Multiple concurrent leases on the same account are allowed (parallel clients).
 * Returns null only when account is rate/quota/auth blocked (or transient cooldown).
 * ttlMs is kept for API compat / stuck-lease safety window metadata only.
 */
function maxInFlightFor(accountOrId) {
  // Optional per-account override: account.maxInFlight or account.routing.maxInFlight
  if (accountOrId && typeof accountOrId === "object") {
    const n =
      Number(accountOrId.maxInFlight) ||
      Number(accountOrId.routing?.maxInFlight) ||
      0;
    if (n > 0) return Math.min(64, Math.max(1, n));
  }
  return DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT;
}

/**
 * Soft-lease. When at/over maxInFlight, still allows lease if force=true (failover
 * last resort), otherwise returns null so pickNext can choose another key.
 */
function leaseAccount(accountId, ttlMs = 30_000, opts = {}) {
  const st = getRuntime(accountId);
  const now = Date.now();
  const forceBlocked = opts.forceBlocked === true;
  if (!forceBlocked && !isAvailable(st, now)) return null;
  const maxInf = Number(opts.maxInFlight) > 0 ? Number(opts.maxInFlight) : DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT;
  const force = opts.force === true;
  if (!force && (st.inFlightCount || 0) >= maxInf) {
    return null; // saturated — try another account
  }
  st.inFlightCount = (st.inFlightCount || 0) + 1;
  // Safety: if a lease is never released (process hang), don't leave count stuck forever.
  st.lastUsedAt = now;
  st._leaseTtlMs = Math.max(1_000, Number(ttlMs) || 30_000);
  st._leasedAt = now;
  return snapshot(st);
}

function releaseAccount(accountId) {
  const st = getRuntime(accountId);
  st.inFlightCount = Math.max(0, (st.inFlightCount || 0) - 1);
  // Do not clear inFlightUntil here — that is a separate short cooldown channel.
  return snapshot(st);
}

function markTransientError(accountId, info = {}) {
  const st = getRuntime(accountId);
  const cooldownMs = Math.max(1_000, Number(info.cooldownMs) || 5_000);
  // Soft cooldown for NEW picks only; release one lease if any
  st.inFlightCount = Math.max(0, (st.inFlightCount || 0) - 1);
  st.inFlightUntil = Date.now() + cooldownMs;
  st.lastError = info.message || "transient upstream error";
  st.lastUsedAt = Date.now();
  return snapshot(st);
}

/**
 * Mark account limited/unavailable.
 * @param {string} accountId
 * @param {{ kind?: string, message?: string, resetAfterSec?: number, blockedUntil?: number }} info
 */
function statusFromKind(kind) {
  if (kind === "quota") return "quota";
  if (kind === "auth" || kind === "banned") return "auth";
  if (kind === "rate_limit") return "rate_limited";
  if (kind === "timeout" || kind === "network" || kind === "server") return "error";
  if (kind === "request" || kind === "policy") return "error";
  if (kind === "error") return "error";
  return "rate_limited";
}

function defaultBlockMs(kind) {
  switch (kind) {
    case "quota":
      // Quota / balance — max 10 minutes (user policy)
      return MAX_BLOCK_MS;
    case "auth":
    case "banned":
      // Was 1h — cap at 10m so keys re-enter rotation quickly
      return MAX_BLOCK_MS;
    case "rate_limit":
      return 60 * 1000;
    case "timeout":
    case "network":
    case "server":
      return 5 * 1000;
    case "request":
    case "policy":
      return 2 * 1000;
    default:
      return 15 * 1000;
  }
}

function markLimited(accountId, info = {}) {
  const st = getRuntime(accountId);
  const kind = info.kind || "rate_limit";
  const now = Date.now();
  st.status = statusFromKind(kind);
  st.lastError = info.message || kind;
  st.lastUsedAt = now;
  // Account is blocked for new work; drop in-flight soft counters so it doesn't
  // look "busy" forever after limit (other parallel calls may still finish).
  st.inFlightUntil = 0;
  st.inFlightCount = Math.max(0, (st.inFlightCount || 0) - 1);
  st.failStreak = (st.failStreak || 0) + 1;

  let until = info.blockedUntil || null;
  if (!until && info.resetAfterSec) {
    // Cap provider-suggested reset (e.g. 24h) to max 10 minutes
    until = now + Math.min(Number(info.resetAfterSec) * 1000, MAX_BLOCK_MS);
  }
  if (!until) {
    until = now + defaultBlockMs(kind);
  }
  st.blockedUntil = capBlockUntil(until, now);
  return snapshot(st);
}

function markFromUpstreamError(accountId, status, body) {
  const c = classifyUpstreamError(status, body);
  // Non-retryable is rare; still release lease so account is not stuck in-flight.
  if (c.kind === "none" || c.retryable === false) {
    const st = getRuntime(accountId);
    st.inFlightCount = Math.max(0, (st.inFlightCount || 0) - 1);
    st.lastError = c.message || st.lastError;
    st.lastUsedAt = Date.now();
    return { ...snapshot(st), classify: c };
  }
  // Soft short cooldown kinds still go through markLimited with short resetAfterSec
  // so the router can pick the next account instead of stopping.
  return {
    ...markLimited(accountId, {
      kind: c.kind === "other" ? "error" : c.kind,
      message: c.message,
      resetAfterSec: c.resetAfterSec || 15,
    }),
    classify: c,
  };
}

/** Sync runtime from fresh usage fetch (called by accounts.refreshAccountUsage). */
function syncFromUsage(accountId, usage) {
  const st = getRuntime(accountId);
  const u = fromUsageSnapshot(usage) || { blocked: false, until: null, reason: null };
  // Keep hydrate cache in sync so a later null usage ref doesn't leave a stale snap
  st._usageRef = usage;
  st._usageSnap = u;
  if (u.blocked) {
    st.status = "quota";
    st.blockedUntil = capBlockUntil(u.until || Date.now() + MAX_BLOCK_MS);
    st.lastError = u.reason;
  } else if (
    st.status === "quota" ||
    st.status === "rate_limited" ||
    st.status === "auth" ||
    st.status === "error"
  ) {
    st.status = "ok";
    st.blockedUntil = null;
    st.inFlightUntil = 0;
    st.lastError = null;
    st.failStreak = 0;
  }
  return snapshot(st);
}

function snapshot(st) {
  const inFlightCount = st.inFlightCount || 0;
  const available = isAvailable(st);
  return {
    status: st.status,
    blockedUntil: st.blockedUntil,
    inFlightUntil: st.inFlightUntil || 0,
    inFlightCount,
    maxInFlight: DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT,
    saturated: available && inFlightCount >= DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT,
    lastError: st.lastError,
    lastUsedAt: st.lastUsedAt,
    lastSuccessAt: st.lastSuccessAt,
    failStreak: st.failStreak,
    // available = not rate/quota/auth blocked (parallel in-flight does NOT make unavailable)
    available,
  };
}

function getStatus(accountId) {
  return snapshot(getRuntime(accountId));
}

function getAllStatuses() {
  const out = {};
  for (const [id, st] of runtime) out[id] = snapshot(st);
  return out;
}

/** Persist routing fields onto account object (caller saves store). */
function applyToAccount(account) {
  if (!account?.id) return account;
  const snap = getStatus(account.id);
  account.routing = {
    status: snap.status,
    blockedUntil: snap.blockedUntil,
    lastError: snap.lastError,
    lastUsedAt: snap.lastUsedAt,
    lastSuccessAt: snap.lastSuccessAt,
  };
  return account;
}

function clearAll() {
  runtime.clear();
  cursors.clear();
}

/**
 * Manual unlock: clear quota/rate-limit routing block for one account.
 * Does not delete credentials or usage history — only routing cooldown flags.
 * Soft-clears stale usage.limitReached so hydrate won't immediately re-block.
 */
function clearQuotaBlock(accountId, account) {
  if (!accountId) return { ok: false, error: "accountId required" };
  const st = getRuntime(accountId);
  st.status = "ok";
  st.blockedUntil = null;
  st.inFlightUntil = 0;
  st.lastError = null;
  st.failStreak = 0;
  // Keep inFlightCount as-is (live requests may still be finishing).

  if (account && typeof account === "object") {
    if (account.usage && typeof account.usage === "object") {
      // Soft-clear so hydrateFromAccount won't re-apply quota block from stale snapshot.
      account.usage = {
        ...account.usage,
        limitReached: false,
      };
      // Invalidate hydrate usage cache so next listCandidates rebuilds from new ref.
      st._usageRef = account.usage;
      st._usageSnap = fromUsageSnapshot(account.usage);
      // If balance is still 0, fromUsageSnapshot would re-block — force clear for manual unlock.
      if (st._usageSnap?.blocked) {
        st._usageSnap = { blocked: false, until: null, reason: null };
      }
    } else {
      st._usageRef = account.usage ?? null;
      st._usageSnap = { blocked: false, until: null, reason: null };
    }
    applyToAccount(account);
  } else {
    st._usageSnap = { blocked: false, until: null, reason: null };
  }

  return { ok: true, status: snapshot(st), account };
}

module.exports = {
  listCandidates,
  selectAccount,
  advanceSelection,
  markSuccess,
  leaseAccount,
  releaseAccount,
  markTransientError,
  markLimited,
  markFromUpstreamError,
  syncFromUsage,
  getStatus,
  getAllStatuses,
  applyToAccount,
  hydrateFromAccount,
  isAvailable,
  sortAccounts,
  clearAll,
  clearQuotaBlock,
  maxInFlightFor,
  DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT,
};
