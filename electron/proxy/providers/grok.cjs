/**
 * xAI Grok provider
 * - apikey (xai-...) → https://api.x.ai/v1  (platform billing)
 * - oauth (Grok Build CLI) → https://cli-chat-proxy.grok.com/v1  (SuperGrok / X Premium)
 */

const PLATFORM_BASE = "https://api.x.ai/v1";
const CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

module.exports = {
  id: "grok",
  name: "Grok (xAI)",
  alias: "xai",
  modelTag: "xai",
  /** Extra tags that resolve to this provider (e.g. xai/grok-4.5, grok/grok-4.5) */
  modelTags: ["xai", "grok"],
  wireFormat: "grok",
  defaultBaseUrl: PLATFORM_BASE,
  cliProxyBaseUrl: CLI_PROXY_BASE,
  supportsOauth: true,
  supportsApiKey: true,
  supportsCliImport: true,
  description:
    "xAI Platform API key or Grok Build CLI OAuth. Models: xai/grok-4.5 or grok/grok-4.5",

  buildUrl(baseUrl, opts = {}) {
    const mode = opts.mode || (opts.authType === "oauth" ? "grok-cli" : "platform");
    const root = String(
      baseUrl || (mode === "grok-cli" ? CLI_PROXY_BASE : PLATFORM_BASE)
    ).replace(/\/$/, "");

    // Full path already
    if (root.includes("/chat/completions")) return root;
    if (root.includes("/responses") && !root.endsWith("/v1")) return root;

    // Models with api_backend=responses on CLI proxy
    if (mode === "grok-cli" && opts.apiBackend === "responses") {
      if (root.endsWith("/v1")) return `${root}/responses`;
      return `${root}/v1/responses`;
    }

    if (root.endsWith("/v1")) return `${root}/chat/completions`;
    return `${root}/v1/chat/completions`;
  },

  buildHeaders(apiKey, opts = {}) {
    const mode = opts.mode || (opts.authType === "oauth" ? "grok-cli" : "platform");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: opts.stream !== false ? "text/event-stream" : "application/json",
    };
    if (mode === "grok-cli") {
      // Match official Grok Build CLI (OmniRoute parity)
      headers["x-grok-client-version"] = "0.2.91";
      headers["x-grok-client-identifier"] = "grok_cli_rs";
      headers["User-Agent"] = "grok-cli/0.2.91";
    }
    return headers;
  },

  parseStreamData(json) {
    return json;
  },
};
