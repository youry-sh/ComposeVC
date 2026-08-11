const BASE = "https://api.deepseek.com";

const CATALOG = [
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", kind: "reasoning", owned_by: "deepseek" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", kind: "chat", owned_by: "deepseek" },
];

module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  alias: "deepseek",
  modelTag: "deepseek",
  modelTags: ["deepseek", "ds"],
  wireFormat: "deepseek",
  defaultBaseUrl: BASE,
  consoleUrl: "https://platform.deepseek.com/",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  requiresReasoningContentReplay: true,
  balanceUrl: `${BASE}/user/balance`,
  balanceOnly: true,
  catalogModels: CATALOG,
  description: "Official DeepSeek API · thinking + tool-call reasoning replay · balance · deepseek/…",
  buildBalanceUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    return root.endsWith("/v1") ? `${root.slice(0, -3)}/user/balance` : `${root}/user/balance`;
  },
  parseBalanceUsage(data) {
    const balances = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
    const currencyBalances = balances
      .map((item) => ({
        currency: String(item?.currency || "").trim().toUpperCase(),
        remaining: Number(item?.total_balance),
        grantedBalance: item?.granted_balance ?? null,
        toppedUpBalance: item?.topped_up_balance ?? null,
      }))
      .filter((item) => item.currency && Number.isFinite(item.remaining));
    const primary = currencyBalances.find((item) => item.remaining > 0) || currencyBalances[0];
    const remaining = primary?.remaining ?? 0;
    const unit = primary?.currency || "USD";
    const hasFunds = currencyBalances.some((item) => item.remaining > 0);
    return {
      plan: "deepseek_api",
      remaining,
      unit,
      limitReached: data?.is_available === false || !hasFunds,
      note: currencyBalances.length
        ? currencyBalances.map((item) => `${item.currency} ${item.remaining.toFixed(5)}`).join(" · ")
        : "Balance unavailable",
      detail: {
        grantedBalance: primary?.grantedBalance ?? null,
        toppedUpBalance: primary?.toppedUpBalance ?? null,
        balanceAvailable: data?.is_available !== false,
        balances: currencyBalances,
      },
    };
  },
  buildUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    if (root.includes("/chat/completions")) return root;
    if (root.endsWith("/v1")) return `${root}/chat/completions`;
    return `${root}/v1/chat/completions`;
  },
  buildHeaders(apiKey) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
