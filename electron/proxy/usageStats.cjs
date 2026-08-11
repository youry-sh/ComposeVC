/**
 * Persistent proxy usage aggregation (all providers).
 * Token counters use decimal strings so totals can grow past Number.MAX_SAFE_INTEGER
 * (billions / trillions) without precision loss.
 */

const fs = require("fs");
const path = require("path");

const DIR = "proxy";
const FILE = "usage-stats.json";

const listeners = new Set();
const forwardRecordListeners = new Set();
let forwardMode = false;
let cache = null;
let userDataPath = null;
let saveTimer = null;
let dirty = false;

/**
 * Forward mode (used by the standalone proxy child process):
 * record() does NOT touch the local cache/disk — each entry is forwarded to
 * the listeners instead, and the APP process (single disk writer) aggregates.
 */
function setForwardMode(v) {
  forwardMode = Boolean(v);
}

function onForwardRecord(fn) {
  forwardRecordListeners.add(fn);
  return () => forwardRecordListeners.delete(fn);
}

function emptyTotals() {
  return {
    requests: "0",
    promptTokens: "0",
    completionTokens: "0",
    totalTokens: "0",
    reasoningTokens: "0",
    cacheReadTokens: "0",
    cacheCreationTokens: "0",
    streamRequests: "0",
    jsonRequests: "0",
    errorRequests: "0",
  };
}

function emptyStats() {
  return {
    version: 1,
    totals: emptyTotals(),
    byModel: {},
    byProvider: {},
    updatedAt: 0,
    createdAt: Date.now(),
  };
}

function statsPath(ud) {
  return path.join(ud, DIR, FILE);
}

function isDigits(s) {
  return typeof s === "string" && /^\d+$/.test(s);
}

function toBig(v) {
  if (typeof v === "bigint") return v < 0n ? 0n : v;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return 0n;
    if (v > Number.MAX_SAFE_INTEGER) return BigInt(Math.trunc(v));
    return BigInt(Math.trunc(v));
  }
  if (typeof v === "string") {
    const t = v.trim().replace(/[,_\s]/g, "");
    if (!t || t === "0") return 0n;
    if (/^\d+$/.test(t)) return BigInt(t);
    const n = Number(t);
    if (Number.isFinite(n) && n > 0) return BigInt(Math.trunc(n));
    return 0n;
  }
  return 0n;
}

function addStr(a, b) {
  return (toBig(a) + toBig(b)).toString();
}

function normalizeBucket(raw) {
  const base = emptyTotals();
  if (!raw || typeof raw !== "object") return base;
  for (const k of Object.keys(base)) {
    const v = raw[k];
    base[k] = isDigits(String(v ?? "0")) ? String(v) : toBig(v).toString();
  }
  return base;
}

function normalizeStats(raw) {
  const base = emptyStats();
  if (!raw || typeof raw !== "object") return base;
  const out = {
    version: 1,
    totals: normalizeBucket(raw.totals),
    byModel: {},
    byProvider: {},
    updatedAt: Number(raw.updatedAt) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
  };
  if (raw.byModel && typeof raw.byModel === "object") {
    for (const [k, v] of Object.entries(raw.byModel)) {
      if (!k) continue;
      out.byModel[String(k)] = normalizeBucket(v);
    }
  }
  if (raw.byProvider && typeof raw.byProvider === "object") {
    for (const [k, v] of Object.entries(raw.byProvider)) {
      if (!k) continue;
      out.byProvider[String(k)] = normalizeBucket(v);
    }
  }
  return out;
}

function emit(stats) {
  for (const fn of listeners) {
    try {
      fn(stats);
    } catch {
      /* */
    }
  }
}

function scheduleSave() {
  dirty = true;
  if (!userDataPath) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, 400);
}

