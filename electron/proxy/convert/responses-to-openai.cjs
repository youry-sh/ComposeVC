/**
 * OpenAI Responses API (Codex SSE) → chat.completion / chat.completion.chunk
 */

const { chatChunk, chatCompletionResponse, uid, usageOpenAI } = require("../openaiFormat.cjs");

/**
 * Pull human-readable reasoning text from a Responses API "reasoning" item.
 * Handles: summary string, summary[] parts, content[] parts, encrypted-only (skip).
 */
function extractResponsesReasoningText(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [];

  const push = (v) => {
    if (v == null) return;
    if (typeof v === "string") {
      const t = v.trim();
      if (t) parts.push(t);
      return;
    }
    if (typeof v === "object") {
      // Common shapes: { type, text } | { type, summary_text } | { text: { value } }
      if (typeof v.text === "string") {
        const t = v.text.trim();
        if (t) parts.push(t);
      } else if (typeof v.summary_text === "string") {
        const t = v.summary_text.trim();
        if (t) parts.push(t);
      } else if (typeof v.value === "string") {
        const t = v.value.trim();
        if (t) parts.push(t);
      } else if (v.text && typeof v.text.value === "string") {
        const t = v.text.value.trim();
        if (t) parts.push(t);
      }
    }
  };

  if (typeof item.summary === "string") push(item.summary);
  else if (Array.isArray(item.summary)) item.summary.forEach(push);

  if (Array.isArray(item.content)) item.content.forEach(push);
  if (typeof item.content === "string") push(item.content);

  // Some payloads use nested reasoning fields
  if (typeof item.reasoning === "string") push(item.reasoning);
  if (Array.isArray(item.reasoning)) item.reasoning.forEach(push);

  // encrypted_content is opaque — do not surface as "think" text
  return parts.join("\n").trim();
}

function extractResponsesMessageText(item) {
  if (!item || typeof item !== "object") return "";
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (typeof v === "string") {
      if (v) parts.push(v);
      return;
    }
    if (typeof v === "object") {
      if (typeof v.text === "string") parts.push(v.text);
      else if (typeof v.output_text === "string") parts.push(v.output_text);
      else if (typeof v.value === "string") parts.push(v.value);
      else if (v.text && typeof v.text.value === "string") parts.push(v.text.value);
    }
  };
  if (typeof item.output_text === "string") push(item.output_text);
  if (typeof item.text === "string") push(item.text);
  if (typeof item.content === "string") push(item.content);
  if (Array.isArray(item.content)) item.content.forEach(push);
  return parts.join("");
}

function extractResponsesOutputText(response) {
  if (!response || typeof response !== "object") return "";
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  let text = "";
  for (const item of output) {
    if (item?.type === "message" || item?.role === "assistant") text += extractResponsesMessageText(item);
  }
  return text;
}

function extractResponsesEventText(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.delta === "string") return event.delta;
  if (typeof event.text === "string") return event.text;
  if (typeof event.output_text === "string") return event.output_text;
  if (typeof event.content === "string") return event.content;
  if (typeof event.part === "string") return event.part;
  if (event.part && typeof event.part === "object") return extractResponsesMessageText(event.part);
  if (event.content && typeof event.content === "object") return extractResponsesMessageText(event.content);
  return "";
}

function emitResponsesTextSuffix(text, state, ensureRole, out, id, model) {
  if (!text) return;
  const full = String(text);
  let add = full;
  if (state.text && full.startsWith(state.text)) add = full.slice(state.text.length);
  else if (state.text && state.text.endsWith(full)) add = "";
  if (!add) return;
  ensureRole();
  state.text += add;
  out.push(chatChunk({ id, model, delta: { content: add } }));
}

function createResponsesStreamState(model) {
  return {
    messageId: uid(),
    model,
    roleSent: false,
    toolIndex: 0,
    toolArgs: new Map(),
    text: "",
    reasoning: "",
    usage: null,
  };
}

