/**
 * OpenAI chat.completions → Gemini generateContent body.
 */

const { contentToText } = require("../openaiFormat.cjs");
const {
  openaiToolsToGemini,
  openaiToolChoiceToGemini,
  safeParseJSON,
} = require("./tools.cjs");
const { reasoningEffortToBudget } = require("./thinking.cjs");
const thoughtSigs = require("./thoughtSignatures.cjs");
const {
  openAIContentToGeminiParts,
  toOpenAIMessageContent,
  modelSupportsImages,
} = require("../../adapters/contentParts.cjs");

function openaiToGeminiRequest(openaiBody, opts = {}) {
  const model = opts.upstreamModel || openaiBody.model;
  const supportImages =
    opts.supportImages != null
      ? Boolean(opts.supportImages)
      : modelSupportsImages(model, "gemini");
  const contents = [];
  let systemInstruction = null;
  const systemTexts = [];

  for (const m of openaiBody.messages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = contentToText(m.content);
      if (t) systemTexts.push(t);
      continue;
    }

    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.name || "tool",
              response: { result: contentToText(m.content) },
              id: m.tool_call_id,
            },
          },
        ],
      });
      continue;
    }

    if (m.role === "assistant") {
      const parts = [];
      const text = contentToText(m.content);
      if (text) parts.push({ text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name;
          const args = safeParseJSON(tc.function?.arguments, {});
          const part = {
            functionCall: {
              name,
              args,
              id: tc.id,
            },
          };
          // Gemini 2.5/3 require thoughtSignature on functionCall parts when replaying history
          const sig = thoughtSigs.lookup(tc);
          if (sig) {
            thoughtSigs.attachToPart(part, sig);
            // Keep cache warm under this id for next turns
            thoughtSigs.remember(tc.id, sig, { name, args });
          }
          parts.push(part);
        }
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }

    // user — multimodal inlineData / fileData when supported
    // Normalize content + optional message.images[] into OpenAI parts first.
    const openaiContent = toOpenAIMessageContent(m, { supportImages });
    contents.push({
      role: "user",
      parts: openAIContentToGeminiParts(openaiContent, { supportImages }),
    });
  }

  if (systemTexts.length) {
    systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }

  const generationConfig = {};
  if (openaiBody.temperature != null) generationConfig.temperature = openaiBody.temperature;
  if (openaiBody.top_p != null) generationConfig.topP = openaiBody.top_p;
  const maxOut = openaiBody.max_tokens || openaiBody.max_completion_tokens;
  if (maxOut != null) generationConfig.maxOutputTokens = Number(maxOut);

  // Thinking config (Gemini 2.5+)
  const budget =
    openaiBody.thinking?.budget_tokens ||
    reasoningEffortToBudget(openaiBody.reasoning_effort);
  if (budget) {
    generationConfig.thinkingConfig = {
      thinkingBudget: Number(budget),
      includeThoughts: true,
    };
  }

  if (openaiBody.response_format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  } else if (openaiBody.response_format?.type === "json_schema") {
    generationConfig.responseMimeType = "application/json";
    if (openaiBody.response_format.json_schema?.schema) {
      generationConfig.responseSchema = openaiBody.response_format.json_schema.schema;
    }
  }

  const body = {
    contents,
    generationConfig,
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const { functionDeclarations, nameMap } = openaiToolsToGemini(openaiBody.tools);
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
    body.toolConfig = { functionCallingConfig: openaiToolChoiceToGemini(openaiBody.tool_choice) };
  }

  return {
    model,
    body,
    _toolNameMap: nameMap,
    stream: Boolean(openaiBody.stream),
  };
}

module.exports = { openaiToGeminiRequest };
