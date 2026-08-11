const base = require("./codebuddy.cjs");
const provider = base.create("codebuddy-cn", "CodeBuddy CN", "codebuddy-cn", "https://www.codebuddy.cn/v2/plugin", "https://www.codebuddy.cn");
module.exports = {
  ...provider,
  id: "codebuddy-cn",
  name: "CodeBuddy CN",
  alias: "codebuddy-cn",
  modelTag: "codebuddy-cn",
  modelTags: ["codebuddy-cn", "codebuddy_cn"],
  defaultBaseUrl: "https://www.codebuddy.cn/v2/plugin",
  consoleUrl: "https://www.codebuddy.cn",
  modelsUrl(root) {
    const value = String(root || this.defaultBaseUrl).replace(/\/$/, "");
    return value.endsWith("/models") ? value : `${value}/models`;
  },
  buildUrl(root) {
    const value = String(root || this.defaultBaseUrl).replace(/\/$/, "");
    return value.includes("/chat/completions") ? value : `${value}/chat/completions`;
  },
  buildHeaders(apiKey, opts = {}) {
    return {
      "Content-Type": "application/json",
      Accept: opts.stream === false ? "application/json" : "text/event-stream",
      Authorization: `Bearer ${opts.accessToken || apiKey || ""}`,
      "User-Agent": "CodeBuddy-CN/1.0",
    };
  },
};
