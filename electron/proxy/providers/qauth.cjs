const BASE = "https://api.cline.bot/api/v1";

module.exports = {
  id: "qauth",
  name: "Cline",
  alias: "cline",
  modelTag: "cline",
  modelTags: ["cline", "qauth"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  description: "Cline API and account gateway",
  supportsOauth: true,
  supportsApiKey: true,
  supportsCliImport: true,
  consoleUrl: "https://app.cline.bot",
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
    const rawToken = opts.accessToken || apiKey || "";
    const token = rawToken && !String(rawToken).toLowerCase().startsWith("workos:") ? `workos:${rawToken}` : rawToken;
    const headers = {
      "Content-Type": "application/json",
      Accept: opts.stream === false ? "application/json" : "text/event-stream",
      Authorization: `Bearer ${token}`,
      "User-Agent": "Cline/3.0.48",
      "X-Client-Version": "3.0.48",
      "X-Client-Name": "cline",
      "X-Cline-Client": "cline",
    };
    if (opts.taskId) headers["X-Task-ID"] = String(opts.taskId);
    if (opts.title) headers["X-Title"] = String(opts.title);
    if (opts.referer) headers["HTTP-Referer"] = String(opts.referer);
    return headers;
  },
  parseStreamData(json) {
    return json;
  },
};
