const path = require("path");
const { EventEmitter } = require("events");
const store = require("./runnerStore.cjs");

const POLL_MS = 10_000;
const MAX_CONCURRENT_RUNS = 60;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BACKOFF_MS = 6000;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
const RUNNER_CONTEXT_TOKENS = 500_000;
const RUNNER_AUTO_COMPACT_TOKENS = Math.floor(RUNNER_CONTEXT_TOKENS * 0.8);

const bus = new EventEmitter();
bus.setMaxListeners(300);

let userDataPath = null;
let started = false;
let pollTimer = null;
let executeChatRequest = null;
let getMainSender = null;
let readProviderConfig = null;

const runners = new Map();
const running = new Map();
const queues = new Map();
let activeRuns = 0;
const slotWaiters = [];

function normalizeTrigger(input = {}) {
  const type = String(input.type || "interval").toLowerCase();
  if (type === "off" || type === "none" || type === "manual") {
    return { type: "off" };
  }
  const intervalMinutes = Math.max(
    1,
    Math.min(MAX_INTERVAL_MINUTES, Number(input.intervalMinutes) || 60)
  );
  return { type: "interval", intervalMinutes };
}

function nextIntervalAt(intervalMinutes, fromMs = Date.now()) {
  const mins = Math.max(1, Math.min(MAX_INTERVAL_MINUTES, Number(intervalMinutes) || 60));
  return fromMs + mins * 60_000;
}

function computeNextRun(runner, fromMs = Date.now()) {
  if (!runner || runner.enabled === false) return null;
  const trigger = normalizeTrigger(runner.trigger || {});
  if (trigger.type !== "interval") return null;
  return nextIntervalAt(trigger.intervalMinutes, fromMs);
}

function defaultStats() {
  return { totalRuns: 0, totalErrors: 0, totalToolCalls: 0, lastMessage: null };
}

function publicRunner(runner) {
  if (!runner) return null;
  const entry = running.get(runner.id);
  const queue = queues.get(runner.id) || [];
  return {
    id: runner.id,
    name: runner.name,
    prompt: runner.prompt,
    modelId: runner.modelId,
    rootPath: runner.rootPath || null,
    projectName: runner.projectName || null,
    enabled: runner.enabled !== false,
    trigger: normalizeTrigger(runner.trigger || {}),
    maxRetries: Math.max(0, Math.min(5, Number(runner.maxRetries) ?? DEFAULT_MAX_RETRIES)),
    createdAt: runner.createdAt,
    updatedAt: runner.updatedAt,
    lastRunAt: runner.lastRunAt || null,
    nextRunAt: runner.nextRunAt || null,
    lastStatus: runner.lastStatus || "idle",
    lastError: runner.lastError || null,
    lastReportId: runner.lastReportId || null,
    stats: runner.stats || defaultStats(),
    running: Boolean(entry),
    queued: queue.length > 0,
  };
}

function publicReport(report, { full = false } = {}) {
  if (!report) return null;
  const base = {
    id: report.id,
    runnerId: report.runnerId,
    runnerName: report.runnerName,
    trigger: report.trigger || "manual",
    message: report.message || null,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt || null,
    status: report.status,
    modelId: report.modelId || null,
    modelName: report.modelName || null,
    prompt: report.prompt || "",
    summary: report.summary || "",
    error: report.error || null,
    usage: report.usage || null,
    toolCount: Array.isArray(report.toolSteps) ? report.toolSteps.length : report.toolCount || 0,
  };
  if (!full) return base;
  return {
    ...base,
    text: report.text || "",
    toolSteps: Array.isArray(report.toolSteps) ? report.toolSteps : [],
  };
}

function emitRunners() {
  const list = Array.from(runners.values())
    .map(publicRunner)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  bus.emit("runners", list);
}

function summarizeText(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > 280 ? `${clean.slice(0, 280)}…` : clean;
}

function trimToolSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length <= store.MAX_TOOL_STEPS) return list;
  return list.slice(-store.MAX_TOOL_STEPS);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function acquireSlot() {
  if (activeRuns < MAX_CONCURRENT_RUNS) {
    activeRuns += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    slotWaiters.push(resolve);
  });
}

function releaseSlot() {
  activeRuns = Math.max(0, activeRuns - 1);
  const next = slotWaiters.shift();
  if (next) {
    activeRuns += 1;
    next();
  }
}

