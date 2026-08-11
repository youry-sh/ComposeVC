/**
 * soviet-7 mode — council of 7 identical advisors (separate files, shared prompt).
 *
 * Lifecycle:
 *   idle → council_running (7 parallel, isolated contexts) → synthesizing handoff
 *        → normal_exec (auto-switch agentMode → lopster / ComposeVC) → idle
 *
 * Contract:
 * - Research model: aiRuntime.soviet7ModelId || main model (all 7 use the same resolved model).
 * - Synthesis/execution: always main model + full ComposeVC system prompt.
 * - Advisors: architecture-only and tool-free; they reason solely from the user request.
 * - Partial failure: main still gets available slots + error slots; never hang forever.
 * - Adding an 8th advisor later = new advisorN.cjs + bump SOVIET7_ADVISOR_COUNT / load list — not orchestrator forks.
 */

const { exec: executeWorkerTask } = require("../workerPool.cjs");
const {
  SOVIET7_MODE_ID,
  SOVIET7_NORMAL_MODE_ID,
  SOVIET7_ADVISOR_COUNT,
  SOVIET7_DEFAULT_CONCURRENCY,
  SOVIET7_MAX_ADVISOR_ITERATIONS,
  buildCouncilHandoffUserMessage,
  inspectAdvisorListPayload,
} = require("./sharedPrompt.cjs");

const ADVISOR_MODULES = [
  require("./advisor1.cjs"),
  require("./advisor2.cjs"),
  require("./advisor3.cjs"),
  require("./advisor4.cjs"),
  require("./advisor5.cjs"),
  require("./advisor6.cjs"),
  require("./advisor7.cjs"),
];

function listAdvisors() {
  return ADVISOR_MODULES.slice(0, SOVIET7_ADVISOR_COUNT).map((m) => ({
    id: m.id,
    index: m.index,
    label: m.label,
    systemPrompt: m.systemPrompt,
    buildUserPrompt: m.buildUserPrompt,
  }));
}

/**
 * Human label for UI: prefer API model name (what the provider actually receives).
 * Avoid showing a stale config id (e.g. "gpt-4o") when name was changed to another model.
 */
function modelDisplayLabel(model) {
  if (!model || typeof model !== "object") return "";
  const name = String(model.name || "").trim();
  const id = String(model.id || "").trim();
  if (name && id && name !== id) return name;
  return name || id || "";
}

/**
 * Resolve council model: setting soviet7ModelId if it exists in config.models, else main model.
 * Match by id OR name (case-insensitive) so Settings pick cannot silently miss.
 * Invalid/missing → main + warning (never silent wrong model).
 * Returns modelName (API) + displayLabel for UI (not only config id).
 */
function resolveCouncilModel(config, mainModel) {
  const rawId =
    config?.aiRuntime?.soviet7ModelId ||
    config?.aiRuntime?.soviet7_model_id ||
    config?.soviet7ModelId ||
    "";
  const wanted = String(rawId || "").trim();
  const mainLabel = modelDisplayLabel(mainModel) || mainModel?.id || "main";

  if (!wanted) {
    return {
      model: mainModel,
      modelId: mainModel?.id,
      modelName: mainModel?.name || mainModel?.id,
      displayLabel: mainLabel,
      usedFallback: false,
      warning: null,
      source: "main",
    };
  }

  const models = Array.isArray(config?.models) ? config.models : [];
  const wantedLower = wanted.toLowerCase();
  const found =
    models.find((m) => m && String(m.id || "") === wanted) ||
    models.find((m) => m && String(m.name || "") === wanted) ||
    models.find((m) => m && String(m.id || "").toLowerCase() === wantedLower) ||
    models.find((m) => m && String(m.name || "").toLowerCase() === wantedLower);

  if (!found) {
    return {
      model: mainModel,
      modelId: mainModel?.id,
      modelName: mainModel?.name || mainModel?.id,
      displayLabel: mainLabel,
      usedFallback: true,
      warning: `soviet-7 model "${wanted}" not found in config.models — using main model ${mainLabel}`,
      source: "main-fallback",
    };
  }

  const label = modelDisplayLabel(found) || found.id;
  return {
    model: found,
    modelId: found.id,
    modelName: found.name || found.id,
    displayLabel: label,
    usedFallback: false,
    warning: null,
    source: "soviet7ModelId",
  };
}

function resolveCouncilProvider(config, councilModel, mainProvider) {
  if (!councilModel) return mainProvider;
  if (mainProvider && councilModel.providerId === mainProvider.id) return mainProvider;
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const found = providers.find((p) => p && p.id === councilModel.providerId);
  return found || mainProvider;
}

