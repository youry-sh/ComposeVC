const path = require("path");
const { exec: executeWorkerTask } = require("./workerPool.cjs");

const MAX_SUBAGENT_DEPTH = 1;
/** Parallel slots: never more than 5 subagents at once (main + batch) so the queue is not clogged. */
const MAX_CONCURRENT_SUBAGENTS = 5;
/** Batch wave size hard cap — same as concurrent (5), no 8-wide stampede. */
const MAX_BATCH_CONCURRENCY = 5;
/** Per-subagent agent-loop turns (tool rounds). Worker/automation needs headroom. */
const MAX_EXPLORE_ITERATIONS = 80;
const MAX_GENERAL_ITERATIONS = 160;
const MAX_WORKER_ITERATIONS = 250;
/** Absolute ceiling passed into agentLoop for any subagent (must be ≥ worker). */
const MAX_SUBAGENT_ITERATIONS = 250;

// ask_user / ask_otp are ALLOWED for all modes so subagents can pause for human
// answers (OTP, choices). Parallel asks use unique toolCallIds (agentLoop).
const EXPLORE_EXCLUDE = [
  "spawn_subagent",
  "spawn_subagent_batch",
  "compact_history",
  "edit_file",
  "create_file",
  "runner",
  "vm",
];

const GENERAL_EXCLUDE = [
  "spawn_subagent",
  "spawn_subagent_batch",
  "compact_history",
];

/** General worker mode — no nested batch/spawn. May ask_user/OTP. */
const WORKER_EXCLUDE = [
  "spawn_subagent",
  "spawn_subagent_batch",
  "compact_history",
];

function normalizeMode(mode) {
  const m = String(mode || "explore")
    .trim()
    .toLowerCase();
  if (m === "general" || m === "edit" || m === "code") return "general";
  if (m === "worker" || m === "auto" || m === "account" || m === "accounts" || m === "farm") {
    return "worker";
  }
  return "explore";
}

function excludeForMode(mode) {
  if (mode === "worker") return WORKER_EXCLUDE;
  if (mode === "general") return GENERAL_EXCLUDE;
  return EXPLORE_EXCLUDE;
}

function iterationsForMode(mode) {
  if (mode === "worker") return MAX_WORKER_ITERATIONS;
  if (mode === "general") return MAX_GENERAL_ITERATIONS;
  return MAX_EXPLORE_ITERATIONS;
}

function clampSubagentIterations(n) {
  const v = Math.floor(Number(n) || 0);
  if (!Number.isFinite(v) || v <= 0) return MAX_WORKER_ITERATIONS;
  return Math.min(MAX_SUBAGENT_ITERATIONS, Math.max(1, v));
}

