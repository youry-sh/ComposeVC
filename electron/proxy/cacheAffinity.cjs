/**
 * Prompt-cache affinity for huge chats.
 *
 * Why: upstream prompt caches (Anthropic cache_control, OpenAI/Codex
 * prompt_cache_key, xAI conv-id, Gemini sessions) are scoped to ONE account and
 * keyed by a stable conversation id. Official clients (Claude Code, Codex CLI)
 * always send the same id and stay on one account, so turn N+1 only prefills
 * the new delta. The proxy used to:
 *   - spread consecutive turns of one chat across accounts (least-in-flight),
 *   - send no cache key / random session ids,
 * so every turn re-prefilled the whole 400–500k token context from scratch.
 *
 * This module derives a stable conversation key from the immutable head of a
 * chat (system prompt + first user message) and remembers which account served
 * it last, so the router can keep the chat on a warm cache.
 */

const crypto = require("crypto");
const { contentToText } = require("./openaiFormat.cjs");

/** How long an account stays "warm" for a conversation (provider caches live 5m–1h). */
const AFFINITY_TTL_MS = 60 * 60_000;
const AFFINITY_LIMIT = 5000;
/** Only the head of long texts is hashed — keeps keying O(1) for 500k-token chats. */
const HEAD_CHARS = 16_384;

const affinity = new Map(); // convKey -> { accountId, at }

function headOf(text) {
  const s = String(text || "");
  return s.length > HEAD_CHARS ? `${s.slice(0, HEAD_CHARS)}#len=${s.length}` : s;
}

/**
 * Stable per-conversation key. The system prompt + first user turn never change
 * while a chat grows, so every turn of the same chat maps to the same key.
 * Clients that already send their own id (prompt_cache_key / conversation id /
 * user) win — that is the most precise signal.
 */
function conversationKey(openaiBody) {
  if (!openaiBody || typeof openaiBody !== "object") return null;
  if (openaiBody._cacheKey) return openaiBody._cacheKey;
  const raw = openaiBody._raw && typeof openaiBody._raw === "object" ? openaiBody._raw : {};
  const explicit =
    raw.prompt_cache_key ||
    raw.conversation_id ||
    raw.conversationId ||
    raw.session_id ||
    raw.sessionId ||
    raw.metadata?.conversation_id ||
    raw.metadata?.session_id ||
    null;

  let seed;
  if (explicit && typeof explicit === "string") {
    seed = `explicit:${explicit}`;
  } else {
    const messages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
    const system = [];
    let firstUser = null;
    for (const m of messages) {
      if (!m) continue;
      if (m.role === "system" || m.role === "developer") {
        system.push(headOf(contentToText(m.content)));
        continue;
      }
      if (m.role === "user") {
        firstUser = headOf(contentToText(m.content));
        break;
      }
    }
    if (firstUser == null && !system.length) return null;
    seed = `conv:${system.join("\n")}\u0000${firstUser || ""}`;
  }
  const key = crypto.createHash("sha256").update(seed).digest("hex");
  try {
    Object.defineProperty(openaiBody, "_cacheKey", { value: key, enumerable: false });
  } catch {
    /* frozen body — just recompute next time */
  }
  return key;
}

/** RFC4122-shaped UUID (v4 layout) derived from a hex key — official CLIs send UUIDs. */
function uuidFromKey(key, salt = "") {
  const hex = crypto.createHash("sha256").update(`${salt}:${key}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

function scopedKey(providerId, convKey) {
  return `${providerId || "?"}|${convKey}`;
}

function getAffinity(providerId, convKey, now = Date.now()) {
  if (!convKey) return null;
  const k = scopedKey(providerId, convKey);
  const row = affinity.get(k);
  if (!row) return null;
  if (now - row.at > AFFINITY_TTL_MS) {
    affinity.delete(k);
    return null;
  }
  return row.accountId;
}

function setAffinity(providerId, convKey, accountId, now = Date.now()) {
  if (!convKey || !accountId) return;
  const k = scopedKey(providerId, convKey);
  // Re-insert to keep Map order = LRU order.
  affinity.delete(k);
  if (affinity.size >= AFFINITY_LIMIT) {
    const oldest = affinity.keys().next().value;
    if (oldest !== undefined) affinity.delete(oldest);
  }
  affinity.set(k, { accountId, at: now });
}

function clearAffinity(providerId, convKey) {
  if (!convKey) return;
  affinity.delete(scopedKey(providerId, convKey));
}

function _resetForTests() {
  affinity.clear();
}

/**
 * Size-aware timeouts: a cold 500k-token prefill can take minutes before the
 * first byte. Fixed 60s/90s limits used to kill the attempt and fail over to
 * ANOTHER account (cold cache again), which is the worst possible spiral.
 */
function scaledTimeoutMs(baseMs, requestChars, { perKTokensMs = 300, maxMs = 300_000 } = {}) {
  const base = Math.max(1000, Number(baseMs) || 0);
  const approxTokens = Math.max(0, Number(requestChars) || 0) / 4;
  const extra = (approxTokens / 1000) * perKTokensMs;
  return Math.round(Math.min(Math.max(base, maxMs), base + extra));
}

module.exports = {
  conversationKey,
  uuidFromKey,
  getAffinity,
  setAffinity,
  clearAffinity,
  scaledTimeoutMs,
  AFFINITY_TTL_MS,
  _resetForTests,
};
