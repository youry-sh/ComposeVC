/**
 * Grok free-tier daily (rolling 24h) usage.
 *
 * The CLI proxy does NOT expose a free-tier quota endpoint:
 *   /v1/billing                → paid credits only (all zeros for free accounts)
 *   /v1/billing?format=credits → weekly paid window (zeros for free accounts)
 *
 * The only authoritative source is the 429 payload from /v1/responses:
 *   { "code": "subscription:free-usage-exhausted",
 *     "error": "You've used all the included free usage for model
 *               grok-4.5-build-free for now. Usage resets over a rolling
 *               24-hour window - tokens (actual/limit): 1021918/1000000. ..." }
 *
 * This module parses that payload and keeps a local rolling-24h token counter
 * per account (fed by real request usage), so the UI can show a daily window
 * even before the account hits the wall.
 */

const DEFAULT_FREE_TOKEN_LIMIT = 1000000;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

const FREE_EXHAUSTED_RE = /free-usage-exhausted|included free usage|free usage for model/i;

function rawText(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Error) return body.message || String(body);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function parseFreeUsageError(body) {
  const raw = rawText(body);
  if (!raw || !FREE_EXHAUSTED_RE.test(raw)) return null;

  const tokens = raw.match(/tokens\s*\(actual\/limit\)\s*:\s*(\d+)\s*\/\s*(\d+)/i);
  const model = raw.match(/free usage for model\s+([A-Za-z0-9._-]+)/i);

  const used = tokens ? Number(tokens[1]) : NaN;
  const limit = tokens ? Number(tokens[2]) : NaN;

  return {
    used: Number.isFinite(used) ? used : NaN,
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_FREE_TOKEN_LIMIT,
    model: model ? model[1] : null,
  };
}

function isFreeUsageExhausted(body) {
  return parseFreeUsageError(body) != null;
}

function nowMs() {
  return Date.now();
}

function normalizeSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const cutoff = nowMs() - ROLLING_WINDOW_MS;
  return samples
    .filter(
      (s) =>
        s &&
        Number.isFinite(Number(s.at)) &&
        Number(s.at) > cutoff &&
        Number(s.tokens) > 0
    )
    .map((s) => ({ at: Number(s.at), tokens: Number(s.tokens) }));
}

function sumWindow(samples) {
  return normalizeSamples(samples).reduce((acc, s) => acc + s.tokens, 0);
}

function addTokens(state, tokens) {
  const n = Number(tokens);
  const prev = state && typeof state === "object" ? state : {};
  const samples = normalizeSamples(prev.samples);
  if (Number.isFinite(n) && n > 0) {
    samples.push({ at: nowMs(), tokens: Math.trunc(n) });
  }
  const trimmed = samples.length > 2000 ? samples.slice(samples.length - 2000) : samples;
  return {
    ...prev,
    samples: trimmed,
    limit: Number(prev.limit) > 0 ? Number(prev.limit) : DEFAULT_FREE_TOKEN_LIMIT,
    used: sumWindow(trimmed),
    updatedAt: nowMs(),
  };
}

function applyExhausted(state, body) {
  const parsed = parseFreeUsageError(body);
  if (!parsed) return null;
  const prev = state && typeof state === "object" ? state : {};
  const limit = parsed.limit > 0 ? parsed.limit : DEFAULT_FREE_TOKEN_LIMIT;
  const used = Number.isFinite(parsed.used) ? parsed.used : limit;
  return {
    state: {
      ...prev,
      samples: normalizeSamples(prev.samples),
      limit,
      used,
      serverUsed: used,
      serverAt: nowMs(),
      model: parsed.model || prev.model || null,
      exhaustedAt: nowMs(),
      resetAt: new Date(nowMs() + ROLLING_WINDOW_MS).toISOString(),
    },
    parsed,
  };
}

function oldestSampleReset(samples) {
  const list = normalizeSamples(samples);
  if (!list.length) return null;
  const oldest = list.reduce((min, s) => (s.at < min ? s.at : min), list[0].at);
  return new Date(oldest + ROLLING_WINDOW_MS).toISOString();
}

function clearIfWindowPassed(state) {
  if (!state || typeof state !== "object") return state;
  const at = Number(state.exhaustedAt);
  if (!Number.isFinite(at)) return state;
  if (nowMs() - at < ROLLING_WINDOW_MS) return state;
  const samples = normalizeSamples(state.samples);
  return {
    ...state,
    samples,
    used: sumWindow(samples),
    serverUsed: null,
    serverAt: null,
    exhaustedAt: null,
    resetAt: null,
  };
}

function toQuota(state) {
  if (!state || typeof state !== "object") return null;
  const limit = Number(state.limit) > 0 ? Number(state.limit) : DEFAULT_FREE_TOKEN_LIMIT;
  const localUsed = sumWindow(state.samples);
  const serverFresh =
    Number.isFinite(Number(state.serverUsed)) &&
    Number.isFinite(Number(state.serverAt)) &&
    nowMs() - Number(state.serverAt) < ROLLING_WINDOW_MS;
  const used = serverFresh ? Math.max(Number(state.serverUsed), localUsed) : localUsed;
  if (!serverFresh && used <= 0) return null;

  const pct = Math.min(100, Math.max(0, (used / limit) * 100));
  const resetAt =
    state.resetAt ||
    (Number.isFinite(Number(state.exhaustedAt))
      ? new Date(Number(state.exhaustedAt) + ROLLING_WINDOW_MS).toISOString()
      : oldestSampleReset(state.samples));

  return {
    name: "daily",
    usedPercent: pct,
    remainingPercent: Math.min(100, Math.max(0, 100 - pct)),
    used,
    total: limit,
    resetAt: resetAt || null,
  };
}

function isExhausted(state) {
  if (!state || typeof state !== "object") return false;
  const at = Number(state.exhaustedAt);
  if (!Number.isFinite(at)) return false;
  return nowMs() - at < ROLLING_WINDOW_MS;
}

module.exports = {
  DEFAULT_FREE_TOKEN_LIMIT,
  ROLLING_WINDOW_MS,
  parseFreeUsageError,
  isFreeUsageExhausted,
  addTokens,
  applyExhausted,
  clearIfWindowPassed,
  toQuota,
  isExhausted,
  sumWindow,
  oldestSampleReset,
};
