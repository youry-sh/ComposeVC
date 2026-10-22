const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_FILE = "mcp-servers.json";
const PROJECTS_FILE = "mcp-projects.json";
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
    environment: { ...(existing?.environment || {}), ...(input.environment || input.env || {}) },
    url: type === "remote" ? String(input.url !== undefined ? input.url : existing?.url || "").trim() : undefined,
    headers: type === "remote" ? { ...(existing?.headers || {}), ...(input.headers || {}) } : undefined,
    timeout: {
      startup: Math.max(1000, Number(input.timeout?.startup ?? input.startupTimeout ?? existing?.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT)),
      request: Math.max(1000, Number(input.timeout?.request ?? input.requestTimeout ?? existing?.timeout?.request ?? DEFAULT_REQUEST_TIMEOUT)),
    },
    marketplace: input.marketplace !== undefined ? input.marketplace : existing?.marketplace,
    envSpec: Array.isArray(input.envSpec) ? input.envSpec : existing?.envSpec,
    headerSpec: Array.isArray(input.headerSpec) ? input.headerSpec : existing?.headerSpec,
    needsProjectPath: input.needsProjectPath !== undefined ? input.needsProjectPath === true : existing?.needsProjectPath === true,
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

function resolveLocalCommand(command) {
  const cmd = String(command || "").trim();
  if (process.platform !== "win32") return cmd;
  if (cmd === "npx") return "npx.cmd";
  if (cmd === "npm") return "npm.cmd";
  if (cmd === "uvx") return "uvx.exe";
  return cmd;
}

function applyProject(server, rootPath) {
  const expand = (value) => {
    if (typeof value !== "string") return value;
    if (!value.includes("{project}")) return value;
    if (!rootPath) throw new Error("Open a project folder and enable this server in Connector");
    return value.split("{project}").join(rootPath);
  };
  const args = (server.args || []).map((arg) => expand(String(arg)));
  const environment = Object.fromEntries(
    Object.entries(server.environment || {}).map(([key, value]) => [key, expand(expandEnv(String(value)))])
  );
  let cwd = server.cwd ? expand(String(server.cwd)) : undefined;
  if (!cwd && server.needsProjectPath && rootPath) cwd = rootPath;
  return {
    ...server,
    command: resolveLocalCommand(server.command),
    args,
    cwd: cwd || undefined,
    environment,
    headers: prepareRemoteHeaders(server, expand),
  };
}

function prepareRemoteHeaders(server, expand) {
  const { isPlaceholderSecret, applySecretValue } = require("./mcpRegistry.cjs");
  const headers = {};
  for (const [key, value] of Object.entries(server.headers || {})) {
    const text = expand(expandEnv(String(value || ""))).trim();
    if (!text || isPlaceholderSecret(text)) continue;
    headers[key] = /^authorization$/i.test(key) ? applySecretValue({ name: "Authorization" }, text) : text;
  }
  if (!headers.Authorization && !headers.authorization) {
    for (const [key, value] of Object.entries(server.environment || {})) {
      if (!/key|token|secret|auth/i.test(key)) continue;
      const formatted = applySecretValue({ name: "Authorization" }, expand(expandEnv(String(value || ""))));
      if (formatted) {
        headers.Authorization = formatted;
        break;
      }
    }
  }
  return headers;
}

async function makeTransport(server, rootPath) {
  const bound = applyProject(server, rootPath);
  if (bound.type === "local") {
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
    return new StdioClientTransport({
      command: bound.command,
      args: bound.args || [],
      cwd: bound.cwd || undefined,
      env: bound.environment || {},
      stderr: "pipe",
    });
  }
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const hasAuth = Boolean(bound.headers?.Authorization || bound.headers?.authorization);
  const needsAuth = (bound.headerSpec || []).some((item) => item.required && /^authorization$/i.test(item.name || ""));
  if ((needsAuth || bound.type === "remote") && !hasAuth && needsAuth) {
    throw new Error(`${bound.title || bound.name}: API key was not saved. Open MCP Marketplace → Installed, paste the key, and press Save settings.`);
  }
  return new StreamableHTTPClientTransport(new URL(bound.url), { requestInit: { headers: bound.headers || {} } });
}

