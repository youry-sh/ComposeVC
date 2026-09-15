const { readResponseEvents, fetchWithRetry } = require("./utils.cjs");
const { normalizeModelOutput } = require("./thinking.cjs");
const {
  contentToText,
  toOpenAIMessageContent,
  openAIContentToGeminiParts,
  modelSupportsImages,
  extractAssistantImages,
  collectImages,
  parseDataUrl,
} = require("./contentParts.cjs");

function buildPayload({ model, messages, tools }) {
  const modelName = String(model?.name || model?.id || "");
  const supportImages = modelSupportsImages(modelName, "gemini");
  const contents = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const parts = [
        {
          functionResponse: {
            name: message.toolName,
            response: { result: contentToText(message.content) },
          },
        },
      ];
      if (supportImages) {
        const images = collectImages(message);
        for (const img of images) {
          const parsed = parseDataUrl(img.url);
          if (parsed) {
            parts.push({
              inlineData: {
                mimeType: parsed.mimeType,
                data: parsed.data,
              },
            });
          }
        }
      }
      contents.push({
        role: "user",
        parts,
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const parts = [];
      const text = contentToText(message.content);
      if (text) parts.push({ text });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.input || {} } });
      }
      contents.push({ role: "model", parts });
      continue;
    }

    const openaiContent = toOpenAIMessageContent(message, { supportImages });
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts: openAIContentToGeminiParts(openaiContent, { supportImages }),
    });
  }

  const systemInstruction = messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .join("\n\n");

  const payload = { contents };
  if (systemInstruction) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools && tools.length) {
    payload.tools = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ];
  }

  return payload;
}

async function execute({ provider, model, messages, tools, onRetry, signal, onDelta }) {
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const response = await fetchWithRetry(
    `${baseUrl}/v1beta/models/${model.name}:streamGenerateContent?alt=sse&key=${provider.apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPayload({ model, messages, tools })),
      signal,
    },
    { providerName: "Gemini", onRetry }
  );

  let content = "";
  let reasoning = "";
  let usage = null;
  const toolCalls = [];
  const imageParts = [];

  const consumeChunk = (chunk) => {
    if (chunk.usageMetadata) {
      usage = {
        promptTokens: chunk.usageMetadata.promptTokenCount || 0,
        completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
        totalTokens: chunk.usageMetadata.totalTokenCount || 0,
      };
    }

    let textDelta = "";
    let reasoningDelta = "";
    for (const candidate of chunk.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.thought === true || part.thought) {
          if (part.text) {
            reasoning += part.text;
            reasoningDelta += part.text;
          }
          continue;
        }
        if (part.text) {
          content += part.text;
          textDelta += part.text;
        }
        const inline = part.inlineData || part.inline_data;
        if (inline?.data) {
          imageParts.push({
            type: "image",
            inlineData: {
              mimeType: inline.mimeType || inline.mime_type || "image/png",
              data: inline.data,
            },
          });
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `${part.functionCall.name}-${toolCalls.length}`,
            name: part.functionCall.name,
            input: part.functionCall.args || {},
          });
        }
      }
    }
    if (textDelta || reasoningDelta) onDelta?.({ text: textDelta, reasoning: reasoningDelta });
  };

  await readResponseEvents(response, "Gemini", consumeChunk, { collectEvents: false });

  // Answer text is clean; reasoning is ephemeral for live UI only (not saved).
  const normalized = normalizeModelOutput({ content, reasoning });
  let images = [];
  try {
    images = extractAssistantImages(imageParts);
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

module.exports = { buildPayload, execute };
