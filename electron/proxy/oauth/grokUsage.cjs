/**
 * Grok Build CLI usage / plan (cli-chat-proxy.grok.com)
 *   GET /v1/user                  — profile, hasGrokCodeAccess
 *   GET /v1/billing               — monthlyLimit / used / calendar month
 *   GET /v1/billing?format=credits — weekly SuperGrok window (creditUsagePercent + reset)
 *   JWT claims                    — tier
 */

const { parseJwtPayload, CLI_PROXY_BASE } = require("./grokAuth.cjs");

const CLI_HEADERS_BASE = {
  Accept: "application/json",
  "x-grok-client-version": "0.2.91",
  "x-grok-client-identifier": "grok_cli_rs",
  "User-Agent": "grok-cli/0.2.91",
};

function numVal(obj, fallback = 0) {
  if (obj == null) return fallback;
  if (typeof obj === "number") return obj;
  if (typeof obj === "object" && obj.val != null) return Number(obj.val) || fallback;
  return Number(obj) || fallback;
}

function tierLabel(tier) {
  const t = Number(tier);
  if (!Number.isFinite(t)) return null;
  // JWT tier from Grok CLI OAuth (subscription / team tier, not API spend tier)
  if (t >= 4) return `Tier ${t} · SuperGrok / Premium`;
  if (t === 3) return `Tier ${t} · Pro`;
  if (t === 2) return `Tier ${t}`;
  if (t === 1) return `Tier ${t} · Basic`;
  return `Tier ${t}`;
}

function isWeeklyPeriod(period) {
  if (!period) return false;
  const t = String(period.type || period.periodType || "").toUpperCase();
  return t.includes("WEEKLY") || t === "WEEKLY";
}

/**
 * Build a quota window from percent + optional absolute used/total + reset ISO.
 */
function quotaFromPercent({ name, usedPercent, resetAt, used, total }) {
  const pct = Math.min(100, Math.max(0, Number(usedPercent) || 0));
  return {
    name,
    usedPercent: pct,
    remainingPercent: Math.min(100, Math.max(0, 100 - pct)),
    resetAt: resetAt || null,
    used: used != null ? Number(used) : undefined,
    total: total != null ? Number(total) : undefined,
  };
}

