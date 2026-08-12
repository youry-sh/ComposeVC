/**
 * Single source of truth helpers: resolve + validate model ids for proxy routes.
 * Prevents shipping invalid upstream model ids (Kiro "Invalid model…") and
 * endless multi-account retries with the same dead id.
 */

const {
  getProvider,
  parseTaggedModel,
  taggedModelId,
  resolveProviderIdFromTag,
} = require("./providers/registry.cjs");

/**
 * Strip ONLY known ComposeVC provider tags (orcarouter/, xai/, openai/, …).
 * Keep vendor paths like deepseek/deepseek-v4-flash-free — OrcaRouter needs the org/ prefix.
 */
function bareModelId(model) {
  let s = String(model || "").trim();
  if (!s) return "";
  // Peel leading provider tags only (may be nested: oracle/orcarouter/deepseek/…)
  while (s.includes("/")) {
    const idx = s.indexOf("/");
    const prefix = s.slice(0, idx).toLowerCase();
    if (!resolveProviderIdFromTag(prefix)) break;
    s = s.slice(idx + 1);
  }
  return s;
}

function normalizeModelKey(id) {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/\[1m\]/gi, "");
}

/** Messages that mean the model id itself is wrong (not auth/quota). */
function isInvalidModelMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    /invalid model/.test(m) ||
    /select a different model to continue/.test(m) ||
    /model is not (supported|available|allowed|valid)/.test(m) ||
    /unsupported model/.test(m) ||
    /unknown model id/.test(m)
  );
}

/**
 * Build a Set of bare model ids known for a provider (catalog + optional live/manual lists).
 * @param {string} providerId
 * @param {Array<{id?: string, bareId?: string}>} [extraModels]
 */
function allowlistFromModels(extraModels) {
  const set = new Set();
  for (const m of extraModels || []) {
    const bare = bareModelId(m.bareId || m.id || m);
    if (bare) set.add(normalizeModelKey(bare));
    const full = String(m.id || "").trim();
    if (full) set.add(normalizeModelKey(full));
  }
  return set;
}

/**
 * Prefer live/catalog order: preferred list → first chat model as safe fallback.
 * @param {Array} models
 * @param {string|null} preferredBare
 * @param {string[]} [preferredList] ordered preference (e.g. Kiro haiku before sonnet-5)
 */
function pickFallbackModel(models, preferredBare, preferredList = []) {
  const list = Array.isArray(models) ? models : [];
  const allowKeys = new Set(
    list.map((m) => normalizeModelKey(bareModelId(m.bareId || m.id))).filter(Boolean)
  );
  const pref = normalizeModelKey(preferredBare);
  if (pref && allowKeys.has(pref)) {
    const hit = list.find((m) => normalizeModelKey(bareModelId(m.bareId || m.id)) === pref);
    if (hit) return bareModelId(hit.bareId || hit.id);
  }
  for (const p of preferredList || []) {
    const k = normalizeModelKey(p);
    if (k && allowKeys.has(k)) {
      const hit = list.find((m) => normalizeModelKey(bareModelId(m.bareId || m.id)) === k);
      if (hit) return bareModelId(hit.bareId || hit.id);
    }
  }
  // Prefer sonnet/haiku/gpt style chat models over embeddings
  const chat = list.find((m) => {
    const id = bareModelId(m.bareId || m.id);
    const k = m.kind || "";
    if (k && k !== "chat") return false;
    return !/embed|tts|whisper|moderation|dall-e|image/i.test(id);
  });
  if (chat) return bareModelId(chat.bareId || chat.id);
  if (list[0]) return bareModelId(list[0].bareId || list[0].id);
  return null;
}

function preferredListForProvider(providerId) {
  if (providerId === "kiro") {
    try {
      const { PREFERRED_DEFAULTS } = require("./oauth/kiroCreds.cjs");
      return Array.isArray(PREFERRED_DEFAULTS) ? PREFERRED_DEFAULTS : [];
    } catch {
      return ["claude-haiku-4.5", "claude-sonnet-4.5"];
    }
  }
  // ChatGPT Codex / OpenAI coding models — never prefer chatgpt-4o-latest
  if (providerId === "openai") {
    return [
      "gpt-5.1-codex",
      "gpt-5-codex",
      "codex-mini-latest",
      "gpt-5.6",
      "gpt-5.4",
      "gpt-5",
      "gpt-5-mini",
    ];
  }
  return [];
}

