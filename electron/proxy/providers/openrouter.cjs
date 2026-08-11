const BASE = "https://openrouter.ai/api/v1";

module.exports = {
  id: "openrouter",
  name: "OpenRouter",
  alias: "openrouter",
  modelTag: "openrouter",
  modelTags: ["openrouter", "or"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://openrouter.ai/settings/keys",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: true,
  balanceUrl: "https://openrouter.ai/api/v1/credits",
  balanceOnly: true,
  description: "OpenRouter API · live model catalog · management-key credit balance · openrouter/…",
  buildBalanceUrl() {
    return "https://openrouter.ai/api/v1/credits";
  },
  parseBalanceUsage(data) {
    const totalCredits = Number(data?.data?.total_credits);
    const totalUsage = Number(data?.data?.total_usage);
    if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) return null;
    const remaining = totalCredits - totalUsage;
    return {
      plan: "openrouter_credits",
      remaining,
      unit: "USD",
      limitReached: remaining <= 0,
      note: `USD ${remaining.toFixed(5)}`,
      detail: {
        totalCredits,
        totalUsage,
        balances: [{ currency: "USD", remaining }],
      },
    };
  },
  buildUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    if (root.includes("/chat/completions")) return root;
    return `${root}/chat/completions`;
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
