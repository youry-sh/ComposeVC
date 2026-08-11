const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_FILE = "mcp-servers.json";
const DEFAULT_STARTUP_TIMEOUT = 30_000;
const DEFAULT_REQUEST_TIMEOUT = 300_000;
const clients = new Map();
const connecting = new Map();
const failures = new Map();
const FAILURE_RETRY_MS = 15_000;

function storePath(userDataPath) {
  if (!userDataPath) throw new Error("MCP storage unavailable: userDataPath is required");
  return path.join(userDataPath, STORE_FILE);
}

function cleanName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function toolPart(value) {
  return String(value || "tool").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "tool";
}

function publicToolName(serverName, remoteName) {
  return `mcp__${toolPart(serverName)}__${toolPart(remoteName)}`;
}

function expandEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key) => process.env[key] || "");
}

function normalizeServer(input = {}, existing = null) {
  const name = cleanName(input.name || existing?.name);
  if (!name) throw new Error("MCP server name is required");
  const inferredType = input.type || existing?.type || (input.url || existing?.url ? "remote" : "local");
  const type = inferredType === "remote" || inferredType === "http" || inferredType === "sse" ? "remote" : "local";
  let command = input.command !== undefined ? input.command : existing?.command;
  let args = input.args !== undefined ? input.args : existing?.args;
  if (Array.isArray(command)) {
    args = command.slice(1);
    command = command[0];
  }
  const server = {
    id: existing?.id || crypto.randomUUID(),
    name,
    title: String(input.title !== undefined ? input.title : existing?.title || name).trim().slice(0, 120),
    description: String(input.description !== undefined ? input.description : existing?.description || "").trim().slice(0, 500),
    type,
    enabled: input.enabled !== undefined ? input.enabled !== false : existing?.enabled !== false,
    command: type === "local" ? String(command || "").trim() : undefined,
    args: type === "local" ? (Array.isArray(args) ? args.map(String) : []) : undefined,
    cwd: type === "local" ? String(input.cwd !== undefined ? input.cwd : existing?.cwd || "").trim() || undefined : undefined,
    environment: type === "local" ? { ...(existing?.environment || {}), ...(input.environment || input.env || {}) } : undefined,
    url: type === "remote" ? String(input.url !== undefined ? input.url : existing?.url || "").trim() : undefined,
    headers: type === "remote" ? { ...(existing?.headers || {}), ...(input.headers || {}) } : undefined,
    timeout: {
      startup: Math.max(1000, Number(input.timeout?.startup ?? input.startupTimeout ?? existing?.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT)),
      request: Math.max(1000, Number(input.timeout?.request ?? input.requestTimeout ?? existing?.timeout?.request ?? DEFAULT_REQUEST_TIMEOUT)),
    },
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  if (type === "local" && !server.command) throw new Error("Local MCP server requires command");
  if (type === "remote") {
    try { new URL(server.url); } catch { throw new Error("Remote MCP server requires a valid http(s) URL"); }
    if (!/^https?:/i.test(server.url)) throw new Error("Remote MCP URL must use http or https");
  }
  return server;
}

async function readStore(userDataPath) {
  try {
    const raw = await fs.promises.readFile(storePath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, servers: Array.isArray(parsed.servers) ? parsed.servers : [] };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, servers: [] };
    throw error;
  }
}

async function writeStore(userDataPath, store) {
  const file = storePath(userDataPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify({ version: 1, servers: store.servers }, null, 2), "utf8");
  await fs.promises.rename(temp, file);
}

async function listServers(userDataPath, { includeTools = true } = {}) {
  const store = await readStore(userDataPath);
  return Promise.all(store.servers.map(async (server) => {
    const key = keyOf(userDataPath, server.name);
    const live = clients.get(key);
    const failure = failures.get(key);
    const summary = { ...server, status: live ? "connected" : server.enabled === false ? "disabled" : failure ? "error" : "disconnected" };
    if (failure) summary.lastError = failure.error;
    if (includeTools) summary.tools = live?.tools || [];
    return summary;
  }));
}

async function findServer(userDataPath, idOrName) {
  const servers = (await readStore(userDataPath)).servers;
  const target = String(idOrName || "").trim();
  return servers.find((s) => s.id === target || s.name === cleanName(target)) || null;
}

