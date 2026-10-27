/**
 * Disk store for the Expert workspace.
 *
 * Everything the tab owns lives under <userData>/expert and survives restarts:
 *   state.json                   3 slots (folder, model, chat id, draft), saved-session list
 *   sessions/<id>.json           one file per Expert chat (messages + composed prompts)
 *   saved/<id>.json              explicit "save session" snapshots
 *   projects/<key>/study.json    the full project study (scan + dossier rounds)
 *
 * Writes are atomic (tmp + rename) and every read is normalized, so a corrupt or
 * hand-edited file can never crash the shell or wipe the other slots.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VERSION = 1;
const STATE_FILE = "state.json";
const SLOT_IDS = ["expert-1", "expert-2", "expert-3"];
const MAX_TITLE = 90;
const MAX_MESSAGE_CHARS = 400_000;
const MAX_LIST = 800;

function baseDir(userDataPath) {
  return path.join(String(userDataPath || "."), "expert");
}

function statePath(userDataPath) {
  return path.join(baseDir(userDataPath), STATE_FILE);
}

function sessionsDir(userDataPath) {
  return path.join(baseDir(userDataPath), "sessions");
}

function savedDir(userDataPath) {
  return path.join(baseDir(userDataPath), "saved");
}

function projectsDir(userDataPath) {
  return path.join(baseDir(userDataPath), "projects");
}

function projectKey(rootPath) {
  const raw = typeof rootPath === "string" ? rootPath.trim() : "";
  if (!raw) return "no-project";
  const normalized = raw.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const hash = crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  const name = normalized.split("/").filter(Boolean).pop() || "project";
  const safe = name.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 32) || "project";
  return `${safe}-${hash}`;
}

function projectDir(userDataPath, rootPath) {
  return path.join(projectsDir(userDataPath), projectKey(rootPath));
}

function studyPath(userDataPath, rootPath) {
  return path.join(projectDir(userDataPath, rootPath), "study.json");
}

function cleanId(value, fallback) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 120 ? id : fallback;
}

function cleanString(value, max = 4000) {
  if (typeof value !== "string" || !value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function cleanTitle(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, MAX_TITLE);
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function newSessionId() {
  return `ex-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function newMessageId() {
  return `m-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}

function newSavedId() {
  return `sv-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
}

function emptyState() {
  return {
    version: VERSION,
    updatedAt: 0,
    ui: { activeSlot: SLOT_IDS[0] },
    slots: SLOT_IDS.map((id) => ({
      id,
      rootPath: null,
      projectName: null,
      selectedModelId: null,
      sessionId: null,
      draft: "",
      updatedAt: 0,
    })),
    saved: [],
  };
}

function normalizeSlot(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    id: cleanId(item.id, SLOT_IDS[index] || `expert-${index + 1}`),
    rootPath: cleanString(item.rootPath, 4096),
    projectName: cleanString(item.projectName, 256),
    selectedModelId: cleanString(item.selectedModelId, 256),
    sessionId: cleanString(item.sessionId, 120),
    draft: typeof item.draft === "string" ? item.draft.slice(0, 20000) : "",
    updatedAt: Number(item.updatedAt) || 0,
  };
}

function normalizeSaved(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    id: cleanId(item.id, newSavedId()),
    name: cleanTitle(item.name) || "Saved session",
    sessionId: cleanString(item.sessionId, 120) || "",
    title: cleanTitle(item.title) || "",
    rootPath: cleanString(item.rootPath, 4096),
    projectName: cleanString(item.projectName, 256),
    messageCount: Math.max(0, Number(item.messageCount) || 0),
    createdAt: Number(item.createdAt) || 0,
    updatedAt: Number(item.updatedAt) || 0,
  };
}

function normalizeState(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const byId = new Map();
  for (const slot of Array.isArray(item.slots) ? item.slots : []) {
    if (slot && SLOT_IDS.includes(slot.id)) byId.set(slot.id, slot);
  }
  const slots = SLOT_IDS.map((id, index) => {
    const slot = normalizeSlot(byId.get(id), index);
    slot.id = id;
    return slot;
  });
  const saved = (Array.isArray(item.saved) ? item.saved : [])
    .slice(-MAX_LIST)
    .map(normalizeSaved)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeSlot = SLOT_IDS.includes(item?.ui?.activeSlot) ? item.ui.activeSlot : SLOT_IDS[0];
  return {
    version: VERSION,
    updatedAt: Number(item.updatedAt) || 0,
    ui: { activeSlot },
    slots,
    saved,
  };
}

function readState(userDataPath) {
  const file = statePath(userDataPath);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return emptyState();
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      /* ignore */
    }
    return emptyState();
  }
}

