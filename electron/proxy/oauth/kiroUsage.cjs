/**
 * Kiro usage / quota + model catalog (OmniRoute GetUsageLimits + ListAvailableModels).
 */

const creds = require("./kiroCreds.cjs");
const { discoverProfileArn } = require("./kiroAuth.cjs");

function catalogFor() {
  return creds.FALLBACK_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    owned_by: m.owned_by || "kiro",
    kind: "chat",
  }));
}

function parseResetTime(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // seconds or ms
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function buildQuota(used, total, resetAt, overageEnabled) {
  const remaining = Math.max(0, total - used);
  const usedPercent = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  if (overageEnabled) {
    return {
      name: "credits",
      used,
      total,
      remaining,
      usedPercent: 0,
      resetAt,
      unlimited: true,
    };
  }
  return {
    name: "credits",
    used,
    total,
    remaining,
    usedPercent,
    resetAt,
    unlimited: false,
  };
}

function isOverageEnabled(data) {
  const overageConfiguration =
    data.overageConfiguration && typeof data.overageConfiguration === "object"
      ? data.overageConfiguration
      : {};
  const overageStatus = String(overageConfiguration.overageStatus || "")
    .trim()
    .toUpperCase();
  return (
    overageStatus === "ENABLED" ||
    data.overageEnabled === true ||
    overageConfiguration.overageEnabled === true
  );
}

function buildUsageFromLimits(data) {
  const usageList = Array.isArray(data.usageBreakdownList) ? data.usageBreakdownList : [];
  const quotas = {};
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);
  const overageEnabled = isOverageEnabled(data);

  for (const row of usageList) {
    const breakdown = row && typeof row === "object" ? row : {};
    const resourceType =
      typeof breakdown.resourceType === "string"
        ? breakdown.resourceType.toLowerCase()
        : "unknown";
    const used = Number(breakdown.currentUsageWithPrecision ?? breakdown.currentUsage ?? 0) || 0;
    const total = Number(breakdown.usageLimitWithPrecision ?? breakdown.usageLimit ?? 0) || 0;
    const q = buildQuota(used, total, resetAt, overageEnabled);
    q.name = resourceType;
    quotas[resourceType] = q;

    // Free-trial sub-window (OmniRoute parity) — surface as secondary/weekly when present
    const freeTrialInfo =
      breakdown.freeTrialInfo && typeof breakdown.freeTrialInfo === "object"
        ? breakdown.freeTrialInfo
        : null;
    if (freeTrialInfo) {
      const freeUsed =
        Number(freeTrialInfo.currentUsageWithPrecision ?? freeTrialInfo.currentUsage ?? 0) || 0;
      const freeTotal =
        Number(freeTrialInfo.usageLimitWithPrecision ?? freeTrialInfo.usageLimit ?? 0) || 0;
      if (freeTotal > 0 || freeUsed > 0) {
        const fq = buildQuota(freeUsed, freeTotal, resetAt, overageEnabled);
        fq.name = `${resourceType}_freetrial`;
        quotas[`${resourceType}_freetrial`] = fq;
      }
    }
  }

  if (!Object.keys(quotas).length) {
    return {
      ok: true,
      usage: {
        plan:
          String(data.subscriptionInfo?.subscriptionTitle || "").trim() || "Kiro",
        quotas: {},
        note:
          "Kiro connected, but the account returned no usage breakdown. Some AWS IAM / Builder ID accounts don't expose per-resource quota via GetUsageLimits.",
      },
    };
  }

  // Primary window for router + UI Usage column (must be quotas.session — UI contract)
  const primary =
    quotas.agentic_request ||
    quotas.credit ||
    quotas.CREDIT ||
    Object.values(quotas).find((q) => q && !String(q.name || "").includes("freetrial")) ||
    Object.values(quotas)[0];

  // Secondary / Weekly column: free-trial or a second distinct resource if present
  const secondary =
    quotas.agentic_request_freetrial ||
    quotas.credit_freetrial ||
    Object.values(quotas).find(
      (q) =>
        q &&
        q !== primary &&
        (String(q.name || "").includes("freetrial") ||
          String(q.name || "").includes("bonus") ||
          String(q.name || "").includes("week"))
    ) ||
    null;

  // UI reads quotas.session (Usage) and quotas.weekly (Weekly) — same contract as Codex.
  // Keep raw resource keys for debugging / router.
  if (primary) {
    const sessionQ = { ...primary, name: primary.name || "session" };
    quotas.session = sessionQ;
    quotas.primary = sessionQ;
  }
  if (secondary) {
    const weeklyQ = {
      ...secondary,
      name:
        String(secondary.name || "").includes("freetrial")
          ? "weekly"
          : secondary.name || "weekly",
    };
    // Prefer label "weekly" for the Weekly column
    weeklyQ.name = "weekly";
    quotas.weekly = weeklyQ;
    quotas.secondary = weeklyQ;
  } else if (primary && !quotas.weekly) {
    // Single window accounts: mirror primary into weekly so Weekly is not silent "—"
    // when Kiro only returns one breakdown row (common for Builder ID).
    quotas.weekly = { ...primary, name: "weekly" };
    quotas.secondary = quotas.weekly;
  }

  return {
    ok: true,
    usage: {
      plan: String(data.subscriptionInfo?.subscriptionTitle || "").trim() || "Kiro",
      quotas,
      // flat helpers used by UI BalanceCell/QuotaCell / router
      used: primary?.used,
      total: primary?.total,
      remaining: primary?.remaining,
      usedPercent: primary?.usedPercent,
      resetAt: primary?.resetAt,
      detail: { overageEnabled, resourceTypes: Object.keys(quotas) },
    },
  };
}

