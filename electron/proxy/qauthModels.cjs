function modelId(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.id || value.model || value.modelId || value.name || "").trim();
}

/** Keep vendor/model paths intact; only remove ComposeVC's QAuth route tag. */
function normalizeQauthModelId(value) {
  let id = String(value || "").trim();
  while (/^(?:qauth|cline)\//i.test(id)) id = id.slice(id.indexOf("/") + 1);
  return id;
}

/**
 * Normalize both OpenAI-style model payloads and Cline's categorized catalog.
 * Cline has used top-level and data-wrapped variants of these shapes.
 */
function modelsFromQauthPayload(payload) {
  const rows = [];
  const seenContainers = new Set();

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const row of value) {
        const id = normalizeQauthModelId(modelId(row));
        if (id) rows.push(typeof row === "object" ? { ...row, id } : { id });
      }
      return;
    }
    if (typeof value !== "object" || seenContainers.has(value)) return;
    seenContainers.add(value);
    for (const key of ["models", "recommended", "free", "clinePass", "cline_pass"]) {
      if (Array.isArray(value[key])) visit(value[key]);
    }
    if (value.data && typeof value.data === "object") visit(value.data);
  }

  visit(payload);
  const byId = new Map();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    if (!byId.has(key)) byId.set(key, row);
  }
  return [...byId.values()];
}

module.exports = { modelId, normalizeQauthModelId, modelsFromQauthPayload };
