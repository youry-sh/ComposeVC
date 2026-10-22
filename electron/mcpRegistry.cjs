const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

function cleanName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function looksLikePathArg(arg) {
  const blob = `${arg?.name || ""} ${arg?.valueHint || ""} ${arg?.description || ""}`.toLowerCase();
  return /path|dir|root|folder|cwd|directory|workspace/.test(blob);
}

function argTokens(list) {
  const out = [];
  for (const arg of list || []) {
    if (!arg || typeof arg !== "object") continue;
    if (arg.type === "named" && arg.name) out.push(String(arg.name));
    if (arg.value != null && String(arg.value).trim()) out.push(String(arg.value));
  }
  return out;
}

function pickPackage(packages) {
  const list = Array.isArray(packages) ? packages : [];
  const stdio = list.find((pkg) => !pkg.transport || pkg.transport.type === "stdio");
  return stdio || null;
}

function pickRemote(remotes) {
  const list = Array.isArray(remotes) ? remotes : [];
  return list.find((remote) => remote?.type === "streamable-http" && remote.url)
    || list.find((remote) => remote?.url)
    || null;
}

function isPlaceholderSecret(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  if (/\{[^}]+\}/.test(text)) return true;
  return /your_api_key|your_token|api_key_here|replace_me|insert[_ -]?key|<.*>/i.test(text);
}

function applySecretValue(spec, raw) {
  const value = String(raw || "").trim();
  if (isPlaceholderSecret(value)) return "";
  const name = String(spec?.name || "");
  const template = String(spec?.value || "");
  if (/^authorization$/i.test(name)) {
    if (/^(bearer|basic)\s+\S+/i.test(value)) return value;
    return `Bearer ${value}`;
  }
  if (template && /\{[^}]+\}/.test(template)) {
    const filled = template.replace(/\{[^}]+\}/g, value);
    if (!isPlaceholderSecret(filled)) return filled;
  }
  return value;
}

function runtimeCommand(pkg) {
  const hint = String(pkg.runtimeHint || "").toLowerCase();
  if (hint === "uvx" || pkg.registryType === "pypi") return "uvx";
  if (hint === "docker" || pkg.registryType === "oci") return "docker";
  if (hint === "python") return "python";
  if (hint === "node") return "node";
  return "npx";
}

