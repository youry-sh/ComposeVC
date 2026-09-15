const { readResponseEvents, fetchWithRetry } = require("./utils.cjs");
const { normalizeModelOutput } = require("./thinking.cjs");
const {
  contentToText,
  toOpenAIMessageContent,
  openAIContentToAnthropicBlocks,
  modelSupportsImages,
  extractAssistantImages,
  collectImages,
  parseDataUrl,
} = require("./contentParts.cjs");

function buildPayload({ model, messages, tools }) {
  const modelName = String(model?.name || model?.id || "");
  const supportImages = modelSupportsImages(modelName, "anthropic");
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .join("\n\n");

  const converted = [];
  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const toolBlocks = [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: contentToText(message.content),
        },
      ];
      if (supportImages) {
        const images = collectImages(message);
        for (const img of images) {
          const parsed = parseDataUrl(img.url);
          if (parsed) {
            toolBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: parsed.mimeType,
                data: parsed.data,
              },
            });
          } else if (/^https?:\/\//i.test(String(img.url || ""))) {
            toolBlocks.push({
              type: "image",
              source: { type: "url", url: img.url },
            });
          }
        }
      }
      converted.push({
        role: "user",
        content: toolBlocks,
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      const blocks = [];
      const text = contentToText(message.content);
      if (text) blocks.push({ type: "text", text });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input || {} });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    const openaiContent = toOpenAIMessageContent(message, { supportImages });
    converted.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content:
        message.role === "assistant"
          ? contentToText(openaiContent) || openaiContent
          : openAIContentToAnthropicBlocks(openaiContent, { supportImages }),
    });
  }

  const payload = {
    model: model.name,
    max_tokens: 4096,
    stream: true,
    ...(system ? { system } : {}),
    messages: converted,
  };

  if (tools && tools.length) {
    payload.tools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  return payload;
}

async function execute({ provider, model, messages, tools, onRetry, signal, onDelta }) {
  const response = await fetchWithRetry(
    `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(buildPayload({ model, messages, tools })),
      signal,
    },
    { providerName: "Anthropic", onRetry }
  );

  let content = "";
  let reasoning = "";
  let usage = null;
  const toolCalls = [];
  const toolBlocks = new Map();
  const imageBlocks = [];

  const consumeChunk = (chunk) => {
    if (chunk.usage) {
      const promptTokens = chunk.usage.input_tokens || 0;
      const completionTokens = chunk.usage.output_tokens || 0;
      usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
    }

    let textDelta = "";
    let reasoningDelta = "";
    if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
      toolBlocks.set(chunk.index ?? toolBlocks.size, {
        id: chunk.content_block.id,
        name: chunk.content_block.name,
        json: "",
      });
    } else if (chunk.type === "content_block_start" && chunk.content_block?.type === "text") {
      // Streaming-native Anthropic event: the text itself follows as deltas.
    } else if (chunk.type === "content_block_delta") {
      textDelta = chunk.delta?.text || "";
      reasoningDelta = chunk.delta?.thinking || "";
      content += textDelta;
      reasoning += reasoningDelta;
      if (chunk.delta?.type === "input_json_delta") {
        const tool = toolBlocks.get(chunk.index);
        if (tool) tool.json += chunk.delta.partial_json || "";
      }
    }

    for (const block of chunk.content || []) {
      if (block.type === "text") {
        content += block.text || "";
        textDelta += block.text || "";
      }
      if (block.type === "thinking") {
        const value = block.thinking || block.text || "";
        reasoning += value;
        reasoningDelta += value;
      }
      if (block.type === "image") imageBlocks.push(block);
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input || {} });
      }
    }
    if (textDelta || reasoningDelta) onDelta?.({ text: textDelta, reasoning: reasoningDelta });
  };

  await readResponseEvents(response, "Anthropic", consumeChunk, { collectEvents: false });
  for (const tool of toolBlocks.values()) {
    if (toolCalls.some((call) => call.id === tool.id)) continue;
    let input = {};
    if (tool.json) {
      try {
        input = JSON.parse(tool.json);
      } catch {
        // Do not fail a completed stream because one upstream relay emitted an
        // incomplete input_json_delta; the model can recover on the next turn.
      }
    }
    toolCalls.push({ id: tool.id, name: tool.name, input });
  }

  // Answer text is clean; reasoning is ephemeral for live UI only (not saved).
  const normalized = normalizeModelOutput({ content, reasoning });
  let images = [];
  try {
    images = extractAssistantImages(imageBlocks);
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
