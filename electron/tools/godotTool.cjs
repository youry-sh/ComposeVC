const fs = require("fs");
const path = require("path");

const godot = require("../plugins/godot/index.cjs");
const registry = require("../plugins/registry.cjs");
const store = require("../plugins/store.cjs");

const ACTIONS = [
  "status",
  "probe",
  "detect",
  "project",
  "scene",
  "import_glb",
  "build",
  "export",
  "run",
  "jobs",
  "job",
  "cancel",
  "delete_job",
  "config",
  "copy_artifacts",
  "open_output",
  "demo",
];

const SCENE_REFERENCE = `
SCENE (action=scene) — declarative text .tscn, no GDScript:
{
  "name": "Demo",
  "nodes": [{
    "name": "Crate", "type": "MeshInstance3D",
    "mesh": "box|cylinder|sphere|plane|capsule|prism",
    "size": [1,1,1] | 1, "radius": 0.5, "height": 1,
    "location": [0,0,0], "rotation": [0,0,0], "scale": [1,1,1],
    "material": { "albedo_color": "#8a6d3b", "metallic": 0, "roughness": 0.7,
                  "emission": "#18d7ff", "emission_energy": 2 }
  }],
  "main_scene": true
}
`;

function truth(ok, text, payload = {}) {
  return { bit: ok ? 1 : 0, ok: Boolean(ok), text, ...payload };
}

