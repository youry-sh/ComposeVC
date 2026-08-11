const BASE = "https://openapi.qoder.sh";

module.exports = {
  id: "qoder",
  name: "Qoder",
  alias: "qoder",
  modelTag: "qoder",
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  description: "Qoder OAuth gateway",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  consoleUrl: "https://qoder.com",
  modelsUrl(root) {
    const value = String(root || BASE).replace(/\/$/, "");
    return value.endsWith("/models") ? value : `${value}/models`;
  },
  buildUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    if (root.includes("/chat/completions")) return root;
    return `${root}/chat/completions`;
  },
  buildHeaders(apiKey, opts = {}) {
    return {
      "Content-Type": "application/json",
      Accept: opts.stream === false ? "application/json" : "text/event-stream",
      Authorization: `Bearer ${opts.accessToken || apiKey || ""}`,
      "User-Agent": "Qoder/1.0",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