function savePatch(userDataPath, patch) {
  const current = readState(userDataPath);
  const source = patch && typeof patch === "object" ? patch : {};
  const next = normalizeState({
    version: VERSION,
    updatedAt: Date.now(),
    ui: source.ui && typeof source.ui === "object" ? { ...current.ui, ...source.ui } : current.ui,
    slots: Array.isArray(source.slots) ? source.slots : current.slots,
    saved: Array.isArray(source.saved) ? source.saved : current.saved,
  });
  atomicWrite(statePath(userDataPath), next);
  return next;
}

// ── sessions ────────────────────────────────────────────────────────────────

function cleanMessage(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const role = item.role === "assistant" ? "assistant" : "user";
  const content = typeof item.content === "string" ? item.content.slice(0, MAX_MESSAGE_CHARS) : "";
  const meta = item.meta && typeof item.meta === "object" ? item.meta : undefined;
  return {
    id: cleanId(item.id, newMessageId()),
    role,
    content,
    createdAt: Number(item.createdAt) || Date.now(),
    ...(meta ? { meta } : {}),
  };
}

function normalizeSession(raw, fallbackId) {
  const item = raw && typeof raw === "object" ? raw : {};
  const messages = (Array.isArray(item.messages) ? item.messages : []).map(cleanMessage);
  return {
    version: VERSION,
    sessionId: cleanId(item.sessionId, fallbackId || newSessionId()),
    title: cleanTitle(item.title) || cleanTitle(messages.find((m) => m.role === "user")?.content) || "Expert chat",
    rootPath: cleanString(item.rootPath, 4096),
    projectName: cleanString(item.projectName, 256),
    slotId: cleanString(item.slotId, 64),
    modelId: cleanString(item.modelId, 256),
    createdAt: Number(item.createdAt) || Date.now(),
    updatedAt: Number(item.updatedAt) || Date.now(),
    messages,
    contextTokens: Math.max(0, Number(item.contextTokens) || 0),
    contextLimit: Math.max(0, Number(item.contextLimit) || 0),
    study: item.study && typeof item.study === "object" ? item.study : undefined,
  };
}

