module.exports = {
  id: "anthropic",
  name: "Anthropic",
  alias: "anthropic",
  modelTag: "anthropic",
  modelTags: ["anthropic", "claude"],
  wireFormat: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com",
  consoleUrl: "https://console.anthropic.com/settings/keys",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: false,
  catalogModels: [
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", kind: "chat", owned_by: "anthropic" },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", kind: "reasoning", owned_by: "anthropic" },
  ],
  description: "Anthropic API key · Claude Messages API · anthropic/…",

  buildUrl(baseUrl) {
    const root = String(baseUrl || this.defaultBaseUrl).replace(/\/$/, "");
    if (root.endsWith("/v1/messages")) return root;
    if (root.endsWith("/v1")) return `${root}/messages`;
    return `${root}/v1/messages`;
  },

  buildHeaders(apiKey) {
    return {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    };
  },

  parseStreamData(json) {
    // Anthropic events are the JSON itself (type: message_start, ...)
    return json;
  },

  /** Anthropic SSE may prefix event: lines — pipeline handles data: only */
  streamMode: "event-json",
};
