const BASE = "https://opencode.ai/zen/go/v1";

const CATALOG = [
  ["grok-4.5", "Grok 4.5", "chat"],
  ["glm-5.2", "GLM-5.2", "reasoning"],
  ["glm-5.1", "GLM-5.1", "reasoning"],
  ["gpt-5.6-luna", "GPT 5.6 Luna", "chat"],
  ["kimi-k3", "Kimi K3", "reasoning"],
  ["kimi-k2.7-code", "Kimi K2.7 Code", "chat"],
  ["kimi-k2.6", "Kimi K2.6", "chat"],
  ["mimo-v2.5", "MiMo V2.5", "chat"],
  ["mimo-v2.5-pro", "MiMo V2.5 Pro", "reasoning"],
  ["minimax-m3", "MiniMax M3", "chat"],
  ["minimax-m2.7", "MiniMax M2.7", "chat"],
  ["qwen3.7-max", "Qwen3.7 Max", "reasoning"],
  ["qwen3.7-plus", "Qwen3.7 Plus", "chat"],
  ["qwen3.6-plus", "Qwen3.6 Plus", "chat"],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", "reasoning"],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", "chat"],
  ["hy3", "Hy3", "chat"],
].map(([id, name, kind]) => ({ id, name, kind, owned_by: "opencode-go" }));

module.exports = {
  id: "opencode-go",
  name: "OpenCode Go",
  alias: "opencode-go",
  modelTag: "opencode-go",
  modelTags: ["opencode-go", "opencode_go", "go"],
  wireFormat: "openai",
  defaultBaseUrl: BASE,
  consoleUrl: "https://opencode.ai/auth",
  description: "OpenCode Go subscription API with OpenAI-compatible models",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: true,
  supportsUsage: false,
  catalogModels: CATALOG,
  // OpenCode Go is an OpenAI-compatible chat endpoint, including DeepSeek.
  resolveWireFormat() {
    return "openai";
  },
  buildUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    return root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
  },
  modelsUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    return root.endsWith("/models") ? root : `${root}/models`;
  },
  buildHeaders(apiKey, opts = {}) {
    return {
      "Content-Type": "application/json",
      Accept: opts.stream === false ? "application/json" : "text/event-stream",
      Authorization: `Bearer ${apiKey || ""}`,
      "User-Agent": "opencode/1.0",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