async function fetchKiroUsage({ accessToken, providerMeta = {} } = {}) {
  if (!accessToken) return { ok: false, error: "missing access token" };
  try {
    let profileArn =
      typeof providerMeta.profileArn === "string" ? providerMeta.profileArn : undefined;
    const region = creds.resolveRegion(providerMeta);
    const usageBaseUrl = creds.usageHost(region);

    if (!profileArn) {
      profileArn = (await discoverProfileArn(accessToken, region)) || undefined;
    }

    if (!profileArn) {
      // Soft success with note — accounts layer should surface note, not silent empty quotas.
      return {
        ok: true,
        usage: {
          plan: "Kiro",
          quotas: {},
          note: "Kiro connected. Profile ARN not available for quota tracking — re-login or wait for profile discovery.",
        },
        profileArn: null,
        region,
        softError: "profile_arn_missing",
      };
    }

    const response = await fetch(usageBaseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
        Accept: "application/json",
      },
      body: JSON.stringify({
        origin: "AI_EDITOR",
        profileArn,
        resourceType: "AGENTIC_REQUEST",
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          expired: response.status === 401,
          error: `Kiro quota API ${response.status}: ${text.slice(0, 200) || "auth failed"}`,
          profileArn,
          region,
        };
      }
      return {
        ok: false,
        error: `Kiro API error (${response.status}): ${text.slice(0, 300)}`,
        profileArn,
        region,
      };
    }

    const data = await response.json();
    const built = buildUsageFromLimits(data);
    return { ...built, profileArn, region };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function fetchLiveModels({ accessToken, providerMeta = {} } = {}) {
  if (!accessToken) return { ok: false, models: catalogFor(), source: "fallback" };
  const region = creds.resolveRegion(providerMeta);
  const urls = [
    `https://q.${region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`,
  ];
  if (region !== "us-east-1") {
    urls.push("https://q.us-east-1.amazonaws.com/ListAvailableModels?origin=AI_EDITOR");
  }
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const items = Array.isArray(data.models)
        ? data.models
        : Array.isArray(data.availableModels)
          ? data.availableModels
          : [];
      const models = [];
      const seen = new Set();
      for (const it of items) {
        const id = String(it.modelId || it.id || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          id,
          name: String(it.modelName || it.name || id),
          owned_by: "kiro",
          kind: "chat",
        });
      }
      if (models.length) return { ok: true, models, source: "api" };
    } catch {
      /* try next */
    }
  }
  return { ok: true, models: catalogFor(), source: "fallback" };
}

module.exports = {
  catalogFor,
  fetchKiroUsage,
  fetchLiveModels,
  buildUsageFromLimits,
};
