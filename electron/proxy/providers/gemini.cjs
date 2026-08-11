module.exports = {
  id: "gemini",
  name: "Google Gemini",
  wireFormat: "gemini",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  description: "Google Gemini generateContent (converted ↔ OpenAI)",

  buildUrl(baseUrl, { model, stream, apiKey } = {}) {
    const root = String(baseUrl || this.defaultBaseUrl).replace(/\/$/, "");
    const m = encodeURIComponent(model || "gemini-2.0-flash");
    const action = stream ? "streamGenerateContent" : "generateContent";
    const qs = new URLSearchParams();
    if (stream) qs.set("alt", "sse");
    if (apiKey) qs.set("key", apiKey);
    const q = qs.toString();
    return `${root}/models/${m}:${action}${q ? `?${q}` : ""}`;
  },

  buildHeaders(apiKey) {
    return {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
    };
  },

  parseStreamData(json) {
    return json;
  },
};
