/**
 * Worker thread entry for WorkerPool.
 * Receives CPU-bound tasks via parentPort and returns results.
 * Keeps the main process Event Loop free.
 */

const { parentPort, isMainThread } = require("worker_threads");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

if (isMainThread) {
  module.exports = null;
  process.exit(0);
}

/** Rough token estimate (char-based, fast, non-blocking). */
function countTokens(text) {
  return Math.ceil((text || "").length / 4);
}

function countMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let sum = 0;
  for (const msg of messages) {
    if (!msg) continue;
    sum += countTokens(msg.content);
    if (Array.isArray(msg.toolCalls)) {
      for (const tc of msg.toolCalls) {
        sum += countTokens(tc.name);
        sum += countTokens(JSON.stringify(tc.input));
      }
    }
  }
  return sum;
}

/** Keep last N messages, return counts. */
function compactMessages({ messages, keepRecent }) {
  if (!Array.isArray(messages)) {
    return { compactedMessages: messages || [], tokensBefore: 0, tokensAfter: 0 };
  }
  const keep = Math.max(keepRecent || 16, 4);
  const tokensBefore = countMessagesTokens(messages);
  const compacted = messages.slice(-keep);
  const tokensAfter = countMessagesTokens(compacted);
  return {
    compactedMessages: compacted,
    tokensBefore,
    tokensAfter,
    removedCount: messages.length - compacted.length,
  };
}

function stringifySafe(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

parentPort.on("message", (msg) => {
  const { task, payload } = msg || {};
  try {
    switch (task) {
      case "countTokens":
        parentPort.postMessage({ result: countTokens(payload?.text || payload) });
        break;
      case "countMessagesTokens":
        parentPort.postMessage({ result: countMessagesTokens(payload?.messages || payload) });
        break;
      case "compactMessages":
        parentPort.postMessage({ result: compactMessages(payload || {}) });
        break;
      case "parseFileContent": {
        const { parseFileContent } = require("./codeImpactEngine.cjs");
        parentPort.postMessage({ result: parseFileContent(payload?.content || "", payload?.filePath || "") });
        break;
      }
      case "hashContent":
        parentPort.postMessage({ result: crypto.createHash("sha1").update(String(payload?.content || "").slice(0, 64 * 1024)).digest("hex").slice(0, 12) });
        break;
      case "serialize":
        parentPort.postMessage({ result: JSON.stringify(payload?.value ?? null) });
        break;
      case "deserialize":
        parentPort.postMessage({ result: JSON.parse(String(payload?.text || "null")) });
        break;
      case "countArray":
        parentPort.postMessage({ result: Array.isArray(payload?.items) ? payload.items.length : 0 });
        break;
      case "formatToolResult": {
        const value = payload?.value;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const limit = Number(payload?.limit) > 0 ? Number(payload.limit) : 6000;
        parentPort.postMessage({ result: text.length <= limit ? text : `${text.slice(0, limit)}\\n…[TRUNCATED]` });
        break;
      }
      case "guardScanOpenAIResponse": {
        const { scanOpenAIResponse } = require("./proxy/guard/scan.cjs");
        parentPort.postMessage({ result: scanOpenAIResponse(payload?.payload, payload?.openaiBody || {}, payload?.config || {}) });
        break;
      }
      case "convertRequest": {
        const { getConverter, bootstrap } = require("./proxy/convert/registry.cjs");
        bootstrap();
        const converter = getConverter(payload?.from || "openai", payload?.to);
        if (!converter?.request) throw new Error(`Converter not found: ${payload?.to}`);
        parentPort.postMessage({ result: converter.request(payload.body, payload.options || {}) });
        break;
      }
      case "runProcess": {
        const result = spawnSync(String(payload?.command || ""), Array.isArray(payload?.args) ? payload.args.map(String) : [], {
          cwd: payload?.cwd || process.cwd(),
          encoding: "utf8",
          timeout: Math.max(1000, Math.min(120000, Number(payload?.timeoutMs) || 90000)),
          windowsHide: true,
          env: { ...process.env, ...(payload?.env || {}) },
        });
        parentPort.postMessage({ result: {
          code: result.status == null ? -1 : result.status,
          stdout: String(result.stdout || "").trim(),
          stderr: String(result.stderr || "").trim(),
          ok: result.status === 0 && !result.error,
          error: result.error?.message || null,
        } });
        break;
      }
      default:
        parentPort.postMessage({ error: `Unknown task: ${task}` });
    }
  } catch (err) {
    parentPort.postMessage({ error: err?.message || String(err) });
  }
});

// Signal readiness
parentPort.postMessage({ result: "ready" });
