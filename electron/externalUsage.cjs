const usageStats = require("./proxy/usageStats.cjs");

function isLocalProxy(baseUrl) {
  try {
    const url = new URL(String(baseUrl || ""));
    const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    return localHost && (url.port === "8787" || url.port === "");
  } catch {
    return false;
  }
}

function cleanLabel(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isGeneratedId(value) {
  return /^\d{10,}-[a-z0-9]+$/i.test(cleanLabel(value));
}

function getProviderLabel(provider) {
  const name = cleanLabel(provider?.name);
  if (name && !/^provider\s+\d+$/i.test(name)) return name;
  const baseUrl = cleanLabel(provider?.baseUrl);
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, "");
    if (host) return host;
  } catch {
    /* */
  }
  const id = cleanLabel(provider?.id);
  return id && !isGeneratedId(id) ? id : "External provider";
}

function getModelLabel(model) {
  const name = cleanLabel(model?.name);
  if (name && !isGeneratedId(name)) return name;
  const id = cleanLabel(model?.id || model);
  return id && !isGeneratedId(id) ? id : "Unknown model";
}

async function recordExternalUsage({ userDataPath, provider, model, usage, stream = false } = {}) {
  if (!provider || isLocalProxy(provider.baseUrl)) return null;
  if (userDataPath) await usageStats.init(userDataPath);
  const providerId = `external:${getProviderLabel(provider)}`;
  const modelId = getModelLabel(model);
  return usageStats.record({ model: modelId, providerId, usage: usage || null, stream });
}

function trackExternalUsage(entry) {
  void recordExternalUsage(entry).catch(() => {});
}

module.exports = { recordExternalUsage, trackExternalUsage };
