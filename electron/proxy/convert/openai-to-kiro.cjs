/**
 * OpenAI Chat Completions → Kiro / CodeWhisperer GenerateAssistantResponse body.
 * Adapted from OmniRoute open-sse/translator/request/openai-to-kiro.ts (core path).
 */

const crypto = require("crypto");

const NAMESPACE_KIRO = "34f7193f-561d-4050-bc84-9547d953d6bf";

function uuidv4() {
  return crypto.randomUUID();
}

/** Deterministic uuid v5-ish from seed (SHA-1 namespace layout). */
function uuidFromSeed(seed) {
  const ns = Buffer.from(NAMESPACE_KIRO.replace(/-/g, ""), "hex");
  const hash = crypto.createHash("sha1").update(ns).update(String(seed || "")).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || c.text))
      .map((c) => c.text || "")
      .join("\n");
  }
  return "";
}

function normalizeToolSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  return schema;
}

function convertMessages(messages, tools, model) {
  const history = [];
  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let currentRole = null;
  let toolsAttached = false;
  let currentMessage = null;
  const supportsImages = typeof model === "string" && model.toLowerCase().includes("claude");
  let pendingImages = [];

  const flushPending = () => {
    if (currentRole === "user") {
      const text = pendingUserContent.join("\n\n").trim();
      const hasContext = pendingToolResults.length > 0 || pendingImages.length > 0;
      const content = text || (hasContext ? "" : "(empty)");
      const userMsg = {
        userInputMessage: {
          content,
          modelId: "",
          origin: "AI_EDITOR",
        },
      };
      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        };
      }
      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }
      if (tools && tools.length > 0 && !toolsAttached) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        const TOOL_DESC_MAX = 10000;
        const toolDocs = [];
        userMsg.userInputMessage.userInputMessageContext.tools = tools.map((t) => {
          const fn = t.function || t;
          const name = fn.name || t.name;
          let description = fn.description || t.description || "";
          if (!String(description).trim()) description = `Tool: ${name}`;
          if (description.length > TOOL_DESC_MAX) {
            toolDocs.push(`## Tool: ${name}\n\n${description}`);
            description = `[Full documentation in system prompt under '## Tool: ${name}']`;
          }
          return {
            toolSpecification: {
              name,
              description,
              inputSchema: {
                json: normalizeToolSchema(fn.parameters || t.parameters || t.input_schema || {}),
              },
            },
          };
        });
        if (toolDocs.length) userMsg._toolDocs = toolDocs.join("\n\n---\n\n");
        toolsAttached = true;
      }
      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "(empty)";
      history.push({
        assistantResponseMessage: { content },
      });
      pendingAssistantContent = [];
    }
  };

  for (const msg of messages || []) {
    let role = msg.role;
    if (role === "system" || role === "tool") role = "user";
    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === "user") {
      if (msg.role === "system") {
        const t = textFromContent(msg.content);
        if (t) pendingUserContent.push(`<system-reminder>\n${t}\n</system-reminder>`);
      } else if (msg.role === "tool") {
        let resultText = textFromContent(msg.content);
        if (!resultText) resultText = "(empty)";
        pendingToolResults.push({
          toolUseId: msg.tool_call_id || msg.id || `tool_${Date.now()}`,
          content: [{ text: resultText }],
          status: "success",
        });
      } else {
        let content = "";
        if (typeof msg.content === "string") content = msg.content;
        else if (Array.isArray(msg.content)) {
          const texts = [];
          const fallbackImgs = [];
          for (const block of msg.content) {
            if (block?.type === "text" || block?.text) texts.push(block.text || "");
            if (block?.type === "image_url") {
              const url = block.image_url?.url || "";
              if (supportsImages) {
                const m = String(url).match(/^data:image\/(\w+);base64,(.+)$/);
                if (m) {
                  pendingImages.push({
                    format: m[1] === "jpg" ? "jpeg" : m[1],
                    source: { bytes: m[2] },
                  });
                } else if (url) {
                  // Non-data URLs can't be sent as Kiro bytes — keep as text note.
                  fallbackImgs.push({ url });
                }
              } else if (url) {
                // Non-Claude Kiro models: embed image as text so request never fails.
                fallbackImgs.push({ url });
              }
            }
          }
          content = texts.join("\n");
          if (fallbackImgs.length) {
            try {
              const { imagesToFallbackText } = require("../../adapters/contentParts.cjs");
              const fb = imagesToFallbackText(fallbackImgs);
              if (fb) content = content ? `${content}\n\n${fb}` : fb;
            } catch {
              content = content
                ? `${content}\n\n[${fallbackImgs.length} image(s) as text]`
                : `[${fallbackImgs.length} image(s) as text]`;
            }
          }
        }
        // Also fold parallel message.images[] (if present)
        if (Array.isArray(msg.images) && msg.images.length) {
          for (const img of msg.images) {
            const url = img?.url || img?.dataUrl || (typeof img === "string" ? img : "");
            if (!url) continue;
            if (supportsImages) {
              const m = String(url).match(/^data:image\/(\w+);base64,(.+)$/);
              if (m) {
                pendingImages.push({
                  format: m[1] === "jpg" ? "jpeg" : m[1],
                  source: { bytes: m[2] },
                });
                continue;
              }
            }
            try {
              const { imagesToFallbackText } = require("../../adapters/contentParts.cjs");
              const fb = imagesToFallbackText([{ url, name: img?.name }]);
              if (fb) content = content ? `${content}\n\n${fb}` : fb;
            } catch {
              /* ignore */
            }
          }
        }
        if (content) pendingUserContent.push(content);
      }
    } else if (role === "assistant") {
      const content = textFromContent(msg.content);
      if (content) pendingAssistantContent.push(content);
      if (Array.isArray(msg.tool_calls)) {
        // Represent prior tool calls as text note in assistant history (Kiro history shape)
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name || tc.name || "tool";
          const args = tc.function?.arguments || "";
          pendingAssistantContent.push(`[tool_call ${name}] ${args}`);
        }
      }
    }
  }
  if (currentRole) flushPending();

  // Ensure we have a current user message
  if (!currentMessage) {
    currentMessage = {
      userInputMessage: {
        content: "(empty)",
        modelId: "",
        origin: "AI_EDITOR",
      },
    };
  }

  // History for Kiro excludes the current turn (currentMessage is separate)
  const histWithoutCurrent = history.filter((h) => h !== currentMessage);

  return {
    history: histWithoutCurrent,
    currentMessage,
    toolsAttached,
  };
}

