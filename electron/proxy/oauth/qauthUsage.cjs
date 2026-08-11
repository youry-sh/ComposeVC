const API_ENDPOINT = "https://api.cline.bot";
const API_PREFIX = "/api/v1";

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function request(pathname, token) {
  const response = await fetch(`${API_ENDPOINT}${API_PREFIX}${pathname}`, {
    headers: {
      Authorization: `Bearer workos:${String(token || "").replace(/^workos:/i, "")}`,
      Accept: "application/json",
      "User-Agent": "Cline/3.0.48",
      "X-Client-Version": "3.0.48",
    },
    signal: AbortSignal.timeout(30000),
  });
  const raw = await response.text().catch(() => "");
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok) throw new Error(`Cline usage ${response.status}: ${raw.slice(0, 300)}`);
  return object(data.data || data);
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function makeQuota(name, used, total, resetAt = null) {
  const usedNumber = asNumber(used);
  const totalNumber = asNumber(total);
  if (usedNumber === null && totalNumber === null) return null;
  const usedPercent = totalNumber && totalNumber > 0 && usedNumber !== null
    ? Math.max(0, Math.min(100, usedNumber / totalNumber * 100))
    : totalNumber === 0
      ? 100
      : 0;
  return {
    name,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    used: usedNumber,
    total: totalNumber,
    resetAt,
  };
}

async function fetchClineUsage({ accessToken, userId }) {
  if (!accessToken) throw new Error("Cline access token missing");
  const resolvedUserId = String(userId || "").trim();
  if (!resolvedUserId) throw new Error("Cline user id missing");
  const [balance, usages, me] = await Promise.all([
    request(`/users/${encodeURIComponent(resolvedUserId)}/balance`, accessToken),
    request(`/users/${encodeURIComponent(resolvedUserId)}/usages`, accessToken),
    request("/users/me", accessToken),
  ]);
  const items = Array.isArray(usages.items) ? usages.items : [];
  const totalTokens = items.reduce((sum, item) => sum + (asNumber(item.totalTokens) || 0), 0);
  const costUsd = items.reduce((sum, item) => sum + (asNumber(item.costUsd) || 0), 0);
  const balanceValue = asNumber(balance.balance);
  const quotas = {};
  if (balanceValue !== null) quotas.credits = makeQuota("credits", 0, balanceValue);
  return {
    plan: me.displayName || "Cline",
    limitReached: balanceValue !== null && balanceValue <= 0,
    balance: balanceValue,
    remaining: balanceValue,
    unit: "credits",
    balanceOnly: false,
    quotas,
    note: `${items.length} usage records · ${totalTokens.toLocaleString()} tokens · $${(costUsd / 1000000).toFixed(4)}`,
    detail: {
      userId: resolvedUserId,
      email: me.email || null,
      usageRecords: items.length,
      totalTokens,
      costUsdMicros: costUsd,
      fetchedAt: Date.now(),
    },
  };
}

module.exports = { fetchClineUsage };
