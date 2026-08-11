/**
 * Kiro stream/response helpers.
 * After EventStream→SSE transform, chunks are already OpenAI-shaped.
 */

function createKiroStreamState(model) {
  return {
    model: model || "kiro",
    started: false,
  };
}

function kiroStreamToOpenAIChunks(data, state) {
  if (!data || typeof data !== "object") return [];
  // Pass-through OpenAI chat.completion.chunk
  if (data.object === "chat.completion.chunk" || data.choices) {
    if (state && !state.started) state.started = true;
    return [data];
  }
  return [];
}

function kiroMessageToOpenAI(data, model) {
  // Non-stream fallback (rare — Kiro is eventstream)
  if (data?.choices) return data;
  const content =
    data?.content ||
    data?.output ||
    data?.assistantResponseMessage?.content ||
    "";
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || "kiro",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: String(content || "") },
        finish_reason: "stop",
      },
    ],
  };
}

module.exports = {
  createKiroStreamState,
  kiroStreamToOpenAIChunks,
  kiroMessageToOpenAI,
};