function openaiToKiroRequest(openaiBody, opts = {}) {
  const body = openaiBody || {};
  // Default must match kiroCreds PREFERRED_DEFAULTS[0] (widest free-tier), not plan-gated ids
  let model = String(opts.upstreamModel || body.model || "claude-haiku-4.5").replace(
    /^[^/]+\//,
    ""
  );
  // Strip unsupported Anthropic 1m suffix
  if (model.toLowerCase().includes("[1m]")) {
    model = model.replace(/\[1m\]/gi, "");
  }
  // Normalize common alias forms so modelId matches Kiro catalog spelling
  if (/^claude-sonnet-4-5$/i.test(model)) model = "claude-sonnet-4.5";
  if (/^claude-haiku-4-5$/i.test(model)) model = "claude-haiku-4.5";
  if (/^claude-sonnet-4-6$/i.test(model)) model = "claude-sonnet-4.5"; // not a Kiro id

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let tools = Array.isArray(body.tools) ? body.tools : null;

  const { history, currentMessage } = convertMessages(messages, tools, model);

  let finalContent = currentMessage?.userInputMessage?.content || "";
  const timestamp = new Date().toISOString();
  finalContent = `[Context: Current time is ${timestamp}]\n\n${finalContent}`;
  if (currentMessage?._toolDocs) {
    finalContent = `# Tool Documentation\n\n${currentMessage._toolDocs}\n\n---\n\n${finalContent}`;
  }

  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  const temperature = body.temperature;
  const topP = body.top_p;

  const profileArn =
    opts.profileArn ||
    opts.providerMeta?.profileArn ||
    opts.account?.providerMeta?.profileArn ||
    opts.account?.workspaceId ||
    "";

  // conversationId: stable hash of first real user content
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    (firstUser && textFromContent(firstUser.content).slice(0, 4000)) ||
    finalContent.slice(0, 4000) ||
    uuidv4();

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidFromSeed(seed),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: model,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.images?.length
            ? { images: currentMessage.userInputMessage.images }
            : {}),
          ...(currentMessage?.userInputMessage?.userInputMessageContext
            ? {
                userInputMessageContext:
                  currentMessage.userInputMessage.userInputMessageContext,
              }
            : {}),
        },
      },
      history,
    },
  };

  if (profileArn) payload.profileArn = profileArn;

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = Number(maxTokens);
    if (temperature !== undefined) payload.inferenceConfig.temperature = Number(temperature);
    if (topP !== undefined) payload.inferenceConfig.topP = Number(topP);
  }

  return payload;
}

module.exports = { openaiToKiroRequest };
