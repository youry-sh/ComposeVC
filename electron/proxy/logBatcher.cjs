/**
 * logBatcher — coalesce high-frequency proxy logs into debounced batches so the
 * renderer never receives one IPC event per line (that churns React renders and
 * freezes the UI while the proxy stream is active).
 *
 * Usage:
 *   const batcher = createLogBatcher((batch) => broadcast("proxy:log/batch", { entries: batch }));
 *   batcher.push(logEntry);   // cheap, non-blocking
 *   batcher.flush();          // force-flush (before shutdown / immediately)
 *
 * The batch callback receives an ARRAY of log entries. A fixed frame + debounce
 * cap keeps both throughput and latency predictable under heavy failover loops.
 */

function createLogBatcher(emitBatch, opts = {}) {
  const maxBatch = Math.max(1, Number(opts.maxBatch) || 50);
  const flushMs = Math.max(10, Number(opts.flushMs) || 120);
  const maxQueued = Math.max(maxBatch, Number(opts.maxQueued) || 500);

  let queue = [];
  let timer = null;
  let flushing = false;

  function push(entry) {
    queue.push(entry);
    if (queue.length >= maxQueued) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(flush, flushMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!queue.length || flushing) return;
    const batch = queue;
    queue = [];
    flushing = true;
    try {
      const slices = [];
      for (let i = 0; i < batch.length; i += maxBatch) {
        slices.push(batch.slice(i, i + maxBatch));
      }
      // One emit per slice, scheduled so the renderer can keep up and we never
      // block the main process Event Loop on a massive array in one IPC send.
      for (const slice of slices) {
        queueMicrotask(() => emitBatch(slice));
      }
    } finally {
      flushing = false;
    }
  }

  return { push, flush, size: () => queue.length };
}

module.exports = { createLogBatcher };
