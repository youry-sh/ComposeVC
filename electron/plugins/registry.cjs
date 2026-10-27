const fs = require("fs");
const path = require("path");

const store = require("./store.cjs");
const blender = require("./blender/index.cjs");

/**
 * ComposeVC plugin host.
 *
 * A plugin is a built-in capability with its own settings, job history and AI
 * tools. Today the host ships one plugin (Blender); the shape is generic so
 * more (Krita, Godot, Substance, …) can be added without touching the UI or the
 * store format: register metadata here, expose an executor, and the workspace,
 * IPC bridge and AI tools pick it up.
 */

const PLUGINS = [
  {
    id: "blender",
    name: "Blender",
    kind: "builtin",
    version: "3.6 – 5.x",
    tagline: "Полный контроль над Blender: сцены, PBR-материалы, рендер и игровой экспорт",
    description:
      "Управляет установленным Blender через background-режим и bpy. Строит сцены из декларативного плана " +
      "или произвольного Python-скрипта, создаёт PBR-материалы с пресетами и процедурными/файловыми картами, " +
      "анимирует объекты и риги, добавляет эффекты (bloom, хроматика, emissive), рендерит презентационные кадры и turntable, " +
      "запекает текстуры, проверяет качество ассета и экспортирует GLB/GLTF/FBX/OBJ/USD/STL/PLY. " +
      "Сам ставит нужные аддоны Blender и скачивает CC0 текстуры/HDRI из Poly Haven.",
    icon: "box",
    homepage: "https://www.blender.org/download/",
    tools: ["blender"],
    capabilities: [
      "Объекты: примитивы, mesh из вершин/полигонов, кривые, текст, пустышки, импорт моделей и .blend-библиотек",
      "Материалы: пресеты (steel/wood/stone/leather/glass/gold/emissive/hologram/…), Principled BSDF, процедурные текстуры, PBR-карты (diffuse/normal/roughness/metalness)",
      "Модификаторы: Subdivision, Bevel, Array, Mirror, Solidify, Boolean, Decimate, Triangulate, Weld",
      "Свет и камера: пресеты studio/product/sunset/outdoor/dramatic, авто-кадрирование, turntable",
      "Анимация: keyframes объектов и emission материалов, арматуры с auto-weights, экспорт анимации в glTF/FBX",
      "Эффекты: bloom/glare и хроматическая дисперсия через compositor, emissive/голограммы, HDRI/sky",
      "Рендер: EEVEE / Cycles / Workbench, несколько ракурсов, PNG с альфой",
      "Запекание: base color / roughness / normal из процедурных материалов в PNG",
      "QA: score/game_ready, UV, текстуры, масштаб, полигоны — с автоматическим списком замечаний",
      "Аддоны: поиск и установка любых расширений Blender самим агентом, авто-включение в следующих задачах",
      "Ассеты: поиск и скачивание CC0 текстур/HDRI/моделей Poly Haven в локальную библиотеку",
      "Экспорт: GLB, GLTF, FBX, OBJ, USD, STL, PLY, .blend + пресеты unity/unreal/godot/web/3dprint",
      "Импорт готовых моделей и добавление объектов из других .blend",
      "Произвольный bpy-скрипт — без ограничений по возможностям Blender",
    ],
    examples: [
      "Создай стилизованный игровой меч с PBR-материалами (сталь + кожаная рукоять), студийным светом и экспортом в GLB для Unity. Проверь quality и исправь замечания.",
      "Найди CC0 текстуру дерева, скачай 2K-карты, собери сундук с фасками и UV, отрендери 3 ракурса и экспортируй GLB с текстурами.",
      "Собери low-poly набор: сундук, бочка, ящик — единый стиль, палитра, рендер 3 ракурса, GLB + запечённые текстуры.",
      "Сгенерируй sci-fi панель с emissive-полосами, bloom, воронёным металлом и процедурными царапинами, затем запеки текстуры в 2048.",
      "Сделай анимацию: вращающийся кристалл с пульсирующим emission, turntable 6 кадров и экспорт GLB с анимацией.",
      "Мне нужен авто-риггер — найди и установи подходящий аддон Blender сам, затем подготовь персонажа к ригу.",
      "Импортируй мою модель character.glb, поставь три-точечный свет, отрендерь витрину и выгрузи USD.",
    ],
    accent: "#e87d33",
  },
];

const META_BY_ID = new Map(PLUGINS.map((plugin) => [plugin.id, plugin]));

function metaFor(id) {
  return META_BY_ID.get(String(id)) || null;
}