function toServerInput(raw, overrides = {}) {
  const server = raw?.server || raw || {};
  const registryName = String(server.name || "").trim();
  if (!registryName) throw new Error("Registry server has no name");
  const pkg = pickPackage(server.packages);
  const remote = pickRemote(server.remotes);
  const warnings = [];
  const base = {
    name: cleanName(registryName),
    title: String(server.title || registryName).slice(0, 120),
    description: String(server.description || "").slice(0, 500),
    enabled: true,
    marketplace: {
      registry: "https://registry.modelcontextprotocol.io",
      name: registryName,
      version: server.version || "",
      repository: server.repository?.url || "",
    },
    warnings,
  };
  if (!base.name) throw new Error("Cannot derive a local server name");
  const envOverride = overrides.environment && typeof overrides.environment === "object" ? overrides.environment : {};
  const headerOverride = overrides.headers && typeof overrides.headers === "object" ? overrides.headers : {};

  if (pkg) {
    const command = runtimeCommand(pkg);
    const args = argTokens(pkg.runtimeArguments);
    if (command === "npx" && !args.includes("-y")) args.unshift("-y");
    const ident = String(pkg.identifier || "").trim();
    if (!ident) throw new Error("Registry package has no identifier");
    const version = pkg.version ? String(pkg.version) : "";
    if (command === "docker") {
      args.push("run", "-i", "--rm", version ? `${ident}:${version}` : ident);
    } else if (command === "uvx") {
      args.push(version ? `${ident}==${version}` : ident);
    } else if (pkg.registryType === "npm" || command === "npx" || command === "node") {
      args.push(version ? `${ident}@${version}` : ident);
    } else {
      args.push(ident);
    }
    let needsProjectPath = false;
    for (const arg of pkg.packageArguments || []) {
      if (arg?.value != null && String(arg.value).trim()) {
        if (arg.type === "named" && arg.name) args.push(String(arg.name));
        args.push(String(arg.value));
        continue;
      }
      if (arg?.isRequired && looksLikePathArg(arg)) {
        if (arg.type === "named" && arg.name) args.push(String(arg.name));
        args.push("{project}");
        needsProjectPath = true;
        continue;
      }
      if (arg?.isRequired) warnings.push(`Argument ${arg.name || arg.valueHint || "value"} was left unset`);
    }
    const envSpec = [];
    const environment = {};
    for (const item of pkg.environmentVariables || []) {
      if (!item?.name) continue;
      envSpec.push({
        name: String(item.name),
        description: String(item.description || ""),
        required: item.isRequired === true,
        secret: item.isSecret === true,
      });
      const override = envOverride[item.name];
      if (override != null && String(override).trim()) environment[item.name] = String(override);
      else if (item.value && !item.isSecret && !String(item.value).includes("{")) environment[item.name] = String(item.value);
      else if (item.isRequired) warnings.push(`Set ${item.name} before this server can connect`);
    }
    return { ...base, type: "local", command, args, environment, envSpec, needsProjectPath };
  }

  if (remote?.url) {
    const headerSpec = [];
    const headers = {};
    for (const item of remote.headers || []) {
      if (!item?.name) continue;
      headerSpec.push({
        name: String(item.name),
        description: String(item.description || ""),
        required: item.isRequired === true,
        secret: item.isSecret === true,
      });
      const override = headerOverride[item.name];
      const formatted = applySecretValue(item, override);
      if (formatted) headers[item.name] = formatted;
      else if (item.value && !item.isSecret && !isPlaceholderSecret(item.value)) headers[item.name] = String(item.value);
      else if (item.isRequired) warnings.push(`Set header ${item.name} before this server can connect`);
    }
    if (!headerSpec.some((item) => /^authorization$/i.test(item.name))) {
      headerSpec.unshift({ name: "Authorization", description: "Bearer API key", required: true, secret: true });
    }
    const directAuth = applySecretValue({ name: "Authorization" }, headerOverride.Authorization);
    if (directAuth) headers.Authorization = directAuth;
    for (const [key, value] of Object.entries(envOverride)) {
      if (!/key|token|secret|auth/i.test(key)) continue;
      const formatted = applySecretValue({ name: "Authorization" }, value);
      if (formatted && !headers.Authorization) headers.Authorization = formatted;
    }
    return { ...base, type: "remote", url: String(remote.url), headers, headerSpec, environment: {} };
  }

  throw new Error("This server has no installable package or remote endpoint");
}

function summarize(row) {
  const server = row?.server || {};
  const pkg = pickPackage(server.packages);
  const remote = pickRemote(server.remotes);
  const transport = pkg ? "local" : remote ? "remote" : "unknown";
  return {
    name: server.name || "",
    title: server.title || server.name || "MCP server",
    description: server.description || "",
    version: server.version || "",
    repository: server.repository?.url || "",
    transport,
    packageName: pkg?.identifier || "",
    runtime: pkg ? runtimeCommand(pkg) : "",
    remoteUrl: remote?.url || "",
    raw: row,
  };
}

async function searchRegistry({ query = "", cursor = "", limit = 24 } = {}) {
  const url = new URL(REGISTRY_URL);
  url.searchParams.set("limit", String(Math.min(48, Math.max(1, Number(limit) || 24))));
  url.searchParams.set("version", "latest");
  const q = String(query || "").trim();
  if (q) url.searchParams.set("search", q);
  if (cursor) url.searchParams.set("cursor", String(cursor));
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Official MCP registry returned ${response.status}`);
  const data = await response.json();
  const servers = (Array.isArray(data.servers) ? data.servers : []).map(summarize).filter((item) => item.name);
  return {
    registry: "https://registry.modelcontextprotocol.io",
    servers,
    nextCursor: data.metadata?.nextCursor || null,
    count: Number(data.metadata?.count || servers.length),
  };
}

module.exports = { searchRegistry, toServerInput, summarize, REGISTRY_URL, isPlaceholderSecret, applySecretValue };
