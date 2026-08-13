/**
 * swarm — subagent-batch mode orchestrator.
 *
 * Lifecycle:
 *   plan (main model, read-only) → decompose task into N narrow subtasks
 *   workers (main model, general) → run ALL in parallel (Promise.all — not one by one)
 *   handoff → main ComposeVC agent verifies syntax/build and fixes breakage
 *
 * The whole point: many autonomous file-level workers, launched simultaneously,
 * each on a disjoint file scope (no writer conflicts), then a single verifier pass.
 */

const {
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
} = require("./prompts.cjs");

const { exec: executeWorkerTask } = require("../workerPool.cjs");

/** Tools the planner must not use (it only reasons + reads). */
const PLANNER_EXCLUDE_TOOLS = [
  "spawn_subagent",
  "spawn_subagent_batch",
  "compact_history",
  "edit_file",
  "create_file",
  "restore_backup",
  "bash",
  "cf_mail",
  "ask_user",
  "ask_otp",
  "runner",
];

/** Tools each swarm worker must not use (they only edit their own scope). */
const WORKER_EXCLUDE_TOOLS = [
  "spawn_subagent",
  "spawn_subagent_batch",
  "compact_history",
  "ask_user",
  "ask_otp",
];

function safeParsePlan(text) {
  const raw = String(text || "").trim();
  if (!raw) return { ok: false, error: "empty planner output" };
  let candidate = raw;
  // Strip a single markdown fence if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();
  // Grab the first balanced { ... } block as a fallback
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  try {
    const parsed = JSON.parse(candidate);
    const subtasks = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
    if (!subtasks.length) {
      return { ok: false, error: "planner returned no subtasks", raw };
    }
    const clean = subtasks
      .map((s, i) => ({
        id: Number(s.id) || i + 1,
        title: String(s.title || `task ${i + 1}`).trim(),
        detail: String(s.detail || "").trim(),
        scope: Array.isArray(s.scope)
          ? s.scope.map((x) => String(x)).filter(Boolean)
          : [],
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      }))
      .filter((s) => s.detail);
    if (!clean.length) {
      return { ok: false, error: "planner subtasks empty after cleaning", raw };
    }
    return {
      ok: true,
      subtasks: clean,
      planNote: String(parsed.planNote || "").trim(),
      raw,
    };
  } catch (e) {
    return { ok: false, error: `plan parse failed: ${e.message}`, raw: raw.slice(0, 800) };
  }
}