async function statusFor(userDataPath, plugin, { deep = false } = {}) {
  if (plugin.id !== "blender") {
    return { found: false, error: "Для этого плагина ещё нет исполнителя.", executable: "", version: "" };
  }
  const detected = blender.detect(plugin.config);
  const base = {
    found: detected.found,
    executable: detected.executable,
    version: detected.version,
    source: detected.source,
    error: detected.error,
    running: blender.listRunning(),
    checked: (detected.checked || []).slice(0, 12),
  };
  if (!detected.found || !deep) return base;
  const probed = await blender.probe(userDataPath, plugin.config);
  return { ...base, probe: probed };
}

async function listPlugins(userDataPath, options = {}) {
  const state = await store.readAll(userDataPath);
  const jobs = await store.listJobs(userDataPath, { limit: 60 });
  const list = [];
  for (const meta of PLUGINS) {
    const record = state.plugins[meta.id];
    if (!record) continue;
    const status = await statusFor(userDataPath, record, { deep: false });
    const lastJob = jobs.find((job) => job.pluginId === meta.id) || null;
    list.push({
      ...meta,
      enabled: record.enabled,
      config: record.config,
      stats: record.stats,
      status,
      lastJob,
      outputDir: store.resolveOutputDir(userDataPath, record.config),
      jobsCount: jobs.filter((job) => job.pluginId === meta.id).length,
    });
  }
  return {
    ok: true,
    version: state.version,
    plugins: list,
    jobsRoot: store.jobsRoot(userDataPath),
    running: blender.listRunning(),
  };
}

async function getPlugin(userDataPath, id) {
  const meta = metaFor(id);
  if (!meta) throw new Error(`Плагин '${id}' не найден.`);
  const record = await store.getPlugin(userDataPath, meta.id);
  if (!record) throw new Error(`Плагин '${id}' не найден.`);
  const status = await statusFor(userDataPath, record, { deep: false });
  return decorate(userDataPath, meta, record, status, await store.listJobs(userDataPath, { limit: 60 }));
}

function decorate(userDataPath, meta, record, status, jobs) {
  const own = (jobs || []).filter((job) => job.pluginId === meta.id);
  return {
    ...meta,
    enabled: record.enabled,
    config: record.config,
    stats: record.stats,
    status,
    lastJob: own[0] || null,
    outputDir: store.resolveOutputDir(userDataPath, record.config),
    jobsCount: own.length,
  };
}

async function updatePlugin(userDataPath, id, patch = {}) {
  const meta = metaFor(id);
  if (!meta) throw new Error(`Плагин '${id}' не найден.`);
  const record = await store.updatePlugin(userDataPath, meta.id, patch);
  const status = await statusFor(userDataPath, record, { deep: false });
  return decorate(userDataPath, meta, record, status, await store.listJobs(userDataPath, { limit: 60 }));
}

async function configForBlender(userDataPath) {
  const record = await store.getPlugin(userDataPath, "blender");
  return record?.config || { ...store.DEFAULT_BLENDER_CONFIG };
}

async function jobs(userDataPath, options = {}) {
  return store.listJobs(userDataPath, options);
}

async function job(userDataPath, jobId) {
  return store.getJob(userDataPath, jobId);
}

function cancel(jobId) {
  return blender.cancelJob(jobId);
}

async function deleteJob(userDataPath, jobId) {
  return blender.deleteJob(userDataPath, jobId);
}

async function copyArtifacts(userDataPath, jobId, targetDir) {
  const record = await store.getJob(userDataPath, jobId);
  if (!record) throw new Error("Задача не найдена.");
  const root = String(targetDir || "").trim() || store.resolveOutputDir(userDataPath, (await store.getPlugin(userDataPath, "blender"))?.config);
  const folder = path.join(root, record.id);
  await fs.promises.mkdir(folder, { recursive: true });
  const copied = [];
  const files = [
    ...record.exports.map((item) => item.path),
    ...record.renders.map((item) => item.path),
    ...(record.bakes || []).map((item) => item.path),
    ...(record.blendPath ? [record.blendPath] : []),
  ];
  for (const file of files) {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile()) continue;
      const target = path.join(folder, path.basename(file));
      await fs.promises.copyFile(file, target);
      copied.push(target);
    } catch {
      /* skip missing artifacts */
    }
  }
  return { ok: true, folder, copied, outputDir: root };
}

function describeStatus(status) {
  if (!status?.found) return `не найден — ${status?.error || "укажите путь к blender.exe"}`;
  return `${status.version || "?"} · ${status.executable}`;
}

module.exports = {
  PLUGINS,
  metaFor,
  listPlugins,
  getPlugin,
  updatePlugin,
  statusFor,
  configForBlender,
  jobs,
  job,
  cancel,
  deleteJob,
  copyArtifacts,
  describeStatus,
};
