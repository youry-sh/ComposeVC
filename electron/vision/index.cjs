/**
 * Vision bridge.
 *
 * The tools live in the main process but the provider config/API keys belong to
 * the app. main.cjs registers one executor; the vision tool never touches
 * config files or adapters directly.
 */

let executor = null;

function setVisionExecutor(fn) {
  executor = typeof fn === "function" ? fn : null;
}

async function requestVision(payload = {}) {
  if (!executor) throw new Error("Vision runtime is not initialised yet.");
  return executor(payload);
}

module.exports = { setVisionExecutor, requestVision };
