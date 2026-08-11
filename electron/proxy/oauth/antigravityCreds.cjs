/**
 * Antigravity public OAuth client (Google installed-app / OmniRoute antigravity_id|alt).
 * Public client identifiers for native OAuth — not app secrets.
 */

const CLIENT_ID =
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ||
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

const CLIENT_SECRET =
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET ||
  "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";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const FALLBACK_VERSION = "1.104.0";
const CHROME_VERSION = "142.0.7444.175";
const ELECTRON_VERSION = "39.2.3";

function antigravityUserAgent(platform = process.platform) {
  let plat = "X11; Linux x86_64";
  if (platform === "win32") plat = "Windows NT 10.0; Win64; x64";
  else if (platform === "darwin") plat = "Macintosh; Intel Mac OS X 10_15_7";
  return `Antigravity/${FALLBACK_VERSION} (${plat}) Chrome/${CHROME_VERSION} Electron/${ELECTRON_VERSION}`;
}

function antigravityNativeOAuthUserAgent() {
  return `vscode/1.X.X (Antigravity/${FALLBACK_VERSION})`;
}

function loadCodeAssistMetadata() {
  return { ideType: "ANTIGRAVITY" };
}

function headers(profile, accessToken) {
  const h = {
    "Content-Type": "application/json",
    "User-Agent":
      profile === "loadCodeAssist" ? antigravityNativeOAuthUserAgent() : antigravityUserAgent(),
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
  FALLBACK_VERSION,
  antigravityUserAgent,
  antigravityNativeOAuthUserAgent,
  loadCodeAssistMetadata,
  headers,
  endpoint,
  loadCodeAssistUrls: () => endpoint("/v1internal:loadCodeAssist"),
  onboardUserUrls: () => endpoint("/v1internal:onboardUser"),
  fetchAvailableModelsUrls: () => endpoint("/v1internal:fetchAvailableModels"),
  streamGenerateContentPath: "/v1internal:streamGenerateContent?alt=sse",
};
