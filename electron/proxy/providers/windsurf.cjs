const BASE = "https://server.codeium.com";

module.exports = {
  id: "windsurf",
  name: "Windsurf",
  alias: "windsurf",
  modelTag: "windsurf",
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  description: "Windsurf bearer-token gateway",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  consoleUrl: "https://windsurf.com",
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
      "User-Agent": "Windsurf/1.0",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
