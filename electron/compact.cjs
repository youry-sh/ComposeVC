const { getAdapter } = require("./adapters/index.cjs");
const { countMessagesTokens, makeUsageEstimate } = require("./tokenCount.cjs");

// Keep a meaningful live tail outside the summary. Tool-heavy coding turns can
// easily use more than six rows for one user request.
const DEFAULT_KEEP_RECENT = 12;
const MAX_COMPACTION_MESSAGE_CHARS = Object.freeze({
  user: 14_000,
  assistant: 12_000,
  tool: 12_000,
  recent: 18_000,
  previousSummary: 24_000,
});

const COMPACTION_SECTIONS = Object.freeze([
  "CURRENT OBJECTIVE",
  "AUTHORITATIVE USER REQUIREMENTS",
  "STATE AND TIMELINE",
  "DECISIONS AND RATIONALE",
  "IMPLEMENTED CHANGES",
  "FILES, SYMBOLS, AND CONTRACTS",
  "TOOLS, COMMANDS, AND EVIDENCE",
  "ERRORS, FAILED ATTEMPTS, AND FIXES",
  "WORKTREE AND EXTERNAL STATE",
  "OPEN WORK AND BLOCKERS",
  "VERIFICATION STATUS",
  "NEXT CONCRETE ACTION",
  "CONTINUITY INSTRUCTIONS",
]);

const CHAT_COMPACTION_SYSTEM_PROMPT = `You are the durable memory compiler for a coding agent. Convert the source transcript into a high-fidelity continuation checkpoint that another instance can use to resume the work without guessing, repeating completed work, or forgetting how the current state was reached.

This is NOT a brief conversational summary. Completeness, recency, exact technical state, and causal continuity are more important than elegance or brevity.

Preservation rules:
- Treat the user's latest real intent, corrections, acceptance criteria, negative constraints, preferences, and rejected approaches as authoritative. Preserve distinct requirements separately instead of merging them into vague prose.
- Preserve the chronology and cause/effect of recent events with the highest detail: what was requested, inspected, changed, observed, verified, and left unfinished.
- If the transcript contains an earlier "[Conversation summary ...]", it is inherited memory. Merge every still-relevant fact from it into the new checkpoint; never summarize that memory away merely because it is old.
- Preserve exact file paths, symbols, APIs, data flows, schemas, configuration/model choices, IDs, links, commands, tool names, error text, test results, and important values when present.
- Record implemented behavior separately from proposed behavior. Never imply a file was edited, a command passed, or a task completed unless the transcript proves it.
- Preserve failed attempts and their root causes so the next agent does not repeat them. State whether a proposed fix was actually applied and tested.
- Preserve dirty/untracked user changes and external state that must not be overwritten. Distinguish repository facts from assumptions and unresolved questions.
- Store conclusions, decisions, concise rationale, and observable evidence. Do not include hidden chain-of-thought or fabricate missing rationale.
- Omit or redact secrets such as API keys, access tokens, passwords, cookies, and private credentials.
- Do not spend space on greetings, filler, repetitive status updates, or obsolete details unless they explain the current state.
- If a source message contains a truncation marker, explicitly record what may be missing and do not pretend the omitted material was reviewed.

Use these exact Markdown headings in this exact order. Under every heading, write dense, concrete bullets. Write "None known" when a section truly has no information; do not silently omit sections.

## CURRENT OBJECTIVE
## AUTHORITATIVE USER REQUIREMENTS
## STATE AND TIMELINE
## DECISIONS AND RATIONALE
## IMPLEMENTED CHANGES
## FILES, SYMBOLS, AND CONTRACTS
## TOOLS, COMMANDS, AND EVIDENCE
## ERRORS, FAILED ATTEMPTS, AND FIXES
## WORKTREE AND EXTERNAL STATE
## OPEN WORK AND BLOCKERS
## VERIFICATION STATUS
## NEXT CONCRETE ACTION
## CONTINUITY INSTRUCTIONS

The final checkpoint must be self-contained. A future agent should know what to do next, what not to redo, which claims are verified, and which details remain uncertain. Do not add a generic introduction or conclusion.`;

/** Internal continuation nudges — not real user requests. */
const HIDDEN_USER_NUDGES = new Set([
  "Continue exactly where you left off. Keep working autonomously until the task is fully complete, then give the final answer.",
  "You have reached the maximum number of steps for this turn. Stop calling tools now and reply with a clear final summary of everything you completed, and what (if anything) still remains to be done.",
]);