async function cliGet(accessToken, path) {
  const url = `${CLI_PROXY_BASE.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...CLI_HEADERS_BASE,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { ok: res.ok, status: res.status, json, text: text.slice(0, 400) };
}

/**
 * @param {{ accessToken: string, refreshToken?: string }} creds
 */
function isAuthDenied(res) {
  if (!res) return false;
  if (res.status === 401 || res.status === 403) return true;
  const hay = `${res.text || ""}\n${JSON.stringify(res.json || {})}`.toLowerCase();
  return /invalid.?token|token expired|unauthori[sz]ed|not authenticated|access.?denied|invalid_grant/.test(
    hay
  );
}

async function fetchGrokUsage({ accessToken }) {
  if (!accessToken) {
    return { ok: false, error: "accessToken required" };
  }

  const jwt = parseJwtPayload(accessToken);
  const tier = jwt.claims?.tier;
  const planFromJwt = tierLabel(tier);
  const jwtExpired =
    typeof jwt.exp === "number" && Number.isFinite(jwt.exp) && jwt.exp * 1000 <= Date.now();

  const [userRes, billingRes, creditsRes] = await Promise.all([
    cliGet(accessToken, "/user"),
    cliGet(accessToken, "/billing"),
    cliGet(accessToken, "/billing?format=credits"),
  ]);

  if (isAuthDenied(userRes)) {
    return {
      ok: false,
      expired: true,
      error: "Grok token expired — re-authenticate (browser or Import CLI)",
      status: userRes.status,
    };
  }

  if (
    isAuthDenied(billingRes) &&
    isAuthDenied(creditsRes) &&
    !userRes.ok &&
    (jwtExpired || userRes.status === 0)
  ) {
    return {
      ok: false,
      expired: true,
      error: "Grok token expired — re-authenticate (browser or Import CLI)",
      status: billingRes.status || creditsRes.status || userRes.status,
    };
  }

  const user = userRes.ok ? userRes.json : null;
  const billing = billingRes.ok ? billingRes.json?.config || billingRes.json : null;
  const credits = creditsRes.ok ? creditsRes.json?.config || creditsRes.json : null;

  if (!user && !billing && !credits) {
    if (planFromJwt || jwt.email) {
      return {
        ok: true,
        usage: {
          plan: planFromJwt || "Grok CLI",
          limitReached: false,
          quotas: {},
          note: "Paid billing unavailable — free daily window tracked from live requests",
          detail: {
            email: jwt.email || null,
            name: null,
            hasGrokCodeAccess: false,
            principalType: jwt.claims?.principal_type || null,
            tier: tier != null ? Number(tier) : null,
            billingUnavailable: true,
            userStatus: userRes.status,
            billingStatus: billingRes.status,
            creditsStatus: creditsRes.status,
          },
        },
      };
    }
    return {
      ok: false,
      expired: false,
      error: `Could not load Grok usage (user ${userRes.status}, billing ${billingRes.status}, credits ${creditsRes.status})`,
    };
  }

  // ── Monthly (calendar / dollar credits on default /billing) ──
  const monthlyLimit = billing ? numVal(billing.monthlyLimit, 0) : 0;
  const used = billing ? numVal(billing.used, 0) : 0;
  const onDemandCap = billing ? numVal(billing.onDemandCap, 0) : 0;
  const periodStart = billing?.billingPeriodStart || null;
  const periodEnd = billing?.billingPeriodEnd || null;

  const monthlyUsedPercent =
    monthlyLimit > 0 ? Math.min(100, Math.max(0, (used / monthlyLimit) * 100)) : 0;

  // ── Weekly SuperGrok (format=credits) ──
  // Example:
  //   currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end }
  //   creditUsagePercent: 57
  //   productUsage: [{ product: "GrokBuild", usagePercent: 57 }, ...]
  const creditUsagePercent =
    credits != null && Number.isFinite(Number(credits.creditUsagePercent))
      ? Number(credits.creditUsagePercent)
      : null;

  const productUsage = Array.isArray(credits?.productUsage) ? credits.productUsage : [];
  const grokBuildProduct = productUsage.find(
    (p) => /grokbuild|grok.?build|code/i.test(String(p?.product || ""))
  );
  const weeklyProductPercent =
    grokBuildProduct != null && Number.isFinite(Number(grokBuildProduct.usagePercent))
      ? Number(grokBuildProduct.usagePercent)
      : null;

  const weeklyUsedPercent =
    weeklyProductPercent != null
      ? weeklyProductPercent
      : creditUsagePercent != null
        ? creditUsagePercent
        : null;

  const creditsPeriod = credits?.currentPeriod || null;
  const weeklyResetAt =
    creditsPeriod?.end ||
    credits?.billingPeriodEnd ||
    (isWeeklyPeriod(creditsPeriod) ? creditsPeriod?.end : null) ||
    null;
  const weeklyStartAt = creditsPeriod?.start || credits?.billingPeriodStart || null;
  const weeklyIsWeekly =
    isWeeklyPeriod(creditsPeriod) ||
    // If format=credits returns a short window (~7d), treat as weekly SuperGrok
    (weeklyResetAt &&
      weeklyStartAt &&
      Date.parse(weeklyResetAt) - Date.parse(weeklyStartAt) <= 8 * 24 * 3600 * 1000);

  let plan =
    planFromJwt ||
    (user?.hasGrokCodeAccess ? "Grok Code / SuperGrok" : null) ||
    user?.principalType ||
    "Grok CLI";

  if (user?.hasGrokCodeAccess && planFromJwt) {
    plan = `${planFromJwt}${user.hasGrokCodeAccess ? " · Code" : ""}`;
  } else if (user?.hasGrokCodeAccess && !planFromJwt) {
    plan = "Grok Code access";
  }

  const quotas = {};

  // Primary Usage column: monthly dollar/credits budget (calendar month)
  if (monthlyLimit > 0) {
    quotas.session = quotaFromPercent({
      name: "monthly",
      usedPercent: monthlyUsedPercent,
      resetAt: periodEnd,
      used,
      total: monthlyLimit,
    });
  }

  // Secondary column: Weekly SuperGrok Limit (the one CLI shows as "57% used / Resets …")
  if (weeklyUsedPercent != null) {
    quotas.weekly = quotaFromPercent({
      name: weeklyIsWeekly ? "supergrok" : "credits",
      usedPercent: weeklyUsedPercent,
      resetAt: weeklyResetAt,
    });
  } else if (onDemandCap > 0) {
    // Fallback only when credits endpoint missing
    quotas.weekly = quotaFromPercent({
      name: "on_demand",
      usedPercent: 0,
      resetAt: periodEnd,
      used: 0,
      total: onDemandCap,
    });
  }

  const weeklyExhausted = weeklyUsedPercent != null && weeklyUsedPercent >= 100;
  const monthlyExhausted = monthlyLimit > 0 && used >= monthlyLimit;

  return {
    ok: true,
    usage: {
      plan,
      limitReached: weeklyExhausted || monthlyExhausted,
      quotas,
      detail: {
        email: user?.email || jwt.email || null,
        name: user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : null,
        hasGrokCodeAccess: Boolean(user?.hasGrokCodeAccess),
        principalType: user?.principalType || jwt.claims?.principal_type || null,
        tier: tier != null ? Number(tier) : null,
        monthlyLimit,
        used,
        onDemandCap,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
        // Weekly SuperGrok snapshot
        weeklyUsedPercent,
        weeklyResetAt,
        weeklyStartAt,
        creditUsagePercent,
        productUsage,
        currentPeriod: creditsPeriod,
        isUnifiedBillingUser: Boolean(credits?.isUnifiedBillingUser),
      },
    },
  };
}

/** Live models list from CLI proxy (works with OAuth). */
async function fetchGrokModels(accessToken) {
  if (!accessToken) return { ok: false, models: [] };
  const res = await cliGet(accessToken, "/models");
  if (!res.ok || !res.json) {
    return { ok: false, models: [], error: res.text || `models ${res.status}` };
  }
  const list = Array.isArray(res.json.data) ? res.json.data : [];
  return {
    ok: true,
    models: list.map((m) => ({
      id: m.id || m.model,
      object: "model",
      created: null,
      owned_by: m.owned_by || "xai",
      kind: "chat",
      source: "live",
      name: m.name || m.id,
      context_window: m.context_window || null,
      api_backend: m.api_backend || null,
    })),
  };
}

module.exports = {
  fetchGrokUsage,
  fetchGrokModels,
  tierLabel,
};