function responsesEventToOpenAIChunks(event, state) {
  if (!event || typeof event !== "object") return [];
  const type = event.type || "";
  const id = state.messageId;
  const model = state.model;
  const out = [];

  const ensureRole = () => {
    if (!state.roleSent) {
      state.roleSent = true;
      out.push(chatChunk({ id, model, delta: { role: "assistant" } }));
    }
  };

  // Text deltas
  if (
    type === "response.output_text.delta" ||
    type === "response.content_part.delta" ||
    type === "response.content.delta" ||
    type === "response.text.delta" ||
    type === "thread.message.delta"
  ) {
    emitResponsesTextSuffix(extractResponsesEventText(event), state, ensureRole, out, id, model);
    return out;
  }

  // Reasoning deltas (OpenAI + xAI Grok Responses variants)
  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning.delta" ||
    type === "response.reasoning_summary.delta" ||
    type === "response.reasoning_summary_part.delta"
  ) {
    const delta =
      event.delta ??
      event.text ??
      (typeof event.part === "object" ? event.part?.text : "") ??
      "";
    if (delta) {
      ensureRole();
      state.reasoning += delta;
      out.push(chatChunk({ id, model, delta: { reasoning_content: String(delta) } }));
    }
    return out;
  }

  // Function call / reasoning item start
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const item = event.item || {};
    // Grok / Responses may ship a full reasoning item (summary or content arrays)
    if (item.type === "reasoning") {
      const piece = extractResponsesReasoningText(item);
      if (piece) {
        ensureRole();
        // Avoid double-emit on both added+done: only stream new suffix
        if (!state.reasoning.endsWith(piece)) {
          const add = state.reasoning
            ? piece.startsWith(state.reasoning)
              ? piece.slice(state.reasoning.length)
              : piece
            : piece;
          if (add) {
            state.reasoning = state.reasoning ? `${state.reasoning}${add}` : piece;
            out.push(chatChunk({ id, model, delta: { reasoning_content: String(add) } }));
          }
        }
      }
      return out;
    }
    if (item.type === "function_call" && type === "response.output_item.added") {
      ensureRole();
      const idx = state.toolIndex++;
      const callId = item.call_id || item.id || `call_${idx}`;
      const name = item.name || "";
      state.toolArgs.set(item.id || callId, {
        index: idx,
        id: callId,
        name,
        arguments: item.arguments || "",
      });
      out.push(
        chatChunk({
          id,
          model,
          delta: {
            tool_calls: [
              {
                index: idx,
                id: callId,
                type: "function",
                function: { name, arguments: item.arguments || "" },
              },
            ],
          },
        })
      );
    } else if (type === "response.output_item.done" && (item.type === "message" || item.role === "assistant")) {
      emitResponsesTextSuffix(extractResponsesMessageText(item), state, ensureRole, out, id, model);
    }
    return out;
  }

  // Function call args delta
  if (
    type === "response.function_call_arguments.delta" ||
    type === "response.output_item.delta"
  ) {
    const delta = event.delta ?? event.arguments ?? "";
    const itemId = event.item_id || event.output_index;
    let tc = null;
    if (itemId != null) tc = state.toolArgs.get(itemId);
    if (!tc && state.toolArgs.size) {
      tc = [...state.toolArgs.values()][state.toolArgs.size - 1];
    }
    if (tc && delta) {
      tc.arguments += delta;
      out.push(
        chatChunk({
          id,
          model,
          delta: {
            tool_calls: [{ index: tc.index, function: { arguments: String(delta) } }],
          },
        })
      );
    }
    return out;
  }

  if (
    type === "response.completed" ||
    type === "response.done" ||
    type === "response.output_text.done" ||
    type === "response.content_part.done" ||
    type === "response.text.done" ||
    type === "thread.message.completed"
  ) {
    emitResponsesTextSuffix(extractResponsesEventText(event), state, ensureRole, out, id, model);
    const resp = event.response || event.message || {};
    emitResponsesTextSuffix(extractResponsesOutputText(resp), state, ensureRole, out, id, model);
    if (resp.usage) {
      state.usage = {
        prompt_tokens: resp.usage.input_tokens || 0,
        completion_tokens: resp.usage.output_tokens || 0,
        total_tokens:
          (resp.usage.input_tokens || 0) + (resp.usage.output_tokens || 0),
      };
    }
    const hasTools = state.toolArgs.size > 0;
    out.push(
      chatChunk({
        id,
        model,
        delta: {},
        finishReason: hasTools ? "tool_calls" : "stop",
        usage: state.usage,
      })
    );
    return out;
  }

  if (type === "response.failed" || type === "error") {
    const msg =
      event.error?.message ||
      event.response?.error?.message ||
      event.response?.message ||
      event.message ||
      "Codex response failed";
    const err = new Error(String(msg));
    err.code = "UPSTREAM_RESPONSE_FAILED";
    err.upstreamEvent = event;
    throw err;
  }

  return out;
}

/** Non-streaming JSON response object → chat.completion */
function responsesMessageToOpenAI(data, model) {
  let content = "";
  let reasoning = "";
  const toolCalls = [];

  const output = data.output || data.response?.output || [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" || part.type === "text") {
          content += part.text || "";
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        name: item.name,
        arguments: item.arguments || "{}",
      });
    } else if (item.type === "reasoning") {
      const piece = extractResponsesReasoningText(item);
      if (piece) reasoning += (reasoning ? "\n" : "") + piece;
    }
  }

  // Some payloads put text at top level
  if (!content && data.output_text) content = data.output_text;

  const usage = data.usage
    ? {
        prompt_tokens: data.usage.input_tokens || 0,
        completion_tokens: data.usage.output_tokens || 0,
        total_tokens:
          (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
      }
    : null;

  return chatCompletionResponse({
    model,
    content,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage,
  });
}

module.exports = {
  createResponsesStreamState,
  responsesEventToOpenAIChunks,
  responsesMessageToOpenAI,
};
