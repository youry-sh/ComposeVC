const { readResponseEvents, fetchWithRetry } = require("./utils.cjs");
const { normalizeToolName: normalizeRegisteredToolName } = require("../tools/registry.cjs");
const { normalizeModelOutput } = require("./thinking.cjs");
const {
  toOpenAIMessageContent,
  modelSupportsImages,
  extractAssistantImages,
} = require("./contentParts.cjs");

function repairLooseJson(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  // Strip markdown fences some proxies/models wrap around tool args.
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

/**
 * Models often under-escape Windows paths in tool-call JSON:
 *   "C:\tools\bin"  → JSON \t/\b become TAB/BACKSPACE, or parse fails on \g/\U.
 * Only repair when control char sits after drive/letter/slash (path context),
 * not after a digit (read_file "12\\tcode") or bare indent tabs.
 */
function repairWindowsPathControlChars(str) {
  if (typeof str !== "string" || !str) return str;
  if (!/[\t\b\f]/.test(str)) return str;
  return str
    .replace(/([A-Za-z:\\/])\t(?=[A-Za-z0-9_.])/g, "$1\\t")
    .replace(/([A-Za-z0-9_.:\\/])\x08(?=[A-Za-z0-9_.])/g, "$1\\b")
    .replace(/([A-Za-z0-9_.:\\/])\f(?=[A-Za-z0-9_.])/g, "$1\\f");
}

/**
 * Unescape a JSON string body (content between quotes) from broken/under-escaped
 * model output. Keeps Windows path backslashes; only treats \n/\r/\t/\b/\f as
 * controls when they are not clearly path segments (e.g. \tools, \bin).
 */
function unescapeModelJsonString(rawInner) {
  let out = "";
  for (let i = 0; i < rawInner.length; i += 1) {
    const ch = rawInner[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = rawInner[i + 1];
    if (next == null) {
      out += "\\";
      break;
    }
    if (next === "n") {
      out += "\n";
      i += 1;
      continue;
    }
    if (next === "r") {
      out += "\r";
      i += 1;
      continue;
    }
    if (next === '"' || next === "\\" || next === "/") {
      out += next;
      i += 1;
      continue;
    }
    if (next === "t" || next === "b" || next === "f") {
      const following = rawInner[i + 2];
      // \tools \bin \foo → keep literal backslash (Windows path), not control char
      if (following && /[A-Za-z0-9_.]/.test(following)) {
        out += `\\${next}`;
        i += 1;
        continue;
      }
      out += next === "t" ? "\t" : next === "b" ? "\b" : "\f";
      i += 1;
      continue;
    }
    if (next === "u" && /^[0-9a-fA-F]{4}/.test(rawInner.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(rawInner.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    // Unknown escape (\U, \g, \%, etc.) — model meant a literal path separator
    out += `\\${next}`;
    i += 1;
  }
  return out;
}

function repairToolArgStrings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "string") {
      obj[key] = repairWindowsPathControlChars(obj[key]);
    }
  }
  return obj;
}

function safeParseJson(text) {
  if (text && typeof text === "object") return repairToolArgStrings(text);
  if (!text) return {};
  if (typeof text !== "string") return {};
  const attempts = [text, repairLooseJson(text)];
  const firstObject = extractFirstJsonObject(text);
  if (firstObject) attempts.push(firstObject, repairLooseJson(firstObject));
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return repairToolArgStrings(JSON.parse(candidate));
    } catch {
      /* try next */
    }
  }
  // Last resort: recover common edit_file / path keys from broken JSON so a
  // partial tool call can still run (fast models sometimes mangle escapes).
  const recovered = recoverToolArgsFromBrokenJson(text);
  return recovered ? repairToolArgStrings(recovered) : {};
}

