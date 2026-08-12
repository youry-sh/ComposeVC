/**
 * Claude Code OAuth usage:
 *   GET https://api.anthropic.com/api/oauth/usage
 * Windows: five_hour (session), seven_day (weekly), seven_day_* (per-model).
 */

const creds = require("./claudeCodeCreds.cjs");

// Claude Code has no model-list API for subscription OAuth. Keep this catalog
// aligned with the official Claude Code model configuration documentation.
// Plan-gated models are real selections but can still be rejected for accounts
// whose organization does not have access.
const CLAUDE_CODE_CATALOG = [
  { id: "claude-fable-5", name: "Claude Fable 5", kind: "reasoning" },
  { id: "claude-opus-5", name: "Claude Opus 5", kind: "reasoning" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", kind: "chat" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", kind: "reasoning" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", kind: "reasoning" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", kind: "reasoning" },
  { id: "claude-opus-4-5", name: "Claude Opus 4.5", kind: "reasoning" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", kind: "chat" },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", kind: "chat" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5 (pinned)", kind: "chat" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", kind: "chat" },
  { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", kind: "chat" },
];

function catalogFor() {
  return CLAUDE_CODE_CATALOG;
}

function toRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function safePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, n));
}

function parseResetTime(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : v.trim();
  }
  return null;
}

function createQuotaObject(window) {
  const used = safePct(window.utilization);
  if (used === undefined) return null;
  const remaining = Math.max(0, 100 - used);
  return {
    usedPercent: used,
    remainingPercent: remaining,
    used,
    total: 100,
    remaining,
    resetAt: parseResetTime(window.resets_at || window.reset_at || window.resetsAt),
    name: undefined,
  };
}

function getClaudePlanLabel(...candidates) {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (low === "claude code" || low === "unknown") continue;
    return t;
  }
  return null;
}

/**
 * @param {{ accessToken: string }} opts
 */
async function fetchClaudeCodeUsage({ accessToken } = {}) {
  if (!accessToken) {
    return { ok: false, error: "No access token", expired: true };
  }

  try {
    const res = await fetch(creds.OAUTH_USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": creds.claudeCodeUsageUserAgent(),
        "anthropic-beta": creds.ANTHROPIC_BETA_OAUTH,
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (res.status === 401 || res.status === 403) {
      const t = await res.text().catch(() => "");
      return {
        ok: false,
        expired: true,
        error: `Auth failed (${res.status}): ${t.slice(0, 160)}`,
      };
    }

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Claude usage ${res.status}: ${t.slice(0, 200)}`,
      };
    }

    const data = toRecord(await res.json());
    const quotas = {};

    const fiveHour = createQuotaObject(toRecord(data.five_hour));
    if (fiveHour) {
      fiveHour.name = "session_5h";
      // UI Usage column reads quotas.session (Codex contract) — alias all names
      quotas.session = fiveHour;
      quotas.primary = fiveHour;
      quotas.session_5h = fiveHour;
    }

    const sevenDay = createQuotaObject(toRecord(data.seven_day));
    if (sevenDay) {
      sevenDay.name = "weekly";
      quotas.weekly = sevenDay;
      quotas.secondary = sevenDay;
    }

    const MODEL_DISPLAY = { omelette: "designer" };
    for (const [key, value] of Object.entries(data)) {
      if (!key.startsWith("seven_day_") || key === "seven_day") continue;
      const q = createQuotaObject(toRecord(value));
      if (!q) continue;
      const codename = key.replace("seven_day_", "");
      const modelName = MODEL_DISPLAY[codename] || codename;
      q.name = `weekly_${modelName}`;
      quotas[`weekly_${modelName}`] = q;
    }

    const plan =
      getClaudePlanLabel(
        typeof data.tier === "string" ? data.tier : null,
        typeof data.plan === "string" ? data.plan : null,
        typeof data.subscription_type === "string" ? data.subscription_type : null
      ) || "Claude Code";

    const windows = Object.values(quotas);
    const limitReached = windows.some(
      (q) => q && (q.remainingPercent <= 0.5 || q.usedPercent >= 99.5)
    );

    return {
      ok: true,
      usage: {
        plan,
        limitReached,
        quotas,
        note: plan,
        detail: {
          extraUsage: data.extra_usage ?? null,
          rawKeys: Object.keys(data),
        },
        rawUpdatedAt: Date.now(),
      },
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  catalogFor,
  fetchClaudeCodeUsage,
  CLAUDE_CODE_CATALOG,
};
