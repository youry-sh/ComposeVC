const fs = require("fs");

const blender = require("../plugins/blender/index.cjs");
const blenderAddons = require("../plugins/blender/addons.cjs");
const blenderAssets = require("../plugins/blender/assets.cjs");
const registry = require("../plugins/registry.cjs");
const store = require("../plugins/store.cjs");

const ACTIONS = [
  "status",
  "probe",
  "scene",
  "python",
  "render",
  "export",
  "import",
  "inspect",
  "bake",
  "jobs",
  "job",
  "cancel",
  "delete_job",
  "config",
  "copy_artifacts",
  "open_output",
  "open_gui",
  "addons",
  "addon_search",
  "addon_install",
  "addon_enable",
  "addon_disable",
  "asset_search",
  "asset_download",
  "asset_list",
  "asset_remove",
];

const PLAN_REFERENCE = `
PLAN (declarative scene, action=scene) — everything optional except objects/source/import/python:
{
  "name": "job title",
  "reset": true,                      // wipe the scene first (default true)
  "source": "C:/path/existing.blend", // open an existing file instead of resetting
  "unit": "METRIC", "unit_scale": 1.0,
  "materials": [{
    "name": "Steel", "preset": "steel|brushed_metal|gold|copper|wood|oak|stone|concrete|brick|fabric|leather|rubber|plastic|ceramic|glass|emissive|hologram|skin|sci_fi_panel|rust|marble|dirt",
    "base_color": "#b8bcc4" | [r,g,b(,a)], "metallic": 1, "roughness": 0.28,
    "ior": 1.45, "alpha": 1, "transmission": 0, "emission": "#ff6a00", "emission_strength": 4,
    "coat": 0.2, "sheen": 0, "subsurface": 0, "anisotropic": 0, "backface_culling": false,
    "texture": {
      "type": "noise|voronoi|wave|rings|checker|brick|gradient|magic|image",
      "scale": 6, "detail": 8, "roughness": 0.5, "distortion": 0.2,
      "color_a": "#2b2f36", "color_b": "#d8dde6", "contrast": 0.5,
      "roughness_map": true, "roughness_min": 0.15, "roughness_max": 0.7,
      "bump": 0.25, "bump_distance": 0.05,
      "path": "C:/tex/wood.png",            // for type=image
      "projection": "uv|box", "uv_scale": 3, "rotation": [0,0,0], "offset": [0,0,0],
      "color_a/color_b drive a ColorRamp; use_raw_color:true keeps texture colour without ramp"
    },
    "normal_map": {"path": "C:/tex/normal.png", "strength": 1.0},
    "roughness_texture": {"path": "C:/tex/rough.jpg", "roughness_min": 0.2, "roughness_max": 0.9},
    "metallic_texture": {"path": "C:/tex/metal.jpg"},
    "animation": {"emission_strength": [{"frame": 1, "value": 0.5}, {"frame": 40, "value": 8}]}
  }],
  "collections": ["Props", {"name": "Env", "parent": "Props"}],
  "objects": [{
    "name": "Sword", "type": "cube|box|sphere|uv_sphere|ico_sphere|cylinder|cone|torus|plane|circle|grid|monkey|mesh|curve|text|empty|light|point|sun|area|spot|camera",
    "collection": "Props",
    "location": [0,0,0], "rotation": [0,0,0] (degrees), "scale": [1,1,1],
    "dimensions": [0.1, 0.02, 1.2], "look_at": [0,0,0],
    "vertices": [[x,y,z], …], "faces": [[0,1,2], …],     // type=mesh
    "points": [[x,y,z], …], "spline_type": "BEZIER|POLY", "bevel_depth": 0.02, // type=curve
    "text": "Hello", "size": 1, "extrude": 0.02,          // type=text
    "material": "Steel" | {inline material spec} | ["Steel", "Leather"],
    "smooth": true,
    "bevel": 0.01 | {"width": 0.01, "segments": 2},
    "subdivision": 2,
    "array": {"count": 4, "relative_offset_displace": [1.1,0,0]},
    "mirror": "X",
    "modifiers": [{"type": "SOLIDIFY", "thickness": 0.01}, {"type": "BOOLEAN", "object": "Other", "operation": "DIFFERENCE"}],
    "apply_modifiers": false,
    "uv": {"angle": 66, "margin": 0.02},
    "parent": "Root",
    "animation": {"location": [{"frame": 1, "value": [0,0,0]}, {"frame": 60, "value": [0,0,1]}],
                  "rotation": [{"frame": 1, "value": [0,0,0]}, {"frame": 60, "value": [0,0,360]}],
                  "scale": [{"frame": 1, "value": [1,1,1]}], "interpolation": "BEZIER|LINEAR"},
    "energy": 500, "color": "#ffffff", "size": 2, "shape": "DISK",   // lights
    "lens": 50, "dof": {"fstop": 2.8, "distance": 6}                 // cameras
  }],
  "armatures": [{
    "name": "Rig", "mesh": "Character", "bind": true,
    "bones": [{"name": "Root", "head": [0,0,0], "tail": [0,0,0.3]},
              {"name": "Spine", "head": [0,0,0.3], "tail": [0,0,1.1], "parent": "Root"}]
  }],
  "animation": {"frame_start": 1, "frame_end": 120, "fps": 30},
  "lighting": "studio|three_point|product|sunset|dramatic|outdoor|none",
  "world": {"color": "#15171c", "strength": 0.3, "hdri": "C:/hdri/studio.hdr", "hdri_rotation": [0,0,0],
            "sky": {"type": "NISHITA", "sun_elevation": 12, "sun_rotation": 40, "dust": 2}},
  "camera": "three_quarter|front|back|side|top|hero|closeup" | {"view": "hero", "lens": 50, "distance": 1.0, "margin": 1.12, "look_at": [0,0,0.5]},
  "render": {"engine": "EEVEE|CYCLES|WORKBENCH", "resolution": [1600,1000], "samples": 64,
             "transparent": false, "denoise": true, "exposure": 0,
             "filename": "preview",
             "views": ["hero", "front", {"view": "top", "name": "top"}],
             "turntable": {"frames": 8, "start_angle": 0},
             "effects": {"bloom": {"type": "Fog Glow|Bloom|Streaks", "threshold": 0.85, "strength": 0.6, "size": 0.6},
                         "chromatic": 0.02}},
  "bake": {"objects": ["Sword"], "passes": ["BASE_COLOR","ROUGHNESS","NORMAL"], "width": 2048, "height": 2048,
           "margin": 8, "apply": true, "dir": "textures"},
  "optimize": {"apply_scale": true, "merge_distance": 0.0001, "triangulate": false, "origin": "center_floor"},
  "quality": {"require_textures": true, "require_uv": true, "require_applied_scale": true, "max_polygons": 40000},
  "export": {"format": "GLB|GLTF|FBX|OBJ|USD|STL|PLY|BLEND",
             "preset": "unity|unreal|godot|web|3dprint",
             "filepath": "sword.glb", "selected": false, "objects": ["Sword"],
             "apply_modifiers": true, "include_lights": false, "include_cameras": false},
  "import": [{"path": "C:/models/character.glb", "location": [0,0,0], "scale": [1,1,1]}],
  "append": [{"blend": "C:/lib/assets.blend", "objects": ["Crate", "Barrel"]}],
  "addons": [{"module": "bl_ext.user_default.my_addon"}, "another_module"],
  "install_addons": [{"path": "C:/addons/auto_rig.zip", "enable": true}],
  "disable_addons": ["some_module"],
  "python": "import bpy\\n# arbitrary bpy code executed after the declarative build",
  "save": "scene.blend"
}
`;


