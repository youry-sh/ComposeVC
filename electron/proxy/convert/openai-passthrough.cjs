/**
 * OpenAI-compatible upstream: request is already hub format.
 * Response may still need light normalization (usage, tool_calls, reasoning).
 */

const { stripThinkTags } = require("./thinking.cjs");
const { usageOpenAI, chatCompletionResponse, chatChunk, uid } = require("../openaiFormat.cjs");
const {
  contentToText,
  collectImages,
  modelSupportsImages,
} = require("../../adapters/contentParts.cjs");

/**
 * Strict text-only OpenAI-compatible endpoints (notably DeepSeek chat/reasoner)
 * reject a content-parts array even on assistant history turns. Convert every
 * role to one string and retain an attachment marker/data URL where possible.
 */
function flattenMessageToText(message) {
  const text = contentToText(message?.content);
  const images = collectImages(message);
  // A text-only model cannot inspect bytes. Do not inject a large base64 image into
  // its context: it wastes the context window and can itself trigger a 400/413.
  // Keep a small, readable attachment marker so history remains intelligible.
  const fallback = images
    .map((img, i) => `[Image attachment omitted for this text-only model: ${img.name || `image-${i + 1}`} (${img.mimeType || "image/*"})]`)
    .join("\n");
  return [text, fallback].filter(Boolean).join("\n\n");
}

function openaiToOpenAIRequest(openaiBody, opts = {}) {
  const out = { ...openaiBody };
  if (opts.upstreamModel) out.model = opts.upstreamModel;
  // Strip internal fields
  delete out._raw;

  // When upstream/model cannot take vision parts, flatten images → text so the
  // request never 400s. Uses modelSupportsImages heuristic when caller did not
  // explicitly set supportImages (default: try multimodal for known vision models).
  const supportImages =
    opts.supportImages != null
      ? Boolean(opts.supportImages)
      : modelSupportsImages(opts.upstreamModel || openaiBody.model || "", opts.providerType || "");
  if (!supportImages && Array.isArray(out.messages)) {
    // Do not exempt assistant or tool-history messages: serde text-only backends
    // validate *every* messages[N].content and reject any image_url variant.
    out.messages = out.messages.map((m) => {
      if (!m) return m;
      const hasImages = collectImages(m).length > 0;
      const hasParts = Array.isArray(m.content);
      if (!hasImages && !hasParts && !Array.isArray(m.images)) return m;
      return {
        ...m,
        content: flattenMessageToText(m),
        images: undefined,
      };
    });
  }
  // DeepSeek rejects assistant turns whose content is empty and which do not
  // contain tool calls. Preserve the turn while making it valid on the wire.
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((message) => {
      if (
        message?.role === "assistant" &&
        !message.tool_calls?.length &&
        (message.content == null || message.content === "")
      ) {
        return { ...message, content: " " };
      }
      return message;
    });
  }
  return out;
}

function normalizeOpenAIResponse(data, model) {
  if (!data || !data.choices) {
    return chatCompletionResponse({ model, content: "", finishReason: "stop" });
  }
  const choice = data.choices[0] || {};
  const msg = choice.message || {};
  let content = msg.content || "";
  let reasoning = msg.reasoning_content || msg.reasoning || "";

  if (typeof content === "string") {
    const stripped = stripThinkTags(content);
    content = stripped.content;
    if (stripped.reasoning) reasoning = (reasoning ? reasoning + "\n" : "") + stripped.reasoning;
  }

  const toolCalls = (msg.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    arguments: tc.function?.arguments || "{}",
  }));

  return chatCompletionResponse({
    id: data.id || uid(),
    model: data.model || model,
    content,
    reasoning,
    toolCalls,
    finishReason: choice.finish_reason || (toolCalls.length ? "tool_calls" : "stop"),
    usage: data.usage ? usageOpenAI(data.usage) : null,
  });
}

function createOpenAIStreamState(model) {
  return { messageId: null, model, roleSent: false };
}

