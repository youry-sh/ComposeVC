/**
 * Antigravity usage / models (Cloud Code):
 *   POST :fetchAvailableModels  — remainingFraction / resetTime
 *   POST :retrieveUserQuota     — live Gemini buckets
 *   POST :loadCodeAssist         — plan tier
 */

const creds = require("./antigravityCreds.cjs");
const { fetchFirstOk } = require("./antigravityAuth.cjs");

const ANTIGRAVITY_CATALOG = [
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", kind: "reasoning" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", kind: "chat" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", kind: "chat" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)", kind: "chat" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)", kind: "chat" },
  { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (Agent)", kind: "chat" },
  { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)", kind: "chat" },
  { id: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)", kind: "chat" },
  { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)", kind: "chat" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", kind: "chat" },
  { id: "gemini-3-pro-preview", name: "Gemini 3.1 Pro", kind: "chat" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", kind: "chat" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "chat" },
  { id: "gemini-2.5-flash-thinking", name: "Gemini 2.5 Flash Thinking", kind: "reasoning" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", kind: "chat" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", kind: "reasoning" },
];

const ANTIGRAVITY_IDS = new Set(ANTIGRAVITY_CATALOG.map((m) => m.id));

function catalogFor() {
  return ANTIGRAVITY_CATALOG;
}

function isUserCallableModel(_providerId, modelId) {
  const id = String(modelId || "").trim();
  if (!id || /tab_/i.test(id)) return false;
  if (ANTIGRAVITY_IDS.has(id)) return true;
  return /^(gemini-|claude-|gpt-oss|gemini_)/i.test(id);
}

function planLabel(_providerId, tierPlan) {
  return `${tierPlan || "Free"} · Cloud Code`;
}

/** Client id → upstream id (OmniRoute antigravityModelAliases) */
const MODEL_ALIASES = {
  "gemini-3.5-flash-low": "gemini-3.5-flash-extra-low",
  "gemini-3.5-flash-medium": "gemini-3.5-flash-low",
  "gemini-3.5-flash-high": "gemini-3-flash-agent",
  "gemini-3.5-flash-preview": "gemini-3-flash-agent",
  "gemini-3-pro-preview": "gemini-3.1-pro",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-claude-sonnet-4-5": "claude-sonnet-4-6",
  "gemini-claude-sonnet-4-5-thinking": "claude-sonnet-4-6",
  "gemini-claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
};

function resolveUpstreamModelId(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return id;
  return MODEL_ALIASES[id] || id;
}

function toRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function toNum(v, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function mapTierToPlan(tier) {
  const u = String(tier || "").toUpperCase();
  if (!u) return "Free";
  if (u.includes("ULTRA")) return "Ultra";
  if (u.includes("PRO") || u.includes("PREMIUM") || u.includes("GOOGLE_ONE") || u.includes("ONE_AI"))
    return "Pro";
  if (u.includes("ENTERPRISE")) return "Enterprise";
  if (u.includes("BUSINESS") || u.includes("STANDARD")) return "Business";
  if (u.includes("PLUS")) return "Plus";
  if (u.includes("LITE") || u.includes("LIGHT")) return "Lite";
  if (u.includes("FREE") || u.includes("INDIVIDUAL") || u.includes("LEGACY")) return "Free";
  return tier.charAt(0).toUpperCase() + String(tier).slice(1).toLowerCase();
}

function parseReset(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof v === "object") {
    // { seconds: "..." } protobuf Timestamp-like
    const sec = toNum(v.seconds ?? v.Seconds, NaN);
    if (Number.isFinite(sec)) return new Date(sec * 1000).toISOString();
  }
  return null;
}

function quotaWindow(name, remainingFraction, resetAt) {
  const frac = Math.max(0, Math.min(1, remainingFraction));
  const remainingPercent = frac * 100;
  const usedPercent = 100 - remainingPercent;
  const total = 1000;
  const remaining = Math.round(total * frac);
  const used = Math.max(0, total - remaining);
  return {
    name,
    usedPercent,
    remainingPercent,
    resetAt,
    used,
    total,
  };
}

