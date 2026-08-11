module.exports = {
  name: "spawn_subagent",
  description:
    "Launch ONE focused sub-agent (same model) in its own context; waits until it finishes by default, or returns a jobId immediately with background=true so the parent can continue and call wait_subagents later. " +
    "Use for LARGE multi-area search (2–4 parallel spawn_subagent in one turn) OR one heavy unit of work.\n\n" +
    "Modes: explore (read-only, default) | general (edit code) | worker (general task execution).\n" +
    "For MANY similar jobs (e.g. 50 accounts, waves of 5) use spawn_subagent_batch instead — " +
    "it runs concurrency waves until the queue is empty.\n\n" +
    "Do NOT use for tiny checks you can do in a few tool calls. " +
    "Write a self-contained prompt. Subagents cannot spawn further. " +
    "Subagents CAN ask_user / ask_otp (wait) — human answers in the UI and that unit continues.\n\n" +
    "FULL-LIST: for research/findings/advice prompts, instruct the subagent to return the ENTIRE list of " +
    "items in one final answer (not one tip). You (main) wait, then review the full list — do not re-ask for the next tip.",
  isReadOnly: true,
  isParallelSafe: true,
  inputSchema: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "Short 3–8 word label shown in the UI (e.g. 'Find auth handlers').",
      },
      prompt: {
        type: "string",
        description:
          "Full self-contained task for the subagent. Include goal, relevant paths, and what to return. " +
          "For findings/advice: require a complete list dump in one answer (all items), not a single recommendation.",
      },
      mode: {
        type: "string",
        enum: ["explore", "general", "worker"],
        description:
          "explore (default): read-only. general: may edit code. " +
          "worker: executes one general task with the registered tools.",
      },
      background: {
        type: "boolean",
        description: "Start asynchronously and return a jobId immediately. Use wait_subagents later to collect the result.",
      },
    },
    required: ["description", "prompt"],
  },
  async execute(input, context = {}) {
    const description = String(input.description || "").trim();
    const prompt = String(input.prompt || "").trim();
    if (!description) throw new Error("'description' is required");
    if (!prompt) throw new Error("'prompt' is required");

    const rawMode = String(input.mode || "explore").toLowerCase();
    const mode =
      rawMode === "general" || rawMode === "worker"
        ? rawMode
        : rawMode === "auto" || rawMode === "account"
          ? "worker"
          : "explore";

    if (!context.spawnSubagent || typeof context.spawnSubagent !== "function") {
      throw new Error("spawn_subagent is not available in this session");
    }

    return context.spawnSubagent({
      description,
      prompt,
      mode,
      background: Boolean(input.background),
      toolCallId: context.toolCallId,
    });
  },
};
