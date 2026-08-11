/**
 * Extract model "thinking" / reasoning from API fields or <think> tags in text.
 * Returns { text, reasoning } — text is the user-visible answer without think blocks.
 * (test comment edit)
 */

const THINK_TAG_RE =
  /<\s*(?:think|thinking|redacted_reasoning|reasoning)\s*>([\s\S]*?)<\s*\/\s*(?:think|thinking|redacted_reasoning|reasoning)\s*>/gi;

/**
 * @param {string} raw
 * @returns {{ text: string, reasoning: string }}
 */
function splitThinkTags(raw) {
  const source = String(raw || "");
  if (!source) return { text: "", reasoning: "" };

  const parts = [];
  let text = source.replace(THINK_TAG_RE, (_, inner) => {
    const t = String(inner || "").trim();
    if (t) parts.push(t);
    return "\n";
  });

  // Unclosed trailing <think>... (stream-ish partial)
  const open = text.match(/<\s*(?:think|thinking|redacted_reasoning|reasoning)\s*>([\s\S]*)$/i);
  if (open) {
    const t = String(open[1] || "").trim();
    if (t) parts.push(t);
    text = text.slice(0, open.index);
  }

  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return { text, reasoning: parts.join("\n\n").trim() };
}

/**
 * Merge API reasoning_content / thought fields with optional tags in body text.
 * @param {{ content?: string, reasoning?: string|null }} input
 */
function normalizeModelOutput(input = {}) {
  let content = String(input.content || "");
  let reasoning = String(input.reasoning || "").trim();

  const split = splitThinkTags(content);
  content = split.text;
  if (split.reasoning) {
    reasoning = reasoning ? `${reasoning}\n\n${split.reasoning}` : split.reasoning;
  }

  return {
    text: content,
    reasoning: reasoning || "",
  };
}

module.exports = {
  splitThinkTags,
  normalizeModelOutput,
  THINK_TAG_RE,
};
