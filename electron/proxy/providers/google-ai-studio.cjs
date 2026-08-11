/**
 * Google AI Studio — Google Gemini API via API key.
 * Console: https://aistudio.google.com
 * API: Gemini generateContent / streamGenerateContent (Interactions API compatible).
 * Auth: X-Goog-Api-Key header or ?key query param.
 * Wire format: gemini (reuses openai-to-gemini + gemini-to-openai converters).
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Known Gemini models from Google AI Studio (Interactions API catalog). */
const GEMINI_CATALOG = [
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", kind: "chat", owned_by: "google" },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", kind: "chat", owned_by: "google" },
  { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro High", kind: "reasoning", owned_by: "google" },
  { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro Low", kind: "chat", owned_by: "google" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", kind: "chat", owned_by: "google" },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", kind: "chat", owned_by: "google" },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", kind: "chat", owned_by: "google" },
  { id: "gemini-3.1-flash", name: "Gemini 3.1 Flash", kind: "chat", owned_by: "google" },
  { id: "gemini-3-flash", name: "Gemini 3 Flash", kind: "chat", owned_by: "google" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", kind: "reasoning", owned_by: "google" },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", kind: "chat", owned_by: "google" },
  { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", kind: "chat", owned_by: "google" },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", kind: "chat", owned_by: "google" },
];

function encodeModelId(model) {
  return encodeURIComponent(String(model || "gemini-3.6-flash").replace(/^models\//, ""));
}

function buildUrl(baseUrl, opts = {}) {
  const root = String(baseUrl || BASE).replace(/\/$/, "");
  const model = opts.model || "gemini-3.6-flash";
  const stream = Boolean(opts.stream);
  const m = encodeModelId(model);
  const action = stream ? "streamGenerateContent" : "generateContent";
  const qs = new URLSearchParams();
  if (stream) qs.set("alt", "sse");
  if (opts.apiKey) qs.set("key", opts.apiKey);
  const q = qs.toString();
  return `${root}/models/${m}:${action}${q ? `?${q}` : ""}`;
}

function buildHeaders(apiKey) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
  };
}

module.exports = {
  id: "google-ai-studio",
  name: "Google AI Studio",
  alias: "ai-studio",
  modelTag: "google-ai-studio",
  modelTags: ["google-ai-studio", "ai-studio", "gemini"],
  wireFormat: "gemini",
  defaultBaseUrl: BASE,
  consoleUrl: "https://aistudio.google.com",
  description:
    "Google AI Studio API key · models: gemini-3.6-flash, gemini-3.1-pro, gemini-2.5-pro, gemini-3.1-flash, gemini-3.1-flash-image (Interactions API)",
  supportsOauth: false,
  supportsApiKey: true,
  supportsCliImport: false,
  emptyCatalog: false,
  catalogModels: GEMINI_CATALOG,

  buildUrl,
  buildHeaders,

  parseStreamData(json) {
    return json;
  },
};
