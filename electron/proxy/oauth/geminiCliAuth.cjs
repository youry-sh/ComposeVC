/**
 * Gemini CLI auth: token refresh, loadCodeAssist / onboardUser project bootstrap,
 * local oauth_creds import (~/.gemini/oauth_creds.json).
 *
 * Notes (2026-06+):
 *  - Free / "Gemini Code Assist for individuals" is deprecated (UNSUPPORTED_CLIENT).
 *  - Standard tier requires a user-defined GCP project (userDefinedCloudaicompanionProject).
 *  - Auto project assignment no longer works for consumers; we bind via onboardUser(project).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const creds = require("./geminiCliCreds.cjs");

/** @type {Map<string, { projectId: string, tier: string|null, note?: string|null }>} */
const projectCache = new Map();

function toRecord(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function nonEmpty(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t || null;
}

function localTokenPath() {
  if (process.env.GEMINI_TOKEN_FILE && process.env.GEMINI_TOKEN_FILE.trim()) {
    return process.env.GEMINI_TOKEN_FILE.trim();
  }
  return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}

function parseOauthCredsFile(raw) {
  const doc = toRecord(raw);
  const token =
    doc.token && typeof doc.token === "object"
      ? toRecord(doc.token)
      : doc.credentials && typeof doc.credentials === "object"
        ? toRecord(doc.credentials)
        : doc;

  const accessToken = nonEmpty(token.access_token) || nonEmpty(token.accessToken);
  const refreshToken = nonEmpty(token.refresh_token) || nonEmpty(token.refreshToken);
  if (!accessToken) throw new Error("access_token missing in oauth_creds.json");
  if (!refreshToken) throw new Error("refresh_token missing in oauth_creds.json");

  let expiresAt = null;
  if (typeof token.expiry_date === "number" && Number.isFinite(token.expiry_date)) {
    expiresAt = token.expiry_date;
  } else if (typeof token.expires_at === "number") {
    expiresAt = token.expires_at;
  } else {
    const iso = nonEmpty(token.expiry) || nonEmpty(token.expires_at);
    if (iso) {
      const ms = Date.parse(iso);
      expiresAt = Number.isFinite(ms) ? ms : null;
    } else if (token.expires_in) {
      expiresAt = Date.now() + Number(token.expires_in) * 1000;
    }
  }

  return {
    accessToken,
    refreshToken,
    tokenType: nonEmpty(token.token_type) || "Bearer",
    expiresAt,
  };
}

function readLocalGeminiAuthFile() {
  const p = localTokenPath();
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      error: `Not found: ${p}. Install Gemini CLI, run: gemini, sign in with Google, then Import CLI.`,
      path: p,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const parsed = parseOauthCredsFile(raw);
    return { ok: true, path: p, ...parsed };
  } catch (e) {
    return { ok: false, error: e.message || String(e), path: p };
  }
}

