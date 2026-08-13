const engine = require("../runners/runnerEngine.cjs");

const ACTIONS = [
  "list",
  "search",
  "get",
  "create",
  "update",
  "delete",
  "enable",
  "disable",
  "run",
  "stop",
  "reports",
  "get_report",
  "delete_report",
  "models",
];

function clip(text, max = 140) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function compactRunner(runner) {
  if (!runner) return null;
  const trigger = runner.trigger || {};
  return {
    id: runner.id,
    name: runner.name,
    enabled: runner.enabled !== false,
    trigger:
      trigger.type === "interval"
        ? { type: "interval", intervalMinutes: trigger.intervalMinutes }
        : { type: "off" },
    modelId: runner.modelId,
    promptPreview: clip(runner.prompt, 160),
    rootPath: runner.rootPath || null,
    projectName: runner.projectName || null,
    lastStatus: runner.lastStatus || "idle",
    lastError: runner.lastError || null,
    lastRunAt: runner.lastRunAt || null,
    nextRunAt: runner.nextRunAt || null,
    running: Boolean(runner.running),
    queued: Boolean(runner.queued),
    maxRetries: runner.maxRetries,
    stats: runner.stats || null,
  };
}

function haystack(runner) {
  return [
    runner.id,
    runner.name,
    runner.prompt,
    runner.modelId,
    runner.projectName,
    runner.rootPath,
    runner.lastStatus,
    runner.lastError,
    runner.trigger?.type,
    runner.enabled === false ? "disabled off" : "enabled on",
    runner.running ? "running" : "",
    runner.queued ? "queued" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function parseIntervalMinutes(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  const raw = String(value).trim().toLowerCase().replace(/^every\s+/, "");
  const match = raw.match(
    /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/
  );
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || "m";
  if (unit.startsWith("s")) return Math.max(1, Math.round(n / 60) || 1);
  if (unit.startsWith("h")) return Math.max(1, Math.round(n * 60));
  if (unit.startsWith("d")) return Math.max(1, Math.round(n * 60 * 24));
  return Math.max(1, Math.round(n));
}

function parseTrigger(input, { required = false } = {}) {
  const typeRaw = String(
    input.triggerType ||
      input.trigger_type ||
      (input.trigger && typeof input.trigger === "object" ? input.trigger.type : input.trigger) ||
      ""
  )
    .trim()
    .toLowerCase();
  if (typeRaw === "off" || typeRaw === "none" || typeRaw === "manual") {
    return { type: "off" };
  }
  const minutes = parseIntervalMinutes(
    input.intervalMinutes ??
      input.interval_minutes ??
      input.interval ??
      input.minutes ??
      input.timer ??
      (input.trigger && typeof input.trigger === "object" ? input.trigger.intervalMinutes : null)
  );
  if (minutes != null) return { type: "interval", intervalMinutes: minutes };
  if (typeRaw === "interval") return { type: "interval", intervalMinutes: 60 };
  if (required) return { type: "interval", intervalMinutes: 60 };
  return null;
}

async function loadModels() {
  const read = global.__lopsterReadProviderConfig;
  if (typeof read !== "function") return { models: [], selectedModelId: null };
  const config = await read().catch(() => null);
  const models = Array.isArray(config?.models)
    ? config.models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        providerId: model.providerId || null,
      }))
    : [];
  return {
    models,
    selectedModelId: config?.selectedModelId || models[0]?.id || null,
  };
}

async function resolveRunner(input) {
  const ref = String(input.id || input.runnerId || input.runner_id || input.name || input.runner || "").trim();
  if (!ref) throw new Error("id or name is required");
  const byId = await engine.getRunner(ref);
  if (byId) return byId;
  const list = await engine.listRunners();
  const lower = ref.toLowerCase();
  const exact = list.filter((runner) => String(runner.name || "").toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `Several runners named "${ref}". Use id: ${exact.map((runner) => runner.id).join(", ")}`
    );
  }
  const partial = list.filter((runner) => String(runner.name || "").toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `Ambiguous name "${ref}". Matches: ${partial
        .map((runner) => `${runner.name} (${runner.id})`)
        .join("; ")}`
    );
  }
  throw new Error(`Runner not found: ${ref}`);
}

