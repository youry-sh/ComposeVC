/**
 * Google Antigravity OAuth → Cloud Code streamGenerateContent.
 */

const creds = require("../oauth/antigravityCreds.cjs");

module.exports = {
  id: "antigravity",
  name: "Antigravity",
  alias: "antigravity",
  modelTag: "antigravity",
  wireFormat: "antigravity",
  defaultBaseUrl: creds.BASE_URLS[0],
  description:
    "Antigravity — Sign in with Google. Models: antigravity/gemini-3.1-pro-high",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: false,

  buildUrl(baseUrl) {
    const root = String(baseUrl || creds.BASE_URLS[0]).replace(/\/$/, "");
    // Always SSE stream endpoint (OmniRoute parity)
    if (root.includes("streamGenerateContent")) return root;
    return `${root}${creds.streamGenerateContentPath}`;
  },

  buildHeaders(apiKey, opts = {}) {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
      "User-Agent": creds.antigravityUserAgent(),
    };
  },

  /**
   * Cloud Code wraps Gemini payload as { response: { candidates, usageMetadata } }.
   */
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
