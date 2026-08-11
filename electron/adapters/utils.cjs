/**
 * Build a readable single-line provider error from a non-OK response body.
 * JSON error envelopes ({error:{message}}) are parsed so the chat bubble shows
 * the actual reason instead of a raw JSON dump. Falls back to raw text.
 */
function formatResponseError(status, text, providerName) {
  const raw = String(text || "").trim();
  let msg = raw;
  if (raw) {
    try {
      const json = JSON.parse(raw);
      const err = json.error || json;
      const candidate =
        err?.message || err?.error?.message || (typeof err === "string" ? err : null) || json.message;
      if (typeof candidate === "string" && candidate.trim()) msg = candidate.trim();
    } catch {
      /* not JSON — keep raw */
    }
  }
  msg = msg.replace(/\s+/g, " ").slice(0, 600);
  return `${providerName} request failed: ${status}${msg ? ` ${msg}` : ""}`;
}

async function readResponseText(response, providerName) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatResponseError(response.status, text, providerName));
  }
  return text;
}

/**
 * Consume JSON or SSE without buffering the response first. `onEvent` runs as
 * each complete SSE event arrives, so callers can forward text deltas to the
 * renderer while the upstream model is still generating.
 */
async function readResponseEvents(response, providerName, onEvent) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(formatResponseError(response.status, text, providerName));
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    const events = parseJsonOrSse(text);
    for (const event of events) onEvent?.(event);
    return events;
  }

  // Some OpenAI-compatible relays stream valid `data:` frames but omit or lie
  // about Content-Type. Inspect the body instead of falling back to response.text().
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const emit = (frame) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    // SSE normally uses data: lines; accepting a bare JSON frame keeps the
    // adapter compatible with relays that stream without a correct MIME type.
    const data = (dataLines.length ? dataLines.join("\n") : frame).trim();
    if (!data || data === "[DONE]") return;
    try {
      const event = JSON.parse(data);
      events.push(event);
      onEvent?.(event);
    } catch {
      // A few OpenAI-compatible relays emit a bare JSON line instead of a
      // properly framed SSE event. Ignore malformed keep-alives safely.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        emit(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
      }
      // Non-SSE relays sometimes emit exactly one JSON object per line.
      // Preserve an incomplete tail; emit every completed line immediately.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline !== -1) {
        const completeLines = buffer.slice(0, lastNewline).split("\n");
        buffer = buffer.slice(lastNewline + 1);
        for (const line of completeLines) {
          if (line.trim()) emit(line);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) emit(buffer);
  } finally {
    reader.releaseLock?.();
  }
  return events;
}

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt) {
  return Math.min(1000 * 2 ** attempt, 15000);
}

function isNonRetryableQuotaBody(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("insufficient_quota") ||
    t.includes("exceeded your current quota") ||
    t.includes("billing details") ||
    t.includes("check your plan and billing") ||
    t.includes("all_accounts_blocked") ||
    t.includes("all accounts are rate-limited") ||
    t.includes("all accounts are rate limited") ||
    t.includes("quota-exhausted") ||
    t.includes("quota exhausted") ||
    t.includes("auth in short cooldown") ||
    t.includes("balance exhausted") ||
    t.includes("usage balance") ||
    t.includes("insufficient balance") ||
    t.includes("credits exhausted") ||
    t.includes("credit exhausted") ||
    t.includes("payment required") ||
    t.includes("grok build usage") ||
    // Proxy may wrap invalid_model as 429 in edge cases — never retry
    t.includes("invalid_model") ||
    t.includes("invalid model") ||
    t.includes("select a different model to continue")
  );
}

/**
 * ChatGPT "Trusted Access for Cyber" gate surfaced by the proxy as
 * { error: { type: "content_policy", code: "cyber_flag" } } (HTTP 502).
 * The rejection is content-based and identical on every account — retrying
 * just burns the attempt budget and delays the flag in the chat. Return as-is.
 */
function isNonRetryableCyberBody(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("cyber_flag") ||
    t.includes("trusted access for cyber") ||
    t.includes("cybersecurity risk") ||
    t.includes("content was flagged")
  );
}

function summarizeBody(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const json = JSON.parse(raw);
    const msg = json.error?.message || json.message || raw;
    const code = json.error?.code || json.code || null;
    return String(code ? `${msg} (${code})` : msg).replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return raw.replace(/\s+/g, " ").slice(0, 500);
  }
}

// Retries transient failures (network drops, timeouts, rate limits, 5xx) up to
// `retries` times with exponential backoff. Non-retryable HTTP errors (bad
// request, auth, not found, billing quota exhausted, etc.) are returned as-is.
async function fetchWithRetry(url, options, { retries = DEFAULT_RETRIES, providerName = "Request", onRetry } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !RETRYABLE_STATUS_CODES.has(response.status)) {
        return response;
      }

      // Clone body for inspection — 429 insufficient_quota must NOT be retried
      // (retrying just burns 10 attempts and shows "Retrying 6/10…").
      let bodyText = "";
      try {
        bodyText = await response.clone().text();
      } catch {
        /* */
      }
      if (response.status === 429 && isNonRetryableQuotaBody(bodyText)) {
        return response;
      }
      // Cyber-flag (Trusted Access for Cyber): content-based, same on every key —
      // surface the flag in the chat immediately, never retry it.
      if (isNonRetryableCyberBody(bodyText)) {
        return response;
      }

      const bodySummary = summarizeBody(bodyText);
      lastError = new Error(
        bodySummary
          ? `${providerName} request failed: ${response.status} ${bodySummary}`
          : `${providerName} request failed: ${response.status}`
      );
    } catch (error) {
      // An intentional abort (user clicked "Stop") must never be retried — retrying would
      // just re-throw the same AbortError after a backoff delay, up to `retries` times,
      // making the stop button take seconds/minutes to actually take effect.
      if (error?.name === "AbortError" || options?.signal?.aborted) {
        throw error;
      }
      lastError = error;
    }

    if (attempt < retries) {
      onRetry?.({ attempt: attempt + 1, retries, error: lastError });
      await sleep(backoffDelay(attempt));
    }
  }

  throw lastError;
}

function parseJsonOrSse(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (!trimmed.startsWith("data:")) {
    return [JSON.parse(trimmed)];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload && payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

module.exports = { readResponseText, readResponseEvents, parseJsonOrSse, fetchWithRetry };