function runnerSystemPrompt() {
  return [
    "You are ComposeVC's background Runner agent.",
    "You have access to the agent toolset, including project files, shell commands, browser/anti tooling, mail, and subagents.",
    "Complete the task end-to-end. Do not stop at a partial result. Ask the human only for a real OTP or CAPTCHA that specifically requires human input.",
    "When a step fails, inspect the failure, try appropriate alternatives, and continue until the goal is achieved or a concrete external blocker is proven.",
    "Work safely with concurrent changes: another agent may edit the same project while you run. Before editing, re-read the target region; after editing, validate only the files you changed and do not attribute unrelated syntax or test failures to your work.",
    "Use focused verification. Run syntax checks and relevant tests when available, report commands and outcomes accurately, and distinguish your confirmed results from concurrent-work uncertainty.",
    "Finish with a concise, actionable report: completed work, results, created paths or IDs, verification evidence, and remaining blockers or risks.",
  ].join(" ");
}

async function reloadAll() {
  const files = await store.listRunnerFiles();
  runners.clear();
  for (const file of files) {
    const id = file.replace(/\.json$/i, "");
    const runner = await store.readRunnerFile(id);
    if (runner && runner.id) {
      runner.stats = { ...defaultStats(), ...(runner.stats || {}) };
      runners.set(runner.id, runner);
    }
  }
  let dirty = false;
  const now = Date.now();
  for (const runner of runners.values()) {
    if (runner.enabled === false) {
      if (runner.nextRunAt != null) {
        runner.nextRunAt = null;
        dirty = true;
      }
      continue;
    }
    if (runner.lastStatus === "running") {
      runner.lastStatus = "idle";
      dirty = true;
    }
    if (!runner.nextRunAt || runner.nextRunAt <= now) {
      runner.nextRunAt = computeNextRun(runner, now);
      dirty = true;
    }
  }
  if (dirty) {
    for (const runner of runners.values()) {
      try {
        await store.writeRunnerFile(runner);
      } catch {
        /* */
      }
    }
  }
  emitRunners();
}

async function saveRunner(runner) {
  runner.updatedAt = Date.now();
  await store.writeRunnerFile(runner);
  emitRunners();
  return runner;
}

