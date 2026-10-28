const { createVisionTool } = require("./visionTool.cjs");
const godot = require("../plugins/godot/index.cjs");

const GODOT_REVIEW_PROMPT =
  "Посмотри на кадр из игры Godot как игровой арт-директор и QA. Опиши, что видно; затем перечисли конкретные проблемы " +
  "и как исправить: читаемость силуэта, освещение и контраст, материалы и текстуры (albedo/normal/roughness), " +
  "масштаб объектов относительно персонажа, композиция кадра, UI/HUD, артефакты z-fighting/швов/normal-карт, " +
  "соответствие целевому стилю. Если это не игровой кадр, а редактор Godot — оцени сцену, ноды, свет, импорт GLB и материал. " +
  "Дай конкретные шаги в Godot (нода/свойство/значение), без общих слов.";

module.exports = createVisionTool({
  name: "vision_godot",
  description:
    "Art-director / QA review of Godot results using the dedicated vision model (Settings → Vision). " +
    "Use it after a Godot build or import to actually SEE the result: pass job=<godot job id> (or path to a screenshot/PNG) and it critiques the frame as a game art director — " +
    "silhouette readability, lighting/contrast, materials (albedo/normal/roughness), scale, composition, HUD, z-fighting/seam artifacts, target style — then lists concrete Godot steps. " +
    "Actions: see (default review), ask (custom question), compare (before/after), ocr, attach (return the image to the current chat model), models/status. " +
    "Image sources: job=<godot job id> (PNG inside the job folder; optional image=<file name>), path=/abs/frame.png, url=https://…, data_url=data:image/…, images=[…]. " +
    "A Godot headless job has no render, so pass a real screenshot with path= when the job folder has no PNG. " +
    "Use the general `vision` tool for ordinary photos, screenshots and OCR — this one always applies the game art-direction prompt.",
  jobPreview: godot.readPreviewDataUrl,
  jobLabel: "godot job id",
  defaultPrompt: GODOT_REVIEW_PROMPT,
});
