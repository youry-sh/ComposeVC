/**
 * OrcaRouter — OpenAI-compatible multi-model gateway (API keys only).
 * Console: https://www.orcarouter.ai/console
 * Base:    https://api.orcarouter.ai/v1
 *
 * Free plan models (per key): deepseek/deepseek-v4-flash-free, deepseek/deepseek-v4-pro-free
 * Failover: any upstream error → next key (sticky until blocked).
 * Tags: orcarouter/…, orca/…, oracle/…
 */

const BASE = "https://api.orcarouter.ai/v1";

/** Static free-plan catalog (seeded as customModels if empty). */
const FREE_MODELS = [
  {
    id: "deepseek/deepseek-v4-flash-free",
    kind: "chat",
    owned_by: "orcarouter",
    name: "DeepSeek V4 Flash Free",
  },
  {
    id: "deepseek/deepseek-v4-pro-free",
    kind: "chat",
    owned_by: "orcarouter",
    name: "DeepSeek V4 Pro Free",
  },
];

module.exports = {
  id: "orcarouter",
  name: "OrcaRouter",
  alias: "orca",
  modelTag: "orcarouter",
  modelTags: ["orcarouter", "orca", "oracle"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://www.orcarouter.ai/console",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  /** Prefer free catalog via catalogModels; emptyCatalog false so list shows free models. */
  emptyCatalog: false,
  failoverOnAnyError: true,
  maxFailoverAttempts: 40,
  description:
    "OrcaRouter OpenAI-compatible · sk-orca keys · free flash/pro models · multi-key rotation · orcarouter/…",

  /** Used by models.cjs static catalog */
  catalogModels: FREE_MODELS,

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
