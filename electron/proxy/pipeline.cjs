/**
 * Chat completions pipeline with smart multi-account failover.
 *
 * OpenAI:
 *   apikey → Platform chat/completions
 *   oauth  → Codex /codex/responses
 *
 * On rate_limit / quota / auth for one account → mark blocked, try next
 * (routing/accountRouter). When first account recovers, it is preferred again.
 */

const {
  normalizeOpenAIRequest,
  ensureToolCallIds,
  wireJsonStringify,
} = require("./openaiFormat.cjs");
const { getConverter, bootstrap: bootstrapConverters } = require("./convert/registry.cjs");
const { bootstrap: bootstrapProviders } = require("./providers/registry.cjs");
const { resolveRoute, accountToConnection } = require("./router.cjs");
const { sendSse, sendSseDone, writeSseHeaders, sendJson, sendOpenAIError } = require("./sse.cjs");
const { openaiToResponsesRequest } = require("./convert/openai-to-responses.cjs");
const {
  createResponsesStreamState,
  responsesEventToOpenAIChunks,
  responsesMessageToOpenAI,
} = require("./convert/responses-to-openai.cjs");
const { ensureFreshToken } = require("./accounts.cjs");
const { createStreamWatchdog, isRetryableOutcome } = require("./streamWatchdog.cjs");
const accountRouter = require("./routing/accountRouter.cjs");
const storeApi = require("./store.cjs");
const guard = require("./guard/index.cjs");
const {
  bareModelId,
  isInvalidModelMessage,
  resolveModelForProvider,
  providerDefaultBare,
} = require("./modelValidate.cjs");
const workerPool = require("../workerPool.cjs");

/** Max wait for upstream headers before rotating to next account (ms). */
const FAILOVER_CONNECT_TIMEOUT_MS = 60_000;
/** Keep a picked account out of the pool while its upstream attempt is in flight. */
const ACCOUNT_LEASE_TTL_MS = 45_000;
/** Soft cap so one hung key does not burn the whole attempt budget. */
const MAX_FAILOVER_ATTEMPTS = 10000;
/** Default cap for credentials tried by one client request. */
const DEFAULT_MAX_RETRY_CREDENTIALS = 50;
/** Min attempts even with a tiny account pool (allows multi-round recycle). */
const MIN_FAILOVER_ATTEMPTS = 8;
/** Max full pool recycles after every unique credential was tried once. */
const MAX_POOL_RECYCLES = 6;
const MAX_CLEAN_EMPTY_RETRIES = 5;
/** Backoff between pool recycles (ms), grows with recycle count. */
const POOL_RECYCLE_BASE_MS = 400;
const POOL_RECYCLE_MAX_MS = 4_000;

function ensureBoot() {
  bootstrapConverters();
  bootstrapProviders();
}

function isQuotaErrorMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("exceeded your current quota") ||
    m.includes("insufficient_quota") ||
    m.includes("billing") ||
    m.includes("free-usage-exhausted") ||
    m.includes("free usage exhausted") ||
    m.includes("included free usage") ||
    m.includes("usage exhausted") ||
    m.includes("balance exhausted") ||
    m.includes("usage balance") ||
    m.includes("insufficient balance") ||
    m.includes("credits exhausted") ||
    m.includes("credit exhausted") ||
    m.includes("payment required")
  );
}

/**
 * OpenAI's "Trusted Access for Cyber" gate. The upstream moderates the WHOLE
 * conversation (instructions + input) and refuses it with:
 *   "This content was flagged for possible cybersecurity risk. If this seems
 *    wrong, try rephrasing your request. To get authorized for security work,
 *    join the Trusted Access for Cyber program: https://chatgpt.com/cyber"
 * The trigger is the CONTENT, not the credential — every account in the pool
 * returns the identical rejection, so account failover is guaranteed to burn
 * the whole attempt budget on the same 502. Detect it and surface the flag in
 * the chat immediately instead.
 */
function isCyberFlagMessage(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("flagged for possible cybersecurity risk") ||
    m.includes("trusted access for cyber") ||
    m.includes("cybersecurity risk") ||
    m.includes("content was flagged")
  );
}

const CYBER_FLAG_MESSAGE =
  "🛡️ Защита OpenAI сработала — запрос заблокирован (cybersecurity risk / Trusted Access for Cyber).\n" +
  "Контент (системный промпт или запрос) помечается фильтром на КАЖДОМ аккаунте, поэтому ретраи бессмысленны.\n" +
  "Что делать: убери/переформулируй триггерные слова (Shodan, scan, exploit, hack и т.п.) в инструкции или запросе, " +
  "либо включи аккаунт в программу: https://chatgpt.com/cyber";

function cyberFlagError(message, status) {
  return {
    status: status || 502,
    error: {
      message: CYBER_FLAG_MESSAGE,
      type: "content_policy",
      code: "cyber_flag",
      param: null,
      upstream: String(message || "").split("\n")[0].slice(0, 200),
    },
  };
}

function isCapacityErrorMessage(message) {
  return /currently at capacity|high demand|capacity.?exhausted|model capacity|overloaded|priority processing|temporarily unavailable/i.test(
    String(message || "")
  );
}

function upstreamErrorMessage(payload) {
  if (!payload || typeof payload !== "object") return "Upstream stream failed";
  return String(
    payload.error?.message ||
      payload.error?.error?.message ||
      (typeof payload.error === "string" ? payload.error : "") ||
      payload.detail?.message ||
      (typeof payload.detail === "string" ? payload.detail : "") ||
      payload.message ||
      payload.reason ||
      "Upstream stream failed"
  );
}

function publicFailureMessage(message, attempts) {
  if (isCapacityErrorMessage(message)) {
    return `Request was not completed after ${attempts} automatic retry attempt(s).`;
  }
  return String(message || "Upstream request failed");
}

function operationalErrorMessage(message) {
  return isCapacityErrorMessage(message)
    ? "Temporary upstream capacity failure"
    : String(message || "Upstream failure");
}

/**
 * Merge client abort + a connect timeout so a dead/slow account fails fast
 * and the router can try the next key without waiting forever.
 * Does NOT abort mid-stream after headers arrive (caller only uses this for fetch).
 */
function withConnectTimeout(signal, ms = FAILOVER_CONNECT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => {
    try {
      ctrl.abort(signal?.reason || new Error("aborted"));
    } catch {
      /* */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      ctrl.abort(new Error(`connect_timeout_${ms}ms`));
    } catch {
      /* */
    }
  }, Math.max(1000, ms));
  if (typeof timer.unref === "function") timer.unref();

  return {
    signal: ctrl.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

/** Debounced disk persist — batch multiple routing updates into one store load+save. */
const _pendingPersist = new Set();
let _persistTimer = null;

function persistRouting(userDataPath, accountId) {
  if (!userDataPath || !accountId) return;
  _pendingPersist.add(accountId);
  if (_persistTimer) return; // already scheduled
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const ids = [..._pendingPersist];
    _pendingPersist.clear();
    if (!ids.length) return;
    setImmediate(() => {
      storeApi
        .load(userDataPath)
        .then((store) => {
          let changed = false;
          for (const id of ids) {
            const idx = store.accounts.findIndex((a) => a.id === id);
            if (idx < 0) continue;
            accountRouter.applyToAccount(store.accounts[idx]);
            changed = true;
          }
          if (changed) return storeApi.save(userDataPath, store);
          return null;
        })
        .catch(() => {});
    });
  }, 500);
  if (typeof _persistTimer.unref === "function") _persistTimer.unref();
}

/**
 * Feed real token spend into the Grok free-tier rolling 24h counter.
 * Free accounts have no quota endpoint — this is the only pre-429 signal.
 */
function recordGrokFreeTokens(account, totalTokens) {
  if (!account || account.providerId !== "grok") return;
  try {
    const n =
      typeof totalTokens === "bigint" ? Number(totalTokens) : Number(totalTokens || 0);
    if (!Number.isFinite(n) || n <= 0) return;
    const grokFreeTracker = require("./oauth/grokFreeTracker.cjs");
    grokFreeTracker.recordTokens(account, n);
  } catch {
    /* */
  }
}

