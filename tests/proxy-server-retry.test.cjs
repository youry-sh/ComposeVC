const assert = require("node:assert/strict");
const test = require("node:test");

const retryPolicy = require("../electron/proxy/routing/retryPolicy.cjs");
const { classifyUpstreamError } = require("../electron/proxy/routing/limitDetect.cjs");

test("server errors receive bounded pool retries instead of stopping after one pass", () => {
  assert.equal(retryPolicy.MAX_SERVER_POOL_RECYCLES, 3);
  assert.equal(retryPolicy.poolRecycleLimit("server"), 3);
  assert.equal(retryPolicy.poolRecycleLimit("rate_limit"), 6);

  const firstServerFailure = {
    kind: "server",
    continueFailover: true,
    nextAttempt: 1,
    maxAttempts: 8,
    poolRecycles: 0,
  };
  assert.equal(retryPolicy.canRecyclePool(firstServerFailure), true);
  assert.equal(
    retryPolicy.canRecyclePool({ ...firstServerFailure, poolRecycles: 3 }),
    false,
    "server retries must stop after the bounded retry budget"
  );
});

test("the reported OpenAI HTTP 500 is classified into the server retry path", () => {
  const classified = classifyUpstreamError(
    500,
    "The server had an error processing your request. Sorry about that! You can retry your request."
  );
  assert.equal(classified.kind, "server");
  assert.equal(classified.retryable, true);
  assert.equal(
    retryPolicy.canRecyclePool({
      kind: classified.kind,
      continueFailover: classified.retryable,
      nextAttempt: 1,
      maxAttempts: 8,
      poolRecycles: 0,
    }),
    true
  );
});

test("server retry waits through the account cooldown", () => {
  const now = 1_000_000;
  assert.equal(retryPolicy.poolRecycleDelayMs("server", 1, [now + 4_000], now), 4_025);
  assert.equal(
    retryPolicy.poolRecycleDelayMs("server", 1, [now + 4_000, now + 2_000], now),
    2_025
  );
  assert.equal(retryPolicy.poolRecycleDelayMs("server", 2, [], now), 800);
  assert.equal(retryPolicy.poolRecycleDelayMs("rate_limit", 2, [now + 60_000], now), 800);
});

test("a new request waits for a short transient block but not quota or long blocks", () => {
  const now = 1_000_000;
  const transient = [{ state: { status: "error", blockedUntil: now + 4_000 } }];
  const quota = [{ state: { status: "quota", blockedUntil: now + 4_000 } }];
  const longError = [{ state: { status: "error", blockedUntil: now + 60_000 } }];

  assert.equal(retryPolicy.transientPoolWaitMs(transient, now), 4_025);
  assert.equal(retryPolicy.transientPoolWaitMs(quota, now), null);
  assert.equal(retryPolicy.transientPoolWaitMs(longError, now), null);
});

test("retry wait stops immediately when the client aborts", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = retryPolicy.waitForRetry(5_000, controller.signal);
  controller.abort();

  assert.equal(await waiting, false);
  assert.ok(Date.now() - startedAt < 500, "abort should not wait for the retry timer");
});
