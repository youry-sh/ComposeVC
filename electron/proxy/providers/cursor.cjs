const BASE = "https://api2.cursor.sh";

module.exports = {
  id: "cursor",
  name: "Cursor",
  alias: "cursor",
  modelTag: "cursor",
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  description: "Cursor bearer-token gateway",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  consoleUrl: "https://cursor.com",
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
      "User-Agent": "Cursor/1.0",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
