/**
 * spawn_subagent_batch — wave runner for many parallel unit tasks.
 *
 * Example: 50 accounts, concurrency 5 → starts 5 workers; when one finishes
 * the next unit starts, until the queue is empty. Parent waits for all.
 * Units may call ask_user / ask_otp wait — each gets its own UI card; human
 * answers unstick that unit only (other units keep running).
 */

function parseTasks(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null) return [];
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return [];
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return j;
    } catch {
      /* fall through — treat as single unit? no */
    }
    // newline-separated units
    if (s.includes("\n")) {
      return s
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    }
    return [s];
  }
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    // count only — expand with shared_prompt
    const n = Math.min(200, Math.floor(raw));
    return Array.from({ length: n }, (_, i) => ({
      description: `unit ${i + 1}`,
      prompt: `UNIT_INDEX=${i + 1}\nTOTAL=${n}`,
      index: i + 1,
    }));
  }
  return [];
}

module.exports = {
  name: "spawn_subagent_batch",
  description:
    "Run MANY unit sub-agents in waves (default concurrency 5), waiting for all by default; with background=true return a jobId immediately so the parent can continue and call wait_subagents later. " +
    "Use when the user wants N accounts / N similar jobs (e.g. 50 acc → 5 at a time, " +
    "as each finishes start the next, until all done). Parent WAITS for the full batch.\n\n" +
    "Each unit gets its own context and the registered tools. " +
    "Subagents do not spawn further. Soft-fail per unit — one failure does not kill the wave.\n\n" +
    "Inputs:\n" +
    "- tasks: array of unit prompts/objects OR a number N (1..N with shared_prompt)\n" +
    "- concurrency: wave size (default 5, max 5 — never more than 5 live at once)\n" +
    "- mode: worker (default, automation) | general | explore\n" +
    "- shared_prompt: common instructions prepended to every unit\n" +
    "- description_prefix: label prefix for UI\n\n" +
    "Prefer this over manually calling spawn_subagent 50 times. " +
    "For 1–4 different research areas still use spawn_subagent.",
  isReadOnly: false,
  isParallelSafe: false,
  inputSchema: {
    type: "object",
    properties: {
      tasks: {
        description:
          "Array of units: strings or { description?, prompt?, data? }. " +
          "Or a number N to run units 1..N (use with shared_prompt). " +
          "Or JSON string of an array / newline-separated prompts.",
      },
      count: {
        type: "number",
        description: "Alias: create N units (1..N) when tasks omitted. Max 200.",
      },
      concurrency: {
        type: "number",
        description:
          "How many subagents run at once (default 5, hard max 5 so the queue is not clogged). When one finishes, next starts.",
      },
      mode: {
        type: "string",
        enum: ["worker", "general", "explore"],
        description:
          "worker (default): general task execution. general: code edits. explore: read-only search.",
      },
      shared_prompt: {
        type: "string",
        description:
          "Common instructions for every unit (site URL, output file path, rules). " +
          "Unit-specific data goes in tasks[].",
      },
      description_prefix: {
        type: "string",
        description: "UI label prefix (default 'unit' or 'acc').",
      },
      description: {
        type: "string",
        description: "Optional batch title for the UI card.",
      },
      background: {
        type: "boolean",
        description: "Start asynchronously and return a jobId immediately. Use wait_subagents later to collect the result.",
      },
    },
    required: [],
  },

  async execute(input = {}, context = {}) {
    let tasks = parseTasks(input.tasks);
    if (!tasks.length && input.count != null) {
      tasks = parseTasks(Number(input.count));
    }
    if (!tasks.length && input.n != null) {
      tasks = parseTasks(Number(input.n));
    }
    if (!tasks.length && input.total != null) {
      tasks = parseTasks(Number(input.total));
    }
    if (!tasks.length) {
      throw new Error(
        "Provide tasks (array/JSON/newlines) or count/n (number of units). " +
          "Example: count=50, concurrency=5, mode=worker, shared_prompt='…'"
      );
    }

    const concurrency = input.concurrency ?? input.wave ?? input.parallel ?? 5;
    const mode = input.mode || "worker";
    const shared_prompt = input.shared_prompt || input.sharedPrompt || input.instructions || "";
    const description_prefix =
      input.description_prefix ||
      input.descriptionPrefix ||
      input.prefix ||
      (String(input.description || "").toLowerCase().includes("acc") ? "acc" : "unit");

    if (!context.spawnSubagent || typeof context.spawnSubagent !== "function") {
      throw new Error("spawn_subagent_batch is not available in this session");
    }
    const batchFn =
      context.spawnSubagent.batch ||
      context.spawnSubagentBatch ||
      (typeof context.spawnSubagent === "function" && context.spawnSubagent.batch);

    if (typeof batchFn !== "function") {
      throw new Error("spawn_subagent_batch runner missing (update subagent handler)");
    }

    const result = await batchFn({
      tasks,
      concurrency,
      mode,
      shared_prompt,
      description_prefix,
      background: Boolean(input.background),
      toolCallId: context.toolCallId,
    });

    // Compact __toolText for chat UI
    const lines = [
      result.summary || `Batch done total=${result.total}`,
      `ok=${result.ok_count} fail=${result.fail_count} concurrency=${result.concurrency} mode=${result.mode}`,
    ];
    const fails = (result.results || []).filter((r) => r && !r.ok);
    if (fails.length && fails.length <= 12) {
      for (const f of fails) {
        lines.push(`  FAIL #${(f.index ?? 0) + 1}: ${String(f.answer || f.error || "").slice(0, 160)}`);
      }
    } else if (fails.length > 12) {
      lines.push(`  (${fails.length} failures — see results[])`);
    }
    result.__toolText = lines.join("\n");
    if (input.description) result.batch_title = String(input.description);
    return result;
  },
};
