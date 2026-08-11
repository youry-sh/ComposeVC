/**
 * Gemini thought signatures for multi-turn tool calling.
 * OpenAI wire format has no field for these — cache by tool_call id (and name+args).
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */

/** @type {Map<string, string>} id → signature */
const byId = new Map();
/** @type {Map<string, string>} name|argsHash → signature (fallback) */
const byFingerprint = new Map();

const MAX_ENTRIES = 4000;

function fingerprint(name, args) {
  let argsStr = "";
  try {
    argsStr =
      typeof args === "string"
        ? args
        : JSON.stringify(args && typeof args === "object" ? args : {});
  } catch {
    argsStr = String(args || "");
  }
  // stable-ish: strip whitespace noise
  argsStr = argsStr.replace(/\s+/g, " ").trim();
  return `${String(name || "").trim()}|${argsStr}`;
}

function trimMaps() {
  if (byId.size > MAX_ENTRIES) {
    const drop = byId.size - Math.floor(MAX_ENTRIES * 0.7);
    let i = 0;
    for (const k of byId.keys()) {
      byId.delete(k);
      if (++i >= drop) break;
    }
  }
  if (byFingerprint.size > MAX_ENTRIES) {
    const drop = byFingerprint.size - Math.floor(MAX_ENTRIES * 0.7);
    let i = 0;
    for (const k of byFingerprint.keys()) {
      byFingerprint.delete(k);
      if (++i >= drop) break;
    }
  }
}

function extractFromPart(part) {
  if (!part || typeof part !== "object") return null;
  const sig =
    part.thoughtSignature ||
    part.thought_signature ||
    part.functionCall?.thoughtSignature ||
    part.functionCall?.thought_signature ||
    null;
  if (typeof sig === "string" && sig.trim()) return sig.trim();
  if (sig && typeof sig === "object" && Buffer.isBuffer(sig)) {
    return sig.toString("base64");
  }
  // bytes as number array
  if (Array.isArray(sig)) {
    try {
      return Buffer.from(sig).toString("base64");
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Remember signature for a tool call id (+ optional name/args fingerprint).
 */
function remember(id, signature, { name, args } = {}) {
  if (!signature || typeof signature !== "string") return;
  const sig = signature.trim();
  if (!sig) return;
  if (id) byId.set(String(id), sig);
  if (name != null) {
    byFingerprint.set(fingerprint(name, args), sig);
  }
  trimMaps();
}

/**
 * Look up signature for OpenAI tool_call object or loose fields.
 */
function lookup(tc) {
  if (!tc || typeof tc !== "object") return null;
  // Prefer fields already on the tool call (if client preserved them)
  const direct =
    tc.thought_signature ||
    tc.thoughtSignature ||
    tc.extra_content?.google?.thought_signature ||
    tc.extra_content?.google?.thoughtSignature ||
    tc.function?.thought_signature ||
    tc.function?.thoughtSignature ||
    null;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const id = tc.id || null;
  if (id && byId.has(String(id))) return byId.get(String(id));

  const name = tc.function?.name || tc.name || "";
  const args = tc.function?.arguments ?? tc.arguments ?? tc.input;
  const fp = fingerprint(name, args);
  if (byFingerprint.has(fp)) return byFingerprint.get(fp);
  return null;
}

function lookupByIdNameArgs(id, name, args) {
  if (id && byId.has(String(id))) return byId.get(String(id));
  const fp = fingerprint(name, args);
  if (byFingerprint.has(fp)) return byFingerprint.get(fp);
  return null;
}

/**
 * Attach thoughtSignature onto a Gemini functionCall part (mutates part).
 */
function attachToPart(part, signature) {
  if (!part || !signature) return part;
  part.thoughtSignature = signature;
  return part;
}

/**
 * From a Gemini content part with functionCall — cache signature + return it.
 */
function rememberFromGeminiPart(part, toolCallId, { name, args } = {}) {
  const sig = extractFromPart(part);
  if (sig) {
    remember(toolCallId, sig, {
      name: name || part.functionCall?.name,
      args: args != null ? args : part.functionCall?.args,
    });
  }
  return sig;
}

function stats() {
  return { byId: byId.size, byFingerprint: byFingerprint.size };
}

function clear() {
  byId.clear();
  byFingerprint.clear();
}

module.exports = {
  remember,
  lookup,
  lookupByIdNameArgs,
  extractFromPart,
  attachToPart,
  rememberFromGeminiPart,
  fingerprint,
  stats,
  clear,
};
