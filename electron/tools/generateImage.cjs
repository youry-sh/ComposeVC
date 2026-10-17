const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const MODEL = "@cf/black-forest-labs/flux-2-dev";

function readCloudflare(context) {
  const userData = context?.userDataPath;
  if (!userData) throw new Error("Cloudflare image settings need the app user-data folder.");
  const raw = JSON.parse(fs.readFileSync(path.join(userData, "providers_config.json"), "utf8"));
  const runtime = raw?.aiRuntime || {};
  const accountId = String(runtime.cloudflareAccountId || "").trim();
  const apiToken = String(runtime.cloudflareApiToken || "").trim();
  if (!accountId || !apiToken) {
    throw new Error("Set the Cloudflare account id and API token in Settings, then run generate_image again.");
  }
  return { accountId, apiToken };
}

function slug(text) {
  const clean = String(text || "sprite")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return clean || "sprite";
}

function resolveOut(input, context) {
  const root = context?.rootPath ? path.resolve(context.rootPath) : null;
  const raw = typeof input.path === "string" ? input.path.trim() : "";
  const filePath = raw
    ? path.resolve(root && !path.isAbsolute(raw) ? path.join(root, raw) : raw)
    : path.join(root || process.cwd(), "art", `${slug(input.prompt)}-${Date.now().toString(36)}.png`);
  if (!filePath.toLowerCase().endsWith(".png")) {
    throw new Error("generate_image writes a .png");
  }
  if (root) {
    const rel = path.relative(root, filePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("generate_image path is outside the project");
  }
  return filePath;
}

/** Drop chroma green everywhere, including pockets trapped behind hair. */
function keyGreen(rgba, width, height) {
  const n = width * height;
  const drop = new Uint8Array(n);
  const sample = (p) => {
    const i = p * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2]];
  };
  const chroma = (p) => {
    const [r, g, b] = sample(p);
    return g >= 60 && g >= r + 22 && g >= b + 22;
  };
  for (let p = 0; p < n; p += 1) {
    if (chroma(p)) drop[p] = 1;
  }
  const fringe = (p) => {
    const [r, g, b] = sample(p);
    return g >= 36 && g >= r + 12 && g >= b + 12;
  };
  for (let pass = 0; pass < 24; pass += 1) {
    const extra = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const p = y * width + x;
        if (drop[p] || !fringe(p)) continue;
        const near =
          (x > 0 && drop[p - 1]) ||
          (x + 1 < width && drop[p + 1]) ||
          (y > 0 && drop[p - width]) ||
          (y + 1 < height && drop[p + width]);
        if (near) extra.push(p);
      }
    }
    if (!extra.length) break;
    for (const p of extra) drop[p] = 1;
  }
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    if (drop[p]) {
      rgba[i + 3] = 0;
      continue;
    }
    const x = p % width;
    const y = (p - x) / width;
    const edge =
      (x > 0 && drop[p - 1]) ||
      (x + 1 < width && drop[p + 1]) ||
      (y > 0 && drop[p - width]) ||
      (y + 1 < height && drop[p + width]);
    if (!edge) continue;
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    if (g > r && g > b) rgba[i + 1] = Math.max(r, b);
  }
}

function characterFile(root, name) {
  return path.join(root, "art", "characters", `${slug(name)}.json`);
}

function loadCharacter(root, name) {
  if (!root || !name) return null;
  try {
    return JSON.parse(fs.readFileSync(characterFile(root, name), "utf8"));
  } catch {
    return null;
  }
}

