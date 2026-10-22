const {
  getToolSchemas,
  getToolSchemasAsync,
  getTool,
  dispatch,
  normalizeToolName,
} = require("./tools/registry.cjs");
const { getAdapter } = require("./adapters/index.cjs");
const { trackExternalUsage } = require("./externalUsage.cjs");
const { countMessagesTokens, countTokens, countToolSchemaTokens, makeUsageEstimate } = require("./tokenCount.cjs");
const { exec: executeWorkerTask } = require("./workerPool.cjs");
const { compactMessages } = require("./compact.cjs");
const { createAskUserHandler, rejectAllPending } = require("./askUserBridge.cjs");
const { createSpawnSubagentHandler } = require("./subagent.cjs");
const codeImpactHost = require("./codeImpactHost.cjs");
const chatSessions = require("./chatSessionRegistry.cjs");
const { REQUIRED_CYCLES, getCycleDirective } = require("./thinkingMaxPrompt.cjs");

const ITERATIONS_PER_CONTINUE = 7;
/** Root agent turn budget (chat). Subagents may request higher via maxIterations. */
const MAX_TOTAL_ITERATIONS = 8000;
/** Subagent hard ceiling (worker automation needs long tool runs). */
const MAX_SUBAGENT_TOTAL_ITERATIONS = 250;
const MAX_TOOL_CALLS_PER_BATCH = 20;
const THINKING_MAX_REQUIRED_CYCLES = REQUIRED_CYCLES;
const DEFAULT_MAX_CONTEXT_TOKENS = 500000;
const DEFAULT_AUTO_COMPACT_TOKENS = 400000;
const ABSOLUTE_MAX_CONTEXT_TOKENS = 2_000_000;
// First text is delivered immediately; subsequent provider deltas are grouped
// into a smooth ~15 FPS stream. This removes most IPC/Markdown churn without a
// perceptible typing delay, and large bursts bypass the timer automatically.
const STREAM_DELTA_FLUSH_MS = 64;
const STREAM_DELTA_FORCE_CHARS = 8_192;

function clampTokenBudget(value, fallback, { min = 1_000, max = ABSOLUTE_MAX_CONTEXT_TOKENS } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

const CONTINUE_NUDGE =
  "Continue exactly where you left off. Keep working autonomously until the task is fully complete, then give the final answer.";

const WRAP_UP_NUDGE =
  "You have reached the maximum number of steps for this turn. Stop calling tools now and reply with a clear final summary of everything you completed, and what (if anything) still remains to be done.";

function getWorkTimerStatus(timer) {
  if (!timer?.deadlineAt) return { active: false, remainingSeconds: 0, remainingMinutes: 0 };
  const remainingSeconds = Math.max(0, Math.ceil((timer.deadlineAt - Date.now()) / 1000));
  return {
    active: remainingSeconds > 0,
    remainingSeconds,
    remainingMinutes: Math.ceil(remainingSeconds / 60),
  };
}

function buildWorkTimerNudge(timer) {
  const status = getWorkTimerStatus(timer);
  return (
    `The work timer is still active: ${status.remainingMinutes} minute(s) ` +
    `(${status.remainingSeconds} seconds) remain. Do not give a final answer yet. ` +
    "Look for patterns and non-obvious relationships; compare facts and requirements; form concrete hypotheses, " +
    "then validate or reject them with code, tests, logs, or other tools. " +
    "Build and update a risk map covering requirements, assumptions, dependencies, interfaces, data flow, edge cases, and failure points. " +
    "Check overlaps and contradictions between changes, current behavior, and future execution paths; " +
    "look for regressions, races, incomplete states, hidden dependencies, and error-handling gaps. " +
    "Revisit completed work from different angles to find weak assumptions, missed cases, test blind spots, and safeguards against future defects. " +
    "Prioritize by impact and evidence; do not invent work without a verifiable reason. " +
    "Do not repeat the same actions or fill time by waiting—every next step must produce new verifiable information or improve the result. " +
    "Use work_timer action=status to check the exact remaining time."
  );
}

/** Soft ceiling so code_impact blockers cannot trap the loop forever (host also caps). */
const MAX_CODE_IMPACT_NUDGES = 2;

function toolsByNameLength(tools) {
  return (tools || []).slice().sort((a, b) => b.name.length - a.name.length);
}

function hardNormalizeToolName(name, toolsSorted) {
  const normalized = normalizeToolName(name);
  if (getTool(normalized)) return normalized;
  const tools = toolsSorted || [];
  if (tools.some((tool) => tool.name === normalized)) return normalized;
  const compact = String(name || "").trim().replace(/[^a-zA-Z0-9_]/g, "");
  const byRepeat = tools.find(
    (tool) => compact.length > tool.name.length && compact.replaceAll(tool.name, "") === ""
  );
  if (byRepeat) return byRepeat.name;
  const byPrefix = tools.find((tool) => compact.startsWith(tool.name));
  if (byPrefix) return byPrefix.name;
  const byEmbedded = tools.find((tool) => compact.includes(tool.name));
  return byEmbedded ? byEmbedded.name : normalized;
}

function normalizeMessageToolCalls(messages, tools) {
  const sorted = toolsByNameLength(tools);
  return (messages || []).map((message) => {
    if (!message?.toolCalls?.length) return message;
    return {
      ...message,
      toolCalls: message.toolCalls.map((call) => ({
        ...call,
        name: hardNormalizeToolName(call.name, sorted),
      })),
    };
  });
}

/** Hard cap for tool results in the model transcript — keeps context from ballooning. */
const TOOL_RESULT_CHAR_LIMIT = 4000;
/**
 * read_file is hard-capped to ~400 lines in the tool itself.
 * ~400 lines × ~120 chars + header ≈ 50k worst case; 48k is enough headroom
 * without inviting full multi-k dumps (those no longer come back from the tool).
 */
const READ_FILE_RESULT_CHAR_LIMIT = 48000;

function toolResultCharLimit(toolName = "") {
  if (toolName === "read_file") return READ_FILE_RESULT_CHAR_LIMIT;
  // Write tools carry an auto-appended ## code_impact card — need headroom.
  if (toolName === "edit_file" || toolName === "create_file") return 7000;
  return TOOL_RESULT_CHAR_LIMIT;
}

function extractToolImages(data) {
  if (!data || typeof data !== "object") return undefined;
  const out = [];
  const seen = new Set();
  const push = (img) => {
    if (!img) return;
    if (typeof img === "string") {
      const u = img.trim();
      if (!u || seen.has(u)) return;
      seen.add(u);
      out.push({ url: u });
      return;
    }
    if (typeof img !== "object") return;
    const url = String(img.url || img.dataUrl || img.src || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      mimeType: img.mimeType || img.mediaType || undefined,
      name: img.name || img.filename || undefined,
    });
  };
  // Only the reserved tool-output fields opt into multimodal history. Generic
  // response properties such as `image_url` / `dataUrl` are often page metadata
  // returned by web tools, not user attachments. Promoting them made the next model
  // request try to download a transient site asset (often 404) or sent image_url to
  // text-only endpoints even though the user never attached an image.
  if (Array.isArray(data.__images)) {
    for (const img of data.__images) push(img);
  }
  if (data.__image) push(data.__image);
  return out.length ? out : undefined;
}

