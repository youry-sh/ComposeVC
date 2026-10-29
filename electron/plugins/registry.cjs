const fs = require("fs");
const path = require("path");

const store = require("./store.cjs");
const blender = require("./blender/index.cjs");
const godot = require("./godot/index.cjs");
const motion = require("./motion/index.cjs");

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
  {
    id: "godot",
    name: "Godot",
    kind: "builtin",
    version: "4.x",
    tagline: "Сборка сцены, импорт GLB из Blender, headless-сборка и экспорт игры",
    description:
      "Управляет установленным Godot в headless-режиме. Создаёт проект и текстовые .tscn-сцены (Node3D, MeshInstance3D, " +
      "StandardMaterial3D), импортирует GLB/GLTF из Blender, собирает игру через --export-release с пресетами windows/linux/macos/web, " +
      "проверяет сцену запуском проекта. Все задачи пишутся в общий журнал плагинов и видны агенту и во вкладке «Плагины».",
    icon: "gamepad",
    homepage: "https://godotengine.org/download",
    tools: ["godot"],
    capabilities: [
      "Проект: создание минимального project.godot, каталогов assets/scenes и главной сцены",
      "Сцена: декларативные .tscn — Node3D, MeshInstance3D (Box/Cylinder/Sphere/Plane), StandardMaterial3D, свет и камера",
      "Импорт: копирование GLB/GLTF из Blender в assets/ и `godot --headless --import`",
      "Сборка: `--export-release` с пресетами windows, linux, macos, web (создаёт export_presets.cfg при необходимости)",
      "Проверка: headless-запуск проекта на N кадров и разбор ошибок Godot",
      "Журнал: задачи в userData/plugins/jobs с живым прогрессом в интерфейсе",
      "Экспорт артефактов игры в папку проекта одной командой",
    ],
    examples: [
      "Импортируй последний GLB из Blender в Godot и собери Windows-билд в build/windows/game.exe.",
      "Собери в Godot демо-сцену с полом, пьедесталом и светящимся кристаллом, затем проверь её запуском.",
      "Сделай web-экспорт проекта Godot и положи его в build/web.",
      "Проверь, что проект Godot запускается без ошибок, и покажи лог последних строк.",
      "Импортируй GLB, собери игру и покажи кадр через vision_godot, если есть скриншот.",
    ],
    accent: "#478cbf",
  },
  {
    id: "motion",
    name: "Motion Studio",
    kind: "builtin",
    version: "FFmpeg 6.x+",
    tagline: "Монтаж моушн-роликов: анимация текста, переходы, звук, рендер",
    description:
      "Собирает моушн-ролики через установленный FFmpeg: таймлайн из титров и сцен, анимация текста (fade/rise/slide), " +
      "переходы xfade, наложение звуковой дорожки и рендер в MP4/MOV/WebM/GIF одним вызовом filter_complex. " +
      "Читает метаданные медиа через ffprobe, сам ставит portable FFmpeg при первом запуске и пишет каждую задачу " +
      "с прогрессом, логом команды и кадром-превью в общий журнал плагинов.",
    icon: "clapperboard",
    homepage: "https://ffmpeg.org/download.html",
    tools: ["motion"],
    capabilities: [
      "Движок: автоопределение FFmpeg/FFprobe, установка portable-сборки или winget, проверка версии",
      "Таймлайн: титры, сцены с медиафайлами, переходы и аудиодорожки с точными временами",
      "Текст: drawtext с fade/rise/slide, переносом строк, safe margins и системным шрифтом fontFamily",
      "Переходы: xfade fade/slideleft/slideright/wipeleft/wiperight/circleopen/dissolve",
      "Звук: наложение дорожки, громкость в dB, amix нескольких источников, AAC/Opus",
      "Вывод: MP4/MOV (H.264), WebM (VP9), GIF с палитрой, настройки width/height/fps/crf/preset",
      "Метаданные: ffprobe — длительность, разрешение, fps, кодеки, битрейт, размер",
      "Журнал: задачи с живым прогрессом, log.txt с реальной командой ffmpeg и кадром-превью",
    ],
    examples: [
      "Собери 15-секундный ролик: титр «ComposeVC», переход dissolve, титр «Motion Studio», фоновая музыка.",
      "Сделай рекламный тизер из title-сцен с fade/rise, переходом slideleft и выводом 1080p MP4.",
      "Прочитай метаданные intro.mp4 (длительность, fps, кодеки) и подгони таймлайн под него.",
      "Смонтируй вертикальный ролик 1080x1920 для соцсетей с тремя титрами и дорожкой audio.mp3.",
      "Пересобери ролик в GIF с частотой 24 fps и палитрой, затем покажи превью из журнала задач.",
    ],
    accent: "#8b5cf6",
  },
];

