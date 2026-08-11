/**
 * Stream lifecycle watchdog for the proxy pipeline.
 *
 * An upstream SSE connection can go quiet (proxy drop, key revoked mid-stream,
 * provider hang). Without a watchdog the read loop just ends, [DONE] is written
 * and the client sees a truncated answer with no error and no retry.
 *
 * This module makes every silent death observable:
 *   - idle timeout: no bytes from upstream for N ms -> abort with a real reason
 *   - hard cap: total stream duration guard so nothing hangs forever
 *   - outcome classification: clean | clean_empty | truncated | empty | idle_timeout | error
 */

const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_STREAM_MS = 30 * 60_000;

const RETRYABLE_OUTCOMES = new Set(["clean_empty", "empty", "idle_timeout", "error"]);

function createStreamWatchdog(opts = {}) {
  const idleTimeoutMs = Math.max(
    5_000,
    Number(opts.idleTimeoutMs) > 0 ? Number(opts.idleTimeoutMs) : DEFAULT_IDLE_TIMEOUT_MS
  );
  const maxStreamMs = Math.max(
    idleTimeoutMs,
    Number(opts.maxStreamMs) > 0 ? Number(opts.maxStreamMs) : DEFAULT_MAX_STREAM_MS
  );

  const ctrl = new AbortController();
  const startedAt = Date.now();
  const state = {
    bytes: 0,
    chunks: 0,
    deltas: 0,
    finishReason: null,
    lastDataAt: startedAt,
    aborted: false,
    abortReason: null,
  };

  let idleTimer = null;
  let hardTimer = null;

  const abortWith = (reason) => {
    if (state.aborted) return;
    state.aborted = true;
    state.abortReason = reason;
    try {
      ctrl.abort(new Error(reason));
    } catch {
      /* */
    }
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortWith(`stream_idle_timeout_${idleTimeoutMs}ms`);
    }, idleTimeoutMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  };

  hardTimer = setTimeout(() => {
    abortWith(`stream_max_duration_${maxStreamMs}ms`);
  }, maxStreamMs);
  if (typeof hardTimer.unref === "function") hardTimer.unref();
  armIdle();

  return {
    signal: ctrl.signal,

    onBytes(len) {
      state.bytes += Number(len) || 0;
      state.chunks += 1;
      state.lastDataAt = Date.now();
      armIdle();
    },

    onClientChunk(chunk) {
      const choice = chunk?.choices?.[0];
      if (!choice) return;
      const d = choice.delta || {};
      if (
        (typeof d.content === "string" && d.content.length) ||
        (typeof d.reasoning_content === "string" && d.reasoning_content.length) ||
        (Array.isArray(d.tool_calls) && d.tool_calls.length) ||
        d.function_call
      ) {
        state.deltas += 1;
      }
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    },

    isAborted: () => state.aborted,
    abortReason: () => state.abortReason,
    sawContent: () => state.deltas > 0,

    dispose() {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      idleTimer = null;
      hardTimer = null;
    },

    outcome(err) {
      const elapsedMs = Date.now() - startedAt;
      const base = {
        elapsedMs,
        bytes: state.bytes,
        chunks: state.chunks,
        deltas: state.deltas,
        finishReason: state.finishReason,
      };
      if (state.aborted) {
        return {
          ...base,
          kind: "idle_timeout",
          retryable: state.deltas === 0,
          message:
            state.deltas === 0
              ? `Upstream stream produced no data (${state.abortReason})`
              : `Upstream stream stalled after ${state.deltas} chunk(s) (${state.abortReason})`,
        };
      }
      if (err) {
        return {
          ...base,
          kind: "error",
          retryable: state.deltas === 0,
          message: `Upstream stream error: ${err.message || err}`,
        };
      }
      if (state.deltas === 0 && state.finishReason) {
        return {
          ...base,
          kind: "clean_empty",
          retryable: opts.retryCleanEmpty === true,
          message: `Upstream completed with ${state.finishReason} but no visible content`,
        };
      }
      if (state.deltas === 0) {
        return {
          ...base,
          kind: "empty",
          retryable: true,
          message:
            state.bytes > 0
              ? `Upstream closed after ${state.bytes} bytes without any content chunk`
              : "Upstream closed the stream immediately without any data",
        };
      }
      if (!state.finishReason) {
        return {
          ...base,
          kind: "truncated",
          retryable: false,
          message: `Upstream stream ended without finish_reason after ${state.deltas} chunk(s)`,
        };
      }
      return { ...base, kind: "clean", retryable: false, message: "ok" };
    },
  };
}

function isRetryableOutcome(outcome) {
  if (!outcome) return false;
  return Boolean(outcome.retryable) && RETRYABLE_OUTCOMES.has(outcome.kind);
}

module.exports = {
  createStreamWatchdog,
  isRetryableOutcome,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_STREAM_MS,
};
