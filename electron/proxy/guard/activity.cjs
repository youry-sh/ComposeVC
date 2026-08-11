/**
 * In-memory ring buffer of Guard decisions (for /v1/guard/status + logs).
 */

const MAX = 100;
const recent = [];
let stats = {
  scanned: 0,
  allowed: 0,
  alerted: 0,
  scrubbed: 0,
  blocked: 0,
  lastBlockedAt: null,
  lastAlertAt: null,
  lastScrubAt: null,
};

function record(entry) {
  const row = {
    ts: Date.now(),
    action: entry.action || "allow",
    severity: entry.severity || "low",
    model: entry.model || null,
    providerId: entry.providerId || null,
    account: entry.account || null,
    stream: Boolean(entry.stream),
    findings: (entry.findings || []).slice(0, 12).map((f) => ({
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      match: f.match,
      source: f.source,
    })),
    reason: entry.reason || null,
    changed: Boolean(entry.changed),
  };
  recent.push(row);
  if (recent.length > MAX) recent.shift();

  stats.scanned += 1;
  if (row.action === "block") {
    stats.blocked += 1;
    stats.lastBlockedAt = row.ts;
  } else if (row.action === "scrub") {
    stats.scrubbed += 1;
    stats.lastScrubAt = row.ts;
  } else if (row.action === "alert") {
    stats.alerted += 1;
    stats.lastAlertAt = row.ts;
  } else {
    stats.allowed += 1;
  }
  return row;
}

function getRecent(limit = 50) {
  const n = Math.max(1, Math.min(MAX, Number(limit) || 50));
  return recent.slice(-n).reverse();
}

function getStats() {
  return { ...stats };
}

function reset() {
  recent.length = 0;
  stats = {
    scanned: 0,
    allowed: 0,
    alerted: 0,
    scrubbed: 0,
    blocked: 0,
    lastBlockedAt: null,
    lastAlertAt: null,
    lastScrubAt: null,
  };
}

module.exports = {
  record,
  getRecent,
  getStats,
  reset,
  MAX,
};