const META_BY_ID = new Map(PLUGINS.map((plugin) => [plugin.id, plugin]));

function metaFor(id) {
  return META_BY_ID.get(String(id)) || null;
}

async function statusFor(userDataPath, plugin, { deep = false } = {}) {
  if (plugin.id === "blender") {
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
  if (plugin.id === "godot") {
    const detected = godot.detect(plugin.config);
    const base = {
      found: detected.found,
      executable: detected.executable,
      version: detected.version,
      source: detected.source,
      error: detected.error,
      note: detected.note || "",
      running: godot.listRunning(),
      checked: (detected.checked || []).slice(0, 12),
    };
    if (!detected.found || !deep) return base;
    const probed = await godot.probe(userDataPath, plugin.config);
    return { ...base, probe: probed };
  }
  if (plugin.id === "motion") {
    const detected = motion.detect(plugin.config, userDataPath);
    const base = {
      found: detected.found,
      executable: detected.executable,
      version: detected.version,
      source: detected.source,
      error: detected.error,
      note: detected.note || "",
      ffprobe: detected.ffprobe,
      running: motion.listRunning(),
      checked: (detected.checked || []).slice(0, 12),
    };
    if (!detected.found || !deep) return base;
    const probed = await motion.probe(userDataPath, plugin.config);
    return { ...base, probe: probed };
  }
  return { found: false, error: "Для этого плагина ещё нет исполнителя.", executable: "", version: "" };
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
    running: [...blender.listRunning(), ...godot.listRunning(), ...motion.listRunning()],
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

async function configForGodot(userDataPath) {
  const record = await store.getPlugin(userDataPath, "godot");
  return record?.config || { ...store.DEFAULT_GODOT_CONFIG };
}

async function configForMotion(userDataPath) {
  const record = await store.getPlugin(userDataPath, "motion");
  return record?.config || { ...store.DEFAULT_MOTION_CONFIG };
}

async function jobs(userDataPath, options = {}) {
  return store.listJobs(userDataPath, options);
}

async function job(userDataPath, jobId) {
  return store.getJob(userDataPath, jobId);
}

function cancel(jobId) {
  const cancelled = blender.cancelJob(jobId);
  if (cancelled?.canceled) return cancelled;
  const godotCancelled = godot.cancelJob(jobId);
  if (godotCancelled?.canceled) return godotCancelled;
  return motion.cancelJob(jobId);
}

async function deleteJob(userDataPath, jobId) {
  const record = await store.getJob(userDataPath, jobId);
  if (record?.pluginId === "godot") return godot.deleteJob(userDataPath, jobId);
  if (record?.pluginId === "motion") return motion.deleteJob(userDataPath, jobId);
  return blender.deleteJob(userDataPath, jobId);
}

async function copyArtifacts(userDataPath, jobId, targetDir) {
  const record = await store.getJob(userDataPath, jobId);
  if (!record) throw new Error("Задача не найдена.");
  const plugin = await store.getPlugin(userDataPath, record.pluginId || "blender");
  const root = String(targetDir || "").trim() || store.resolveOutputDir(userDataPath, plugin?.config);
  const folder = path.join(root, record.id);
  await fs.promises.mkdir(folder, { recursive: true });
  const copied = [];
  const files = [
    ...record.exports.map((item) => item.path),
    ...record.renders.map((item) => item.path),
    ...(record.bakes || []).map((item) => item.path),
    ...(record.blendPath ? [record.blendPath] : []),
    ...(record.scenePath ? [record.scenePath] : []),
    ...(record.exportPath ? [record.exportPath] : []),
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
  configForGodot,
  configForMotion,
  jobs,
  job,
  cancel,
  deleteJob,
  copyArtifacts,
  describeStatus,
};
