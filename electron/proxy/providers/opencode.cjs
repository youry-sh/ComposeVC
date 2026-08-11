const BASE = "https://opencode.ai/zen/v1";

const CATALOG = [
  ["gpt-5.6-sol", "GPT 5.6 Sol", "reasoning"],
  ["gpt-5.6-terra", "GPT 5.6 Terra", "reasoning"],
  ["gpt-5.6-luna", "GPT 5.6 Luna", "reasoning"],
  ["gpt-5.5", "GPT 5.5", "reasoning"],
  ["gpt-5.5-pro", "GPT 5.5 Pro", "reasoning"],
  ["gpt-5.4", "GPT 5.4", "reasoning"],
  ["gpt-5.4-pro", "GPT 5.4 Pro", "reasoning"],
  ["gpt-5.4-mini", "GPT 5.4 Mini", "reasoning"],
  ["gpt-5.4-nano", "GPT 5.4 Nano", "chat"],
  ["gpt-5.3-codex", "GPT 5.3 Codex", "codex"],
  ["gpt-5.3-codex-spark", "GPT 5.3 Codex Spark", "codex"],
  ["gpt-5.2", "GPT 5.2", "reasoning"],
  ["gpt-5.2-codex", "GPT 5.2 Codex", "codex"],
  ["gpt-5.1", "GPT 5.1", "reasoning"],
  ["gpt-5.1-codex", "GPT 5.1 Codex", "codex"],
  ["gpt-5.1-codex-max", "GPT 5.1 Codex Max", "codex"],
  ["gpt-5.1-codex-mini", "GPT 5.1 Codex Mini", "codex"],
  ["gpt-5", "GPT 5", "reasoning"],
  ["gpt-5-codex", "GPT 5 Codex", "codex"],
  ["gpt-5-nano", "GPT 5 Nano", "chat"],
  ["claude-fable-5", "Claude Fable 5", "reasoning"],
  ["claude-opus-5", "Claude Opus 5", "reasoning"],
  ["claude-opus-4-8", "Claude Opus 4.8", "reasoning"],
  ["claude-opus-4-7", "Claude Opus 4.7", "reasoning"],
  ["claude-opus-4-6", "Claude Opus 4.6", "reasoning"],
  ["claude-opus-4-5", "Claude Opus 4.5", "reasoning"],
  ["claude-sonnet-5", "Claude Sonnet 5", "reasoning"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", "reasoning"],
  ["claude-sonnet-4-5", "Claude Sonnet 4.5", "reasoning"],
  ["claude-haiku-4-5", "Claude Haiku 4.5", "chat"],
  ["gemini-3.6-flash", "Gemini 3.6 Flash", "reasoning"],
  ["gemini-3.5-flash", "Gemini 3.5 Flash", "reasoning"],
  ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "chat"],
  ["gemini-3.1-pro", "Gemini 3.1 Pro", "reasoning"],
  ["gemini-3-pro", "Gemini 3 Pro", "reasoning"],
  ["gemini-3-flash", "Gemini 3 Flash", "chat"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", "reasoning"],
  ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", "chat"],
  ["glm-5.2", "GLM-5.2", "reasoning"],
  ["glm-5.1", "GLM-5.1", "reasoning"],
  ["glm-5", "GLM-5", "reasoning"],
  ["qwen3.7-max", "Qwen3.7 Max", "reasoning"],
  ["qwen3.7-plus", "Qwen3.7 Plus", "chat"],
  ["qwen3.6-plus", "Qwen3.6 Plus", "chat"],
  ["mimo-v2.5", "MiMo V2.5", "chat"],
  ["mimo-v2.5-pro", "MiMo V2.5 Pro", "reasoning"],
  ["minimax-m3", "MiniMax M3", "chat"],
].map(([id, name, kind]) => ({ id, name, kind, owned_by: "opencode" }));

module.exports = {
  id: "opencode",
  name: "OpenCode Zen",
  alias: "opencode-zen",
  modelTag: "opencode-zen",
  modelTags: ["opencode", "opencode-zen", "zen"],
  wireFormat: "opencode-responses",
  defaultBaseUrl: BASE,
  consoleUrl: "https://opencode.ai/auth",
  description: "OpenCode Zen pay-per-use gateway with Responses API models",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: true,
  supportsUsage: false,
  catalogModels: CATALOG,
  resolveWireFormat(model) {
    const id = String(model || "").toLowerCase();
    // Zen serves these models through the OpenAI-compatible chat endpoint.
    if (
      id.startsWith("deepseek") ||
      id.startsWith("glm-") ||
      id.startsWith("kimi-") ||
      id.startsWith("minimax-") ||
      id.startsWith("mimo-")
    ) {
      return "openai";
    }
    return "opencode-responses";
  },
  buildUrl(baseUrl, opts = {}) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    const wire = this.resolveWireFormat(opts.model);
    if (wire === "openai") {
      return root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
    }
    return root.endsWith("/responses") ? root : `${root}/responses`;
  },
  modelsUrl(baseUrl) {
    const root = String(baseUrl || BASE).replace(/\/$/, "");
    return root.endsWith("/models") ? root : `${root}/models`;
  },
  buildHeaders(apiKey) {
    return {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${apiKey || ""}`,
      "User-Agent": "opencode/1.0",
    };
  },
  parseStreamData(json) {
    return json;
  },
};