/**
 * If bare id is not in allowlist, return a safe fallback from the same list.
 * Empty allowlist → no opinion (caller may still send).
 */
function resolveAllowedModel(providerId, requestedModel, models) {
  const bare = providerId === "qauth"
    ? String(requestedModel || "").trim().replace(/^(?:(?:qauth|cline)\/)+/i, "")
    : bareModelId(requestedModel);
  const allow = allowlistFromModels(models);
  if (!allow.size) {
    return {
      ok: true,
      bare,
      tagged: taggedModelId(providerId, bare),
      substituted: false,
      reason: "no_allowlist",
    };
  }
  if (allow.has(normalizeModelKey(bare))) {
    return {
      ok: true,
      bare,
      tagged: taggedModelId(providerId, bare),
      substituted: false,
      reason: null,
    };
  }
  // Alias tweaks: claude-sonnet-4-5 ↔ claude-sonnet-4.5
  const dotted = bare.replace(/(\d)-(\d)/g, "$1.$2");
  const dashed = bare.replace(/(\d)\.(\d)/g, "$1-$2");
  for (const alt of [dotted, dashed]) {
    if (alt && allow.has(normalizeModelKey(alt))) {
      return {
        ok: true,
        bare: alt,
        tagged: taggedModelId(providerId, alt),
        substituted: true,
        reason: "alias_normalize",
        from: bare,
      };
    }
  }
  const prefs = preferredListForProvider(providerId);
  const fb = pickFallbackModel(models, null, prefs);
  if (fb) {
    return {
      ok: true,
      bare: fb,
      tagged: taggedModelId(providerId, fb),
      substituted: true,
      reason: "fallback_allowlist",
      from: bare,
      available: [...allow].slice(0, 24),
    };
  }
  return {
    ok: false,
    bare,
    tagged: taggedModelId(providerId, bare),
    substituted: false,
    reason: "empty_allowlist_after_miss",
    available: [],
  };
}

/**
 * Hardcoded defaults are last-resort only. Prefer first id from live/cached allowlist.
 * Never invent plan-gated ids (e.g. claude-sonnet-5) as default when safer ones exist.
 */
function providerDefaultBare(providerId, models) {
  const p = getProvider(providerId);
  const list = Array.isArray(models) ? models : [];
  if (list.length) {
    const prefs = preferredListForProvider(providerId);
    const fromList = pickFallbackModel(list, null, prefs);
    if (fromList) return fromList;
  }
  if (providerId === "kiro") {
    const prefs = preferredListForProvider("kiro");
    return prefs[0] || "claude-haiku-4.5";
  }
  if (providerId === "claude-code") return "claude-sonnet-4-6";
  if (providerId === "gemini-cli") return "gemini-2.5-flash";
  if (providerId === "grok") return "grok-4.5";
  if (providerId === "antigravity") return "gemini-2.5-flash";
  if (providerId === "openai") {
    const prefs = preferredListForProvider("openai");
    return prefs[0] || "gpt-5.1-codex";
  }
  return p?.defaultModel || null;
}

/**
 * Resolve model for a provider using allowlist (catalog/live/account cache).
 * Central entry used by pipeline preflight + recovery.
 */
function resolveModelForProvider(providerId, requestedModel, models) {
  const rows = Array.isArray(models) ? models : [];
  const resolved = resolveAllowedModel(providerId, requestedModel, rows);
  if (resolved.ok && resolved.bare) return resolved;
  const def = providerDefaultBare(providerId, rows);
  if (def) {
    return {
      ok: true,
      bare: def,
      tagged: taggedModelId(providerId, def),
      substituted: true,
      reason: "provider_default",
      from: bareModelId(requestedModel),
      available: [...allowlistFromModels(rows)].slice(0, 24),
    };
  }
  return resolved;
}

module.exports = {
  bareModelId,
  normalizeModelKey,
  isInvalidModelMessage,
  allowlistFromModels,
  pickFallbackModel,
  resolveAllowedModel,
  resolveModelForProvider,
  providerDefaultBare,
  preferredListForProvider,
};