function recoverToolArgsFromBrokenJson(text) {
  if (!text || typeof text !== "string") return null;
  const out = {};
  const grab = (keys) => {
    for (const key of keys) {
      // "key": "value" with possible unescaped newlines — take until next ","key" or end brace
      const re = new RegExp(
        `["']${key}["']\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|(?:[\\s\\S]*?)(?=,\\s*["']\\w+["']\\s*:|\\s*}))`,
        "i"
      );
      const m = text.match(re);
      if (!m) continue;
      let raw = m[1].trim();
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          return repairWindowsPathControlChars(JSON.parse(raw));
        } catch {
          return unescapeModelJsonString(raw.slice(1, -1));
        }
      }
      if ((raw.startsWith('"') && !raw.endsWith('"')) || raw.includes("\n")) {
        // Truncated / raw multiline string — strip surrounding quotes if present
        if (raw.startsWith('"')) raw = raw.slice(1);
        if (raw.endsWith('"')) raw = raw.slice(0, -1);
        return unescapeModelJsonString(raw);
      }
      if (raw === "true") return true;
      if (raw === "false") return false;
      return raw;
    }
    return undefined;
  };
  const path = grab(["path", "filePath", "file_path", "filepath", "filename", "file"]);
  const old_string = grab(["old_string", "oldString", "old", "old_text", "before", "search"]);
  const new_string = grab(["new_string", "newString", "new", "new_text", "after", "replace", "replacement"]);
  const replace_all = grab(["replace_all", "replaceAll"]);
  if (path != null) out.path = path;
  if (old_string != null) out.old_string = old_string;
  if (new_string != null) out.new_string = new_string;
  if (replace_all != null) out.replace_all = replace_all === true || replace_all === "true";
  return Object.keys(out).length ? out : null;
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function mergeToolArguments(existing, value) {
  if (value == null) return;
  if (typeof value === "string") {
    existing.arguments += value;
    return;
  }
  if (typeof value === "object") {
    existing.input = { ...(existing.input || {}), ...value };
  }
}

function normalizeToolName(name, tools) {
  const normalized = normalizeRegisteredToolName(name);
  if (!tools?.length) return normalized;
  const exists = tools.find((tool) => tool.name === normalized);
  return exists ? normalized : name;
}

function normalizeToolHistory(messages) {
  const out = [];
  for (let i = 0; i < (messages || []).length; i += 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.toolCalls)) {
      if (message?.role !== "tool") out.push(message);
      continue;
    }
    const tools = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      tools.push(messages[j]);
      j += 1;
    }
    const ids = new Set(tools.map((tool) => String(tool.toolCallId || tool.tool_call_id || "")));
    const calls = message.toolCalls.filter((call) => call?.id && ids.has(String(call.id)));
    const callIds = new Set(calls.map((call) => String(call.id)));
    const assistant = { ...message };
    if (calls.length) {
      assistant.toolCalls = calls;
      out.push(assistant);
      for (const tool of tools) {
        const id = String(tool.toolCallId || tool.tool_call_id || "");
        if (callIds.has(id)) out.push(tool);
      }
    } else {
      delete assistant.toolCalls;
      out.push(assistant);
    }
    i = j - 1;
  }
  return out;
}

/**
 * Responses/Codex rejects overgrown tool-result turns as opaque 500s rather than
 * returning a context-limit error. Preserve the newest material but cap any one
 * tool output before it is serialized into the provider request. The full result
 * remains on disk in the chat transcript; this only bounds the wire payload.
 */
const MAX_TOOL_RESULT_CHARS_FOR_UPSTREAM = 12_000;

function truncateToolResultForUpstream(content) {
  if (typeof content !== "string" || content.length <= MAX_TOOL_RESULT_CHARS_FOR_UPSTREAM) {
    return content;
  }
  const omitted = content.length - MAX_TOOL_RESULT_CHARS_FOR_UPSTREAM;
  return `${content.slice(0, MAX_TOOL_RESULT_CHARS_FOR_UPSTREAM)}\n\n[Tool output truncated for upstream context; ${omitted} characters omitted. Read the relevant file or rerun the tool for more.]`;
}