async function connect(userDataPath, idOrName, { force = false, rootPath = null } = {}) {
  const server = await findServer(userDataPath, idOrName);
  if (!server) throw new Error(`MCP server not found: ${idOrName}`);
  if (server.enabled === false && !force) throw new Error(`MCP server is disabled: ${server.name}`);
  const key = keyOf(userDataPath, server.name);
  const boundRoot = rootPath || "";
  const headerStamp = `${JSON.stringify(server.headers || {})}\n${JSON.stringify(server.environment || {})}`;
  const rebind = server.needsProjectPath === true || JSON.stringify(server.args || []).includes("{project}") || headerStamp.includes("{project}");
  const cached = clients.get(key);
  if (cached && (!rebind || (cached.rootPath || "") === boundRoot) && cached.headerStamp === headerStamp) return cached;
  if (cached) await disconnect(userDataPath, server.name).catch(() => {});
  const pending = connecting.get(key);
  if (pending) return pending;
  const recentFailure = failures.get(key);
  if (!force && recentFailure && Date.now() - recentFailure.at < FAILURE_RETRY_MS) {
    throw new Error(recentFailure.error);
  }
  const work = (async () => {
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "composevc", version: "1.0.1" });
    const transport = await makeTransport(server, rootPath);
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
      const entry = { client, transport, server, tools, connectedAt: Date.now(), rootPath: boundRoot, headerStamp };
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

async function getEnabledToolSchemas(userDataPath, { rootPath = null } = {}) {
  const allowed = await projectIdSet(userDataPath, rootPath);
  if (!allowed) return [];
  const servers = (await readStore(userDataPath)).servers.filter((s) => s.enabled !== false && allowed.has(s.id));
  const settled = await Promise.allSettled(servers.map((s) => connect(userDataPath, s.name, { rootPath })));
  const schemas = [];
  settled.forEach((result) => {
    if (result.status !== "fulfilled") return;
    for (const tool of result.value.tools) schemas.push({ name: tool.publicName, description: `[MCP: ${result.value.server.title || result.value.server.name}] ${tool.description}`, inputSchema: tool.inputSchema, isReadOnly: false, isMcp: true, mcpServer: result.value.server.name, mcpTool: tool.name });
  });
  return schemas;
}

async function resolvePublicTool(userDataPath, publicName, { rootPath = null } = {}) {
  const allowed = await projectIdSet(userDataPath, rootPath);
  if (!allowed) return null;
  const servers = (await readStore(userDataPath)).servers.filter((s) => s.enabled !== false && allowed.has(s.id));
  for (const server of servers) {
    try {
      const entry = clients.get(keyOf(userDataPath, server.name)) || await connect(userDataPath, server.name, { rootPath });
      const tool = entry.tools.find((t) => t.publicName === publicName);
      if (tool) return { entry, tool };
    } catch {
      // One unavailable server must not hide tools from the remaining MCP servers.
    }
  }
  return null;
}

async function callPublicTool(userDataPath, publicName, args, { signal, rootPath = null } = {}) {
  const resolved = await resolvePublicTool(userDataPath, publicName, { rootPath });
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

function projectsPath(userDataPath) {
  return path.join(userDataPath, PROJECTS_FILE);
}

function projectKey(rootPath) {
  if (!rootPath) return "";
  return path.resolve(String(rootPath)).replace(/[\\/]+$/, "").toLowerCase();
}

async function readProjects(userDataPath) {
  try {
    const raw = await fs.promises.readFile(projectsPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {} };
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, projects: {} };
    throw error;
  }
}

async function writeProjects(userDataPath, store) {
  const file = projectsPath(userDataPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify({ version: 1, projects: store.projects }, null, 2), "utf8");
  await fs.promises.rename(temp, file);
}

async function projectIdSet(userDataPath, rootPath) {
  const key = projectKey(rootPath);
  if (!key) return null;
  const store = await readProjects(userDataPath);
  return new Set(Array.isArray(store.projects[key]) ? store.projects[key] : []);
}

async function listProjectServers(userDataPath, rootPath) {
  const key = projectKey(rootPath);
  if (!key) return { rootPath: null, serverIds: [] };
  const store = await readProjects(userDataPath);
  return { rootPath: key, serverIds: Array.isArray(store.projects[key]) ? store.projects[key] : [] };
}

async function setProjectServer(userDataPath, rootPath, serverId, enabled) {
  const key = projectKey(rootPath);
  if (!key) throw new Error("Open a project folder first");
  const server = await findServer(userDataPath, serverId);
  if (!server) throw new Error("MCP server not found");
  const store = await readProjects(userDataPath);
  const next = new Set(Array.isArray(store.projects[key]) ? store.projects[key] : []);
  if (enabled) next.add(server.id);
  else next.delete(server.id);
  store.projects[key] = [...next];
  await writeProjects(userDataPath, store);
  if (!enabled) await disconnect(userDataPath, server.name).catch(() => {});
  return { rootPath: key, serverIds: store.projects[key], server };
}

async function installRegistryServer(userDataPath, raw, overrides = {}) {
  const { toServerInput } = require("./mcpRegistry.cjs");
  const input = toServerInput(raw, overrides);
  const store = await readStore(userDataPath);
  const registryName = input.marketplace?.name;
  const existing = store.servers.find((server) => registryName && server.marketplace?.name === registryName)
    || store.servers.find((server) => server.name === input.name);
  if (existing) {
    const patch = {};
    if (input.headerSpec) patch.headerSpec = input.headerSpec;
    if (input.envSpec) patch.envSpec = input.envSpec;
    if (input.headers && Object.keys(input.headers).length) patch.headers = input.headers;
    if (input.environment && Object.keys(input.environment).length) patch.environment = input.environment;
    if (!Object.keys(patch).length) return { installed: false, already: true, server: existing, warnings: input.warnings || [] };
    const savedSecret = Boolean(
      (patch.headers && Object.keys(patch.headers).length) ||
      (patch.environment && Object.keys(patch.environment).length)
    );
    const server = await updateServer(userDataPath, existing.id, patch);
    return { installed: savedSecret, already: true, updated: savedSecret, server, warnings: input.warnings || [] };
  }
  let name = input.name;
  if (store.servers.some((server) => server.name === name)) {
    name = cleanName(`${name}-${crypto.createHash("sha1").update(registryName || name).digest("hex").slice(0, 4)}`);
  }
  const server = await addServer(userDataPath, { ...input, name, enabled: true });
  return { installed: true, already: false, server, warnings: input.warnings || [] };
}

async function disposeAll() {
  const entries = [...clients.values()];
  clients.clear();
  failures.clear();
  await Promise.allSettled(entries.map((entry) => entry.client.close()));
  return { disconnected: entries.length };
}

module.exports = { storePath, cleanName, publicToolName, normalizeServer, readStore, listServers, findServer, addServer, updateServer, removeServer, connect, disconnect, refresh, inspectServer, importConfig, getEnabledToolSchemas, resolvePublicTool, callPublicTool, disposeAll, listProjectServers, setProjectServer, installRegistryServer };
