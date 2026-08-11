const openai = require("./openai.cjs");
const anthropic = require("./anthropic.cjs");
const gemini = require("./gemini.cjs");

const adapters = {
  openai,
  "openai-compat": openai,
  "openai-compatible": openai,
  anthropic,
  gemini,
};

function getAdapter(type) {
  const adapter = adapters[type];
  if (!adapter) {
    throw new Error(`Unsupported provider format: ${type}`);
  }
  return adapter;
}

module.exports = { getAdapter };