function sessionFile(userDataPath, sessionId) {
  const id = cleanId(sessionId, "");
  if (!id) return null;
  return path.join(sessionsDir(userDataPath), `${id.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
}

function readSession(userDataPath, sessionId) {
  const file = sessionFile(userDataPath, sessionId);
  if (!file) return null;
  const raw = readJson(file);
  if (!raw) return null;
  return normalizeSession(raw, sessionId);
}

function writeSession(userDataPath, session) {
  const normalized = normalizeSession(session);
  normalized.updatedAt = Date.now();
  const file = sessionFile(userDataPath, normalized.sessionId);
  if (!file) throw new Error("Invalid Expert session id");
  atomicWrite(file, normalized);
  return normalized;
}

function createSession(userDataPath, input = {}) {
  const now = Date.now();
  const session = normalizeSession(
    {
      sessionId: newSessionId(),
      title: input.title,
      rootPath: input.rootPath,
      projectName: input.projectName,
      slotId: input.slotId,
      modelId: input.modelId,
      createdAt: now,
      updatedAt: now,
      messages: Array.isArray(input.messages) ? input.messages : [],
    },
    null
  );
  return writeSession(userDataPath, session);
}

function appendMessages(userDataPath, sessionId, messages) {
  const session = readSession(userDataPath, sessionId);
  if (!session) return null;
  session.messages.push(...(Array.isArray(messages) ? messages : [messages]));
  return writeSession(userDataPath, session);
}

function summaryOf(session) {
  return {
    sessionId: session.sessionId,
    title: session.title,
    rootPath: session.rootPath,
    projectName: session.projectName,
    messageCount: session.messages.length,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    promptCount: session.messages.filter((m) => m.role === "assistant" && m.meta?.kind === "prompt").length,
  };
}

function listSessions(userDataPath, rootPath) {
  const dir = sessionsDir(userDataPath);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const wanted = typeof rootPath === "string" && rootPath ? rootPath.trim().toLowerCase() : null;
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = readJson(path.join(dir, entry.name));
    if (!raw) continue;
    const session = normalizeSession(raw, entry.name.replace(/\.json$/, ""));
    if (wanted && String(session.rootPath || "").trim().toLowerCase() !== wanted) continue;
    if (!session.messages.length) continue;
    out.push(summaryOf(session));
    if (out.length >= MAX_LIST) break;
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

function deleteSession(userDataPath, sessionId) {
  const file = sessionFile(userDataPath, sessionId);
  if (!file) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ── saved sessions ──────────────────────────────────────────────────────────

function savedFile(userDataPath, savedId) {
  const id = cleanId(savedId, "");
  if (!id) return null;
  return path.join(savedDir(userDataPath), `${id.replace(/[^a-z0-9._-]+/gi, "-")}.json`);
}

function saveNamedSession(userDataPath, sessionId, name) {
  const session = readSession(userDataPath, sessionId);
  if (!session) return null;
  const now = Date.now();
  const entryId = newSavedId();
  const file = savedFile(userDataPath, entryId);
  if (!file) return null;
  const snapshot = normalizeSession({
    ...session,
    sessionId: `svs-${entryId}`,
    createdAt: now,
    updatedAt: now,
  });
  atomicWrite(file, { ...snapshot, savedName: cleanTitle(name) || session.title, savedAt: now });
  const entry = normalizeSaved({
    id: entryId,
    name: cleanTitle(name) || session.title,
    sessionId: snapshot.sessionId,
    title: session.title,
    rootPath: session.rootPath,
    projectName: session.projectName,
    messageCount: session.messages.length,
    createdAt: now,
    updatedAt: now,
  });
  const state = readState(userDataPath);
  const saved = [entry, ...state.saved.filter((item) => item.id !== entryId)];
  savePatch(userDataPath, { saved });
  return entry;
}

function listSaved(userDataPath) {
  return readState(userDataPath).saved;
}

function deleteSaved(userDataPath, savedId) {
  const state = readState(userDataPath);
  const entry = state.saved.find((item) => item.id === savedId);
  if (!entry) return { deleted: false };
  savePatch(userDataPath, { saved: state.saved.filter((item) => item.id !== savedId) });
  const file = savedFile(userDataPath, savedId);
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  return { deleted: true };
}

function readSavedSession(userDataPath, savedId) {
  const state = readState(userDataPath);
  if (!state.saved.some((item) => item.id === savedId)) return null;
  const file = savedFile(userDataPath, savedId);
  const raw = file ? readJson(file) : null;
  if (raw) return normalizeSession(raw, savedId);
  const entry = state.saved.find((item) => item.id === savedId);
  return entry ? readSession(userDataPath, entry.sessionId) : null;
}

// ── project study ───────────────────────────────────────────────────────────

function emptyStudy(rootPath) {
  return {
    version: VERSION,
    key: projectKey(rootPath),
    rootPath: rootPath || null,
    projectName: null,
    status: "empty",
    createdAt: 0,
    updatedAt: 0,
    rounds: [],
    dossier: null,
    scan: null,
    digest: null,
    coverage: { readFiles: [], rounds: [] },
    studyTokens: 0,
  };
}

function readStudy(userDataPath, rootPath) {
  if (!rootPath) return emptyStudy(null);
  const raw = readJson(studyPath(userDataPath, rootPath));
  if (!raw || typeof raw !== "object") return emptyStudy(rootPath);
  return {
    ...emptyStudy(rootPath),
    ...raw,
    key: projectKey(rootPath),
    coverage: {
      readFiles: Array.isArray(raw?.coverage?.readFiles) ? raw.coverage.readFiles : [],
      rounds: Array.isArray(raw?.coverage?.rounds) ? raw.coverage.rounds : [],
    },
    rounds: Array.isArray(raw.rounds) ? raw.rounds : [],
  };
}

function writeStudy(userDataPath, rootPath, study) {
  if (!rootPath) return null;
  const next = {
    ...emptyStudy(rootPath),
    ...(study && typeof study === "object" ? study : {}),
    version: VERSION,
    key: projectKey(rootPath),
    rootPath,
    updatedAt: Date.now(),
  };
  atomicWrite(studyPath(userDataPath, rootPath), next);
  return next;
}

function deleteStudy(userDataPath, rootPath) {
  if (!rootPath) return false;
  try {
    fs.rmSync(projectDir(userDataPath, rootPath), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  VERSION,
  SLOT_IDS,
  baseDir,
  projectKey,
  projectDir,
  studyPath,
  statePath,
  emptyState,
  normalizeState,
  readState,
  savePatch,
  newMessageId,
  newSessionId,
  sessionFile,
  normalizeSession,
  readSession,
  writeSession,
  createSession,
  appendMessages,
  summaryOf,
  listSessions,
  deleteSession,
  saveNamedSession,
  listSaved,
  deleteSaved,
  readSavedSession,
  emptyStudy,
  readStudy,
  writeStudy,
  deleteStudy,
  atomicWrite,
  readJson,
};