async function handleChatCompletions({ store, body, res, onLog, signal, userDataPath }) {
  ensureBoot();

  let openaiBody;
  try {
    openaiBody = ensureToolCallIds(normalizeOpenAIRequest(body || {}));
  } catch (e) {
    sendOpenAIError(res, 400, e.message || "Invalid request");
    return;
  }

  // Lopster Guard — OFF by default (heavy injection scanner; only explicit
  // store.guard.enabled=true turns it on). LOPSTER_GUARD_DISABLED=1 forces off.
  const guardCfg = guard.normalizeGuardConfig(store?.guard);

  const route = resolveRoute(store, openaiBody.model);
  if (!route.ok) {
    sendOpenAIError(res, 400, route.error);
    onLog?.({ level: "error", msg: route.error, model: openaiBody.model });
    return;
  }

  // Preflight: rewrite dead/unknown model ids against provider catalog + live list
  // (Kiro rejects unknown ids with 400 "Invalid model" — never storm all accounts).
  try {
    let modelRows = [];
    // Prefer per-account cached allowlist (fast, no network) for Kiro
    if (route.providerId === "kiro" && store?.accounts?.length) {
      const acc =
        (route.pinnedAccountId &&
          store.accounts.find((a) => a.id === route.pinnedAccountId)) ||
        store.accounts.find(
          (a) =>
            a.providerId === "kiro" &&
            a.enabled !== false &&
            (a.accessToken || a.refreshToken)
        );
      const cached = acc?.providerMeta?.availableModels;
      if (Array.isArray(cached) && cached.length) {
        modelRows = cached.map((id) => ({ id, bareId: id, source: "cache" }));
      }
    }
    if (userDataPath) {
      const modelsApi = require("./models.cjs");
      // Avoid live catalog fetch on every chat request under parallel load (was serializing
      // 20 clients behind one models list). Prefer cache; live only when empty / forced.
      const needLive =
        (route.providerId === "kiro" && modelRows.length === 0) ||
        (route.providerId !== "kiro" && modelRows.length === 0);
      // Prefer ChatGPT OAuth account for openai model allowlist — platform catalog
      // includes chatgpt-4o-latest which Codex ChatGPT accounts reject with 400.
      let listAccountId = route.pinnedAccountId || undefined;
      if (!listAccountId && route.providerId === "openai" && store?.accounts?.length) {
        const oauthAcc = store.accounts.find(
          (a) =>
            a.providerId === "openai" &&
            a.enabled !== false &&
            a.authType === "oauth" &&
            (a.accessToken || a.refreshToken)
        );
        if (oauthAcc) listAccountId = oauthAcc.id;
      }
      const listed = await modelsApi.listModelsFor(userDataPath, {
        providerId: route.providerId,
        chatOnly: true,
        refreshLive: needLive,
        accountId: listAccountId,
      });
      if (listed.models?.length) modelRows = listed.models;
    } else if (route.providerId === "kiro" && !modelRows.length) {
      try {
        const { catalogFor } = require("./oauth/kiroUsage.cjs");
        modelRows = catalogFor();
      } catch {
        /* */
      }
    }
    // Always apply Codex blocklist when openai oauth accounts exist (even if modelRows empty)
    if (route.providerId === "openai" && store?.accounts?.length) {
      try {
        const { OPENAI_CODEX_BLOCKED_IDS, OPENAI_CODEX_FALLBACK_MODELS, isOpenAICodexAccount } =
          require("./models.cjs");
        const hasCodexOauth = store.accounts.some(
          (a) => a.enabled !== false && isOpenAICodexAccount(a)
        );
        if (hasCodexOauth) {
          if (!modelRows.length) {
            modelRows = OPENAI_CODEX_FALLBACK_MODELS.map((m) => ({
              ...m,
              bareId: m.id,
              source: "catalog",
            }));
          }
          const bare = bareModelId(route.upstreamModel);
          if (bare && OPENAI_CODEX_BLOCKED_IDS.has(String(bare).toLowerCase())) {
            // Force allowlist path so chatgpt-4o-latest never hits Codex
            if (!modelRows.some((m) => String(m.id || m.bareId).toLowerCase() === bare.toLowerCase())) {
              /* already blocked from list */
            }
          }
        }
      } catch {
        /* */
      }
    }
    if (modelRows.length) {
      const resolved = resolveModelForProvider(
        route.providerId,
        route.upstreamModel,
        modelRows
      );
      if (resolved.substituted && resolved.bare) {
        onLog?.({
          level: "warn",
          msg: `model preflight: "${route.upstreamModel}" → "${resolved.bare}" (${resolved.reason})${
            resolved.available?.length
              ? `; available sample: ${resolved.available.slice(0, 8).join(", ")}`
              : ""
          }`,
          model: openaiBody.model,
        });
        route.upstreamModel = resolved.bare;
      } else if (resolved.ok && resolved.bare) {
        route.upstreamModel = resolved.bare;
      }
    } else if (route.providerId === "kiro") {
      // No list at all — still strip tags / 1m and use safest static default
      const def = providerDefaultBare("kiro", []);
      const bare = bareModelId(route.upstreamModel);
      if (def && bare && bare !== def) {
        // Keep bare if it looks like a known safe id; else force default
        const safe = /^(claude-haiku-4\.5|claude-sonnet-4\.5)$/i.test(bare);
        if (!safe) {
          onLog?.({
            level: "warn",
            msg: `model preflight: no allowlist; coercing "${route.upstreamModel}" → "${def}"`,
          });
          route.upstreamModel = def;
        } else {
          route.upstreamModel = bare;
        }
      } else if (bare) {
        route.upstreamModel = bare;
      }
    }
  } catch (e) {
    onLog?.({
      level: "warn",
      msg: `model preflight skipped: ${e.message || e}`,
    });
  }

  const candidates = (route.candidates || []).filter(
    (c) => c.account && (c.account.accessToken || c.account.apiKey)
  );
  if (!candidates.length) {
    sendOpenAIError(res, 400, "No usable accounts for this model");
    return;
  }

  // Prefer currently available first (list already sorted). Skip still-blocked keys
  // unless every key is blocked (then try soonest-unblock order as soft fallback).
  const available = candidates.filter((c) => c.available);
  const blocked = candidates.filter((c) => !c.available);

  // If ALL accounts are blocked, don't burn attempts trying blocked ones.
  // Find the soonest-unblock time and return 429 with Retry-After.
  if (!available.length && blocked.length) {
    const soonest = blocked.reduce(
      (min, c) => {
        const t = c.state?.blockedUntil || 0;
        return t && (!min.t || t < min.t) ? { t, cand: c } : min;
      },
      { t: 0, cand: null }
    );
    const retryAfterSec = soonest.t
      ? Math.max(1, Math.ceil((soonest.t - Date.now()) / 1000))
      : 60;
    const label = soonest.cand?.account?.email || soonest.cand?.account?.name || "?";
    onLog?.({
      level: "warn",
      msg: `All ${blocked.length} accounts blocked. Soonest unblock: ${label} in ${retryAfterSec}s`,
    });
    sendJson(res, 429, {
      error: {
        message: `All accounts are rate-limited or quota-exhausted. Soonest available in ${retryAfterSec}s (${label}).`,
        type: "rate_limit_exceeded",
        param: null,
        code: "all_accounts_blocked",
      },
    }, { "Retry-After": String(retryAfterSec) });
    return;
  }

  const ordered = available.length ? available : [...blocked].sort(
    (a, b) => (a.state?.blockedUntil || 0) - (b.state?.blockedUntil || 0)
  );

  const provider = route.provider;
  const maxRetryCredentials = Number(provider.maxRetryCredentials) > 0
    ? Number(provider.maxRetryCredentials)
    : Number(provider.maxFailoverAttempts) > 0
      ? Number(provider.maxFailoverAttempts)
      : DEFAULT_MAX_RETRY_CREDENTIALS;
  // Do NOT cap by ordered.length alone — with 1–2 accounts that stopped
  // multi-round recycle after the first empty-stream/502/401 pass.
  // Budget = unique-pool * recycle rounds, floored at MIN_FAILOVER_ATTEMPTS.
  const poolSize = Math.max(1, ordered.length);
  const maxAttempts = Math.max(
    1,
    Math.min(
      MAX_FAILOVER_ATTEMPTS,
      Math.max(
        MIN_FAILOVER_ATTEMPTS,
        Math.min(maxRetryCredentials, poolSize * (MAX_POOL_RECYCLES + 1))
      )
    )
  );
  const failoverAny = Boolean(provider.failoverOnAnyError);
  const connectTimeoutMs = Math.max(
    2000,
    Math.min(
      60_000,
      Number(provider.failoverConnectTimeoutMs) > 0
        ? Number(provider.failoverConnectTimeoutMs)
        : FAILOVER_CONNECT_TIMEOUT_MS
    )
  );

  const errors = [];
  let lastFail = null;
  let lastMode = "platform";
  let cleanEmptyRetries = 0;
  const triedIds = new Set();
  let poolRecycles = 0;
  const forceRefreshIds = new Set();

  // Pick next untried available candidate.
  // BOTH API keys and OAuth: least in-flight first so 20+ parallel clients spread
  // across the pool. Sticky lastSuccess only breaks ties among equally free keys
  // (router already orders free keys before saturated ones).
  function isApiKeyCand(c) {
    const a = c?.account;
    if (!a) return false;
    const authType = a.authType || (a.accessToken && !a.apiKey ? "oauth" : "apikey");
    return authType === "apikey" && Boolean(a.apiKey) && !(a.accessToken && !a.apiKey);
  }

  const maxInFlightDefault =
    Number(provider.maxInFlightPerAccount) > 0
      ? Number(provider.maxInFlightPerAccount)
      : accountRouter.DEFAULT_MAX_IN_FLIGHT_PER_ACCOUNT || 6;

  function pickNext({ allowSaturated = false, allowBlocked = false } = {}) {
    let best = null;
    let bestScore = null;
    // Prefer free keys, then free oauth, then (if allowSaturated) busy accounts.
    for (const preferKeys of [true, false]) {
      for (const c of ordered) {
        if (preferKeys !== isApiKeyCand(c)) continue;
        const id = c.account?.id;
        if (!id || triedIds.has(id)) continue;
        const live = accountRouter.getStatus(id);
        if (!allowBlocked && available.length && live && live.available === false) continue;
        const inFlight = live?.inFlightCount || 0;
        const maxInf =
          accountRouter.maxInFlightFor?.(c.account) || maxInFlightDefault;
        if (!allowSaturated && inFlight >= maxInf) continue;
        // Score: inFlight primary, then sticky lastSuccess (higher = better, so invert),
        // then lastUsed (older better for spread).
        const lastSuccess = live?.lastSuccessAt || 0;
        const lastUsed = live?.lastUsedAt || 0;
        const score = inFlight * 1e16 - lastSuccess * 1e3 + lastUsed;
        if (bestScore == null || score < bestScore) {
          best = c;
          bestScore = score;
        }
      }
      if (best) return best;
    }
    // Last resort: any remaining candidate including saturated
    if (!allowSaturated) return pickNext({ allowSaturated: true, allowBlocked });
    return best;
  }

  // Prepare a candidate: token refresh + connection build + mode detection
  async function prepareCand(cand, { forceLease = false, forceBlocked = false } = {}) {
    let account = cand.account;
    if (!account || !(account.accessToken || account.apiKey)) return null;
    let connection = accountToConnection(account, provider);
    const maxInf = accountRouter.maxInFlightFor?.(account) || maxInFlightDefault;
    // Reserve before upstream work. Soft lease allows limited parallel on same key;
    // when saturated, lease fails so pickNext can spread to another account.
    const lease = accountRouter.leaseAccount(connection.id, ACCOUNT_LEASE_TTL_MS, {
      maxInFlight: maxInf,
      force: forceLease,
      forceBlocked,
    });
    // Only mark tried when we actually took a lease — otherwise another request
    // may still use this free key. On forceLease failure, mark tried to avoid loop.
    if (!lease) {
      if (forceLease) triedIds.add(connection.id);
      return null;
    }
    triedIds.add(connection.id);
    // Round-robin cursor is OAuth load-spread only — do not advance for API keys
    // (sticky key must stay first for subsequent client requests).
    const isApiKey =
      connection.authType === "apikey" ||
      (account?.authType === "apikey" && account?.apiKey) ||
      (Boolean(account?.apiKey) && !account?.accessToken);
    if (!isApiKey) {
      accountRouter.advanceSelection(provider.id, route.upstreamModel);
    }

    const isOauth =
      connection.authType === "oauth" ||
      account?.authType === "oauth" ||
      (Boolean(account?.accessToken) && !account?.apiKey);

    if (isOauth && userDataPath && account?.id) {
      try {
        const force = forceRefreshIds.has(account.id);
        account = await ensureFreshToken(userDataPath, { ...account }, { force });
        connection = accountToConnection(account, provider);
        if (force) forceRefreshIds.delete(account.id);
      } catch (e) {
        onLog?.({ level: "error", msg: `token refresh: ${e.message}` });
      }
    }

    let mode = "platform";
    if (isOauth && provider.id === "openai") mode = "codex";
    else if (isOauth && provider.id === "grok") mode = "grok-cli";
    else if (isOauth && (provider.id === "antigravity" || provider.wireFormat === "antigravity")) {
      mode = "antigravity";
    } else if (isOauth && (provider.id === "gemini-cli" || provider.wireFormat === "gemini-cli")) {
      mode = "gemini-cli";
    } else if (
      isOauth &&
      (provider.id === "claude-code" || provider.modelTag === "claude-code" || provider.id === "claude")
    ) {
      mode = "claude-code";
    } else if (
      isOauth &&
      (provider.id === "kiro" || provider.wireFormat === "kiro" || provider.modelTag === "kiro")
    ) {
      mode = "kiro";
    } else if (isOauth) {
      mode = provider.wireFormat || "openai";
    }

    return { account, connection, mode, label: account?.email || account?.name || connection.id };
  }

  // Mark a failed attempt and record error. Always classifies so unknown errors
  // still get a kind + cooldown and the failover loop can try the next account.
  function handleFail(candId, attempt, label, mode, account) {
    let markBody = attempt.body || attempt.message;
    let markStatus = attempt.status || 0;

    // Grok free tier: 429 payload carries the only real daily numbers
    // ("tokens (actual/limit): 1021918/1000000", rolling 24h window).
    if (account?.providerId === "grok") {
      try {
        const grokFreeTracker = require("./oauth/grokFreeTracker.cjs");
        const applied = grokFreeTracker.recordExhausted(account, markBody);
        if (applied) {
          onLog?.({
            level: "warn",
            msg: `⏳ ${label}: free daily limit ${applied.parsed.used}/${applied.parsed.limit} tokens (rolling 24h)`,
            account: label,
          });
        }
      } catch {
        /* */
      }
    }
    let classifyKind;
    let classifyRetryable = true;
    if (attempt.timedOut) {
      markStatus = 504;
      markBody = attempt.message || "connect timeout";
      // Soft cooldown for new picks; also drops one lease ref
      accountRouter.markTransientError(candId, {
        message: attempt.message || "connect timeout",
        cooldownMs: 2_000,
      });
      classifyKind = "timeout";
      classifyRetryable = true;
      persistRouting(userDataPath, candId);
    } else {
      // Missing status → still classify from message (network/quota/auth text)
      if (!markStatus && markBody) markStatus = 0;
      const marked = accountRouter.markFromUpstreamError(candId, markStatus, markBody);
      classifyKind = marked?.classify?.kind || "other";
      classifyRetryable = marked?.classify?.retryable !== false;
      // markLimited already drops one lease for retryable kinds.
      // Only release when classify left the lease still held (none / non-retryable).
      if (classifyKind === "none" || classifyRetryable === false) {
        accountRouter.releaseAccount(candId);
      }
      persistRouting(userDataPath, candId);
    }

    const attemptMessage = (attempt.message || "").split("\n")[0];
    errors.push({
      account: label,
      status: attempt.timedOut ? 504 : attempt.status || markStatus,
      kind: attempt.timedOut ? "timeout" : classifyKind,
      retryable: classifyRetryable,
      message: attemptMessage,
    });
    lastFail = attempt;
    lastMode = mode;

    onLog?.({
      level: "error",
      msg: `✗ ${label}: ${attempt.timedOut ? "timeout" : classifyKind} HTTP ${
        attempt.timedOut ? 504 : attempt.status || markStatus || "?"
      } — ${operationalErrorMessage(attemptMessage).slice(0, 120)}`,
      status: attempt.timedOut ? 504 : attempt.status || markStatus,
    });
  }

  // Sequential failover per client request (one upstream account at a time for THIS
  // request). Many client requests run fully concurrent; routing spreads them via
  // least-in-flight + soft per-account lease cap.
  for (let i = 0; i < maxAttempts; i++) {
    // Prefer free accounts; after half the budget, allow saturated keys (force lease).
    const allowSaturated = i >= Math.max(1, Math.floor(maxAttempts / 2));
    const allowBlocked = poolRecycles > 0;
    const cand = pickNext({ allowSaturated, allowBlocked });
    if (!cand) break;

    let prepared;
    try {
      prepared = await prepareCand(cand, {
        forceLease: allowSaturated,
        forceBlocked: allowBlocked,
      });
    } catch (e) {
      onLog?.({ level: "error", msg: `prepare account: ${e.message || e}` });
      continue;
    }
    if (!prepared) {
      // Lease lost race (another parallel client took the slot) — try next key.
      continue;
    }

    const wasAvailable = cand.available !== false;
    onLog?.({
      level: "info",
      msg: `→ ${provider.id}/${prepared.mode} ${route.upstreamModel} [${i + 1}/${maxAttempts}] ${prepared.label}${wasAvailable ? "" : " (blocked fallback)"}`,
      model: openaiBody.model,
      stream: Boolean(openaiBody.stream),
      account: prepared.label,
    });

    let attempt;
    try {
      attempt = await tryOneAccount({
        openaiBody,
        route,
        provider,
        account: prepared.account,
        connection: prepared.connection,
        mode: prepared.mode,
        signal,
        onLog,
        userDataPath,
        connectTimeoutMs,
      });
    } catch (e) {
      attempt = {
        ok: false,
        status: 502,
        message: `Upstream attempt failed: ${e.message || e}`,
      };
    }

    if (attempt.ok) {
      accountRouter.markSuccess(prepared.connection.id);
      persistRouting(userDataPath, prepared.connection.id);

      if (attempt.kind === "stream") {
        const streamResult = await pipeStream({
          upstream: attempt.upstream,
          res,
          converter: attempt.converter,
          provider,
          model: route.upstreamModel,
          clientModel: openaiBody.model,
          toolNameMap: attempt.toolNameMap,
          onLog,
          openaiBody,
          guardCfg,
          guardMeta: {
            providerId: provider?.id || route.providerId,
            account: prepared.label,
          },
          idleTimeoutMs: provider.streamIdleTimeoutMs,
        });
        const streamUsage = streamResult?.usage || null;

        // Stream died before any content reached the client — nothing was written
        // to the socket yet, so this account can be failed over like a normal error.
        if (streamResult && streamResult.delivered === false) {
          const outcome = streamResult.outcome || {};
          const isCleanEmpty = outcome.kind === "clean_empty";
          if (isCleanEmpty) cleanEmptyRetries += 1;
          // markSuccess (above) already dropped this request's lease ref; handleFail
          // drops one too. Re-take it so the in-flight counter stays balanced and we
          // do not free a slot that belongs to another concurrent request.
          accountRouter.leaseAccount(prepared.connection.id, ACCOUNT_LEASE_TTL_MS, {
            force: true,
          });
          handleFail(
            prepared.connection.id,
            {
              ok: false,
              status: outcome.kind === "idle_timeout" ? 504 : 502,
              timedOut: outcome.kind === "idle_timeout",
              message: outcome.message || "Upstream stream produced no data",
            },
            prepared.label,
            prepared.mode,
            prepared.account
          );
          // OpenAI cyber gate: content-based rejection, identical on every key.
          // Stop now and surface the flag in the chat — retrying the same
          // conversation on other accounts is guaranteed to fail the same way.
          // (Lease was re-taken above to balance handleFail's drop, so release it.)
          if (isCyberFlagMessage(outcome.message)) {
            accountRouter.releaseAccount(prepared.connection.id);
            const cy = cyberFlagError(outcome.message, 502);
            onLog?.({
              level: "error",
              msg: `🛡️ cyber-flag: ${prepared.label} — upstream protection refused the request content (${errors.length} attempt(s))`,
              model: openaiBody.model,
            });
            sendJson(res, cy.status, cy.error);
            return;
          }
          if (isCleanEmpty && cleanEmptyRetries >= MAX_CLEAN_EMPTY_RETRIES) {
            onLog?.({
              level: "warn",
              msg: `↻ empty completed stream retry limit reached (${cleanEmptyRetries}/${MAX_CLEAN_EMPTY_RETRIES})`,
              model: openaiBody.model,
            });
            break;
          }
          if (triedIds.size >= ordered.length) {
            const canRecycle = i + 1 < maxAttempts && poolRecycles < MAX_POOL_RECYCLES;
            if (!canRecycle) break;
            poolRecycles += 1;
            triedIds.clear();
            const backoffMs = Math.min(
              POOL_RECYCLE_MAX_MS,
              POOL_RECYCLE_BASE_MS * poolRecycles
            );
            onLog?.({
              level: "warn",
              msg: `↻ pool exhausted after empty stream (${errors.length} fails) → recycle #${poolRecycles}/${MAX_POOL_RECYCLES} after ${backoffMs}ms`,
              model: openaiBody.model,
            });
            await new Promise((r) => setTimeout(r, backoffMs));
          }
          if (i + 1 < maxAttempts) {
            onLog?.({
              level: "info",
              msg: isCleanEmpty
                ? `↻ empty completed stream → retry (${cleanEmptyRetries}/${MAX_CLEAN_EMPTY_RETRIES})`
                : `↻ empty stream → retry on next account (${i + 2}/${maxAttempts})`,
              model: openaiBody.model,
            });
          }
          continue;
        }
        try {
          const usageStats = require("./usageStats.cjs");
          usageStats.record({
            model: openaiBody.model,
            providerId: provider?.id || route.providerId,
            usage: streamUsage,
            stream: true,
          });
        } catch {
          /* */
        }
        let tok = null;
        try {
          const { normalizeUsage } = require("./usageStats.cjs");
          const n = normalizeUsage(streamUsage);
          if (n.totalTokens > 0n) tok = n.totalTokens.toString();
          recordGrokFreeTokens(prepared.account, n.totalTokens);
        } catch {
          tok =
            streamUsage?.total_tokens ??
            streamUsage?.totalTokens ??
            ((streamUsage?.prompt_tokens || 0) + (streamUsage?.completion_tokens || 0) || null);
        }
        onLog?.({
          level: "info",
          msg: `← ok via ${prepared.label} (stream done)${tok != null ? ` tokens=${tok}` : ""}`,
          model: openaiBody.model,
          providerId: provider?.id || route.providerId,
          usage: streamUsage || null,
          stream: true,
        });
        return;
      }

      // Non-stream: scan full JSON response before client sees it.
      // CPU-bound guard scan runs in a worker thread so the main process
      // Event Loop stays free while we wait on upstream.
      let responsePayload = attempt.payload;
      if (guardCfg.enabled) {
        const decision = await Promise.resolve(
          workerPool.exec("guardScanOpenAIResponse", {
            payload: attempt.payload,
            openaiBody,
            config: guardCfg,
          })
        ).catch(() => guard.scanOpenAIResponse(attempt.payload, openaiBody, guardCfg));
        guard.activity.record({
          ...decision,
          model: openaiBody.model,
          providerId: provider?.id || route.providerId,
          account: prepared.label,
          stream: false,
        });
        if (decision.action === "block") {
          onLog?.({
            level: "error",
            msg: `🛡 Guard BLOCKED non-stream response via ${prepared.label}: ${(decision.findings || [])
              .map((f) => f.ruleId)
              .slice(0, 6)
              .join(", ")}`,
            model: openaiBody.model,
            guard: decision,
          });
          sendJson(res, 403, guard.blockErrorPayload(decision, { model: openaiBody.model }));
          return;
        }
        if (decision.action === "scrub") {
          if (decision.payload) responsePayload = decision.payload;
          onLog?.({
            level: "warn",
            msg: `🛡 Guard SCRUBBED non-stream via ${prepared.label}: ${(decision.findings || [])
              .map((f) => f.ruleId)
              .slice(0, 6)
              .join(", ")}${decision.changed ? " (fragments cut)" : ""}`,
            model: openaiBody.model,
            guard: decision,
          });
        } else if (decision.action === "alert" && decision.findings?.length) {
          onLog?.({
            level: "warn",
            msg: `🛡 Guard ALERT non-stream: ${(decision.findings || [])
              .map((f) => f.ruleId)
              .slice(0, 6)
              .join(", ")}`,
            model: openaiBody.model,
            guard: decision,
          });
        }
      }

      sendJson(res, 200, responsePayload);
      try {
        const usageStats = require("./usageStats.cjs");
        usageStats.record({
          model: openaiBody.model,
          providerId: provider?.id || route.providerId,
          usage: attempt.payload?.usage || null,
          stream: false,
        });
        recordGrokFreeTokens(
          prepared.account,
          usageStats.normalizeUsage(attempt.payload?.usage || null).totalTokens
        );
      } catch {
        /* */
      }
      onLog?.({
        level: "info",
        msg: `← ok via ${prepared.label}${attempt.payload?.usage ? ` tokens=${attempt.payload.usage.total_tokens || "?"}` : ""}`,
        model: openaiBody.model,
        providerId: provider?.id || route.providerId,
        usage: attempt.payload?.usage || null,
        stream: false,
      });
      return;
    }

    handleFail(prepared.connection.id, attempt, prepared.label, prepared.mode, prepared.account);

    const lastErr = errors[errors.length - 1];

    // OpenAI cyber gate: the conversation content is flagged identically on every
    // account — failover cannot repair it. Surface the flag in the chat right now
    // instead of burning the whole attempt budget on the same 502.
    if (isCyberFlagMessage(attempt.message || lastErr?.message)) {
      const cy = cyberFlagError(attempt.message || lastErr.message, attempt.status || 502);
      onLog?.({
        level: "error",
        msg: `🛡️ cyber-flag: ${prepared.label} — upstream protection refused the request content (${errors.length} attempt(s))`,
        model: openaiBody.model,
      });
      sendJson(res, cy.status, cy.error);
      return;
    }

    // Invalid model id is request-global: do not walk every account with the same dead id.
    // One recovery attempt: refresh allowlist + substitute, then stop on second invalid_model.
    if (
      lastErr?.kind === "invalid_model" ||
      (lastErr?.retryable === false && isInvalidModelMessage(attempt.message || lastErr?.message))
    ) {
      if (!route._invalidModelRecovered && userDataPath) {
        route._invalidModelRecovered = true;
        try {
          // Drop stale per-account cache so live list is authoritative
          if (route.providerId === "kiro" && prepared.account?.id) {
            try {
              const st = await storeApi.load(userDataPath);
              const ix = (st.accounts || []).findIndex((a) => a.id === prepared.account.id);
              if (ix >= 0 && st.accounts[ix].providerMeta) {
                delete st.accounts[ix].providerMeta.availableModels;
                delete st.accounts[ix].providerMeta.availableModelsAt;
                st.accounts[ix].providerMeta.availableModelsSource = "invalidated";
                await storeApi.save(userDataPath, st);
              }
            } catch {
              /* */
            }
          }
          const modelsApi = require("./models.cjs");
          const listed = await modelsApi.listModelsFor(userDataPath, {
            providerId: route.providerId,
            chatOnly: true,
            refreshLive: true,
            accountId: prepared.account?.id,
          });
          const rows = listed.models || [];
          // Force a *different* model than the one Kiro just rejected
          const forced = resolveModelForProvider(
            route.providerId,
            "__never_match_invalid__",
            rows
          );
          let candidate = forced.bare || providerDefaultBare(route.providerId, rows);
          if (candidate && candidate === route.upstreamModel) {
            // Pick any other id from the list
            const others = rows
              .map((m) => bareModelId(m.bareId || m.id))
              .filter((id) => id && id !== route.upstreamModel);
            candidate = others[0] || null;
          }
          if (candidate && candidate !== route.upstreamModel) {
            onLog?.({
              level: "warn",
              msg: `invalid model recovery: "${route.upstreamModel}" → "${candidate}" (one retry, no multi-account storm)`,
              model: openaiBody.model,
            });
            route.upstreamModel = candidate;
            triedIds.delete(prepared.connection.id);
            continue;
          }
        } catch (e) {
          onLog?.({ level: "warn", msg: `invalid model recovery failed: ${e.message || e}` });
        }
      }
      const msg =
        attempt.message ||
        lastErr.message ||
        `Invalid model "${route.upstreamModel}" for provider ${route.providerId}`;
      onLog?.({
        level: "error",
        msg: `invalid_model stop: ${msg} (accounts tried this request: ${errors.length})`,
        model: openaiBody.model,
      });
      sendJson(res, 400, {
        error: {
          message: `${msg}. Model id is not available on this provider/account — pick a model from the live list (Proxy → provider → Models refresh). Do not retry the same id.`,
          type: "apierror",
          param: "model",
          code: "invalid_model",
          accounts_tried: errors,
        },
      });
      return;
    }

    // Fail over only account-scoped / transient errors (quota, 429, auth, network,
    // 5xx, generic request, policy, banned, other, timeout). Explicit non-retryable
    // request_format errors stop here: retrying the same malformed body on every key
    // cannot repair it and can make a single 400 destroy the whole chat turn.
    // provider.failoverOnAnyError still forces account-scoped errors, but never a
    // request-global error (invalid model, unsupported wire content, etc.).
    // Note: 402 / "balance exhausted" is classified as quota in limitDetect.
    const continueFailover =
      // failoverOnAnyError must not override a request-global incompatibility.
      Boolean(lastErr) &&
      lastErr.retryable !== false &&
      (failoverAny ||
        lastErr.kind === "timeout" ||
        lastErr.kind === "rate_limit" ||
        lastErr.kind === "quota" ||
        lastErr.kind === "auth" ||
        lastErr.kind === "network" ||
        lastErr.kind === "server" ||
        lastErr.kind === "request" ||
        lastErr.kind === "policy" ||
        lastErr.kind === "banned" ||
        lastErr.kind === "other" ||
        lastErr.kind === "error");
    if (lastErr && !continueFailover) {
      if (lastFail) {
        sendError(res, lastFail, lastMode);
        return;
      }
    }

    // Auth/401: next pass for this id must force OAuth refresh even if expiresAt
    // still looks valid (revoked access token is the common case).
    if (
      lastErr?.kind === "auth" ||
      lastErr?.status === 401 ||
      /revoked|unauthori[sz]ed|invalid.?token|token expired/i.test(
        String(lastErr?.message || attempt?.message || "")
      )
    ) {
      const authId = prepared?.connection?.id || prepared?.account?.id;
      if (authId) forceRefreshIds.add(authId);
    }

    if (triedIds.size >= ordered.length) {
      // A generic upstream 5xx means this request has already had one chance on
      // every credential. Reusing the same accounts in this request only hammers
      // healthy credentials while the upstream is failing (e.g. 2 keys × 7 rounds
      // produced 14 identical server/500 errors). The normal 5-second per-account
      // cooldown still lets a later, independent request retry them. Capacity is
      // classified as rate_limit above and retains its controlled recycle behavior.
      const canRecycle =
        continueFailover &&
        lastErr?.kind !== "server" &&
        i + 1 < maxAttempts &&
        poolRecycles < MAX_POOL_RECYCLES;
      if (!canRecycle) break;
      poolRecycles += 1;
      triedIds.clear();
      const backoffMs = Math.min(
        POOL_RECYCLE_MAX_MS,
        POOL_RECYCLE_BASE_MS * poolRecycles
      );
      onLog?.({
        level: "warn",
        msg: `↻ pool exhausted (${errors.length} fails) → recycle #${poolRecycles}/${MAX_POOL_RECYCLES} after ${backoffMs}ms`,
        model: openaiBody.model,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }

    if (i + 1 < maxAttempts) {
      onLog?.({
        level: "info",
        msg: `↻ failover → next account (${i + 2}/${maxAttempts})`,
        model: openaiBody.model,
      });
    }
  }

  // All failed
  const summary =
    errors.map((e) => `${e.account}: ${e.kind}/${e.status || "?"}`).join("; ") ||
    "all accounts failed";
  onLog?.({
    level: "error",
    msg: `All attempts failed after ${errors.length} tries: ${summary}`,
  });

  const rawFinalMsg = lastFail?.message || summary;
  const capacityFailure =
    isCapacityErrorMessage(rawFinalMsg) ||
    errors.some((e) => isCapacityErrorMessage(e.message));
  let finalMsg = publicFailureMessage(rawFinalMsg, errors.length);
  if (errors.length > 1 && !capacityFailure) {
    finalMsg = `${finalMsg}\n\nTried ${errors.length} key attempt(s): ${summary}`;
  }
  const publicErrors = errors.map((e) => ({
    account: e.account,
    status: e.status,
    kind: e.kind,
    retryable: e.retryable,
    message: isCapacityErrorMessage(e.message)
      ? "Temporary upstream capacity failure"
      : e.message,
  }));
  const finalStatus = capacityFailure ? 503 : lastFail?.status || 502;
  const finalPayload = {
    error: {
      message: finalMsg,
      type: isQuotaErrorMessage(finalMsg) ? "insufficient_quota" : "api_error",
      param: null,
      code: capacityFailure ? "upstream_capacity_retries_exhausted" : lastFail?.code || null,
      accounts_tried: publicErrors,
    },
  };

  // A partially delivered stream already wrote SSE headers — never throw
  // ERR_HTTP_HEADERS_SENT, emit the failure as a final SSE error frame instead.
  if (res.headersSent) {
    sendSse(res, finalPayload);
    sendSseDone(res);
    return;
  }

  sendJson(res, finalStatus, finalPayload);
}

function sendError(res, attempt, mode) {
  let message = attempt.message || "Upstream error";
  if (mode === "platform" && isQuotaErrorMessage(message)) {
    message +=
      "\n\nHint: Platform API key has no billing credits. Use ChatGPT OAuth or top up billing.";
  }
  sendJson(res, attempt.status || 502, {
    error: {
      message,
      type: isQuotaErrorMessage(message) ? "insufficient_quota" : "api_error",
      param: null,
      code: attempt.code || null,
    },
  });
}

async function tryOneAccount({
  openaiBody,
  route,
  provider,
  account,
  connection,
  mode,
  signal,
  onLog,
  userDataPath,
  connectTimeoutMs = FAILOVER_CONNECT_TIMEOUT_MS,
}) {
  let upstreamBody;
  let stream = Boolean(openaiBody.stream);
  let converter;
  let toolNameMap = null;

  if (mode === "codex") {
    // OpenAI Codex /chatgpt.com backend-api
    upstreamBody = openaiToResponsesRequest(openaiBody, {
      upstreamModel: route.upstreamModel,
    });
    stream = true;
    converter = {
      responseMessage: (data, model) => responsesMessageToOpenAI(data, model),
      createStreamState: (model) => createResponsesStreamState(model),
      streamEvent: (ev, state) => responsesEventToOpenAIChunks(ev, state),
    };
  } else if (mode === "grok-cli") {
    const grokBackend = connection.apiBackend || "responses";
    if (grokBackend === "responses") {
      upstreamBody = openaiToResponsesRequest(openaiBody, {
        upstreamModel: route.upstreamModel || "grok-4.5",
      });
      stream = true;
      converter = {
        responseMessage: (data, model) => responsesMessageToOpenAI(data, model),
        createStreamState: (model) => createResponsesStreamState(model),
        streamEvent: (ev, state) => responsesEventToOpenAIChunks(ev, state),
      };
    } else {
      // Grok Build CLI chat backend is OpenAI-compatible.
      converter = getConverter("openai", "grok") || getConverter("openai", "openai");
      const converted = converter.request(openaiBody, {
        upstreamModel: route.upstreamModel || "grok-4.5",
      });
      upstreamBody = { ...converted };
      stream = Boolean(openaiBody.stream ?? true);
      upstreamBody.stream = stream;
      for (const k of [
        "presence_penalty",
        "frequency_penalty",
        "logprobs",
        "top_logprobs",
        "presencePenalty",
        "frequencyPenalty",
        "logprobs",
        "topLogprobs",
      ]) {
        delete upstreamBody[k];
      }
    }
  } else if (mode === "antigravity" || mode === "gemini-cli") {
    const wire = mode === "gemini-cli" ? "gemini-cli" : "antigravity";
    converter = getConverter("openai", wire);
    if (!converter?.request) {
      return { ok: false, status: 500, message: `No converter openai→${wire}` };
    }
    let projectId =
      connection.projectId ||
      connection.workspaceId ||
      account?.providerMeta?.projectId ||
      null;

    // Auto-discover projectId via loadCodeAssist (+ onboardUser for Gemini CLI)
    if (!projectId && account?.accessToken) {
      try {
        if (mode === "gemini-cli") {
          const geminiCliAuth = require("./oauth/geminiCliAuth.cjs");
          let siblingAccounts = [];
          if (userDataPath) {
            try {
              const store = await storeApi.load(userDataPath);
              siblingAccounts = store.accounts || [];
            } catch {
              /* */
            }
          }
          const disc = await geminiCliAuth.ensureProjectAssigned(account.accessToken, {
            preferredProjectId: account.providerMeta?.projectId || account.workspaceId,
            email: account.email,
            accounts: siblingAccounts,
          });
          if (disc.projectId) {
            projectId = disc.projectId;
            onLog?.({
              level: "info",
              msg: `gemini-cli: bound projectId=${projectId}${disc.note ? ` (${String(disc.note).slice(0, 80)})` : ""}`,
            });
            if (account) {
              account.providerMeta = {
                ...(account.providerMeta || {}),
                projectId,
                tier: disc.tier || account.providerMeta?.tier,
              };
              account.workspaceId = projectId;
              if (disc.tier) account.planType = disc.tier;
            }
            connection.projectId = projectId;
            connection.workspaceId = projectId;
            if (userDataPath && account?.id) {
              try {
                const store = await storeApi.load(userDataPath);
                const idx = store.accounts.findIndex((a) => a.id === account.id);
                if (idx >= 0) {
                  store.accounts[idx] = {
                    ...store.accounts[idx],
                    workspaceId: projectId,
                    planType: disc.tier || store.accounts[idx].planType,
                    providerMeta: {
                      ...(store.accounts[idx].providerMeta || {}),
                      projectId,
                      tier: disc.tier || store.accounts[idx].providerMeta?.tier,
                    },
                  };
                  await storeApi.save(userDataPath, store);
                }
              } catch {
                /* */
              }
            }
          } else if (disc.error) {
            onLog?.({ level: "warn", msg: `gemini-cli project: ${disc.error}` });
          }
        } else {
          // Antigravity — try enrich if empty
          const antigravityAuth = require("./oauth/antigravityAuth.cjs");
          const enr = await antigravityAuth.enrichWithBackend(account.accessToken);
          if (enr.projectId) {
            projectId = enr.projectId;
            connection.projectId = projectId;
            connection.workspaceId = projectId;
            if (account) {
              account.providerMeta = {
                ...(account.providerMeta || {}),
                projectId,
                tier: enr.tier || account.providerMeta?.tier,
              };
              account.workspaceId = projectId;
            }
          }
        }
      } catch (e) {
        onLog?.({
          level: "warn",
          msg: `projectId discovery failed: ${e.message || e}`,
        });
      }
    }

    if (!projectId) {
      // OmniRoute: gemini-cli deprecated in favor of Antigravity (auto project via loadCodeAssist).
      // Soft structured error — account itself stays valid.
      return {
        ok: false,
        status: 422,
        message:
          mode === "gemini-cli"
            ? "No Cloud Code project bound yet. OmniRoute uses Antigravity for this (auto project). Fix: (1) Proxy → Antigravity → Sign in with Google, then re-open Gemini CLI, or (2) set Project ID on the Gemini CLI account, or (3) use provider Antigravity instead of Gemini CLI."
            : "Missing Google projectId for Antigravity. Reconnect OAuth so loadCodeAssist can assign a Cloud Code project.",
        code: "missing_project_id",
      };
    }
    const converted = converter.request(openaiBody, {
      upstreamModel: route.upstreamModel,
      projectId,
    });
    upstreamBody = converted.body || converted;
    toolNameMap = converted._toolNameMap || null;
    stream = true; // Cloud Code always SSE
    if (mode === "gemini-cli" && converted._mappedFrom && converted._upstreamModel) {
      onLog?.({
        level: "info",
        msg: `gemini-cli: model ${converted._mappedFrom} → ${converted._upstreamModel}`,
      });
    }
  } else if (mode === "claude-code" || route.wireFormat === "anthropic") {
    converter = getConverter("openai", "anthropic");
    if (!converter?.request) {
      return { ok: false, status: 500, message: "No converter openai→anthropic" };
    }
    const converted = converter.request(openaiBody, {
      upstreamModel: route.upstreamModel,
    });
    upstreamBody = converted;
    stream = Boolean(openaiBody.stream ?? true);
    if (upstreamBody && typeof upstreamBody === "object") {
      upstreamBody.stream = stream;
    }
  } else if (mode === "kiro") {
    converter = getConverter("openai", "kiro");
    if (!converter?.request) {
      return { ok: false, status: 500, message: "No converter openai→kiro" };
    }
    const converted = converter.request(openaiBody, {
      upstreamModel: route.upstreamModel,
      profileArn: account?.providerMeta?.profileArn || account?.workspaceId,
      providerMeta: account?.providerMeta || {},
      account,
    });
    upstreamBody = converted;
    stream = true; // Kiro EventStream always streamed as SSE to client
  } else {
    converter = getConverter("openai", route.wireFormat) || getConverter("openai", "openai");
    if (!converter?.request) {
      return { ok: false, status: 500, message: `No converter openai→${route.wireFormat}` };
    }
    const converted = converter.request(openaiBody, {
      upstreamModel: route.upstreamModel,
      providerType: route.providerId,
    });
    upstreamBody = converted;
    if (
      (route.wireFormat === "gemini" || route.wireFormat === "antigravity") &&
      converted?.body
    ) {
      upstreamBody = converted.body;
      toolNameMap = converted._toolNameMap;
      stream = Boolean(converted.stream);
    } else if (converted && typeof converted === "object" && converted.stream != null) {
      stream = Boolean(openaiBody.stream ?? converted.stream);
    }
  }

  const baseUrl =
    mode === "codex"
      ? provider.codexBaseUrl || "https://chatgpt.com/backend-api/codex"
      : mode === "grok-cli"
        ? provider.cliProxyBaseUrl || "https://cli-chat-proxy.grok.com/v1"
        : mode === "antigravity" || mode === "gemini-cli"
          ? connection.baseUrl || provider.defaultBaseUrl
          : mode === "kiro"
            ? connection.baseUrl ||
              account?.baseUrl ||
              provider.defaultBaseUrl
            : // Custom / api-key providers: prefer per-account baseUrl, then connection, then provider default
              account?.baseUrl ||
              connection.baseUrl ||
              provider.defaultBaseUrl;

  const url = provider.buildUrl(baseUrl, {
    model: route.upstreamModel,
    stream,
    apiKey: connection.apiKey,
    authType: connection.authType,
    mode,
    apiBackend: mode === "grok-cli" ? connection.apiBackend : undefined,
    region: account?.providerMeta?.region,
    providerMeta: account?.providerMeta || {},
  });
  let headers = provider.buildHeaders(connection.apiKey, {
    authType: connection.authType,
    workspaceId: connection.workspaceId,
    mode,
    stream,
    accessToken: account?.accessToken || connection.apiKey,
  });

  // Claude Code OAuth: full CLI identity cloak (billing, metadata, stainless headers)
  if (mode === "claude-code" && typeof provider.prepareRequest === "function") {
    try {
      const prepared = provider.prepareRequest(upstreamBody, {
        id: account?.id || connection.id,
        email: account?.email,
        accessToken: account?.accessToken || connection.apiKey,
        providerMeta: account?.providerMeta || {},
      });
      if (prepared?.body) upstreamBody = prepared.body;
      if (prepared?.headers) headers = { ...headers, ...prepared.headers };
    } catch (e) {
      onLog?.({
        level: "warn",
        msg: `claude-code cloak: ${e.message || e}`,
      });
    }
  }

  // Kiro: strip unknown fields + inject profileArn
  if (mode === "kiro" && typeof provider.prepareRequest === "function") {
    try {
      const prepared = provider.prepareRequest(upstreamBody, {
        id: account?.id || connection.id,
        email: account?.email,
        accessToken: account?.accessToken || connection.apiKey,
        providerMeta: account?.providerMeta || {},
        workspaceId: account?.workspaceId,
      });
      if (prepared?.body) upstreamBody = prepared.body;
      if (prepared?.headers) headers = { ...headers, ...prepared.headers };
    } catch (e) {
      onLog?.({
        level: "warn",
        msg: `kiro prepare: ${e.message || e}`,
      });
    }
  }

  // Codex/serde_json 400s on lone surrogates / control junk in tool outputs
  // (error: input[N].output unexpected end of hex escape). Single-pass wire
  // serialization: sanitize + strip internal keys + stringify in ONE traversal
  // (old chain did three full deep clones of the whole body per attempt).
  const preserveReasoning =
    Boolean(provider.requiresReasoningContentReplay) ||
    ((route.providerId === "opencode" || route.providerId === "opencode-go") &&
      route.wireFormat === "openai");
  let requestBodyText;
  try {
    requestBodyText = wireJsonStringify(upstreamBody, {
      preserveKeys: preserveReasoning ? new Set(["reasoning_content"]) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      status: 400,
      message: `Failed to serialize upstream body: ${e.message || e}`,
    };
  }

  let upstream;
  const connect = withConnectTimeout(signal, connectTimeoutMs);
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body: requestBodyText,
      signal: connect.signal,
    });
  } catch (e) {
    const timedOut = connect.didTimeout();
    connect.dispose();
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      timedOut,
      message: timedOut
        ? `Connect timeout after ${connectTimeoutMs}ms — rotating account`
        : `Upstream fetch failed: ${e.message}`,
    };
  }
  connect.dispose();

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => "");
    let message = errText.slice(0, 800) || `Upstream HTTP ${upstream.status}`;
    let code = null;
    try {
      const j = JSON.parse(errText);
      message = j.error?.message || j.message || message;
      code = j.error?.code || null;
    } catch {
      /* */
    }

    if (mode === "kiro") {
      return {
        ok: false,
        status: upstream.status,
        message: message || `Kiro upstream HTTP ${upstream.status}`,
        code,
        body: errText,
      };
    }

    // Gemini CLI: 404 model not found → one retry with safe fallback model
    if (
      mode === "gemini-cli" &&
      upstream.status === 404 &&
      /not found|requested entity/i.test(message)
    ) {
      try {
        const {
          DEFAULT_FALLBACK_MODEL,
          resolveUpstreamModelId,
        } = require("./oauth/geminiCliUsage.cjs");
        const used =
          (upstreamBody && typeof upstreamBody === "object" && upstreamBody.model) ||
          route.upstreamModel;
        const fb = resolveUpstreamModelId(used).model;
        const alt =
          fb !== used
            ? fb
            : used === DEFAULT_FALLBACK_MODEL
              ? "gemini-2.5-pro"
              : DEFAULT_FALLBACK_MODEL;
        if (alt && alt !== used && upstreamBody && typeof upstreamBody === "object") {
          onLog?.({
            level: "warn",
            msg: `gemini-cli: ${used} not found → retry ${alt}`,
          });
          const retryBody = { ...upstreamBody, model: alt };
          const retryConnect = withConnectTimeout(signal, connectTimeoutMs);
          let retry;
          try {
            retry = await fetch(url, {
              method: "POST",
              headers,
              body: wireJsonStringify(retryBody),
              signal: retryConnect.signal,
            });
          } catch (e) {
            const timedOut = retryConnect.didTimeout();
            retryConnect.dispose();
            return {
              ok: false,
              status: timedOut ? 504 : 502,
              timedOut,
              message: timedOut
                ? `Connect timeout after ${connectTimeoutMs}ms (gemini-cli retry)`
                : `Upstream fetch failed: ${e.message}`,
            };
          }
          retryConnect.dispose();
          if (retry.ok) {
            upstream = retry;
            upstreamBody = retryBody;
            // fall through to success path below
          } else {
            const t2 = await retry.text().catch(() => "");
            let m2 = t2.slice(0, 400);
            try {
              m2 = JSON.parse(t2).error?.message || m2;
            } catch {
              /* */
            }
            return {
              ok: false,
              status: retry.status,
              message: `Model "${used}" not available on Gemini CLI (only gemini-2.5-pro/flash/flash-lite, gemini-3.1-flash-lite). Retry ${alt} also failed: ${m2}. Tip: use Antigravity for Gemini 3.x / Claude, or select gemini-cli/gemini-2.5-flash.`,
              code: retry.status,
              body: t2,
            };
          }
        }
      } catch {
        /* use original error */
      }
    }

    if (!upstream.ok) {
      // Enrich 404 for gemini-cli
      if (
        mode === "gemini-cli" &&
        upstream.status === 404 &&
        /not found|requested entity/i.test(message)
      ) {
        message = `Model not available on Gemini CLI: "${route.upstreamModel}". Use gemini-cli/gemini-2.5-pro (or flash / flash-lite / 3.1-flash-lite). Gemini 3.x Pro / Claude → switch to Antigravity. Google AI Pro ≠ Code Assist model list.`;
      }
      return {
        ok: false,
        status: upstream.status,
        message,
        code,
        body: errText,
      };
    }
  }

  // Kiro returns AWS EventStream binary — convert to OpenAI SSE before piping
  if (mode === "kiro") {
    try {
      const { transformEventStreamToSseResponse } = require("./oauth/kiroEventstream.cjs");
      const sseUpstream = await transformEventStreamToSseResponse(
        upstream,
        openaiBody.model || route.upstreamModel
      );
      return {
        ok: true,
        kind: "stream",
        upstream: sseUpstream,
        converter,
        toolNameMap,
      };
    } catch (e) {
      return {
        ok: false,
        status: 502,
        message: `Kiro EventStream transform failed: ${e.message || e}`,
      };
    }
  }

  const contentType = upstream.headers.get("content-type") || "";
  if (
    stream ||
    contentType.includes("text/event-stream") ||
    mode === "codex" ||
    mode === "antigravity" ||
    mode === "gemini-cli" ||
    mode === "kiro"
  ) {
    return {
      ok: true,
      kind: "stream",
      upstream,
      converter,
      toolNameMap,
    };
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: 502, message: "Upstream returned non-JSON", body: text };
  }

  const openaiOut = converter.responseMessage
    ? converter.responseMessage(data, openaiBody.model, { toolNameMap })
    : data;
  if (openaiOut && typeof openaiOut === "object") {
    openaiOut.model = openaiBody.model;
  }
  return { ok: true, kind: "json", payload: openaiOut };
}

