/**
 * Multimodal content helpers for agent adapters + proxy converters.
 * OpenAI hub shape: content = string | Array<{type:"text"|"image_url", ...}>
 * Internal agent messages may also carry message.images[] (data URLs).
 */

function isDataImageUrl(url) {
  return typeof url === "string" && /^data:image\//i.test(url);
}

function parseDataUrl(url) {
  const raw = String(url || "");
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!m) return null;
  return {
    mimeType: m[1].toLowerCase(),
    mediaType: m[1].toLowerCase(),
    data: m[2],
    format: (m[1].split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg") === "jpg"
      ? "jpeg"
      : (m[1].split("/")[1] || "png").toLowerCase(),
  };
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
          return String(part.text || "");
        }
        if (part.text) return String(part.text);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object" && content.text) return String(content.text);
  return String(content);
}

/**
 * Collect image data-URLs / http(s) urls from OpenAI content parts and/or message.images.
 * @returns {Array<{ url: string, mimeType?: string, name?: string }>}
 */
function collectImages(messageOrContent, extraImages) {
  const out = [];
  const seen = new Set();

  const push = (url, mimeType, name) => {
    const u = String(url || "").trim();
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push({
      url: u,
      mimeType: mimeType || parseDataUrl(u)?.mimeType || undefined,
      name: name || undefined,
    });
  };

  const walk = (content) => {
    if (!content) return;
    // Plain message/tool text may legitimately contain Markdown image syntax copied
    // from a fetched web page. It is text, not an attachment. Promoting those URLs
    // to image_url parts breaks strict OpenAI-compatible text endpoints on the next
    // turn ("unknown variant image_url, expected text"). Only explicit structured
    // image parts or message.images[] are treated as actual attachments.
    if (typeof content === "string") return;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "image_url") {
        const url = part.image_url?.url || part.url || "";
        push(url, part.image_url?.mime_type || part.mimeType);
      } else if (part.type === "image" || part.type === "input_image") {
        const url = part.image_url || part.url || part.source?.url || "";
        if (url) push(url, part.mimeType || part.media_type || part.source?.media_type);
        else if (part.source?.data || part.data) {
          const mime = part.source?.media_type || part.mimeType || part.media_type || "image/png";
          const data = part.source?.data || part.data;
          push(`data:${mime};base64,${data}`, mime);
        }
      } else if (part.inlineData || part.inline_data) {
        const inline = part.inlineData || part.inline_data;
        const mime = inline.mimeType || inline.mime_type || "image/png";
        if (inline.data) push(`data:${mime};base64,${inline.data}`, mime);
      }
    }
  };

  if (messageOrContent && typeof messageOrContent === "object" && !Array.isArray(messageOrContent)) {
    walk(messageOrContent.content);
    const imgs = messageOrContent.images;
    if (Array.isArray(imgs)) {
      for (const img of imgs) {
        if (!img) continue;
        if (typeof img === "string") push(img);
        else push(img.url || img.dataUrl || img.src, img.mimeType || img.mediaType, img.name || img.filename);
      }
    }
  } else {
    walk(messageOrContent);
  }

  if (Array.isArray(extraImages)) {
    for (const img of extraImages) {
      if (!img) continue;
      if (typeof img === "string") push(img);
      else push(img.url || img.dataUrl || img.src, img.mimeType || img.mediaType, img.name || img.filename);
    }
  }

  return out;
}

function imagesToFallbackText(images, opts = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return "";
  const maxDataChars = Number(opts.maxDataChars) > 0 ? Number(opts.maxDataChars) : 120_000;
  const lines = list.map((img, i) => {
    const name = img.name || img.filename || `image-${i + 1}`;
    const mime = img.mimeType || parseDataUrl(img.url || img.dataUrl || "")?.mimeType || "image/*";
    const url = String(img.url || img.dataUrl || img.src || "");
    if (!url) return `[Image: ${name} (${mime})]`;
    // Prefer full data URL so non-vision models still receive bytes as text (request won't crash).
    if (url.length <= maxDataChars) {
      return `[Image attachment: ${name} (${mime})]\n${url}`;
    }
    return `[Image attachment: ${name} (${mime}, ${url.length} chars — truncated)]\n${url.slice(0, maxDataChars)}…`;
  });
  return lines.join("\n\n");
}

/**
 * Heuristic: does this model/provider path accept vision / image parts?
 * Conservative false → flatten images into text so the request never fails.
 */
