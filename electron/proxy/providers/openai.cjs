/**
 * OpenAI provider:
 * - apikey → Platform api.openai.com chat/completions (billed API credits)
 * - oauth  → ChatGPT Codex backend /codex/responses (subscription quota)
 */

const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
const PLATFORM_BASE = "https://api.openai.com/v1";

module.exports = {
  id: "openai",
  name: "OpenAI",
  alias: "openai",
  modelTag: "openai",
  wireFormat: "openai",
  defaultBaseUrl: PLATFORM_BASE,
  codexBaseUrl: CODEX_BASE,
  supportsOauth: true,
  supportsApiKey: true,
  supportsCliImport: false,
  description:
    "OpenAI Platform API keys + ChatGPT OAuth (Codex). OAuth uses Codex-safe models (gpt-5.1-codex, …); Platform API keys can list live /v1/models.",

  /**
   * @param {string} baseUrl
   * @param {{ stream?: boolean, authType?: string, mode?: 'platform'|'codex' }} opts
   */
  buildUrl(baseUrl, opts = {}) {
    const mode = opts.mode || (opts.authType === "oauth" ? "codex" : "platform");
    if (mode === "codex") {
      const root = String(baseUrl || CODEX_BASE).replace(/\/$/, "");
      if (root.endsWith("/responses")) return root;
      if (root.includes("backend-api/codex")) return `${root.replace(/\/$/, "")}/responses`;
      return `${CODEX_BASE}/responses`;
    }
    const root = String(baseUrl || PLATFORM_BASE).replace(/\/$/, "");
    if (root.endsWith("/v1")) return `${root}/chat/completions`;
    if (root.includes("/chat/completions")) return root;
    return `${root}/v1/chat/completions`;
  },

  /**
   * @param {string} apiKey token or sk-
   * @param {{ authType?: string, workspaceId?: string, mode?: string }} opts
   */
  buildHeaders(apiKey, opts = {}) {
    const mode = opts.mode || (opts.authType === "oauth" ? "codex" : "platform");
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (mode === "codex") {
      headers.Accept = "text/event-stream";
      headers.originator = "codex_cli_rs";
      headers["OpenAI-Beta"] = "responses=experimental";
      headers["User-Agent"] = "codex_cli_rs";
      if (opts.workspaceId) {
        headers["chatgpt-account-id"] = opts.workspaceId;
      }
    }
    return headers;
  },

  parseStreamData(json) {
    return json;
  },
};
