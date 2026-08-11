/**
 * Kiro (AWS CodeWhisperer / Amazon Q) OAuth provider.
 * OmniRoute parity: generateAssistantResponse + EventStream.
 */

const creds = require("../oauth/kiroCreds.cjs");

module.exports = {
  id: "kiro",
  name: "Kiro",
  alias: "kiro",
  modelTag: "kiro",
  modelTags: ["kiro", "kr"],
  wireFormat: "kiro",
  defaultBaseUrl: "https://codewhisperer.us-east-1.amazonaws.com",
  description:
    "AWS Kiro / CodeWhisperer (Builder ID device OAuth or paste refresh token). Use live model list (Proxy → Kiro → refresh). Safe defaults: kiro/claude-haiku-4.5, kiro/claude-sonnet-4.5. Invalid model is non-retryable.",
  supportsOauth: true,
  supportsApiKey: false,
  supportsCliImport: true,
  website: "https://kiro.dev",
  consoleUrl: "https://app.kiro.dev",
  streamMode: "eventstream",

  buildUrl(baseUrl, opts = {}) {
    const region =
      opts.region ||
      opts.providerMeta?.region ||
      (String(baseUrl || "").includes("q.")
        ? String(baseUrl).match(/q\.([a-z0-9-]+)\.amazonaws/)?.[1]
        : null) ||
      "us-east-1";
    return `${creds.runtimeHost(region)}/generateAssistantResponse`;
  },

  buildHeaders(apiKey, opts = {}) {
    const token = apiKey || opts.accessToken || "";
    return {
      ...creds.getKiroServiceHeaders("application/vnd.amazon.eventstream"),
      Authorization: `Bearer ${token}`,
    };
  },

  /** Strip unknown top-level fields before fetch (Kiro is strict). */
  prepareRequest(body, account = {}) {
    const b = body && typeof body === "object" ? body : {};
    const payload = {};
    if (b.conversationState !== undefined) payload.conversationState = b.conversationState;
    if (b.profileArn !== undefined) payload.profileArn = b.profileArn;
    if (b.inferenceConfig !== undefined) payload.inferenceConfig = b.inferenceConfig;
    if (b.additionalModelRequestFields !== undefined) {
      payload.additionalModelRequestFields = b.additionalModelRequestFields;
    }
    // Inject profileArn from account if translator didn't set it
    const arn = account?.providerMeta?.profileArn || account?.workspaceId;
    if (arn && !payload.profileArn) payload.profileArn = arn;
    if (!payload.conversationState && b.conversationState == null) {
      const { model: _m, stream: _s, ...rest } = b;
      return { body: rest, headers: null };
    }
    return { body: payload, headers: null };
  },

  parseStreamData(json) {
    // EventStream is transformed to OpenAI SSE chunks upstream; pass through.
    return json;
  },
};