async function toDisplayContentAsync(data, toolName = "") {
  if (toolName === "read_file" || toolName === "edit_file" || toolName === "create_file") {
    return toDisplayContent(data, toolName);
  }
  try {
    const text = await executeWorkerTask("formatToolResult", {
      value: data,
      limit: toolResultCharLimit(toolName),
    });
    return String(text || "");
  } catch {
    return toDisplayContent(data, toolName);
  }
}

function toDisplayContent(data, toolName = "") {
  // Lazy require — avoid circular load with proxy helpers at boot.
  let sanitizeJsonSafeString = (s) => (s == null ? "" : String(s));
  let truncateUtf16Safe = (s, n) => {
    const t = String(s || "");
    return t.length <= n ? t : t.slice(0, n);
  };
  try {
    const fmt = require("./proxy/openaiFormat.cjs");
    if (typeof fmt.sanitizeJsonSafeString === "function") {
      sanitizeJsonSafeString = fmt.sanitizeJsonSafeString;
    }
    if (typeof fmt.truncateUtf16Safe === "function") {
      truncateUtf16Safe = fmt.truncateUtf16Safe;
    }
  } catch {
    /* optional */
  }

  let text;
  try {
    if (typeof data === "string") {
      text = data;
    } else if (data && typeof data === "object" && typeof data.__toolText === "string") {
      // Tools may return preformatted dense text for the model
      text = data.__toolText;
    } else if (data && typeof data === "object" && toolName === "read_file" && typeof data.content === "string") {
      // Prefer dense numbered content over full JSON wrapper (saves quote escaping overhead).
      const parts = [];
      if (typeof data.path === "string") parts.push(`path: ${data.path}`);
      if (data.totalLines != null) parts.push(`totalLines: ${data.totalLines}`);
      if (data.offset != null) parts.push(`offset: ${data.offset}`);
      if (data.returnedLines != null) parts.push(`returnedLines: ${data.returnedLines}`);
      if (data.truncated === true) {
        parts.push(`truncated: true`);
        if (data.nextOffset != null) parts.push(`nextOffset: ${data.nextOffset}`);
      }
      if (typeof data.note === "string" && data.note.trim()) parts.push(data.note.trim());
      const header = parts.length ? `${parts.join("\n")}\n` : "";
      text = `${header}${data.content}`;
    } else {
      // Compact JSON — pretty-print wastes space under the char cap
      text = JSON.stringify(data);
    }
  } catch {
    text = String(data);
  }
  // Browser/CDP dumps can inject lone surrogates / nulls; strip before transcript.
  text = sanitizeJsonSafeString(text);
  const limit = toolResultCharLimit(toolName);
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  // UTF-16-safe truncate: never leave a dangling high surrogate (Codex JSON 400).
  const head = truncateUtf16Safe(text, limit);
  return (
    `${head}\n\n` +
    `…[TRUNCATED: showed ${limit}/${text.length} chars, omitted ${omitted}. ` +
    (toolName === "read_file"
      ? "Call read_file again with offset/limit for the rest.]"
      : "Request a smaller slice (offset/limit / narrower query) if you need the rest.]")
  );
}

async function runAgentLoop(opts) {
  await chatSessions.acquireAgentLoopSlot();
  try {
    return await runAgentLoopInner(opts);
  } finally {
    chatSessions.releaseAgentLoopSlot();
  }
}

