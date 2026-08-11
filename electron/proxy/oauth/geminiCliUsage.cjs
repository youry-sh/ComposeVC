/**
 * Gemini CLI models + usage via Cloud Code Assist.
 * Quotas use keys session/weekly (same as Antigravity / Proxy UI).
 */

const creds = require("./geminiCliCreds.cjs");
const {
  fetchFirstOk,
  ensureProjectAssigned,
  collectPreferredProjects,
} = require("./geminiCliAuth.cjs");

/**
 * Models that actually work on gemini-cli Cloud Code OAuth (verified 2026-07).
 * Antigravity-only ids (gemini-3.1-pro-high, claude-*, …) return 404 NOT_FOUND.
 */
const GEMINI_CLI_CATALOG = [
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", kind: "chat" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "chat" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", kind: "chat" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", kind: "chat" },
];

const GEMINI_CLI_KNOWN = new Set(GEMINI_CLI_CATALOG.map((m) => m.id));

/** Map common / Antigravity names → gemini-cli surface */
const MODEL_ALIASES = {
  // bare / tagged noise
  "gemini-cli/gemini-2.5-pro": "gemini-2.5-pro",
  "gemini-cli/gemini-2.5-flash": "gemini-2.5-flash",
  "gc/gemini-2.5-pro": "gemini-2.5-pro",
  // antigravity / preview names → closest gemini-cli model
  "gemini-3.1-pro-high": "gemini-2.5-pro",
  "gemini-3.1-pro-low": "gemini-2.5-pro",
  "gemini-3.1-pro": "gemini-2.5-pro",
  "gemini-3-pro-preview": "gemini-2.5-pro",
  "gemini-3-pro": "gemini-2.5-pro",
  "gemini-pro": "gemini-2.5-pro",
  "gemini-pro-agent": "gemini-2.5-pro",
  "gemini-2.5-pro-preview": "gemini-2.5-pro",
  "gemini-2.0-flash": "gemini-2.5-flash",
  "gemini-1.5-pro": "gemini-2.5-pro",
  "gemini-1.5-flash": "gemini-2.5-flash",
  "gemini-3-flash": "gemini-2.5-flash",
  "gemini-3-flash-agent": "gemini-2.5-flash",
  "gemini-3-flash-preview": "gemini-2.5-flash",
  "gemini-3.5-flash-low": "gemini-2.5-flash",
  "gemini-3.5-flash-medium": "gemini-2.5-flash",
  "gemini-3.5-flash-high": "gemini-2.5-flash",
  "gemini-3.5-flash-extra-low": "gemini-2.5-flash",
  "gemini-2.5-flash-thinking": "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite",
};

const DEFAULT_FALLBACK_MODEL = "gemini-2.5-flash";

function catalogFor() {
  return GEMINI_CLI_CATALOG;
}

/**
 * Resolve client model id to a gemini-cli upstream id that won't 404.
 * @returns {{ model: string, mappedFrom?: string|null, known: boolean }}
 */
