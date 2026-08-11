const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_REPORTS_PER_RUNNER = 300;
const MAX_REPORT_TEXT = 150000;
const MAX_TOOL_STEPS = 250;
const RUNNERS_DIR_NAME = "runners";

let userDataPath = null;

function start(opts = {}) {
  if (opts.userDataPath) userDataPath = opts.userDataPath;
}

function runnersRoot() {
  if (!userDataPath) throw new Error("runner store not started");
  return path.join(userDataPath, RUNNERS_DIR_NAME);
}

function reportsDirFor(runnerId) {
  return path.join(runnersRoot(), "reports", String(runnerId || "unknown"));
}

function runnerPath(id) {
  return path.join(runnersRoot(), `${id}.json`);
}

function reportPath(runnerId, reportId) {
  return path.join(reportsDirFor(runnerId), `${reportId}.json`);
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

async function ensureDirs() {
  await fs.promises.mkdir(runnersRoot(), { recursive: true });
}

async function listRunnerFiles() {
  await ensureDirs();
  try {
    const names = await fs.promises.readdir(runnersRoot());
    return names.filter((n) => n.endsWith(".json") && !n.endsWith(".tmp.json"));
  } catch {
    return [];
  }
}

async function readRunnerFile(id) {
  try {
    const raw = await fs.promises.readFile(runnerPath(id), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeRunnerFile(runner) {
  await ensureDirs();
  const tmp = `${runnerPath(runner.id)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(runner, null, 2), "utf8");
  await fs.promises.rename(tmp, runnerPath(runner.id));
  return runner;
}

async function deleteRunnerFile(id) {
  try {
    await fs.promises.unlink(runnerPath(id));
    return true;
  } catch {
    return false;
  }
}

async function listReportFiles(runnerId) {
  const dir = reportsDirFor(runnerId);
  try {
    const names = await fs.promises.readdir(dir);
    return names.filter((n) => n.endsWith(".json") && !n.endsWith(".tmp.json"));
  } catch {
    return [];
  }
}

async function readReportFile(runnerId, reportId) {
  try {
    const raw = await fs.promises.readFile(reportPath(runnerId, reportId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeReportFile(report) {
  const dir = reportsDirFor(report.runnerId);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = `${reportPath(report.runnerId, report.id)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(report, null, 2), "utf8");
  await fs.promises.rename(tmp, reportPath(report.runnerId, report.id));
  return report;
}

async function deleteReportFile(runnerId, reportId) {
  try {
    await fs.promises.unlink(reportPath(runnerId, reportId));
    return true;
  } catch {
    return false;
  }
}

async function pruneReports(runnerId, max = MAX_REPORTS_PER_RUNNER) {
  const files = await listReportFiles(runnerId);
  if (files.length <= max) return;
  const metas = [];
  for (const file of files) {
    const id = file.replace(/\.json$/i, "");
    const report = await readReportFile(runnerId, id);
    metas.push({ id, startedAt: report?.startedAt || 0 });
  }
  metas.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const drop = metas.slice(max);
  for (const item of drop) {
    try {
      await fs.promises.unlink(reportPath(runnerId, item.id));
    } catch {
      /* */
    }
  }
}

module.exports = {
  start,
  runnersRoot,
  reportsDirFor,
  ensureDirs,
  uid,
  listRunnerFiles,
  readRunnerFile,
  writeRunnerFile,
  deleteRunnerFile,
  listReportFiles,
  readReportFile,
  writeReportFile,
  deleteReportFile,
  pruneReports,
  MAX_REPORTS_PER_RUNNER,
  MAX_REPORT_TEXT,
  MAX_TOOL_STEPS,
};
