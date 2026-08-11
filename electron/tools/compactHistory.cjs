module.exports = {
  name: "compact_history",
  description: "Summarize and compact the earlier conversation history to free up context window space, keeping the most recent messages intact. Use when the user asks to compact/summarize the chat, or when context is running low.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      keep_recent: { type: "number", description: "Number of most recent messages to keep uncompacted, default 6" },
    },
  },
  async execute(input, context) {
    if (!context.compactHistory) {
      throw new Error("Compaction is not available in this context");
    }

    const result = await context.compactHistory(input.keep_recent);
    return {
      removedCount: result.removedCount,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      summary: result.summary,
    };
  },
};