/**
 * Detect synthetic user-role messages injected by the agent loop (continue /
 * memory gate / code_impact). These must never show as chat bubbles
 * or be treated as the "last real user request".
 */
function isInternalAgentNudge(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (HIDDEN_USER_NUDGES.has(t)) return true;
  if (t.startsWith("Continue exactly where you left off.")) return true;
  if (t.startsWith("You have reached the maximum number of steps for this turn.")) return true;
  if (t.startsWith("## code_impact_nudge") || t.startsWith("## code_impact_soft_allow")) return true;
  return false;
}

function messageContentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
          return String(part.text || "");
        }
        if (part.text) return String(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function isRealUserMessage(message) {
  if (!message || message.role !== "user") return false;
  // Multimodal user turns with only images still count as real user input.
  const hasImages =
    (Array.isArray(message.images) && message.images.length > 0) ||
    (Array.isArray(message.content) &&
      message.content.some(
        (p) => p && typeof p === "object" && (p.type === "image_url" || p.type === "image")
      ));
  const text = messageContentToText(message.content).trim();
  if (!text && !hasImages) return false;
  if (text && isInternalAgentNudge(text)) return false;
  return true;
}

/** Drop synthetic agent user-nudges from a transcript (safe for disk + UI history). */
function stripInternalUserNudges(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter((m) => {
    if (!m || m.role !== "user") return true;
    return !isInternalAgentNudge(messageContentToText(m.content));
  });
}

/**
 * Ensure the latest real user request is never dropped by the sliding "keep recent"
 * window (tool-heavy turns often push the user message out of the last N rows).
 */
function ensureLastUserPreserved(messages, recent) {
  const lastUser = [...(messages || [])].reverse().find(isRealUserMessage);
  if (!lastUser) return recent;

  const alreadyInRecent = (recent || []).some(
    (m) =>
      m?.role === "user" &&
      messageContentToText(m.content) === messageContentToText(lastUser.content) &&
      JSON.stringify(m.images || null) === JSON.stringify(lastUser.images || null)
  );
  if (alreadyInRecent) return recent;

  // Put the real user request just before the recent tail so UI/history still shows it.
  const preserved = { role: "user", content: lastUser.content };
  if (Array.isArray(lastUser.images) && lastUser.images.length) preserved.images = lastUser.images;
  return [preserved, ...(recent || [])];
}

function stringifyCompactValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Preserve both the beginning and the outcome/error at the end of long rows. */
function truncateForCompaction(text, maxChars) {
  const value = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, omittedChars: 0 };
  }

  const markerReserve = 140;
  const available = Math.max(200, maxChars - markerReserve);
  const headChars = Math.ceil(available * 0.62);
  const tailChars = Math.max(0, available - headChars);
  const omittedChars = Math.max(0, value.length - headChars - tailChars);
  const marker = `\n\n[COMPACTION SOURCE TRUNCATED: ${omittedChars} characters omitted from the middle of this message]\n\n`;
  return {
    text: `${value.slice(0, headChars)}${marker}${tailChars ? value.slice(-tailChars) : ""}`,
    omittedChars,
  };
}

function isPreviousCompactionSummary(message) {
  if (!message || message.role !== "assistant") return false;
  return /^\s*\[Conversation summary\b/i.test(messageContentToText(message.content));
}

function messageCharBudget(message, index, total) {
  if (isPreviousCompactionSummary(message)) return MAX_COMPACTION_MESSAGE_CHARS.previousSummary;
  // The final eight rows of the summarized range are the most likely bridge into
  // the still-verbatim recent tail, so retain more detail from them.
  if (index >= Math.max(0, total - 8)) return MAX_COMPACTION_MESSAGE_CHARS.recent;
  if (message?.role === "tool") return MAX_COMPACTION_MESSAGE_CHARS.tool;
  if (message?.role === "assistant") return MAX_COMPACTION_MESSAGE_CHARS.assistant;
  return MAX_COMPACTION_MESSAGE_CHARS.user;
}

function formatToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return "";
  return toolCalls
    .map((call, index) => {
      const name = call?.name || "unknown_tool";
      const id = call?.id ? ` id=${call.id}` : "";
      return `TOOL CALL ${index + 1}: ${name}${id}\nINPUT: ${stringifyCompactValue(call?.input || {})}`;
    })
    .join("\n\n");
}

