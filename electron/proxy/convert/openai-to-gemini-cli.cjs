/**
 * OpenAI → Gemini CLI Cloud Code envelope.
 * Only a small model set works on gemini-cli OAuth (see resolveUpstreamModelId).
 */

const crypto = require("crypto");
const { openaiToGeminiRequest } = require("./openai-to-gemini.cjs");
const { resolveUpstreamModelId } = require("../oauth/geminiCliUsage.cjs");

function openaiToGeminiCliRequest(openaiBody, opts = {}) {
  const gemini = openaiToGeminiRequest(openaiBody, {
    upstreamModel: opts.upstreamModel || openaiBody.model,
  });
  let geminiBody = gemini;
  let toolNameMap = null;
  let stream = true;
  if (gemini && typeof gemini === "object" && gemini.body) {
    geminiBody = gemini.body;
    toolNameMap = gemini._toolNameMap || null;
    stream = gemini.stream !== false;
  }

  const clientModel = opts.upstreamModel || openaiBody.model;
  const resolved = resolveUpstreamModelId(clientModel);
  const upstreamModel = resolved.model;
  const projectId = opts.projectId || null;

  const request = { ...geminiBody };
  delete request.model;
  if (!request.sessionId) {
    request.sessionId = opts.sessionId || `lopster-${crypto.randomUUID()}`;
  }
  if (!request.safetySettings) {
    request.safetySettings = [
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_CIVIC_INTEGRITY",
    ].map((category) => ({ category, threshold: "OFF" }));
  }

  const envelope = {
    project: projectId,
    model: upstreamModel,
    userAgent: "gemini-cli",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request,
  };

  return {
    body: envelope,
    stream,
    _toolNameMap: toolNameMap,
    _upstreamModel: upstreamModel,
    _mappedFrom: resolved.mappedFrom || null,
  };
}

module.exports = { openaiToGeminiCliRequest, resolveUpstreamModelId };
