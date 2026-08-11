/**
 * Dynamic OpenAI-compatible custom providers (user-defined endpoint + name + models).
 * Each entry in store.customProviders becomes a full provider module so accounts
 * with that providerId participate in multi-key rotation like a6api / orcarouter.
 */

function slugifyProviderId(name, fallback = "custom") {
  const base = String(name || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || fallback;
}

function normalizeEndpoint(url) {
  let s = String(url || "").trim();
  if (!s) return "";
  // Accept host without scheme
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, "");
  // Strip trailing /chat/completions so buildUrl can append consistently
  s = s.replace(/\/chat\/completions$/i, "");
  return s;
}

/**
 * Build a provider module from a stored custom provider record.
 * @param {{ id: string, name?: string, baseUrl: string, modelTag?: string, description?: string, failoverOnAnyError?: boolean, maxFailoverAttempts?: number }} rec
 */
function createCustomProviderModule(rec) {
  if (!rec?.id) throw new Error("custom provider requires id");
  const id = String(rec.id).trim();
  const name = String(rec.name || id).trim() || id;
  const base = normalizeEndpoint(rec.baseUrl);
  if (!base) throw new Error("custom provider requires baseUrl / endpoint");
  const modelTag = String(rec.modelTag || id)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || id;
  const maxFailover =
    rec.maxFailoverAttempts != null ? Number(rec.maxFailoverAttempts) || 30 : 30;

  return {
    id,
    name,
    alias: modelTag,
    modelTag,
    modelTags: Array.from(new Set([modelTag, id.toLowerCase()].filter(Boolean))),
    wireFormat: "openai",
    defaultBaseUrl: base,
    consoleUrl: null,
    supportsOauth: false,
    supportsApiKey: true,
    supportsCliImport: false,
    probeBalance: true,
    balanceOnly: true,
    /** Models only from store.customModels[id] */
    emptyCatalog: true,
    failoverOnAnyError: rec.failoverOnAnyError !== false,
    maxFailoverAttempts: maxFailover,
    custom: true,
    isCustom: true,
    description:
      rec.description ||
      `Custom OpenAI-compatible · ${base} · models manual · ${modelTag}/…`,

    buildUrl(baseUrl) {
      const root = String(baseUrl || base).replace(/\/$/, "");
      if (root.includes("/chat/completions")) return root;
      if (/\/v\d+$/i.test(root)) return `${root}/chat/completions`;
      return `${root}/v1/chat/completions`;
    },

    buildHeaders(apiKey) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      };
    },

    parseStreamData(json) {
      return json;
    },
  };
}

module.exports = {
  createCustomProviderModule,
  normalizeEndpoint,
  slugifyProviderId,
};