function buildCompactionTranscript(messages) {
  const source = Array.isArray(messages) ? messages : [];
  let truncatedMessages = 0;
  let omittedChars = 0;

  const transcript = source
    .map((message, index) => {
      const role =
        message?.role === "assistant"
          ? "ASSISTANT"
          : message?.role === "tool"
            ? "TOOL"
            : message?.role === "system"
              ? "SYSTEM"
              : "USER";
      const metadata = [];
      if (message?.toolName) metadata.push(`tool=${message.toolName}`);
      if (message?.toolCallId || message?.tool_call_id) {
        metadata.push(`toolCallId=${message.toolCallId || message.tool_call_id}`);
      }
      if (isPreviousCompactionSummary(message)) metadata.push("inherited-memory=true");

      const text = messageContentToText(message?.content);
      const calls = formatToolCalls(message?.toolCalls);
      const combined = [text, calls].filter(Boolean).join("\n\n");
      const truncated = truncateForCompaction(
        combined,
        messageCharBudget(message, index, source.length)
      );
      if (truncated.omittedChars > 0) {
        truncatedMessages += 1;
        omittedChars += truncated.omittedChars;
      }

      const imageCount =
        (Array.isArray(message?.images) ? message.images.length : 0) +
        (Array.isArray(message?.content)
          ? message.content.filter(
              (part) =>
                part &&
                typeof part === "object" &&
                (part.type === "image_url" || part.type === "image" || part.type === "input_image")
            ).length
          : 0);
      if (imageCount) metadata.push(`images=${imageCount} (binary content unavailable to compiler)`);

      const metaSuffix = metadata.length ? ` | ${metadata.join(" | ")}` : "";
      return `--- MESSAGE ${index + 1}/${source.length} | ${role}${metaSuffix} ---\n${truncated.text || "[empty content]"}`;
    })
    .join("\n\n");

  return { transcript, truncatedMessages, omittedChars };
}

/** Adaptive output budget: substantial memory for long chats without padding tiny chats. */
function compactionWordTarget(sourceTokens) {
  const tokens = Number.isFinite(sourceTokens) ? Math.max(0, sourceTokens) : 0;
  return Math.min(2_600, Math.max(900, Math.ceil(tokens * 0.18)));
}

function buildCompactionInstruction(targetWords, transcript, previousDraft, qualityProblems) {
  const repairBlock = previousDraft
    ? `\n\nA previous draft failed the quality gate (${qualityProblems.join("; ")}). Regenerate it from the source transcript. Do not merely polish or shorten the failed draft.\n\n--- FAILED DRAFT ---\n${previousDraft}`
    : "";
  return (
    `Produce the continuation checkpoint from the chronological source transcript below. ` +
    `The available detail budget is approximately ${targetWords} words; this is a capacity target, not a quota. ` +
    `Use less only when the source is genuinely sparse, and never sacrifice concrete continuity merely to be short.\n\n` +
    `--- SOURCE TRANSCRIPT ---\n${transcript}${repairBlock}`
  );
}

function assessCompactionSummary(summary, sourceChars = 0) {
  const value = String(summary || "").trim();
  const normalizedHeadings = new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, "").trim().toUpperCase())
      .filter(Boolean)
  );
  const foundHeadings = COMPACTION_SECTIONS.filter((heading) =>
    normalizedHeadings.has(heading)
  ).length;
  const expectedHeadings = sourceChars < 3_000 ? 3 : sourceChars < 10_000 ? 6 : 9;
  const minimumChars = Math.min(8_000, Math.max(500, Math.floor(sourceChars * 0.04)));
  const problems = [];
  if (!value || value === "(summary unavailable)") problems.push("empty summary");
  if (value.length < minimumChars) {
    problems.push(`only ${value.length} characters; expected at least ${minimumChars}`);
  }
  if (foundHeadings < expectedHeadings) {
    problems.push(`only ${foundHeadings}/${COMPACTION_SECTIONS.length} required headings`);
  }
  return { ok: problems.length === 0, problems, foundHeadings, minimumChars };
}

function resultUsage(result, promptTokens, tokenCountingMode) {
  if (tokenCountingMode === "auto" || !result?.usage) {
    return makeUsageEstimate(promptTokens, result?.text || "");
  }
  return result.usage;
}

function mergeUsage(first, second) {
  if (!first) return second || null;
  if (!second) return first;
  const promptTokens = Number(first.promptTokens || 0) + Number(second.promptTokens || 0);
  const completionTokens = Number(first.completionTokens || 0) + Number(second.completionTokens || 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(first.totalTokens || 0) + Number(second.totalTokens || 0),
    estimated: Boolean(first.estimated || second.estimated),
  };
}

