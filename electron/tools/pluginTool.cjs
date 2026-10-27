const fs = require("fs");

const registry = require("../plugins/registry.cjs");
const blender = require("../plugins/blender/index.cjs");
const store = require("../plugins/store.cjs");

const ACTIONS = [
  "list",
  "get",
  "status",
  "probe",
  "enable",
  "disable",
  "config",
  "jobs",
  "job",
  "cancel",
  "delete_job",
  "copy_artifacts",
  "open_output",
];

function truth(ok, text, payload = {}) {
  return { bit: ok ? 1 : 0, ok: Boolean(ok), text, ...payload };
}

function resolveUserData(context) {
  const value = context?.userDataPath;
  if (!value) throw new Error("Plugin tool requires Electron userDataPath");
  return value;
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function pluginId(input) {
  return String(pick(input, "plugin", "plugin_id", "id", "name") || "blender").trim();
}

function summarize(job) {
  const flags = `${job.status === "succeeded" ? "1" : "0"} ${job.id} [${job.kind}]`;
  return `${flags} ${job.title || ""}${job.summary ? ` — ${job.summary}` : ""}${job.error ? ` — ${job.error}` : ""}`.trim();
}

async function run(action, input, context) {
  const userDataPath = resolveUserData(context);

  switch (action) {
    case "list": {
      const state = await registry.listPlugins(userDataPath);
      const lines = state.plugins.map((plugin) => {
        const status = plugin.status?.found
          ? `ok ${plugin.status.version || "?"}`
          : `не найден`;
        return `${plugin.enabled ? "1" : "0"} ${plugin.id} (${plugin.name}) — ${status} · ${plugin.stats?.runs || 0} запусков · задач: ${plugin.jobsCount}`;
      });
      return truth(true, lines.join("\n") || "Плагинов нет.", {
        plugins: state.plugins.map((plugin) => ({
          id: plugin.id,
          name: plugin.name,
          enabled: plugin.enabled,
          version: plugin.version,
          tagline: plugin.tagline,
          tools: plugin.tools,
          status: plugin.status,
          stats: plugin.stats,
          config: plugin.config,
          lastJob: plugin.lastJob,
        })),
        jobsRoot: state.jobsRoot,
      });
    }
    case "get": {
      const plugin = await registry.getPlugin(userDataPath, pluginId(input));
      return truth(true, `${plugin.name}: ${plugin.enabled ? "включён" : "выключен"} — ${registry.describeStatus(plugin.status)}`, { plugin });
    }
    case "status":
    case "probe": {
      const id = pluginId(input);
      const plugin = await registry.getPlugin(userDataPath, id);
      if (id !== "blender") {
        return truth(false, `Для плагина '${id}' нет исполнителя статуса.`, { plugin });
      }
      if (action === "status") {
        const text = plugin.status.found
          ? `${plugin.name} ${plugin.status.version || "?"} · ${plugin.status.executable} · ${plugin.enabled ? "включён" : "выключен"}`
          : `${plugin.name} не найден: ${plugin.status.error}`;
        return truth(plugin.status.found, text, { plugin });
      }
      const probed = await blender.probe(userDataPath, plugin.config);
      return truth(Boolean(probed.ok), probed.ok
        ? `${plugin.name} ${probed.version} · движки: ${(probed.engines || []).join(", ") || "—"}`
        : `Не удалось опросить ${plugin.name}: ${probed.error || "ошибка"}`,
        { plugin, probe: probed });
    }
    case "enable":
    case "disable": {
      const id = pluginId(input);
      const updated = await registry.updatePlugin(userDataPath, id, { enabled: action === "enable" });
      return truth(true, `${updated.name}: ${updated.enabled ? "включён" : "выключен"}`, { plugin: updated });
    }
    case "config": {
      const id = pluginId(input);
      const patch = input.config && typeof input.config === "object" ? { ...input.config } : {};
      for (const key of ["executable", "outputDir", "engine", "samples", "format", "autoRender", "timeoutSec", "factoryStartup"]) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      if (input.resolution) patch.resolution = input.resolution;
      if (input.width || input.height) {
        patch.resolution = { width: Number(input.width) || 1600, height: Number(input.height) || 1000 };
      }
      const updated = await registry.updatePlugin(userDataPath, id, { config: patch, enabled: input.enabled });
      return truth(true, `${updated.name}: настройки сохранены\n${registry.describeStatus(updated.status)}`, { plugin: updated });
    }
    case "jobs": {
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 20));
      const jobs = await registry.jobs(userDataPath, { limit, pluginId: input.plugin || undefined });
      return truth(true, jobs.length ? jobs.map(summarize).join("\n") : "Задач нет.", {
        jobs: jobs.map((job) => ({
          id: job.id,
          pluginId: job.pluginId,
          kind: job.kind,
          status: job.status,
          title: job.title,
          summary: job.summary,
          createdAt: job.createdAt,
          durationMs: job.durationMs,
          preview: job.previewPath,
          exports: job.exports.map((item) => item.format),
          error: job.error,
        })),
      });
    }
    case "job": {
      const id = String(pick(input, "job", "job_id") || "");
      if (!id) throw new Error("action=job требует job (id задачи).");
      const job = await registry.job(userDataPath, id);
      if (!job) return truth(false, `Задача ${id} не найдена.`);
      let logTail = "";
      if (input.include_log) {
        try {
          logTail = (await fs.promises.readFile(job.logPath, "utf8")).slice(-8000);
        } catch {
          logTail = "";
        }
      }
      return truth(job.status === "succeeded", summarize(job), { job, logTail });
    }
    case "cancel": {
      const id = String(pick(input, "job", "job_id") || "");
      if (!id) throw new Error("action=cancel требует job (id задачи).");
      const result = registry.cancel(id);
      return truth(result.canceled, result.canceled ? `Задача ${id} остановлена.` : "Задача не выполняется.", result);
    }
    case "delete_job": {
      const id = String(pick(input, "job", "job_id") || "");
      if (!id) throw new Error("action=delete_job требует job (id задачи).");
      const result = await registry.deleteJob(userDataPath, id);
      return truth(true, `Задача ${id} удалена.`, result);
    }
    case "copy_artifacts": {
      const id = String(pick(input, "job", "job_id") || "");
      if (!id) throw new Error("action=copy_artifacts требует job (id задачи).");
      const result = await registry.copyArtifacts(userDataPath, id, pick(input, "output_dir", "dir", "target"));
      return truth(true, `Скопировано ${result.copied.length} файл(ов) → ${result.folder}`, result);
    }
    case "open_output": {
      const job = pick(input, "job", "job_id") ? await registry.job(userDataPath, String(pick(input, "job", "job_id"))) : null;
      const plugin = await registry.getPlugin(userDataPath, pluginId(input));
      const dir = job?.dir || plugin.outputDir || store.resolveOutputDir(userDataPath, plugin.config);
      return truth(true, `Папка: ${dir}`, { dir, jobId: job?.id || null });
    }
    default:
      throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
  }
}