/** Normalize an upstream OpenAI SSE chunk object */
function normalizeOpenAIChunk(chunk, state) {
  if (!chunk) return null;
  if (!Array.isArray(chunk.choices)) {
    const tokenText =
      typeof chunk.token?.text === "string"
        ? chunk.token.text
        : typeof chunk.text === "string"
          ? chunk.text
          : typeof chunk.output_text === "string"
            ? chunk.output_text
            : typeof chunk.generated_text === "string"
              ? chunk.generated_text
              : typeof chunk.output === "string"
                ? chunk.output
                : typeof chunk.data?.text === "string"
                  ? chunk.data.text
                  : typeof chunk.data?.content === "string"
                    ? chunk.data.content
                    : typeof chunk.response?.text === "string"
                      ? chunk.response.text
                      : typeof chunk.response?.output_text === "string"
                        ? chunk.response.output_text
                        : "";
    const finishReason =
      chunk.details?.finish_reason ||
      chunk.finish_reason ||
      (chunk.generated_text != null ? "stop" : null);
    if (!tokenText && !finishReason) return null;
    if (!state.messageId) state.messageId = chunk.id || uid();
    return chatChunk({
      id: state.messageId,
      model: chunk.model || state.model,
      delta: tokenText ? { content: tokenText } : {},
      finishReason,
      usage: chunk.usage || null,
    });
  }
  if (!state.messageId) state.messageId = chunk.id || uid();
  const choice = chunk.choices[0] || {};
  const message = choice.message || null;
  const delta = { ...(choice.delta || {}) };
  const choiceText =
    typeof choice.text === "string"
      ? choice.text
      : typeof choice.delta?.text === "string"
        ? choice.delta.text
        : typeof choice.delta?.output_text === "string"
          ? choice.delta.output_text
          : "";
  if (choiceText && delta.content == null) delta.content = choiceText;
  if (Array.isArray(delta.content)) {
    delta.content = delta.content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof part?.text === "string"
            ? part.text
            : typeof part?.content === "string"
              ? part.content
              : ""
      )
      .join("");
  }

  // Some OpenAI-compatible gateways return a full chat.completion object on an
  // event-stream response. Convert its message into a normal streaming delta.
  if (!choice.delta && message) {
    if (message.role) delta.role = message.role;
    if (message.content != null) delta.content = message.content;
    if (message.reasoning_content != null) delta.reasoning_content = message.reasoning_content;
    else if (message.reasoning != null) delta.reasoning_content = message.reasoning;
    if (message.tool_calls) delta.tool_calls = message.tool_calls;
  }

  if (typeof delta.refusal === "string" && delta.refusal.trim() && !delta.content) {
    delta.content = delta.refusal;
  }
  delete delta.refusal;

  // Promote reasoning fields (OpenAI / xAI / various gateways)
  if (delta.reasoning && !delta.reasoning_content) {
    delta.reasoning_content =
      typeof delta.reasoning === "string"
        ? delta.reasoning
        : delta.reasoning?.content || delta.reasoning?.text || "";
    delete delta.reasoning;
  }
  if (delta.thinking && !delta.reasoning_content) {
    delta.reasoning_content =
      typeof delta.thinking === "string"
        ? delta.thinking
        : delta.thinking?.content || delta.thinking?.text || "";
    delete delta.thinking;
  }
  if (delta.reasoning_content && typeof delta.reasoning_content !== "string") {
    delta.reasoning_content =
      delta.reasoning_content.content ||
      delta.reasoning_content.text ||
      String(delta.reasoning_content);
  }

  // Extract <think> from content deltas
  if (typeof delta.content === "string") {
    const stripped = stripThinkTags(delta.content);
    if (stripped.reasoning) {
      delta.reasoning_content = (delta.reasoning_content || "") + stripped.reasoning;
    }
    delta.content = stripped.content;
    if (!delta.content && !stripped.reasoning && choice.delta?.content) {
      delta.content = choice.delta.content;
    }
    if (!delta.content) delete delta.content;
  }

  // Drop empty reasoning_content so clients don't flash empty think blocks
  if (delta.reasoning_content != null && !String(delta.reasoning_content).trim()) {
    delete delta.reasoning_content;
  }

  return chatChunk({
    id: state.messageId,
    model: chunk.model || state.model,
    delta,
    finishReason: choice.finish_reason || null,
    usage: chunk.usage || null,
  });
}

module.exports = {
  openaiToOpenAIRequest,
  normalizeOpenAIResponse,
  createOpenAIStreamState,
  normalizeOpenAIChunk,
};
