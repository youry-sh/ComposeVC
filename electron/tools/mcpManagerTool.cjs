const mcp = require("../mcpManager.cjs");

function userData(context) {
  if (!context?.userDataPath) throw new Error("MCP storage unavailable: no userDataPath");
  return context.userDataPath;
}
function target(input) { return input.id || input.name || input.server; }
function notify(context, payload) { try { context?.onMcpChanged?.(payload); } catch {} }

module.exports = {
  name: "mcp_manager",
  description: "Manage Model Context Protocol (MCP) servers and their tools. The AI can add/remove/update local stdio or remote Streamable HTTP servers, connect, inspect, search discovered tools, import standard mcpServers/OpenCode configs, and call a server tool. Enabled MCP tools are also injected as first-class tools named mcp__<server>__<tool>.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "get", "add", "update", "remove", "enable", "disable", "connect", "disconnect", "refresh", "inspect", "call", "import"] },
      id: { type: "string" }, name: { type: "string" }, server: { type: "string" }, title: { type: "string" }, description: { type: "string" },
      type: { type: "string", enum: ["local", "remote"] }, command: { description: "Local executable string or command array" },
      args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, environment: { type: "object" }, env: { type: "object" },
      url: { type: "string" }, headers: { type: "object" }, enabled: { type: "boolean" },
      timeout: { type: "object", properties: { startup: { type: "number" }, request: { type: "number" } } },
      query: { type: "string" }, tool: { type: "string" }, arguments: { type: "object" }, argsObject: { type: "object" },
      config: { description: "JSON object/string using mcpServers, mcp.servers, or servers" }, overwrite: { type: "boolean" },
    }, required: ["action"], additionalProperties: true,
  },
  async execute(input = {}, context = {}) {
    const root = userData(context);
    const action = String(input.action || "").toLowerCase();
    if (action === "list") return { servers: await mcp.listServers(root), count: (await mcp.listServers(root, { includeTools: false })).length };
    if (action === "get") { const server = await mcp.findServer(root, target(input)); if (!server) throw new Error("MCP server not found"); return server; }
    if (action === "add") { const server = await mcp.addServer(root, input); notify(context, { type: "added", server }); return server; }
    if (action === "update") { const server = await mcp.updateServer(root, target(input), input); notify(context, { type: "updated", server }); return server; }
    if (action === "remove") { const result = await mcp.removeServer(root, target(input)); notify(context, { type: "removed", server: result.server }); return result; }
    if (action === "enable" || action === "disable") { const server = await mcp.updateServer(root, target(input), { enabled: action === "enable" }); notify(context, { type: "updated", server }); return server; }
    if (action === "connect") { const entry = await mcp.connect(root, target(input), { force: input.force === true }); notify(context, { type: "status", name: entry.server.name }); return { server: entry.server, tools: entry.tools }; }
    if (action === "disconnect") { const result = await mcp.disconnect(root, target(input)); notify(context, { type: "status", name: result.name }); return result; }
    if (action === "refresh") { const result = await mcp.refresh(root, target(input)); notify(context, { type: "status", name: result.server.name }); return result; }
    if (action === "inspect") return mcp.inspectServer(root, target(input));
    if (action === "call") {
      let publicName = input.tool;
      if (publicName && !publicName.startsWith("mcp__")) publicName = mcp.publicToolName(target(input), publicName);
      return mcp.callPublicTool(root, publicName, input.arguments || input.argsObject || {}, { signal: context.signal, rootPath: context.rootPath || null });
    }
    if (action === "search") {
      const q = String(input.query || "").toLowerCase();
      const schemas = await mcp.getEnabledToolSchemas(root, { rootPath: context.rootPath || null });
      const tools = schemas.filter((t) => !q || `${t.name} ${t.description} ${t.mcpServer} ${t.mcpTool}`.toLowerCase().includes(q));
      return { count: tools.length, tools };
    }
    if (action === "import") { const result = await mcp.importConfig(root, input.config, { overwrite: input.overwrite === true }); notify(context, { type: "changed" }); return result; }
    throw new Error(`Unknown MCP action: ${action}`);
  },
  disposeAll() { return mcp.disposeAll(); },
};
