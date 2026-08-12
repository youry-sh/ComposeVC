const fs = require("fs");
const customTools = require("../customTools.cjs");

async function main() {
  const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  const userDataPath = String(payload.userDataPath || "");
  const callerName = String(payload.caller || "");
  const targetName = String(payload.name || "");
  const stack = Array.isArray(payload.stack) ? payload.stack.map(String) : [];
  if (!userDataPath || !callerName || !targetName) throw new Error("callTool requires caller, name and userDataPath");
  if (stack.includes(targetName) || callerName === targetName) {
    throw new Error(`Custom tool cycle blocked: ${[...stack, callerName, targetName].join(" -> ")}`);
  }
  if (stack.length >= 6) throw new Error("Custom tool composition depth exceeded (max 6)");
  const caller = await customTools.findCustomTool(userDataPath, { name: callerName });
  if (!caller) throw new Error(`Calling custom tool not found: ${callerName}`);
  const allowed = Array.isArray(caller.dependencies) ? caller.dependencies : [];
  if (!allowed.includes(targetName)) {
    throw new Error(`Tool ${callerName} is not connected to ${targetName}. Connect it in Custom Tools workshop first.`);
  }
  const result = await customTools.executeCustomToolByName(userDataPath, targetName, payload.args || {}, {
    rootPath: payload.rootPath || null,
    projectName: payload.projectName || null,
    __customToolDepth: stack.length + 1,
    __customToolStack: [...stack, callerName],
  });
  process.stdout.write(JSON.stringify({ ok: true, result: result.result }));
}

main().catch((error) => {
  process.stderr.write(String(error?.stack || error));
  process.exit(1);
});