function resolveUserData(context) {
  const value = context?.userDataPath;
  if (!value) throw new Error("Godot tool requires Electron userDataPath");
  return value;
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function numberOr(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function jobLine(job) {
  if (!job) return "";
  const flag = job.status === "succeeded" ? "1" : "0";
  return `${flag} ${job.id} [${job.kind}] ${job.title || ""}${job.summary ? ` — ${job.summary}` : ""}${
    job.error ? ` — ${job.error}` : ""
  }`.trim();
}

function jobPayload(job) {
  if (!job) return {};
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    dir: job.dir,
    logPath: job.logPath,
    scenePath: job.scenePath || "",
    exportPath: job.exportPath || "",
    exportBytes: (job.exports || []).reduce((sum, item) => sum + (item.bytes || 0), 0),
    preset: job.godot?.preset || "",
    godot: job.godot || null,
    warnings: job.warnings || [],
    summary: job.summary || "",
    error: job.error || "",
  };
}

function configWithOverrides(config, input) {
  const patch = {};
  if (input.executable) patch.executable = String(input.executable);
  if (pick(input, "project", "project_dir", "projectDir")) {
    patch.projectDir = String(pick(input, "project", "project_dir", "projectDir"));
  }
  if (input.preset) patch.preset = String(input.preset);
  if (pick(input, "export_path", "exportPath", "output")) {
    patch.exportPath = String(pick(input, "export_path", "exportPath", "output"));
  }
  if (input.timeout_sec != null) patch.timeoutSec = numberOr(input.timeout_sec, config.timeoutSec);
  if (input.headless != null) patch.headless = input.headless !== false;
  if (input.import_glb != null) patch.importGlb = input.import_glb !== false;
  if (pick(input, "glb_dir", "glbDir")) patch.glbDir = String(pick(input, "glb_dir", "glbDir"));
  if (input.config && typeof input.config === "object") Object.assign(patch, input.config);
  return { ...config, ...patch };
}

async function run(action, input, context) {
  const userDataPath = resolveUserData(context);
  const stored = (await store.getPlugin(userDataPath, "godot"))?.config || (await registry.configForGodot(userDataPath));
  const config = configWithOverrides(stored, input);
  const execution = new Set(["project", "scene", "import_glb", "build", "export", "run", "demo"]);
  if (execution.has(action)) {
    const record = await store.getPlugin(userDataPath, "godot");
    if (record && record.enabled === false) {
      return truth(false, "Плагин Godot выключен. Включите: plugin action=enable plugin=godot");
    }
  }

  switch (action) {
    case "status":
    case "detect": {
      const info = godot.detect(config);
      const running = godot.listRunning();
      const text = info.found
        ? `Godot ${info.version || "?"} найден (${info.source === "config" ? "из настроек" : "автоопределение"}): ${info.executable}` +
          `\nпроект: ${config.projectDir || godot.resolveProjectDir(userDataPath, config)}` +
          `\nпресет: ${config.preset} · экспорт: ${config.exportPath || "по умолчанию"}` +
          (running.length ? `\nвыполняется задач: ${running.length}` : "")
        : `Godot не найден. ${info.error}\nУстановите Godot (https://godotengine.org/download) или укажите путь: action=config executable="C:/Program Files/Godot/godot.exe".`;
      return truth(info.found, text, {
        found: info.found,
        executable: info.executable,
        version: info.version,
        source: info.source,
        checked: info.checked,
        config,
        running,
      });
    }
    case "probe": {
      const probed = await godot.probe(userDataPath, config);
      const templates = probed.templates?.found ? "есть" : "нет";
      const text = probed.ok
        ? `Godot ${probed.version} · export templates: ${templates}\nвозможности: ${(probed.engines || []).join(", ")}\n` +
          `платформы: ${Object.entries(probed.operators || {})
            .filter(([, value]) => value)
            .map(([key]) => key)
            .join(", ")}`
        : `Не удалось опросить Godot: ${probed.error || "неизвестная ошибка"}`;
      return truth(Boolean(probed.ok), text, { ...probed, config });
    }
    case "project": {
      const info = godot.detect(config);
      const project = await godot.ensureProject(userDataPath, config, { version: info.version });
      return truth(true, `Проект Godot готов: ${project.projectDir}`, {
        projectDir: project.projectDir,
        projectFile: project.projectFile,
        created: project.created,
        sceneCreated: project.sceneCreated,
      });
    }
    case "scene": {
      let plan = pick(input, "plan", "scene");
      if (typeof plan === "string") {
        try {
          plan = JSON.parse(plan);
        } catch {
          throw new Error("scene: plan должен быть объектом или JSON-строкой.");
        }
      }
      if (!plan || typeof plan !== "object") plan = {};
      if (!Array.isArray(plan.nodes) && Array.isArray(input.nodes)) plan = { ...plan, nodes: input.nodes };
      if (!Array.isArray(plan.nodes) && Array.isArray(input.objects)) plan = { ...plan, nodes: input.objects };
      if (!Array.isArray(plan.nodes) || !plan.nodes.length) {
        throw new Error("Пустая сцена: передайте nodes[] (name, type, mesh, transform, material). " + SCENE_REFERENCE);
      }
      const result = await godot.runScene(userDataPath, config, plan, { title: input.title || plan.name || "Godot сцена" });
      return truth(Boolean(result.ok), `${jobLine(result.job)}\nсцена: ${result.scenePath || "—"}`, {
        ...jobPayload(result.job),
        scenePath: result.scenePath || "",
        warnings: result.warnings || [],
      });
    }
    case "import_glb": {
      const files = pick(input, "glb", "files", "paths", "source_dir", "glb_dir", "glbDir");
      const result = await godot.importGlb(userDataPath, config, files || [], {
        title: input.title || "Импорт GLB в Godot",
      });
      const imported = result.imported || [];
      const lines = imported
        .filter((entry) => entry.ok)
        .map((entry) => `1 ${entry.target}${entry.importFile ? ` (+ .import)` : ""}`)
        .concat(imported.filter((entry) => !entry.ok).map((entry) => `0 ${entry.target} — не импортирован`));
      const text = result.ok
        ? `Импортировано ${imported.length} файл(ов) в assets/.\n${lines.join("\n")}`
        : `Импорт GLB не удался: ${result.error}\n${lines.join("\n")}`;
      return truth(Boolean(result.ok), text.trim(), {
        ...jobPayload(result.job),
        imported,
        assetsDir: path.join(godot.resolveProjectDir(userDataPath, config), "assets"),
      });
    }
    case "build":
    case "export": {
      const preset = pick(input, "preset", "platform");
      const result = await godot.build(userDataPath, config, {
        preset,
        exportPath: pick(input, "export_path", "exportPath", "output"),
        title: input.title || `Сборка Godot (${preset || config.preset})`,
      });
      const text = result.ok
        ? `${jobLine(result.job)}\nэкспорт: ${result.exportPath}`
        : `Сборка Godot не удалась: ${result.error}${result.hint ? `\n${result.hint}` : ""}`;
      return truth(Boolean(result.ok), text, {
        ...jobPayload(result.job),
        preset: result.preset || preset || config.preset,
        exportPath: result.exportPath || "",
        hint: result.hint || "",
        error: result.error || "",
      });
    }
    case "run": {
      const frames = numberOr(pick(input, "frames", "quit_after"), 3);
      const result = await godot.runProject(userDataPath, config, { frames, title: input.title || "Запуск Godot" });
      const tail = String(result.log || "")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-12)
        .join("\n");
      const text = result.ok
        ? `${jobLine(result.job)}\nпроект отработал ${result.seconds} с (${result.frames} кадров)`
        : `Запуск Godot не удался: ${result.error}`;
      return truth(Boolean(result.ok), `${text}${tail ? `\n${tail}` : ""}`, {
        ...jobPayload(result.job),
        seconds: result.seconds || 0,
        frames: result.frames || frames,
      });
    }
    case "demo": {
      const result = await godot.runDemo(userDataPath, config, {
        preset: pick(input, "preset", "platform"),
        frames: numberOr(pick(input, "frames", "quit_after"), 3),
        files: pick(input, "glb", "files"),
      });
      const text = result.ok
        ? `${jobLine(result.job)}\nсцена: ${result.scenePath}\nэкспорт: ${result.exportPath}${
            result.run?.seconds != null ? `\nзапуск: ${result.run.seconds} с` : ""
          }`
        : `Демо Godot не удалось: ${result.error}${result.hint ? `\n${result.hint}` : ""}`;
      return truth(Boolean(result.ok), text, {
        ...jobPayload(result.job),
        scenePath: result.scenePath || "",
        exportPath: result.exportPath || "",
        hint: result.hint || "",
        warnings: result.warnings || [],
      });
    }
    case "jobs": {
      const jobs = await registry.jobs(userDataPath, {
        limit: numberOr(input.limit, 20),
        pluginId: "godot",
      });
      const lines = jobs.map(jobLine);
      return truth(true, lines.join("\n") || "Задач Godot нет.", {
        jobs: jobs.map((job) => ({ ...jobPayload(job), kind: job.kind, title: job.title, createdAt: job.createdAt })),
      });
    }
    case "job": {
      const jobId = pick(input, "job", "job_id", "id");
      if (!jobId) throw new Error("action=job требует job=<id>.");
      const job = await registry.job(userDataPath, String(jobId));
      if (!job) return truth(false, "Задача не найдена.");
      const tail = job.logPath && fs.existsSync(job.logPath) ? readTextTail(job.logPath, 40) : "";
      return truth(job.status === "succeeded", `${jobLine(job)}${tail ? `\n\n${tail}` : ""}`, {
        ...jobPayload(job),
        log: tail,
      });
    }
    case "cancel": {
      const jobId = pick(input, "job", "job_id", "id");
      if (!jobId) throw new Error("action=cancel требует job=<id>.");
      const result = registry.cancel(String(jobId));
      return truth(Boolean(result.canceled), result.canceled ? `Задача ${jobId} отменена.` : `Задача ${jobId} не выполняется.`, result);
    }
    case "delete_job": {
      const jobId = pick(input, "job", "job_id", "id");
      if (!jobId) throw new Error("action=delete_job требует job=<id>.");
      const result = await registry.deleteJob(userDataPath, String(jobId));
      return truth(true, `Задача ${jobId} удалена.`, result);
    }
    case "config": {
      const patch = {};
      for (const key of [
        "executable",
        "projectDir",
        "outputDir",
        "preset",
        "exportPath",
        "headless",
        "importGlb",
        "glbDir",
        "timeoutSec",
      ]) {
        if (input[key] !== undefined) patch[key] = input[key];
      }
      if (input.project_dir !== undefined) patch.projectDir = input.project_dir;
      if (input.export_path !== undefined) patch.exportPath = input.export_path;
      if (input.timeout_sec !== undefined) patch.timeoutSec = input.timeout_sec;
      if (input.glb_dir !== undefined) patch.glbDir = input.glb_dir;
      if (input.config && typeof input.config === "object") Object.assign(patch, input.config);
      const updated = await registry.updatePlugin(userDataPath, "godot", { config: patch, enabled: input.enabled });
      return truth(true, `Godot: настройки сохранены\n${registry.describeStatus(updated.status)}`, {
        plugin: updated,
        config: updated.config,
      });
    }
    case "copy_artifacts": {
      const jobId = pick(input, "job", "job_id", "id");
      if (!jobId) throw new Error("action=copy_artifacts требует job=<id>.");
      const result = await registry.copyArtifacts(userDataPath, String(jobId), pick(input, "output_dir", "target") || "");
      return truth(true, `Скопировано файлов: ${result.copied.length}\n${result.folder}`, result);
    }
    case "open_output": {
      const jobId = pick(input, "job", "job_id", "id");
      const job = jobId ? await registry.job(userDataPath, String(jobId)) : null;
      const folder = job?.dir || godot.resolveProjectDir(userDataPath, config);
      const exportPath = job?.exportPath || config.exportPath || "";
      return truth(true, `Папка: ${folder}${exportPath ? `\nэкспорт: ${exportPath}` : ""}`, { folder, exportPath });
    }
    default:
      throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
  }
}

