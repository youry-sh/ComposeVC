/**
 * OpenAI chat.completions request → Anthropic Messages API.
 * Patterns from OmniRoute openai-to-claude (tools, tool_result adjacency, thinking).
 */

const { contentToText } = require("../openaiFormat.cjs");
const {
  openaiToolsToAnthropic,
  openaiToolChoiceToAnthropic,
  safeParseJSON,
} = require("./tools.cjs");
const { reasoningEffortToBudget } = require("./thinking.cjs");
const {
  openAIContentToAnthropicBlocks,
  toOpenAIMessageContent,
  modelSupportsImages,
} = require("../../adapters/contentParts.cjs");

function openaiToAnthropicRequest(openaiBody, opts = {}) {
  const model = opts.upstreamModel || openaiBody.model;
  const stream = Boolean(openaiBody.stream);
  const supportImages =
    opts.supportImages != null
      ? Boolean(opts.supportImages)
      : modelSupportsImages(model, "anthropic");

  const systemParts = [];
  const messages = [];

  for (const m of openaiBody.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = contentToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }

    if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id || m.toolCallId || "",
            content: contentToText(m.content) || "",
          },
        ],
      });
      continue;
    }

    if (m.role === "assistant") {
      const blocks = [];
      if (m.reasoning_content) {
        blocks.push({ type: "thinking", thinking: String(m.reasoning_content) });
      }
      const text = contentToText(m.content);
      if (text) blocks.push({ type: "text", text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeParseJSON(tc.function?.arguments, {}),
          });
        }
      }
      messages.push({
        role: "assistant",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }

    // user (and unknown) — multimodal image blocks when supported
    // Normalize content + optional message.images[] into OpenAI parts first.
    const openaiContent = toOpenAIMessageContent(m, { supportImages });
    messages.push({
      role: "user",
      content: openAIContentToAnthropicBlocks(openaiContent, { supportImages }),
    });
  }

  // Merge consecutive same-role messages (Anthropic requirement for tool_result)
  const merged = mergeAdjacentRoles(messages);

  const maxTokens =
    Number(openaiBody.max_tokens || openaiBody.max_completion_tokens || 4096) || 4096;

  const result = {
    model,
    max_tokens: maxTokens,
    stream,
    messages: merged,
  };

  if (systemParts.length) {
    result.system = systemParts.join("\n\n");
  }

  const tools = openaiToolsToAnthropic(openaiBody.tools);
  if (tools.length) {
    result.tools = tools;
    result.tool_choice = openaiToolChoiceToAnthropic(openaiBody.tool_choice);
  }

  // Extended thinking
  const budget =
    openaiBody.thinking?.budget_tokens ||
    reasoningEffortToBudget(openaiBody.reasoning_effort);
  if (budget || openaiBody.thinking) {
    result.thinking = {
      type: "enabled",
      budget_tokens: Number(budget) || 8192,
    };
    // Anthropic rejects temperature with thinking
    delete result.temperature;
  } else if (openaiBody.temperature != null) {
    result.temperature = openaiBody.temperature;
  }

  if (openaiBody.top_p != null && !result.thinking) {
    result.top_p = openaiBody.top_p;
  }

  return result;
}

function mergeAdjacentRoles(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      const a = Array.isArray(last.content)
        ? last.content
        : [{ type: "text", text: String(last.content || "") }];
      const b = Array.isArray(m.content)
        ? m.content
        : [{ type: "text", text: String(m.content || "") }];
      last.content = [...a, ...b];
    } else {
      out.push({
        role: m.role,
        content: m.content,
      });
    }
  }
  // Strip empty text blocks
  for (const m of out) {
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((b) => {
        if (b?.type === "text" && (b.text === "" || b.text == null)) return false;
        return true;
      });
      if (!m.content.length) m.content = [{ type: "text", text: "(empty)" }];
    }
  }
  return out;
}

module.exports = { openaiToAnthropicRequest, mergeAdjacentRoles };
