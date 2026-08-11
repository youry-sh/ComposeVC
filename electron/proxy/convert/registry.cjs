/**
 * Modular converter registry: wireFormat pairs.
 * Add a provider converter by registering request + response transformers.
 *
 *   registerConverter('openai', 'anthropic', { request, responseMessage, createStreamState, streamEvent })
 */

const converters = new Map();
const { exec: executeWorkerTask } = require("../../workerPool.cjs");

function key(from, to) {
  return `${from}->${to}`;
}

function registerConverter(from, to, handlers) {
  converters.set(key(from, to), {
    from,
    to,
    request: handlers.request,
    responseMessage: handlers.responseMessage || null,
    createStreamState: handlers.createStreamState || null,
    streamEvent: handlers.streamEvent || null,
  });
}

function getConverter(from, to) {
  return converters.get(key(from, to)) || null;
}

function listConverters() {
  return [...converters.keys()];
}

async function convertRequestAsync(from, to, body, options = {}) {
  bootstrap();
  return executeWorkerTask("convertRequest", { from, to, body, options });
}

function bootstrap() {
  if (converters.size) return;

  const { openaiToAnthropicRequest } = require("./openai-to-anthropic.cjs");
  const {
    anthropicMessageToOpenAI,
    createAnthropicStreamState,
    anthropicEventToOpenAIChunks,
  } = require("./anthropic-to-openai.cjs");
  const { openaiToGeminiRequest } = require("./openai-to-gemini.cjs");
  const {
    geminiCandidateToOpenAI,
    createGeminiStreamState,
    geminiStreamToOpenAIChunks,
  } = require("./gemini-to-openai.cjs");
  const {
    openaiToOpenAIRequest,
    normalizeOpenAIResponse,
    createOpenAIStreamState,
    normalizeOpenAIChunk,
  } = require("./openai-passthrough.cjs");
  const { openaiToResponsesRequest } = require("./openai-to-responses.cjs");
  const { openaiToDeepSeekRequest } = require("./openai-to-deepseek.cjs");
  const {
    responsesMessageToOpenAI,
    createResponsesStreamState,
    responsesEventToOpenAIChunks,
  } = require("./responses-to-openai.cjs");

  // Hub format is always 'openai' on the client side.
  // Some OpenAI-compatible endpoints (e.g. custom LiteLLM / Nous Inference with an
  // "anthropic/..." model) unexpectedly answer with Anthropic Messages SSE events even
  // though the wireFormat is "openai". Auto-detect those events and route them through
  // the Anthropic→OpenAI converter so chunks are never silently dropped (fixes the
  // "upstream closed without any content chunk" retry-loop regardless of provider).
  const isAnthropicEvent = (c) =>
    c && typeof c === "object" && !Array.isArray(c.choices) &&
    (/^(message_|content_block_|ping$|error$)/.test(String(c.type || "")) ||
      c.content_block ||
      c.delta?.type?.endsWith("_delta") ||
      c.message?.content);
  const openAICompatibleStreamEvent = (chunk, state) => {
    const eventType = chunk?.type ? String(chunk.type) : "";
    if (eventType.startsWith("response.") || eventType.startsWith("thread.message.")) {
      if (!state.responses) state.responses = createResponsesStreamState(state.model);
      return responsesEventToOpenAIChunks(chunk, state.responses);
    }
    if (isAnthropicEvent(chunk)) {
      if (!state.anthropic) state.anthropic = createAnthropicStreamState(state.model);
      return anthropicEventToOpenAIChunks(chunk, state.anthropic);
    }
    const n = normalizeOpenAIChunk(chunk, state);
    return n ? [n] : [];
  };

  registerConverter("openai", "openai", {
    request: (body, opts) => openaiToOpenAIRequest(body, opts),
    responseMessage: (data, model) => normalizeOpenAIResponse(data, model),
    createStreamState: (model) => createOpenAIStreamState(model),
    streamEvent: openAICompatibleStreamEvent,
  });

  registerConverter("openai", "deepseek", {
    request: (body, opts) => openaiToDeepSeekRequest(body, opts),
    responseMessage: (data, model) => normalizeOpenAIResponse(data, model),
    createStreamState: (model) => createOpenAIStreamState(model),
    streamEvent: openAICompatibleStreamEvent,
  });

  registerConverter("openai", "anthropic", {
    request: (body, opts) => openaiToAnthropicRequest(body, opts),
    responseMessage: (data, model) => anthropicMessageToOpenAI(data, model),
    createStreamState: (model) => createAnthropicStreamState(model),
    streamEvent: (event, state) => anthropicEventToOpenAIChunks(event, state),
  });

  registerConverter("openai", "gemini", {
    request: (body, opts) => openaiToGeminiRequest(body, opts),
    responseMessage: (data, model, meta) =>
      geminiCandidateToOpenAI(data, model, meta?.toolNameMap),
    createStreamState: (model, meta) => createGeminiStreamState(model, meta),
    streamEvent: (data, state) => geminiStreamToOpenAIChunks(data, state),
  });

  const registerOpenAICompatible = (providerId) => {
    registerConverter("openai", providerId, {
      request: (body, opts) => openaiToOpenAIRequest(body, opts),
      responseMessage: (data, model) => normalizeOpenAIResponse(data, model),
      createStreamState: (model) => createOpenAIStreamState(model),
      streamEvent: openAICompatibleStreamEvent,
    });
  };

  ["github-copilot", "windsurf", "cursor", "codebuddy", "codebuddy-cn", "qoder", "opencode-go", "openrouter", "zai"].forEach(
    registerOpenAICompatible
  );

  registerConverter("openai", "openai-responses", {
    request: (body, opts) => openaiToResponsesRequest(body, opts),
    responseMessage: (data, model) => responsesMessageToOpenAI(data, model),
    createStreamState: (model) => createResponsesStreamState(model),
    streamEvent: (event, state) => responsesEventToOpenAIChunks(event, state),
  });

  registerConverter("openai", "opencode-responses", {
    request: (body, opts) => openaiToResponsesRequest(body, opts),
    responseMessage: (data, model) => responsesMessageToOpenAI(data, model),
    createStreamState: (model) => createResponsesStreamState(model),
    streamEvent: (event, state) => responsesEventToOpenAIChunks(event, state),
  });

  registerConverter("openai", "grok", {
    request: (body, opts) => openaiToOpenAIRequest(body, opts),
    responseMessage: (data, model) => normalizeOpenAIResponse(data, model),
    createStreamState: (model) => createOpenAIStreamState(model),
    streamEvent: openAICompatibleStreamEvent,
  });

  // Antigravity: Gemini-shaped request inside Cloud Code envelope
  const { openaiToAntigravityRequest } = require("./openai-to-antigravity.cjs");
  registerConverter("openai", "antigravity", {
    request: (body, opts) => openaiToAntigravityRequest(body, opts),
    responseMessage: (data, model, meta) =>
      geminiCandidateToOpenAI(data, model, meta?.toolNameMap),
    createStreamState: (model, meta) => createGeminiStreamState(model, meta),
    streamEvent: (data, state) => geminiStreamToOpenAIChunks(data, state),
  });

  // Gemini CLI / Code Assist (same Cloud Code envelope, gemini-cli userAgent)
  const { openaiToGeminiCliRequest } = require("./openai-to-gemini-cli.cjs");
  registerConverter("openai", "gemini-cli", {
    request: (body, opts) => openaiToGeminiCliRequest(body, opts),
    responseMessage: (data, model, meta) =>
      geminiCandidateToOpenAI(data, model, meta?.toolNameMap),
    createStreamState: (model, meta) => createGeminiStreamState(model, meta),
    streamEvent: (data, state) => geminiStreamToOpenAIChunks(data, state),
  });

  // Kiro / CodeWhisperer EventStream
  const { openaiToKiroRequest } = require("./openai-to-kiro.cjs");
  const {
    kiroMessageToOpenAI,
    createKiroStreamState,
    kiroStreamToOpenAIChunks,
  } = require("./kiro-to-openai.cjs");
  registerConverter("openai", "kiro", {
    request: (body, opts) => openaiToKiroRequest(body, opts),
    responseMessage: (data, model) => kiroMessageToOpenAI(data, model),
    createStreamState: (model) => createKiroStreamState(model),
    streamEvent: (data, state) => kiroStreamToOpenAIChunks(data, state),
  });
}

module.exports = {
  registerConverter,
  getConverter,
  listConverters,
  convertRequestAsync,
  bootstrap,
};