function modelSupportsImages(modelName, providerType) {
  const m = String(modelName || "").toLowerCase();
  const p = String(providerType || "").toLowerCase();
  if (!m && !p) return true; // unknown: try multimodal (OpenAI-compatible default)
  // Explicit non-vision / tiny models
  if (
    /\b(text-embedding|embed|tts|whisper|moderation|dall-e|davinci|curie|babbage|ada)\b/.test(m) ||
    // DeepSeek chat/reasoner are text-only, but deepseek-flash / V4 / VL accept
    // OpenAI image_url parts (base64, URL or Files API) — keep those vision-capable.
    (m.includes("deepseek") && !/v4|vl|vision|omni|multimodal|flash/i.test(m)) ||
    /\b(llama\b(?!-vision|-vl))/i.test(m) ||
    m.includes("mixtral") ||
    m.includes("mistral") ||
    m.includes("command-r") ||
    m.includes("command-r7") ||
    m.includes("aya") ||
    m.includes("granite") ||
    m.includes("phi-") ||
    m.includes("nemotron") ||
    m.includes("dbrx") ||
    m.includes("yi-") ||
    m.includes("falcon") ||
    m.includes("solar") ||
    m.includes("gemma")
  ) {
    return false;
  }
  // Known vision-capable families
  if (
    m.includes("vision") ||
    m.includes("gpt-4o") ||
    m.includes("gpt-4.1") ||
    m.includes("gpt-4-turbo") ||
    m.includes("gpt-5") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("claude") ||
    m.includes("gemini") ||
    m.includes("grok") ||
    m.includes("sonar") ||
    m.includes("pixtral") ||
    m.includes("llava") ||
    m.includes("qwen-vl") ||
    m.includes("qwen2-vl") ||
    m.includes("qwen2.5-vl") ||
    m.includes("flash") ||
    m.includes("pro") ||
    m.includes("sonnet") ||
    m.includes("opus") ||
    m.includes("haiku") ||
    m.includes("codex")
  ) {
    return true;
  }
  // Provider formats that usually accept OpenAI image_url
  if (p === "openai" || p === "openai-compat" || p === "anthropic" || p === "gemini") {
    return true;
  }
  // Generic gateway providers (OrcaRouter, a6api, etc.) — model name already checked
  // above; if no match, assume no vision to avoid 400 errors on non-vision models.
  if (p === "orcarouter" || p === "a6api" || p === "orca" || p === "a6") {
    return false;
  }
  // Default: try multimodal — proxy converters also flatten when wire format can't carry images
  return true;
}

/**
 * Build OpenAI chat message content from internal agent message.
 * @returns {string | Array}
 */
function toOpenAIMessageContent(message, { supportImages = true } = {}) {
  const text = contentToText(message?.content);
  const images = collectImages(message);

  if (!images.length) {
    return text || (message?.content != null && typeof message.content !== "string" ? message.content : text);
  }

  if (!supportImages) {
    const fallback = imagesToFallbackText(images);
    return [text, fallback].filter(Boolean).join("\n\n");
  }

  const parts = [];
  if (text && String(text).trim()) {
    parts.push({ type: "text", text: String(text) });
  }
  for (const img of images) {
    parts.push({
      type: "image_url",
      image_url: { url: img.url },
    });
  }
  // OpenAI requires at least one part
  if (!parts.length) parts.push({ type: "text", text: "" });
  return parts;
}

/**
 * Convert OpenAI-style content (string | parts) → Anthropic content blocks.
 * Unsupported / non-image providers should pass supportImages=false.
 */
function openAIContentToAnthropicBlocks(content, { supportImages = true } = {}) {
  if (content == null) return [{ type: "text", text: "" }];
  if (typeof content === "string") return [{ type: "text", text: content }];

  if (!Array.isArray(content)) {
    return [{ type: "text", text: contentToText(content) }];
  }

  const blocks = [];
  const fallbackImages = [];

  for (const part of content) {
    if (typeof part === "string") {
      if (part) blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" || part.type === "input_text") {
      const t = String(part.text || "");
      if (t) blocks.push({ type: "text", text: t });
      continue;
    }

    if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      const url = part.image_url?.url || part.image_url || part.url || "";
      if (!supportImages) {
        fallbackImages.push({ url });
        continue;
      }
      const parsed = parseDataUrl(url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mimeType,
            data: parsed.data,
          },
        });
      } else if (/^https?:\/\//i.test(url)) {
        blocks.push({
          type: "image",
          source: {
            type: "url",
            url,
          },
        });
      } else if (url) {
        fallbackImages.push({ url });
      }
      continue;
    }

    if (part.text) blocks.push({ type: "text", text: String(part.text) });
  }

  if (fallbackImages.length) {
    const fb = imagesToFallbackText(fallbackImages);
    if (fb) blocks.push({ type: "text", text: fb });
  }

  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return blocks;
}

/**
 * Convert OpenAI-style content → Gemini parts[].
 */
