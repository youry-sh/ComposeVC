const store = require("../labIn/knowledgeStore.cjs");

const ACTIONS = new Set(["stats", "list", "search", "read", "links", "add", "update"]);

function dense(value) {
  return { ...value, __toolText: JSON.stringify(value) };
}

module.exports = {
  name: "knowledge",
  description:
    "LAB-IN global persistent knowledge memory shared by every project. " +
    "Use action=add/update ONLY when the user explicitly asks to remember, save, replenish, or update memory. " +
    "action=search returns a ranked list: rank 1 is the best match, with score, strength (strong, partial, or weak), and via (direct, broad, or link). " +
    "Read strong hits, then partial hits. If the list is empty or the strongest hit is weak, search again with different concrete words and open links. " +
    "Do not treat the first two files as the answer. Knowledge is stored as readable chunks under Electron userData/lab-in/knowledge.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["stats", "list", "search", "read", "links", "add", "update"],
      },
      query: { type: "string", description: "Search query for action=search. Results come back best-first by rank." },
      id: { type: "string", description: "Chunk id for read/links/update" },
      title: { type: "string", description: "Clear chunk title for add/update" },
      content: { type: "string", description: "Knowledge text for add/update" },
      tags: { type: "array", items: { type: "string" } },
      links: { type: "array", items: { type: "string" }, description: "Related knowledge chunk ids" },
      source: { type: "string", description: "Origin/provenance of the knowledge" },
      chunkChars: { type: "number", description: "Optional target maximum chunk size for add" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    required: ["action"],
  },
  async execute(input = {}, context = {}) {
    const action = String(input.action || "").trim().toLowerCase();
    if (!ACTIONS.has(action)) throw new Error(`Unknown knowledge action: ${action || "(empty)"}`);
    if (context.knowledgeReadOnly === true && (action === "add" || action === "update")) {
      throw new Error("This LAB-IN search stage has read-only knowledge access");
    }
    const userDataPath = context.userDataPath;
    if (action === "stats") return dense(await store.knowledgeStats(userDataPath));
    if (action === "list") return dense(await store.listKnowledge(userDataPath, input));
    if (action === "search") {
      const results = await store.searchKnowledge(userDataPath, input.query, input);
      return dense({
        query: input.query,
        strongest: results.strongest || "none",
        broadened: Boolean(results.broadened),
        results,
      });
    }
    if (action === "read") return dense(await store.getKnowledgeChunk(userDataPath, input.id));
    if (action === "links") return dense(await store.knowledgeLinks(userDataPath, input.id));
    if (action === "add") {
      const result = await store.addKnowledge(userDataPath, input);
      context.onKnowledgeChanged?.({ type: "added", chunks: result.created || [] });
      return dense(result);
    }
    const result = await store.updateKnowledge(userDataPath, input);
    context.onKnowledgeChanged?.({ type: "updated", chunk: result });
    return dense(result);
  },
};
