#!/usr/bin/env node
/**
 * Drive the vm tool from a terminal, without launching the app.
 *
 *   node scripts/vm-cli.cjs host_status
 *   node scripts/vm-cli.cjs host_install wait=true
 *   node scripts/vm-cli.cjs create name=dev image=debian-12 memory_mb=4096
 *   node scripts/vm-cli.cjs wait_ready name=dev
 *   node scripts/vm-cli.cjs exec name=dev command="uname -a"
 *   node scripts/vm-cli.cjs list --json
 */
const tool = require("../electron/tools/vmTool.cjs");

function parse(argv) {
  const input = {};
  let json = false;
  for (const token of argv) {
    if (token === "--json") {
      json = true;
      continue;
    }
    const index = token.indexOf("=");
    if (index <= 0) continue;
    const key = token.slice(0, index);
    const raw = token.slice(index + 1);
    if (raw === "true" || raw === "false") input[key] = raw === "true";
    else if (/^-?\d+(\.\d+)?$/.test(raw)) input[key] = Number(raw);
    else input[key] = raw;
  }
  return { input, json };
}

(async () => {
  const [action, ...rest] = process.argv.slice(2);
  if (!action) {
    console.error("usage: node scripts/vm-cli.cjs <action> [key=value ...] [--json]");
    console.error(`actions: ${tool.inputSchema.properties.action.enum.join(", ")}`);
    process.exit(2);
  }
  const { input, json } = parse(rest);
  try {
    const result = await tool.execute({ action, ...input }, { userDataPath: process.env.COMPOSEVC_USER_DATA || null });
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(`bit=${result.bit}\n${result.text}`);
    process.exit(result.bit ? 0 : 1);
  } catch (error) {
    console.error(`bit=0\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
})();
