/**
 * Validate inbound proxy API keys (must start with sk-).
 */

function extractBearer(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // OpenAI-style alternate headers some clients send
  const apiKey = h["x-api-key"] || h["api-key"] || "";
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return "";
}

function findKey(store, token) {
  if (!token || typeof token !== "string") return null;
  const t = token.trim();
  if (!t.startsWith("sk-")) return null;
  const keys = store.keys || [];
  return keys.find((k) => k.enabled !== false && k.key === t) || null;
}

function assertAuthorized(store, req) {
  const token = extractBearer(req);
  if (!token) {
    return { ok: false, status: 401, error: { message: "Missing API key. Use Authorization: Bearer sk-...", type: "auth_error" } };
  }
  if (!token.startsWith("sk-")) {
    return { ok: false, status: 401, error: { message: "API key must start with sk-", type: "auth_error" } };
  }
  const rec = findKey(store, token);
  if (!rec) {
    return { ok: false, status: 401, error: { message: "Invalid API key", type: "auth_error" } };
  }
  return { ok: true, key: rec };
}

module.exports = { extractBearer, findKey, assertAuthorized };
