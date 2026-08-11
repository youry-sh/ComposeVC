function balanceProbeUrls(baseUrl) {
  const root = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!root) return [];
  const apiRoot = root.replace(/\/chat\/completions$/i, "");
  const rootWithoutV1 = apiRoot.replace(/\/v1$/i, "");
  return [...new Set([
    `${rootWithoutV1}/user/balance`,
    `${apiRoot}/usage`,
    `${rootWithoutV1}/usage`,
  ])];
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseGenericBalanceUsage(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const candidates = [
    [data.remaining, data.unit || data.currency],
    [data.balance, data.unit || data.currency],
    [data.total_balance, data.currency || data.unit],
    [data.data?.remaining, data.data?.unit || data.data?.currency],
    [data.data?.balance, data.data?.unit || data.data?.currency],
    [data.data?.total_balance, data.data?.currency || data.data?.unit],
  ];
  for (const [value, unit] of candidates) {
    const remaining = toFiniteNumber(value);
    if (remaining == null) continue;
    return {
      plan: "api_key_balance",
      remaining,
      unit: String(unit || "USD"),
      limitReached: remaining <= 0,
      note: `${String(unit || "USD")} ${remaining.toFixed(5)}`,
    };
  }
  return null;
}

module.exports = {
  balanceProbeUrls,
  parseGenericBalanceUsage,
};
