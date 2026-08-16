const { getToolSchemas } = require("../tools/registry.cjs");
const knowledgeStore = require("./knowledgeStore.cjs");
const {
  LAB_IN_MODE_ID,
  LAB_IN_MAX_HANDOFF_CHARS,
  PROMPT_REFINER_SYSTEM_PROMPT,
  SEARCH_AGENT_SYSTEM_PROMPT,
  buildRefinerPrompt,
  buildSearchPrompt,
  buildAuditPrompt,
  buildHandoff,
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
  return {
    search: Math.min(3, chunkCount),
    read: Math.min(3, chunkCount),
    links: Math.min(2, chunkCount),
  };
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
      const parentToolCallId = `lab-in-search-${Date.now().toString(16)}`;
      const toolInputs = new Map();
      const forwardProgress = (progress) => {
        if (!progress) return;
        if (progress.type === "tool_start" && progress.toolCallId) {
          toolInputs.set(progress.toolCallId, progress.input || {});
        }
        const enriched = progress.type === "tool_end"
          ? { ...progress, input: toolInputs.get(progress.toolCallId) || {} }
          : progress;
        noteToolCall(counts, enriched);
        if (progress.type === "tool_end" && progress.toolCallId) toolInputs.delete(progress.toolCallId);
        if (["tool_start", "tool_end", "retry"].includes(progress.type)) {
          emit({ ...progress, parentToolCallId, agentId: "lab-in-search", unit: true });
        }
      };
      let result = null;
      try {
        searchPasses += 1;
        result = await runAgentLoop({
          provider: searcher.provider,
          model: searcher.model,
          messages: [{
            role: "user",
            content: buildSearchPrompt({
              originalTask,
              refinedPrompt,
              conversationContext,
              knowledgeRoot: paths.root,
              chunkCount: stats.chunkCount,
            }),
          }],
          systemPrompt: SEARCH_AGENT_SYSTEM_PROMPT,
          toolContext: {
            rootPath: paths.root,
            projectName: "LAB-IN shared knowledge",
            userDataPath,
            allowedRoot: paths.root,
            knowledgeReadOnly: true,
          },
          rootPath: paths.root,
          userDataPath,
          signal,
          tokenCountingMode,
          ...stageLimits(searcher.model),
          maxIterations: 36,
          excludeToolNames: makeSearchExclusions(),
          builtinToolsOnly: true,
          isSubagent: true,
          subagentDepth: 1,
          onProgress: forwardProgress,
        });
        knowledgePackage = String(result?.text || "").trim() || knowledgePackage;

        if (!coverageMet(counts, required) && !signal?.aborted) {
          emit({
            type: "status",
            phase: "lab-in-audit",
            label: `LAB-IN · coverage audit · search ${counts.search}/${required.search}, read ${counts.read}/${required.read}, links ${counts.links}/${required.links}…`,
          });
          searchPasses += 1;
          const auditMessages = [
            ...(Array.isArray(result?.messages) ? result.messages : []),
            { role: "user", content: buildAuditPrompt({ counts, required, previousReport: knowledgePackage }) },
          ];
          const audited = await runAgentLoop({
            provider: searcher.provider,
            model: searcher.model,
            messages: auditMessages,
            systemPrompt: SEARCH_AGENT_SYSTEM_PROMPT,
            toolContext: {
              rootPath: paths.root,
              projectName: "LAB-IN shared knowledge",
              userDataPath,
              allowedRoot: paths.root,
              knowledgeReadOnly: true,
            },
            rootPath: paths.root,
            userDataPath,
            signal,
            tokenCountingMode,
            ...stageLimits(searcher.model),
            maxIterations: 24,
            excludeToolNames: makeSearchExclusions(),
            builtinToolsOnly: true,
            isSubagent: true,
            subagentDepth: 1,
            onProgress: forwardProgress,
          });
          if (String(audited?.text || "").trim()) knowledgePackage = String(audited.text).trim();
        }
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") throw error;
        warnings.push(`search agent failed: ${error?.message || error}`);
        if (!knowledgePackage.trim()) knowledgePackage = "Knowledge research failed; the main agent must proceed from workspace evidence.";
      }
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
    type: "status",
    phase: "lab-in-execute",
    label: `LAB-IN · package ready · main ${modelLabel(mainModel)} executing…`,
  });

  return {
    mode: LAB_IN_MODE_ID,
    refinedPrompt,
    knowledgePackage,
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