function buildPayload({ model, messages, tools }) {
  const modelName = String(model?.name || model?.id || "");
  const supportImages = modelSupportsImages(modelName, "openai");
  const { collectImages } = require("./contentParts.cjs");
  const normalizedMessages = normalizeToolHistory(messages || []);
  const outMessages = [];
  const pendingToolImages = [];
  const flushToolImages = () => {
    if (!pendingToolImages.length) return;
    outMessages.push(...pendingToolImages.splice(0));
  };
  for (const message of normalizedMessages) {
    if (message.role !== "tool") {
      flushToolImages();
      if (message.role === "assistant" && message.toolCalls?.length) {
        const assistantMessage = {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: normalizeRegisteredToolName(call.name),
              arguments: JSON.stringify(call.input || {}),
            },
          })),
        };
        const reasoning1 = message.reasoning_content ?? message.reasoning ?? message.thinking;
        if (reasoning1 != null) assistantMessage.reasoning_content = String(reasoning1);
        outMessages.push(assistantMessage);
        continue;
      }
      const assistantMessage = {
        role: message.role,
        content: toOpenAIMessageContent(message, { supportImages }) ||
          (message.role === "assistant" ? " " : ""),
      };
      const reasoning2 = message.reasoning_content ?? message.reasoning ?? message.thinking;
      if (reasoning2 != null) assistantMessage.reasoning_content = String(reasoning2);
      outMessages.push(assistantMessage);
      continue;
    }

    let toolContent = message.content;
    try {
      const { sanitizeJsonSafeString } = require("../proxy/openaiFormat.cjs");
      if (typeof toolContent === "string") toolContent = sanitizeJsonSafeString(toolContent);
      else if (toolContent != null) toolContent = sanitizeJsonSafeString(String(toolContent));
    } catch {
      if (toolContent != null && typeof toolContent !== "string") toolContent = String(toolContent);
    }
    // Tool results are text-only unless the current runtime explicitly marked a
    // reserved __image/__images output. This blocks web metadata and legacy chat
    // artifacts from becoming synthetic user images with dead remote URLs.
    const images = supportImages && message.toolImagesExplicit ? collectImages(message) : [];
    outMessages.push({
      role: "tool",
      tool_call_id: message.toolCallId || message.tool_call_id,
      content: truncateToolResultForUpstream(toolContent == null ? "" : toolContent),
    });
    if (images.length) {
      const parts = [{
        type: "text",
        text: `[tool image: ${message.toolName || "tool"} / ${message.toolCallId || message.tool_call_id || ""}]`,
      }];
      for (const img of images) parts.push({ type: "image_url", image_url: { url: img.url } });
      pendingToolImages.push({ role: "user", content: parts });
    }
  }
  flushToolImages();
  const payload = {
    model: modelName,
    stream: true,
    messages: outMessages,
  };

  if (tools && tools.length) {
    payload.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  // Ask reasoning models (Grok / o-series) for a readable think trace.
  // Local proxy maps this → Responses API { reasoning: { effort, summary } }.
  const m = modelName.toLowerCase();
  if (
    m.includes("grok") ||
    m.includes("o3") ||
    m.includes("o4") ||
    /(^|[^a-z])o1([^a-z]|$)/.test(m) ||
    m.includes("reason")
  ) {
    if (payload.reasoning_effort == null) payload.reasoning_effort = "high";
  }

  return payload;
}

function extractText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

