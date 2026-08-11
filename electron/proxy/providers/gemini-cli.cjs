/**
 * Gemini CLI (Google Code Assist OAuth).
 * OmniRoute parity: Cloud Code streamGenerateContent + GeminiCLI user-agent.
 */

const creds = require("../oauth/geminiCliCreds.cjs");

module.exports = {
  id: "gemini-cli",
  name: "Gemini CLI",
  alias: "gemini-cli",
  modelTag: "gemini-cli",
  modelTags: ["gemini-cli", "gc", "gemini"],
  wireFormat: "gemini-cli",
  defaultBaseUrl: creds.BASE_URLS[0],
  description:
    "Google Gemini CLI / Code Assist — models: gemini-2.5-pro|flash|flash-lite, gemini-3.1-flash-lite (not Antigravity 3.x Pro/Claude)",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  website: "https://github.com/google-gemini/gemini-cli",
  consoleUrl: "https://aistudio.google.com",

  buildUrl(baseUrl) {
    const root = String(baseUrl || creds.BASE_URLS[0]).replace(/\/$/, "");
    if (root.includes("streamGenerateContent")) return root;
    return `${root}${creds.streamGenerateContentPath}`;
  },

  buildHeaders(apiKey) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      "User-Agent": creds.geminiCliUserAgent(),
    };
  },

  parseStreamData(json) {
    if (!json || typeof json !== "object") return json;
    if (json.response && typeof json.response === "object") {
      return {
        ...json.response,
        remainingCredits: json.remainingCredits,
      };
    }
    return json;
  },
};