function buildCreatePayload(input, context, modelsInfo) {
  const prompt = String(input.prompt || input.task || input.instruction || "").trim();
  if (!prompt) throw new Error("prompt is required (the runner's standing task)");
  const modelId = String(
    input.modelId || input.model_id || input.model || context.modelId || modelsInfo.selectedModelId || ""
  ).trim();
  if (!modelId) {
    throw new Error("modelId is required — call action=models, then pass a model id");
  }
  const useCurrentFolder = input.useCurrentFolder !== false && input.use_current_folder !== false;
  const rootPath =
    input.rootPath != null
      ? input.rootPath
        ? String(input.rootPath)
        : null
      : useCurrentFolder
        ? context.rootPath || null
        : null;
  const projectName =
    input.projectName != null
      ? input.projectName
        ? String(input.projectName)
        : null
      : useCurrentFolder
        ? context.projectName || null
        : null;
  const trigger = parseTrigger(input, { required: true });
  const payload = {
    name: String(input.name || "").trim() || "Runner",
    prompt,
    modelId,
    enabled: input.enabled !== false,
    trigger,
    maxRetries:
      input.maxRetries != null || input.max_retries != null
        ? Number(input.maxRetries ?? input.max_retries)
        : 2,
    rootPath,
    projectName,
  };
  return payload;
}

function buildUpdatePatch(input) {
  const patch = {};
  if (input.name != null) patch.name = String(input.name).trim();
  if (input.prompt != null || input.task != null || input.instruction != null) {
    patch.prompt = String(input.prompt || input.task || input.instruction).trim();
  }
  if (input.modelId != null || input.model_id != null || input.model != null) {
    patch.modelId = String(input.modelId || input.model_id || input.model).trim();
  }
  if (input.enabled != null) patch.enabled = Boolean(input.enabled);
  if (input.maxRetries != null || input.max_retries != null) {
    patch.maxRetries = Number(input.maxRetries ?? input.max_retries);
  }
  if (input.rootPath !== undefined) patch.rootPath = input.rootPath ? String(input.rootPath) : null;
  if (input.projectName !== undefined) {
    patch.projectName = input.projectName ? String(input.projectName) : null;
  }
  const trigger = parseTrigger(input);
  if (trigger) patch.trigger = trigger;
  if (Object.keys(patch).length === 0) {
    throw new Error("update requires at least one field: name, prompt, modelId, trigger/interval, enabled, maxRetries, rootPath");
  }
  return patch;
}

