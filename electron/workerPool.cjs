/**
 * WorkerPool — offload CPU-bound tasks to worker_threads so the main process
 * Event Loop is never blocked by JSON serialization, token counting, or 
 * message compaction.
 *
 * Pool keeps N workers alive, reuses them, and falls back to inline execution
 * if workers are unavailable (headless / packaged without node).
 */

const { Worker, isMainThread, parentPort } = require("worker_threads");
const path = require("path");
const os = require("os");

const MAX_WORKERS = 1000;
const DEFAULT_ACTIVE_WORKERS = Math.max(1, Math.min(os.cpus().length - 1 || 1, 32));
const configuredWorkers = Number.parseInt(process.env.LOPSTER_WORKERS || "", 10);
const ACTIVE_WORKERS = Number.isFinite(configuredWorkers)
  ? Math.max(1, Math.min(MAX_WORKERS, configuredWorkers))
  : DEFAULT_ACTIVE_WORKERS;
const MAX_PENDING_TASKS = 10000;
const workerPool = [];
let poolReady = false;

/** Simple inline fallback when workers are unavailable. */
const INLINE = {
  countTokens(text) {
    // Rough char-based estimate — fast, never blocks
    return Math.ceil((text || "").length / 4);
  },
  countMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let sum = 0;
    for (const msg of messages) {
      if (!msg) continue;
      sum += this.countTokens(msg.content);
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          sum += this.countTokens(tc.name);
          sum += this.countTokens(JSON.stringify(tc.input));
        }
      }
    }
    return sum;
  },
  compactMessages({ messages, keepRecent }) {
    // Naive truncation fallback: keep last N messages
    if (!Array.isArray(messages)) return { compactedMessages: messages || [], tokensBefore: 0, tokensAfter: 0 };
    const keep = Math.max(keepRecent || 16, 4);
    const tokensBefore = this.countMessagesTokens(messages);
    const compacted = messages.slice(-keep);
    const tokensAfter = this.countMessagesTokens(compacted);
    return { compactedMessages: compacted, tokensBefore, tokensAfter, removedCount: messages.length - compacted.length };
  },
  guardScanOpenAIResponse({ payload, openaiBody, config }) {
    // Inline fallback when worker threads are unavailable (packaged headless).
    const { scanOpenAIResponse } = require("../proxy/guard/scan.cjs");
    return scanOpenAIResponse(payload, openaiBody || {}, config || {});
  },
};

function getWorkerPath() {
  return path.join(__dirname, "workerPoolWorker.cjs");
}

/**
 * Acquire a free worker or create one if pool not full.
 * Returns null if workers are not supported.
 */
function createWorker() {
  if (typeof Worker === "undefined" || !isMainThread || workerPool.length >= ACTIVE_WORKERS) return null;
  try {
    const worker = new Worker(getWorkerPath());
    const entry = { worker, busy: false, current: null, ready: false };
    worker.on("error", (error) => {
      const current = entry.current;
      if (current) {
        clearTimeout(current.timeout);
        current.reject(error);
        entry.current = null;
      }
      const index = workerPool.indexOf(entry);
      if (index >= 0) workerPool.splice(index, 1);
      dispatch();
    });
    worker.on("exit", () => {
      const index = workerPool.indexOf(entry);
      if (index >= 0) workerPool.splice(index, 1);
      dispatch();
    });
    workerPool.push(entry);
    poolReady = true;
    return entry;
  } catch {
    return null;
  }
}

function acquireWorker() {
  const idle = workerPool.find((entry) => !entry.busy);
  return idle || createWorker();
}

const pendingTasks = [];
let warmupScheduled = false;

function warmup(target = ACTIVE_WORKERS) {
  const limit = Math.max(1, Math.min(ACTIVE_WORKERS, Number(target) || ACTIVE_WORKERS));
  while (workerPool.length < limit) {
    if (!createWorker()) break;
  }
  return stats();
}

function warmupAsync(target = ACTIVE_WORKERS) {
  if (warmupScheduled) return Promise.resolve(stats());
  warmupScheduled = true;
  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        resolve(warmup(target));
      } finally {
        warmupScheduled = false;
      }
    });
  });
}

function dispatch() {
  while (pendingTasks.length) {
    const worker = acquireWorker();
    if (!worker || worker.busy) return;
    const task = pendingTasks.shift();
    worker.busy = true;
    const timeout = setTimeout(() => {
      worker.busy = false;
      worker.current = null;
      task.reject(new Error("Worker task timeout"));
      try { worker.worker.terminate(); } catch {}
      dispatch();
    }, 30000);
    worker.current = { reject: task.reject, timeout };
    const handler = (message) => {
      if (message && message.result === "ready") {
        worker.ready = true;
        return;
      }
      clearTimeout(timeout);
      worker.worker.removeListener("message", handler);
      worker.busy = false;
      worker.current = null;
      if (message && message.error) task.reject(new Error(message.error));
      else task.resolve(message?.result);
      dispatch();
    };
    worker.worker.on("message", handler);
    try {
      worker.worker.postMessage({ task: task.name, payload: task.payload });
    } catch (error) {
      clearTimeout(timeout);
      worker.worker.removeListener("message", handler);
      worker.busy = false;
      worker.current = null;
      task.reject(error);
    }
  }
}

function exec(task, payload) {
  if (typeof Worker === "undefined" || !isMainThread) {
    return Promise.resolve().then(() => INLINE[task] ? INLINE[task](payload) : null);
  }
  return new Promise((resolve, reject) => {
    if (pendingTasks.length >= MAX_PENDING_TASKS) {
      reject(new Error("Worker queue limit reached"));
      return;
    }
    pendingTasks.push({ name: task, payload, resolve, reject });
    dispatch();
  });
}

/** Drain all workers (call on app quit / cache flush). */
function terminate() {
  const error = new Error("Worker pool terminated");
  while (pendingTasks.length) pendingTasks.shift().reject(error);
  for (const entry of workerPool) {
    if (entry.current) {
      clearTimeout(entry.current.timeout);
      entry.current.reject(error);
      entry.current = null;
      entry.busy = false;
    }
    try { entry.worker.terminate(); } catch { /* */ }
  }
  workerPool.length = 0;
  poolReady = false;
  warmupScheduled = false;
}

function stats() {
  return {
    maxWorkers: MAX_WORKERS,
    activeWorkers: ACTIVE_WORKERS,
    runningWorkers: workerPool.length,
    busyWorkers: workerPool.filter((entry) => entry.busy).length,
    pendingTasks: pendingTasks.length,
    poolReady,
  };
}

module.exports = {
  exec,
  terminate,
  INLINE,
  MAX_WORKERS,
  ACTIVE_WORKERS,
  MAX_PENDING_TASKS,
  stats,
  warmup,
  warmupAsync,
};

if (isMainThread && process.env.LOPSTER_WORKERS_WARMUP !== "0") {
  warmupAsync();
}
