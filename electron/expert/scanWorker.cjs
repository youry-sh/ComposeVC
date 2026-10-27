/**
 * Worker wrapper around the deterministic project scan.
 *
 * Reading every text file in a large repository must never block Electron's main
 * process (the window would freeze while the global hotkeys and IPC stall).
 */
const { parentPort, workerData } = require("worker_threads");
const { scanProject } = require("./scan.cjs");

try {
  const rootPath = workerData && workerData.rootPath;
  const result = scanProject(rootPath);
  parentPort.postMessage({ ok: true, scan: result.scan, digest: result.digest });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
