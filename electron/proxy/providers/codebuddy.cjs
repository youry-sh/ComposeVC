const BASE = "https://www.codebuddy.ai/v2/plugin";

function create(id, name, alias, baseUrl, consoleUrl) {
  return {
    id,
    name,
    alias,
    modelTag: alias,
    modelTags: [alias, id],
    wireFormat: "openai",
    defaultBaseUrl: baseUrl,
    description: `${name} OAuth gateway`,
    supportsOauth: true,
    supportsApiKey: false,
    supportsCliImport: true,
    consoleUrl,
    buildUrl(root) {
      const value = String(root || baseUrl).replace(/\/$/, "");
      if (value.includes("/chat/completions")) return value;
      return `${value}/chat/completions`;
    },
    modelsUrl(root) {
      const value = String(root || baseUrl).replace(/\/$/, "");
      if (value.endsWith("/v1")) return `${value}/models`;
      return `${value}/v1/models`;
    },
    buildHeaders(apiKey, opts = {}) {
      return {
        "Content-Type": "application/json",
        Accept: opts.stream === false ? "application/json" : "text/event-stream",
        Authorization: `Bearer ${opts.accessToken || apiKey || ""}`,
        "User-Agent": `${name}/1.0`,
      };
    },
    parseStreamData(json) {
      return json;
    },
  };
}

const provider = create("codebuddy", "CodeBuddy", "codebuddy", BASE, "https://www.codebuddy.ai");
provider.create = create;
module.exports = provider;