function buildSubagentSystemPrompt(mode, toolContext = {}) {
  const rootPath = toolContext.rootPath || null;
  const projectName = toolContext.projectName || (rootPath ? path.basename(rootPath) : null);
  const subMode = normalizeMode(mode);

  const sections = [
    "You are a focused sub-agent of ComposeVC, an AI coding assistant.",
    "Complete ONLY the task in the user message. Be thorough with tools, then give a clear final answer.",
    "Do NOT spawn further subagents. Finish your unit of work yourself.",
    // Full-list contract: one pass dumps EVERY finding/advice item; main filters later.
    "FULL-LIST RETURN (mandatory for research / findings / advice / issues / bugs / recommendations):\n" +
      "- In ONE final answer, return the COMPLETE list of everything you found in this pass.\n" +
      "- Prefer a numbered or bulleted FULL LIST (array of items). Never drip one tip at a time.\n" +
      "- FORBIDDEN: \"one recommendation\", \"start with the main point\", \"ask if you need more\", " +
      "withholding items to stay short, or interviewing the main agent for the next tip.\n" +
      "- FORBIDDEN: compress your findings into \"top 7\" / \"only the main bugs\" when you found more — dump ALL.\n" +
      "- 0 findings → explicit empty list (e.g. \"Findings: (none)\") — not a fake single generic tip.\n" +
      "- 1 finding → list of length 1 (still list-shaped). Many findings → list all of them.\n" +
      "- Main agent must receive your FULL list (together with other agents); you do not pre-shrink for them.\n" +
      "- If the task is a single automation unit (worker account job), still return ONE complete unit report, not partial drip steps as the final answer.",
    "HUMAN PAUSE (allowed):\n" +
      "- ask_user — real choice the human must make (A vs B, confirm). Prefer 2–5 options.\n" +
      "- ask_otp action=wait — ONLY when a real SMS/app/email OTP was just sent and you cannot read it via cf_mail.\n" +
      "- Do NOT invent OTP codes. Do NOT ask for name/email/password/identity — invent via generate_* or cf_mail.\n" +
      "- After the human answers, continue automatically. Multiple subagents may ask in parallel — each wait is independent.",
  ];

  if (subMode === "worker") {
    sections.push(
      "Mode: WORKER. Use the registered tools to complete the assigned unit.\n" +
        "RESILIENCE:\n" +
        "- Read tool errors, correct inputs, and retry a reasonable number of times before reporting failure.\n" +
        "- Keep results grounded in tool output; do not invent success.\n" +
        "FILES:\n" +
        "- If told to write results: use create_file for a new file and edit_file for an existing file (read first).\n" +
        "RETURN: one compact unit report with outcome, files written, and errors tried."
    );
  } else if (subMode === "explore") {
    sections.push(
      "Always inspect real files with tools before claiming what code does. Prefer precise findings.",
      "FILE READ: use read_file only. HARD CAP ~400 lines/call (default 400). " +
        "Large files: offset + limit≤400, then nextOffset to continue. " +
         "Workflow: grep (regex + optional include) → targeted read_file slices. " +
         "FORBIDDEN: shell dumps of source. Prefer grep for project search.",
      "Mode: explore (read-only). Investigate with read/search tools only. Do not edit files.",
      "You may use ask_user only for a real human preference that blocks investigation.",
      "FINAL ANSWER SHAPE (full list, not one tip):\n" +
        "1) Findings / advice / issues — FULL numbered list of every item found (title + detail + path/evidence).\n" +
        "2) Key paths/symbols (bullets).\n" +
        "3) Risks / gaps (full bullets).\n" +
        "Dense is fine. Omitting known items to look brief is a failure. Empty search → Findings: (none)."
    );
  } else {
    sections.push(
      "Always inspect real files with tools before claiming what code does.",
      "FILE READ: use read_file only (max ~400 lines/call; use offset/nextOffset for more). " +
         "Prefer grep for search. bash only for git/npm/builds/tests.",
      "Mode: general. You may edit/create files when required; keep changes minimal. " +
        "create_file is NEW files only. Existing → edit_file only (read_file first).",
      "You may use ask_user / ask_otp wait when a real human answer is required; then continue.",
      "FINAL ANSWER SHAPE: complete report for this unit — full list of what changed / findings / paths / risks. " +
        "Not a single-line tip; not \"more later\"."
    );
  }

  sections.push("You have web_search / web_fetch when outside facts are needed.");

  if (rootPath) {
    sections.push(`Open project: ${projectName || path.basename(rootPath)} (${rootPath})`);
  } else {
    sections.push("No project folder is currently open.");
  }

  sections.push(`Today's date: ${new Date().toISOString().slice(0, 10)}.`);
  return sections.join("\n\n");
}

/**
 * Creates the spawn_subagent runner bound to the parent agent loop.
 * Uses the same provider/model; awaits completion; supports limited concurrency.
 */
