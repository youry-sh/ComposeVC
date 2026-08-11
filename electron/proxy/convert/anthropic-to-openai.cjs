/**
 * Anthropic Messages (JSON + SSE events) → OpenAI chat.completions.
 * Maps thinking → reasoning_content, tool_use → tool_calls, usage tokens.
 */

const { chatCompletionResponse, chatChunk, uid, usageOpenAI } = require("../openaiFormat.cjs");

/** Non-streaming Anthropic message object → OpenAI completion */
function anthropicMessageToOpenAI(msg, model) {
  let textContent = "";
  let reasoning = "";
  const toolCalls = [];
  const imageParts = [];

  for (const block of msg.content || []) {
    if (block.type === "text") textContent += block.text || "";
    else if (block.type === "thinking") reasoning += block.thinking || "";
    else if (block.type === "image") {
      // Anthropic image block → OpenAI image_url (data URL or remote)
      const src = block.source || {};
      if (src.type === "base64" && src.data) {
        const mime = src.media_type || "image/png";
        imageParts.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${src.data}` },
        });
      } else if (src.type === "url" && src.url) {
        imageParts.push({
          type: "image_url",
          image_url: { url: src.url },
        });
      }
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
      });
    }
  }

  const usage = msg.usage
    ? {
        prompt_tokens: msg.usage.input_tokens || 0,
        completion_tokens: msg.usage.output_tokens || 0,
        total_tokens: (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0),
      }
    : null;

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
    id: msg.id ? `chatcmpl-${msg.id}` : uid(),
    model: model || msg.model,
    content,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : mapStop(msg.stop_reason),
    usage,
  });
}

function mapStop(reason) {
  if (reason === "end_turn") return "stop";
  if (reason === "max_tokens") return "length";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "stop_sequence") return "stop";
  return "stop";
}

/**
 * Streaming state machine: feed Anthropic SSE event objects, get OpenAI chunks[].
 */
function createAnthropicStreamState(model) {
  return {
    messageId: uid(),
    model,
    toolCalls: new Map(), // block index → tool call
    toolCallIndex: 0,
    inThinking: false,
    usage: null,
  };
}

function anthropicEventToOpenAIChunks(event, state) {
  if (!event || !event.type) return [];
  const results = [];
  const id = state.messageId;
  const model = state.model;

  switch (event.type) {
    case "message_start": {
      state.messageId = event.message?.id
        ? `chatcmpl-${event.message.id}`
        : state.messageId;
      if (event.message?.model) state.model = event.message.model;
      results.push(chatChunk({ id: state.messageId, model: state.model, delta: { role: "assistant" } }));
      if (event.message?.usage) {
        state.usage = {
          prompt_tokens: event.message.usage.input_tokens || 0,
          completion_tokens: event.message.usage.output_tokens || 0,
        };
      }
      break;
    }
    case "content_block_start": {
      const block = event.content_block;
      if (block?.type === "thinking") {
        state.inThinking = true;
        results.push(chatChunk({ id, model, delta: { reasoning_content: "" } }));
      } else if (block?.type === "tool_use") {
        const idx = state.toolCallIndex++;
        const tc = {
          index: idx,
          id: block.id,
          type: "function",
          function: { name: block.name || "", arguments: "" },
        };
        state.toolCalls.set(event.index, tc);
        results.push(
          chatChunk({
            id,
            model,
            delta: { tool_calls: [{ index: idx, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] },
          })
        );
      }
      break;
    }
    case "content_block_delta": {
      const d = event.delta;
      if (d?.type === "text_delta" && d.text) {
        results.push(chatChunk({ id, model, delta: { content: d.text } }));
      } else if (d?.type === "thinking_delta" && d.thinking) {
        results.push(chatChunk({ id, model, delta: { reasoning_content: d.thinking } }));
      } else if (d?.type === "input_json_delta" && d.partial_json) {
        const tc = state.toolCalls.get(event.index);
        if (tc) {
          tc.function.arguments += d.partial_json;
          results.push(
            chatChunk({
              id,
              model,
              delta: {
                tool_calls: [
                  { index: tc.index, function: { arguments: d.partial_json } },
                ],
              },
            })
          );
        }
      }
      break;
    }
    case "content_block_stop": {
      state.inThinking = false;
      break;
    }
    case "message_delta": {
      if (event.usage) {
        state.usage = {
          prompt_tokens: state.usage?.prompt_tokens || 0,
          completion_tokens: event.usage.output_tokens || 0,
          total_tokens:
            (state.usage?.prompt_tokens || 0) + (event.usage.output_tokens || 0),
        };
      }
      const fr = mapStop(event.delta?.stop_reason);
      results.push(
        chatChunk({
          id,
          model,
          delta: {},
          finishReason: fr,
          usage: state.usage,
        })
      );
      break;
    }
    case "message_stop":
      break;
    default:
      break;
  }
  return results;
}

module.exports = {
  anthropicMessageToOpenAI,
  createAnthropicStreamState,
  anthropicEventToOpenAIChunks,
  mapStop,
};