/**
 * Aggregate model quotas into session (worst / primary) + weekly-style secondary.
 * Antigravity uses rolling ~5h windows + weekly caps; we surface:
 *   session  = most-constrained model bucket (lowest remaining)
 *   weekly   = average / second-worst if present
 */
function aggregateQuotas(modelQuotas) {
  const entries = Object.entries(modelQuotas || {});
  if (!entries.length) return {};

  const sorted = entries
    .map(([id, q]) => ({ id, ...q }))
    .filter((q) => !q.unlimited)
    .sort((a, b) => a.remainingPercent - b.remainingPercent);

  const quotas = {};
  if (sorted[0]) {
    quotas.session = {
      name: sorted[0].id.slice(0, 24),
      usedPercent: sorted[0].usedPercent,
      remainingPercent: sorted[0].remainingPercent,
      resetAt: sorted[0].resetAt,
      used: sorted[0].used,
      total: sorted[0].total,
    };
  }
  // Prefer a bucket that looks weekly (reset > 24h away) as secondary
  const now = Date.now();
  const weeklyish = sorted.find((q) => {
    if (!q.resetAt) return false;
    const ms = Date.parse(q.resetAt) - now;
    return ms > 24 * 3600 * 1000;
  });
  const secondary = weeklyish || sorted[1];
  if (secondary) {
    quotas.weekly = {
      name: secondary.id.slice(0, 24),
      usedPercent: secondary.usedPercent,
      remainingPercent: secondary.remainingPercent,
      resetAt: secondary.resetAt,
      used: secondary.used,
      total: secondary.total,
    };
  }
  return quotas;
}

async function fetchAvailableModels(accessToken, projectId) {
  const res = await fetchFirstOk(
    creds.fetchAvailableModelsUrls(),
    {
      method: "POST",
      headers: creds.headers("fetchAvailableModels", accessToken),
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    },
    12000
  );
  return res.json();
}

async function fetchUserQuota(accessToken, projectId) {
  if (!projectId) return null;
  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project: projectId }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchSubscriptionPlan(accessToken) {
  try {
    const res = await fetchFirstOk(
      creds.loadCodeAssistUrls(),
      {
        method: "POST",
        headers: creds.headers("loadCodeAssist", accessToken),
        body: JSON.stringify({ metadata: creds.loadCodeAssistMetadata() }),
      },
      8000
    );
    const data = toRecord(await res.json());
    const tier =
      data.tierId ||
      toRecord(data.currentTier).id ||
      toRecord(data.currentTier).name ||
      toRecord(data.currentTier).displayName ||
      "";
    const project = data.cloudaicompanionProject;
    const projectId =
      (typeof project === "string" ? project : null) || toRecord(project).id || null;
    return { plan: mapTierToPlan(tier), tier: String(tier || ""), projectId };
  } catch {
    return { plan: "Free", tier: null, projectId: null };
  }
}

/**
 * @param {{ accessToken: string, projectId?: string|null, providerId?: string }} opts
 */
