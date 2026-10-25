/**
 * Inline composer autocomplete ("ghost text") backend.
 *
 * Contract:
 *  - Renderer sends the WHOLE composer draft + caret offset.
 *  - Host resolves the configured suggestion model (Settings → AI runtime).
 *  - The model returns ONLY the continuation; it is cleaned and length-capped here.
 *  - Nothing is persisted: this is a read-only side channel next to normal chat.
 *
 * The handler must never throw into the renderer for ordinary conditions
 * (disabled feature, missing key, provider error) — it returns { ok:false, error }.
 */
const crypto = require("crypto");
const { getAdapter } = require("./adapters/index.cjs");

const MAX_DRAFT_CHARS = 4000;
const MAX_HINT_CHARS = 220;
const STREAM_ABORT_CHARS = 700;
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 120;

const SYSTEM_PROMPT = [
  "You are the inline autocomplete inside a chat composer where a developer writes a task prompt for a coding agent.",
  "The user message contains the complete draft with a <|caret|> marker showing where the cursor is.",
  "Continue the draft from the marker with what the user would most likely type next.",
  "Rules:",
  "- Output ONLY the continuation text — no preamble, no quotes, no markdown fences, no explanation, no list markers added unless the draft already uses them.",
  "- Never start with a space or a newline.",
  "- Keep it short: at most 16 words, on ONE single line. Never insert a line break or a trailing newline.",
  "- Match the language of the draft exactly (Russian draft → Russian continuation).",
  "- Never repeat or paraphrase text that is already present in the draft.",
  "- Never offer help, never ask questions, never mention that you are an AI.",
  "- If no sensible continuation exists, output nothing at all.",
].join("\n");

const cache = new Map();

function hashKey(value) {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function cacheSet(key, text) {
  cache.set(key, { text, at: Date.now() });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

function trimToChars(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

/** Strip fenced blocks, wrapping quotes and stray role prefixes some models add. */
function cleanContinuation(raw) {
  let text = String(raw ?? "");
  if (!text) return "";
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/^```[a-zA-Z0-9_-]*\s*?\n?/, "").replace(/\n?```\s*$/, "");
  text = text.replace(/^\s*(?:continuation|completion|next)\s*:\s*/i, "");
  text = text.replace(/^["'`«]+/, "").replace(/["'`»]+$/, "");
  text = text.replace(/^\s+/, "").replace(/[ \t]+$/, "");
  // The ghost is drawn on a single line inside the composer — flatten breaks.
  text = text.replace(/\s*\n+\s*/g, " ");
  if (text.length > MAX_HINT_CHARS) {
    const cut = text.slice(0, MAX_HINT_CHARS);
    const boundary = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
    text = (boundary > MAX_HINT_CHARS * 0.6 ? cut.slice(0, boundary) : cut).trimEnd();
  }
  return text;
}

/**
 * Models occasionally echo the tail of the draft before continuing.
 * Drop the longest exact overlap (>= 8 chars) so Tab never duplicates words.
 */
function dropDraftEcho(hint, beforeCaret) {
  if (!hint) return "";
  const tail = String(beforeCaret || "").slice(-160);
  const max = Math.min(tail.length, hint.length);
  for (let size = max; size >= 8; size -= 1) {
    if (tail.slice(-size) === hint.slice(0, size)) return hint.slice(size).trimStart();
  }
  return hint;
}

/** The renderer inserts the hint verbatim — keep word spacing natural here. */
function normalizeSpacing(hint, beforeCaret, afterCaret) {
  let text = hint;
  if (!text) return "";
  const before = String(beforeCaret || "");
  const after = String(afterCaret || "");
  const prevChar = before.slice(-1);
  const nextChar = text.slice(0, 1);
  if (prevChar && !/\s/.test(prevChar) && !/^[\s.,;:!?)\]}»…]/.test(nextChar)) {
    text = ` ${text}`;
  }
  const lastChar = text.slice(-1);
  const nextDraftChar = after.slice(0, 1);
  if (lastChar && nextDraftChar && !/\s/.test(lastChar) && !/^[\s.,;:!?)\]}»…]/.test(nextDraftChar)) {
    text = `${text} `;
  }
  return text;
}

