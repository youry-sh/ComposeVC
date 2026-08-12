/**
 * Claude Code (Anthropic) OAuth public client credentials.
 * OmniRoute parity: CLAUDE_CONFIG + claudeIdentity versions.
 *
 * These are public desktop/CLI client ids secured by PKCE (RFC 8252),
 * not confidential secrets.
 */

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
/** Fixed Anthropic redirect — user pastes code#state after browser login. */
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
];
const CODE_CHALLENGE_METHOD = "S256";
const ANTHROPIC_BETA_OAUTH = "oauth-2025-04-20";
const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Pinned current Claude Code release. Opus 5 requires >=2.1.219 and Sonnet 5
 * requires >=2.1.197, so an older identity hides/rejects the newest models.
 */
const CLAUDE_CODE_VERSION = "2.1.228";
const CLAUDE_CODE_STAINLESS_VERSION = "0.94.0";
const API_BASE = "https://api.anthropic.com";
const MESSAGES_URL = `${API_BASE}/v1/messages`;
const BOOTSTRAP_URL = `${API_BASE}/api/claude_cli/bootstrap`;
const OAUTH_USAGE_URL = `${API_BASE}/api/oauth/usage`;

function claudeCliUserAgent() {
  return `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`;
}

function claudeCodeUsageUserAgent() {
  return `claude-code/${CLAUDE_CODE_VERSION}`;
}

function stainlessOS() {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    case "freebsd":
      return "FreeBSD";
    default:
      return "Unknown";
  }
}

function stainlessArch() {
  switch (process.arch) {
    case "x64":
      return "x64";
    case "arm64":
      return "arm64";
    case "ia32":
      return "x32";
    default:
      return process.arch;
  }
}

module.exports = {
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  SCOPES,
  CODE_CHALLENGE_METHOD,
  ANTHROPIC_BETA_OAUTH,
  ANTHROPIC_VERSION,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_STAINLESS_VERSION,
  API_BASE,
  MESSAGES_URL,
  BOOTSTRAP_URL,
  OAUTH_USAGE_URL,
  claudeCliUserAgent,
  claudeCodeUsageUserAgent,
  stainlessOS,
  stainlessArch,
};