/**
 * Cap length for handoff. Marks incomplete when cut — never silent truncate-as-complete.
 * Full-list / no-compress: main must receive entire advisor dumps (often 20–40+ items each,
 * 100–200+ across 7). Default cap is intentionally high so we do not force "top 7" by clipping.
 */
function truncateAdvice(text, maxChars = 120000) {
  const s = String(text || "");
  if (s.length <= maxChars) {
    return { text: s, truncated: false };
  }
  return {
    text:
      `${s.slice(0, maxChars)}\n\n` +
      `…[truncated ${s.length - maxChars} chars — INCOMPLETE full list; truncated=true]\n` +
      `item_count below may undercount; main must re-inspect gaps. Do NOT treat the kept head as the only advice.`,
    truncated: true,
  };
}

/**
 * Run all 7 advisors with bounded concurrency (default 3 — waves, not all-at-once).
 * Soft-fail per unit. Emits subagent_status-compatible progress for UI.
 */
async function runSoviet7Council({
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
  concurrency,
}) {
  const runId = `s7-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const advisors = listAdvisors();
  const total = advisors.length;

  const resolved = resolveCouncilModel(config, mainModel);
  const councilModel = resolved.model;
  const councilProvider = resolveCouncilProvider(config, councilModel, mainProvider);
  // UI + logs: show API model name (displayLabel), not a stale config id like "gpt-4o".
  const councilModelLabel =
    resolved.displayLabel ||
    resolved.modelName ||
    modelDisplayLabel(councilModel) ||
    resolved.modelId ||
    "main";

  if (!councilProvider?.apiKey) {
    throw new Error(
      resolved.warning ||
        `Council provider API key empty (model ${councilModelLabel})`
    );
  }

  const limit = Math.min(
    total,
    Math.max(1, Math.floor(Number(concurrency) || SOVIET7_DEFAULT_CONCURRENCY))
  );

  const parentToolCallId = `soviet7-council-${runId}`;

  const emit = (payload) => {
    try {
      onProgress?.({
        sessionId,
        ...payload,
      });
    } catch {
      /* */
    }
  };

  emit({
    type: "status",
    label: `Soviet-7 · council · model ${councilModelLabel} · ${total} advisors…`,
    phase: "soviet7-council",
    agentMode: SOVIET7_MODE_ID,
    soviet7: {
      phase: "council_running",
      runId,
      total,
      completed: 0,
      modelId: resolved.modelId,
      modelName: resolved.modelName || councilModel?.name,
      displayLabel: councilModelLabel,
      source: resolved.source,
      warning: resolved.warning,
    },
  });

  if (resolved.warning) {
    emit({
      type: "status",
      label: `Soviet-7 · ${resolved.warning}`,
      phase: "soviet7-council",
      agentMode: SOVIET7_MODE_ID,
      soviet7: {
        phase: "council_running",
        modelId: resolved.modelId,
        modelName: resolved.modelName,
        displayLabel: councilModelLabel,
        warning: resolved.warning,
      },
    });
  }

  // Parent batch row for live timeline / toolActivity
  emit({
    type: "tool_start",
    toolCallId: parentToolCallId,
    name: "soviet_7_council",
    description: `Soviet-7 council · ${total} advisors · ${councilModelLabel}`,
    mode: "explore",
    batch: true,
    total,
    completed: 0,
    concurrency: limit,
    status: "running",
    statusText: `council · ${councilModelLabel}`,
    modelId: resolved.modelId,
    modelName: resolved.modelName || councilModel?.name,
    displayLabel: councilModelLabel,
  });

  emit({
    type: "subagent_status",
    toolCallId: parentToolCallId,
    parentToolCallId,
    agentId: "batch",
    batch: true,
    name: "soviet_7_council",
    status: "running",
    description: `Soviet-7 · ${total} advisors · ${councilModelLabel}`,
    text: `0/${total} done · model ${councilModelLabel}`,
    total,
    completed: 0,
    concurrency: limit,
    modelId: resolved.modelId,
    modelName: resolved.modelName || councilModel?.name,
    displayLabel: councilModelLabel,
  });

  // Pre-queue unit rows so UI shows 7 seats immediately
  for (const adv of advisors) {
    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId: `queued-${adv.index}`,
      unit: true,
      name: "soviet_7_council",
      status: "queued",
      description: adv.label,
      text: "queued",
      index: adv.index,
      total,
      mode: "explore",
    });
  }

  const results = new Array(total);
  let completed = 0;
  let cursor = 0;

  async function runOne(adv) {
    const agentId = `${adv.id}-${runId}`;
    const label = adv.label;
    const userPrompt = adv.buildUserPrompt({
      userTask,
      advisorIndex: adv.index,
      total,
      runId,
    });

    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId,
      unit: true,
      name: "soviet_7_council",
      status: "running",
      description: label,
      text: "planning architecture…",
      index: adv.index,
      total,
      mode: "explore",
    });

    try {
      if (signal?.aborted) {
        throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
      }

      await executeWorkerTask("countTokens", { text: userPrompt }).catch(() => null);
      const result = await runAgentLoop({
        provider: councilProvider,
        model: councilModel,
        messages: [{ role: "user", content: userPrompt }],
        systemPrompt: adv.systemPrompt,
        toolContext: {
          rootPath: toolContext?.rootPath || null,
          projectName: toolContext?.projectName || null,
          userDataPath: toolContext?.userDataPath || null,
          invalidateContext: toolContext?.invalidateContext,
        },
        signal,
        tokenCountingMode,
        maxContextTokens,
        autoCompactTokens,
        maxIterations: SOVIET7_MAX_ADVISOR_ITERATIONS,
        disableTools: true,
        isSubagent: true,
        subagentDepth: 1,
        onProgress: (progress) => {
          if (!progress) return;
          if (
            progress.type === "assistant_text" ||
            progress.type === "context_usage" ||
            progress.type === "assistant_thinking"
          ) {
            return;
          }
          if (progress.type === "tool_start" || progress.type === "tool_end") {
            emit({
              ...progress,
              parentToolCallId,
              agentId,
              index: adv.index,
              total,
              unit: true,
            });
            if (progress.type === "tool_start" && progress.name) {
              emit({
                type: "subagent_status",
                toolCallId: parentToolCallId,
                parentToolCallId,
                agentId,
                unit: true,
                name: "soviet_7_council",
                status: "running",
                description: label,
                text: progress.name,
                index: adv.index,
                total,
                mode: "explore",
              });
            }
          }
        },
      });

      const capped = truncateAdvice(result?.text);
      const answerText =
        capped.text || (Boolean(result?.stopped) ? "[Stopped by user]" : "(empty answer)");
      const listMeta = inspectAdvisorListPayload(answerText);
      const stopped = Boolean(result?.stopped) || Boolean(signal?.aborted);
      const statusText = stopped
        ? "stopped"
        : capped.truncated
          ? `done · incomplete list (~${listMeta.itemCount} items)`
          : listMeta.empty
            ? "done · empty list"
            : `done · ~${listMeta.itemCount || "?"} items`;

      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId,
        unit: true,
        name: "soviet_7_council",
        status: stopped ? "stopped" : "done",
        description: label,
        text: statusText,
        index: adv.index,
        total,
        mode: "explore",
      });

      return {
        id: adv.id,
        index: adv.index,
        description: label,
        ok: !stopped,
        stopped,
        truncated: Boolean(capped.truncated || listMeta.truncatedMarker),
        itemCount: listMeta.itemCount,
        looksListShaped: listMeta.looksListShaped,
        empty: listMeta.empty,
        answer: answerText,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = error?.name === "AbortError" || signal?.aborted;

      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId,
        unit: true,
        name: "soviet_7_council",
        status: aborted ? "stopped" : "error",
        description: label,
        text: aborted ? "stopped" : message.slice(0, 120),
        index: adv.index,
        total,
        mode: "explore",
      });

      return {
        id: adv.id,
        index: adv.index,
        description: label,
        ok: false,
        stopped: aborted,
        error: message,
        answer: aborted ? "[Stopped by user]" : `[error] ${message}`,
      };
    } finally {
      completed += 1;
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId: "batch",
        batch: true,
        name: "soviet_7_council",
        status: "running",
        description: `Soviet-7 · ${total} advisors · ${councilModelLabel}`,
        text: `${completed}/${total} done · model ${councilModelLabel}`,
        total,
        completed,
        concurrency: limit,
        modelId: resolved.modelId,
        modelName: resolved.modelName || councilModel?.name,
        displayLabel: councilModelLabel,
      });
      emit({
        type: "status",
        label: `Soviet-7 · advisors ${completed}/${total} · ${councilModelLabel}`,
        phase: "soviet7-council",
        agentMode: SOVIET7_MODE_ID,
        soviet7: {
          phase: "council_running",
          runId,
          total,
          completed,
          modelId: resolved.modelId,
          modelName: resolved.modelName || councilModel?.name,
          displayLabel: councilModelLabel,
          source: resolved.source,
        },
      });
    }
  }

  // Wave pool: default concurrency 3 (not 7) so multi-chat stays alive.
  // Unfinished seats start as earlier advisors finish.
  async function worker() {
    while (true) {
      if (signal?.aborted) break;
      const i = cursor;
      cursor += 1;
      if (i >= total) break;
      results[i] = await runOne(advisors[i]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, total) }, () => worker());
  await Promise.all(workers);

  // Fill any holes if aborted mid-queue
  for (let i = 0; i < total; i++) {
    if (!results[i]) {
      results[i] = {
        id: advisors[i].id,
        index: advisors[i].index,
        description: advisors[i].label,
        ok: false,
        stopped: true,
        answer: "[Stopped by user]",
        error: "not started",
      };
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const errorCount = results.filter((r) => !r.ok && !r.stopped).length;
  const stoppedCount = results.filter((r) => r.stopped).length;
  const aborted = Boolean(signal?.aborted) || stoppedCount === total;

  emit({
    type: "subagent_status",
    toolCallId: parentToolCallId,
    parentToolCallId,
    agentId: "batch",
    batch: true,
    name: "soviet_7_council",
    status: aborted ? "stopped" : errorCount === total ? "error" : "done",
    description: `Soviet-7 · ${okCount}/${total} ok · ${councilModelLabel}`,
    text: aborted
      ? "stopped"
      : `done · ok ${okCount} · err ${errorCount} · stop ${stoppedCount} · model ${councilModelLabel}`,
    total,
    completed: total,
    concurrency: limit,
    modelId: resolved.modelId,
    modelName: resolved.modelName || councilModel?.name,
    displayLabel: councilModelLabel,
  });

  emit({
    type: "tool_end",
    toolCallId: parentToolCallId,
    name: "soviet_7_council",
    ok: !aborted && okCount > 0,
    status: aborted ? "stopped" : "done",
    description: `Soviet-7 council · ${okCount}/${total} ok · ${councilModelLabel}`,
    result: {
      runId,
      okCount,
      errorCount,
      stoppedCount,
      modelId: resolved.modelId,
      modelName: resolved.modelName || councilModel?.name,
      displayLabel: councilModelLabel,
      source: resolved.source,
      warning: resolved.warning,
      // Full-list contract meta: each seat dumps a list; previews are not the only payload.
      advices: results.map((r) => ({
        id: r.id,
        index: r.index,
        ok: r.ok,
        stopped: r.stopped,
        truncated: Boolean(r.truncated),
        itemCount: typeof r.itemCount === "number" ? r.itemCount : null,
        looksListShaped: Boolean(r.looksListShaped),
        empty: Boolean(r.empty),
        preview: String(r.answer || "").slice(0, 280),
      })),
    },
  });
  emit({
    type: "status",
    label:
      okCount > 0
        ? `Soviet-7 · ${okCount}/${total} advice · model ${councilModelLabel} · synthesizing…`
        : aborted
          ? "Soviet-7 · stopped"
          : "Soviet-7 · no advice · continuing carefully…",
    phase: "soviet7-synthesize",
    agentMode: SOVIET7_MODE_ID,
    soviet7: {
      phase: "synthesizing",
      runId,
      total,
      completed: total,
      okCount,
      errorCount,
      stoppedCount,
      modelId: resolved.modelId,
      modelName: resolved.modelName || councilModel?.name,
      displayLabel: councilModelLabel,
      source: resolved.source,
    },
  });

  const handoffUserMessage = buildCouncilHandoffUserMessage({
    userTask,
    advices: results,
    meta: {
      runId,
      okCount,
      errorCount,
      stoppedCount,
      modelId: resolved.modelId,
      modelName: resolved.modelName || councilModel?.name,
      displayLabel: councilModelLabel,
      warning: resolved.warning,
    },
  });

  return {
    runId,
    aborted,
    okCount,
    errorCount,
    stoppedCount,
    modelId: resolved.modelId,
    modelName: resolved.modelName || councilModel?.name,
    displayLabel: councilModelLabel,
    source: resolved.source,
    warning: resolved.warning,
    advices: results,
    handoffUserMessage,
    parentToolCallId,
  };
}

module.exports = {
  SOVIET7_MODE_ID,
  SOVIET7_NORMAL_MODE_ID,
  SOVIET7_ADVISOR_COUNT,
  listAdvisors,
  resolveCouncilModel,
  modelDisplayLabel,
  runSoviet7Council,
  buildCouncilHandoffUserMessage,
};
