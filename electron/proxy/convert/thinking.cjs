/**
 * Thinking / reasoning block normalization across providers.
 * Maps: Claude thinking blocks, Gemini thoughts, <think> tags, reasoning_content.
 */

const OPEN_TAGS = ["think", "thinking", "thought", "internal_thought", "reasoning"];

/**
 * Strip <think>/<thinking>/… tags from model text.
 *
 * IMPORTANT: do NOT trim content. This runs on every SSE delta for Gemini /
 * Antigravity / OpenAI-compatible streams. Trimming each chunk ate leading/
 * trailing spaces and glued words: "входящие " + "сообщения" → "входящиесообщения".
 */
function stripThinkTags(text) {
  if (!text || typeof text !== "string") return { content: text || "", reasoning: "" };
  let reasoning = "";
  let content = text;

  for (const tag of OPEN_TAGS) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    content = content.replace(re, (_m, inner) => {
      const innerText = String(inner || "");
      // Trim only the extracted reasoning body, not the surrounding content.
      const piece = innerText.replace(/^\s+|\s+$/g, "");
      if (piece) reasoning += (reasoning ? "\n" : "") + piece;
      return "";
    });
  }

  // Unclosed <think>... at start (common in streaming partials)
  const unclosed = content.match(/^<think(?:ing)?[^>]*>([\s\S]*)$/i);
  if (unclosed) {
    reasoning += (reasoning ? "\n" : "") + unclosed[1];
    content = "";
  }

  // Preserve content whitespace (streaming-safe). Only tidy reasoning ends.
  return {
    content,
    reasoning: reasoning.replace(/^\s+|\s+$/g, ""),
  };
}

/** Merge reasoning into OpenAI message / delta fields. */
function applyReasoningToMessage(message, reasoning) {
  if (!message || !reasoning) return message;
  const prev = message.reasoning_content || "";
  message.reasoning_content = prev ? `${prev}${reasoning}` : reasoning;
  return message;
}

function reasoningEffortToBudget(effort) {
  const e = String(effort || "").toLowerCase();
  if (e === "low") return 1024;
  if (e === "medium") return 8192;
  if (e === "high") return 16384;
  if (e === "xhigh" || e === "max") return 32768;
  return null;
}

module.exports = {
  stripThinkTags,
  applyReasoningToMessage,
  reasoningEffortToBudget,
  OPEN_TAGS,
};