async function generateImage(input, context) {
  const prompt = String(input.prompt || input.subject || "").trim();
  if (!prompt) throw new Error("generate_image requires a prompt");
  const character = slug(input.character || input.name || "");
  const root = context?.rootPath ? path.resolve(context.rootPath) : null;
  const memory = character ? loadCharacter(root, character) : null;
  const { accountId, apiToken } = readCloudflare(context);
  const width = Math.max(256, Math.min(1440, Math.round(Number(input.width) || 1024)));
  const height = Math.max(256, Math.min(1440, Math.round(Number(input.height) || 1024)));
  const lock = memory
    ? `Image 0 is the same character. Keep the identical face, hair, body, outfit, colors, and art style. Do not redesign them. New frame only: ${prompt}. Established look: ${memory.look}`
    : prompt;
  const fullPrompt =
    `${lock}\n\n` +
    "The background is one flat chroma-key green, exact color #00FF00, evenly lit, with no gradient, shadow, floor, scenery, glow, or green light. " +
    "No green anywhere on the subject, hair, clothes, or effects. The subject is fully visible and does not touch the image edges.";
  const form = new FormData();
  form.set("prompt", fullPrompt);
  form.set("width", String(width));
  form.set("height", String(height));
  if (memory?.reference && fs.existsSync(memory.reference)) {
    const ref = await sharp(memory.reference).resize(512, 512, { fit: "inside" }).png().toBuffer();
    form.set("input_image_0", new Blob([ref], { type: "image/png" }), "reference.png");
  }
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`,
    { method: "POST", headers: { Authorization: `Bearer ${apiToken}` }, body: form }
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload?.result?.image) {
    const message = payload?.errors?.[0]?.message || `Cloudflare image request failed (${response.status})`;
    throw new Error(message);
  }
  const jpeg = Buffer.from(payload.result.image, "base64");
  const decoded = await sharp(jpeg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.from(decoded.data);
  keyGreen(rgba, decoded.info.width, decoded.info.height);
  const png = await sharp(rgba, {
    raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 },
  })
    .png()
    .toBuffer();
  const filePath = resolveOut(input, context);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, png);
  let characterNote = "No character id was given, so the next frame will not stay consistent. Pass the same character name every time.";
  if (character && root) {
    const card = characterFile(root, character);
    const reference = path.join(path.dirname(card), `${slug(character)}-ref.png`);
    await fs.promises.mkdir(path.dirname(card), { recursive: true });
    await sharp(png).resize(512, 512, { fit: "inside" }).png().toFile(reference);
    const look = memory?.look || prompt;
    await fs.promises.writeFile(card, JSON.stringify({
      name: character,
      look,
      reference,
      updatedAt: Date.now(),
    }, null, 2));
    characterNote = memory
      ? `Character "${character}" kept. Pass character="${character}" on every later frame.`
      : `Character "${character}" saved. Pass character="${character}" on every later frame so the face, clothes, and style stay the same.`;
  }
  const preview = await sharp(png).resize({ width: 720, height: 720, fit: "inside" }).png().toBuffer();
  return {
    path: filePath,
    character: character || null,
    width: decoded.info.width,
    height: decoded.info.height,
    model: MODEL,
    background: "removed",
    __toolText: `Saved a transparent PNG at ${filePath}. ${characterNote} Background green was removed.`,
    __image: {
      dataUrl: `data:image/png;base64,${preview.toString("base64")}`,
      mimeType: "image/png",
      name: path.basename(filePath),
    },
  };
}

module.exports = {
  name: "generate_image",
  description:
    "Generate one finished picture with Cloudflare flux-2-dev and save a transparent PNG. " +
    "Pass a prompt for this frame and the same character name on every frame of one person. " +
    "The first call stores their look and picture. Later calls send that picture back so the face, hair, outfit, and style do not change. " +
    "The tool forces a flat green backdrop and removes the green, including the green fringe on hair. " +
    "Requires the Cloudflare account id and API token from Settings. Optional path, width, and height.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "This frame only. Do not ask for a background; it is removed." },
      character: { type: "string", description: "Stable name for this person. Reuse it on every frame so they stay the same." },
      path: { type: "string", description: "Optional PNG path inside the project" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["prompt"],
  },
  execute: generateImage,
  keyGreen,
};