async function listRunners() {
  return Array.from(runners.values())
    .map(publicRunner)
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function getRunner(id) {
  const runner = runners.get(id);
  return publicRunner(runner || null);
}

async function createRunner(input = {}) {
  if (!started) throw new Error("runner engine not started");
  const now = Date.now();
  const name = String(input.name || "").trim() || "Runner";
  const prompt = String(input.prompt || "").trim();
  const modelId = String(input.modelId || "").trim();
  if (!prompt) throw new Error("prompt is required");
  if (!modelId) throw new Error("modelId is required");
  const trigger = normalizeTrigger(input.trigger || {});
  const runner = {
    version: 1,
    id: store.uid("runner"),
    name,
    prompt,
    modelId,
    rootPath: input.rootPath ? String(input.rootPath) : null,
    projectName: input.projectName ? String(input.projectName) : null,
    enabled: input.enabled !== false,
    trigger,
    maxRetries: Math.max(0, Math.min(5, Number(input.maxRetries) ?? DEFAULT_MAX_RETRIES)),
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: "idle",
    lastError: null,
    lastReportId: null,
    stats: defaultStats(),
  };
  runner.nextRunAt = runner.enabled ? computeNextRun(runner, now) : null;
  runners.set(runner.id, runner);
  await saveRunner(runner);
  return publicRunner(runner);
}

async function updateRunner(id, patch = {}) {
  const runner = runners.get(id);
  if (!runner) throw new Error("runner not found");
  if (patch.name != null) runner.name = String(patch.name).trim() || runner.name;
  if (patch.prompt != null) runner.prompt = String(patch.prompt).trim();
  if (patch.modelId != null) {
    runner.modelId = String(patch.modelId).trim();
    if (!runner.modelId) throw new Error("modelId is required");
  }
  if (patch.rootPath !== undefined) runner.rootPath = patch.rootPath ? String(patch.rootPath) : null;
  if (patch.projectName !== undefined) {
    runner.projectName = patch.projectName ? String(patch.projectName) : null;
  }
  if (patch.enabled !== undefined) runner.enabled = Boolean(patch.enabled);
  if (patch.trigger != null) runner.trigger = normalizeTrigger(patch.trigger);
  if (patch.maxRetries !== undefined) {
    runner.maxRetries = Math.max(0, Math.min(5, Number(patch.maxRetries) ?? DEFAULT_MAX_RETRIES));
  }
  if (!runner.prompt) throw new Error("prompt is required");
  if (runner.enabled === false) {
    runner.nextRunAt = null;
  } else if (
    patch.trigger != null ||
    patch.enabled !== undefined ||
    runner.nextRunAt == null ||
    runner.nextRunAt <= Date.now()
  ) {
    runner.nextRunAt = computeNextRun(runner, Date.now());
  }
  await saveRunner(runner);
  return publicRunner(runner);
}

async function deleteRunner(id) {
  const runner = runners.get(id);
  if (!runner) return { ok: false, error: "not found" };
  const entry = running.get(id);
  if (entry) {
    try {
      entry.abortController.abort();
    } catch {
      /* */
    }
  }
  queues.delete(id);
  runners.delete(id);
  await store.deleteRunnerFile(id);
  emitRunners();
  bus.emit("runner-deleted", { id });
  return { ok: true };
}

async function stopRunner(id) {
  const entry = running.get(id);
  if (entry) {
    try {
      entry.abortController.abort();
    } catch {
      /* */
    }
  }
  queues.delete(id);
  emitRunners();
  return { ok: true };
}

async function executeRunnerRun(runnerId, opts = {}) {
  const entry = running.get(runnerId);
  const runner = runners.get(runnerId);
  if (!entry) return { ok: false, error: "not running" };
  if (!runner) {
    running.delete(runnerId);
    return { ok: false, error: "runner not found" };
  }
  if (runner.enabled === false && opts.manual !== true) {
    running.delete(runnerId);
    return { ok: false, error: "disabled" };
  }

  const config =
    typeof readProviderConfig === "function"
      ? await readProviderConfig().catch(() => null)
      : null;
  const model = config?.models?.find((m) => m.id === runner.modelId) || null;
  const modelName = model?.name || runner.modelId;

  const trigger = String(opts.trigger || entry.trigger || (opts.manual ? "manual" : "interval"));
  const message = opts.message != null ? String(opts.message).trim() : entry.message || null;
  const reportId = store.uid("rep");
  const startedAt = Date.now();
  const abortController = entry.abortController;
  const toolSteps = [];

  const report = {
    id: reportId,
    runnerId: runner.id,
    runnerName: runner.name,
    trigger,
    message,
    startedAt,
    finishedAt: null,
    status: "running",
    modelId: runner.modelId,
    modelName,
    prompt: runner.prompt,
    summary: "",
    text: "",
    error: null,
    usage: null,
    toolSteps: [],
    toolCount: 0,
  };

  running.set(runner.id, { ...entry, reportId, startedAt, trigger, message, pending: false });
  runner.lastRunAt = startedAt;
  runner.lastStatus = "running";
  runner.lastError = null;
  runner.lastReportId = reportId;
  runner.stats = { ...defaultStats(), ...(runner.stats || {}) };
  runner.stats.totalRuns = (runner.stats.totalRuns || 0) + 1;
  try {
    await store.writeRunnerFile(runner);
    await store.writeReportFile(report);
  } catch {
    /* */
  }
  bus.emit("status", { runnerId: runner.id, reportId, status: "running", trigger });
  emitRunners();

  const sender = typeof getMainSender === "function" ? getMainSender() : null;
  const event = {
    sender:
      sender || {
        send() {},
        isDestroyed: () => true,
      },
  };

  const promptLines = [`# Runner: ${runner.name}`, "", runner.prompt || ""];
  if (message) {
    promptLines.push("", `Новый запрос от пользователя: "${message}"`);
  }
  promptLines.push("", "Выполни задачу полностью до конца и напиши финальный отчёт.");

  const maxRetries =
    runner.maxRetries == null
      ? DEFAULT_MAX_RETRIES
      : Math.max(0, Math.min(5, Number(runner.maxRetries) || 0));
  let result = null;
  let errorText = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (abortController.signal.aborted) {
      errorText = "Stopped";
      break;
    }
    if (typeof executeChatRequest !== "function") {
      errorText = "executeChatRequest not bound";
      break;
    }
    try {
      result = await executeChatRequest(
        event,
        {
          modelId: runner.modelId,
          rootPath: runner.rootPath || null,
          projectName: runner.projectName || runner.name || "Runner",
          messages: [{ role: "user", content: promptLines.join("\n") }],
          sessionId: `runner-${runner.id}-${reportId}`,
        },
        {
          persistSession: false,
          systemPrompt: runnerSystemPrompt(),
          agentMode: "lopster",
          progressChannel: "runner:progress",
          agentId: `runner:${runner.id}`,
          maxContextTokens: RUNNER_CONTEXT_TOKENS,
          autoCompactTokens: RUNNER_AUTO_COMPACT_TOKENS,
          onProgress: (progress) => {
            try {
              if (progress?.type === "tool_start" || progress?.type === "tool_end") {
                toolSteps.push({
                  at: Date.now(),
                  type: progress.type,
                  name: progress.name || progress.toolName || progress.tool || "",
                  label: progress.label || "",
                  ok: progress.ok,
                  error: progress.error || null,
                });
                if (toolSteps.length > store.MAX_TOOL_STEPS * 2) {
                  toolSteps.splice(0, toolSteps.length - store.MAX_TOOL_STEPS);
                }
              }
              bus.emit("progress", { runnerId: runner.id, reportId, progress });
            } catch {
              /* */
            }
          },
        }
      );
      break;
    } catch (error) {
      errorText = error?.message || String(error);
      if (abortController.signal.aborted || error?.name === "AbortError" || error?.stopped) {
        break;
      }
      if (attempt < maxRetries) {
        bus.emit("progress", {
          runnerId: runner.id,
          reportId,
          progress: {
            type: "status",
            label: `Ошибка запуска (попытка ${attempt + 1}/${maxRetries + 1}) — повтор через ${Math.round(
              (RETRY_BACKOFF_MS * (attempt + 1)) / 1000
            )}с…`,
            error: errorText,
          },
        });
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
  }

  const finishedAt = Date.now();
  const stopped = Boolean(result?.stopped) || abortController.signal.aborted;
  const status = stopped
    ? "stopped"
    : errorText && !result?.text
      ? "error"
      : errorText
        ? "error"
        : "success";
  const text = String(result?.text || errorText || "").slice(0, store.MAX_REPORT_TEXT);

  const finalReport = {
    ...report,
    finishedAt,
    status,
    text,
    summary: summarizeText(text || errorText),
    error: errorText || (stopped ? "Stopped" : null),
    usage: result?.usage || null,
    toolSteps: trimToolSteps(toolSteps),
    toolCount: toolSteps.length,
  };
  try {
    await store.writeReportFile(finalReport);
    await store.pruneReports(runner.id);
  } catch {
    /* */
  }

  if (status === "error") {
    runner.stats.totalErrors = (runner.stats.totalErrors || 0) + 1;
  }
  if (message) {
    runner.stats.lastMessage = message;
  }
  runner.lastStatus = status;
  runner.lastError = finalReport.error;
  runner.lastReportId = reportId;
  runner.lastRunAt = startedAt;
  runner.updatedAt = Date.now();
  running.delete(runner.id);

  const refreshed = runners.get(runner.id);
  if (refreshed) {
    if (refreshed.enabled !== false) {
      refreshed.nextRunAt = computeNextRun(refreshed, finishedAt);
    } else {
      refreshed.nextRunAt = null;
    }
    refreshed.updatedAt = Date.now();
    try {
      await store.writeRunnerFile(refreshed);
    } catch {
      /* */
    }
  }
  emitRunners();
  bus.emit("status", {
    runnerId: runner.id,
    reportId,
    status,
    nextRunAt: refreshed ? refreshed.nextRunAt : null,
  });
  bus.emit("report", publicReport(finalReport, { full: true }));

  return { ok: status !== "error", status, report: publicReport(finalReport, { full: true }) };
}

function drainQueue(runnerId) {
  const queue = queues.get(runnerId) || [];
  if (!queue.length) return;
  const runner = runners.get(runnerId);
  if (!runner) {
    queues.delete(runnerId);
    return;
  }
  if (runner.enabled === false) {
    queues.delete(runnerId);
    return;
  }
  const next = queue.shift();
  if (queue.length) {
    queues.set(runnerId, queue);
  } else {
    queues.delete(runnerId);
  }
  emitRunners();
  void runRunner(runnerId, {
    manual: true,
    message: next.message || null,
    trigger: "queued",
  }).catch((error) => {
    console.error("[runnerEngine] queued run failed", runnerId, error?.message || error);
  });
}

async function runRunner(runnerId, opts = {}) {
  if (!started) return { ok: false, error: "runner engine not started" };
  const runner = runners.get(runnerId);
  if (!runner) return { ok: false, error: "runner not found" };
  if (running.has(runnerId)) {
    const queue = queues.get(runnerId) || [];
    queue.push({
      message: opts.message ? String(opts.message).trim() : null,
      at: Date.now(),
    });
    queues.set(runnerId, queue);
    emitRunners();
    return { ok: true, queued: true, reason: "already_running" };
  }
  if (runner.enabled === false && opts.manual !== true) {
    return { ok: false, error: "disabled" };
  }
  const trigger = String(opts.trigger || (opts.manual ? "manual" : "interval"));
  const message = opts.message ? String(opts.message).trim() : null;
  const abortController = new AbortController();
  running.set(runnerId, {
    reportId: null,
    abortController,
    startedAt: Date.now(),
    trigger,
    message,
    pending: true,
  });
  await acquireSlot();
  try {
    if (abortController.signal.aborted) {
      running.delete(runnerId);
      return { ok: false, error: "stopped" };
    }
    const result = await executeRunnerRun(runnerId, {
      manual: opts.manual !== false,
      message,
      trigger,
    });
    return result;
  } finally {
    releaseSlot();
    drainQueue(runnerId);
  }
}

async function listRunnerReports({ runnerId = null, limit = 200 } = {}) {
  const ids = runnerId ? [String(runnerId)] : Array.from(runners.keys());
  const items = [];
  for (const id of ids) {
    const files = await store.listReportFiles(id);
    for (const file of files) {
      const report = await store.readReportFile(id, file.replace(/\.json$/i, ""));
      if (!report) continue;
      items.push(publicReport(report, { full: false }));
    }
  }
  items.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return items.slice(0, Math.max(1, Math.min(500, Number(limit) || 200)));
}

async function getRunnerReport(runnerId, reportId) {
  const report = await store.readReportFile(runnerId, reportId);
  return publicReport(report, { full: true });
}

async function deleteRunnerReport(runnerId, reportId) {
  const deleted = await store.deleteReportFile(runnerId, reportId);
  if (deleted) {
    bus.emit("report-deleted", { id: reportId, runnerId });
  }
  return { ok: deleted };
}

async function tick() {
  if (!started) return;
  try {
    for (const runner of runners.values()) {
      if (!runner || runner.enabled === false) continue;
      if (running.has(runner.id)) continue;
      const queue = queues.get(runner.id) || [];
      if (queue.length) {
        drainQueue(runner.id);
        continue;
      }
      const due = Number(runner.nextRunAt || 0);
      if (!due || due > Date.now()) continue;
      void runRunner(runner.id, { manual: false, trigger: "interval" }).catch((error) => {
        console.error("[runnerEngine] interval run failed", runner.id, error?.message || error);
      });
    }
  } catch (error) {
    console.error("[runnerEngine] tick failed", error?.message || error);
  }
}

async function start(opts = {}) {
  userDataPath = opts.userDataPath || userDataPath;
  executeChatRequest = opts.executeChatRequest || executeChatRequest;
  getMainSender = opts.getMainSender || getMainSender;
  readProviderConfig = opts.readProviderConfig || readProviderConfig;
  if (!userDataPath) throw new Error("userDataPath required");
  if (started) return { ok: true, already: true };
  started = true;
  store.start({ userDataPath });
  await store.ensureDirs().catch(() => {});
  await reloadAll().catch((error) => {
    console.error("[runnerEngine] reload failed", error?.message || error);
  });
  pollTimer = setInterval(() => {
    void tick();
  }, POLL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
  setTimeout(() => {
    void tick();
  }, 1500);
  return { ok: true };
}

function stop() {
  started = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const [, entry] of running) {
    try {
      entry.abortController?.abort?.();
    } catch {
      /* */
    }
  }
  running.clear();
  queues.clear();
  while (slotWaiters.length) {
    slotWaiters.shift()();
  }
  activeRuns = 0;
}

function on(event, listener) {
  bus.on(event, listener);
  return () => bus.off(event, listener);
}

function getRunning() {
  return Array.from(running.entries()).map(([runnerId, entry]) => ({
    runnerId,
    reportId: entry.reportId,
    startedAt: entry.startedAt,
    trigger: entry.trigger,
    message: entry.message || null,
  }));
}

module.exports = {
  start,
  stop,
  on,
  listRunners,
  getRunner,
  createRunner,
  updateRunner,
  deleteRunner,
  runRunner,
  stopRunner,
  listRunnerReports,
  getRunnerReport,
  deleteRunnerReport,
  getRunning,
  publicRunner,
  publicReport,
  computeNextRun,
  MAX_CONCURRENT_RUNS,
};