async function addServer(userDataPath, input) {
  const store = await readStore(userDataPath);
  const server = normalizeServer(input);
  if (store.servers.some((s) => s.name === server.name)) throw new Error(`MCP server already exists: ${server.name}`);
  store.servers.push(server);
  await writeStore(userDataPath, store);
  return server;
}

async function updateServer(userDataPath, idOrName, patch) {
  const store = await readStore(userDataPath);
  const index = store.servers.findIndex((s) => s.id === String(idOrName) || s.name === cleanName(idOrName));
  if (index < 0) throw new Error(`MCP server not found: ${idOrName}`);
  const next = normalizeServer({ ...patch, name: patch.name || store.servers[index].name }, store.servers[index]);
  if (store.servers.some((s, i) => i !== index && s.name === next.name)) throw new Error(`MCP server already exists: ${next.name}`);
  await disconnect(userDataPath, store.servers[index].name).catch(() => {});
  store.servers[index] = next;
  await writeStore(userDataPath, store);
  return next;
}

async function removeServer(userDataPath, idOrName) {
  const store = await readStore(userDataPath);
  const index = store.servers.findIndex((s) => s.id === String(idOrName) || s.name === cleanName(idOrName));
  if (index < 0) return { deleted: false };
  const [server] = store.servers.splice(index, 1);
  await disconnect(userDataPath, server.name).catch(() => {});
  await writeStore(userDataPath, store);
  return { deleted: true, server };
}

function keyOf(userDataPath, name) { return `${path.resolve(userDataPath)}::${name}`; }
function timed(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

async function makeTransport(server) {
  if (server.type === "local") {
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    const env = Object.fromEntries(Object.entries(server.environment || {}).map(([k, v]) => [k, expandEnv(String(v))]));
    return new StdioClientTransport({ command: server.command, args: server.args || [], cwd: server.cwd || undefined, env, stderr: "pipe" });
  }
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const headers = Object.fromEntries(Object.entries(server.headers || {}).map(([k, v]) => [k, expandEnv(String(v))]));
  return new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
}

async function connect(userDataPath, idOrName, { force = false } = {}) {
  const server = await findServer(userDataPath, idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  if (server.enabled === false && !force) throw new Error(`MCP server is disabled: ${server.name}`);
  const key = keyOf(userDataPath, server.name);
  const cached = clients.get(key);
  if (cached) return cached;
  const pending = connecting.get(key);
  if (pending) return pending;
  const recentFailure = failures.get(key);
  if (!force && recentFailure && Date.now() - recentFailure.at < FAILURE_RETRY_MS) {
    throw new Error(recentFailure.error);
  }
  const work = (async () => {
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "composevc", version: "1.0.1" });
    const transport = await makeTransport(server);
    try {
      await timed(client.connect(transport), server.timeout?.startup || DEFAULT_STARTUP_TIMEOUT, `MCP ${server.name} startup`);
      const listed = await timed(client.listTools(), server.timeout?.request || DEFAULT_REQUEST_TIMEOUT, `MCP ${server.name} tools/list`);
      const tools = (listed.tools || []).map((tool) => ({
        name: tool.name,
        publicName: publicToolName(server.name, tool.name),
        description: tool.description || `MCP tool ${tool.name} from ${server.name}`,
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
        annotations: tool.annotations,
      }));
      const entry = { client, transport, server, tools, connectedAt: Date.now() };
      clients.set(key, entry);
      failures.delete(key);
      transport.onclose = () => clients.delete(key);
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(key, { at: Date.now(), error: message });
      await transport.close?.().catch(() => {});
      throw error;
    }
  })();
  connecting.set(key, work);
  try { return await work; } finally { connecting.delete(key); }
}

async function disconnect(userDataPath, idOrName) {
  const server = await findServer(userDataPath, idOrName);
  const name = server?.name || cleanName(idOrName);
  const key = keyOf(userDataPath, name);
  failures.delete(key);
  const entry = clients.get(key);
  if (!entry) return { disconnected: false, name };
  clients.delete(key);
  await entry.client.close().catch(() => entry.transport.close?.());
  return { disconnected: true, name };
}

