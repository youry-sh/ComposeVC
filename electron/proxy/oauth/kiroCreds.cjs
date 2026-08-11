/**
 * Kiro (AWS CodeWhisperer / Amazon Q) constants — OmniRoute parity.
 */

const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

const KIRO_CONFIG = {
  ssoOidcEndpoint: "https://oidc.us-east-1.amazonaws.com",
  registerClientUrl: "https://oidc.us-east-1.amazonaws.com/client/register",
  deviceAuthUrl: "https://oidc.us-east-1.amazonaws.com/device_authorization",
  tokenUrl: "https://oidc.us-east-1.amazonaws.com/token",
  startUrl: "https://view.awsapps.com/start",
  clientName: "kiro-oauth-client",
  clientType: "public",
  scopes: [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations",
  ],
  grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
  socialAuthEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
  socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
  socialClientId: process.env.KIRO_OAUTH_CLIENT_ID || "kiro-cli",
};

const KIRO_SDK_USER_AGENT = "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0";
const KIRO_AMZ_USER_AGENT = "aws-sdk-js/3.0.0 kiro-ide/1.0.0";
const KIRO_STREAMING_TARGET =
  "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

/**
 * Offline catalog only — NOT an entitlement guarantee.
 * Order = prefer widely available free-tier ids first (haiku/sonnet-4.5).
 * Plan-gated ids (sonnet-5, some third-party) stay lower so defaults don't
 * pick them when live ListAvailableModels is unavailable.
 */
const FALLBACK_MODELS = [
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", owned_by: "kiro" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", owned_by: "kiro" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", owned_by: "kiro" },
  { id: "deepseek-3.2", name: "DeepSeek V3.2", owned_by: "kiro" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", owned_by: "kiro" },
  { id: "minimax-m2.1", name: "MiniMax M2.1", owned_by: "kiro" },
  { id: "glm-5", name: "GLM-5", owned_by: "kiro" },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", owned_by: "kiro" },
];

/** Prefer these when substituting invalid model (still only if in allowlist). */
const PREFERRED_DEFAULTS = ["claude-haiku-4.5", "claude-sonnet-4.5", "claude-sonnet-5"];

function assertValidAwsRegion(region) {
  const r = String(region || "").trim().toLowerCase();
  if (!AWS_REGION_PATTERN.test(r)) {
    throw new Error(`Invalid AWS region: ${region}`);
  }
  return r;
}

function resolveRegion(providerMeta = {}) {
  const explicit = String(providerMeta.region || "").trim().toLowerCase();
  if (explicit && AWS_REGION_PATTERN.test(explicit)) return explicit;
  const arn = String(providerMeta.profileArn || "");
  const fromArn = arn.toLowerCase().match(/^arn:aws:codewhisperer:([a-z0-9-]+):/)?.[1];
  if (fromArn) return fromArn;
  return "us-east-1";
}

function runtimeHost(region) {
  const r = String(region || "us-east-1").toLowerCase();
  return r === "us-east-1"
    ? "https://codewhisperer.us-east-1.amazonaws.com"
    : `https://q.${r}.amazonaws.com`;
}

function usageHost(region) {
  const r = String(region || "us-east-1").toLowerCase();
  return r === "us-east-1"
    ? "https://codewhisperer.us-east-1.amazonaws.com"
    : `https://q.${r}.amazonaws.com`;
}

function getKiroServiceHeaders(accept = "application/vnd.amazon.eventstream") {
  return {
    "Content-Type": "application/json",
    Accept: accept,
    "X-Amz-Target": KIRO_STREAMING_TARGET,
    "User-Agent": KIRO_SDK_USER_AGENT,
    "X-Amz-User-Agent": KIRO_AMZ_USER_AGENT,
  };
}

module.exports = {
  AWS_REGION_PATTERN,
  KIRO_CONFIG,
  KIRO_SDK_USER_AGENT,
  KIRO_AMZ_USER_AGENT,
  KIRO_STREAMING_TARGET,
  FALLBACK_MODELS,
  PREFERRED_DEFAULTS,
  assertValidAwsRegion,
  resolveRegion,
  runtimeHost,
  usageHost,
  getKiroServiceHeaders,
};
