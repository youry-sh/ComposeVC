const { getToolSchemas } = require("../tools/registry.cjs");
const knowledgeStore = require("./knowledgeStore.cjs");
const {
  LAB_IN_MODE_ID,
  LAB_IN_MAX_HANDOFF_CHARS,
  PROMPT_REFINER_SYSTEM_PROMPT,
  SEARCH_AGENT_SYSTEM_PROMPT,
  SEARCH_SYNTHESIS_SYSTEM_PROMPT,
  SEARCH_HELPERS,
  buildRefinerPrompt,
  buildSearchPrompt,
  buildHelperSearchPrompt,
  buildSynthesisPrompt,
  buildHandoffSequence,
  buildHandoff,
  formatRankedShortlist,
} = require("./prompts.cjs");

const SEARCH_ALLOWED_TOOLS = new Set(["grep", "read_file", "list_dir", "think", "knowledge"]);

function modelLabel(model) {
  return String(model?.name || model?.id || "main");
}

function resolveStageModel(config, mainModel, mainProvider, settingKey) {
  const raw = String(config?.aiRuntime?.[settingKey] || "").trim();
  const models = Array.isArray(config?.models) ? config.models : [];
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const wanted = raw.toLowerCase();
  const found = raw
    ? models.find((item) => String(item?.id || "").toLowerCase() === wanted) ||
      models.find((item) => String(item?.name || "").toLowerCase() === wanted)
    : null;
  const model = found || mainModel;
  const provider = providers.find((item) => item?.id === model?.providerId) || mainProvider;
  return {
    model,
    provider,
    source: found ? settingKey : "main",
    warning: raw && !found ? `${settingKey} model "${raw}" is missing; using ${modelLabel(mainModel)}` : null,
  };
}

function stageLimits(model) {
  const context = Math.max(8000, Number(model?.contextLimit) || 256000);
  return { maxContextTokens: context, autoCompactTokens: Math.max(4000, Math.floor(context * 0.8)) };
}

function truncatePackage(text, maxChars = LAB_IN_MAX_HANDOFF_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n\n…[LAB-IN package truncated by host: omitted ${value.length - maxChars} chars. Treat coverage as incomplete.]`,
    truncated: true,
  };
}

function requiredCoverage(chunkCount) {
  if (chunkCount <= 0) return { search: 0, read: 0, links: 0 };
  return { search: 1, read: 1, links: 0 };
}

function emptyCounts() {
  return { search: 0, read: 0, links: 0, total: 0 };
}

function noteToolCall(counts, progress) {
  if (progress?.type !== "tool_end" || progress?.ok === false) return;
  const name = String(progress.name || "");
  const input = progress.input || progress.toolInput || {};
  counts.total += 1;
  if (name === "grep") counts.search += 1;
  if (name === "read_file") counts.read += 1;
  if (name === "knowledge") {
    const action = String(input?.action || "").toLowerCase();
    if (action === "search") counts.search += 1;
    if (action === "read") counts.read += 1;
    if (action === "links") counts.links += 1;
  }
}

function coverageMet(counts, required) {
  return counts.search >= required.search && counts.read >= required.read && counts.links >= required.links;
}

function makeSearchExclusions() {
  return getToolSchemas()
    .map((tool) => tool.name)
    .filter((name) => !SEARCH_ALLOWED_TOOLS.has(name));
}

function searchToolContext(paths, userDataPath) {
  return {
    rootPath: paths.root,
    projectName: "LAB-IN shared knowledge",
    userDataPath,
    allowedRoot: paths.root,
    knowledgeReadOnly: true,
  };
}

function researchReportLimit(model, reportCount = 4) {
  const contextTokens = Math.max(8000, Number(model?.contextLimit) || 256000);
  const sharedBudgetChars = Math.floor(contextTokens * 4 * 0.55);
  return Math.max(5000, Math.min(36000, Math.floor(sharedBudgetChars / Math.max(1, reportCount))));
}

function capResearchReport(text, maxChars) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n\n…[research report capped by LAB-IN host; synthesis must treat this source as incomplete]`,
    truncated: true,
  };
}

