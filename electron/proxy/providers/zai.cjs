const BASE = "https://api.z.ai/api/paas/v4";

const CATALOG = [
  { id: "glm-5.2", name: "GLM-5.2", kind: "reasoning", owned_by: "zai" },
];

module.exports = {
  id: "zai",
  name: "Z.AI",
  alias: "zai",
  modelTag: "zai",
  modelTags: ["zai", "z-ai", "glm"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://z.ai/manage-apikey/apikey-list",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: false,
  catalogModels: CATALOG,
  description: "Z.AI GLM API · OpenAI-compatible · live model catalog · zai/…",
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
      "Accept-Language": "en-US,en",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