async function flushSave() {
  if (!userDataPath || !cache || !dirty) return;
  dirty = false;
  try {
    const dir = path.join(userDataPath, DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = statsPath(userDataPath) + ".tmp";
    const file = statsPath(userDataPath);
    await fs.promises.writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await fs.promises.rename(tmp, file);
  } catch {
    dirty = true;
  }
}

async function init(ud) {
  userDataPath = ud;
  if (cache) return cache;
  try {
    const raw = await fs.promises.readFile(statsPath(ud), "utf8");
    cache = normalizeStats(JSON.parse(raw));
  } catch {
    cache = emptyStats();
    dirty = true;
    scheduleSave();
  }
  return cache;
}

function getSnapshot() {
  if (!cache) cache = emptyStats();
  // deep-ish clone for IPC safety
  return JSON.parse(JSON.stringify(cache));
}

function bumpBucket(bucket, delta) {
  bucket.requests = addStr(bucket.requests, delta.requests || 0);
  bucket.promptTokens = addStr(bucket.promptTokens, delta.promptTokens || 0);
  bucket.completionTokens = addStr(bucket.completionTokens, delta.completionTokens || 0);
  bucket.totalTokens = addStr(bucket.totalTokens, delta.totalTokens || 0);
  bucket.reasoningTokens = addStr(bucket.reasoningTokens, delta.reasoningTokens || 0);
  bucket.cacheReadTokens = addStr(bucket.cacheReadTokens, delta.cacheReadTokens || 0);
  bucket.cacheCreationTokens = addStr(bucket.cacheCreationTokens, delta.cacheCreationTokens || 0);
  if (delta.stream) bucket.streamRequests = addStr(bucket.streamRequests, 1);
  if (delta.json) bucket.jsonRequests = addStr(bucket.jsonRequests, 1);
  if (delta.error) bucket.errorRequests = addStr(bucket.errorRequests, 1);
}

/**
 * OmniRoute-aligned token accounting (see OmniRoute src/lib/usage/tokenAccounting.ts
 * + computeBillableTokens): per-request context, no double-count of cache breakdown.
 *
 * Rules:
 * - Prefer prompt_tokens when present (already full OpenAI-normalized input).
 * - Claude-style input_tokens is non-cached only → add cache_read + cache_creation.
 * - Output = completion_tokens || output_tokens.
 * - Reasoning from completion_tokens_details.reasoning_tokens / reasoning_tokens.
 * - Billable total = input + output + reasoning (cache is inside input, not added again).
 */
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getPromptTokenDetails(tokens) {
  const r = asRecord(tokens);
  const promptDetails = asRecord(r.prompt_tokens_details);
  if (Object.keys(promptDetails).length > 0) return promptDetails;
  return asRecord(r.input_tokens_details);
}

function getPromptCacheReadTokens(tokens) {
  const r = asRecord(tokens);
  const d = getPromptTokenDetails(r);
  return toBig(
    r.cacheRead ??
      r.cache_read_input_tokens ??
      r.cached_tokens ??
      r.prompt_cache_hit_tokens ??
      d.cached_tokens ??
      0
  );
}

function getPromptCacheCreationTokens(tokens) {
  const r = asRecord(tokens);
  const d = getPromptTokenDetails(r);
  return toBig(
    r.cacheCreation ??
      r.cache_creation_input_tokens ??
      d.cache_creation_tokens ??
      0
  );
}

/** True total input tokens for one request (context), OmniRoute getLoggedInputTokens. */
function getLoggedInputTokens(tokens) {
  const r = asRecord(tokens);
  if (r.input != null) return toBig(r.input);
  // Prefer prompt_tokens: translators already put full input there; do NOT re-add cache.
  // prompt_tokens_str keeps BigInt-safe values across stream merges.
  if (r.prompt_tokens_str != null) return toBig(r.prompt_tokens_str);
  if (r.prompt_tokens != null) return toBig(r.prompt_tokens);
  if (r.promptTokens != null) return toBig(r.promptTokens);
  if (r.promptTokenCount != null) return toBig(r.promptTokenCount);
  if (r.input_tokens != null) {
    // Anthropic: input_tokens is non-cached portion only
    return (
      toBig(r.input_tokens) +
      toBig(r.cache_read_input_tokens) +
      toBig(r.cache_creation_input_tokens)
    );
  }
  return 0n;
}

function getLoggedOutputTokens(tokens) {
  const r = asRecord(tokens);
  if (r.output != null) return toBig(r.output);
  if (r.completion_tokens_str != null) return toBig(r.completion_tokens_str);
  return toBig(
    r.completion_tokens ??
      r.output_tokens ??
      r.completionTokens ??
      r.candidatesTokenCount ??
      0
  );
}

function getReasoningTokens(tokens) {
  const r = asRecord(tokens);
  const details = asRecord(r.completion_tokens_details);
  const outDetails = asRecord(r.output_tokens_details);
  return toBig(
    r.reasoning ??
      r.reasoning_tokens ??
      details.reasoning_tokens ??
      outDetails.reasoning_tokens ??
      r.thoughtsTokenCount ??
      0
  );
}

/**
 * Normalize OpenAI/Claude/Gemini usage for one completed request.
 * Returns BigInt fields for durable aggregation.
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return {
      promptTokens: 0n,
      completionTokens: 0n,
      totalTokens: 0n,
      reasoningTokens: 0n,
      cacheReadTokens: 0n,
      cacheCreationTokens: 0n,
    };
  }
  // Gemini usageMetadata passthrough
  if (usage.usageMetadata && typeof usage.usageMetadata === "object") {
    return normalizeUsage({
      prompt_tokens: usage.usageMetadata.promptTokenCount,
      completion_tokens: usage.usageMetadata.candidatesTokenCount,
      reasoning_tokens: usage.usageMetadata.thoughtsTokenCount,
      total_tokens: usage.usageMetadata.totalTokenCount,
    });
  }

  const prompt = getLoggedInputTokens(usage);
  const completion = getLoggedOutputTokens(usage);
  const reasoning = getReasoningTokens(usage);
  const cacheRead = getPromptCacheReadTokens(usage);
  const cacheCreation = getPromptCacheCreationTokens(usage);

  // Billable / displayed total = input + output + reasoning (OmniRoute computeBillableTokens).
  // Do NOT trust total_tokens blindly if it under-counts reasoning or double-counts cache.
  let total = prompt + completion + reasoning;
  const reported = toBig(
    usage.total_tokens_str ?? usage.total_tokens ?? usage.totalTokens ?? usage.totalTokenCount ?? 0
  );
  // If provider reported a larger total (e.g. includes something we missed), take max.
  if (reported > total) total = reported;

  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    reasoningTokens: reasoning,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
  };
}

/**
 * Record one completed proxy request (all providers).
 * @param {{ model?: string, providerId?: string, usage?: object|null, stream?: boolean, error?: boolean }} entry
 */
function record(entry = {}) {
  if (forwardMode) {
    // Standalone child: forward the entry to the app process (single writer).
    const copy = { ...entry };
    for (const fn of forwardRecordListeners) {
      try {
        fn(copy);
      } catch {
        /* */
      }
    }
    return getSnapshot();
  }
  if (!cache) cache = emptyStats();
  const usage = normalizeUsage(entry.usage);
  const model = String(entry.model || entry.clientModel || "unknown").trim() || "unknown";
  const providerId = String(entry.providerId || entry.provider || "unknown").trim() || "unknown";
  const delta = {
    requests: 1,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens: usage.reasoningTokens || 0n,
    cacheReadTokens: usage.cacheReadTokens || 0n,
    cacheCreationTokens: usage.cacheCreationTokens || 0n,
    stream: Boolean(entry.stream),
    json: !entry.stream && !entry.error,
    error: Boolean(entry.error),
  };

  bumpBucket(cache.totals, delta);

  if (!cache.byModel[model]) cache.byModel[model] = emptyTotals();
  bumpBucket(cache.byModel[model], delta);

  if (!cache.byProvider[providerId]) cache.byProvider[providerId] = emptyTotals();
  bumpBucket(cache.byProvider[providerId], delta);

  cache.updatedAt = Date.now();
  scheduleSave();
  const snap = getSnapshot();
  emit(snap);
  return snap;
}

async function reset() {
  cache = emptyStats();
  dirty = true;
  await flushSave();
  const snap = getSnapshot();
  emit(snap);
  return snap;
}

function onUpdate(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Public view for UI: totals + top models sorted by total tokens / requests.
 */
function publicView(limitModels = 40) {
  const snap = getSnapshot();
  const models = Object.entries(snap.byModel || {})
    .map(([id, b]) => ({
      id,
      requests: b.requests,
      promptTokens: b.promptTokens,
      completionTokens: b.completionTokens,
      totalTokens: b.totalTokens,
      reasoningTokens: b.reasoningTokens || "0",
      cacheReadTokens: b.cacheReadTokens || "0",
      cacheCreationTokens: b.cacheCreationTokens || "0",
      streamRequests: b.streamRequests,
      jsonRequests: b.jsonRequests,
      errorRequests: b.errorRequests,
    }))
    .sort((a, b) => {
      const tb = toBig(b.totalTokens) - toBig(a.totalTokens);
      if (tb !== 0n) return tb > 0n ? 1 : -1;
      const rb = toBig(b.requests) - toBig(a.requests);
      if (rb !== 0n) return rb > 0n ? 1 : -1;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(1, limitModels | 0));

  const providers = Object.entries(snap.byProvider || {})
    .map(([id, b]) => ({
      id,
      requests: b.requests,
      promptTokens: b.promptTokens,
      completionTokens: b.completionTokens,
      totalTokens: b.totalTokens,
      reasoningTokens: b.reasoningTokens || "0",
      cacheReadTokens: b.cacheReadTokens || "0",
      cacheCreationTokens: b.cacheCreationTokens || "0",
      streamRequests: b.streamRequests,
      jsonRequests: b.jsonRequests,
      errorRequests: b.errorRequests,
    }))
    .sort((a, b) => {
      const tb = toBig(b.totalTokens) - toBig(a.totalTokens);
      if (tb !== 0n) return tb > 0n ? 1 : -1;
      const rb = toBig(b.requests) - toBig(a.requests);
      if (rb !== 0n) return rb > 0n ? 1 : -1;
      return a.id.localeCompare(b.id);
    });

  return {
    totals: snap.totals,
    models,
    providers,
    modelCount: Object.keys(snap.byModel || {}).length,
    providerCount: Object.keys(snap.byProvider || {}).length,
    updatedAt: snap.updatedAt,
    createdAt: snap.createdAt,
  };
}

function bigToJsonNum(v) {
  // Prefer number when safe; always also store *_str for BigInt path.
  if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v.toString();
}

/**
 * Merge successive stream usage snapshots for ONE request (not sum of chunks).
 * Mirrors OmniRoute: take latest full counters with max() so progressive
 * completion_tokens grow while prompt_tokens stay the request context size.
 */
function mergeUsageSnapshots(prev, next) {
  if (!next || typeof next !== "object") return prev || null;
  if (!prev || typeof prev !== "object") return { ...next };

  const a = normalizeUsage(prev);
  const b = normalizeUsage(next);
  const prompt = a.promptTokens > b.promptTokens ? a.promptTokens : b.promptTokens;
  const completion =
    a.completionTokens > b.completionTokens ? a.completionTokens : b.completionTokens;
  const reasoning =
    a.reasoningTokens > b.reasoningTokens ? a.reasoningTokens : b.reasoningTokens;
  const cacheRead =
    a.cacheReadTokens > b.cacheReadTokens ? a.cacheReadTokens : b.cacheReadTokens;
  const cacheCreation =
    a.cacheCreationTokens > b.cacheCreationTokens
      ? a.cacheCreationTokens
      : b.cacheCreationTokens;
  const total = prompt + completion + reasoning;

  return {
    ...prev,
    ...next,
    prompt_tokens: bigToJsonNum(prompt),
    completion_tokens: bigToJsonNum(completion),
    total_tokens: bigToJsonNum(total),
    // String forms always present — normalizeUsage prefers them (BigInt-safe)
    prompt_tokens_str: prompt.toString(),
    completion_tokens_str: completion.toString(),
    total_tokens_str: total.toString(),
    reasoning_tokens: bigToJsonNum(reasoning),
    cache_read_input_tokens: bigToJsonNum(cacheRead),
    cache_creation_input_tokens: bigToJsonNum(cacheCreation),
  };
}

module.exports = {
  init,
  record,
  reset,
  getSnapshot,
  publicView,
  onUpdate,
  setForwardMode,
  onForwardRecord,
  flushSave,
  normalizeUsage,
  mergeUsageSnapshots,
  getLoggedInputTokens,
  getLoggedOutputTokens,
  getReasoningTokens,
  toBig,
};
