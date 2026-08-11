module.exports = {
  name: "wait_subagents",
  description: "Wait for asynchronously started subagents or Soviet-7 background jobs and return all completed results.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      jobIds: {
        type: "array",
        items: { type: "string" },
        description: "Specific job IDs returned by background spawn calls.",
      },
      all: {
        type: "boolean",
        description: "Wait for every currently tracked background job.",
      },
    },
    required: [],
  },
  async execute(input = {}, context = {}) {
    if (!context.spawnSubagent || typeof context.spawnSubagent.wait !== "function") {
      throw new Error("wait_subagents is not available in this session");
    }
    return context.spawnSubagent.wait({
      jobIds: input.jobIds,
      all: Boolean(input.all),
    });
  },
};