function resolveModel(config, preferredModelId) {
  const models = Array.isArray(config?.models) ? config.models : [];
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const wanted = [
    preferredModelId,
    config?.aiRuntime?.inlineHintModelId,
    config?.selectedModelId,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  let model = null;
  for (const id of wanted) {
    model =
      models.find((item) => String(item?.id || "").toLowerCase() === id) ||
      models.find((item) => String(item?.name || "").toLowerCase() === id) ||
      null;
    if (model) break;
  }
  if (!model) model = models[0] || null;
  const provider = model
    ? providers.find((item) => item?.id === model.providerId) || providers[0] || null
    : null;
  return { model, provider };
}

function readSettings(config) {
  const modelId = String(config?.aiRuntime?.inlineHintModelId || "").trim();
  return {
    enabled: config?.aiRuntime?.inlineHintEnabled === true,
    modelId,
  };
}

function buildMessages({ beforeCaret, afterCaret, projectName }) {
  const draft = `${beforeCaret}<|caret|>${afterCaret}`;
  const context = projectName ? `Project: ${projectName}\n\n` : "";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${context}Draft:\n"""\n${draft}\n"""\n\nWrite only the text that belongs at <|caret|>.`,
    },
  ];
}

/**
 * Ask the configured model for a ghost continuation.
 * @returns {Promise<{ok:boolean, text?:string, model?:string, error?:string}>}
 */
async function requestInlineHint({ config, request = {} }) {
  const settings = readSettings(config);
  if (!settings.enabled) return { ok: false, error: "Inline autocomplete is disabled in Settings" };

  const rawText = String(request.text ?? "");
  if (!rawText.trim()) return { ok: false, error: "Empty draft" };

  const caretRaw = Number(request.caret);
  const caret = Number.isFinite(caretRaw)
    ? Math.max(0, Math.min(Math.trunc(caretRaw), rawText.length))
    : rawText.length;

  const beforeFull = rawText.slice(0, caret);
  const afterFull = rawText.slice(caret);
  const beforeCaret = trimToChars(beforeFull, MAX_DRAFT_CHARS);
  const afterCaret = afterFull.slice(0, 600);

  const { model, provider } = resolveModel(config, request.modelId);
  if (!model) return { ok: false, error: "No model configured for inline autocomplete" };
  if (!provider) return { ok: false, error: "Provider for the autocomplete model is missing" };
  if (!provider.apiKey) return { ok: false, error: `API key is empty for ${provider.name || provider.id}` };

  const cacheKey = hashKey(
    [String(model.id || model.name || ""), caret, beforeCaret, afterCaret].join("\u0000")
  );
  const cached = cacheGet(cacheKey);
  if (cached != null) return { ok: true, text: cached, model: String(model.name || model.id || ""), cached: true };

  const adapter = getAdapter(provider.type || "openai");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let accumulated = "";
  let abortedForLength = false;
  try {
    await adapter.execute({
      provider,
      model,
      messages: buildMessages({
        beforeCaret,
        afterCaret,
        projectName: typeof request.projectName === "string" ? request.projectName.slice(0, 80) : "",
      }),
      tools: [],
      signal: controller.signal,
      onDelta: ({ text }) => {
        if (!text) return;
        accumulated += text;
        if (accumulated.length >= STREAM_ABORT_CHARS) {
          abortedForLength = true;
          controller.abort();
        }
      },
    });
  } catch (error) {
    const name = error?.name || "";
    if (!(abortedForLength || name === "AbortError" || name === "TimeoutError") || !accumulated.trim()) {
      return {
        ok: false,
        error:
          name === "AbortError"
            ? "Autocomplete request timed out"
            : error?.message || "Autocomplete request failed",
      };
    }
  } finally {
    clearTimeout(timeout);
  }

  const cleaned = normalizeSpacing(
    dropDraftEcho(cleanContinuation(accumulated), beforeCaret),
    beforeCaret,
    afterCaret
  );
  if (!cleaned.trim()) return { ok: false, error: "No suggestion" };

  cacheSet(cacheKey, cleaned);
  return { ok: true, text: cleaned, model: String(model.name || model.id || "") };
}

module.exports = {
  readSettings,
  resolveModel,
  buildMessages,
  cleanContinuation,
  dropDraftEcho,
  normalizeSpacing,
  requestInlineHint,
};
