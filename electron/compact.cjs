const { getAdapter } = require("./adapters/index.cjs");
const { countMessagesTokens, makeUsageEstimate } = require("./tokenCount.cjs");

const DEFAULT_KEEP_RECENT = 6;

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

  const transcript = older
    .map((message) => {
      const role =
        message.role === "assistant"
          ? "ASSISTANT"
          : message.role === "tool"
            ? "TOOL"
            : "USER";
      const body = messageContentToText(message.content).slice(0, 4000);
      const imgNote =
        Array.isArray(message.images) && message.images.length
          ? ` [${message.images.length} image(s)]`
          : Array.isArray(message.content) &&
              message.content.some((p) => p && p.type === "image_url")
            ? " [image(s)]"
            : "";
      return `${role}: ${body}${imgNote}`;
    })
    .join("\n\n");

  const summarizationMessages = [
    {
      role: "system",
      content:
        "You are an emergency chat-memory compiler for a coding agent (blocking compact path). " +
        "Compress the transcript into DENSE structured technical memory — not an essay. " +
        "Preserve: user goals, decisions, file paths, symbols, shell commands, errors + fixes, tools used, " +
        "open/unfinished tasks, constraints, ids/links. Omit secrets (API keys, tokens, passwords). " +
        "Prefer this layout:\n\n" +
        "GOAL:\n...\n\nDECISIONS:\n...\n\nPATHS:\n...\n\nCOMMANDS:\n...\n\nERRORS/FIXES:\n...\n\nTOOLS:\n...\n\nOPEN:\n...\n\nCONSTRAINTS:\n...\n\nCONTINUITY:\n...\n\n" +
        "Dense bullets. Max ~800 words. No chain-of-thought.",
    },
    { role: "user", content: transcript },
  ];

  const adapter = getAdapter(provider.type);
  const promptTokens = countMessagesTokens(summarizationMessages);
  const result = await adapter.execute({ provider, model, messages: summarizationMessages, tools: [], onRetry });
  const summary = (result.text || "").trim() || "(summary unavailable)";

  const compactedMessages = [
    { role: "assistant", content: `[Conversation summary — ${older.length} earlier messages compacted]\n${summary}` },
    ...recent,
  ];

  const tokensAfter = countMessagesTokens(compactedMessages);

  const usage = tokenCountingMode === "auto" || !result.usage ? makeUsageEstimate(promptTokens, result.text || "") : result.usage;
  return { compactedMessages, tokensBefore, tokensAfter, removedCount: older.length, summary, usage };
}

module.exports = {
  compactMessages,
  DEFAULT_KEEP_RECENT,
  isInternalAgentNudge,
  isRealUserMessage,
  stripInternalUserNudges,
  ensureLastUserPreserved,
  messageContentToText,
};
