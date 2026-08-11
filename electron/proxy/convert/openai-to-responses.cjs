/**
 * OpenAI Chat Completions → OpenAI Responses API (Codex /chatgpt.com backend).
 * Simplified from OmniRoute openai-responses/toResponses.
 */

const {
  contentToText,
  sanitizeJsonSafeString,
  sanitizeJsonSafeDeep,
} = require("../openaiFormat.cjs");
const { safeParseJSON } = require("./tools.cjs");
const {
  openAIContentToResponsesParts,
  toOpenAIMessageContent,
  modelSupportsImages,
} = require("../../adapters/contentParts.cjs");
const crypto = require("crypto");

// Responses separates the provider item id (fc_...) from the chat tool id
// used to correlate function_call_output. Keep the latter stable while
// translating arbitrary chat-completions ids from the client.
function responsesFunctionIds(id) {
  const raw = sanitizeJsonSafeString(String(id || ""));
  // Responses limits item ids to 64 chars. Agent-loop ids intentionally carry
  // iteration/tool context and can exceed that limit, so hash only long ids.
  const token = raw.length > 48
    ? crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32)
    : raw || "generated";
  const callId = raw.startsWith("call_") && raw.length <= 48 ? token : `call_${token}`;
  const itemId = raw.startsWith("fc_") && raw.length <= 48 ? token : `fc_${token}`;
  return { callId, itemId };
}

function openaiToResponsesRequest(openaiBody, opts = {}) {
  const model = opts.upstreamModel || openaiBody.model;
  const supportImages =
    opts.supportImages != null
      ? Boolean(opts.supportImages)
      : modelSupportsImages(model, "openai");
  const input = [];
  let instructions = "";

  for (const m of openaiBody.messages || []) {
    const role = m.role || "user";

    if (role === "system" || role === "developer") {
      const t = contentToText(m.content);
      if (t) instructions = instructions ? `${instructions}\n\n${t}` : t;
      continue;
    }

    if (role === "tool") {
      // Browser/tool dumps can carry lone surrogates / C0 junk. Codex (serde_json)
      // rejects the whole body with "unexpected end of hex escape" on input[N].output.
      const ids = responsesFunctionIds(m.tool_call_id || m.toolCallId);
      input.push({
        type: "function_call_output",
        call_id: ids.callId,
        output: contentToText(m.content) || "",
      });
      continue;
    }

    if (role === "assistant") {
      const text = contentToText(m.content);
      const contentParts = [];
      if (text && text.trim()) {
        contentParts.push({ type: "output_text", text });
      }
      if (contentParts.length) {
        input.push({
          type: "message",
          role: "assistant",
          content: contentParts,
        });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const ids = responsesFunctionIds(tc?.id);
          const name = sanitizeJsonSafeString(tc?.function?.name || tc?.name || "");
          if (!name) continue;
          const argsRaw =
            typeof tc.function?.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {});
          input.push({
            type: "function_call",
            id: ids.itemId,
            call_id: ids.callId,
            name,
            arguments: sanitizeJsonSafeString(argsRaw || "{}"),
          });
        }
      }
      continue;
    }

    // user — input_image parts when vision is supported
    // Normalize content + optional message.images[] into OpenAI parts first.
    const openaiContent = toOpenAIMessageContent(m, { supportImages });
    input.push({
      type: "message",
      role: "user",
      content: openAIContentToResponsesParts(openaiContent, { supportImages }),
    });
  }

  // Codex rejects empty system role in input — use developer if needed
  for (const item of input) {
    if (item.role === "system") item.role = "developer";
  }

  const result = {
    model,
    input,
    stream: true, // Codex /responses requires stream=true
    store: false,
  };
  if (instructions) result.instructions = instructions;

  // tools
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length) {
    result.tools = openaiBody.tools.map((t) => {
      const fn = t.function || t;
      return {
        type: "function",
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} },
      };
    });
  }

  if (openaiBody.tool_choice != null) {
    result.tool_choice = openaiBody.tool_choice;
  }

  // max tokens
  const maxOut = openaiBody.max_tokens || openaiBody.max_completion_tokens;
  if (maxOut != null) result.max_output_tokens = Number(maxOut);

  // Reasoning (Grok / o-series / Responses API)
  // - effort: low | medium | high
  // - summary: auto|concise|detailed so clients get readable reasoning_content
  //   (without summary many providers only return encrypted traces / tokens)
  const effortRaw =
    openaiBody.reasoning_effort ||
    openaiBody.reasoning?.effort ||
    openaiBody.thinking?.budget_tokens ||
    openaiBody.thinking?.type ||
    null;
  let effort = null;
  if (typeof effortRaw === "string" && effortRaw.trim()) {
    const e = effortRaw.toLowerCase();
    if (e === "none" || e === "off" || e === "disabled") effort = null;
    else if (e === "minimal" || e === "low") effort = "low";
    else if (e === "medium" || e === "med") effort = "medium";
    else if (e === "high" || e === "xhigh" || e === "max") effort = "high";
    else effort = e;
  } else if (typeof effortRaw === "number" && Number.isFinite(effortRaw)) {
    effort = effortRaw >= 16000 ? "high" : effortRaw >= 4000 ? "medium" : "low";
  }

  // Default: enable visible reasoning for Grok / o-series style models when client
  // did not opt out. Chat clients (including ComposeVC) can then show live think.
  if (!effort) {
    const m = String(model || openaiBody.model || "").toLowerCase();
    if (
      m.includes("grok") ||
      m.includes("o3") ||
      m.includes("o4") ||
      m.includes("o1") ||
      m.includes("reason")
    ) {
      effort = "high";
    }
  }

  if (effort) {
    const summary =
      openaiBody.reasoning?.summary ||
      openaiBody.reasoning_summary ||
      "auto";
    result.reasoning = {
      effort,
      // Request a human-readable summary so convert can map → reasoning_content
      summary: summary === false || summary === "none" ? undefined : summary,
    };
    if (!result.reasoning.summary) delete result.reasoning.summary;
  }

  // xAI encrypted reasoning traces (optional round-trip). Prefer readable summary first.
  if (Array.isArray(openaiBody.include)) {
    result.include = openaiBody.include;
  } else if (openaiBody.include_encrypted_reasoning || openaiBody.include_encrypted_content) {
    result.include = ["reasoning.encrypted_content"];
  }

  // Final pass: every string leaf (esp. input[].output / arguments) must be
  // JSON-wire-safe before pipeline safeJsonStringify → Codex.
  return sanitizeJsonSafeDeep(result);
}

module.exports = { openaiToResponsesRequest };
