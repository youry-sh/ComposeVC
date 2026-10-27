const path = require("path");

const blender = require("../plugins/blender/index.cjs");
const visionBridge = require("../vision/index.cjs");
const imageTools = require("../vision/image.cjs");

const ACTIONS = ["see", "ask", "ocr", "compare", "attach", "models", "status"];

function truth(ok, text, payload = {}) {
  return { bit: ok ? 1 : 0, ok: Boolean(ok), text, ...payload };
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function resolveUserData(context) {
  const value = context?.userDataPath;
  if (!value) throw new Error("Vision tool requires Electron userDataPath");
  return value;
}

const GENERAL_PROMPT =
  "Посмотри на изображение и опиши, что на нём видно. Ответь на вопрос пользователя по содержимому: " +
  "объекты, люди, текст, интерфейс, детали. Если чего-то не видно — так и скажи, не выдумывай.";

async function imageFromInput(input, userDataPath, prefix = "") {
  const dataUrl = pick(input, `${prefix}data_url`, `${prefix}dataUrl`);
  if (dataUrl) {
    return { url: String(dataUrl), mimeType: String(dataUrl).slice(5).split(";")[0] || "image/png", name: "inline" };
  }
  const directUrl = pick(input, `${prefix}url`);
  if (directUrl) {
    const value = String(directUrl);
    if (/^data:image\//i.test(value) || /^https?:\/\//i.test(value)) {
      return { url: value, mimeType: /^data:image\//i.test(value) ? value.slice(5).split(";")[0] : undefined, name: "url" };
    }
    // A plain path passed in url= is treated as a local file.
    const loaded = await imageTools.fileToDataUrl(value, { maxSize: input.max_size });
    return { url: loaded.dataUrl, mimeType: loaded.mimeType, name: path.basename(value), width: loaded.width, height: loaded.height };
  }
  const filePath = pick(input, `${prefix}path`, `${prefix}file`, `${prefix}image_path`);
  if (filePath) {
    const loaded = await imageTools.fileToDataUrl(String(filePath), { maxSize: input.max_size });
    return {
      url: loaded.dataUrl,
      mimeType: loaded.mimeType,
      name: path.basename(String(filePath)),
      width: loaded.width,
      height: loaded.height,
      bytes: loaded.bytes,
    };
  }
  const jobId = pick(input, `${prefix}job`, `${prefix}job_id`);
  if (jobId) {
    const preview = await blender.readPreviewDataUrl(userDataPath, String(jobId), pick(input, `${prefix}image`, "image_name") || "");
    return {
      url: preview.dataUrl,
      mimeType: "image/png",
      name: path.basename(preview.path || "render.png"),
      bytes: preview.bytes,
      path: preview.path,
    };
  }
  return null;
}

async function resolveImages(input, userDataPath) {
  const images = [];
  const list = Array.isArray(input.images) ? input.images : Array.isArray(input.paths) ? input.paths : null;
  if (list) {
    for (const entry of list.slice(0, 6)) {
      if (typeof entry === "string") {
        if (/^data:image\//i.test(entry) || /^https?:\/\//i.test(entry)) {
          images.push({ url: entry, mimeType: /^data:image\//i.test(entry) ? entry.slice(5).split(";")[0] : undefined, name: "image" });
        } else {
          const loaded = await imageTools.fileToDataUrl(entry, { maxSize: input.max_size });
          images.push({ url: loaded.dataUrl, mimeType: loaded.mimeType, name: path.basename(entry) });
        }
      } else if (entry && typeof entry === "object") {
        const image = await imageFromInput(entry, userDataPath, "");
        if (image) images.push(image);
      }
    }
  }
  if (!images.length) {
    const first = await imageFromInput(input, userDataPath, "");
    if (first) images.push(first);
    const second = await imageFromInput(input, userDataPath, "image2_");
    if (second) images.push(second);
    if (!second && input.path2) {
      const loaded = await imageTools.fileToDataUrl(String(input.path2), { maxSize: input.max_size });
      images.push({
        url: loaded.dataUrl,
        mimeType: loaded.mimeType,
        name: path.basename(String(input.path2)),
        width: loaded.width,
        height: loaded.height,
      });
    }
    if (images.length === 1 && input.image2_url) {
      const value = String(input.image2_url);
      images.push({
        url: value,
        mimeType: /^data:image\//i.test(value) ? value.slice(5).split(";")[0] : undefined,
        name: "image-2",
      });
    }
  }
  return images;
}

function summarizeImages(images) {
  return images.map((image, index) => ({
    index: index + 1,
    name: image.name || `image-${index + 1}`,
    mimeType: image.mimeType || "image/*",
    bytes: image.bytes || undefined,
    width: image.width || undefined,
    height: image.height || undefined,
  }));
}

function attachPayload(images) {
  if (!images.length) return {};
  return {
    __images: images.map((image, index) => ({
      url: image.url,
      mimeType: image.mimeType,
      name: image.name || `image-${index + 1}`,
    })),
  };
}

async function run(action, input, context, options = {}) {
  const userDataPath = resolveUserData(context);

  if (action === "models" || action === "status") {
    const listed = await visionBridge.requestVision({ kind: "models" });
    const rows = (listed.models || []).map(
      (model) => `${model.supportsImages ? "vision" : "text "} ${model.name || model.id}${model.id && model.id !== model.name ? ` · id ${model.id}` : ""}`
    );
    const selected = listed.visionModelId
      ? listed.models?.find((model) => model.id === listed.visionModelId || model.name === listed.visionModelId)
      : null;
    const text = [
      `vision-модель: ${selected ? selected.name || selected.id : "не задана (используется модель текущего чата / fallback)"}`,
      `модель чата: ${listed.selectedModelId || "—"}`,
      rows.length ? rows.join("\n") : "Модели не настроены.",
    ].join("\n\n");
    return truth(true, text, {
      visionModelId: listed.visionModelId || "",
      selectedModelId: listed.selectedModelId || "",
      models: listed.models || [],
    });
  }

  const images = await resolveImages(input, userDataPath);
  if (!images.length) {
    throw new Error(
      "vision: нужен источник изображения — path=/abs/file.png, job=<blender jobId>, url=https://…, data_url=data:image/… или images=[…]."
    );
  }

  if (action === "attach") {
    return truth(
      true,
      `Изображение приложено к результату инструмента (${images.length}).`,
      { images: summarizeImages(images), ...attachPayload(images) }
    );
  }

  const question = String(
    pick(input, "prompt", "question", "text", "q") ||
      (action === "ocr"
        ? "Извлеки весь видимый текст с изображения дословно, сохраняя порядок строк. Если текста нет — скажи об этом."
        : action === "compare"
          ? "Сравни эти изображения как арт-директор: что изменилось, что стало лучше/хуже, какие конкретные правки нужны. Будь краток и конкретен."
          : options.defaultPrompt || GENERAL_PROMPT)
  ).trim();

  const result = await visionBridge.requestVision({
    kind: "complete",
    modelId: pick(input, "model", "vision_model"),
    fallbackModelId: context?.modelId || null,
    messages: [
      {
        role: "user",
        content: question,
        images: images.map((image) => ({ url: image.url, mimeType: image.mimeType, name: image.name })),
      },
    ],
  });

  const answer = String(result.text || "").trim();
  const text = answer || "Vision-модель не вернула текст.";
  const payload = {
    model: result.model || "",
    usage: result.usage || null,
    images: summarizeImages(images),
    ...(input.attach === false ? {} : attachPayload(images)),
  };
  return truth(Boolean(answer), text, payload);
}

function createVisionTool(config = {}) {
  return {
  name: config.name || "vision",
  description:
    config.description ||
    "Look at real images and answer questions about them using a dedicated vision model (configurable in Settings → Vision). " +
    "Use it for user screenshots, photos, charts, UI states and any picture the agent must actually see — the agent otherwise only sees text. " +
    "Actions: see (describe the image and answer), ask (custom prompt/question), ocr (extract visible text), compare (two or more images), " +
    "attach (return the image to the current model without calling a vision model), models/status (list configured models and the selected vision model). " +
    "Image sources: path=/abs/file.png|jpg|webp, job=<blender job id> (uses the job preview; optional image=<file name>), url=https://…, " +
    "data_url=data:image/..., or images=[{path|url|data_url}, …]. Images are downscaled before sending; attach=false skips returning them to the chat model. " +
    "DeepSeek flash/v4 models accept images (PNG/JPEG/WebP/GIF) through the same OpenAI-compatible proxy; text-only models receive a readable attachment note instead.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: ACTIONS.join(" | ") },
      path: { type: "string", description: "Absolute path to a local image" },
      job: { type: "string", description: "Blender job id whose render should be inspected" },
      image: { type: "string", description: "Optional render file name inside the job" },
      url: { type: "string", description: "http(s) image URL (public) or data:image/… URL" },
      data_url: { type: "string", description: "Inline data:image/...;base64,... image" },
      images: { type: "array", description: "Multiple images: strings (path/url/data URL) or objects with path/url/data_url" },
      path2: { type: "string", description: "Second local image for compare" },
      image2_url: { type: "string", description: "Second URL/data URL for compare" },
      image2_job: { type: "string", description: "Second Blender job id for compare" },
      prompt: { type: "string", description: "Question / instruction for the vision model" },
      question: { type: "string", description: "Alias of prompt" },
      model: { type: "string", description: "Override vision model id/name (default: Settings → Vision)" },
      attach: { type: "boolean", description: "Return the inspected image(s) to the current model (default true)" },
      max_size: { type: "number", description: "Max image side in px after downscale (default 1280)" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    let action = String(pick(input, "action") || "see").trim().toLowerCase();
    const aliases = {
      describe: "see",
      look: "see",
      review: "see",
      read: "ocr",
      text: "ocr",
      compare_images: "compare",
      diff: "compare",
      show: "attach",
      preview: "attach",
      image: "attach",
      list: "models",
      config: "status",
    };
    if (aliases[action]) action = aliases[action];
    if (!ACTIONS.includes(action)) throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
    return run(action, input, context, { defaultPrompt: config.defaultPrompt });
  },
  };
}

const visionTool = createVisionTool({ name: "vision" });
module.exports = visionTool;
module.exports.createVisionTool = createVisionTool;
module.exports.GENERAL_PROMPT = GENERAL_PROMPT;