function fallbackResearchPackage(reports) {
  const usable = (Array.isArray(reports) ? reports : []).filter((report) => String(report?.text || "").trim());
  if (!usable.length) return "Knowledge research failed; the main agent must proceed from workspace evidence.";
  return [
    "[LAB-IN Search Team fallback: final synthesis failed. The independent reports follow and may overlap.]",
    ...usable.map((report) => `\n## ${report.label}\n${report.text}`),
  ].join("\n");
}

async function runSearchTeam({
  runAgentLoop,
  searcher,
  originalTask,
  refinedPrompt,
  conversationContext,
  paths,
  stats,
  userDataPath,
  signal,
  tokenCountingMode,
  counts,
  required,
  emit,
}) {
  const runId = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
  const parentToolCallId = `lab-in-search-team-${runId}`;
  const warnings = [];
  const synthesisCounts = emptyCounts();
  let searchPasses = 0;
  let completed = 0;

  const assertRunning = () => {
    if (signal?.aborted) throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
  };
  let rankedResults = [];
  try {
    const taskQuery = String(originalTask || "").trim();
    if (taskQuery) rankedResults = await knowledgeStore.searchKnowledge(userDataPath, taskQuery, { limit: 12 });
  } catch (error) {
    warnings.push(`ranked shortlist failed: ${error?.message || error}`);
  }
  const rankedBlock = formatRankedShortlist(rankedResults);
  const commonPromptInput = {
    originalTask,
    refinedPrompt,
    conversationContext,
    knowledgeRoot: paths.root,
    chunkCount: stats.chunkCount,
    rankedBlock,
  };
  const researchers = [
    {
      id: "lead",
      label: "Search Lead",
      prompt: buildSearchPrompt(commonPromptInput),
      maxIterations: 30,
    },
    ...SEARCH_HELPERS.map((helper) => ({
      id: `helper-${helper.id}`,
      label: helper.label,
      prompt: buildHelperSearchPrompt({ ...commonPromptInput, helper }),
      maxIterations: 24,
    })),
  ];

  emit({
    type: "tool_start",
    toolCallId: parentToolCallId,
    name: "lab_in_search_team",
    description: `LAB-IN Search Lead + ${SEARCH_HELPERS.length} helpers · ${stats.chunkCount} chunks`,
    mode: "explore",
    batch: true,
    total: researchers.length,
    completed: 0,
    concurrency: researchers.length,
    status: "running",
  });
  emit({
    type: "subagent_status",
    toolCallId: parentToolCallId,
    parentToolCallId,
    agentId: "batch",
    batch: true,
    name: "lab_in_search_team",
    status: "running",
    description: `Search Lead + ${SEARCH_HELPERS.length} helpers`,
    text: `0/${researchers.length} done`,
    total: researchers.length,
    completed: 0,
    concurrency: researchers.length,
  });
  for (const researcher of researchers) {
    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId: researcher.id,
      unit: true,
      name: "lab_in_search_team",
      status: "queued",
      description: researcher.label,
      text: "queued",
      mode: "explore",
    });
  }

  const makeProgressForwarder = (researcher, localCounts, parentId = parentToolCallId) => {
    const toolInputs = new Map();
    return (progress) => {
      if (!progress) return;
      if (progress.type === "tool_start" && progress.toolCallId) {
        toolInputs.set(progress.toolCallId, progress.input || {});
      }
      const enriched = progress.type === "tool_end"
        ? { ...progress, input: toolInputs.get(progress.toolCallId) || {} }
        : progress;
      noteToolCall(counts, enriched);
      noteToolCall(localCounts, enriched);
      if (progress.type === "tool_end" && progress.toolCallId) toolInputs.delete(progress.toolCallId);
      if (["tool_start", "tool_end", "retry"].includes(progress.type)) {
        emit({ ...progress, parentToolCallId: parentId, agentId: researcher.id, unit: true });
      }
    };
  };

  const runResearcher = async (researcher) => {
    const localCounts = emptyCounts();
    emit({
      type: "subagent_status",
      toolCallId: parentToolCallId,
      parentToolCallId,
      agentId: researcher.id,
      unit: true,
      name: "lab_in_search_team",
      status: "running",
      description: researcher.label,
      text: "researching shared memory…",
      mode: "explore",
    });
    searchPasses += 1;
    try {
      assertRunning();
      const result = await runAgentLoop({
        provider: searcher.provider,
        model: searcher.model,
        messages: [{ role: "user", content: researcher.prompt }],
        systemPrompt: SEARCH_AGENT_SYSTEM_PROMPT,
        toolContext: searchToolContext(paths, userDataPath),
        rootPath: paths.root,
        userDataPath,
        signal,
        tokenCountingMode,
        ...stageLimits(searcher.model),
        maxIterations: researcher.maxIterations,
        excludeToolNames: makeSearchExclusions(),
        builtinToolsOnly: true,
        isSubagent: true,
        subagentDepth: 1,
        onProgress: makeProgressForwarder(researcher, localCounts),
      });
      const text = String(result?.text || "").trim();
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId: researcher.id,
        unit: true,
        name: "lab_in_search_team",
        status: text ? "done" : "error",
        description: researcher.label,
        text: text
          ? `done · search ${localCounts.search} · read ${localCounts.read} · links ${localCounts.links}`
          : "empty report",
        mode: "explore",
      });
      return { ...researcher, ok: Boolean(text), text, counts: localCounts };
    } catch (error) {
      const aborted = signal?.aborted || error?.name === "AbortError";
      const message = error?.message || String(error);
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId: researcher.id,
        unit: true,
        name: "lab_in_search_team",
        status: aborted ? "stopped" : "error",
        description: researcher.label,
        text: aborted ? "stopped" : String(message).slice(0, 140),
        mode: "explore",
      });
      if (!aborted) warnings.push(`${researcher.label} failed: ${message}`);
      return { ...researcher, ok: false, stopped: aborted, text: "", error: message, counts: localCounts };
    } finally {
      completed += 1;
      emit({
        type: "subagent_status",
        toolCallId: parentToolCallId,
        parentToolCallId,
        agentId: "batch",
        batch: true,
        name: "lab_in_search_team",
        status: "running",
        description: `Search Lead + ${SEARCH_HELPERS.length} helpers`,
        text: `${completed}/${researchers.length} done`,
        total: researchers.length,
        completed,
        concurrency: researchers.length,
      });
    }
  };

  const reports = await Promise.all(researchers.map(runResearcher));
  assertRunning();
  const okCount = reports.filter((report) => report.ok).length;
  const researcherMeta = reports.map((report) => ({
    id: report.id,
    label: report.label,
    ok: report.ok,
    stopped: Boolean(report.stopped),
    counts: report.counts,
    error: report.error || null,
  }));

  emit({
    type: "subagent_status",
    toolCallId: parentToolCallId,
    parentToolCallId,
    agentId: "batch",
    batch: true,
    name: "lab_in_search_team",
    status: okCount ? "done" : "error",
    description: `Search team · ${okCount}/${researchers.length} reports ready`,
    text: `done · ${okCount}/${researchers.length} reports`,
    total: researchers.length,
    completed: researchers.length,
    concurrency: researchers.length,
  });
  emit({
    type: "tool_end",
    toolCallId: parentToolCallId,
    name: "lab_in_search_team",
    ok: okCount > 0,
    status: okCount ? "done" : "error",
    result: { total: researchers.length, okCount },
  });

  let knowledgePackage = fallbackResearchPackage(reports);
  if (!okCount) {
    return { knowledgePackage, searchPasses, researcherMeta, synthesisCounts, warnings };
  }

  emit({
    type: "status",
    phase: "lab-in-synthesis",
    label: `LAB-IN · Search Lead merging ${okCount}/${researchers.length} reports · ${modelLabel(searcher.model)}…`,
  });
  const perReportLimit = researchReportLimit(searcher.model, reports.length);
  let sourceReportsTruncated = false;
  const synthesisReports = reports.map((report) => {
    const capped = capResearchReport(report.text || report.error || "(empty report)", perReportLimit);
    if (capped.truncated) sourceReportsTruncated = true;
    return { ...report, text: capped.text };
  });
  if (sourceReportsTruncated) warnings.push("one or more research reports were capped before Search Lead synthesis");

  const synthesisToolCallId = `lab-in-search-synthesis-${runId}`;
  emit({
    type: "tool_start",
    toolCallId: synthesisToolCallId,
    name: "lab_in_search_synthesis",
    description: `Search Lead merging ${okCount}/${researchers.length} independent reports`,
    mode: "explore",
    status: "running",
  });
  try {
    searchPasses += 1;
    const synthesized = await runAgentLoop({
      provider: searcher.provider,
      model: searcher.model,
      messages: [{
        role: "user",
        content: buildSynthesisPrompt({
          originalTask,
          refinedPrompt,
          knowledgeRoot: paths.root,
          counts,
          required,
          reports: synthesisReports,
        }),
      }],
      systemPrompt: SEARCH_SYNTHESIS_SYSTEM_PROMPT,
      toolContext: searchToolContext(paths, userDataPath),
      rootPath: paths.root,
      userDataPath,
      signal,
      tokenCountingMode,
      ...stageLimits(searcher.model),
      maxIterations: 2,
      disableTools: true,
      isSubagent: true,
      subagentDepth: 1,
      onProgress: makeProgressForwarder({ id: "lead-synthesis" }, synthesisCounts, synthesisToolCallId),
    });
    if (String(synthesized?.text || "").trim()) knowledgePackage = String(synthesized.text).trim();
    emit({
      type: "tool_end",
      toolCallId: synthesisToolCallId,
      name: "lab_in_search_synthesis",
      ok: true,
      status: "done",
      result: { sourceReports: reports.length, sourceReportsOk: okCount, counts: synthesisCounts },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    warnings.push(`Search Lead synthesis failed: ${error?.message || error}`);
    emit({
      type: "tool_end",
      toolCallId: synthesisToolCallId,
      name: "lab_in_search_synthesis",
      ok: false,
      status: "error",
      error: error?.message || String(error),
    });
  }

  return { knowledgePackage, searchPasses, researcherMeta, synthesisCounts, warnings };
}

async function runLabInPipeline({
  runAgentLoop,
  config,
  mainModel,
  mainProvider,
  originalTask,
  conversationContext,
  projectName,
  userDataPath,
  signal,
  tokenCountingMode,
  onProgress,
  sessionId,
}) {
  const emit = (payload) => {
    try {
      onProgress?.({ sessionId, agentMode: LAB_IN_MODE_ID, ...payload });
    } catch {
      /* renderer may be gone */
    }
  };
  const ensureRunning = () => {
    if (signal?.aborted) throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
  };

  ensureRunning();
  const paths = await knowledgeStore.ensureStore(userDataPath);
  const stats = await knowledgeStore.knowledgeStats(userDataPath);
  const refiner = resolveStageModel(config, mainModel, mainProvider, "labInPromptModelId");
  const searcher = resolveStageModel(config, mainModel, mainProvider, "labInSearchModelId");
  const warnings = [refiner.warning, searcher.warning].filter(Boolean);

  emit({
    type: "status",
    phase: "lab-in-refine",
    label: `LAB-IN · improving prompt · ${modelLabel(refiner.model)}…`,
  });
  let refinedPrompt = String(originalTask || "").trim();
  try {
    ensureRunning();
    if (!refiner.provider?.apiKey) throw new Error(`Prompt-refiner API key is empty for ${refiner.provider?.name || "provider"}`);
    const result = await runAgentLoop({
      provider: refiner.provider,
      model: refiner.model,
      messages: [{
        role: "user",
        content: buildRefinerPrompt({ originalTask, conversationContext, projectName }),
      }],
      systemPrompt: PROMPT_REFINER_SYSTEM_PROMPT,
      signal,
      tokenCountingMode,
      ...stageLimits(refiner.model),
      maxIterations: 2,
      disableTools: true,
      isSubagent: true,
      subagentDepth: 1,
      userDataPath,
    });
    if (String(result?.text || "").trim()) refinedPrompt = String(result.text).trim();
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    warnings.push(`prompt refiner failed: ${error?.message || error}`);
  }

  ensureRunning();
  let knowledgePackage = "The shared LAB-IN knowledge base is empty. No stored guidance was available for this request.";
  const counts = emptyCounts();
  const required = requiredCoverage(stats.chunkCount);
  let searchPasses = 0;
  let truncated = false;
  let researcherMeta = [];
  const synthesisCounts = emptyCounts();

  emit({
    type: "status",
    phase: "lab-in-search",
    label: stats.chunkCount
      ? `LAB-IN · searching ${stats.chunkCount} knowledge chunks · ${modelLabel(searcher.model)}…`
      : "LAB-IN · shared knowledge is empty · preparing execution…",
  });

  if (stats.chunkCount > 0) {
    if (!searcher.provider?.apiKey) {
      warnings.push(`search-agent API key is empty for ${searcher.provider?.name || "provider"}`);
    } else {
      const team = await runSearchTeam({
        runAgentLoop,
        searcher,
        originalTask,
        refinedPrompt,
        conversationContext,
        paths,
        stats,
        userDataPath,
        signal,
        tokenCountingMode,
        counts,
        required,
        emit,
      });
      knowledgePackage = team.knowledgePackage;
      searchPasses = team.searchPasses;
      researcherMeta = team.researcherMeta;
      Object.assign(synthesisCounts, team.synthesisCounts);
      warnings.push(...team.warnings);
    }
  }

  const capped = truncatePackage(knowledgePackage);
  knowledgePackage = capped.text;
  truncated = capped.truncated;
  const coverage = coverageMet(counts, required);
  if (stats.chunkCount > 0 && !coverage) {
    knowledgePackage +=
      `\n\n[LAB-IN host coverage warning: search ${counts.search}/${required.search}, ` +
      `read ${counts.read}/${required.read}, links ${counts.links}/${required.links}. ` +
      "Do not assume the knowledge base was exhaustively covered.]";
  }

  emit({
    type: "lab_in_package",
    phase: "lab-in-execute",
    label: `LAB-IN · package ready · main ${modelLabel(mainModel)} executing…`,
    knowledgePackage,
    refinedPrompt,
    chunkCount: stats.chunkCount,
    truncated,
    coverage,
  });

  const handoffSequence = buildHandoffSequence({
    originalTask,
    refinedPrompt,
    knowledgePackage,
    knowledgeMeta: stats,
  });

  emit({
    type: "status",
    phase: "lab-in-execute",
    label: `LAB-IN · package ready · main ${modelLabel(mainModel)} executing…`,
  });

  return {
    mode: LAB_IN_MODE_ID,
    refinedPrompt,
    knowledgePackage,
    handoffMessages: handoffSequence.messages,
    handoffUserMessage: buildHandoff({
      originalTask,
      refinedPrompt,
      knowledgePackage,
      knowledgeMeta: stats,
    }),
    meta: {
      ok: stats.chunkCount === 0 || coverage,
      chunkCount: stats.chunkCount,
      knowledgeRoot: stats.root,
      promptModelId: refiner.model?.id,
      promptModelName: refiner.model?.name,
      searchModelId: searcher.model?.id,
      searchModelName: searcher.model?.name,
      counts,
      required,
      coverage,
      searchPasses,
      handoffPartCount: handoffSequence.partCount,
      segmentedHandoff: handoffSequence.segmented,
      searchTeam: {
        researcherCount: researcherMeta.length,
        helperCount: researcherMeta.filter((researcher) => researcher.id.startsWith("helper-")).length,
        researchers: researcherMeta,
        synthesisCounts,
      },
      truncated,
      warnings,
    },
  };
}

module.exports = {
  LAB_IN_MODE_ID,
  resolveStageModel,
  requiredCoverage,
  coverageMet,
  truncatePackage,
  runLabInPipeline,
};