async function execute({ provider, model, messages, tools, onRetry, signal, onDelta }) {
  const base = provider.baseUrl.replace(/\/$/, "");
  const url = base.includes("/chat/completions")
    ? base
    : base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;

  const response = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(buildPayload({ model, messages, tools })),
      signal,
    },
    { providerName: "OpenAI", onRetry }
  );

  let content = "";
  let reasoning = "";
  let usage = null;
  const toolCallsMap = new Map();
  // Keep raw multimodal parts so extractAssistantImages can recover image_url blocks
  // (extractText collapses content to plain text only).
  const rawImageSources = [];

  // OpenAI-compatible gateways occasionally append a full `choice.message` after
  // ordinary delta chunks. Treat message content as a snapshot, not another delta,
  // otherwise both the adapter result and the live renderer repeat the whole answer.
  const appendContent = (value, { snapshot = false } = {}) => {
    const text = extractText(value);
    if (!text) return "";
    if (!snapshot) {
      content += text;
      return text;
    }
    if (text === content || content.startsWith(text)) return "";
    if (text.startsWith(content)) {
      const suffix = text.slice(content.length);
      content = text;
      return suffix;
    }
    content += text;
    return text;
  };

  const consumeChunk = (chunk) => {
    const choice = chunk.choices?.[0];
    const message = choice?.message;
    const delta = choice?.delta;

    let messageText = "";
    const messageContentText = message?.content ? extractText(message.content) : "";
    if (message?.content) {
      if (Array.isArray(message.content)) rawImageSources.push(...message.content);
      messageText = appendContent(message.content, { snapshot: true });
    }
    let deltaText = "";
    if (delta?.content) {
      if (Array.isArray(delta.content)) rawImageSources.push(...delta.content);
      const rawDeltaText = extractText(delta.content);
      // Some OpenAI-compatible proxies put both a full `message` snapshot and
      // the matching `delta` in the same SSE event. The snapshot is authoritative;
      // appending that delta too duplicates the answer in both proxy clients and chat.
      // Preserve a genuine suffix for the less common snapshot+new-delta shape.
      if (!messageContentText || !rawDeltaText || !messageContentText.endsWith(rawDeltaText)) {
        deltaText = appendContent(delta.content);
      }
    }
    // Ephemeral reasoning for live UI only (not persisted into assistant text).
    const msgReason =
      message?.reasoning_content ||
      message?.reasoning ||
      message?.thinking ||
      (typeof message?.reasoning === "object" && message?.reasoning?.content) ||
      "";
    const deltaReason =
      delta?.reasoning_content ||
      delta?.reasoning ||
      delta?.thinking ||
      (typeof delta?.reasoning === "object" && delta?.reasoning?.content) ||
      "";
    if (msgReason) reasoning += extractText(msgReason);
    if (deltaReason) reasoning += extractText(deltaReason);

    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens || 0,
        completionTokens: chunk.usage.completion_tokens || 0,
        totalTokens: chunk.usage.total_tokens || 0,
      };
    }

    const toolCallsSource = message?.tool_calls || delta?.tool_calls;
    if (toolCallsSource) {
      for (const call of toolCallsSource) {
        const index = call.index ?? 0;
        const existing = toolCallsMap.get(index) || {
          id: call.id,
          name: "",
          arguments: "",
          input: null,
          thoughtSignature: null,
        };
        if (call.id) existing.id = call.id;
        if (call.function?.name && !existing.name) existing.name = call.function.name;
        const sig =
          call.thought_signature ||
          call.thoughtSignature ||
          call.extra_content?.google?.thought_signature ||
          call.extra_content?.google?.thoughtSignature ||
          null;
        if (sig) existing.thoughtSignature = sig;
        mergeToolArguments(
          existing,
          call.function?.arguments ?? call.function?.input ?? call.input ?? call.arguments
        );
        toolCallsMap.set(index, existing);
      }
    }

    const textDelta = messageText + deltaText;
    const reasoningDelta = extractText(deltaReason);
    if (textDelta || reasoningDelta) {
      onDelta?.({ text: textDelta, reasoning: reasoningDelta });
    }
  };

  await readResponseEvents(response, "OpenAI", consumeChunk);

  const toolCalls = Array.from(toolCallsMap.values())
    .filter((call) => call.name)
    .map((call) => {
      const out = {
        id: call.id,
        name: normalizeToolName(call.name, tools),
        input: call.input || safeParseJson(call.arguments),
      };
      if (call.thoughtSignature) out.thoughtSignature = call.thoughtSignature;
      return out;
    });

  // Strip <think>/reasoning tags from content; reasoning is ephemeral for live UI only.
  const normalized = normalizeModelOutput({ content, reasoning });
  // Capture any image parts the provider returned (multimodal assistant content).
  let images = [];
  try {
    images = extractAssistantImages(rawImageSources.length ? rawImageSources : content);
  } catch {
    images = [];
  }
  return {
    text: normalized.text,
    reasoning: normalized.reasoning || "",
    toolCalls,
    usage,
    images: images.length ? images : undefined,
  };
}

module.exports = {
  buildPayload,
  execute,
  // Exported for unit tests / recovery diagnostics (agent runtime only needs buildPayload+execute).
  safeParseJson,
  recoverToolArgsFromBrokenJson,
  repairWindowsPathControlChars,
  unescapeModelJsonString,
};