module.exports = {
  name: "plugin",
  description:
    "ComposeVC plugin manager. A plugin is a built-in capability with settings, a job history and its own AI tool. " +
    "The first plugin is Blender (3D scenes, PBR materials, renders, game exports) — use the `blender` tool for creating assets, and this tool to inspect/manage plugins. " +
    "Actions: list (all plugins with install status), get (one plugin), status (is it available), probe (deep capabilities), enable/disable, config (path/settings), " +
    "jobs/job/cancel/delete_job (history, logs, stop a running job), copy_artifacts (copy results to a folder), open_output (where artifacts live). " +
    "Plugin jobs are stored under <userData>/plugins/jobs/<jobId> with plan.json, script.py, log.txt, renders, exports and result.json.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: ACTIONS.join(" | ") },
      plugin: { type: "string", description: "plugin id (default: blender)" },
      id: { type: "string", description: "plugin id alias, or job id for job actions" },
      job: { type: "string", description: "job id" },
      limit: { type: "number", description: "jobs: how many recent jobs" },
      include_log: { type: "boolean", description: "job: include log tail" },
      config: { type: "object", description: "config: full config patch" },
      executable: { type: "string", description: "config: executable path" },
      outputDir: { type: "string", description: "config: artifact output folder" },
      engine: { type: "string", enum: ["EEVEE", "CYCLES", "WORKBENCH"], description: "config: default render engine" },
      resolution: { type: "array", items: { type: "number" }, description: "config: [width, height]" },
      samples: { type: "number", description: "config: default samples" },
      format: { type: "string", description: "config: default export format" },
      autoRender: { type: "boolean", description: "config: render automatically on scene builds" },
      timeoutSec: { type: "number", description: "config: job timeout seconds" },
      enabled: { type: "boolean", description: "config: enable the plugin" },
      output_dir: { type: "string", description: "copy_artifacts: target folder" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    let action = String(pick(input, "action") || "").trim().toLowerCase();
    if (!action) action = "list";
    const aliases = {
      plugins: "list",
      info: "get",
      show: "get",
      check: "status",
      capabilities: "probe",
      inspect: "probe",
      settings: "config",
      setup: "config",
      update: "config",
      history: "jobs",
      runs: "jobs",
      get_job: "job",
      stop: "cancel",
      stop_job: "cancel",
      remove: "delete_job",
      rm: "delete_job",
      copy: "copy_artifacts",
      folder: "open_output",
    };
    if (aliases[action]) action = aliases[action];
    if (!ACTIONS.includes(action)) throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
    return run(action, input, context);
  },
};
