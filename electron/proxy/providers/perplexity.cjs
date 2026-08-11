const BASE = "https://api.perplexity.ai";

const CATALOG = [
  { id: "sonar-pro", name: "Sonar Pro", kind: "chat", owned_by: "perplexity" },
];

module.exports = {
  id: "perplexity",
  name: "Perplexity",
  alias: "perplexity",
  modelTag: "perplexity",
  modelTags: ["perplexity", "pplx"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://www.perplexity.ai/settings/api",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: false,
  catalogModels: CATALOG,
  description: "Perplexity Sonar API key · OpenAI-compatible chat completions · perplexity/…",
  buildUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    if (root.endsWith("/chat/completions")) return root;
    if (root.endsWith("/v1")) return `${root}/chat/completions`;
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
