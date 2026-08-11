/**
 * Detect provider limit / quota / auth / network / request errors from HTTP status + body.
 * Provider-agnostic; unknown errors stay retryable so account router can failover.
 *
 * kind values (pipeline + accountRouter):
 *   quota | rate_limit | auth | timeout | network | server | request | invalid_model | policy | banned | other
 * retryable=true  → cooldown/block this account, try next
 * retryable=false → non-account fatal (invalid model id) — stop multi-account storm
 */

function textOf(body) {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof Error) return body.message || String(body);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function extractMessage(body, raw) {
  let message = (raw || "").slice(0, 400);
  try {
    const j = typeof body === "string" ? JSON.parse(body) : body;
    if (!j || typeof j !== "object") return message;
    message =
      j?.error?.message ||
      j?.error?.error?.message ||
      (typeof j?.error === "string" ? j.error : null) ||
      j?.message ||
      j?.msg ||
      j?.detail ||
      (Array.isArray(j?.errors) ? j.errors.map((e) => e?.message || e).join("; ") : null) ||
      message;
  } catch {
    /* plain text / SSE fragment */
  }
  return String(message || raw || "").slice(0, 400);
}

/**
 * @returns {{
 *   kind: 'none'|'quota'|'rate_limit'|'auth'|'timeout'|'network'|'server'|'request'|'policy'|'banned'|'other',
 *   retryable: boolean,
 *   message: string,
 *   resetAfterSec?: number
 * }}
 */
