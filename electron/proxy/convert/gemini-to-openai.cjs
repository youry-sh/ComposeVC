/**
 * Gemini generateContent response / stream chunks → OpenAI format.
 */

const { chatCompletionResponse, chatChunk, uid } = require("../openaiFormat.cjs");
const { stripThinkTags } = require("./thinking.cjs");
const thoughtSigs = require("./thoughtSignatures.cjs");

function geminiCandidateToOpenAI(data, model, toolNameMap) {
  const cand = data?.candidates?.[0];
  let textContent = "";
  let reasoning = "";
  const toolCalls = [];
  const imageParts = [];

  for (const part of cand?.content?.parts || []) {
    if (part.thought === true || part.thought) {
      reasoning += part.text || "";
      // thought parts can also carry signatures for later functionCalls
      const ts = thoughtSigs.extractFromPart(part);
      if (ts && part.functionCall) {
        /* handled below with functionCall */
      }
      continue;
    }
    if (part.text) {
      const stripped = stripThinkTags(part.text);
      textContent += stripped.content;
      if (stripped.reasoning) reasoning += stripped.reasoning;
    }
    // Gemini may return inline image data from image-generation / multimodal models
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType || inline.mime_type || "image/png";
      imageParts.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${inline.data}` },
      });
    }
    if (part.functionCall) {
      const name =
        toolNameMap?.get?.(part.functionCall.name) ||
        part.functionCall.name;
      const id = part.functionCall.id || `call_${uid("g")}`;
      const args = JSON.stringify(part.functionCall.args || {});
      const sig = thoughtSigs.rememberFromGeminiPart(part, id, {
        name,
        args: part.functionCall.args || {},
      });
      toolCalls.push({
        id,
        name,
        arguments: args,
        thoughtSignature: sig || undefined,
      });
    }
  }

  const um = data?.usageMetadata;
  const usage = um
    ? {
        prompt_tokens: um.promptTokenCount || 0,
        completion_tokens: um.candidatesTokenCount || 0,
        total_tokens: um.totalTokenCount || 0,
        completion_tokens_details: um.thoughtsTokenCount
          ? { reasoning_tokens: um.thoughtsTokenCount }
          : undefined,
      }
    : null;

  // Multimodal assistant content when provider returned images
  let content = textContent;
  if (imageParts.length) {
    const parts = [];
    if (textContent && String(textContent).trim()) {
      parts.push({ type: "text", text: textContent });
    }
    parts.push(...imageParts);
    content = parts;
  }

  return chatCompletionResponse({
    model,
    content,
    reasoning,
    toolCalls,
    finishReason: mapGeminiFinish(cand?.finishReason, toolCalls.length > 0),
    usage,
  });
}

function mapGeminiFinish(reason, hasTools) {
  if (hasTools) return "tool_calls";
  if (reason === "MAX_TOKENS") return "length";
  if (reason === "SAFETY" || reason === "RECITATION") return "content_filter";
  return "stop";
}

function createGeminiStreamState(model, meta) {
  const map =
    meta instanceof Map
      ? meta
      : meta?.toolNameMap instanceof Map
        ? meta.toolNameMap
        : new Map();
  return {
    messageId: uid(),
    model,
    toolNameMap: map,
    toolIndex: 0,
    started: false,
  };
}

/** Convert one Gemini stream JSON object to OpenAI chunks */
function geminiStreamToOpenAIChunks(data, state) {
  const results = [];
  const id = state.messageId;
  const model = state.model;
  if (!state.started) {
    state.started = true;
    results.push(chatChunk({ id, model, delta: { role: "assistant" } }));
  }

  const cand = data?.candidates?.[0];
  for (const part of cand?.content?.parts || []) {
    if (part.thought === true || part.thought) {
      if (part.text) {
        results.push(chatChunk({ id, model, delta: { reasoning_content: part.text } }));
      }
      continue;
    }
    if (part.text) {
      const stripped = stripThinkTags(part.text);
      if (stripped.reasoning) {
        results.push(chatChunk({ id, model, delta: { reasoning_content: stripped.reasoning } }));
      }
      if (stripped.content) {
        results.push(chatChunk({ id, model, delta: { content: stripped.content } }));
      }
    }
    if (part.functionCall) {
      const name =
        state.toolNameMap.get?.(part.functionCall.name) || part.functionCall.name;
      const idx = state.toolIndex++;
      const callId = part.functionCall.id || `call_${id}_${idx}`;
      const args = JSON.stringify(part.functionCall.args || {});
      const sig = thoughtSigs.rememberFromGeminiPart(part, callId, {
        name,
        args: part.functionCall.args || {},
      });
      const tc = {
        index: idx,
        id: callId,
        type: "function",
        function: { name, arguments: args },
      };
      if (sig) {
        tc.thought_signature = sig;
        tc.extra_content = { google: { thought_signature: sig } };
      }
      results.push(
        chatChunk({
          id,
          model,
          delta: {
            tool_calls: [tc],
          },
        })
      );
    }
  }

  if (cand?.finishReason) {
    const um = data?.usageMetadata;
    const usage = um
      ? {
          prompt_tokens: um.promptTokenCount || 0,
          completion_tokens: um.candidatesTokenCount || 0,
          total_tokens: um.totalTokenCount || 0,
        }
      : null;
    results.push(
      chatChunk({
        id,
        model,
        delta: {},
        finishReason: mapGeminiFinish(cand.finishReason, false),
        usage,
      })
    );
  }

  return results;
}

module.exports = {
  geminiCandidateToOpenAI,
  createGeminiStreamState,
  geminiStreamToOpenAIChunks,
  mapGeminiFinish,
};