async function refresh(userDataPath, idOrName) {
  await disconnect(userDataPath, idOrName).catch(() => {});
  const entry = await connect(userDataPath, idOrName);
  return { server: entry.server, tools: entry.tools };
}

async function getEnabledToolSchemas(userDataPath) {
  const servers = (await readStore(userDataPath)).servers.filter((s) => s.enabled !== false);
  const settled = await Promise.allSettled(servers.map((s) => connect(userDataPath, s.name)));
  const schemas = [];
  settled.forEach((result) => {
    if (result.status !== "fulfilled") return;
    for (const tool of result.value.tools) schemas.push({ name: tool.publicName, description: `[MCP: ${result.value.server.title || result.value.server.name}] ${tool.description}`, inputSchema: tool.inputSchema, isReadOnly: false, isMcp: true, mcpServer: result.value.server.name, mcpTool: tool.name });
  });
  return schemas;
}

async function resolvePublicTool(userDataPath, publicName) {
  const servers = (await readStore(userDataPath)).servers.filter((s) => s.enabled !== false);
  for (const server of servers) {
    try {
      const entry = clients.get(keyOf(userDataPath, server.name)) || await connect(userDataPath, server.name);
      const tool = entry.tools.find((t) => t.publicName === publicName);
      if (tool) return { entry, tool };
    } catch {
      // One unavailable server must not hide tools from the remaining MCP servers.
    }
  }
  return null;
}

async function callPublicTool(userDataPath, publicName, args, { signal } = {}) {
  const resolved = await resolvePublicTool(userDataPath, publicName);
  if (!resolved) throw new Error(`Unknown MCP tool: ${publicName}`);
  if (signal?.aborted) throw new Error("Stopped by user");
  return timed(resolved.entry.client.callTool({ name: resolved.tool.name, arguments: args || {} }), resolved.entry.server.timeout?.request || DEFAULT_REQUEST_TIMEOUT, `MCP tool ${resolved.tool.name}`);
}

async function inspectServer(userDataPath, idOrName) {
  const entry = await connect(userDataPath, idOrName);
  const requestMs = entry.server.timeout?.request || DEFAULT_REQUEST_TIMEOUT;
  const [prompts, resources, templates] = await Promise.allSettled([
    timed(entry.client.listPrompts(), requestMs, "MCP prompts/list"),
    timed(entry.client.listResources(), requestMs, "MCP resources/list"),
    timed(entry.client.listResourceTemplates(), requestMs, "MCP resources/templates/list"),
  ]);
  return { server: entry.server, tools: entry.tools, prompts: prompts.status === "fulfilled" ? prompts.value.prompts || [] : [], resources: resources.status === "fulfilled" ? resources.value.resources || [] : [], resourceTemplates: templates.status === "fulfilled" ? templates.value.resourceTemplates || [] : [] };
}

async function importConfig(userDataPath, config, { overwrite = false } = {}) {
  const source = typeof config === "string" ? JSON.parse(config) : config || {};
  const map = source.mcpServers || source.mcp?.servers || source.servers || {};
  const results = [];
  for (const [name, raw] of Object.entries(map)) {
    const input = { ...raw, name, enabled: raw.disabled === true ? false : raw.enabled };
    if (Array.isArray(raw.command)) input.command = raw.command;
    else if (raw.command) { input.command = raw.command; input.args = raw.args || []; }
    input.environment = raw.environment || raw.env;
    const existing = await findServer(userDataPath, name);
    if (existing && overwrite) results.push(await updateServer(userDataPath, existing.id, input));
    else if (!existing) results.push(await addServer(userDataPath, input));
  }
  return { imported: results.length, servers: results };
}

async function disposeAll() {
  const entries = [...clients.values()];
  clients.clear();
  failures.clear();
  await Promise.allSettled(entries.map((entry) => entry.client.close()));
  return { disconnected: entries.length };
}

module.exports = { storePath, cleanName, publicToolName, normalizeServer, readStore, listServers, findServer, addServer, updateServer, removeServer, connect, disconnect, refresh, inspectServer, importConfig, getEnabledToolSchemas, resolvePublicTool, callPublicTool, disposeAll };
