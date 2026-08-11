/**
 * Lopster Guard — public API for the proxy layer.
 *
 * ON by default. Scans every chat completion (JSON + SSE) for
 * malicious-provider tool/command injections before the client acts.
 */

const { getDefaultEngine, GuardEngine, RULE_UNSOLICITED } = require("./engine.cjs");
const scan = require("./scan.cjs");
const activity = require("./activity.cjs");

function status(config) {
  const cfg = scan.normalizeGuardConfig(config);
  const eng = getDefaultEngine();
  return {
    ok: true,
    service: "lopster-guard",
    enabled: cfg.enabled,
    mode: cfg.mode,
    blockOn: cfg.blockOn,
    scrubOn: cfg.scrubOn,
    unsolicitedTools: cfg.unsolicitedTools,
    scanThinking: cfg.scanThinking,
    rules: eng.ruleCount,
    iocs: eng.iocCount,
    packVersion: eng.packVersion,
    stats: activity.getStats(),
    recent: activity.getRecent(20),
    note:
      "Catches active injection (tool payloads, persistence, exfil, client-config poison). " +
      "Does NOT detect passive prompt reading — never send secrets to untrusted providers.",
  };
}

module.exports = {
  getDefaultEngine,
  GuardEngine,
  RULE_UNSOLICITED,
  ...scan,
  activity,
  status,
};