function buildSafetyNetSummary(summary, transcript, qualityProblems) {
  const draft = String(summary || "").trim();
  const sourceExtract = truncateForCompaction(transcript, 14_000).text;
  return `${draft ? `${draft}\n\n` : ""}## COMPACTION QUALITY SAFETY NET\n- The generated checkpoint did not fully pass validation: ${qualityProblems.join("; ")}.\n- The chronological source extract below is retained so recent state is not silently lost.\n\n${sourceExtract}`;
}

async function compactMessages({
  provider,
  model,
  messages,
  keepRecent,
  onRetry,
  tokenCountingMode = "provider",
}) {
  const effectiveKeepRecent = keepRecent && keepRecent > 0 ? keepRecent : DEFAULT_KEEP_RECENT;
  const tokensBefore = countMessagesTokens(messages);

  if (messages.length <= effectiveKeepRecent) {
    return { compactedMessages: messages, tokensBefore, tokensAfter: tokensBefore, removedCount: 0, summary: null, usage: null };
  }

  const splitIndex = messages.length - effectiveKeepRecent;
  const older = messages.slice(0, splitIndex);
  let recent = messages.slice(splitIndex);
  recent = ensureLastUserPreserved(messages, recent);

  const olderTokens = countMessagesTokens(older);
  const { transcript, truncatedMessages, omittedChars } = buildCompactionTranscript(older);
  const targetWords = compactionWordTarget(olderTokens);

  const makeMessages = (previousDraft = "", qualityProblems = []) => [
    { role: "system", content: CHAT_COMPACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildCompactionInstruction(targetWords, transcript, previousDraft, qualityProblems),
    },
  ];
  const summarizationMessages = makeMessages();

  const adapter = getAdapter(provider.type);
  const promptTokens = countMessagesTokens(summarizationMessages);
  let result = await adapter.execute({
    provider,
    model,
    messages: summarizationMessages,
    tools: [],
    onRetry,
  });
  let usage = resultUsage(result, promptTokens, tokenCountingMode);
  let summary = (result.text || "").trim();
  let quality = assessCompactionSummary(summary, transcript.length);
  let repairAttempted = false;

  // Providers occasionally ignore requested structure or return a tiny answer.
  // Retry once with precise feedback, but never let optional repair kill the run.
  if (!quality.ok) {
    repairAttempted = true;
    const repairMessages = makeMessages(summary, quality.problems);
    const repairPromptTokens = countMessagesTokens(repairMessages);
    try {
      const repaired = await adapter.execute({
        provider,
        model,
        messages: repairMessages,
        tools: [],
        onRetry,
      });
      usage = mergeUsage(usage, resultUsage(repaired, repairPromptTokens, tokenCountingMode));
      const repairedSummary = (repaired.text || "").trim();
      const repairedQuality = assessCompactionSummary(repairedSummary, transcript.length);
      const repairIsBetter =
        repairedQuality.ok ||
        repairedQuality.foundHeadings > quality.foundHeadings ||
        (repairedQuality.foundHeadings === quality.foundHeadings &&
          repairedSummary.length > summary.length);
      if (repairIsBetter) {
        result = repaired;
        summary = repairedSummary;
        quality = repairedQuality;
      }
    } catch {
      // The deterministic safety net below still preserves source evidence.
    }
  }

  if (!quality.ok) {
    summary = buildSafetyNetSummary(summary, transcript, quality.problems);
    quality = assessCompactionSummary(summary, transcript.length);
  }

  const compactedMessages = [
    {
      role: "assistant",
      content: `[Conversation summary — ${older.length} earlier messages compacted; continuation checkpoint]\n${summary}`,
    },
    ...recent,
  ];

  const tokensAfter = countMessagesTokens(compactedMessages);

  return {
    compactedMessages,
    tokensBefore,
    tokensAfter,
    removedCount: older.length,
    summary,
    usage,
    quality: {
      ...quality,
      repairAttempted,
      targetWords,
      truncatedMessages,
      omittedChars,
    },
  };
}

module.exports = {
  compactMessages,
  DEFAULT_KEEP_RECENT,
  isInternalAgentNudge,
  isRealUserMessage,
  stripInternalUserNudges,
  ensureLastUserPreserved,
  messageContentToText,
  CHAT_COMPACTION_SYSTEM_PROMPT,
  COMPACTION_SECTIONS,
  truncateForCompaction,
  buildCompactionTranscript,
  compactionWordTarget,
  assessCompactionSummary,
};
