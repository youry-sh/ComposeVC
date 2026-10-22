/**
 * Canonical OpenAI chat.completions shapes used as the proxy hub format.
 * Inspired by OmniRoute's openai helpers (tools, reasoning_content, usage).
 */

const crypto = require("crypto");

function uid(prefix = "chatcmpl") {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (!t || typeof t !== "object") return null;
      // Already OpenAI function tool
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          function: {
            name: String(t.function.name || "").trim(),
            description: t.function.description != null ? String(t.function.description) : "",
            parameters:
              t.function.parameters && typeof t.function.parameters === "object"
                ? t.function.parameters
                : { type: "object", properties: {} },
          },
        };
      }
      // Flat { name, description, parameters|input_schema }
      if (t.name) {
        return {
          type: "function",
          function: {
            name: String(t.name).trim(),
            description: t.description != null ? String(t.description) : "",
            parameters:
              t.parameters ||
              t.input_schema ||
              t.inputSchema || { type: "object", properties: {} },
          },
        };
      }
      return null;
    })
    .filter((t) => t && t.function.name);
}

/**
 * Make a JS string safe for JSON wire formats (Codex/serde_json, etc.).
 * - Drop C0 controls except TAB/LF/CR (nulls + binary junk from browser dumps)
 * - Replace lone UTF-16 surrogates (common after bad slice / CDP / binary pages)
 * Does NOT invent incomplete \u escapes — JSON.stringify never does; this prevents
 * upstream parsers that are stricter about surrogate pairs from 400'ing mid-body.
 */
function sanitizeJsonSafeString(value) {
  if (value == null) return "";
  let s = typeof value === "string" ? value : String(value);
  if (!s) return "";
  // C0 controls except \t (9) \n (10) \r (13)
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) {
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  }
  // Lone surrogates → U+FFFD (avoids "unexpected end of hex escape" / invalid UTF-16 on wire)
  if (/[\uD800-\uDFFF]/.test(s)) {
    let out = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += s[i] + s[i + 1];
          i += 1;
        } else {
          out += "\uFFFD";
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += "\uFFFD";
      } else {
        out += s[i];
      }
    }
    s = out;
  }
  return s;
}

/** Deep-walk objects/arrays and sanitize every string leaf. */
function sanitizeJsonSafeDeep(value, depth = 0) {
  if (depth > 40) return null;
  if (typeof value === "string") return sanitizeJsonSafeString(value);
  if (value == null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : String(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonSafeDeep(v, depth + 1));
  }
  if (typeof value === "object") {
    // Buffers / typed arrays → base64-ish short marker (never dump binary into chat body)
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
      return `[buffer ${value.length} bytes]`;
    }
    if (ArrayBuffer.isView?.(value)) {
      return `[binary ${value.byteLength} bytes]`;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "function" || typeof v === "symbol") continue;
      out[sanitizeJsonSafeString(k)] = sanitizeJsonSafeDeep(v, depth + 1);
    }
    return out;
  }
  return sanitizeJsonSafeString(value);
}

/**
 * JSON.stringify that:
 * 1) sanitizes strings (surrogates/controls)
 * 2) verifies the result re-parses
 * 3) on failure, falls back to a stricter pass
 * Prevents Codex 400: Failed to parse request body … unexpected end of hex escape
 * (typically on input[N].output after browser/tool dumps).
 */
function safeJsonStringify(value) {
  const cleaned = sanitizeJsonSafeDeep(value);
  let text;
  try {
    text = JSON.stringify(cleaned);
  } catch (e) {
    // Circular / BigInt leftovers — last resort: string coerce top-level
    text = JSON.stringify(sanitizeJsonSafeString(String(value)));
  }
  if (typeof text !== "string") text = "null";
  try {
    JSON.parse(text);
    return text;
  } catch {
    // Stricter: strip any remaining non-BMP / weirdness by re-encoding via Buffer utf8
    try {
      const again = JSON.stringify(
        sanitizeJsonSafeDeep(JSON.parse(JSON.stringify(cleaned, (_k, v) => {
          if (typeof v === "string") {
            // Force well-formed UTF-8 round-trip
            return Buffer.from(sanitizeJsonSafeString(v), "utf8").toString("utf8");
          }
          return v;
        })))
      );
      JSON.parse(again);
      return again;
    } catch {
      return JSON.stringify({
        error: "safeJsonStringify_fallback",
        message: "request body could not be serialized cleanly",
      });
    }
  }
}

