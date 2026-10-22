// Smoke-тест localAgentMcp.cjs без Electron: только status (без start/stop, чтобы не ронять живой сервер).
const Module = require("module");
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === "electron") return { dialog: {}, BrowserWindow: { getFocusedWindow: () => null } };
  return origLoad.call(this, req, ...rest);
};
const os = require("os");
const { registerLocalAgentHandlers } = require("../electron/localAgentMcp.cjs");
const handlers = {};
registerLocalAgentHandlers({ handle: (ch, fn) => (handlers[ch] = fn) }, () => os.tmpdir());

(async () => {
  const chans = Object.keys(handlers).sort();
  console.log("channels:", chans.join(", "));
  const res = await handlers["localAgent:status"]();
  const s = res.state;
  console.log(
    JSON.stringify(
      {
        ok: res.ok,
        agentDir: s.agentDir,
        exists: s.exists,
        port: s.port,
        localOk: s.localOk,
        serverPids: s.serverPids,
        tunnelRunning: s.tunnelRunning,
        url: s.connector.url,
        tokenPresent: Boolean(s.connector.token),
        instructionFirstLine: s.instruction.split("\n")[0],
      },
      null,
      2
    )
  );
  const path = require("path");
  const expected = path.resolve(__dirname, "..", "mcp-agent").toLowerCase();
  if (path.resolve(s.agentDir).toLowerCase() !== expected) {
    console.log("agentDir не внутри проекта:", s.agentDir);
    process.exit(1);
  }
  if (!res.ok || chans.length !== 6 || !s.exists) process.exit(1);
  console.log("SMOKE_OK");
})();
