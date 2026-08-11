/**
 * vip.j3gb.com — OpenAI-compatible gateway (API keys only).
 * Base: https://vip.j3gb.com/v1
 * Usage/balance: GET /v1/usage with the same API key.
 *
 * /v1/usage is flaky (HTML 429 openresty, 401 API_KEY_DISABLED) even when the
 * same key still works for chat/completions. With usagePollNeverBlocks=true,
 * a failed/rate-limited usage poll is display-only — key stays ready for routing.
 */

const BASE = "https://vip.j3gb.com/v1";

module.exports = {
  id: "j3gb",
  name: "J3GB VIP",
  alias: "j3gb",
  modelTag: "j3gb",
  modelTags: ["j3gb", "vip"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://vip.j3gb.com/",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: true,
  failoverOnAnyError: true,
  maxFailoverAttempts: 30,
  balanceUrl: `${BASE}/usage`,
  balanceOnly: true,
  /** Usage/balance poll must never mark the key blocked for chat rotation. */
  usagePollNeverBlocks: true,
  description: "vip.j3gb.com OpenAI-compatible · API keys only · auto-rotate when balance is exhausted · tag j3gb/…",

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