/**
 * Truncate without splitting a UTF-16 surrogate pair (and never mid-code-unit mess).
 * Used for tool-result caps before they become Responses API function_call_output.output.
 */
function truncateUtf16Safe(text, limit) {
  const s = sanitizeJsonSafeString(text);
  const max = Math.max(0, Number(limit) || 0);
  if (!max || s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  // If last kept unit is a high surrogate, drop it so we don't orphan it.
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, Math.max(0, end));
}

/**
 * Single-pass wire sanitizer: deep-walks the body ONCE and produces a clean
 * clone that is BOTH sanitized (strings, numbers, bigint, buffers) AND stripped
 * of internal keys (STRIP_KEYS unless preserved).
 *
 * This replaces the old pipeline chain
 *   sanitizeJsonSafeDeep → stripWireInternal → safeJsonStringify
 * (three full deep clones of the request body per attempt) with a single
 * clone + one native JSON.stringify — the big-chat hot path is ~2–3× faster
 * and the full raw `_raw` body is never cloned anymore.
 */
function wireSanitize(value, opts = {}, depth = 0) {
  const preserve = opts.preserveKeys || null;
  if (depth > 40) return null;
  if (value == null) return value;
  const t = typeof value;
  if (t === "string") return sanitizeJsonSafeString(value);
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "boolean") return value;
  if (t === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : String(value);
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") {
        out[i] = null;
        continue;
      }
      out[i] = wireSanitize(v, opts, depth + 1);
    }
    return out;
  }
  if (t === "object") {
    // Buffers / typed arrays → short marker (never dump binary into chat body)
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
      return `[buffer ${value.length} bytes]`;
    }
    if (ArrayBuffer.isView?.(value)) {
      return `[binary ${value.byteLength} bytes]`;
    }
    const out = {};
    for (const k of Object.keys(value)) {
      const isInternal = preserve ? !preserve.has(k) && STRIP_KEYS.has(k) : STRIP_KEYS.has(k);
      if (isInternal) continue;
      const v = value[k];
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      out[sanitizeJsonSafeString(k)] = wireSanitize(v, opts, depth + 1);
    }
    return out;
  }
  return sanitizeJsonSafeString(value);
}

/**
 * JSON.stringify the request body with one pass: sanitize + strip internal keys.
 * JSON.stringify can never emit invalid JSON from the sanitized tree, and any
 * remaining throw (pathological case) degrades to a small safe payload.
 */
function wireJsonStringify(value, opts = {}) {
  if (value == null || typeof value !== "object") return JSON.stringify(value ?? null);
  try {
    const text = JSON.stringify(wireSanitize(value, opts));
    return typeof text === "string" ? text : "null";
  } catch {
    return JSON.stringify({
      error: "wireJsonStringify_fallback",
      message: "request body could not be serialized cleanly",
    });
  }
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return sanitizeJsonSafeString(content);
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return sanitizeJsonSafeString(part);
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return sanitizeJsonSafeString(part.text || "");
        if (part.type === "input_text") return sanitizeJsonSafeString(part.text || "");
        if (part.type === "output_text") return sanitizeJsonSafeString(part.text || "");
        // Vision parts intentionally omitted from plain text (use contentParts helpers).
        if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
          return "";
        }
        if (part.text) return sanitizeJsonSafeString(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return sanitizeJsonSafeString(content);
}

/**
 * Flatten multimodal content to text when the upstream wire format cannot carry images.
 * Data-URL images are embedded as text so the request still succeeds.
 */
function flattenContentWithImageFallback(content) {
  try {
    const {
      collectImages,
      imagesToFallbackText,
      contentToText: partsText,
    } = require("../adapters/contentParts.cjs");
    const images = collectImages(content);
    if (!images.length) return partsText(content);
    const text = partsText(content);
    const fb = imagesToFallbackText(images);
    return [text, fb].filter(Boolean).join("\n\n");
  } catch {
    return contentToText(content);
  }
}

function contentHasImages(content) {
  try {
    const { collectImages } = require("../adapters/contentParts.cjs");
    return collectImages(content).length > 0;
  } catch {
    if (!Array.isArray(content)) return false;
    return content.some(
      (p) =>
        p &&
        typeof p === "object" &&
        (p.type === "image_url" || p.type === "image" || p.type === "input_image")
    );
  }
}