/** Every answer carries one bit: 1 = it happened / it is true, 0 = it did not. */
function truth(ok, text, payload = {}) {
  return { bit: ok ? 1 : 0, ok: Boolean(ok), text, ...payload };
}

function resolveUserData(context) {
  const value = context?.userDataPath;
  if (!value) throw new Error("Blender plugin requires Electron userDataPath");
  return value;
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function parsePlan(input, config) {
  let plan = input.plan;
  if (typeof plan === "string") {
    try {
      plan = JSON.parse(plan);
    } catch (error) {
      throw new Error(`plan: некорректный JSON — ${error.message}`);
    }
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) plan = {};
  else plan = { ...plan };

  const shorthand = {
    name: "name",
    title: "title",
    objects: "objects",
    materials: "materials",
    collections: "collections",
    world: "world",
    lighting: "lighting",
    camera: "camera",
    lights: "lights",
    cameras: "cameras",
    render: "render",
    export: "export",
    save: "save",
    source: "source",
    python: "python",
    bake: "bake",
    import: "import",
    append: "append",
    reset: "reset",
    armatures: "armatures",
    animation: "animation",
    quality: "quality",
    optimize: "optimize",
    addons: "addons",
    install_addons: "install_addons",
    disable_addons: "disable_addons",
  };
  for (const [inputKey, planKey] of Object.entries(shorthand)) {
    if (input[inputKey] !== undefined && input[inputKey] !== null) plan[planKey] = input[inputKey];
  }
  if (input.blend && !plan.source) plan.source = String(input.blend);

  if (!plan.name && input.title) plan.name = String(input.title);
  if (plan.render === undefined) {
    plan.render =
      config.autoRender === false
        ? false
        : {
            engine: config.engine,
            resolution: config.resolution,
            samples: config.samples,
          };
  }
  if (plan.render && typeof plan.render === "object") {
    if (!plan.render.engine) plan.render.engine = config.engine;
    if (!plan.render.resolution) plan.render.resolution = config.resolution;
    if (!plan.render.samples) plan.render.samples = config.samples;
    if (input.effects && !plan.render.effects) plan.render.effects = input.effects;
    if (plan.effects && !plan.render.effects) plan.render.effects = plan.effects;
  }
  if (plan.export === undefined) plan.export = { format: config.format };
  if (plan.save === undefined) plan.save = "scene.blend";
  return plan;
}

function jobSummary(job) {
  const stats = job.stats || {};
  const lines = [];
  if (job.title) lines.push(`задача: ${job.title}`);
  lines.push(`результат: ${job.status === "succeeded" ? "готово" : job.status}${job.error ? ` — ${job.error}` : ""}`);
  if (job.summary) lines.push(job.summary);
  if (job.blender?.engine) lines.push(`движок: ${job.blender.engine}`);
  if (job.blendPath) lines.push(`blend: ${job.blendPath}`);
  if (job.renders?.length) lines.push(`рендеры: ${job.renders.map((item) => item.path).join(", ")}`);
  if (job.exports?.length) lines.push(`экспорт: ${job.exports.map((item) => `${item.format} ${item.path}`).join(", ")}`);
  if (job.quality) {
    lines.push(
      `качество: ${job.quality.score}/100${job.quality.game_ready ? " · game-ready" : " · есть замечания"}` +
        (job.quality.issues?.length ? ` · ${job.quality.issues.slice(0, 8).join(", ")}` : "")
    );
  }
  if (job.addons?.length) {
    const modules = job.addons.map((entry) => entry.module).filter(Boolean);
    if (modules.length) lines.push(`аддоны: ${modules.join(", ")}`);
  }
  if (stats.objects) lines.push(`сцена: ${stats.objects} объектов · ${stats.polygons || 0} полигонов · ${stats.materials || 0} материалов`);
  if (job.warnings?.length) lines.push(`предупреждения (${job.warnings.length}): ${job.warnings.slice(0, 5).join(" | ")}`);
  return lines.join("\n");
}

async function copyToOutput(userDataPath, job, targetDir) {
  if (!targetDir) return null;
  try {
    return await registry.copyArtifacts(userDataPath, job.id, targetDir);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function jobPayload(job, extra = {}) {
  const stats = job.stats || {};
  return {
    jobId: job.id,
    status: job.status,
    kind: job.kind,
    title: job.title,
    summary: job.summary,
    durationMs: job.durationMs,
    jobDir: job.dir,
    blendPath: job.blendPath,
    renders: job.renders || [],
    bakes: job.bakes || [],
    exports: job.exports || [],
    warnings: (job.warnings || []).slice(0, 20),
    warningsCount: (job.warnings || []).length,
    quality: job.quality || null,
    addons: job.addons || [],
    stats: {
      objects: stats.objects || 0,
      meshes: stats.meshes || 0,
      polygons: stats.polygons || 0,
      vertices: stats.vertices || 0,
      materials: stats.materials || 0,
      lights: stats.lights || 0,
      cameras: stats.cameras || 0,
      images: stats.images || 0,
    },
    engine: job.blender?.engine || "",
    error: job.error || "",
    ...extra,
  };
}

async function run(action, input, context) {
  const userDataPath = resolveUserData(context);
  const config = await registry.configForBlender(userDataPath);
  const onProgress = typeof context?.onProgress === "function" ? context.onProgress : undefined;
  const signal = context?.signal;
  const EXECUTION_ACTIONS = new Set(["scene", "import", "python", "render", "export", "bake"]);
  if (EXECUTION_ACTIONS.has(action)) {
    const record = await store.getPlugin(userDataPath, "blender");
    if (record && record.enabled === false) {
      return truth(
        false,
        "Плагин Blender выключен. Включите его во вкладке Plugins (или action=config enabled=true), затем повторите."
      );
    }
  }

  switch (action) {
    case "status": {
      const info = blender.detect(config);
      const plugin = await store.getPlugin(userDataPath, "blender");
      const running = blender.listRunning();
      const text = info.found
        ? `Blender ${info.version || "?"} найден (${info.source === "config" ? "из настроек" : "автоопределение"}): ${info.executable}` +
          `\nплагин: ${plugin?.enabled ? "включён" : "выключен"} · движок по умолчанию: ${config.engine} · экспорт: ${config.format}` +
          (running.length ? `\nвыполняется задач: ${running.length}` : "")
        : `Blender не найден. ${info.error}\nУстановите Blender (https://www.blender.org/download/) или укажите путь: action=config executable="C:/Program Files/Blender Foundation/Blender 5.2/blender.exe".`;
      return truth(info.found, text, {
        found: info.found,
        executable: info.executable,
        version: info.version,
        source: info.source,
        checked: info.checked,
        config,
        enabled: plugin?.enabled !== false,
        running,
      });
    }
    case "probe": {
      const info = blender.detect(config);
      if (!info.found) return truth(false, info.error, { found: false, checked: info.checked });
      const probed = await blender.probe(userDataPath, config);
      const engines = (probed.engines || []).join(", ") || "—";
      const text = probed.ok
        ? `Blender ${probed.version} · движки: ${engines}\nэкспортёры: ${Object.entries(probed.operators || {})
            .filter(([, value]) => value)
            .map(([key]) => key.replace("export_scene.", "").replace("wm.", ""))
            .join(", ")}\nаддоны: ${(probed.addons || []).slice(0, 12).join(", ")}`
        : `Не удалось опросить Blender: ${probed.error || "неизвестная ошибка"}`;
      return truth(Boolean(probed.ok), text, { found: true, executable: info.executable, ...probed });
    }
    case "scene":
    case "import": {
      const plan = parsePlan(input, config);
      if (action === "import" && !plan.import) {
        const files = pick(input, "files", "paths");
        if (files) plan.import = Array.isArray(files) ? files.map((file) => ({ path: String(file) })) : [{ path: String(files) }];
      }
      const hasWork =
        (Array.isArray(plan.objects) && plan.objects.length > 0) ||
        (Array.isArray(plan.import) && plan.import.length > 0) ||
        (Array.isArray(plan.append) && plan.append.length > 0) ||
        Boolean(plan.python) ||
        Boolean(plan.source);
      if (!hasWork) {
        throw new Error(
          "Пустой план: передайте objects[] (или import/append/python/source). " + PLAN_REFERENCE
        );
      }
      const job = await blender.runPlan(userDataPath, config, plan, {
        title: plan.name || "Blender scene",
        kind: action === "import" ? "import" : "scene",
        onProgress,
        signal,
      });
      const copied = job.status === "succeeded" ? await copyToOutput(userDataPath, job, input.output_dir) : null;
      return truth(job.status === "succeeded", jobSummary(job), jobPayload(job, copied ? { copied } : {}));
    }
    case "python": {
      const code = pick(input, "code", "python", "script", "source");
      if (!code) throw new Error("action=python требует code (bpy-скрипт).");
      const job = await blender.runPython(userDataPath, config, code, {
        title: input.title || "Blender python",
        onProgress,
        signal,
      });
      const tail = (job.logTail || "").split(/\r?\n/).filter(Boolean).slice(-30).join("\n");
      const text = job.status === "succeeded"
        ? `Скрипт выполнен за ${job.durationMs} мс.${job.blendPath ? `\nblend: ${job.blendPath}` : ""}${tail ? `\nвывод:\n${tail}` : ""}`
        : `Скрипт не выполнен: ${job.error}\n${tail}`;
      return truth(job.status === "succeeded", text, jobPayload(job, { stdoutTail: job.logTail, stderrTail: job.stderrTail }));
    }
    case "render": {
      const source = pick(input, "blend", "source", "path");
      if (!source) throw new Error("action=render требует blend (путь к .blend) или source.");
      const renderSpec =
        input.render && typeof input.render === "object"
          ? input.render
          : {
              engine: input.engine || config.engine,
              resolution: input.resolution || config.resolution,
              samples: input.samples || config.samples,
              views: input.views,
              transparent: input.transparent,
              filename: input.filename,
            };
      const plan = { source: String(source), render: renderSpec, save: false, export: false, reset: false };
      if (input.objects) plan.objects = input.objects;
      const job = await blender.runPlan(userDataPath, config, plan, {
        title: input.title || "Blender render",
        kind: "render",
        onProgress,
        signal,
      });
      return truth(job.status === "succeeded", jobSummary(job), jobPayload(job));
    }
    case "export": {
      const source = pick(input, "blend", "source", "path");
      if (!source) throw new Error("action=export требует blend (путь к .blend).");
      const spec = {
        format: String(pick(input, "format", "type") || config.format).toUpperCase(),
        filepath: pick(input, "filepath", "file"),
        selected: Boolean(pick(input, "selected", "selection")),
        objects: input.objects,
        apply_modifiers: input.apply_modifiers !== false,
      };
      const exportsList = input.exports;
      const plan = {
        source: String(source),
        export: exportsList && Array.isArray(exportsList) ? exportsList : spec,
        render: false,
        save: false,
        reset: false,
      };
      const job = await blender.runPlan(userDataPath, config, plan, {
        title: input.title || `Blender export ${spec.format}`,
        kind: "export",
        onProgress,
        signal,
      });
      const copied = job.status === "succeeded" ? await copyToOutput(userDataPath, job, input.output_dir) : null;
      return truth(job.status === "succeeded", jobSummary(job), jobPayload(job, copied ? { copied } : {}));
    }
    case "inspect": {
      const source = pick(input, "blend", "source", "path");
      if (!source) throw new Error("action=inspect требует blend (путь к .blend).");
      const plan = { source: String(source), render: false, save: false, export: false, reset: false };
      const job = await blender.runPlan(userDataPath, config, plan, {
        title: input.title || "Blender inspect",
        kind: "inspect",
        onProgress,
        signal,
      });
      const objects = (job.stats?.objectsDetail || []).map((item) => ({ ...item }));
      const list = objects.slice(0, 120);
      const text =
        job.status === "succeeded"
          ? `Сцена: ${job.stats?.objects || 0} объектов · ${job.stats?.polygons || 0} полигонов · ${job.stats?.materials || 0} материалов\n` +
            list
              .map((item) => `- ${item.name} [${item.type}]${item.polygons ? ` ${item.polygons} tri` : ""}${item.materials?.length ? ` · ${item.materials.join(", ")}` : ""}`)
              .join("\n")
          : `Не удалось прочитать сцену: ${job.error}`;
      return truth(job.status === "succeeded", text, jobPayload(job, { objects: list }));
    }
    case "bake": {
      const plan = parsePlan(input, config);
      if (!plan.bake) plan.bake = { passes: ["BASE_COLOR"], width: 2048, height: 2048, apply: true };
      if (input.render === undefined) plan.render = false;
      plan.save = plan.save === undefined ? "scene.baked.blend" : plan.save;
      const job = await blender.runPlan(userDataPath, config, plan, {
        title: input.title || "Blender bake",
        kind: "bake",
        onProgress,
        signal,
      });
      return truth(job.status === "succeeded", jobSummary(job), jobPayload(job));
    }
    case "jobs": {
      const limit = Math.max(1, Math.min(200, Number(input.limit) || 20));
      const jobs = await store.listJobs(userDataPath, { limit, pluginId: input.plugin_id || undefined });
      const text = jobs.length
        ? jobs
            .map((job) => `${job.status === "succeeded" ? "1" : "0"} ${job.id} [${job.kind}] ${job.title || ""} ${job.summary || ""}`.trim())
            .join("\n")
        : "Задач пока нет.";
      return truth(true, text, {
        jobs: jobs.map((job) => ({
          id: job.id,
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
      const id = String(pick(input, "job", "job_id", "id") || "");
      if (!id) throw new Error("action=job требует job (id задачи).");
      const job = await store.getJob(userDataPath, id);
      if (!job) return truth(false, `Задача ${id} не найдена.`);
      let logTail = "";
      if (input.include_log !== false) {
        try {
          const content = await fs.promises.readFile(job.logPath, "utf8");
          logTail = content.slice(-8000);
        } catch {
          logTail = "";
        }
      }
      return truth(job.status === "succeeded", jobSummary(job), jobPayload(job, { logTail }));
    }
    case "cancel": {
      const id = String(pick(input, "job", "job_id", "id") || "");
      if (!id) throw new Error("action=cancel требует job (id задачи).");
      const result = blender.cancelJob(id);
      return truth(result.canceled, result.canceled ? `Задача ${id} остановлена.` : `Задача ${id} не выполняется.`, result);
    }
    case "delete_job": {
      const id = String(pick(input, "job", "job_id", "id") || "");
      if (!id) throw new Error("action=delete_job требует job (id задачи).");
      const result = await registry.deleteJob(userDataPath, id);
      return truth(true, `Задача ${id} удалена вместе с файлами.`, result);
    }
    case "copy_artifacts": {
      const id = String(pick(input, "job", "job_id", "id") || "");
      if (!id) throw new Error("action=copy_artifacts требует job (id задачи).");
      const target = pick(input, "output_dir", "target", "dir") || config.outputDir;
      const result = await registry.copyArtifacts(userDataPath, id, target);
      return truth(true, `Скопировано ${result.copied.length} файл(ов) в ${result.folder}`, result);
    }
    case "config": {
      const patch = {};
      const executable = pick(input, "executable", "blender_path", "path");
      if (executable) patch.executable = String(executable);
      const outputDir = pick(input, "output_dir", "outputDir");
      if (outputDir) patch.outputDir = String(outputDir);
      const engine = pick(input, "engine");
      if (engine) patch.engine = String(engine).toUpperCase();
      if (input.resolution) {
        const [width, height] = Array.isArray(input.resolution) ? input.resolution : [1600, 1000];
        patch.resolution = { width: Number(width) || 1600, height: Number(height) || 1000 };
      }
      if (input.width || input.height) {
        patch.resolution = { width: Number(input.width) || 1600, height: Number(input.height) || 1000 };
      }
      if (input.samples) patch.samples = Number(input.samples);
      const format = pick(input, "format");
      if (format) patch.format = String(format).toUpperCase();
      if (input.auto_render !== undefined) patch.autoRender = Boolean(input.auto_render);
      if (input.timeout_sec) patch.timeoutSec = Number(input.timeout_sec);
      if (input.factory_startup !== undefined) patch.factoryStartup = Boolean(input.factory_startup);
      if (input.enabled !== undefined) {
        await registry.updatePlugin(userDataPath, "blender", { enabled: Boolean(input.enabled) });
      }
      const updated = await registry.updatePlugin(userDataPath, "blender", { config: patch });
      const detected = blender.detect(updated.config);
      const text = `Настройки сохранены.\nBlender: ${detected.found ? `${detected.version} · ${detected.executable}` : "не найден"}\nдвижок: ${updated.config.engine} · ${updated.config.resolution.width}×${updated.config.resolution.height} · ${updated.config.samples} сэмплов · экспорт ${updated.config.format} · авто-рендер ${updated.config.autoRender ? "да" : "нет"}`;
      return truth(true, text, { config: updated.config, enabled: updated.enabled, detected });
    }
    case "open_output": {
      const id = String(pick(input, "job", "job_id", "id") || "");
      const job = id ? await store.getJob(userDataPath, id) : null;
      const dir = job?.dir || store.resolveOutputDir(userDataPath, config);
      return truth(true, `Папка задачи: ${dir}`, { dir, jobId: job?.id || null });
    }
    case "open_gui": {
      const source = pick(input, "blend", "source", "path");
      let blendPath = source ? String(source) : "";
      if (!blendPath) {
        const jobs = await store.listJobs(userDataPath, { limit: 25 });
        const withBlend = jobs.find((job) => job.blendPath);
        blendPath = withBlend?.blendPath || "";
      }
      if (!blendPath) return truth(false, "Нет .blend для открытия — сначала выполните action=scene.");
      const opened = await blender.openInBlender(config, blendPath);
      return truth(true, `Blender открыт с файлом ${opened.file}`, opened);
    }
    default:
      throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
  }
}

module.exports = {
  name: "blender",
  description:
    "Full control of the installed Blender via background bpy — build game-ready 3D scenes, materials and assets for the user. " +
    "Use it whenever the user wants a 3D model, prop, character base, environment, texture work, a render, or an export for Unity/Unreal/Godot. " +
    "Actions: status (is Blender installed + plugin config), probe (engines/exporters/addons), scene (BUILD from a declarative plan: objects, PBR materials with procedural or image textures, modifiers, lighting presets, camera, render, bake, export), " +
    "python (arbitrary bpy script — full power, no limits), render (re-render an existing .blend with new camera/lights/settings), export (existing .blend → GLB/GLTF/FBX/OBJ/USD/STL/PLY/BLEND), import (bring GLB/FBX/OBJ/STL/USD into a build), " +
    "inspect (objects/materials/polycounts of a .blend), bake (procedural materials → image textures), jobs/job/cancel/delete_job (history + logs), config (engine, resolution, samples, export format, Blender path), copy_artifacts (copy results into a folder), open_output, open_gui (open the .blend in Blender's UI). " +
    "Scene building is declarative: plan.objects[] + plan.materials[] + lighting/camera/render/export. Always inspect the result (renders/exports) and iterate for quality. " +
    "Textures: either procedural (noise/voronoi/wood/brick/…) or image files — generate texture images with the generate_image tool, save them, then reference the paths. " +
    PLAN_REFERENCE +
    "\nTips: default lighting preset 'studio' + camera 'three_quarter' + EEVEE 1600×1000 produce a presentable render in seconds. " +
    "For game assets use bake {passes:['BASE_COLOR','ROUGHNESS','NORMAL'], apply:true} then export GLB so textures travel with the model. " +
    "Every result carries bit=1 (done) / bit=0 (failed), the job id, output paths and a scene summary.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: ACTIONS.join(" | ") },
      plan: {
        type: "object",
        description:
          "Declarative scene plan (see tool description). May also be a JSON string. Shorthand top-level fields below are merged into it.",
        additionalProperties: true,
      },
      objects: { type: "array", items: { type: "object" }, description: "scene shorthand: objects to create" },
      materials: { type: "array", items: { type: "object" }, description: "scene shorthand: material definitions" },
      collections: { type: "array", items: { type: "string" }, description: "scene shorthand: collection names" },
      world: { type: "object", description: "scene shorthand: world color/strength/hdri/sky" },
      lighting: {
        type: "string",
        description: "scene shorthand: studio | three_point | product | sunset | dramatic | outdoor | none",
      },
      camera: { description: "scene shorthand: preset name or camera object" },
      render: { description: "scene shorthand: render settings object, or false to skip rendering" },
      export: { description: "scene shorthand: export spec object/array, or false" },
      bake: { type: "object", description: "scene shorthand: texture bake settings" },
      save: { description: "scene shorthand: .blend filename (or false)" },
      reset: { type: "boolean", description: "scene shorthand: wipe the scene before building (default true)" },
      source: { type: "string", description: "path to an existing .blend to open instead of resetting" },
      blend: { type: "string", description: "render/export/inspect/open_gui: path to a .blend" },
      python: { type: "string", description: "scene: inline bpy code executed after the declarative build" },
      code: { type: "string", description: "action=python: the full bpy script to run" },
      format: { type: "string", enum: ["GLB", "GLTF", "FBX", "OBJ", "USD", "STL", "PLY", "BLEND"], description: "export format" },
      filepath: { type: "string", description: "export: output filename (relative to the job folder or absolute)" },
      selected: { type: "boolean", description: "export: only selected objects" },
      engine: { type: "string", enum: ["EEVEE", "CYCLES", "WORKBENCH"], description: "render engine" },
      resolution: { type: "array", items: { type: "number" }, description: "render: [width, height]" },
      samples: { type: "number", description: "render samples" },
      views: { type: "array", description: "render: camera presets/objects to render as separate stills" },
      executable: { type: "string", description: "config: absolute path to blender.exe / blender" },
      output_dir: { type: "string", description: "copy results into this folder (scene/export actions)" },
      auto_render: { type: "boolean", description: "config: render automatically on scene builds" },
      timeout_sec: { type: "number", description: "config: job timeout in seconds" },
      enabled: { type: "boolean", description: "config: enable/disable the Blender plugin" },
      job: { type: "string", description: "job id for job/cancel/delete_job/copy_artifacts/open_output" },
      limit: { type: "number", description: "jobs: how many recent jobs to return" },
      include_log: { type: "boolean", description: "action=job: include the tail of the Blender log" },
      title: { type: "string", description: "human title for this job" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    const raw = String(context.originalToolName || context.rawToolName || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    let action = String(pick(input, "action", "operation", "command") || "").trim().toLowerCase();
    if (!action && input.plan) action = "scene";
    if (!action && (input.objects || input.materials)) action = "scene";
    if (!action && input.code) action = "python";
    if (!action && raw.includes("render")) action = "render";
    if (!action) action = "status";
    const aliases = {
      check: "status",
      info: "status",
      build: "scene",
      create: "scene",
      make: "scene",
      generate: "scene",
      sculpt: "scene",
      model: "scene",
      script: "python",
      run_python: "python",
      bpy: "python",
      rerender: "render",
      render_scene: "render",
      save: "export",
      export_scene: "export",
      load: "import",
      read: "inspect",
      scene_info: "inspect",
      list: "jobs",
      history: "jobs",
      get_job: "job",
      stop: "cancel",
      remove: "delete_job",
      settings: "config",
      setup: "config",
      open: "open_gui",
      open_blender: "open_gui",
      folder: "open_output",
      copy: "copy_artifacts",
    };
    if (aliases[action]) action = aliases[action];
    if (!ACTIONS.includes(action)) throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
    return run(action, input, context);
  },
};