function openAIContentToGeminiParts(content, { supportImages = true } = {}) {
  if (content == null) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];

  if (!Array.isArray(content)) {
    return [{ text: contentToText(content) }];
  }

  const parts = [];
  const fallbackImages = [];

  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" || part.type === "input_text") {
      const t = String(part.text || "");
      if (t) parts.push({ text: t });
      continue;
    }

    if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      const url = part.image_url?.url || part.image_url || part.url || "";
      if (!supportImages) {
        fallbackImages.push({ url });
        continue;
      }
      const parsed = parseDataUrl(url);
      if (parsed) {
        parts.push({
          inlineData: {
            mimeType: parsed.mimeType,
            data: parsed.data,
          },
        });
      } else if (/^https?:\/\//i.test(url)) {
        parts.push({
          fileData: {
            mimeType: "image/jpeg",
            fileUri: url,
          },
        });
      } else if (url) {
        fallbackImages.push({ url });
      }
      continue;
    }

    if (part.text) parts.push({ text: String(part.text) });
  }

  if (fallbackImages.length) {
    const fb = imagesToFallbackText(fallbackImages);
    if (fb) parts.push({ text: fb });
  }

  if (!parts.length) parts.push({ text: "" });
  return parts;
}

/**
 * Convert OpenAI content → Responses API user content parts.
 */
function openAIContentToResponsesParts(content, { supportImages = true } = {}) {
  if (content == null) return [{ type: "input_text", text: "" }];
  if (typeof content === "string") return [{ type: "input_text", text: content }];

  if (!Array.isArray(content)) {
    return [{ type: "input_text", text: contentToText(content) }];
  }

  const parts = [];
  const fallbackImages = [];

  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push({ type: "input_text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" || part.type === "input_text") {
      const t = String(part.text || "");
      if (t) parts.push({ type: "input_text", text: t });
      continue;
    }

    if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      const url = part.image_url?.url || part.image_url || part.url || "";
      if (!supportImages) {
        fallbackImages.push({ url });
        continue;
      }
      if (url) {
        parts.push({
          type: "input_image",
          image_url: url,
          detail: part.image_url?.detail || part.detail || "auto",
        });
      }
      continue;
    }

    if (part.text) parts.push({ type: "input_text", text: String(part.text) });
  }

  if (fallbackImages.length) {
    const fb = imagesToFallbackText(fallbackImages);
    if (fb) parts.push({ type: "input_text", text: fb });
  }

  if (!parts.length) parts.push({ type: "input_text", text: "" });
  return parts;
}

/**
 * If content has image parts but supportImages is false, flatten to pure text string.
 * If supportImages is true, leave multimodal content as-is (normalize to OpenAI parts).
 */
function normalizeContentForWire(content, { supportImages = true } = {}) {
  const images = collectImages(content);
  const text = contentToText(content);

  if (!images.length) {
    return typeof content === "string" || content == null ? text : content;
  }

  if (!supportImages) {
    return [text, imagesToFallbackText(images)].filter(Boolean).join("\n\n");
  }

  // Normalize to OpenAI multimodal array
  if (Array.isArray(content)) {
    // Already parts — ensure image_url shape
    return content
      .map((part) => {
        if (typeof part === "string") return { type: "text", text: part };
        if (!part || typeof part !== "object") return null;
        if (part.type === "text" || part.type === "input_text") {
          return { type: "text", text: String(part.text || "") };
        }
        if (part.type === "image_url") {
          const url = part.image_url?.url || part.url || "";
          return url ? { type: "image_url", image_url: { url } } : null;
        }
        if (part.type === "image" || part.type === "input_image") {
          const url = part.image_url || part.url || "";
          if (url) return { type: "image_url", image_url: { url } };
          const parsed =
            part.source?.data
              ? {
                  mimeType: part.source.media_type || "image/png",
                  data: part.source.data,
                }
              : null;
          if (parsed) {
            return {
              type: "image_url",
              image_url: { url: `data:${parsed.mimeType};base64,${parsed.data}` },
            };
          }
        }
        if (part.text) return { type: "text", text: String(part.text) };
        return null;
      })
      .filter(Boolean);
  }

  const parts = [];
  if (text && String(text).trim()) parts.push({ type: "text", text: String(text) });
  for (const img of images) {
    parts.push({ type: "image_url", image_url: { url: img.url } });
  }
  return parts.length ? parts : text;
}

/**
 * Extract assistant-visible image URLs from provider response content (for UI).
 */
function extractAssistantImages(content) {
  return collectImages(content).map((img, i) => ({
    id: `asst-img-${i}-${Date.now().toString(36)}`,
    url: img.url,
    dataUrl: img.url,
    mimeType: img.mimeType || parseDataUrl(img.url)?.mimeType || "image/*",
    name: img.name || `image-${i + 1}`,
  }));
}

module.exports = {
  isDataImageUrl,
  parseDataUrl,
  contentToText,
  collectImages,
  imagesToFallbackText,
  modelSupportsImages,
  toOpenAIMessageContent,
  openAIContentToAnthropicBlocks,
  openAIContentToGeminiParts,
  openAIContentToResponsesParts,
  normalizeContentForWire,
  extractAssistantImages,
};