/** Normalize inbound OpenAI chat body. */
function repairToolCallHistory(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      if (message?.role !== "tool") out.push(message);
      continue;
    }

    const calls = message.tool_calls.filter((call) => call?.id);
    const following = [];
    let j = i + 1;
    while (j < messages.length && messages[j]?.role === "tool") {
      following.push(messages[j]);
      j += 1;
    }
    const responseIds = new Set(following.map((tool) => String(tool.tool_call_id || "")));
    const matchedCalls = calls.filter((call) => responseIds.has(String(call.id)));
    const matchedIds = new Set(matchedCalls.map((call) => String(call.id)));

    const assistant = { ...message };
    if (matchedCalls.length) {
      assistant.tool_calls = matchedCalls;
      out.push(assistant);
      for (const tool of following) {
        if (matchedIds.has(String(tool.tool_call_id || ""))) out.push(tool);
      }
    } else {
      delete assistant.tool_calls;
      out.push(assistant);
    }
    i = j - 1;
  }
  return out;
}

/**
 * Recursively strip all internal/metadata keys from an object tree.
 * Keeps only the OpenAI chat.completions standard fields so strict Rust
 * serde backends (serde_json + untagged enums) never see unknown keys.
 *
 * Also drops expanded reasoning / thinking fields that are extensions
 * (reasoning_content, reasoning, thinking) unless explicitly requested.
 */
const STRIP_KEYS = new Set([
  "_raw",
  "reasoning_content",
  "reasoning",
  "thinking",
  "images", // stripped here; converters already fold them into content before this runs
]);

