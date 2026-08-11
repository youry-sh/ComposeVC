/**
 * Codex / ChatGPT subscription usage (OmniRoute parity).
 * GET https://chatgpt.com/backend-api/wham/usage
 */

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function toNum(v, fb = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fb;
  }
  return fb;
}

function field(obj, ...keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function parseReset(window) {
  const resetAt = toNum(field(window, "reset_at", "resetAt"), 0);
  const resetAfter = toNum(field(window, "reset_after_seconds", "resetAfterSeconds"), 0);
  if (resetAt > 0) {
    const ms = resetAt < 1e12 ? resetAt * 1000 : resetAt;
    return new Date(ms).toISOString();
  }
  if (resetAfter > 0) return new Date(Date.now() + resetAfter * 1000).toISOString();
  return null;
}

function quotaName(window, fallback) {
  const seconds = toNum(field(window, "limit_window_seconds", "limitWindowSeconds"), 0);
  if (seconds > 0 && seconds <= 6 * 60 * 60) return "session";
  if (seconds > 6 * 60 * 60 && seconds <= 36 * 60 * 60) return "daily";
  if (seconds >= 6 * 24 * 60 * 60) return "weekly";
  return fallback;
}

function uniqueQuotaKey(quotas, base) {
  if (!quotas[base]) return base;
  let index = 2;
  while (quotas[`${base}_${index}`]) index += 1;
  return `${base}_${index}`;
}

function windowQuota(window, name) {
  if (!window || typeof window !== "object" || !Object.keys(window).length) return null;
  const used = toNum(field(window, "used_percent", "usedPercent"), 0);
  return {
    name,
    usedPercent: Math.min(100, Math.max(0, used)),
    remainingPercent: Math.min(100, Math.max(0, 100 - used)),
    resetAt: parseReset(window),
  };
}

function hasWindow(window) {
  return Boolean(window && typeof window === "object" && Object.keys(window).length);
}

function addQuota(quotas, window, fallback) {
  const name = quotaName(window, fallback);
  const quota = windowQuota(window, name);
  if (quota) quotas[uniqueQuotaKey(quotas, name)] = quota;
}

function buildQuotas(data) {
  const rateLimit = field(data, "rate_limit", "rateLimit") || {};
  const primary = field(rateLimit, "primary_window", "primaryWindow") || {};
  const secondary = field(rateLimit, "secondary_window", "secondaryWindow") || {};
  const quotas = {};
  const hasPrimary = hasWindow(primary);

  if (hasPrimary) addQuota(quotas, primary, "session");
  if (hasWindow(secondary)) addQuota(quotas, secondary, hasPrimary ? "weekly" : "session");

  const additional = field(data, "additional_rate_limits", "additionalRateLimits");
  if (Array.isArray(additional)) {
    for (const limit of additional) {
      if (!limit || typeof limit !== "object") continue;
      const id = String(field(limit, "id", "title") || "model").trim() || "model";
      addQuota(quotas, field(limit, "primary_window", "primaryWindow") || {}, `${id}_primary`);
      addQuota(quotas, field(limit, "secondary_window", "secondaryWindow") || {}, `${id}_secondary`);
    }
  }

  const review = field(data, "code_review_rate_limit", "codeReviewRateLimit") || null;
  if (review && typeof review === "object") {
    addQuota(quotas, field(review, "primary_window", "primaryWindow") || review, "code_review");
  }

  const plan = String(field(data, "plan_type", "planType") || "unknown");
  const allowed = field(rateLimit, "allowed");
  const limitReached = Boolean(field(rateLimit, "limit_reached", "limitReached")) || allowed === false;

  return {
    plan,
    limitReached,
    quotas,
    rawUpdatedAt: Date.now(),
  };
}

async function fetchCodexUsage({ accessToken, workspaceId }) {
  if (!accessToken) throw new Error("accessToken required");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (workspaceId) headers["chatgpt-account-id"] = workspaceId;

  const res = await fetch(USAGE_URL, { method: "GET", headers });
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      expired: true,
      error: "Token expired or access denied — re-authenticate",
    };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `Usage API ${res.status}: ${t.slice(0, 160)}` };
  }
  const data = await res.json();
  const usage = buildQuotas(data);
  return { ok: true, usage };
}

module.exports = {
  USAGE_URL,
  buildQuotas,
  fetchCodexUsage,
};