function createSpawnSubagentHandler({
  runAgentLoop,
  provider,
  model,
  toolContext,
  onProgress,
  signal,
  tokenCountingMode,
  maxContextTokens,
  autoCompactTokens,
  depth = 0,
}) {
  /**
   * Global concurrency for this parent turn (max 5 live subagents).
   * Batch wave pool ALREADY limits how many runOneSubagent run at once —
   * so runOneSubagent must NOT acquire again when skipAcquire=true,
   * otherwise count=4 with concurrency=5 still serializes (double semaphore).
   */
  let activeCount = 0;
  const waitQueue = [];
  const backgroundJobs = new Map();
  let backgroundSequence = 0;

  const createBackgroundJob = (runner, description) => {
    const jobId = `job-${Date.now().toString(16)}-${(++backgroundSequence).toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
    const promise = Promise.resolve().then(runner).then(
      (result) => ({ jobId, description, status: "done", result }),
      (error) => ({
        jobId,
        description,
        status: "error",
        result: { ok: false, error: error instanceof Error ? error.message : String(error) },
      })
    );
    backgroundJobs.set(jobId, promise);
    promise.finally(() => {
      setTimeout(() => backgroundJobs.delete(jobId), 10 * 60 * 1000).unref?.();
    }).catch(() => {});
    // `background` is deliberately explicit: the tool call has finished scheduling,
    // but its subagent is still live. The renderer uses this to avoid showing a
    // misleading completed checkmark before wait_subagents has collected it.
    return { jobId, description, background: true, status: "running" };
  };

  const waitForBackgroundJobs = async ({ jobIds, all = false } = {}) => {
    const ids = Array.isArray(jobIds) ? jobIds.map((id) => String(id)).filter(Boolean) : [];
    const selected = ids.length
      ? ids
      : all
        ? [...backgroundJobs.keys()]
        : [];
    if (!selected.length) return { ok: true, total: 0, results: [], summary: "No background subagent jobs" };
    const results = await Promise.all(
      selected.map(async (jobId) => {
        const promise = backgroundJobs.get(jobId);
        if (!promise) return { jobId, status: "missing", result: { ok: false, error: "Unknown background job" } };
        return promise;
      })
    );
    const failed = results.filter((item) => item.status !== "done" || item.result?.ok === false).length;
    return {
      ok: failed === 0,
      total: results.length,
      failed,
      results,
      summary: `Background subagents finished ${results.length} · failed=${failed}`,
    };
  };

  const acquire = () =>
    new Promise((resolve) => {
      if (activeCount < MAX_CONCURRENT_SUBAGENTS) {
        activeCount += 1;
        resolve();
        return;
      }
      waitQueue.push(resolve);
    });

  const release = () => {
    activeCount = Math.max(0, activeCount - 1);
    const next = waitQueue.shift();
    if (next) {
      activeCount += 1;
      next();
    }
  };

  async function runOneSubagent({
    description,
    prompt,
    mode = "explore",
    toolCallId,
    progressName = "spawn_subagent",
    index = null,
    total = null,
    /** When true, caller already holds a concurrency slot (batch wave pool). */
    skipAcquire = false,
  } = {}) {
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error("Subagents cannot spawn further subagents (max depth reached)");
    }

    const desc = String(description || "subagent").trim().slice(0, 100);
    const task = String(prompt || "").trim();
    if (!task) throw new Error("prompt is required");
    const subMode = normalizeMode(mode);
    // Unique id even when many start in the same ms (batch wave)
    const agentId = `sub-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}-${
      index != null ? index : "x"
    }`;
    const excludeToolNames = excludeForMode(subMode);
    const maxIterations = clampSubagentIterations(iterationsForMode(subMode));
    const label =
      index != null && total != null ? `${desc} [${Number(index) + 1}/${total}]` : desc;

    if (!skipAcquire) {
      await acquire();
    }

    onProgress?.({
      type: "subagent_status",
      toolCallId,
      parentToolCallId: toolCallId,
      agentId,
      name: progressName,
      status: "running",
      description: label,
      mode: subMode,
      text: "starting…",
      index,
      total,
      unit: true,
    });

    try {
      if (signal?.aborted) {
        throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
      }

      const systemPrompt = buildSubagentSystemPrompt(subMode, toolContext);
      await executeWorkerTask("countTokens", { text: task }).catch(() => null);
      const result = await runAgentLoop({
        provider,
        model,
        messages: [{ role: "user", content: task }],
        systemPrompt,
        toolContext: {
          rootPath: toolContext.rootPath,
          projectName: toolContext.projectName,
          userDataPath: toolContext.userDataPath,
          invalidateContext: toolContext.invalidateContext,
        },
        signal,
        tokenCountingMode,
        maxContextTokens,
        autoCompactTokens,
        maxIterations,
        excludeToolNames,
        isSubagent: true,
        subagentDepth: depth + 1,
        onProgress: (progress) => {
          if (!progress) return;
          if (progress.type === "assistant_text") return;

          if (progress.type === "tool_start" || progress.type === "tool_end") {
            // Nested tool under this unit — keep agentId so UI attaches to the right row
            onProgress?.({
              ...progress,
              parentToolCallId: toolCallId,
              agentId,
              index,
              total,
              unit: true,
            });
            if (progress.type === "tool_start" && progress.name) {
              onProgress?.({
                type: "subagent_status",
                toolCallId,
                parentToolCallId: toolCallId,
                agentId,
                name: progressName,
                status: "running",
                description: label,
                mode: subMode,
                text: progress.name,
                index,
                total,
                unit: true,
              });
            }
            return;
          }

          if (progress.type === "retry" || progress.type === "compact_start" || progress.type === "compact_end") {
            onProgress?.({
              ...progress,
              parentToolCallId: toolCallId,
              agentId,
              index,
              unit: true,
            });
          }
        },
      });

      const answer = String(result?.text || "").trim();
      const stopped = Boolean(result?.stopped);

      onProgress?.({
        type: "subagent_status",
        toolCallId,
        parentToolCallId: toolCallId,
        agentId,
        name: progressName,
        status: stopped ? "stopped" : "done",
        description: label,
        mode: subMode,
        text: stopped ? "stopped" : "done",
        index,
        total,
        unit: true,
      });

      return {
        agentId,
        description: label,
        mode: subMode,
        ok: !stopped,
        stopped,
        index,
        answer: answer || (stopped ? "[Stopped by user]" : "(empty answer)"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = error?.name === "AbortError" || signal?.aborted;

      onProgress?.({
        type: "subagent_status",
        toolCallId,
        parentToolCallId: toolCallId,
        agentId,
        name: progressName,
        status: aborted ? "stopped" : "error",
        description: label,
        mode: subMode,
        text: aborted ? "stopped" : message.slice(0, 120),
        index,
        total,
        unit: true,
      });

      if (aborted) {
        return {
          agentId,
          description: label,
          mode: subMode,
          ok: false,
          stopped: true,
          index,
          answer: "[Stopped by user]",
        };
      }
      // Soft-fail for batch: do not kill the whole wave
      return {
        agentId,
        description: label,
        mode: subMode,
        ok: false,
        stopped: false,
        error: message,
        index,
        answer: `[error] ${message}`,
      };
    } finally {
      // Only release if we acquired (single spawn). Batch owns the slot.
      if (!skipAcquire) {
        release();
      }
    }
  }

  async function spawnSubagent(opts = {}) {
    if (opts.background) {
      return createBackgroundJob(
        () => runOneSubagent({ ...opts, progressName: "spawn_subagent", background: false }),
        String(opts.description || "subagent")
      );
    }
    const r = await runOneSubagent({ ...opts, progressName: "spawn_subagent" });
    if (r && r.ok === false && r.error && !r.stopped) {
      throw new Error(r.error);
    }
    return r;
  }

  async function waitBackgroundJobs(opts = {}) {
    return waitForBackgroundJobs(opts);
  }

  /**
   * Wave runner: process many unit tasks with concurrency limit.
   * When a slot frees, the next task starts — cycles until the queue is empty.
   */
  async function spawnSubagentBatch({
    tasks,
    concurrency = 5,
    mode = "worker",
    shared_prompt = "",
    description_prefix = "unit",
    toolCallId,
    background = false,
  }) {
    if (background) {
      return createBackgroundJob(
        () => spawnSubagentBatch({
          tasks,
          concurrency,
          mode,
          shared_prompt,
          description_prefix,
          toolCallId,
          background: false,
        }),
        `batch ${description_prefix || "unit"}`
      );
    }
    if (depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error("Subagents cannot spawn further subagents (max depth reached)");
    }

    let list = [];
    if (Array.isArray(tasks)) {
      list = tasks;
    } else if (typeof tasks === "string") {
      try {
        const parsed = JSON.parse(tasks);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = [];
      }
    }
    if (!list.length) {
      throw new Error(
        "tasks required: array of { description?, prompt?, index? } or strings (unit prompts)"
      );
    }

    // Hard-cap waves at 5 so many units never stampede the model.
    const limit = Math.min(
      MAX_BATCH_CONCURRENCY,
      MAX_CONCURRENT_SUBAGENTS,
      Math.max(1, Math.floor(Number(concurrency) || 5))
    );
    const subMode = normalizeMode(mode || "worker");
    const shared = String(shared_prompt || "").trim();
    const prefix = String(description_prefix || "unit").trim() || "unit";
    const total = list.length;

    const normalized = list.map((item, i) => {
      if (item == null) {
        return { description: `${prefix} ${i + 1}`, prompt: shared || `(empty task ${i + 1})`, index: i };
      }
      if (typeof item === "string" || typeof item === "number") {
        const unit = String(item);
        const prompt = shared
          ? `${shared}\n\n--- UNIT ${i + 1}/${total} ---\n${unit}\n---`
          : unit;
        return { description: `${prefix} ${i + 1}`, prompt, index: i };
      }
      if (typeof item === "object") {
        const unitPrompt = String(item.prompt || item.task || item.goal || item.text || "").trim();
        const unitExtra = item.vars || item.data || item.meta || null;
        let body = unitPrompt;
        if (unitExtra) {
          body += `\n\nUNIT_DATA:\n${typeof unitExtra === "string" ? unitExtra : JSON.stringify(unitExtra, null, 2)}`;
        }
        if (item.index != null) {
          body = `UNIT_INDEX=${item.index}\n` + body;
        } else {
          body = `UNIT_INDEX=${i + 1}\nTOTAL=${total}\n` + body;
        }
        const prompt = shared ? `${shared}\n\n--- UNIT ${i + 1}/${total} ---\n${body}\n---` : body;
        const description = String(item.description || item.name || item.label || `${prefix} ${i + 1}`)
          .trim()
          .slice(0, 80);
        return { description, prompt, index: i };
      }
      return { description: `${prefix} ${i + 1}`, prompt: String(item), index: i };
    });

    // Parent batch card (summary). Individual units emit unit:true with their own agentId.
    onProgress?.({
      type: "subagent_status",
      toolCallId,
      parentToolCallId: toolCallId,
      agentId: "batch",
      name: "spawn_subagent_batch",
      status: "running",
      description: `batch ${total} · wave ${limit}`,
      mode: subMode,
      text: `starting ${total} units · ${limit} live at once`,
      total,
      batch: true,
      concurrency: limit,
    });

    // Pre-announce every unit as queued so UI shows all N rows immediately
    // (not "3 running then 4th appears later").
    for (let i = 0; i < total; i += 1) {
      const unit = normalized[i];
      onProgress?.({
        type: "subagent_status",
        toolCallId,
        parentToolCallId: toolCallId,
        agentId: `queued-${i}`,
        name: "spawn_subagent_batch",
        status: "running",
        description: unit.description,
        mode: subMode,
        text: i < limit ? "starting…" : "queued",
        index: i,
        total,
        unit: true,
        queued: i >= limit,
      });
    }

    // Wave pool: exactly `limit` workers. Each holds ONE slot for the whole unit run.
    // runOneSubagent(skipAcquire=true) — no second semaphore (was causing 3 then 4).
    const results = new Array(total);
    let cursor = 0;
    let completed = 0;
    let liveCount = 0;

    async function worker() {
      while (true) {
        if (signal?.aborted) break;
        const i = cursor;
        cursor += 1;
        if (i >= total) break;
        const unit = normalized[i];
        liveCount += 1;
        const r = await runOneSubagent({
          description: unit.description,
          prompt: unit.prompt,
          mode: subMode,
          toolCallId,
          progressName: "spawn_subagent_batch",
          index: i,
          total,
          skipAcquire: true,
        });
        results[i] = r;
        liveCount = Math.max(0, liveCount - 1);
        completed += 1;
        onProgress?.({
          type: "subagent_status",
          toolCallId,
          parentToolCallId: toolCallId,
          agentId: "batch",
          name: "spawn_subagent_batch",
          status: "running",
          description: `batch ${completed}/${total}`,
          mode: subMode,
          text: `${completed}/${total} done · ${liveCount} live · wave ${limit}`,
          total,
          completed,
          batch: true,
          concurrency: limit,
        });
      }
    }

    // Start ALL wave slots in the same tick so N≤5 units begin together.
    const waveSize = Math.min(limit, total);
    const pool = [];
    for (let w = 0; w < waveSize; w += 1) {
      pool.push(worker());
    }
    await Promise.all(pool);

    const okCount = results.filter((r) => r && r.ok).length;
    const failCount = results.filter((r) => r && !r.ok).length;
    const stopped = Boolean(signal?.aborted) || results.some((r) => r?.stopped);

    onProgress?.({
      type: "subagent_status",
      toolCallId,
      parentToolCallId: toolCallId,
      agentId: "batch",
      name: "spawn_subagent_batch",
      status: stopped ? "stopped" : "done",
      description: `batch ${okCount} ok / ${failCount} fail`,
      mode: subMode,
      text: stopped ? "stopped" : `finished ${total} (ok=${okCount} fail=${failCount})`,
      total,
      completed: total,
    });

    return {
      ok: failCount === 0 && !stopped,
      stopped,
      mode: subMode,
      concurrency: limit,
      total,
      ok_count: okCount,
      fail_count: failCount,
      results: results.map((r, i) => r || {
        ok: false,
        index: i,
        answer: "[missing result]",
      }),
      summary:
        `Batch ${total} units · concurrency ${limit} · ok=${okCount} fail=${failCount}` +
        (stopped ? " · stopped" : ""),
    };
  }

  // Attach batch on the same handler function for toolContext
  spawnSubagent.batch = spawnSubagentBatch;

  return Object.assign(spawnSubagent, {
    batch: spawnSubagentBatch,
    runOne: runOneSubagent,
    wait: waitBackgroundJobs,
    jobs: () => [...backgroundJobs.keys()],
  });
}

module.exports = {
  createSpawnSubagentHandler,
  buildSubagentSystemPrompt,
  normalizeMode,
  iterationsForMode,
  clampSubagentIterations,
  MAX_SUBAGENT_DEPTH,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_BATCH_CONCURRENCY,
  MAX_WORKER_ITERATIONS,
  MAX_SUBAGENT_ITERATIONS,
};