function stripInternalKeys(value, depth = 0) {
  if (depth > 40) return null;
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (Array.isArray(value)) return value.map((v) => stripInternalKeys(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (STRIP_KEYS.has(k)) continue;
      if (typeof v === "function" || typeof v === "symbol") continue;
      out[k] = stripInternalKeys(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Remove internal keys from the full chat.completions body before wire serialization. */
function stripWireInternal(body, options = {}) {
  if (!body || typeof body !== "object") return body;
  const preserveKeys = options.preserveKeys || new Set();
  if (Array.isArray(body)) return body.map((value) => stripWireInternal(value, options));
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (STRIP_KEYS.has(k) && !preserveKeys.has(k)) continue;
    out[k] = stripWireInternal(v, options);
  }
  return out;
}

function normalizeOpenAIRequest(body = {}) {
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  // Normalize once — the result is reused, not re-mapped (big-chat hot path).
  const normalized = rawMessages.map((m, idx) => normalizeMessage(m, idx));
  const messages = repairToolCallHistory(normalized);
  const tools = normalizeTools(body.tools);
  const stream = Boolean(body.stream);
  return {
    model: String(body.model || "").trim() || "default",
    messages,
    tools,
    tool_choice: body.tool_choice != null ? body.tool_choice : undefined,
    stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    max_completion_tokens: body.max_completion_tokens,
    stop: body.stop,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
    response_format: body.response_format,
    user: body.user,
    // Thinking / reasoning (OpenAI-compatible extensions)
    reasoning_effort: body.reasoning_effort,
    thinking: body.thinking,
    // Pass-through unknowns for future converters — stripped before wire
    _raw: body,
  };
}

function normalizeMessage(m, msgIndex = 0) {
  if (!m || typeof m !== "object") return { role: "user", content: "" };
  const role = String(m.role || "user");
  const msg = {
    role,
    content: m.content != null ? m.content : "",
  };
  // Preserve parallel images[] so converters can fold them into wire content.
  if (Array.isArray(m.images) && m.images.length) {
    msg.images = m.images;
  }
  if (m.name) msg.name = m.name;
  if (m.tool_call_id || m.toolCallId) msg.tool_call_id = m.tool_call_id || m.toolCallId;
  const rawToolCalls = m.tool_calls || m.toolCalls;
  if (Array.isArray(rawToolCalls)) {
    msg.tool_calls = rawToolCalls.map((tc, i) => {
      const out = {
        // Deterministic fallback id: Date.now() changed the history bytes every
        // turn and broke upstream prefix (prompt) caching on long chats.
        id: tc.id || `call_m${msgIndex}_${i}`,
        type: tc.type || "function",
        function: {
          name: tc.function?.name || tc.name || "",
          arguments:
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      };
      // Preserve Gemini thought signatures (multi-turn tools)
      const sig =
        tc.thought_signature ||
        tc.thoughtSignature ||
        tc.extra_content?.google?.thought_signature ||
        tc.extra_content?.google?.thoughtSignature ||
        tc.function?.thought_signature ||
        tc.function?.thoughtSignature ||
        null;
      if (sig) {
        out.thought_signature = sig;
        out.extra_content = {
          ...(tc.extra_content || {}),
          google: {
            ...(tc.extra_content?.google || {}),
            thought_signature: sig,
          },
        };
      } else if (tc.extra_content) {
        out.extra_content = tc.extra_content;
      }
      return out;
    });
  }
    const reasoning = m.reasoning_content ?? m.reasoning ?? m.thinking;
    if (reasoning != null) msg.reasoning_content = reasoning;
  return msg;
}

function ensureToolCallIds(body) {
  if (!body?.messages) return body;
  for (let i = 0; i < body.messages.length; i++) {
    const msg = body.messages[i];
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    const ids = [];
    let k = 0;
    for (const tc of msg.tool_calls) {
      if (!tc.type) tc.type = "function";
      if (tc.function?.arguments != null && typeof tc.function.arguments !== "string") {
        tc.function.arguments = JSON.stringify(tc.function.arguments);
      }
      // Deterministic (was Date.now()+random → new bytes every turn → cache miss).
      if (!tc.id) tc.id = `call_m${i}_${k}`;
      k++;
      ids.push(tc.id);
    }
    // Link following tool messages by order
    let idx = 0;
    for (let j = i + 1; j < body.messages.length; j++) {
      const later = body.messages[j];
      if (later.role === "assistant") break;
      if (later.role !== "tool") continue;
      if (idx < ids.length && !later.tool_call_id) {
        later.tool_call_id = ids[idx];
      }
      idx++;
    }
  }
  return body;
}

function usageOpenAI(u = {}) {
  const prompt = u.prompt_tokens ?? u.input_tokens ?? u.promptTokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? u.completionTokens ?? 0;
  const out = {
    prompt_tokens: Number(prompt) || 0,
    completion_tokens: Number(completion) || 0,
    total_tokens: Number(u.total_tokens ?? prompt + completion) || 0,
  };
  if (u.prompt_tokens_details) out.prompt_tokens_details = u.prompt_tokens_details;
  if (u.completion_tokens_details) out.completion_tokens_details = u.completion_tokens_details;
  return out;
}

function chatCompletionResponse({
  id,
  model,
  content = "",
  toolCalls = [],
  reasoning = "",
  finishReason = "stop",
  usage = null,
}) {
  // content may be string or multimodal parts (text + image_url) from providers.
  let messageContent = content;
  if (messageContent == null || messageContent === "") {
    messageContent = toolCalls.length ? null : "";
  }
  const message = {
    role: "assistant",
    content: messageContent,
  };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((tc, i) => {
      const out = {
        id: tc.id || `call_${i}`,
        type: "function",
        function: {
          name: tc.name || tc.function?.name || "",
          arguments:
            typeof tc.arguments === "string"
              ? tc.arguments
              : typeof tc.function?.arguments === "string"
                ? tc.function.arguments
                : JSON.stringify(tc.input || tc.function?.arguments || {}),
        },
      };
      const sig =
        tc.thoughtSignature ||
        tc.thought_signature ||
        tc.extra_content?.google?.thought_signature ||
        null;
      if (sig) {
        out.thought_signature = sig;
        out.extra_content = { google: { thought_signature: sig } };
      }
      return out;
    });
  }
  return {
    id: id || uid(),
    object: "chat.completion",
    created: nowSec(),
    model: model || "default",
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : finishReason,
        logprobs: null,
      },
    ],
    usage: usage ? usageOpenAI(usage) : usageOpenAI({}),
  };
}

function chatChunk({ id, model, delta, finishReason = null, usage = null }) {
  const chunk = {
    id: id || uid(),
    object: "chat.completion.chunk",
    created: nowSec(),
    model: model || "default",
    choices: [
      {
        index: 0,
        delta: delta || {},
        finish_reason: finishReason,
      },
    ],
  };
  if (usage) chunk.usage = usageOpenAI(usage);
  return chunk;
}

module.exports = {
  uid,
  nowSec,
  normalizeTools,
  contentToText,
  flattenContentWithImageFallback,
  contentHasImages,
  normalizeOpenAIRequest,
  normalizeMessage,
  ensureToolCallIds,
  usageOpenAI,
  chatCompletionResponse,
  chatChunk,
  sanitizeJsonSafeString,
  sanitizeJsonSafeDeep,
  safeJsonStringify,
  wireSanitize,
  wireJsonStringify,
  truncateUtf16Safe,
  stripWireInternal,
  stripInternalKeys,
};
