/**
 * Tool schema / name helpers for cross-provider conversion.
 *
 * safeParseJSON is shared by OpenAI→Anthropic/Gemini history replay. Models and
 * proxies often mangle tool-call arguments (unescaped Windows paths, raw newlines
 * inside strings, trailing commas). A bare JSON.parse → {} drops old_string and
 * makes edit_file fail with "not found". Prefer the robust adapter parser.
 */

let _adapterSafeParse = null;
function getAdapterSafeParse() {
  if (_adapterSafeParse !== null) return _adapterSafeParse;
  try {
    // Lazy require avoids circular load with adapters that import convert helpers.
    const openai = require("../../adapters/openai.cjs");
    _adapterSafeParse = typeof openai.safeParseJson === "function" ? openai.safeParseJson : false;
  } catch {
    _adapterSafeParse = false;
  }
  return _adapterSafeParse;
}

function repairWindowsPathControlChars(str) {
  if (typeof str !== "string" || !str) return str;
  if (!/[\t\b\f]/.test(str)) return str;
  return str
    .replace(/([A-Za-z:\\/])\t(?=[A-Za-z0-9_.])/g, "$1\\t")
    .replace(/([A-Za-z0-9_.:\\/])\x08(?=[A-Za-z0-9_.])/g, "$1\\b")
    .replace(/([A-Za-z0-9_.:\\/])\f(?=[A-Za-z0-9_.])/g, "$1\\f");
}

function repairToolArgStrings(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === "string") {
      obj[key] = repairWindowsPathControlChars(obj[key]);
    }
  }
  return obj;
}

function repairLooseJson(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  s = s.replace(/,\s*([}\]])/g, "$1");
  return s;
}

/**
 * Last-resort recovery for edit_file / path-heavy tool args when JSON is broken.
 * Mirrors electron/adapters/openai.cjs recoverToolArgsFromBrokenJson (kept local
 * so proxy convert never hard-depends on adapter internals).
 */
function recoverToolArgsFromBrokenJson(text) {
  if (!text || typeof text !== "string") return null;
  const out = {};
  const grab = (keys) => {
    for (const key of keys) {
      const re = new RegExp(
        `["']${key}["']\\s*:\\s*("(?:\\\\.|[^"\\\\])*"|(?:[\\s\\S]*?)(?=,\\s*["']\\w+["']\\s*:|\\s*}))`,
        "i"
      );
      const m = text.match(re);
      if (!m) continue;
      let raw = m[1].trim();
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          return repairWindowsPathControlChars(JSON.parse(raw));
        } catch {
          // fall through to unescape
        }
      }
      if (raw.startsWith('"')) raw = raw.slice(1);
      if (raw.endsWith('"')) raw = raw.slice(0, -1);
      return repairWindowsPathControlChars(
        raw
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\")
      );
    }
    return undefined;
  };
  const pathVal = grab(["path", "filePath", "file_path", "filepath", "filename", "file"]);
  const old_string = grab(["old_string", "oldString", "old", "old_text", "before", "search"]);
  const new_string = grab(["new_string", "newString", "new", "new_text", "after", "replace", "replacement"]);
  const replace_all = grab(["replace_all", "replaceAll"]);
  const content = grab(["content", "text", "body", "data"]);
  if (pathVal != null) out.path = pathVal;
  if (old_string != null) out.old_string = old_string;
  if (new_string != null) out.new_string = new_string;
  if (replace_all != null) out.replace_all = replace_all === true || replace_all === "true";
  if (content != null && out.content == null) out.content = content;
  return Object.keys(out).length ? out : null;
}

function safeParseJSON(s, fallback = {}) {
  if (s == null) return fallback;
  if (typeof s === "object") return repairToolArgStrings(s);
  const text = String(s);
  if (!text.trim()) return fallback;

  // Prefer the agent-side robust parser (handles recover + path repair).
  const adapterParse = getAdapterSafeParse();
  if (adapterParse) {
    try {
      const parsed = adapterParse(text);
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        return repairToolArgStrings(parsed);
      }
    } catch {
      /* fall through */
    }
  }

  const attempts = [text, repairLooseJson(text)];
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return repairToolArgStrings(JSON.parse(candidate));
    } catch {
      /* try next */
    }
  }

  const recovered = recoverToolArgsFromBrokenJson(text);
  if (recovered) return repairToolArgStrings(recovered);
  return fallback;
}

function sanitizeToolName(name) {
  // Gemini: [a-zA-Z0-9_-]{1,64}; Claude more flexible
  return String(name || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64) || "tool";
}

/** OpenAI tools → Anthropic tools */
function openaiToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => {
    const fn = t.function || t;
    return {
      name: String(fn.name || "").trim(),
      description: fn.description != null ? String(fn.description) : "",
      input_schema:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
    };
  }).filter((t) => t.name);
}

/** OpenAI tools → Gemini functionDeclarations */
function openaiToolsToGemini(tools) {
  if (!Array.isArray(tools)) return { functionDeclarations: [], nameMap: new Map() };
  const nameMap = new Map();
  const decls = tools.map((t) => {
    const fn = t.function || t;
    const original = String(fn.name || "").trim();
    const name = sanitizeToolName(original);
    if (name !== original) nameMap.set(name, original);
    return {
      name,
      description: fn.description != null ? String(fn.description) : "",
      parameters:
        fn.parameters && typeof fn.parameters === "object"
          ? cleanSchemaForGemini(fn.parameters)
          : { type: "object", properties: {} },
    };
  }).filter((d) => d.name);
  return { functionDeclarations: decls, nameMap };
}

function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) {
    // Gemini rejects some JSON Schema keywords
    if (["$schema", "additionalProperties", "default", "examples"].includes(k)) continue;
    // Gemini requires `items` for array types — add fallback if missing
    if (k === "items" && v == null) {
      out[k] = { type: "string" };
      continue;
    }
    if (v && typeof v === "object") out[k] = cleanSchemaForGemini(v);
    else out[k] = v;
  }
  // If current node is type=array and items is still missing, add minimal fallback
  if (out.type === "array" && !out.items) {
    out.items = { type: "string" };
  }
  return out;
}

function openaiToolChoiceToAnthropic(toolChoice) {
  if (toolChoice == null || toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    return { type: "tool", name: toolChoice.function?.name || toolChoice.name };
  }
  return { type: "auto" };
}

function openaiToolChoiceToGemini(toolChoice) {
  if (toolChoice == null || toolChoice === "auto") return { mode: "AUTO" };
  if (toolChoice === "none") return { mode: "NONE" };
  if (toolChoice === "required") return { mode: "ANY" };
  if (typeof toolChoice === "object" && toolChoice.type === "function") {
    const name = toolChoice.function?.name || toolChoice.name;
    return { mode: "ANY", allowedFunctionNames: name ? [sanitizeToolName(name)] : undefined };
  }
  return { mode: "AUTO" };
}

module.exports = {
  safeParseJSON,
  sanitizeToolName,
  openaiToolsToAnthropic,
  openaiToolsToGemini,
  cleanSchemaForGemini,
  openaiToolChoiceToAnthropic,
  openaiToolChoiceToGemini,
};
