/**
 * swarm — prompts for the subagent-batch mode.
 *
 * Lifecycle:
 *   planner (main model, read-only) → decompose user task into narrow subtasks
 *   workers (main model, general, edit) → all run IN PARALLEL (Promise.all), each its own file scope
 *   main agent (full ComposeVC) → verifies syntax/build, fixes breakage, final answer
 *
 * Single source of truth for all swarm prompts. Edit here once.
 */

const SWARM_MODE_ID = "swarm";
const SWARM_NORMAL_MODE_ID = "lopster";
const SWARM_DEFAULT_WORKERS = 7;
const SWARM_MAX_WORKERS = 12;
const SWARM_PLAN_ITERATIONS = 14;
const SWARM_WORKER_ITERATIONS = 150;
const SWARM_MAX_HANDOFF_CHARS = 60000;

const PLANNER_SYSTEM_PROMPT = `You are the PLANNER of a ComposeVC "swarm" run.

Your ONLY job: split the user's coding task into N narrow, NON-OVERLAPPING sub-tasks that independent worker sub-agents will execute IN PARALLEL.

Hard rules:
1) Do NOT write code. Do NOT edit files. Do NOT run builds/checks. Reason over the task and output ONE JSON object.
2) You may read the project (read_file / grep / list_dir) to see file layout so the split is realistic and collision-free. Keep reads minimal and targeted — be fast.
3) Every worker must own a DISJOINT file scope: no two subtasks may edit the same file or the same region of a shared file. If two changes must touch one file, either merge them into ONE subtask or point one at it and mark the other as dependent.
4) Prefer many narrow tasks over few broad ones (default ${SWARM_DEFAULT_WORKERS}, cap ${SWARM_MAX_WORKERS}).
5) Each subtask is self-contained: it must not need another worker's output to finish (keep them parallel-izable; if an ordering truly exists, mark dependsOn but still try to avoid it).

OUTPUT (STRICT — raw JSON, nothing else, no markdown fence):
{
  "subtasks": [
    {
      "id": 1,
      "title": "short label",
      "detail": "exact narrow work to do, as a self-contained instruction",
      "scope": ["file path or area this worker may touch"],
      "dependsOn": []
    }
  ],
  "planNote": "one line about how you split it"
}

If the task is trivial and not worth splitting, return exactly one subtask with the whole task. Do NOT invent files. Every scope entry must be a real path/area you saw or can infer from the request.`;

const WORKER_SYSTEM_PROMPT = `You are a focused WORKER sub-agent in a ComposeVC swarm run.

You have ONE narrow sub-task. The main agent already split the job; other workers are running in parallel on their own disjoint file scopes.

Rules:
1) Complete ONLY your sub-task. Do exactly what the sub-task says.
2) Touch ONLY files inside your assigned scope. NEVER edit a file you were not told to own. If something outside your scope needs changing, do NOT edit it — note it in your report instead.
3) You may EDIT/CREATE files in your scope (create_file is for NEW files; existing files → edit_file, read first).
4) Do NOT run syntax checkers / builds / full verification (e.g. check_code, chack_code, long build commands). That is the MAIN agent's job after all workers return. Small targeted shell (e.g. installing a dep your change needs) is allowed, but no heavy verify.
5) Do NOT spawn sub-agents. Do NOT run compact_history.
6) Report your changes fully in ONE final message: exact list of every file you wrote/edited (paths), what you changed in each, any issues or left-over notes that the main agent must know.

This is the FULL-LIST contract: one reply = the COMPLETE report of everything you did. No drip-feed. No "want more?".`;

/**
 * Build the planner user message.
 */
function buildPlannerUserPrompt({ userTask, workerCount, runId }) {
  const n = Number(workerCount) || SWARM_DEFAULT_WORKERS;
  return (
    `Swarm run ${runId || "?"} — split the user task into up to ${n} narrow parallel sub-tasks.\n\n` +
    `OUTPUT RULE (hard): return ONLY the raw JSON object with a "subtasks" array. No prose around it.\n\n` +
    `USER TASK:\n${String(userTask || "").trim() || "(empty task)"}`
  );
}

/**
 * Build one worker's user message.
 */