function classifyUpstreamError(status, body) {
  const raw = textOf(body);
  const lower = raw.toLowerCase();
  const message = extractMessage(body, raw);
  const msgLower = String(message || "").toLowerCase();
  const hay = `${lower}\n${msgLower}`;
  const code = Number(status) || 0;

  // ── Quota / billing / balance (before 429 — many providers send 429 for quota) ──
  if (
    code === 402 ||
    /insufficient[_\s-]?quota|exceeded your current quota|billing details|quota exceeded|usage[_\s-]?limit|free-usage-exhausted|free usage exhausted|subscription:free|included free usage|usage exhausted|balance exhausted|usage balance|insufficient balance|credits? exhausted|payment required|plan limit|out of credits|no credits|credit balance|billing_hard_limit|spend limit|budget exceeded|resource.?exhausted|resource_exhausted/.test(
      hay
    )
  ) {
    // 402 / balance / quota: max 10 minutes block (not 24h)
    return { kind: "quota", retryable: true, message, resetAfterSec: Math.min(guessResetSec(hay) || 10 * 60, 10 * 60) };
  }

  if (/currently at capacity|high demand|model capacity|priority processing/.test(hay)) {
    return {
      kind: "rate_limit",
      retryable: true,
      message,
      resetAfterSec: 60,
    };
  }

  // ── Rate limit ──
  if (
    code === 429 ||
    /rate[_\s-]?limit|too many requests|tokens per min|requests per min|\brpm\b|\btpm\b|throttl|slow down|concurrency limit|capacity.?exhausted/.test(
      hay
    )
  ) {
    return {
      kind: "rate_limit",
      retryable: true,
      message,
      resetAfterSec: guessResetSec(hay) || 60,
    };
  }

  // ── Auth / permission / IAM (message-first so 403 with clear text still routes) ──
  // Note: API_KEY_DISABLED on some gateways (e.g. J3GB /usage) is often usage-only noise.
  // When it appears on chat, still failover — but use a short cooldown (not 1h ban) so
  // sticky keys recover quickly if the same credential works for other models/routes.
  if (/api_key_disabled|api key is disabled/.test(hay)) {
    return {
      kind: "rate_limit",
      retryable: true,
      message,
      resetAfterSec: guessResetSec(hay) || 60,
    };
  }
  if (
    code === 401 ||
    /invalid[_\s-]?api[_\s-]?key|incorrect api key|invalid.?token|token expired|refresh.?token|unauthori[sz]ed|authentication|not authenticated|access denied|permission.?denied|forbidden|iam|api key not valid|no api key|missing api key|revoked|invalid_grant|login.?required|oauth/.test(
      hay
    )
  ) {
    // Auth blocks capped at 10 minutes (was 1h for 401)
    return { kind: "auth", retryable: true, message, resetAfterSec: code === 401 ? 10 * 60 : 30 };
  }
  if (code === 403) {
    // 403 may be auth, ban, or policy — prefer specific kinds below; default auth for failover
    if (/banned|suspended|disabled|deactivated|terminated|account.?locked|blocked.?region|region.?not|geo.?block|not available in your/.test(hay)) {
      return { kind: "banned", retryable: true, message, resetAfterSec: 10 * 60 };
    }
    if (/safety|content.?policy|moderation|blocked by|responsible.?ai|harmful|violat/.test(hay)) {
      return { kind: "policy", retryable: true, message, resetAfterSec: 5 };
    }
    return { kind: "auth", retryable: true, message, resetAfterSec: 30 };
  }

  // ── Account banned / suspended / region ──
  if (
    /account.?banned|account.?suspended|account.?disabled|user.?banned|organization.?disabled|region.?block|not available in (your|this) (country|region)|geo.?restrict|access.?restricted/.test(
      hay
    )
  ) {
    return { kind: "banned", retryable: true, message, resetAfterSec: 10 * 60 };
  }

  // ── Content policy / safety ──
  if (
    /content.?policy|safety.?system|moderation|blocked by|responsible.?ai|harmful content|violates? (our |the )?policy|content.?filter|prompt.?blocked/.test(
      hay
    )
  ) {
    // Still failover: another account/provider policy stack may differ; short cooldown
    return { kind: "policy", retryable: true, message, resetAfterSec: 5 };
  }

  // ── Timeout (HTTP + message) ──
  if (
    code === 408 ||
    code === 504 ||
    code === 524 ||
    /timeout|timed out|connect_timeout|deadline.?exceeded|context deadline|gateway time-?out|econnaborted/.test(
      hay
    )
  ) {
    return { kind: "timeout", retryable: true, message, resetAfterSec: guessResetSec(hay) || 5 };
  }

  // ── Network / DNS / TLS / connection ──
  // Note: code===0 alone is not enough (missing status + text error); require message cues.
  if (
    /econnreset|econnrefused|enotfound|eai_again|enetunreach|ehostunreach|epipe|socket hang up|network error|fetch failed|getaddrinfo|certificate|ssl|tls|handshake|connection reset|connection refused|\bdns\b/.test(
      hay
    ) ||
    (code === 0 && !hay.trim())
  ) {
    return { kind: "network", retryable: true, message, resetAfterSec: 5 };
  }

  // ── Cloudflare / gateway / 5xx ──
  if (
    code === 520 ||
    code === 521 ||
    code === 522 ||
    code === 523 ||
    code === 502 ||
    code === 503 ||
    code === 500 ||
    code === 507 ||
    code === 529 ||
    code >= 500 ||
    /internal server error|bad gateway|service unavailable|upstream|overloaded|server.?error|temporarily unavailable|capacity/.test(
      hay
    )
  ) {
    return { kind: "server", retryable: true, message, resetAfterSec: 5 };
  }

  // ── Invalid / unknown model id — NOT account-scoped; do not burn all accounts ──
  // Kiro: "Invalid model. Please select a different model to continue."
  // OpenAI-style: model_not_found / does not exist / unknown model
  if (
    /invalid model|select a different model to continue|model.?not.?found|unknown model|model .* does not exist|does not exist.*model|unsupported model|model is not (supported|available|allowed|valid)|no such model|invalid.?model.?id/.test(
      hay
    ) ||
    ((code === 400 || code === 404) &&
      /invalid model|model.?not.?found|unknown model|does not exist|unsupported model|select a different model/.test(
        hay
      ))
  ) {
    return {
      kind: "invalid_model",
      retryable: false,
      message,
      resetAfterSec: 0,
    };
  }

  // ── Deterministic wire-format incompatibility — request-global, not account-scoped ──
  // Repeating an unchanged image_url payload across every credential cannot succeed
  // and used to turn one DeepSeek 400 into 50 retries plus a broken chat turn.
  if (
    /unknown variant\s+(?:[`"']?image_url[`"']?)|expected text|failed to deserialize.*(?:messages|content)|(?:messages|content).*failed to deserialize|invalid content[-_ ]?part|unsupported (?:content )?type.*image_url|image_url.*(?:not supported|unsupported)/.test(
      hay
    )
  ) {
    return {
      kind: "request_format",
      retryable: false,
      message,
      resetAfterSec: 0,
    };
  }

  // ── Client / request shape (may still work on next key/gateway) ──
  if (
    code === 400 ||
    code === 404 ||
    code === 409 ||
    code === 413 ||
    code === 422 ||
    /context.?length|maximum context|too many tokens|payload too large|request too large|invalid.?request|validation|model.?not.?found|unknown model|does not exist|unsupported|malformed|json.?parse|unexpected.?token|empty response|stream interrupted|incomplete/.test(
      hay
    )
  ) {
    return { kind: "request", retryable: true, message, resetAfterSec: 2 };
  }

  // ── Any other non-2xx or unknown → still failover (do not stop the router) ──
  if (code && code !== 200 && code !== 201) {
    return { kind: "other", retryable: true, message, resetAfterSec: 3 };
  }

  // status missing / 200 body with error-like text
  if (hay.trim()) {
    return { kind: "other", retryable: true, message, resetAfterSec: 3 };
  }

  return { kind: "other", retryable: true, message: message || "unknown upstream error", resetAfterSec: 3 };
}

function guessResetSec(lower) {
  const text = String(lower || "");
  // "try again in 20s" / "Please try again in 1m" / "retry after 30"
  const sec = text.match(/try again in\s+(\d+)\s*s/) || text.match(/retry[- ]after[:\s]+(\d+)/);
  if (sec) return Number(sec[1]);
  const min = text.match(/try again in\s+(\d+)\s*m/);
  if (min) return Number(min[1]) * 60;
  const hour = text.match(/try again in\s+(\d+)\s*h/);
  if (hour) return Number(hour[1]) * 3600;
  return null;
}

/**
 * From account.usage (Codex wham windows) — is this account currently exhausted?
 * @returns {{ blocked: boolean, until: number|null, reason: string|null }}
 */
function fromUsageSnapshot(usage) {
  if (!usage || typeof usage !== "object") {
    return { blocked: false, until: null, reason: null };
  }
  const MAX_BLOCK_MS = 10 * 60 * 1000;
  const now = Date.now();
  const capUntil = (until) => {
    const t = Number(until);
    if (!Number.isFinite(t) || t <= now) return now + MAX_BLOCK_MS;
    return Math.min(t, now + MAX_BLOCK_MS);
  };

  const remaining = Number(usage.remaining ?? usage.balance);
  if (Number.isFinite(remaining) && remaining <= 0) {
    return { blocked: true, until: now + MAX_BLOCK_MS, reason: "balance:empty" };
  }
  if (usage.limitReached) {
    const until = earliestReset(usage.quotas);
    return { blocked: true, until: capUntil(until), reason: "limitReached" };
  }
  const quotas = usage.quotas || {};
  for (const [name, q] of Object.entries(quotas)) {
    if (!q || typeof q !== "object") continue;
    const rem = q.remainingPercent != null ? q.remainingPercent : 100 - (q.usedPercent || 0);
    if (rem <= 0.5) {
      const until = q.resetAt ? Date.parse(q.resetAt) : null;
      return {
        blocked: true,
        until: capUntil(Number.isFinite(until) ? until : now + 5 * 60 * 1000),
        reason: `quota:${name}`,
      };
    }
  }
  return { blocked: false, until: null, reason: null };
}

function earliestReset(quotas) {
  const MAX_BLOCK_MS = 10 * 60 * 1000;
  const now = Date.now();
  if (!quotas || typeof quotas !== "object") return now + Math.min(5 * 60 * 1000, MAX_BLOCK_MS);
  let min = null;
  for (const q of Object.values(quotas)) {
    if (q?.resetAt) {
      const t = Date.parse(q.resetAt);
      if (Number.isFinite(t) && (min == null || t < min)) min = t;
    }
  }
  const fallback = now + Math.min(5 * 60 * 1000, MAX_BLOCK_MS);
  if (min == null) return fallback;
  return Math.min(min, now + MAX_BLOCK_MS);
}

/** True when message looks like billing/quota exhaustion (for soft UI / logs). */
function isQuotaErrorMessage(m) {
  const c = classifyUpstreamError(0, m);
  return c.kind === "quota";
}

/**
 * Should the multi-account pipeline try the next credential after this classify result?
 * Default YES for all known kinds; only explicit non-retryable stops failover.
 */
function shouldFailover(classify) {
  if (!classify) return true;
  if (classify.retryable === false) return false;
  // Invalid model is request-global — never rotate accounts for the same dead id
  if (classify.kind === "invalid_model") return false;
  // All other kinds we emit are account-scoped or transient → route next
  return true;
}

module.exports = {
  classifyUpstreamError,
  fromUsageSnapshot,
  isQuotaErrorMessage,
  shouldFailover,
};
