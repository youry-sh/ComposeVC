const { countTokens: rawCountTokens } = require("gpt-tokenizer");

function countTokens(text) {
  const value = text == null ? "" : String(text);
  try {
    return rawCountTokens(value, { disallowedSpecial: new Set() });
  } catch {
    try {
      return rawCountTokens(value);
    } catch {
      return Math.ceil(value.length / 4);
    }
  }
}

const MESSAGE_OVERHEAD_TOKENS = 4;
const REPLY_PRIMING_TOKENS = 3;
const TOOL_SCHEMA_OVERHEAD_TOKENS = 8;
const messageTokenCache = new WeakMap();
const toolSchemaTokenCache = new WeakMap();

function stringifyForTokens(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function contentTextForTokens(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyForTokens(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return "";
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return String(part.text || "");
      }
      return part.text ? String(part.text) : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Rough vision surcharge: fixed per-image estimate without tokenizing base64. */
function countImageTokens(imagesOrContent) {
  let total = 0;
  const addUrl = (url) => {
    const u = String(url || "");
    if (!u) return;
    total += 85;
  };
  if (Array.isArray(imagesOrContent)) {
    for (const img of imagesOrContent) {
      if (!img) continue;
      if (typeof img === "string") addUrl(img);
      else if (img.type === "image_url") addUrl(img.image_url?.url || img.url);
      else if (img.type === "image" || img.type === "input_image") {
        addUrl(img.image_url || img.url || "");
      } else {
        addUrl(img.url || img.dataUrl || img.src || "");
      }
    }
  }
  return total;
}

function countMessageTokens(message) {
  if (!message) return MESSAGE_OVERHEAD_TOKENS;
  const cached = messageTokenCache.get(message);
  if (cached !== undefined) return cached;
  let total = MESSAGE_OVERHEAD_TOKENS + countTokens(contentTextForTokens(message.content));
  if (Array.isArray(message.content)) {
    total += countImageTokens(message.content);
  }
  if (Array.isArray(message.images) && message.images.length) {
    total += countImageTokens(message.images);
  }
  if (message.role) total += countTokens(message.role);
  if (message.toolCallId) total += countTokens(message.toolCallId);
  if (message.toolName) total += countTokens(message.toolName);
  for (const call of message.toolCalls || []) {
    total += TOOL_SCHEMA_OVERHEAD_TOKENS;
    total += countTokens(call.id || "");
    total += countTokens(call.name || "");
    total += countTokens(stringifyForTokens(call.input || {}));
  }
  messageTokenCache.set(message, total);
  return total;
}

function countMessagesTokens(messages) {
  const total = (messages || []).reduce((sum, message) => sum + countMessageTokens(message), 0);
  return total + REPLY_PRIMING_TOKENS;
}

function countToolSchemaTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  const cached = toolSchemaTokenCache.get(tools);
  if (cached !== undefined) return cached;
  const total = tools.reduce((sum, tool) => {
    return sum + TOOL_SCHEMA_OVERHEAD_TOKENS + countTokens(tool.name || "") + countTokens(tool.description || "") + countTokens(stringifyForTokens(tool.inputSchema || {}));
  }, 0);
  toolSchemaTokenCache.set(tools, total);
  return total;
}

function estimatePromptTokens({ messages, systemPrompt = "", tools = [] } = {}) {
  return countMessagesTokens(messages || []) + countTokens(systemPrompt || "") + countToolSchemaTokens(tools);
}

function makeUsageEstimate(promptTokens, completionText = "") {
  const completionTokens = countTokens(completionText || "");
  return {
    promptTokens: promptTokens || 0,
    completionTokens,
    totalTokens: (promptTokens || 0) + completionTokens,
    estimated: true,
  };
}

module.exports = { countTokens, countMessageTokens, countMessagesTokens, countToolSchemaTokens, estimatePromptTokens, makeUsageEstimate };
