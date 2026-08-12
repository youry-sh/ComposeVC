/**
 * Claude Code OAuth provider (Anthropic Messages API + CLI identity cloak).
 * OmniRoute parity: claude OAuth provider / user:sessions:claude_code.
 */

const creds = require("../oauth/claudeCodeCreds.cjs");
const { cloakClaudeCodeRequest } = require("../oauth/claudeCodeAuth.cjs");

module.exports = {
  id: "claude-code",
  name: "Claude Code",
  alias: "claude-code",
  modelTag: "claude-code",
  modelTags: ["claude-code", "cc", "claude"],
  wireFormat: "anthropic",
  defaultBaseUrl: creds.API_BASE,
  description:
    "Anthropic Claude Code (Pro/Max OAuth) — Claude 5, Fable 5, Opus, Sonnet, and Haiku. Model access depends on the account plan. Multi-account failover on limits.",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  website: "https://claude.ai/code",
  consoleUrl: "https://claude.ai",
  streamMode: "event-json",

  buildUrl(baseUrl) {
    const root = String(baseUrl || this.defaultBaseUrl).replace(/\/$/, "");
    if (root.endsWith("/v1/messages")) return root;
    if (root.endsWith("/v1")) return `${root}/messages`;
    return `${root}/v1/messages`;
  },

  /**
   * Basic headers; pipeline re-applies cloakClaudeCodeRequest for full CLI shape.
   */
  buildHeaders(apiKey, opts = {}) {
    const token = apiKey || opts.accessToken || "";
    return {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-version": creds.ANTHROPIC_VERSION,
      "anthropic-beta": creds.ANTHROPIC_BETA_OAUTH,
      "User-Agent": creds.claudeCliUserAgent(),
      "x-app": "cli",
    };
  },

  /** Apply Claude Code identity + billing cloak before fetch. */
  prepareRequest(body, account) {
    return cloakClaudeCodeRequest(body, account || {});
  },

  parseStreamData(json) {
    return json;
  },
};
