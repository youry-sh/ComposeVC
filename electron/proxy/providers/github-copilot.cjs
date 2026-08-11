const BASE = "https://api.githubcopilot.com";

module.exports = {
  id: "github-copilot",
  name: "GitHub Copilot",
  alias: "copilot",
  modelTag: "copilot",
  modelTags: ["copilot", "github-copilot"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  description: "GitHub Copilot bearer-token gateway",
  supportsOauth: true,
  supportsApiKey: true,
  supportsCliImport: true,
  consoleUrl: "https://github.com/settings/copilot",
  buildUrl(baseUrl, opts = {}) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    if (root.includes("/chat/completions")) return root;
    if (opts.path) return `${root}/${String(opts.path).replace(/^\//, "")}`;
    return `${root}/chat/completions`;
  },
  buildHeaders(apiKey, opts = {}) {
    return {
      "Content-Type": "application/json",
      Accept: opts.stream === false ? "application/json" : "text/event-stream",
      Authorization: `Bearer ${opts.githubAccessToken || apiKey || ""}`,
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "User-Agent": "GitHubCopilotChat/0.26.7",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