function truncateReport(text, maxChars = SWARM_MAX_HANDOFF_CHARS) {
  const s = String(text || "");
  if (s.length <= maxChars) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, maxChars)}\n\n…[truncated ${s.length - maxChars} chars — mark incomplete]`,
    truncated: true,
  };
}

/**
 * Run the swarm: planner → parallel workers → handoff for main.
 */
async function runSwarm({
  runAgentLoop,
  config,
  mainProvider,
  mainModel,
  userTask,
  toolContext,
  signal,
  tokenCountingMode,
  maxContextTokens,
  autoCompactTokens,
  onProgress,
  sessionId,
  workerCount,
  workerMode = "general",
}) {
  const runId = `sw-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const emit = (payload) => {
    try {
      onProgress?.({ sessionId, ...payload });
    } catch {
      /* */
    }
  };
  const parentToolCallId = `swarm-run-${runId}`;

  const limit = Math.min(
    SWARM_MAX_WORKERS,
    Math.max(1, Math.floor(Number(workerCount) || SWARM_DEFAULT_WORKERS))
  );

  emit({
    type: "status",
    label: `Swarm · planning (${limit} workers)…`,
    phase: "swarm-plan",
    agentMode: SWARM_MODE_ID,
    swarm: { phase: "planning", runId, workerLimit: limit },
  });

  const planToolCtx = {
    rootPath: toolContext?.rootPath || null,
    projectName: toolContext?.projectName || null,
    userDataPath: toolContext?.userDataPath || null,
    invalidateContext: toolContext?.invalidateContext,
  };

  // ── 1) PLANNER (main model, read-only) ──
  let plan = { ok: false, error: "planner not run" };
  try {
    if (signal?.aborted) throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
    await executeWorkerTask("countTokens", {
      text: buildPlannerUserPrompt({ userTask, workerCount: limit, runId }),
    }).catch(() => null);
    const planResult = await runAgentLoop({
      provider: mainProvider,
      model: mainModel,
      messages: [{ role: "user", content: buildPlannerUserPrompt({ userTask, workerCount: limit, runId }) }],
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      toolContext: planToolCtx,
      signal,
      tokenCountingMode,
      maxContextTokens,
      autoCompactTokens,
      maxIterations: SWARM_PLAN_ITERATIONS,
      excludeToolNames: PLANNER_EXCLUDE_TOOLS,
      isSubagent: true,
      subagentDepth: 1,
      onProgress: (p) => {
        if (!p) return;
        if (p.type === "tool_start" || p.type === "tool_end" || p.type === "retry") {
          emit({ ...p, parentToolCallId, agentId: "swarm-planner", unit: true, index: 0, total: 1 });
        }
      },
    });
    plan = safeParsePlan(planResult?.text);
    if (!plan.ok && planResult?.stopped) {
      plan = { ok: false, error: "stopped", stopped: true };
    }
  } catch (e) {
    plan = {
      ok: false,
      error: e?.name === "AbortError" || signal?.aborted ? "stopped" : e?.message || String(e),
      stopped: Boolean(signal?.aborted),
    };
  }

  const aborted = Boolean(signal?.aborted) || plan.stopped;

  // Planner failed → hand straight back to main with original task + error (main fixes by itself).
  if (!plan.ok) {
    emit({
      type: "status",
      label: `Swarm · planning failed (${plan.error}) — continuing as ComposeVC…`,
      phase: "swarm-plan-failure",
      agentMode: SWARM_NORMAL_MODE_ID,
    });
    return {
      runId,
      aborted,
      okCount: 0,
      errorCount: 0,
      stoppedCount: 0,
      planned: false,
      planError: plan.error,
      subtasks: [],
      workers: [],
      handoffUserMessage:
        `【Swarm failed at planning】\n${plan.error}\n\n` +
        `Proceed as main ComposeVC and execute the original task yourself:\n\n${userTask}`,
      parentToolCallId,
    };
  }

  const subtasks = plan.subtasks;
  const total = subtasks.length;

  emit({
    type: "tool_start",
    toolCallId: parentToolCallId,
    name: "swarm_council",
    description: `Swarm · ${total} parallel workers`,
    mode: workerMode,
    batch: true,
    total,
    completed: 0,
    concurrency: total,
    status: "running",
    statusText: `workers · ${total}`,
  });
  for (let i = 0; i < total; i++) {
    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId: `queued-sw${i}`,
      unit: true,
      name: "swarm_council",
      status: "queued",
      description: subtasks[i]?.title || `worker ${i + 1}`,
      text: "queued",
      index: i,
      total,
      mode: workerMode,
    });
  }

  const workers = new Array(total);
  let completed = 0;

  const runOne = async (i) => {
    const sub = subtasks[i];
    const agentId = `sw-${i}-${runId}`;
    const label = sub.title || `worker ${i + 1}`;
    const prompt = buildSwarmWorkerPrompt({ userTask, subtask: sub, runId, index: i, total });

    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId,
      unit: true,
      name: "swarm_council",
      status: "running",
      description: label,
      text: "working on scope…",
      index: i,
      total,
      mode: workerMode,
    });

    try {
      if (signal?.aborted) throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
      await executeWorkerTask("countTokens", { text: prompt }).catch(() => null);
      const result = await runAgentLoop({
        provider: mainProvider,
        model: mainModel,
        messages: [{ role: "user", content: prompt }],
        systemPrompt: WORKER_SYSTEM_PROMPT,
        toolContext: planToolCtx,
        signal,
        tokenCountingMode,
        maxContextTokens,
        autoCompactTokens,
        maxIterations: SWARM_WORKER_ITERATIONS,
        excludeToolNames: WORKER_EXCLUDE_TOOLS,
        isSubagent: true,
        subagentDepth: 1,
        onProgress: (p) => {
          if (!p) return;
          if (p.type === "tool_start" || p.type === "tool_end") {
            emit({ ...p, parentToolCallId, agentId, index: i, total, unit: true });
            if (p.type === "tool_start" && p.name) {
              emit({
                type: "subagent_status",
                toolCallId: parentToolCallId,
                parentToolCallId,
                agentId,
                unit: true,
                name: "swarm_council",
                status: "running",
                description: label,
                text: p.name,
                index: i,
                total,
                mode: workerMode,
              });
            }
          }
        },
      });
      const capped = truncateReport(result?.text);
      const stopped = Boolean(result?.stopped) || Boolean(signal?.aborted);
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId,
        unit: true,
        name: "swarm_council",
        status: stopped ? "stopped" : "done",
        description: label,
        text: stopped ? "stopped" : capped.truncated ? "done · truncated report" : "done",
        index: i,
        total,
        mode: workerMode,
      });
      return {
        id: agentId,
        index: i,
        title: label,
        ok: !stopped,
        stopped,
        truncated: Boolean(capped.truncated),
        answer: capped.text || (stopped ? "[Stopped by user]" : "(empty report)"),
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const stopped = e?.name === "AbortError" || signal?.aborted;
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId,
        unit: true,
        name: "swarm_council",
        status: stopped ? "stopped" : "error",
        description: label,
        text: stopped ? "stopped" : message.slice(0, 120),
        index: i,
        total,
        mode: workerMode,
      });
      return {
        id: agentId,
        index: i,
        title: label,
        ok: false,
        stopped,
        error: message,
        answer: stopped ? "[Stopped by user]" : `[error] ${message}`,
      };
    } finally {
      completed += 1;
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId: "batch",
        batch: true,
        name: "swarm_council",
        status: "running",
        description: `Swarm · ${total} workers`,
        text: `${completed}/${total} done`,
        total,
        completed,
        concurrency: total,
      });
      emit({
        type: "status",
        label: `Swarm · workers ${completed}/${total}`,
        phase: "swarm-workers",
        agentMode: SWARM_MODE_ID,
        swarm: { phase: "workers", runId, total, completed },
      });
    }
  };

  // ── 2) WORKERS — ALL AT ONCE (Promise.all), not one by one ──
  const runAll = async () => {
    const jobs = [];
    for (let i = 0; i < total; i++) {
      jobs.push(
        (async () => {
          workers[i] = await runOne(i);
        })()
      );
    }
    await Promise.all(jobs);
  };
  if (signal?.aborted) {
    // fill holes anyway
  }
  await runAll();

  for (let i = 0; i < total; i++) {
    if (!workers[i]) {
      workers[i] = {
        id: `sw-${i}-${runId}`,
        index: i,
        title: subtasks[i]?.title || `worker ${i + 1}`,
        ok: false,
        stopped: true,
        answer: "[Stopped by user]",
        error: "not started",
      };
    }
  }

  const okCount = workers.filter((w) => w.ok).length;
  const errorCount = workers.filter((w) => !w.ok && !w.stopped).length;
  const stoppedCount = workers.filter((w) => w.stopped).length;
  const doneAborted = Boolean(signal?.aborted) || stoppedCount === total;

  emit({
    type: "tool_end",
    toolCallId: parentToolCallId,
    name: "swarm_council",
    ok: !doneAborted && okCount > 0,
    status: doneAborted ? "stopped" : "done",
    description: `Swarm · ${okCount}/${total} ok`,
    result: {
      runId,
      okCount,
      errorCount,
      stoppedCount,
      workers: workers.map((w) => ({
        index: w.index,
        ok: w.ok,
        stopped: w.stopped,
        truncated: Boolean(w.truncated),
        title: w.title,
        preview: String(w.answer || "").slice(0, 300),
      })),
    },
  });
  emit({
    type: "status",
    label:
      okCount > 0
        ? `Swarm · ${okCount}/${total} workers done · verifying…`
        : doneAborted
          ? "Swarm · stopped"
          : "Swarm · no workers succeeded · continuing carefully…",
    phase: "swarm-synthesize",
    agentMode: SWARM_NORMAL_MODE_ID,
    swarm: { phase: "handoff", runId, total, okCount, errorCount },
  });

  const handoffUserMessage = buildSwarmHandoffMessage({
    userTask,
    workers,
    meta: {
      runId,
      okCount,
      errorCount,
      stoppedCount,
      planned: true,
      planNote: plan.planNote,
    },
  });

  return {
    runId,
    aborted: doneAborted,
    okCount,
    errorCount,
    stoppedCount,
    planned: true,
    planNote: plan.planNote,
    subtasks,
    workers,
    handoffUserMessage,
    parentToolCallId,
  };
}

module.exports = { runSwarm };
