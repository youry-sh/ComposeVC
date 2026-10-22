/**
 * OpenAI chat.completions → Antigravity Cloud Code envelope
 * (Gemini-compatible request nested under { project, model, request, ... }).
 */

const crypto = require("crypto");
const { openaiToGeminiRequest } = require("./openai-to-gemini.cjs");
const { resolveUpstreamModelId } = require("../oauth/antigravityUsage.cjs");

function stableAntigravitySessionId(openaiBody) {
  // Session id must stay the SAME for every turn of one chat, otherwise Cloud Code
  // drops the cached prefix. Hashing the full history (old code) changed it each
  // turn and cost a full JSON.stringify of the 2+ MB body. Use the immutable head.
  try {
    const { conversationKey } = require("../cacheAffinity.cjs");
    const key = conversationKey(openaiBody);
    if (key) return `lopster-${key.slice(0, 32)}`;
  } catch {
    /* fall through */
  }
  const messages = Array.isArray(openaiBody?.messages) ? openaiBody.messages : [];
  const head = messages.slice(0, 2).map((m) => ({ role: m?.role, content: m?.content }));
  const hash = crypto.createHash("sha256").update(JSON.stringify(head)).digest("hex").slice(0, 32);
  return `lopster-${hash}`;
}

function usesAntigravitySchema(modelName) {
  const m = String(modelName || "").toLowerCase();
  return m.includes("claude") || m.includes("gemini-3-pro") || m.includes("gemini-3.1-pro");
}

function normalizeAntigravityToolResponses(contents) {
  if (!Array.isArray(contents)) return contents;

  const out = [];
  const callNamesById = new Map();
  const pendingGroups = [];
  let collectedResponses = [];

  function normalizeResponsePart(part, fallbackName) {
    const functionResponse = { ...part.functionResponse };
    const mappedName = functionResponse.id && callNamesById.get(functionResponse.id);
    const currentName = String(functionResponse.name || "").trim();
    if (!currentName || (currentName === "tool" && mappedName)) {
      functionResponse.name = mappedName || fallbackName || "tool";
    }
    return { ...part, functionResponse };
  }

  function flushSatisfiedGroups() {
    while (pendingGroups.length && collectedResponses.length >= pendingGroups[0].callNames.length) {
      const group = pendingGroups.shift();
      const responseParts = collectedResponses.splice(0, group.callNames.length)
        .map((part, index) => normalizeResponsePart(part, group.callNames[index]));
      if (responseParts.length) out.push({ role: "user", parts: responseParts });
    }
  }

  for (const content of contents) {
    if (!content || typeof content !== "object" || !Array.isArray(content.parts)) {
      out.push(content);
      continue;
    }

    const responseParts = content.parts.filter((part) => part?.functionResponse);
    if (responseParts.length) {
      collectedResponses.push(...responseParts);
      flushSatisfiedGroups();
      continue;
    }

    out.push(content);

    const functionCalls = content.parts
      .map((part) => part?.functionCall)
      .filter(Boolean);
    const callNames = [];
    for (const call of functionCalls) {
      const name = String(call.name || "").trim();
      if (call.id && name) callNamesById.set(call.id, name);
      if (name) callNames.push(name);
    }
    if (callNames.length) {
      pendingGroups.push({ callNames });
      flushSatisfiedGroups();
    }
  }

  flushSatisfiedGroups();
  for (const part of collectedResponses) {
    out.push({ role: "user", parts: [normalizeResponsePart(part)] });
  }
  return out;
}

function openaiToAntigravityRequest(openaiBody, opts = {}) {
  const gemini = openaiToGeminiRequest(openaiBody, {
    upstreamModel: opts.upstreamModel || openaiBody.model,
  });
  // openaiToGemini returns { body, stream, _toolNameMap } or plain body depending on impl
  let geminiBody = gemini;
  let toolNameMap = null;
  let stream = true;
  if (gemini && typeof gemini === "object" && gemini.body) {
    geminiBody = gemini.body;
    toolNameMap = gemini._toolNameMap || null;
    stream = gemini.stream !== false;
  }

  const clientModel = opts.upstreamModel || openaiBody.model;
  const upstreamModel = resolveUpstreamModelId(clientModel);
  const projectId = opts.projectId || null;

  // Strip model from inner request if present (envelope carries model)
  const request = { ...geminiBody };
  delete request.model;
  request.contents = normalizeAntigravityToolResponses(request.contents);

  // CLIProxyAPI uses a stable session id derived from the payload for agent continuity.
  if (!request.sessionId) {
    request.sessionId = opts.sessionId || stableAntigravitySessionId(openaiBody);
  }

  // CLIProxyAPI strips these for Antigravity before send on Gemini 2.x style models.
  delete request.safetySettings;
  if (!usesAntigravitySchema(upstreamModel)) {
    delete request.generationConfig?.maxOutputTokens;
  }

  const envelope = {
    project: projectId,
    model: upstreamModel,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    enabledCreditTypes: ["GOOGLE_ONE_AI"],
    request,
  };

  return {
    body: envelope,
    stream,
    _toolNameMap: toolNameMap,
    _upstreamModel: upstreamModel,
  };
}

module.exports = {
  openaiToAntigravityRequest,
  resolveUpstreamModelId,
};