async function fetchAntigravityUsage({ accessToken, projectId, providerId = "antigravity" }) {
  if (!accessToken) return { ok: false, error: "accessToken required" };
  const pid = "antigravity";
  void providerId;

  let sub;
  try {
    sub = await fetchSubscriptionPlan(accessToken);
  } catch (e) {
    if (String(e.message || e).includes("401")) {
      return { ok: false, expired: true, error: "Token expired — re-authenticate" };
    }
    sub = { plan: "Free", tier: null, projectId: null };
  }

  const resolvedProject = projectId || sub.projectId || null;
  const plan = planLabel(pid, sub.plan || "Free");

  let data;
  try {
    data = await fetchAvailableModels(accessToken, resolvedProject);
  } catch (e) {
    const msg = e.message || String(e);
    if (/401|403/.test(msg)) {
      return { ok: false, expired: /401/.test(msg), error: msg };
    }
    return {
      ok: true,
      usage: {
        plan,
        limitReached: false,
        quotas: {},
        note: `Could not load ${pid} quotas: ${msg}`,
        detail: { projectId: resolvedProject, providerId: pid },
      },
    };
  }

  const modelsObj = toRecord(toRecord(data).models);
  const userQuota = await fetchUserQuota(accessToken, resolvedProject);
  const userBuckets = new Map();
  if (Array.isArray(toRecord(userQuota).buckets)) {
    for (const b of userQuota.buckets) {
      const id = String(toRecord(b).modelId || "").trim();
      if (id) userBuckets.set(id, toRecord(b));
    }
  }

  const perModel = {};
  for (const [rawKey, infoVal] of Object.entries(modelsObj)) {
    const info = toRecord(infoVal);
    if (info.isInternal === true) continue;
    const modelKey = String(rawKey || "").trim();
    if (!isUserCallableModel(pid, modelKey)) continue;
    const quotaInfo = toRecord(info.quotaInfo);
    const live = userBuckets.get(modelKey);
    const src = live || quotaInfo;
    if (!Object.keys(src).length) continue;

    const rawFrac = toNum(src.remainingFraction, -1);
    if (rawFrac < 0) continue;
    const remainingFraction = Math.max(0, Math.min(1, rawFrac));
    const resetAt = parseReset(src.resetTime);
    const isUnlimited = !resetAt && remainingFraction >= 1;
    if (isUnlimited) {
      perModel[modelKey] = {
        usedPercent: 0,
        remainingPercent: 100,
        resetAt: null,
        used: 0,
        total: 0,
        unlimited: true,
      };
      continue;
    }
    const w = quotaWindow(modelKey, remainingFraction, resetAt);
    perModel[modelKey] = { ...w, unlimited: false };
  }

  // retrieveUserQuota-only buckets (still filtered per provider surface)
  for (const [modelKey, bucket] of userBuckets) {
    if (perModel[modelKey]) continue;
    if (!isUserCallableModel(pid, modelKey)) continue;
    const rawFrac = toNum(bucket.remainingFraction, -1);
    if (rawFrac < 0) continue;
    const resetAt = parseReset(bucket.resetTime);
    perModel[modelKey] = {
      ...quotaWindow(modelKey, rawFrac, resetAt),
      unlimited: false,
    };
  }

  const quotas = aggregateQuotas(perModel);
  const anyExhausted = Object.values(perModel).some(
    (q) => !q.unlimited && q.remainingPercent <= 0
  );

  return {
    ok: true,
    usage: {
      plan,
      limitReached: anyExhausted,
      quotas,
      models: perModel,
      detail: {
        projectId: resolvedProject,
        tier: sub.tier,
        providerId: pid,
        modelCount: Object.keys(perModel).length,
      },
    },
  };
}

/**
 * Live models from fetchAvailableModels (for Models pane + /v1/models).
 */
async function fetchAntigravityModels(accessToken, projectId) {
  const fallback = catalogFor().map((m) => ({
    ...m,
    object: "model",
    created: null,
    owned_by: "google",
    source: "catalog",
  }));

  if (!accessToken) return { ok: false, models: fallback };

  try {
    const data = await fetchAvailableModels(accessToken, projectId);
    const modelsObj = toRecord(toRecord(data).models);
    const list = [];
    for (const [id, infoVal] of Object.entries(modelsObj)) {
      const info = toRecord(infoVal);
      if (info.isInternal === true) continue;
      if (!isUserCallableModel("antigravity", id)) continue;
      list.push({
        id,
        object: "model",
        created: null,
        owned_by: "google",
        kind: /claude|thinking|reason/i.test(id) ? "reasoning" : "chat",
        source: "live",
        name: info.displayName || info.name || id,
      });
    }
    if (!list.length) return { ok: true, models: fallback };
    return { ok: true, models: list };
  } catch (e) {
    return {
      ok: true,
      models: fallback,
      warning: e.message || String(e),
    };
  }
}

module.exports = {
  ANTIGRAVITY_CATALOG,
  MODEL_ALIASES,
  catalogFor,
  resolveUpstreamModelId,
  fetchAntigravityUsage,
  fetchAntigravityModels,
  mapTierToPlan,
  isUserCallableModel,
};