async function fetchFirstOk(urls, init, timeoutMs = 10000) {
  let lastErr = null;
  const signal = AbortSignal.timeout(timeoutMs);
  for (const url of urls) {
    try {
      const res = await fetch(url, { ...init, signal });
      if (res.ok) return res;
      lastErr = new Error(`${res.status} ${await res.text().catch(() => "")}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Gemini Code Assist endpoints unavailable");
}

function extractProjectId(data) {
  const d = toRecord(data);
  const candidates = [
    d.cloudaicompanionProject,
    d.cloudAiCompanionProject,
    d.project,
    d.projectId,
    toRecord(d.cloudaicompanionProject).id,
    toRecord(d.cloudAiCompanionProject).id,
    toRecord(d.project).id,
    toRecord(d.response).cloudaicompanionProject,
    toRecord(toRecord(d.response).cloudaicompanionProject).id,
    toRecord(d.done).cloudaicompanionProject,
    toRecord(toRecord(d.done).cloudaicompanionProject).id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim().replace(/^projects\//, "");
    }
    if (c && typeof c === "object") {
      const id = nonEmpty(c.id) || nonEmpty(c.name) || nonEmpty(c.projectId);
      if (id) return id.replace(/^projects\//, "");
    }
  }
  return null;
}

function extractTier(data) {
  const d = toRecord(data);
  const paid = toRecord(d.paidTier);
  const current = toRecord(d.currentTier);
  const allowed = Array.isArray(d.allowedTiers) ? d.allowedTiers : [];
  const defaultAllowed = allowed.map(toRecord).find((t) => t.isDefault) || toRecord(allowed[0]);

  return (
    nonEmpty(d.tierId) ||
    nonEmpty(paid.id) ||
    nonEmpty(paid.name) ||
    nonEmpty(current.id) ||
    nonEmpty(current.name) ||
    nonEmpty(defaultAllowed.id) ||
    nonEmpty(defaultAllowed.name) ||
    null
  );
}

function extractOnboardTierId(data) {
  const d = toRecord(data);
  const paid = toRecord(d.paidTier);
  if (nonEmpty(paid.id)) return paid.id;
  const current = toRecord(d.currentTier);
  if (nonEmpty(current.id)) return current.id;
  const allowed = Array.isArray(d.allowedTiers) ? d.allowedTiers.map(toRecord) : [];
  const def = allowed.find((t) => t.isDefault) || allowed[0];
  if (nonEmpty(def?.id)) return def.id;
  return "standard-tier";
}

function needsUserDefinedProject(data) {
  const d = toRecord(data);
  const allowed = Array.isArray(d.allowedTiers) ? d.allowedTiers.map(toRecord) : [];
  return allowed.some((t) => t.userDefinedCloudaicompanionProject === true);
}

function freeTierUnsupportedMessage(data) {
  const d = toRecord(data);
  const ineligible = Array.isArray(d.ineligibleTiers) ? d.ineligibleTiers.map(toRecord) : [];
  for (const t of ineligible) {
    if (
      t.reasonCode === "UNSUPPORTED_CLIENT" ||
      /no longer supported|migrate to the Antigravity/i.test(String(t.reasonMessage || ""))
    ) {
      return (
        nonEmpty(t.reasonMessage) ||
        "Gemini Code Assist for individuals is no longer supported. Use Antigravity or a GCP project with Code Assist Standard/Enterprise."
      );
    }
  }
  return null;
}

/** Metadata variants accepted by Cloud Code (GEMINI ideType is invalid). */
const METADATA_VARIANTS = [
  {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  },
  {
    ideType: "IDE_UNSPECIFIED",
    pluginType: "GEMINI",
  },
  { ideType: "VSCODE", pluginType: "GEMINI" },
  { ideType: "ANTIGRAVITY" },
];

function isCloudCodeSibling(providerId) {
  return (
    providerId === "antigravity" ||
    providerId === "agy" ||
    providerId === "gemini-cli"
  );
}

/**
 * Collect candidate GCP project ids from env, hints, sibling Cloud Code accounts.
 * OmniRoute parity: Antigravity/agy already own a Cloud Code project — reuse it.
 * Order: explicit → env → same-email siblings → any Cloud Code sibling.
 * @param {{ preferredProjectId?: string|null, accounts?: any[], email?: string|null }} opts
 */
function collectPreferredProjects(opts = {}) {
  const out = [];
  const push = (v) => {
    const id = nonEmpty(v);
    if (id && !out.includes(id)) out.push(id);
  };
  push(opts.preferredProjectId);
  push(process.env.GOOGLE_CLOUD_PROJECT);
  push(process.env.GCLOUD_PROJECT);
  push(process.env.GEMINI_CLOUD_PROJECT);
  push(process.env.CLOUDAI_PROJECT);

  const email = nonEmpty(opts.email)?.toLowerCase();
  const accounts = Array.isArray(opts.accounts) ? opts.accounts : [];

  // 1) same Google email first (best license match)
  for (const a of accounts) {
    if (!a || typeof a !== "object" || !isCloudCodeSibling(a.providerId)) continue;
    const aEmail = nonEmpty(a.email)?.toLowerCase();
    if (email && aEmail && aEmail !== email) continue;
    if (email && !aEmail) continue; // prefer known match when email known
    push(a.providerMeta?.projectId);
    push(a.workspaceId);
  }

  // 2) any Cloud Code sibling (OmniRoute: project is account-scoped to Google, often shared)
  for (const a of accounts) {
    if (!a || typeof a !== "object" || !isCloudCodeSibling(a.providerId)) continue;
    push(a.providerMeta?.projectId);
    push(a.workspaceId);
  }
  return out;
}

async function loadCodeAssistOnce(accessToken, metadata) {
  const res = await fetchFirstOk(
    creds.loadCodeAssistUrls(),
    {
      method: "POST",
      headers: creds.headers("loadCodeAssist", accessToken),
      body: JSON.stringify({ metadata }),
    },
    12000
  );
  return toRecord(await res.json());
}

async function onboardWithProject(accessToken, { tierId, projectId, metadata }) {
  const body = {
    tierId: tierId || "standard-tier",
    metadata: metadata || METADATA_VARIANTS[0],
  };
  // Cloud Code expects a scalar project id string
  if (projectId) body.cloudaicompanionProject = String(projectId);

  const res = await fetchFirstOk(
    creds.onboardUserUrls(),
    {
      method: "POST",
      headers: creds.headers("loadCodeAssist", accessToken),
      body: JSON.stringify(body),
    },
    15000
  );
  return toRecord(await res.json());
}

/**
 * Discover / bind Cloud Code project for Gemini CLI token.
 * @param {string} accessToken
 * @param {{ preferredProjectId?: string|null, preferredProjects?: string[], accounts?: any[], email?: string|null }} [opts]
 */
async function ensureProjectAssigned(accessToken, opts = {}) {
  if (!accessToken) return { projectId: null, tier: null, error: "no token" };

  const preferred = [
    ...(Array.isArray(opts.preferredProjects) ? opts.preferredProjects : []),
    ...collectPreferredProjects(opts),
  ].filter(Boolean);
  // de-dupe
  const preferredUnique = [...new Set(preferred.map((p) => String(p).trim()).filter(Boolean))];

  const cacheKey =
    accessToken.slice(0, 24) +
    accessToken.slice(-12) +
    "|" +
    preferredUnique.join(",");
  if (projectCache.has(cacheKey)) {
    return { ...projectCache.get(cacheKey), cached: true };
  }

  let lastData = null;
  let lastErr = null;
  let deprecationNote = null;
  let userDefined = false;

  for (const metadata of METADATA_VARIANTS) {
    try {
      const data = await loadCodeAssistOnce(accessToken, metadata);
      lastData = data;
      deprecationNote = freeTierUnsupportedMessage(data) || deprecationNote;
      userDefined = needsUserDefinedProject(data) || userDefined;

      const projectId = extractProjectId(data);
      const tier = extractTier(data);
      if (projectId) {
        const out = { projectId, tier, error: null, note: deprecationNote };
        projectCache.set(cacheKey, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  const tierId = lastData ? extractOnboardTierId(lastData) : "standard-tier";
  const metadata = METADATA_VARIANTS[0];

  // Bind preferred GCP projects (required for standard-tier / userDefined)
  for (const project of preferredUnique) {
    try {
      const data = await onboardWithProject(accessToken, {
        tierId,
        projectId: project,
        metadata,
      });
      const projectId = extractProjectId(data) || project;
      if (projectId) {
        const out = {
          projectId,
          tier: extractTier(data) || tierId,
          error: null,
          note:
            toRecord(toRecord(data.response).status).displayMessage ||
            deprecationNote ||
            null,
        };
        projectCache.set(cacheKey, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // onboard without project (legacy free-tier path — usually fails post-2026)
  if (!userDefined || preferredUnique.length === 0) {
    try {
      const data = await onboardWithProject(accessToken, {
        tierId: "free-tier",
        projectId: "",
        metadata,
      });
      const projectId = extractProjectId(data);
      if (projectId) {
        const out = {
          projectId,
          tier: extractTier(data) || "free-tier",
          error: null,
          note: deprecationNote,
        };
        projectCache.set(cacheKey, out);
        return out;
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // Soft warning only — OmniRoute never blocks OAuth/account add on missing projectId
  // (#338: log + continue; Antigravity path auto-assigns; gemini free tier is deprecated).
  let note =
    deprecationNote ||
    "GCP project not auto-assigned (Google free Code Assist discontinued). " +
      "Sign in Antigravity with the same Google account first, or set Project ID on the account.";

  if (userDefined || /standard-tier/i.test(tierId)) {
    note =
      "Needs GCP project (user-defined). Reused from Antigravity/agy if available, else set Project ID or GOOGLE_CLOUD_PROJECT.";
  }

  return {
    projectId: null,
    tier: lastData ? extractTier(lastData) : null,
    // not a hard error — account add / OAuth must still succeed (OmniRoute parity)
    error: null,
    note,
    needsUserProject: true,
    softWarning: note,
  };
}

async function enrichWithBackend(accessToken, opts = {}) {
  let email = null;
  let name = null;

  try {
    const res = await fetch(`${creds.USERINFO_URL}?alt=json`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const j = await res.json();
      email = nonEmpty(j.email);
      name = nonEmpty(j.name) || nonEmpty(j.given_name);
    }
  } catch {
    /* */
  }

  // If caller didn't pass siblings yet, allow a second pass after email is known
  let proj = await ensureProjectAssigned(accessToken, {
    ...opts,
    email: opts.email || email,
  });
  // Retry once if no project but we have more accounts now (email resolved)
  if (!proj.projectId && (opts.accounts || []).length && (opts.email || email)) {
    projectCache.clear();
    proj = await ensureProjectAssigned(accessToken, {
      ...opts,
      email: opts.email || email,
    });
  }
  return {
    email,
    name,
    projectId: proj.projectId,
    tier: proj.tier,
    // soft only — never fail OAuth because of project
    projectError: null,
    projectNote: proj.note || proj.softWarning || null,
    needsUserProject: Boolean(proj.needsUserProject && !proj.projectId),
  };
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) throw new Error("refresh_token required");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: creds.CLIENT_ID,
    client_secret: creds.CLIENT_SECRET,
  });
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": creds.geminiCliUserAgent(),
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`Gemini CLI token refresh failed (${res.status}): ${t.slice(0, 200)}`);
    if (/invalid_grant/i.test(t)) err.code = "invalid_grant";
    throw err;
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in refresh response");
  projectCache.clear();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in || 3600,
  };
}

function toAccountPayload(tokens, extra = {}) {
  const email = extra.email || "gemini-cli";
  const expiresAt =
    tokens.expiresAt != null
      ? Number(tokens.expiresAt)
      : Date.now() + (Number(tokens.expires_in) || 3600) * 1000;

  const projectId = extra.projectId || null;
  const tier = extra.tier || extra.plan || null;
  // Soft plan label — never put long "Missing GCP…" into usageError on add
  let planType = "Gemini CLI";
  if (projectId && tier) planType = `${tier} · ${projectId}`;
  else if (projectId) planType = `GCP · ${projectId}`;
  else if (tier) planType = String(tier);
  else if (extra.needsUserProject) planType = "Needs GCP project";

  return {
    providerId: "gemini-cli",
    authType: "oauth",
    name: extra.name || email,
    email,
    planType,
    workspaceId: projectId,
    accessToken: tokens.accessToken || tokens.access_token,
    refreshToken: tokens.refreshToken || tokens.refresh_token,
    idToken: null,
    expiresAt,
    apiKey: "",
    baseUrl: creds.BASE_URLS[0],
    defaultModel: "gemini-2.5-pro",
    enabled: true,
    usage: projectId
      ? null
      : {
          plan: planType,
          limitReached: false,
          quotas: {},
          note:
            extra.projectNote ||
            "Set Project ID or sign in Antigravity first (OmniRoute uses Antigravity for auto project).",
        },
    // Account add always succeeds — missing project is a soft note, not usageError
    usageError: null,
    usageUpdatedAt: projectId ? null : Date.now(),
    createdAt: Date.now(),
    providerMeta: {
      source: extra.source || "gemini_cli_oauth",
      projectId,
      tier: tier || null,
      projectNote: extra.projectNote || null,
    },
  };
}

module.exports = {
  localTokenPath,
  parseOauthCredsFile,
  readLocalGeminiAuthFile,
  enrichWithBackend,
  ensureProjectAssigned,
  collectPreferredProjects,
  refreshAccessToken,
  toAccountPayload,
  fetchFirstOk,
  extractProjectId,
  projectCache,
};