function resolveUpstreamModelId(modelId) {
  let id = String(modelId || "")
    .trim()
    .replace(/^models\//, "")
    .replace(/^gemini-cli\//i, "")
    .replace(/^gc\//i, "")
    .replace(/^gemini\//i, "");
  if (!id) return { model: DEFAULT_FALLBACK_MODEL, mappedFrom: null, known: true };

  if (MODEL_ALIASES[id]) {
    return {
      model: MODEL_ALIASES[id],
      mappedFrom: id,
      known: GEMINI_CLI_KNOWN.has(MODEL_ALIASES[id]),
    };
  }
  if (GEMINI_CLI_KNOWN.has(id)) {
    return { model: id, mappedFrom: null, known: true };
  }
  // Heuristic: anything "pro" → 2.5-pro, else flash
  if (/pro/i.test(id) && !/flash/i.test(id)) {
    return { model: "gemini-2.5-pro", mappedFrom: id, known: false };
  }
  if (/lite/i.test(id)) {
    return { model: "gemini-3.1-flash-lite", mappedFrom: id, known: false };
  }
  if (/flash|fast|mini/i.test(id)) {
    return { model: "gemini-2.5-flash", mappedFrom: id, known: false };
  }
  // Unknown → safe default (avoids hard 404)
  return { model: DEFAULT_FALLBACK_MODEL, mappedFrom: id, known: false };
}

function isModelNotFoundError(status, message) {
  if (status !== 404) return false;
  const m = String(message || "").toLowerCase();
  return (
    m.includes("not found") ||
    m.includes("requested entity") ||
    m.includes("not_found")
  );
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
  if (u.includes("PRO") || u.includes("PREMIUM") || u.includes("GOOGLE_ONE")) return "Pro";
  if (u.includes("ENTERPRISE")) return "Enterprise";
  if (u.includes("STANDARD")) return "Standard · GCP project";
  if (u.includes("PLUS")) return "Plus";
  if (u.includes("FREE") || u.includes("INDIVIDUAL") || u.includes("LEGACY")) return "Free";
  return String(tier).charAt(0).toUpperCase() + String(tier).slice(1).toLowerCase();
}

function parseReset(v) {
  if (!v) return null;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof v === "object") {
    const sec = toNum(v.seconds ?? v.Seconds, NaN);
    if (Number.isFinite(sec)) return new Date(sec * 1000).toISOString();
  }
  return null;
}

function quotaWindow(name, remainingFraction, resetAt) {
  const frac = Math.max(0, Math.min(1, remainingFraction));
  const remainingPercent = Math.round(frac * 1000) / 10;
  const usedPercent = Math.round((100 - remainingPercent) * 10) / 10;
  return {
    name,
    usedPercent,
    remainingPercent,
    resetAt,
    used: Math.round(usedPercent * 10),
    total: 1000,
  };
}

function aggregateSessionWeekly(perModel) {
  const entries = Object.entries(perModel || {});
  if (!entries.length) return {};
  const sorted = entries
    .map(([id, q]) => ({ id, ...q }))
    .sort((a, b) => a.remainingPercent - b.remainingPercent);
  const quotas = {};
  if (sorted[0]) {
    quotas.session = {
      name: sorted[0].id.slice(0, 28),
      usedPercent: sorted[0].usedPercent,
      remainingPercent: sorted[0].remainingPercent,
      resetAt: sorted[0].resetAt,
      used: sorted[0].used,
      total: sorted[0].total,
    };
  }
  const now = Date.now();
  const weeklyish = sorted.find((q) => {
    if (!q.resetAt) return false;
    return Date.parse(q.resetAt) - now > 24 * 3600 * 1000;
  });
  const secondary = weeklyish || sorted[1] || sorted[0];
  if (secondary) {
    quotas.weekly = {
      name: secondary.id.slice(0, 28),
      usedPercent: secondary.usedPercent,
      remainingPercent: secondary.remainingPercent,
      resetAt: secondary.resetAt,
      used: secondary.used,
      total: secondary.total,
    };
  }
  return quotas;
}

/**
 * Fetch usage + models for a Gemini CLI oauth account.
 * @param {{ accessToken: string, projectId?: string|null, email?: string|null, accounts?: any[] }} opts
 */
async function fetchGeminiCliUsage(opts = {}) {
  const { accessToken, projectId, email, accounts } = opts;
  if (!accessToken) return { ok: false, error: "no access token" };

  let tier = null;
  let resolvedProject = projectId || null;
  let usageError = null;
  let projectNote = null;
  const perModel = {};

  try {
    const disc = await ensureProjectAssigned(accessToken, {
      preferredProjectId: projectId,
      email,
      accounts,
    });
    if (disc.projectId) resolvedProject = disc.projectId;
    if (disc.tier) tier = disc.tier;
    if (disc.note || disc.softWarning) projectNote = disc.note || disc.softWarning;
    // Missing project is soft (OmniRoute #338) — do not fail usage fetch
  } catch (e) {
    projectNote = e.message || String(e);
  }

  // retrieveUserQuota is reliable; fetchAvailableModels often 403 for gemini-cli client
  if (resolvedProject) {
    try {
      const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": creds.geminiCliUserAgent(),
        },
        body: JSON.stringify({ project: resolvedProject }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const q = toRecord(await res.json());
        if (Array.isArray(q.buckets)) {
          for (const b of q.buckets) {
            const br = toRecord(b);
            const modelId = String(br.modelId || br.model || "").trim();
            if (!modelId) continue;
            const rem =
              br.remainingFraction != null ? toNum(br.remainingFraction, 1) : null;
            if (rem == null) continue;
            const resetAt = parseReset(br.resetTime);
            perModel[modelId] = quotaWindow(modelId, rem, resetAt);
          }
        }
      } else {
        const t = await res.text().catch(() => "");
        if (!usageError) usageError = `retrieveUserQuota ${res.status}: ${t.slice(0, 160)}`;
      }
    } catch (e) {
      if (!usageError) usageError = e.message || String(e);
    }
  }

  // Best-effort live model list (may 403)
  const liveModels = [];
  try {
    const res = await fetchFirstOk(
      creds.fetchAvailableModelsUrls(),
      {
        method: "POST",
        headers: creds.headers("models", accessToken),
        body: JSON.stringify(resolvedProject ? { project: resolvedProject } : {}),
      },
      12000
    );
    const data = toRecord(await res.json());
    const modelsRaw = data.models || data.availableModels || data.modelInfos || {};
    let entries = [];
    if (Array.isArray(modelsRaw)) {
      entries = modelsRaw.map((m) => {
        const rec = toRecord(m);
        const id = String(rec.name || rec.id || rec.model || "").replace(/^models\//, "");
        return [id, rec];
      });
    } else if (modelsRaw && typeof modelsRaw === "object") {
      entries = Object.entries(modelsRaw);
    }

    for (const [rawId, infoVal] of entries) {
      const rec = toRecord(infoVal);
      const bare = String(rawId || rec.name || rec.id || "")
        .replace(/^models\//, "")
        .split("/")
        .pop();
      if (!bare || /tab_/i.test(bare)) continue;
      if (rec.isInternal === true) continue;
      if (!/^gemini/i.test(bare) && !/flash|pro/i.test(bare)) continue;

      const fracRaw =
        rec.remainingFraction ??
        rec.quotaInfo?.remainingFraction ??
        rec.remaining_fraction;
      const frac = fracRaw != null ? toNum(fracRaw, 1) : null;
      const resetAt = parseReset(
        rec.resetTime || rec.quotaInfo?.resetTime || rec.resetAt
      );

      liveModels.push({
        id: bare,
        name: rec.displayName || rec.name || bare,
        kind: /think|reason/i.test(bare) ? "reasoning" : "chat",
        source: "live",
        remainingFraction: frac ?? 1,
        resetAt,
      });

      if (frac != null && !perModel[bare]) {
        perModel[bare] = quotaWindow(bare, frac, resetAt);
      }
    }
  } catch {
    /* models list optional */
  }

  let quotas = aggregateSessionWeekly(perModel);

  // Always expose session so UI is not blank when project is bound
  if (!quotas.session && resolvedProject) {
    quotas.session = {
      name: "Code Assist",
      usedPercent: 0,
      remainingPercent: 100,
      resetAt: null,
      used: 0,
      total: 1000,
    };
  }
  if (!quotas.session && !resolvedProject) {
    quotas = {};
  }

  const plan = mapTierToPlan(tier);
  const session = quotas.session;
  const limitReached =
    session && session.remainingPercent != null ? session.remainingPercent <= 0.5 : false;

  return {
    ok: true,
    usage: {
      plan,
      limitReached,
      quotas,
      models: perModel,
      note: usageError || projectNote || null,
      detail: {
        projectId: resolvedProject,
        tier,
        source: "gemini-cli cloudcode",
        liveModelCount: liveModels.length,
        preferredTried: collectPreferredProjects({
          preferredProjectId: projectId,
          email,
          accounts,
        }),
        error: usageError || null,
      },
    },
    models: liveModels.length ? liveModels : null,
    projectId: resolvedProject,
    tier,
    error: usageError,
  };
}

module.exports = {
  catalogFor,
  fetchGeminiCliUsage,
  resolveUpstreamModelId,
  isModelNotFoundError,
  GEMINI_CLI_CATALOG,
  GEMINI_CLI_KNOWN,
  DEFAULT_FALLBACK_MODEL,
};
