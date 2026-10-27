const { createVisionTool } = require("./visionTool.cjs");

const BLENDER_REVIEW_PROMPT =
  "Ты senior 3D art director и QA-художник. Посмотри на изображение как человек-художник. " +
  "Опиши, что видно, затем перечисли конкретные проблемы и как их исправить: силуэт, анатомия, " +
  "волосы/лицо, материалы и текстуры, свет, композиция, артефакты, масштаб. Будь конкретным и кратким.";

module.exports = createVisionTool({
  name: "vision_blender",
  description:
    "Art-director review of Blender results using the dedicated vision model (Settings → Vision). " +
    "Use it after a Blender job to actually SEE the render: pass job=<job id> (or path to a PNG) and it will critique the image as a senior 3D art director — " +
    "silhouette, face/hair, anatomy, materials/textures, lighting, composition, artifacts, scale — then list concrete fixes. " +
    "Actions: see (default art-director review), ask (custom question, e.g. 'why does the metal look flat?'), compare (before/after iterations), " +
    "ocr (read text baked into a texture), attach (return the render to the current chat model without a second model call), models/status. " +
    "Image sources: job=<blender job id> (optional image=<render file>), path=/abs/render.png, url=https://…, data_url=data:image/…, images=[…]. " +
    "Use the general `vision` tool for ordinary photos, screenshots and OCR — this one always applies the 3D art-direction prompt.",
  defaultPrompt: BLENDER_REVIEW_PROMPT,
});
