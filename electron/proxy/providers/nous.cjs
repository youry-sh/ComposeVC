const creds = require("../oauth/nousCreds.cjs");

const CATALOG_MODELS = [
  { id: "openai/gpt-4.1", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-4.1-mini", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-4.1-nano", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-4o", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-4o-mini", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5-mini", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5-nano", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5-codex", owned_by: "openai", kind: "codex" },
  { id: "openai/gpt-5.1-codex", owned_by: "openai", kind: "codex" },
  { id: "openai/gpt-5.1-codex-mini", owned_by: "openai", kind: "codex" },
  { id: "openai/gpt-5.4", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5.4-mini", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5.6", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5.6-terra", owned_by: "openai", kind: "chat" },
  { id: "openai/gpt-5.6-sol", owned_by: "openai", kind: "chat" },
  { id: "openai/o3", owned_by: "openai", kind: "reasoning" },
  { id: "openai/o3-mini", owned_by: "openai", kind: "reasoning" },
  { id: "openai/o4-mini", owned_by: "openai", kind: "reasoning" },
  { id: "anthropic/claude-sonnet-latest", owned_by: "anthropic", kind: "chat" },
  { id: "anthropic/claude-opus-5-fast", owned_by: "anthropic", kind: "chat" },
  { id: "anthropic/claude-fable-latest", owned_by: "anthropic", kind: "chat" },
  { id: "deepseek/deepseek-v4-flash-0731", owned_by: "deepseek", kind: "chat" },
  { id: "deepseek/deepseek-v4-pro", owned_by: "deepseek", kind: "chat" },
  { id: "moonshotai/kimi-k3", owned_by: "moonshotai", kind: "chat" },
  { id: "z-ai/glm-5.2", owned_by: "z-ai", kind: "chat" },
  { id: "google/gemini-3.6-flash", owned_by: "google", kind: "chat" },
  { id: "google/gemini-3.5-flash", owned_by: "google", kind: "chat" },
  { id: "x-ai/grok-4.5", owned_by: "x-ai", kind: "chat" },
  { id: "x-ai/grok-4.3", owned_by: "x-ai", kind: "chat" },
  { id: "qwen/qwen3.7-flash", owned_by: "qwen", kind: "chat" },
  { id: "qwen/qwen3.7-plus", owned_by: "qwen", kind: "chat" },
  { id: "qwen/qwen3.7-max", owned_by: "qwen", kind: "chat" },
];

module.exports = {
  id: "nous",
  name: "Nous Research",
  alias: "nous",
  modelTag: "nous",
  wireFormat: "openai",
  defaultBaseUrl: creds.INFERENCE_BASE,
  description: "Nous Research Hermes Agent — OAuth (refresh). Live models sync from inference-api.nousresearch.com/v1/models.",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: false,
  catalogModels: CATALOG_MODELS,
  buildUrl(baseUrl) {
    return String(baseUrl || creds.INFERENCE_BASE).replace(/\/$/, "") + "/chat/completions";
  },
  buildHeaders(apiKey) {
    return { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
  },
};
