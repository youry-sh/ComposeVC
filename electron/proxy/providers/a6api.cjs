/**
 * a6api.com — OpenAI-compatible gateway (API keys only).
 * Console: https://a6api.com/console
 * Base:    https://a6api.com/v1
 *
 * Models are manual (user adds in Proxy → Models).
 * Failover: any upstream error (400/403/503/524/…) → next key, up to 30 tries.
 */

const BASE = "https://a6api.com/v1";

module.exports = {
  id: "a6api",
  name: "A6 API",
  alias: "a6api",
  modelTag: "a6api",
  modelTags: ["a6api", "a6"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://a6api.com/console",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  /** Empty catalog — add models manually */
  emptyCatalog: true,
  /** Cycle keys on any HTTP/network error */
  failoverOnAnyError: true,
  maxFailoverAttempts: 30,
  description: "a6api.com OpenAI-compatible · API keys only · models manual · a6api/…",

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