function pickUsageFromChunk(ch) {
  if (!ch || typeof ch !== "object") return null;
  if (ch.usage && typeof ch.usage === "object") return ch.usage;
  return null;
}

/**
 * Per-request stream usage merge (OmniRoute-aligned via usageStats.mergeUsageSnapshots).
 * Does NOT sum every SSE chunk — keeps one request context (max of progressive fields).
 */
function mergeUsage(prev, next) {
  try {
    const { mergeUsageSnapshots } = require("./usageStats.cjs");
    return mergeUsageSnapshots(prev, next);
  } catch {
    if (!next) return prev || null;
    if (!prev) return { ...next };
    const pIn = Number(prev.prompt_tokens ?? prev.input_tokens ?? 0) || 0;
    const pOut = Number(prev.completion_tokens ?? prev.output_tokens ?? 0) || 0;
    const nIn = Number(next.prompt_tokens ?? next.input_tokens ?? 0) || 0;
    const nOut = Number(next.completion_tokens ?? next.output_tokens ?? 0) || 0;
    const prompt = Math.max(pIn, nIn);
    const completion = Math.max(pOut, nOut);
    return {
      ...prev,
      ...next,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }
}

async function pipeStream({
  upstream,
  res,
  converter,
  provider,
  model,
  clientModel,
  toolNameMap,
  onLog,
  openaiBody,
  guardCfg,
  guardMeta,
  headersWritten = false,
  idleTimeoutMs,
}) {
  // SSE headers are written lazily on the first real chunk. Until then the
  // response is still a plain HTTP response, so a dead account can be retried.
  const headerState = { written: Boolean(headersWritten) };
  const ensureHeaders = () => {
    if (headerState.written || res.headersSent) {
      headerState.written = true;
      return;
    }
    headerState.written = true;
    writeSseHeaders(res);
  };
  const state = converter.createStreamState
    ? converter.createStreamState(clientModel || model, { toolNameMap })
    : {};
  const usageHolder = { usage: null };
  const cfg = guard.normalizeGuardConfig(guardCfg);
  const streamScanner = cfg.enabled
    ? guard.createStreamScanner(openaiBody || {}, cfg)
    : null;
  const watchdog = createStreamWatchdog({
    idleTimeoutMs,
    retryCleanEmpty: true,
  });
  const streamCtx = {
    res,
    converter,
    state,
    provider,
    usageHolder,
    streamScanner,
    rawEvents: [],
    guardBlocked: { value: false },
    clientModel: clientModel || model,
    onLog,
    guardMeta: guardMeta || {},
    watchdog,
    ensureHeaders,
  };
  let streamError = null;
  try {
    await consumeUpstreamSse(upstream, streamCtx);
  } catch (e) {
    streamError = e;
  } finally {
    watchdog.dispose();
  }
  const outcome = watchdog.outcome(streamError);
  // Prefer converter stream state usage when chunks never carried usage fields
  if (!usageHolder.usage && state?.usage) {
    usageHolder.usage = state.usage;
  }

  // Final scan pass (covers late tool args / trailing content)
  if (streamScanner && !streamCtx.guardBlocked.value) {
    const decision = streamScanner.finalize();
    if (decision.findings?.length) {
      guard.activity.record({
        ...decision,
        model: clientModel || model,
        providerId: guardMeta?.providerId,
        account: guardMeta?.account,
        stream: true,
      });
    }
    if (decision.action === "block") {
      streamCtx.guardBlocked.value = true;
      onLog?.({
        level: "error",
        msg: `🛡 Guard BLOCKED stream (finalize): ${(decision.findings || [])
          .map((f) => f.ruleId)
          .slice(0, 6)
          .join(", ")}`,
        model: clientModel || model,
        guard: decision,
      });
      ensureHeaders();
      sendSse(res, guard.blockSseChunk(decision, { model: clientModel || model }));
    } else if (decision.action === "scrub" && decision.findings?.length) {
      onLog?.({
        level: "warn",
        msg: `🛡 Guard SCRUBBED stream: ${(decision.findings || [])
          .map((f) => f.ruleId)
          .slice(0, 6)
          .join(", ")}${decision.changed || streamScanner.scrubbed ? " (fragments cut)" : ""}`,
        model: clientModel || model,
        guard: decision,
      });
    } else if (decision.action === "alert" && decision.findings?.length) {
      onLog?.({
        level: "warn",
        msg: `🛡 Guard ALERT stream: ${(decision.findings || [])
          .map((f) => f.ruleId)
          .slice(0, 6)
          .join(", ")}`,
        model: clientModel || model,
        guard: decision,
      });
    }
  }

  // Never close the SSE stream silently. When nothing usable reached the client
  // the caller may still failover to another account (headers are sent lazily).
  if (!streamCtx.guardBlocked.value && isRetryableOutcome(outcome)) {
    onLog?.({
      level: "error",
      msg: `✗ stream ${outcome.kind}: ${operationalErrorMessage(outcome.message)} (bytes=${outcome.bytes}, elapsed=${outcome.elapsedMs}ms)${streamCtx.rawEvents.length ? `; upstream sample: ${streamCtx.rawEvents.join(" | ")}` : ""}`, 
      model: clientModel || model,
    });
    return { usage: usageHolder.usage || null, outcome, delivered: false };
  }

  if (outcome.kind === "truncated") {
    // Nothing reached the client yet (headers still unwritten) — treat as a dead
    // account and let the caller failover to the next key with the full request,
    // so the answer keeps flowing instead of silently cutting at N chunks.
    const nothingSent = !headerState.written && !res.headersSent;
    if (nothingSent) {
      onLog?.({
        level: "error",
        msg: `✗ stream truncated before delivery: ${operationalErrorMessage(outcome.message)} — retrying on next account (bytes=${outcome.bytes}, elapsed=${outcome.elapsedMs}ms)`,
        model: clientModel || model,
      });
      return { usage: usageHolder.usage || null, outcome, delivered: false };
    }
    onLog?.({
      level: "warn",
      msg: `⚠ stream truncated: ${outcome.message} — sending finish_reason=length to client`,
      model: clientModel || model,
    });
    ensureHeaders();
    sendSse(res, {
      id: `chatcmpl-truncated-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: clientModel || model,
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
    });
  }

  ensureHeaders();
  sendSseDone(res);
  return { usage: usageHolder.usage || null, outcome, delivered: true };
}

function processSseLines(
  lines,
  dataBuf,
  {
    res,
    converter,
    state,
    provider,
    usageHolder,
    streamScanner,
    guardBlocked,
    clientModel,
    onLog,
    guardMeta,
    watchdog,
    ensureHeaders,
    rawEvents,
  }
) {
  const emitToClient = (payload) => {
    ensureHeaders?.();
    sendSse(res, payload);
  };
  const emit = () => {
    if (guardBlocked?.value) {
      dataBuf.length = 0;
      return;
    }
    if (!dataBuf.length) return;
    const eventType = dataBuf.eventType || "";
    const raw = dataBuf.join("\n");
    dataBuf.length = 0;
    dataBuf.eventType = "";
    if (!raw || raw === "[DONE]") return;
    let json;
    try {
      json = JSON.parse(raw);
      if (eventType && json && typeof json === "object" && !json.type) {
        json = { ...json, type: eventType };
      }
    } catch {
      if (Array.isArray(rawEvents) && rawEvents.length < 4) {
        rawEvents.push(`non-json:${raw.slice(0, 800)}`);
      }
      return;
    }
    const streamError =
      json?.error ||
      (json?.type === "error" ? json.error || json : null) ||
      (json?.object === "error" ? json : null);
    if (streamError) {
      const err = new Error(upstreamErrorMessage(json));
      err.code = isCapacityErrorMessage(err.message)
        ? "UPSTREAM_CAPACITY"
        : "UPSTREAM_STREAM_ERROR";
      err.upstreamPayload = json;
      throw err;
    }
    if (Array.isArray(rawEvents) && rawEvents.length < 4) {
      rawEvents.push(JSON.stringify(json).slice(0, 800));
    }
    const parsed = provider?.parseStreamData ? provider.parseStreamData(json) : json;
    // Capture usage once per event (prefer converter output / final state over
    // re-merging the same object thrice — still max-merge, never sum chunks).
    if (usageHolder && parsed?.usage) {
      usageHolder.usage = mergeUsage(usageHolder.usage, parsed.usage);
    }
    const chunks = converter?.streamEvent ? converter.streamEvent(parsed, state) : [parsed];
    for (const ch of chunks || []) {
      if (!ch) continue;
      if (guardBlocked?.value) break;
      const u = pickUsageFromChunk(ch);
      if (usageHolder && u) usageHolder.usage = mergeUsage(usageHolder.usage, u);

      // Inline Guard scan on each OpenAI chunk before client receives it
      let outChunk = ch;
      if (streamScanner) {
        const decision = streamScanner.ingestChunk(ch);
        if (decision.action === "block") {
          guardBlocked.value = true;
          guard.activity.record({
            ...decision,
            model: clientModel,
            providerId: guardMeta?.providerId,
            account: guardMeta?.account,
            stream: true,
          });
          onLog?.({
            level: "error",
            msg: `🛡 Guard BLOCKED mid-stream: ${(decision.findings || [])
              .map((f) => f.ruleId)
              .slice(0, 6)
              .join(", ")}`,
            model: clientModel,
            guard: decision,
          });
          emitToClient(guard.blockSseChunk(decision, { model: clientModel }));
          return;
        }
        // scrub: rewrite chunk in place, never abort the stream
        if (decision.chunk) outChunk = decision.chunk;
        if (decision.action === "scrub" && decision.changed) {
          // activity recorded once at finalize; avoid flooding mid-stream
        }
      }

      watchdog?.onClientChunk(outChunk);
      emitToClient(outChunk);
    }
    // Final state.usage (Anthropic message_delta etc.) wins as latest snapshot
    if (usageHolder && state?.usage) {
      usageHolder.usage = mergeUsage(usageHolder.usage, state.usage);
    }
  };
  const processLine = (line) => {
    if (guardBlocked?.value) return false;
    if (line.startsWith("event:")) {
      dataBuf.eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5).trimStart();
      if (dataBuf.length && /^\s*[\[{]/.test(payload)) emit();
      dataBuf.push(payload);
    } else if (line.trim() === "") {
      emit();
    } else if (line.startsWith("{")) {
      dataBuf.push(line);
      emit();
    }
    return !guardBlocked?.value;
  };

  // A stream chunk commonly holds many SSE frames. Scanning it directly avoids a
  // regex split and a short-lived array/string allocation for every upstream read.
  // Return only the unfinished last line; callers append the next decoded bytes.
  if (typeof lines === "string") {
    let start = 0;
    while (start < lines.length) {
      const nl = lines.indexOf("\n", start);
      if (nl < 0) return { emit, tail: lines.slice(start) };
      const end = nl > start && lines.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (!processLine(lines.slice(start, end))) return { emit, tail: "" };
      start = nl + 1;
    }
    return { emit, tail: "" };
  }

  for (const line of lines) {
    if (!processLine(line)) break;
  }
  return { emit, tail: "" };
}

async function consumeUpstreamSse(upstream, ctx) {
  const { res, converter, state, provider, usageHolder, watchdog } = ctx;
  // Web ReadableStream
  if (upstream.body && typeof upstream.body.getReader === "function") {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const dataBuf = [];
    const onWatchdogAbort = () => {
      reader.cancel().catch(() => {});
    };
    watchdog?.signal?.addEventListener?.("abort", onWatchdogAbort, { once: true });
    try {
      while (true) {
        if (ctx.guardBlocked?.value || watchdog?.isAborted()) {
          try {
            await reader.cancel();
          } catch {
            /* */
          }
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        watchdog?.onBytes(value?.byteLength ?? value?.length ?? 0);
        // Parse complete SSE lines in one pass. This is the hot path: avoid
        // split(/\r?\n/) allocating an array for every network chunk.
        const parsed = processSseLines(
          buffer + decoder.decode(value, { stream: true }),
          dataBuf,
          ctx
        );
        buffer = parsed.tail;
      }
    } finally {
      watchdog?.signal?.removeEventListener?.("abort", onWatchdogAbort);
    }
    // Flush a possible final multi-byte UTF-8 sequence before processing the tail.
    if (!ctx.guardBlocked?.value) {
      const finalText = decoder.decode();
      if (finalText) buffer += finalText;
    }
    if (!ctx.guardBlocked?.value && buffer.trim()) {
      processSseLines([buffer], dataBuf, ctx);
    }
    if (!ctx.guardBlocked?.value) {
      processSseLines([], dataBuf, ctx).emit();
    }
    return;
  }

  // Node.js Readable body — stream line-by-line as data arrives
  if (upstream.body && typeof upstream.body[Symbol.asyncIterator] === "function") {
    let buffer = "";
    const dataBuf = [];
    for await (const chunk of upstream.body) {
      if (ctx.guardBlocked?.value || watchdog?.isAborted()) break;
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      watchdog?.onBytes(Buffer.byteLength(text));
      const parsed = processSseLines(buffer + text, dataBuf, ctx);
      buffer = parsed.tail;
    }
    if (!ctx.guardBlocked?.value && buffer.trim()) {
      processSseLines([buffer], dataBuf, ctx);
    }
    if (!ctx.guardBlocked?.value) {
      processSseLines([], dataBuf, ctx).emit();
    }
    return;
  }

  const textBody = await streamToString(upstream);
  watchdog?.onBytes(Buffer.byteLength(textBody || ""));
  const dataBuf = [];
  const parsed = processSseLines(textBody, dataBuf, ctx);
  if (parsed.tail.trim()) processSseLines([parsed.tail], dataBuf, ctx);
  processSseLines([], dataBuf, ctx).emit();
}

async function streamToString(upstream) {
  if (typeof upstream.text === "function") {
    try {
      return await upstream.text();
    } catch {
      /* */
    }
  }
  if (!upstream.body) return "";
  const chunks = [];
  for await (const chunk of upstream.body) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

module.exports = {
  handleChatCompletions,
  ensureBoot,
};
