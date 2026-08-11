/**
 * Gemini CLI / Code Assist OAuth client (public Google installed-app credentials).
 * Source: OmniRoute open-sse/utils/publicCreds.ts (gemini_id / gemini_alt).
 * Public client identifiers for native OAuth + PKCE/secret exchange — not app secrets.
 */

const CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID ||
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

const CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET || "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";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const BASE_URLS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

function geminiCliUserAgent() {
  const plat =
    process.platform === "win32"
      ? "windows; x64"
      : process.platform === "darwin"
        ? "darwin; arm64"
        : "linux; x64";
  return `GeminiCLI/0.1.0 (${plat})`;
}

/** Official Gemini CLI Code Assist metadata (Google gemini-cli). */
function loadCodeAssistMetadata() {
  return {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
}

function headers(profile, accessToken) {
  const h = {
    "Content-Type": "application/json",
    "User-Agent": geminiCliUserAgent(),
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

function endpoint(path) {
  return BASE_URLS.map((b) => `${b}${path}`);
}

module.exports = {
  CLIENT_ID,
  CLIENT_SECRET,
  AUTHORIZE_URL,
  TOKEN_URL,
  USERINFO_URL,
  SCOPES,
  BASE_URLS,
  geminiCliUserAgent,
  loadCodeAssistMetadata,
  headers,
  endpoint,
  loadCodeAssistUrls: () => endpoint("/v1internal:loadCodeAssist"),
  onboardUserUrls: () => endpoint("/v1internal:onboardUser"),
  fetchAvailableModelsUrls: () => endpoint("/v1internal:fetchAvailableModels"),
  streamGenerateContentPath: "/v1internal:streamGenerateContent?alt=sse",
};