async function runAgentLoopInner({
  provider,
  model,
  messages,
  systemPrompt,
  toolContext,
  onProgress,
  onMessagesChange,
  signal,
  tokenCountingMode = "provider",
  maxContextTokens,
  autoCompactTokens,
  keepRecentMessages,
  maxIterations = MAX_TOTAL_ITERATIONS,
  excludeToolNames = [],
  disableTools = false,
  builtinToolsOnly = false,
  isSubagent = false,
  subagentDepth = 0,
  sessionId = null,
  rootPath = null,
  userDataPath = null,
  customToolQuery = "",
  thinkingMax = false,
}) {
  const toolsUserDataPath = userDataPath || toolContext?.userDataPath || null;
  const toolsRootPath = rootPath || toolContext?.rootPath || null;
  const toolsQuery =
    typeof customToolQuery === "string" && customToolQuery.trim()
      ? customToolQuery
      : typeof toolContext?.customToolQuery === "string"
        ? toolContext.customToolQuery
        : "";
  let tools = disableTools
    ? []
    : builtinToolsOnly
      ? getToolSchemas({ excludeNames: excludeToolNames })
      : await getToolSchemasAsync({
          excludeNames: excludeToolNames,
          userDataPath: toolsUserDataPath,
          rootPath: toolsRootPath,
          query: toolsQuery,
        });
  let toolsSorted = toolsByNameLength(tools);
  let toolsFingerprint = tools
    .map((t) => `${t.name}:${t.customId || ""}:${(t.description || "").slice(0, 48)}`)
    .join("|");
  const refreshToolSchemas = async (force = false) => {
    if (disableTools || builtinToolsOnly) return false;
    if (!toolsUserDataPath && !force) return false;
    try {
      const next = await getToolSchemasAsync({
        excludeNames: excludeToolNames,
        userDataPath: toolsUserDataPath,
        rootPath: toolsRootPath,
        query: toolsQuery,
      });
      const nextFingerprint = next
        .map((t) => `${t.name}:${t.customId || ""}:${(t.description || "").slice(0, 48)}`)
        .join("|");
      if (!force && nextFingerprint === toolsFingerprint) return false;
      tools = next;
      toolsSorted = toolsByNameLength(tools);
      toolsFingerprint = nextFingerprint;
      toolSchemaTokens = countToolSchemaTokens(tools);
      return true;
    } catch {
      return false;
    }
  };
  const adapter = getAdapter(provider.type);
  // AI Runtime maxContextTokens is the hard window. Per-model contextLimit is informational only
  // (many configs still ship models with the old 256k default and must not override the setting).
  const contextLimit = clampTokenBudget(maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS, {
    min: 8_000,
    max: ABSOLUTE_MAX_CONTEXT_TOKENS,
  });
  const compactThreshold = (() => {
    const compactCap = Math.max(4_000, contextLimit - 1_000);
    let threshold = clampTokenBudget(autoCompactTokens, Math.min(DEFAULT_AUTO_COMPACT_TOKENS, compactCap), {
      min: 4_000,
      max: compactCap,
    });
    if (threshold >= contextLimit) threshold = Math.max(4_000, contextLimit - 1_000);
    return threshold;
  })();
  const keepRecent =
    Number.isFinite(Number(keepRecentMessages)) && Number(keepRecentMessages) > 0
      ? Math.floor(Number(keepRecentMessages))
      : 16;
  let compactionResult = null;
  let workingMessages = normalizeMessageToolCalls(messages, tools);

  const systemPromptTokens = countTokens(systemPrompt || "");
  let toolSchemaTokens = countToolSchemaTokens(tools);

  const usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let lastPromptTokens = 0;
  let lastText = "";
  let cachedContextMessages = null;
  let cachedContextTokens = 0;
  const currentContextTokens = () => {
    if (cachedContextMessages !== workingMessages) {
      cachedContextMessages = workingMessages;
      cachedContextTokens = countMessagesTokens(workingMessages) + systemPromptTokens + toolSchemaTokens;
    }
    return Math.max(lastPromptTokens || 0, cachedContextTokens || 0);
  };
  let toolCallsInBatch = 0;
  let totalToolCalls = 0;
  let thinkingMaxCycles = 0;
  // Kept only in this run's tool context. work_timer owns the deadline and offers no cancel/extend action.
  const workTimer = { startedAt: null, deadlineAt: null, totalMinutes: null };
  /** Code-impact open-blocker nudges this turn (also capped inside host). */
  let codeImpactNudgeCount = 0;

  // Per-turn relation session: after edit/create → impact card; blockers → beforeFinal nudge.
  // Root agent only — shared engine session must not be clobbered by parallel subagents.
  const codeImpact =
    !isSubagent && toolContext?.rootPath
      ? codeImpactHost.createTurnSession(toolContext.rootPath)
      : null;
  // Warm index in background — must not block first model call.
  if (codeImpact) {
    Promise.resolve()
      .then(() => codeImpact.ensureIndexed())
      .catch(() => {
        /* best-effort */
      });
  }

  // Stop is cooperative, not a mid-request network abort: the HTTP adapters buffer the
  // whole response body before returning (no real token streaming), so aborting a request
  // in flight would just throw away that response with nothing recovered. Instead we check
  // the signal between loop steps and return everything gathered so far — the user's
  // "stop" always yields whatever was actually generated, never an empty/lost turn.
  const withAssistantMessage = (text, images, reasoningContent) => {
    const msg = { role: "assistant", content: text || "" };
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    if (Array.isArray(images) && images.length) msg.images = images;
    return [...workingMessages, msg];
  };

  /**
   * Assistant turns that committed toolCalls without a matching role:"tool" leave the
   * transcript invalid for providers/UI. Walk the working list and return still-open calls.
   */
  const findOpenToolCalls = () => {
    const open = new Map();
    for (const msg of workingMessages) {
      if (!msg || typeof msg !== "object") continue;
      if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
        for (const call of msg.toolCalls) {
          if (!call || typeof call !== "object") continue;
          const id = call.id != null ? String(call.id) : "";
          if (!id) continue;
          open.set(id, {
            id,
            name: call.name ? String(call.name) : "tool",
          });
        }
      } else if (msg.role === "tool" && msg.toolCallId != null) {
        open.delete(String(msg.toolCallId));
      }
    }
    return [...open.values()];
  };

  /**
   * Append synthetic role:"tool" rows for every open toolCallId (same shape as real results).
   * Idempotent: already-closed ids are skipped. Emits tool_end so live UI cards settle.
   */
  const closeOpenToolCalls = (reason = "Stopped by user") => {
    const open = findOpenToolCalls();
    if (!open.length) return 0;
    const content = `Error: ${reason}`;
    for (const call of open) {
      workingMessages = [
        ...workingMessages,
        {
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content,
        },
      ];
      onProgress?.({
        type: "tool_end",
        toolCallId: call.id,
        name: call.name,
        ok: false,
        result: reason,
      });
    }
    return open.length;
  };

  /**
   * After successful edit_file/create_file/restore_backup: impact card under tool result.
   * Best-effort — never throws into the loop.
   */
  const attachImpactCardToOutcome = (outcome, hit) => {
    if (!hit?.card || !outcome) return outcome;
    onProgress?.({
      type: "code_impact",
      paths: codeImpact?.state?.lastWritePaths || [],
      openBlockers: hit.openBlockers || 0,
      open: (hit.open || []).length,
    });
    if (outcome.data && typeof outcome.data === "object") {
      const baseText =
        typeof outcome.data.__toolText === "string" ? outcome.data.__toolText : null;
      const data = {
        ...outcome.data,
        codeImpact: {
          openBlockers: hit.openBlockers || 0,
          open: (hit.open || []).map((o) => ({
            path: o.path,
            severity: o.severity,
            reason: o.reason,
            id: o.id,
          })),
        },
      };
      if (baseText) {
        data.__toolText = codeImpactHost.appendCardToToolText(baseText, hit.card);
      } else {
        data.__impactCard = hit.card;
      }
      return { ...outcome, data };
    }
    if (typeof outcome.data === "string") {
      return {
        ...outcome,
        data: codeImpactHost.appendCardToToolText(outcome.data, hit.card),
      };
    }
    return outcome;
  };

  const enrichWriteOutcomeWithImpact = async (call, outcome) => {
    if (!codeImpact || !outcome?.ok || !call?.name) return outcome;
    if (!codeImpactHost.WRITE_TOOLS.has(call.name)) return outcome;
    try {
      const hit = await codeImpact.noteWriteTool(call.name, outcome.data);
      if (!hit?.card) return outcome;
      return attachImpactCardToOutcome(outcome, hit);
    } catch {
      return outcome;
    }
  };

  /**
   * Coalesce all successful writes in a tool batch → one reindex + one open-set merge.
   * Falls back to per-tool enrich when only one write.
   */
  const enrichBatchWritesWithImpact = async (outcomesList) => {
    if (!codeImpact || !Array.isArray(outcomesList)) return outcomesList;
    const writeEntries = [];
    for (let i = 0; i < outcomesList.length; i += 1) {
      const entry = outcomesList[i];
      if (!entry?.call || !entry?.outcome?.ok) continue;
      if (!codeImpactHost.WRITE_TOOLS.has(entry.call.name)) continue;
      writeEntries.push({ index: i, entry });
    }
    if (!writeEntries.length) return outcomesList;
    if (writeEntries.length === 1) {
      const { index, entry } = writeEntries[0];
      const enriched = await enrichWriteOutcomeWithImpact(entry.call, entry.outcome);
      outcomesList[index] = { call: entry.call, outcome: enriched };
      return outcomesList;
    }
    try {
      const paths = [];
      for (const { entry } of writeEntries) {
        const d = entry.outcome.data;
        if (d && typeof d === "object") {
          if (typeof d.path === "string" && d.path) paths.push(d.path);
          if (Array.isArray(d.paths)) {
            for (const p of d.paths) if (typeof p === "string" && p) paths.push(p);
          }
          if (typeof d.restoredPath === "string" && d.restoredPath) {
            paths.push(d.restoredPath);
          }
        }
      }
      if (!paths.length) return outcomesList;
      const hit = await codeImpact.noteWritePaths(paths);
      if (!hit?.card) return outcomesList;
      // Attach same coalesced card to the last write outcome (avoid N×2k cards)
      const last = writeEntries[writeEntries.length - 1];
      outcomesList[last.index] = {
        call: last.entry.call,
        outcome: attachImpactCardToOutcome(last.entry.outcome, hit),
      };
      return outcomesList;
    } catch {
      // fallback per-tool
      for (const { index, entry } of writeEntries) {
        try {
          const enriched = await enrichWriteOutcomeWithImpact(entry.call, entry.outcome);
          outcomesList[index] = { call: entry.call, outcome: enriched };
        } catch {
          /* keep */
        }
      }
      return outcomesList;
    }
  };

  /** Successful read_file of an open obligation path → auto mark seen / close should+info */
  const noteReadFileForImpact = (call, outcome) => {
    if (!codeImpact || !outcome?.ok || call?.name !== "read_file") return;
    try {
      const p =
        (outcome.data && typeof outcome.data === "object" && outcome.data.path) ||
        call?.input?.path ||
        null;
      if (!p || typeof p !== "string") return;
      if (typeof codeImpact.markSeenOnRead === "function") {
        codeImpact.markSeenOnRead(p, { closeBlockers: false });
      } else {
        codeImpact.markReviewed([p]);
      }
    } catch {
      /* best-effort */
    }
  };

  /** Write completed tool outcomes into workingMessages (shared by success + mid-batch abort). */
  const appendToolOutcomes = async (outcomesList) => {
    if (!Array.isArray(outcomesList)) return;
    for (const entry of outcomesList) {
      if (!entry) continue;
      const { call, outcome } = entry;
      if (!call?.id) continue;
      // Skip if this id was already closed (defensive re-entry).
      if (workingMessages.some((m) => m?.role === "tool" && String(m.toolCallId) === String(call.id))) {
        continue;
      }
      const toolDef = getTool(call.name);
      if (outcome?.ok && toolDef && toolDef.isReadOnly === false) {
        // toolContext is the call-site bag; fullToolContext may not exist yet at define-time.
        toolContext?.invalidateContext?.();
      }
      let displayData = outcome?.data;
      // Prefer preformatted impact-enriched text when present on write tools.
      if (
        outcome?.ok &&
        displayData &&
        typeof displayData === "object" &&
        typeof displayData.__impactCard === "string" &&
        !displayData.__toolText
      ) {
        try {
          const core = JSON.stringify({
            path: displayData.path,
            replacements: displayData.replacements,
            matchStrategy: displayData.matchStrategy,
            created: displayData.created,
            bytesWritten: displayData.bytesWritten,
            backup: displayData.backup,
          });
          displayData = {
            ...displayData,
            __toolText: codeImpactHost.appendCardToToolText(core, displayData.__impactCard),
          };
        } catch {
          /* keep raw */
        }
      }
      const toolImages =
        outcome?.ok && displayData && typeof displayData === "object"
          ? extractToolImages(displayData)
          : undefined;
      const toolMsg = {
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome?.ok
          ? await toDisplayContentAsync(displayData, call.name)
          : `Error: ${outcome?.error || "failed"}`,
      };
      if (toolImages?.length) {
        toolMsg.images = toolImages;
        // Provenance marker: adapters may forward only explicitly declared tool
        // attachments, never image-looking metadata recovered from older history.
        toolMsg.toolImagesExplicit = true;
      }
      workingMessages = [...workingMessages, toolMsg];
      if (toolImages?.length) {
        onProgress?.({
          type: "tool_images",
          toolCallId: call.id,
          name: call.name,
          images: toolImages,
        });
      }
      toolCallsInBatch += 1;
      totalToolCalls += 1;
    }
  };

  /** Dispose registered tool side effects when this root run is stopped. */
  const hardKillRuntime = () => {
    if (isSubagent) return null;
    try {
      return require("./tools/registry.cjs").disposeAllToolRuntime();
    } catch {
      return null;
    }
  };

  const stoppedResult = async () => {
    // MultiIDE: dispose shared tool side effects and pending prompts only when no
    // other chat sessions are still running. This session's tools already listen to
    // AbortSignal (bash kills its own children on abort).
    const soleSession = !isSubagent && !chatSessions.hasOtherRunning(sessionId);
    if (!isSubagent && soleSession) {
      rejectAllPending("Stopped by user");
    }
    // Stop registered tool work first, but never interrupt sibling MultiIDE chats.
    const killReport = soleSession ? hardKillRuntime() : { skipped: true, reason: "other_sessions_running" };
    // F-01: never leave assistant.toolCalls without role:"tool" pairs after stop.
    closeOpenToolCalls("Stopped by user");
    // Always end with a clear assistant marker so the next turn has a valid transcript
    // (and disk save includes tools + "[Stopped by user]").
    const text = lastText?.trim()
      ? `${lastText.trim()}\n\n[Stopped by user]`
      : "[Stopped by user]";
    const messages = withAssistantMessage(text);
    try {
      // Persist FULL stopped transcript (with synthetic tool closes + stop marker)
      if (!isSubagent && onMessagesChange) await onMessagesChange(messages);
    } catch {
      // Persist best-effort — still return a valid in-memory transcript.
    }
    return {
      text,
      messages,
      compactionResult,
            usage: usageTotals,
      contextTokens: currentContextTokens() || lastPromptTokens,
      stopped: true,
      killReport: killReport || undefined,
    };
  };

  const providerFailureResult = (error) => {
    error.recoveredMessages = workingMessages;
    error.usage = usageTotals;
    error.contextTokens = currentContextTokens() || lastPromptTokens;
    throw error;
  };

  const accumulateUsage = (usage, estimate) => {
    const effectiveUsage = tokenCountingMode === "auto" || !usage ? estimate : usage;
    if (!effectiveUsage) return null;
    usageTotals.promptTokens += effectiveUsage.promptTokens || 0;
    usageTotals.completionTokens += effectiveUsage.completionTokens || 0;
    usageTotals.totalTokens += effectiveUsage.totalTokens || effectiveUsage.promptTokens + effectiveUsage.completionTokens || 0;
    if (effectiveUsage.promptTokens) lastPromptTokens = effectiveUsage.promptTokens;
    if (effectiveUsage.estimated) usageTotals.estimated = true;
    return effectiveUsage;
  };

  const recordExternalUsage = (usage, estimate) => {
    const effectiveUsage = tokenCountingMode === "auto" || !usage ? estimate : usage;
    trackExternalUsage({ userDataPath, provider, model, usage: effectiveUsage });
  };

  /** Live context ring: emit after each model step and each finished tool (not only at turn end). */
  let lastContextEmitAt = 0;
  let lastEmittedContextTokens = 0;
  const emitContextUsage = (opts = {}) => {
    const estimated =
      typeof opts.estimated === "number"
        ? opts.estimated
        : countMessagesTokens(workingMessages) + systemPromptTokens + toolSchemaTokens;
    const contextTokens = Math.max(lastPromptTokens || 0, estimated || 0);
    if (!contextTokens) return;
    const now = Date.now();
    const force = Boolean(opts.force);
    const delta = Math.abs(contextTokens - lastEmittedContextTokens);
    if (!force && now - lastContextEmitAt < 400 && delta < 256) return;
    lastContextEmitAt = now;
    lastEmittedContextTokens = contextTokens;
    onProgress?.({
      type: "context_usage",
      contextTokens,
      estimated: Boolean(opts.forceEstimated || !lastPromptTokens || tokenCountingMode === "auto"),
    });
  };

  const onRetry = ({ attempt, retries, error }) => {
    onProgress?.({ type: "retry", attempt, maxRetries: retries, reason: error?.message });
  };

  const persistWorkingMessages = async () => {
    // Subagents don't write to the chat session history.
    if (isSubagent) return;
    if (onMessagesChange) await onMessagesChange(workingMessages);
  };

  const compactIfNeeded = async (reason) => {
    const estimatedTokens = countMessagesTokens(workingMessages) + systemPromptTokens + toolSchemaTokens;
    const compactAt = Math.min(compactThreshold, contextLimit);
    const providerPromptTokens = tokenCountingMode === "provider" ? lastPromptTokens : 0;
    const pressure = Math.max(estimatedTokens, providerPromptTokens);
    if (pressure <= compactAt) return false;

    onProgress?.({ type: "compact_start", reason: reason === "auto" ? "auto" : reason });
    try {
      const result = await compactMessages({
        provider,
        model,
        messages: workingMessages,
        keepRecent,
        onRetry,
        tokenCountingMode,
      });
      compactionResult = result;
      workingMessages = result.compactedMessages;
      await persistWorkingMessages();
      accumulateUsage(result.usage);
      onProgress?.({
        type: "compact_end",
        reason: reason === "auto" ? "auto" : reason,
        ok: true,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        removedCount: result.removedCount,
      });
      if (result.tokensAfter) lastPromptTokens = result.tokensAfter;
      emitContextUsage({ estimated: result.tokensAfter || undefined, forceEstimated: true });
      return true;
    } catch (error) {
      onProgress?.({
        type: "compact_end",
        reason: reason === "auto" ? "auto" : reason,
        ok: false,
        error: error?.message || String(error),
      });
      throw error;
    }
  };

  // Subagents may also pause for human ask_user / ask_otp (OTP, choices). Bridge is
  // keyed by toolCallId so parallel subagents can wait independently.
  const askUser = createAskUserHandler({ signal });

  const fullToolContext = {
    ...toolContext,
    modelId: model?.id || toolContext?.modelId || null,
    modelName: model?.name || toolContext?.modelName || null,
    workTimer,
    isSubagent: Boolean(isSubagent),
    // Lets the think tool enforce stricter cycle content while the mode is locked on.
    thinkingMax: Boolean(thinkingMax),
    sessionId: sessionId || toolContext?.sessionId || null,
    chatId: sessionId || toolContext?.chatId || null,
    askUser,
    // Shared code-impact turn session for automatic post-write checks.
    codeImpact: codeImpact || null,
    // Propagate abort so active tool work can stop promptly
    signal,
    compactHistory: async (keepRecent) => {
      // Always pair compact_start with compact_end (success or error).
      onProgress?.({ type: "compact_start", reason: "tool" });
      try {
        const result = await compactMessages({
          provider,
          model,
          messages: workingMessages,
          keepRecent,
          onRetry,
          tokenCountingMode,
          userDataPath,
        });
        compactionResult = result;
        workingMessages = result.compactedMessages;
        await persistWorkingMessages();
        accumulateUsage(result.usage);
        recordExternalUsage(result.usage);
        onProgress?.({
          type: "compact_end",
          reason: "tool",
          ok: true,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          removedCount: result.removedCount,
        });
        return result;
      } catch (error) {
        onProgress?.({
          type: "compact_end",
          reason: "tool",
          ok: false,
          error: error?.message || String(error),
        });
        throw error;
      }
    },
  };

  // Only the root agent can spawn subagents (depth gate also enforced in the handler).
  if (!isSubagent) {
    fullToolContext.spawnSubagent = createSpawnSubagentHandler({
      runAgentLoop,
      provider,
      model,
      toolContext: fullToolContext,
      onProgress,
      signal,
      tokenCountingMode,
      maxContextTokens: contextLimit,
      autoCompactTokens: compactThreshold,
      depth: subagentDepth,
    });
  }

  // Subagents may request up to MAX_SUBAGENT_TOTAL_ITERATIONS (250); root chat stays at 160.
  const iterationCap = isSubagent ? MAX_SUBAGENT_TOTAL_ITERATIONS : MAX_TOTAL_ITERATIONS;
  const iterationLimit = Math.max(
    1,
    Math.min(maxIterations || iterationCap, iterationCap)
  );

  // An active immutable work timer outranks the normal iteration budget. Once it expires,
  // the usual cap applies again and the loop wraps up normally.
  for (
    let iteration = 0;
    iteration < iterationLimit || getWorkTimerStatus(workTimer).active;
    iteration += 1
  ) {
    if (signal?.aborted) return stoppedResult();

    // Re-check token usage before every model call, not just once up front —
    // a long streak of tool calls can grow the context well past the initial estimate.
    await compactIfNeeded("auto");

    if (iteration > 0 && iteration % ITERATIONS_PER_CONTINUE === 0) {
      onProgress?.({ type: "auto_continue", iteration });
      workingMessages = [...workingMessages, { role: "user", content: CONTINUE_NUDGE }];
      await persistWorkingMessages();
    }

    if (toolCallsInBatch >= MAX_TOOL_CALLS_PER_BATCH) {
      onProgress?.({ type: "tool_limit", limit: MAX_TOOL_CALLS_PER_BATCH, attempted: totalToolCalls });
      workingMessages = [...workingMessages, { role: "user", content: CONTINUE_NUDGE }];
      await persistWorkingMessages();
      toolCallsInBatch = 0;
    }

    // Reload custom tool schemas every model step so create/update mid-turn works without restart.
    const toolsChanged = await refreshToolSchemas(false);
    if (toolsChanged) {
      onProgress?.({ type: "tools_refreshed", count: tools.length });
    }
    const conversation = [{ role: "system", content: systemPrompt }, ...workingMessages];
    const promptEstimate = countMessagesTokens(workingMessages) + systemPromptTokens + toolSchemaTokens;
    let result;
    let streamedText = false;
    // In locked mode the first model attempt may ignore the mandatory think tool
    // and draft an answer. Keep that draft private so the corrective retry cannot
    // produce two visible answers. Streaming starts only after a successful think.
    const suppressPreThinkAnswer = thinkingMax && thinkingMaxCycles < THINKING_MAX_REQUIRED_CYCLES;
    // Keep the exact streamed answer. Most adapters also return the complete
    // answer in result.text after the stream closes; without this we render the
    // same content once as deltas and again as a completed assistant message.
    // Declared at loop scope (not inside try) so the suffix logic below can
    // still read it when a provider error short-circuits the try block.
    let streamedContent = "";
    try {
      let pendingTextParts = [];
      let pendingReasoningParts = [];
      let pendingStreamChars = 0;
      let streamFlushTimer = null;
      const flushStreamDelta = () => {
        if (streamFlushTimer) clearTimeout(streamFlushTimer);
        streamFlushTimer = null;
        if (pendingTextParts.length === 0 && pendingReasoningParts.length === 0) return;
        const textDelta = pendingTextParts.length === 1
          ? pendingTextParts[0]
          : pendingTextParts.join("");
        const reasoningDelta = pendingReasoningParts.length === 1
          ? pendingReasoningParts[0]
          : pendingReasoningParts.join("");
        // Native provider reasoning is not rendered unless Thinking-max is
        // explicitly locked. Avoid tokenizing and IPC-forwarding invisible
        // deltas on the normal path.
        if (reasoningDelta && thinkingMax) {
          onProgress?.({
            type: "assistant_thinking",
            phase: "reasoning",
            tokenDelta: countTokens(reasoningDelta),
          });
        }
        if (textDelta && !suppressPreThinkAnswer) {
          onProgress?.({ type: "assistant_text", text: textDelta, delta: true });
          streamedText = true;
          streamedContent += textDelta;
        }
        pendingTextParts = [];
        pendingReasoningParts = [];
        pendingStreamChars = 0;
      };
      result = await adapter.execute({
        provider,
        model,
        messages: conversation,
        tools,
        onRetry,
        signal,
        onDelta: ({ text, reasoning }) => {
          if (text) pendingTextParts.push(text);
          if (reasoning && thinkingMax) pendingReasoningParts.push(reasoning);
          pendingStreamChars += (text?.length || 0) + (thinkingMax ? reasoning?.length || 0 : 0);
          // Preserve instant time-to-first-text, then batch the hot path.
          if (!streamedText && text && !suppressPreThinkAnswer) {
            flushStreamDelta();
          } else if (pendingStreamChars >= STREAM_DELTA_FORCE_CHARS) {
            flushStreamDelta();
          } else if (!streamFlushTimer) {
            streamFlushTimer = setTimeout(flushStreamDelta, STREAM_DELTA_FLUSH_MS);
          }
        },
      });
      if (streamFlushTimer) clearTimeout(streamFlushTimer);
      flushStreamDelta();
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) return stoppedResult();
      providerFailureResult(error);
    }
    const usageEstimate = makeUsageEstimate(promptEstimate, result.text || "");
    accumulateUsage(result.usage, usageEstimate);
    recordExternalUsage(result.usage, usageEstimate);
    if (!result.usage?.promptTokens && promptEstimate) {
      lastPromptTokens = Math.max(lastPromptTokens || 0, promptEstimate);
    }
    // After every model reply (with or without tools) — live context ring
    emitContextUsage({ estimated: lastPromptTokens || promptEstimate });
    if (result.text) lastText = result.text;
    const resultImages =
      Array.isArray(result.images) && result.images.length ? result.images : undefined;
    // Model reasoning/thinking is intentionally NOT pushed to the UI (no think-live block).
    // Adapters still strip <think> tags from saved answer text via normalizeModelOutput.
    // Stream mid-turn narration (tools still coming) and pure final answers into the UI
    // so the chat can paint text as soon as the model returns — not only after disk I/O.
    // A few upstreams return a final text snapshot in addition to deltas. Send
    // only a genuine suffix (or nothing when it exactly matches the streamed text).
    // This keeps final metadata/images visible without duplicating the answer.
    const finalText = result.text || "";
    const finalSuffix = streamedText && finalText.startsWith(streamedContent)
      ? finalText.slice(streamedContent.length)
      : streamedText && finalText === streamedContent
        ? ""
        : streamedText
          ? ""
          : finalText;
    if (!suppressPreThinkAnswer && (finalSuffix || resultImages?.length || result.reasoning)) {
      onProgress?.({
        type: "assistant_text",
        text: finalSuffix,
        images: resultImages,
        reasoning: result.reasoning || "",
        delta: streamedText && Boolean(finalSuffix),
      });
    }

    if (signal?.aborted) return stoppedResult();

    if (!result.toolCalls || result.toolCalls.length === 0) {
      if (thinkingMax && thinkingMaxCycles < THINKING_MAX_REQUIRED_CYCLES) {
        const nextCycle = thinkingMaxCycles + 1;
        const cycleFocus = getCycleDirective(nextCycle);
        workingMessages = [
          ...workingMessages,
          { role: "assistant", content: result.text || "", reasoning_content: result.reasoning || "" },
          {
            role: "user",
            content:
              `Thinking-max is locked ON. Deep-thinking cycle ${nextCycle}/${THINKING_MAX_REQUIRED_CYCLES} is mandatory before any final answer. ` +
              `${cycleFocus} Call the think tool now. Do not answer the user yet. ` +
              "Use the prior cycle and tool evidence; do not merely repeat it.",
          },
        ];
        await persistWorkingMessages();
        continue;
      }
      const workTimerStatus = getWorkTimerStatus(workTimer);
      if (workTimerStatus.active) {
        const nudge = buildWorkTimerNudge(workTimer);
        workingMessages = [
          ...workingMessages,
          { role: "assistant", content: result.text || "", reasoning_content: result.reasoning || "" },
          { role: "user", content: nudge },
        ];
        await persistWorkingMessages();
        emitContextUsage();
        onProgress?.({
          type: "work_timer_nudge",
          remainingSeconds: workTimerStatus.remainingSeconds,
          remainingMinutes: workTimerStatus.remainingMinutes,
        });
        continue;
      }
      // Code-impact: open blockers after writes → inject must_check nudge (capped).
      // Single authority: host nudgeCount; loop counter only mirrors for soft-allow footer.
      if (codeImpact && codeImpactNudgeCount < MAX_CODE_IMPACT_NUDGES) {
        const ci = codeImpact.beforeFinal();
        if (!ci.allowFinal && ci.nudge) {
          codeImpactNudgeCount = Math.max(
            codeImpactNudgeCount + 1,
            codeImpact.state?.nudgeCount || 0
          );
          workingMessages = [
            ...workingMessages,
            { role: "assistant", content: result.text || "", reasoning_content: result.reasoning || "" },
            { role: "user", content: ci.nudge },
          ];
          await persistWorkingMessages();
          emitContextUsage();
          onProgress?.({
            type: "code_impact_nudge",
            openBlockers: ci.openBlockers || 0,
            attempt: codeImpactNudgeCount,
          });
          continue;
        }
        // Soft-allow residual: surface abandoned blockers once in final text
        if (ci.softAllowed && ci.residualNote) {
          const textWithResidual = (result.text ? `${result.text}\n\n` : "") + ci.residualNote;
          emitContextUsage();
          onProgress?.({
            type: "code_impact_soft_allow",
            openBlockers: ci.openBlockers || 0,
          });
          return {
            text: textWithResidual,
            messages: withAssistantMessage(textWithResidual, undefined, result.reasoning),
            compactionResult,
                        usage: usageTotals,
            contextTokens: currentContextTokens() || lastPromptTokens,
          };
        }
      }
      emitContextUsage();
      return {
        text: result.text,
        messages: withAssistantMessage(result.text, resultImages, result.reasoning),
        images: resultImages,
        compactionResult,
                usage: usageTotals,
        contextTokens: currentContextTokens() || lastPromptTokens,
      };
    }
    const normalizedToolCalls = result.toolCalls.map((call, index) => {
      const originalId = call.id || call.name || "call";
      // Always unique across parallel subagents (same iteration/index would otherwise collide
      // and ask_user/ask_otp answers would resolve the wrong waiter).
      const uniq = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
      const newId = `iter-${iteration}-tool-${index}-${originalId}-${uniq}`;
      // Re-key Gemini thought signatures under the id the transcript will use
      try {
        if (call.thoughtSignature || call.thought_signature) {
          const sig = call.thoughtSignature || call.thought_signature;
          const thoughtSigs = require("./proxy/convert/thoughtSignatures.cjs");
          thoughtSigs.remember(newId, sig, {
            name: call.name,
            args: call.input,
          });
          if (call.id) thoughtSigs.remember(call.id, sig, { name: call.name, args: call.input });
        } else if (call.id) {
          const thoughtSigs = require("./proxy/convert/thoughtSignatures.cjs");
          const existing = thoughtSigs.lookupByIdNameArgs(call.id, call.name, call.input);
          if (existing) {
            thoughtSigs.remember(newId, existing, { name: call.name, args: call.input });
            call = { ...call, thoughtSignature: existing };
          }
        }
      } catch {
        /* proxy module optional in some paths */
      }
      return {
        ...call,
        id: newId,
        name: hardNormalizeToolName(call.name, toolsSorted),
      };
    });
    const remainingBatchSlots = Math.max(1, MAX_TOOL_CALLS_PER_BATCH - toolCallsInBatch);
    const toolCalls = normalizedToolCalls.slice(0, remainingBatchSlots);
    if (toolCalls.length < normalizedToolCalls.length) {
      onProgress?.({ type: "tool_limit", limit: MAX_TOOL_CALLS_PER_BATCH, attempted: totalToolCalls + normalizedToolCalls.length });
    }

    workingMessages = [
      ...workingMessages,
      { role: "assistant", content: result.text || "", reasoning_content: result.reasoning || "", toolCalls },
    ];

    // Start the tool batch immediately. Persisting this half-turn first added a
    // synchronous disk round-trip before every call and made proxy tool loops
    // feel stalled; the complete assistant + tool transcript is saved below.
    // Execute tools. spawn_subagent calls in the same batch run in parallel and
    // the parent waits for every one before continuing — so the main agent never
    // "falls through" while subagents are still working.
    const runOneTool = async (call) => {
      const isThink = call.name === "think";
      if (isThink) {
        onProgress?.({
          type: "assistant_thinking",
          phase: "start",
          processId: call.id,
          thinkCycle: Math.min(thinkingMaxCycles + 1, THINKING_MAX_REQUIRED_CYCLES),
          thinkCycleTarget: THINKING_MAX_REQUIRED_CYCLES,
          text: String(call.input?.focus || "Deep reasoning"),
          tokenDelta: countTokens(JSON.stringify(call.input || {})),
        });
      } else {
        onProgress?.({ type: "tool_start", toolCallId: call.id, name: call.name, input: call.input });
      }
      // Pass abort signal so long-running tools can stop immediately
      const callContext = { ...fullToolContext, toolCallId: call.id, signal };
      let outcome;
      try {
        if (signal?.aborted) {
          outcome = { ok: false, error: "Stopped by user", aborted: true };
        } else {
          // Race the tool against abort so Stop does not wait for a stale operation.
          const work = (async () => {
            let o = await dispatch(call.name, call.input, callContext);
            if (!o.ok && /^Unknown tool:/i.test(String(o.error || ""))) {
              const retryName = hardNormalizeToolName(call.name, toolsSorted);
              if (retryName !== call.name) {
                call.name = retryName;
                o = await dispatch(call.name, call.input, callContext);
              }
            }
            return o;
          })();
          const abortWait =
            signal &&
            new Promise((resolve) => {
              if (signal.aborted) {
                resolve({ ok: false, error: "Stopped by user", aborted: true });
                return;
              }
              const onAb = () => {
                try {
                  signal.removeEventListener("abort", onAb);
                } catch {
                  /* */
                }
                resolve({ ok: false, error: "Stopped by user", aborted: true });
              };
              signal.addEventListener("abort", onAb, { once: true });
              // If work finishes first, clean listener via finally on race winner path
              work.finally(() => {
                try {
                  signal.removeEventListener("abort", onAb);
                } catch {
                  /* */
                }
              });
            });
          outcome = abortWait ? await Promise.race([work, abortWait]) : await work;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outcome = {
          ok: false,
          error: msg,
          aborted: error?.name === "AbortError" || signal?.aborted || /Stopped by user/i.test(msg),
        };
      }
      if (isThink) {
        onProgress?.({ type: "assistant_thinking", phase: "end", processId: call.id, ok: outcome.ok });
      } else {
        onProgress?.({
          type: "tool_end",
          toolCallId: call.id,
          name: call.name,
          ok: outcome.ok,
          result: outcome.ok ? outcome.data : outcome.error,
        });
      }
      return { call, outcome };
    };

    const emitContextAfterTools = () => {
      // Growing transcript estimate for the next model call (provider tokens update on next execute)
      emitContextUsage({ forceEstimated: true });
    };

    const outcomes = new Array(toolCalls.length);
    // Preserve dependency order around writes, but run each contiguous group of
    // read-only calls together. Models often emit grep/read/list/web calls in
    // one response; serialising those was needless proxy round-trip latency.
    const readOnlyToolNames = new Set(
      tools.filter((tool) => tool.isReadOnly === true).map((tool) => tool.name)
    );
    const spawnIndices = [];
    for (let i = 0; i < toolCalls.length; i += 1) {
      // Parallel: single spawn + batch (batch is one tool that runs many workers)
      if (
        toolCalls[i].name === "spawn_subagent" ||
        toolCalls[i].name === "spawn_subagent_batch"
      ) {
        spawnIndices.push(i);
      }
    }

    // All spawn_subagent / batch calls in this batch run concurrently (same model).
    // Parent waits for every one before any other tools or the next model step.
    if (spawnIndices.length) {
      const spawnResults = await Promise.all(
        spawnIndices.map(async (index) => {
          const entry = await runOneTool(toolCalls[index]);
          return { index, entry };
        })
      );
      for (const { index, entry } of spawnResults) {
        outcomes[index] = entry;
      }
      if (signal?.aborted) {
        // Flush tools that finished before stop; close the rest as synthetic errors.
        await appendToolOutcomes(outcomes);
        emitContextAfterTools();
        return stoppedResult();
      }
    }

    for (let i = 0; i < toolCalls.length; ) {
      if (
        toolCalls[i].name === "spawn_subagent" ||
        toolCalls[i].name === "spawn_subagent_batch"
      ) {
        i += 1;
        continue;
      }
      if (readOnlyToolNames.has(toolCalls[i].name)) {
        const batch = [];
        while (
          i < toolCalls.length &&
          !spawnIndices.includes(i) &&
          readOnlyToolNames.has(toolCalls[i].name)
        ) {
          batch.push(i);
          i += 1;
        }
        const entries = await Promise.all(batch.map((index) => runOneTool(toolCalls[index])));
        entries.forEach((entry, offset) => {
          outcomes[batch[offset]] = entry;
        });
      } else {
        outcomes[i] = await runOneTool(toolCalls[i]);
        i += 1;
      }
      if (signal?.aborted) {
        await appendToolOutcomes(outcomes);
        emitContextAfterTools();
        return stoppedResult();
      }
    }

    // Enrich successful writes with code_impact (coalesced batch) + credit read_file.
    // A batch is one reasoning round even if the model emitted duplicate think calls.
    // This forces fresh model feedback between the four mandatory perspectives.
    if (
      thinkingMax &&
      outcomes.some((entry) => entry?.call?.name === "think" && entry?.outcome?.ok)
    ) {
      thinkingMaxCycles = Math.min(thinkingMaxCycles + 1, THINKING_MAX_REQUIRED_CYCLES);
    }
    try {
      await enrichBatchWritesWithImpact(outcomes);
    } catch {
      /* keep original outcomes */
    }
    for (const entry of outcomes) {
      if (!entry?.call || !entry?.outcome) continue;
      try {
        noteReadFileForImpact(entry.call, entry.outcome);
      } catch {
        /* */
      }
    }

    // custom_tool add/update/remove/enable/disable → reload catalog for next model step
    // so brand-new tools are callable by name in the same turn without app restart.
    try {
      const customMutated = outcomes.some((entry) => {
        if (!entry?.outcome?.ok || entry?.call?.name !== "custom_tool") return false;
        const action = String(entry?.call?.input?.action || "").toLowerCase();
        return (
          action === "add" ||
          action === "update" ||
          action === "remove" ||
          action === "enable" ||
          action === "disable" ||
          action === "import"
        );
      });
      if (customMutated) {
        const changed = await refreshToolSchemas(true);
        if (changed) onProgress?.({ type: "tools_refreshed", count: tools.length, reason: "custom_tool" });
      }
    } catch {
      /* optional */
    }

    // File-mutating tools can change the project tree / git status —
    // invalidate the cached system prompt so the *next* user turn is fresh.
    await appendToolOutcomes(outcomes);
    // Update context usage after tool results are on the transcript
    emitContextAfterTools();
    await persistWorkingMessages();
    emitContextAfterTools();
  }

  if (signal?.aborted) {
    return stoppedResult();
  }

  // Safety net: never return an empty/dead-end message. Force the model to stop
  // calling tools and produce a real final answer summarizing what happened.
  await compactIfNeeded("auto");
  // Include residual open blockers in wrap-up so max-iteration path does not silent-drop them
  let wrapNudge = WRAP_UP_NUDGE;
  if (codeImpact) {
    try {
      const open = codeImpact.getOpen?.() || [];
      const blockers = open.filter((o) => o.severity === "blocker");
      if (blockers.length) {
        wrapNudge +=
          "\n\n## code_impact open blockers (wrap-up)\n" +
          blockers
            .slice(0, 8)
            .map((o) => `- ${o.path} — ${o.reason}`)
            .join("\n");
      }
    } catch {
      /* */
    }
  }
  const wrapUpMessages = [...workingMessages, { role: "user", content: wrapNudge }];
  const finalConversation = [{ role: "system", content: systemPrompt }, ...wrapUpMessages];
  let finalResult;
  try {
    finalResult = await adapter.execute({
      provider,
      model,
      messages: finalConversation,
      tools: [],
      onRetry,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || signal?.aborted) return stoppedResult();
    providerFailureResult(error);
  }
  accumulateUsage(finalResult.usage);
  recordExternalUsage(finalResult.usage);
  emitContextUsage({ estimated: lastPromptTokens || undefined });
  // finalReasoning intentionally not emitted to UI (no think-live block).
  let finalText = finalResult.text || "Reached the maximum number of steps without a final answer.";
  if (codeImpact) {
    try {
      const ci = codeImpact.beforeFinal();
      if (ci.softAllowed && ci.residualNote) {
        finalText = `${finalText}\n\n${ci.residualNote}`;
      } else if (ci.openBlockers > 0) {
        const open = codeImpact.getOpen?.() || [];
        const blockers = open.filter((o) => o.severity === "blocker").slice(0, 6);
        if (blockers.length) {
          finalText +=
            "\n\n## code_impact residual blockers\n" +
            blockers.map((o) => `- ${o.path} — ${o.reason}`).join("\n");
        }
      }
    } catch {
      /* */
    }
  }
  if (finalText) {
    onProgress?.({ type: "assistant_text", text: finalText });
  }

  return {
    text: finalText,
    messages: [...wrapUpMessages, { role: "assistant", content: finalText }],
    compactionResult,
        usage: usageTotals,
    contextTokens: currentContextTokens() || lastPromptTokens,
  };
}

module.exports = { runAgentLoop };
