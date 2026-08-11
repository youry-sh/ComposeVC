const { openaiToOpenAIRequest } = require("./openai-passthrough.cjs");

function openaiToDeepSeekRequest(openaiBody, opts = {}) {
  const out = openaiToOpenAIRequest(openaiBody, opts);
  const thinking = out.thinking;
  delete out.thinking;
  if (thinking != null) out.thinking = thinking;
  return out;
}

module.exports = {
  openaiToDeepSeekRequest,
};