function readTextTail(file, lines) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

module.exports = {
  name: "godot",
  description:
    "Drive the installed Godot engine headless — build a text .tscn scene, import GLB from Blender, export a runnable game and verify it. " +
    "Pipeline for game work: build the asset in `blender` (export.preset=godot, filepath=*.glb) → `godot action=import_glb glb=[…]` → " +
    "optional `godot action=scene` (placeholder level / nodes) → `godot action=build preset=windows|linux|macos|web export_path=…` → " +
    "`godot action=run` to check the scene boots, then `vision_godot job=<id>` (or path=<screenshot>) to actually SEE a frame. " +
    "Start with action=status: if found=false, ask the user to install Godot (https://godotengine.org/download) or set the executable in Плагины → Godot. " +
    "Never claim a build succeeded without ok:true from action=build/export; always pass preset and export_path explicitly when the user asked for a specific build. " +
    "Android export needs the Android SDK/NDK and returns a clear error instead of a fake success. " +
    "Actions: status, probe, detect, project, scene, import_glb, build, export, run, jobs, job, cancel, delete_job, config, copy_artifacts, open_output, demo. " +
    SCENE_REFERENCE +
    "Every result carries bit=1 (done) / bit=0 (failed), job id, scene/export paths and the Godot log tail.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: ACTIONS.join(" | ") },
      project: { type: "string", description: "Godot project folder (contains project.godot). Default: userData/plugins/godot/project" },
      project_dir: { type: "string", description: "Alias of project" },
      scene: { type: "object", description: "Declarative scene plan (or JSON string). See SCENE in the description." },
      plan: { type: "object", description: "Alias of scene" },
      nodes: { type: "array", items: { type: "object" }, description: "Scene nodes shorthand" },
      glb: {
        description: "GLB/GLTF file(s) or a folder to import; omit to use the Blender output folder",
      },
      files: { description: "Alias of glb" },
      preset: { type: "string", description: "Export preset: windows | linux | macos | web | android" },
      export_path: { type: "string", description: "Export target (exe / zip / index.html / folder); default <project>/build/<preset>/game" },
      frames: { type: "number", description: "Frames to run headless for action=run (default 3)" },
      headless: { type: "boolean", description: "Run Godot headless (default true)" },
      import_glb: { type: "boolean", description: "Import GLB from the Blender output before build/scene" },
      glb_dir: { type: "string", description: "Folder scanned for GLB when glb= is omitted" },
      timeout_sec: { type: "number", description: "Per-step timeout in seconds (10..7200)" },
      job: { type: "string", description: "Job id for job/cancel/delete_job/copy_artifacts/open_output" },
      executable: { type: "string", description: "Path to godot.exe / godot binary (overrides the saved config for this call)" },
      title: { type: "string", description: "Human title for the job" },
      limit: { type: "number", description: "jobs: max entries (default 20)" },
      config: { type: "object", description: "Config patch saved by action=config" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    let action = String(pick(input, "action") || "status").trim().toLowerCase();
    const aliases = {
      info: "status",
      find: "detect",
      detect_engine: "detect",
      init: "project",
      ensure_project: "project",
      create_project: "project",
      import: "import_glb",
      import_gltf: "import_glb",
      export_game: "build",
      build_game: "build",
      compile: "build",
      play: "run",
      run_project: "run",
      preview: "demo",
      demos: "demo",
      list: "jobs",
      history: "jobs",
      settings: "config",
      configure: "config",
      delete: "delete_job",
      copy: "copy_artifacts",
      output: "open_output",
    };
    if (aliases[action]) action = aliases[action];
    if (!ACTIONS.includes(action)) {
      throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
    }
    return run(action, input, context);
  },
};
