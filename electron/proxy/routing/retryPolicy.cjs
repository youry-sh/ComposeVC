/** Max full pool recycles after every unique credential was tried once. */
const MAX_POOL_RECYCLES = 6;
/** Bounded full-pool retries for a transient generic upstream 5xx. */
const MAX_SERVER_POOL_RECYCLES = 3;
/** Backoff between pool recycles (ms), grows with recycle count. */
const POOL_RECYCLE_BASE_MS = 400;
const POOL_RECYCLE_MAX_MS = 4_000;
/** Small clock-skew guard so a retry does not race the cooldown boundary. */
const SERVER_RETRY_COOLDOWN_GUARD_MS = 25;
/** Never hold a new request for a long quota/rate-limit style block. */
const MAX_TRANSIENT_BLOCK_WAIT_MS = 10_000;

/** Abort-aware delay used between retry rounds. */
function waitForRetry(ms, signal) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (!delayMs) return Promise.resolve(!signal?.aborted);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(completed);
    };
    const onAbort = () => finish(false);
    timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function poolRecycleLimit(kind) {
  return kind === "server" ? MAX_SERVER_POOL_RECYCLES : MAX_POOL_RECYCLES;
}

function canRecyclePool({ kind, continueFailover, nextAttempt, maxAttempts, poolRecycles }) {
  return Boolean(continueFailover) &&
    Number(nextAttempt) < Number(maxAttempts) &&
    Number(poolRecycles) < poolRecycleLimit(kind);
}

/**
 * A request arriving during a short server/network cooldown should wait inside
 * the proxy instead of receiving a synthetic all_accounts_blocked response.
 */
function transientPoolWaitMs(candidates, now = Date.now()) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (!candidates.every((candidate) => candidate?.state?.status === "error")) return null;

  const waits = candidates
    .map((candidate) => Number(candidate?.state?.blockedUntil) - now)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!waits.length) return 0;
  const soonestMs = Math.min(...waits);
  if (soonestMs > MAX_TRANSIENT_BLOCK_WAIT_MS) return null;
  return soonestMs + SERVER_RETRY_COOLDOWN_GUARD_MS;
}

/**
 * Respect the router's short server cooldown before retrying a recycled pool.
 * Other retry kinds retain the existing fast linear backoff.
 */
function poolRecycleDelayMs(kind, recycleNumber, blockedUntilValues = [], now = Date.now()) {
  const backoffMs = Math.min(
    POOL_RECYCLE_MAX_MS,
    POOL_RECYCLE_BASE_MS * Math.max(1, Number(recycleNumber) || 1)
  );
  if (kind !== "server") return backoffMs;

  const waits = blockedUntilValues
    .map((value) => Number(value) - now)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!waits.length) return backoffMs;
  return Math.max(backoffMs, Math.min(...waits) + SERVER_RETRY_COOLDOWN_GUARD_MS);
}

module.exports = {
  MAX_POOL_RECYCLES,
  MAX_SERVER_POOL_RECYCLES,
  poolRecycleLimit,
  canRecyclePool,
  transientPoolWaitMs,
  poolRecycleDelayMs,
  waitForRetry,
};