module.exports = {
  name: "runner",
  description:
    "Manage ComposeVC Runner tab jobs — background autonomous agents with a standing prompt, model, and optional interval timer. " +
    "Use this instead of bash loops or custom_tool when the user wants a recurring or on-demand runner. " +
    "Actions: list, search, get, create, update, delete, enable, disable, run, stop, reports, get_report, delete_report, models. " +
    "Create needs prompt (task) and usually intervalMinutes (timer in minutes; or triggerType=off for manual-only). " +
    "Identify jobs by id or name. Search matches name, prompt, model, status.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ACTIONS,
        description:
          "list|search|get|create|update|delete|enable|disable|run|stop|reports|get_report|delete_report|models",
      },
      id: { type: "string", description: "Runner id (or pass name)" },
      name: { type: "string", description: "Runner name — create, or lookup for get/update/delete/run" },
      query: { type: "string", description: "search: keywords across name, prompt, model, status" },
      prompt: { type: "string", description: "Standing task/prompt the runner executes each run" },
      task: { type: "string", description: "Alias of prompt" },
      modelId: { type: "string", description: "Model config id. Defaults to the current chat model. action=models lists ids." },
      triggerType: {
        type: "string",
        enum: ["interval", "off"],
        description: "interval = timer; off = manual only (Ctrl+R / action=run)",
      },
      intervalMinutes: {
        type: "number",
        description: "Timer interval in minutes (create/update). Minimum 1.",
      },
      interval: {
        type: "string",
        description: "Timer as '15', '30m', '1h', '2d' — converted to intervalMinutes",
      },
      minutes: { type: "number", description: "Alias of intervalMinutes" },
      enabled: { type: "boolean", description: "Whether the interval timer is armed" },
      maxRetries: { type: "number", description: "Retries on failure, 0–5 (default 2)" },
      message: { type: "string", description: "run: extra user request appended to this run" },
      rootPath: { type: "string", description: "Working folder. Defaults to the open project." },
      projectName: { type: "string" },
      useCurrentFolder: {
        type: "boolean",
        description: "create: bind to the current open folder (default true)",
      },
      runnerId: { type: "string", description: "Alias of id, also used with reports" },
      reportId: { type: "string", description: "get_report / delete_report" },
      limit: { type: "number", description: "list/search/reports max items (default 50, max 200)" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    const rawName = String(context.originalToolName || context.rawToolName || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "");
    let action = String(input.action || input.command || "").trim().toLowerCase();
    if (!action && rawName === "create_runner") action = "create";
    if (!action && (rawName === "runners" || rawName === "manage_runners")) action = "list";
    if (!action) throw new Error(`action required: ${ACTIONS.join(", ")}`);

    const limit = Math.max(1, Math.min(200, Number(input.limit) || 50));

    if (action === "list") {
      const runners = (await engine.listRunners()).slice(0, limit).map(compactRunner);
      return { ok: true, count: runners.length, runners };
    }

    if (action === "search") {
      const query = String(input.query || input.q || input.search || "").trim().toLowerCase();
      const all = await engine.listRunners();
      const matched = (query ? all.filter((runner) => haystack(runner).includes(query)) : all)
        .slice(0, limit)
        .map(compactRunner);
      return { ok: true, query, count: matched.length, total: all.length, runners: matched };
    }

    if (action === "get") {
      const runner = await resolveRunner(input);
      return { ok: true, runner };
    }

    if (action === "create") {
      const modelsInfo = await loadModels();
      const payload = buildCreatePayload(input, context, modelsInfo);
      const runner = await engine.createRunner(payload);
      return { ok: true, created: true, runner };
    }

    if (action === "update") {
      const runner = await resolveRunner(input);
      const patch = buildUpdatePatch(input);
      const updated = await engine.updateRunner(runner.id, patch);
      return { ok: true, updated: true, runner: updated };
    }

    if (action === "delete" || action === "remove") {
      const runner = await resolveRunner(input);
      const result = await engine.deleteRunner(runner.id);
      return { ok: result?.ok !== false, deleted: true, id: runner.id, name: runner.name, error: result?.error };
    }

    if (action === "enable" || action === "disable") {
      const runner = await resolveRunner(input);
      const updated = await engine.updateRunner(runner.id, { enabled: action === "enable" });
      return { ok: true, runner: compactRunner(updated) };
    }

    if (action === "run") {
      const runner = await resolveRunner(input);
      const result = await engine.runRunner(runner.id, {
        manual: true,
        trigger: "manual",
        message: input.message ? String(input.message).trim() : null,
      });
      return {
        ok: result?.ok !== false,
        queued: Boolean(result?.queued),
        status: result?.status || (result?.queued ? "queued" : null),
        runner: compactRunner(await engine.getRunner(runner.id)),
        report: result?.report || null,
        error: result?.error || null,
      };
    }

    if (action === "stop") {
      const runner = await resolveRunner(input);
      await engine.stopRunner(runner.id);
      return { ok: true, stopped: true, id: runner.id, name: runner.name };
    }

    if (action === "reports" || action === "list_reports") {
      const runnerId = input.runnerId || input.runner_id || input.id || input.name || null;
      let resolvedId = null;
      if (runnerId) {
        resolvedId = (await resolveRunner({ id: runnerId, name: input.name })).id;
      }
      const reports = await engine.listRunnerReports({
        runnerId: resolvedId,
        limit,
      });
      return { ok: true, count: reports.length, runnerId: resolvedId, reports };
    }

    if (action === "get_report") {
      const runner = await resolveRunner(input);
      const reportId = String(input.reportId || input.report_id || "").trim();
      if (!reportId) throw new Error("reportId is required");
      const report = await engine.getRunnerReport(runner.id, reportId);
      if (!report) throw new Error("report not found");
      return { ok: true, report };
    }

    if (action === "delete_report") {
      const runner = await resolveRunner(input);
      const reportId = String(input.reportId || input.report_id || "").trim();
      if (!reportId) throw new Error("reportId is required");
      const result = await engine.deleteRunnerReport(runner.id, reportId);
      return { ok: result?.ok !== false, deleted: Boolean(result?.ok), reportId, runnerId: runner.id };
    }

    if (action === "models") {
      const info = await loadModels();
      return { ok: true, count: info.models.length, selectedModelId: info.selectedModelId, models: info.models };
    }

    throw new Error(`Unknown runner action: ${action}. Use ${ACTIONS.join(", ")}`);
  },
};