function buildSwarmWorkerPrompt({ userTask, subtask, runId, index, total }) {
  const s = subtask || {};
  const scope = Array.isArray(s.scope) && s.scope.length ? s.scope.join("\n  - ") : "(inferred from task)";
  return (
    `Swarm ${runId || "?"} — you are worker ${Number(index) + 1}/${total}.\n` +
    `SUB-TASK (your ONLY job):\n${String(s.title || "").trim()}\n${String(s.detail || "").trim()}\n\n` +
    `YOUR FILE SCOPE (touch ONLY these; do not edit others):\n  - ${scope}\n\n` +
    `FOR CONTEXT, the original full task was:\n${String(userTask || "").trim()}\n\n` +
    `Final answer = full report of every file you wrote/edited + what changed + notes for the main agent.`
  );
}

/**
 * Wrap worker reports into a handoff user message for the main ComposeVC agent
 * (verification + integration + fixes run on the main model after mode switches to lopster).
 */
function buildSwarmHandoffMessage({ userTask, workers, meta }) {
  const task = String(userTask || "").trim();
  const list = Array.isArray(workers) ? workers : [];
  const ok = list.filter((w) => w.ok).length;

  const lines = [
    "【Swarm (subagent batch) handoff】",
    "You are now the MAIN ComposeVC agent. Mode switched to normal execution.",
    `${ok}/${list.length} workers finished. Every worker report is below.`,
    "",
    "YOUR JOB as main (this is your real work — do NOT skip):",
    "1) INGEST every worker report — all edited files, all changes, all left-over notes.",
    "2) VERIFY the integration: run syntax/build checks (check_code / the right build/test command).",
    "3) FIX any breakage the workers caused (conflicts, missing imports, broken syntax, gaps between",
    "   disjoint scopes, merge seams). Sub-agents did NOT verify — you are the safety net.",
    "4) Close gaps both workers flagged in their notes and holes you find yourself.",
    "5) Final answer: what changed overall, what you fixed, and the result of the verification.",
    "",
    "═══ ORIGINAL USER TASK ═══",
    task || "(empty)",
    "",
    "═══ WORKER REPORTS (full — verify & fix against these) ═══",
  ];

  for (let i = 0; i < list.length; i++) {
    const w = list[i] || {};
    const idx = typeof w.index === "number" ? w.index + 1 : i + 1;
    const status = w.ok ? "done" : w.stopped ? "stopped" : "error";
    const title = w.title || w.description || `worker-${idx}`;
    lines.push(`--- Worker ${idx}/${list.length} · ${title} · ${status} ---`);
    if (w.error) lines.push(`[error] ${String(w.error).slice(0, 300)}`);
    lines.push(String(w.answer || "(no report)").trim() || "(empty)");
    lines.push("");
  }

  if (meta && (meta.okCount != null || meta.errorCount != null)) {
    const modelLabel = meta.displayLabel || meta.modelName || meta.modelId || "main";
    lines.push(
      `═══ SWARM META ═══`,
      `ok=${meta.okCount ?? "?"} error=${meta.errorCount ?? "?"} stopped=${meta.stoppedCount ?? "?"} model=${modelLabel}` +
        (meta.modelId && meta.modelId !== modelLabel ? ` (id=${meta.modelId})` : "") +
        ` runId=${meta.runId || "?"}`
    );
  }

  lines.push(
    "",
    "═══ REQUIREMENT ═══",
    "Verify syntax/build NOW, fix every breakage yourself, then summarize. Do not report done until verified."
  );

  return lines.join("\n");
}

module.exports = {
  SWARM_MODE_ID,
  SWARM_NORMAL_MODE_ID,
  SWARM_DEFAULT_WORKERS,
  SWARM_MAX_WORKERS,
  SWARM_PLAN_ITERATIONS,
  SWARM_WORKER_ITERATIONS,
  SWARM_MAX_HANDOFF_CHARS,
  PLANNER_SYSTEM_PROMPT,
  WORKER_SYSTEM_PROMPT,
  buildPlannerUserPrompt,
  buildSwarmWorkerPrompt,
  buildSwarmHandoffMessage,
};
