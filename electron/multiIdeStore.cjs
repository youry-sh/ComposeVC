/**
 * Disk-backed store for the MultiIDE layout: workspaces (name + view state) and
 * the chat panels that belong to them.
 *
 * This used to live in renderer localStorage only. Keeping it under userData as
 * a versioned JSON file means a renamed workspace survives cache clears and is
 * readable/writable by the main process (one source of truth). Writes are
 * atomic (tmp + rename) and every patch is re-normalized, so a corrupt or
 * hand-edited file can never crash the shell.
 */

const fs = require("fs");
const path = require("path");

const VERSION = 2;
const STATE_FILE = "multiide_state.json";
const MAX_SLOTS = 12;
const MAX_WORKSPACES = 64;
const MAX_OPEN_ROWS = 3;
const MAX_NAME_CHARS = 48;
const AGENT_MODES = new Set(["lopster", "lab-in", "fortani"]);

function statePath(userDataPath) {
  return path.join(String(userDataPath || "."), STATE_FILE);
}

function cleanId(value, fallback) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 80 ? id : fallback;
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS);
}

function cleanString(value) {
  return typeof value === "string" && value ? value : null;
}

function normalizeWorkspace(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  const openIds = Array.isArray(item.openIds)
    ? item.openIds.filter((id) => typeof id === "string" && id).slice(0, MAX_OPEN_ROWS)
    : [];
  return {
    id: cleanId(item.id, `ws-${index + 1}`),
    name: cleanName(item.name),
    activeId: cleanString(item.activeId),
    openIds: Array.from(new Set(openIds)),
  };
}

function normalizeSlot(raw, index) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    id: cleanId(item.id, `multi-${index + 1}`),
    rootPath: cleanString(item.rootPath),
    sessionId: cleanString(item.sessionId),
    selectedModelId: cleanString(item.selectedModelId),
    agentMode: AGENT_MODES.has(item.agentMode) ? item.agentMode : "lopster",
    workspaceId: cleanId(item.workspaceId, "ws-default"),
  };
}

/**
 * Shell chrome state — which side columns are folded away. Global, not per
 * workspace: folding the rail is a quirk of the window, not of a chat set.
 */
function normalizeUi(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  return {
    railCollapsed: item.railCollapsed === true,
    asideCollapsed: item.asideCollapsed === true,
  };
}

function normalizeState(raw) {
  const item = raw && typeof raw === "object" ? raw : {};

  const usedWorkspaceIds = new Set();
  const workspaces = (Array.isArray(item.workspaces) ? item.workspaces : [])
    .slice(0, MAX_WORKSPACES)
    .map(normalizeWorkspace)
    .filter((workspace) => {
      if (usedWorkspaceIds.has(workspace.id)) return false;
      usedWorkspaceIds.add(workspace.id);
      return true;
    });

  const usedSlotIds = new Set();
  const slots = (Array.isArray(item.slots) ? item.slots : [])
    .slice(0, MAX_SLOTS)
    .map(normalizeSlot)
    .filter((slot) => {
      if (usedSlotIds.has(slot.id)) return false;
      usedSlotIds.add(slot.id);
      return true;
    });

  const requestedActive = typeof item.activeWorkspaceId === "string" ? item.activeWorkspaceId : null;
  const activeWorkspaceId =
    requestedActive && usedWorkspaceIds.has(requestedActive) ? requestedActive : null;

  return {
    version: VERSION,
    updatedAt: Number(item.updatedAt) || 0,
    activeWorkspaceId,
    ui: normalizeUi(item.ui),
    workspaces,
    slots,
  };
}

function emptyState() {
  return {
    version: VERSION,
    updatedAt: 0,
    activeWorkspaceId: null,
    ui: normalizeUi(null),
    workspaces: [],
    slots: [],
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
    // Keep the broken file for recovery instead of silently overwriting it.
    try {
      fs.renameSync(file, `${file}.corrupt`);
    } catch {
      /* ignore */
    }
    return emptyState();
  }
}

function writeState(userDataPath, state) {
  const file = statePath(userDataPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Merge a partial patch (slots OR workspaces OR active id) into the stored file.
 * Both the slots effect and the workspace effect save independently, so a patch
 * must never wipe the field it does not own.
 */
function savePatch(userDataPath, patch) {
  const current = readState(userDataPath);
  const source = patch && typeof patch === "object" ? patch : {};
  const next = normalizeState({
    version: VERSION,
    updatedAt: Date.now(),
    activeWorkspaceId:
      "activeWorkspaceId" in source ? source.activeWorkspaceId : current.activeWorkspaceId,
    // ui is a partial merge: a patch may flip one column and leave the other.
    ui:
      source.ui && typeof source.ui === "object"
        ? { ...current.ui, ...source.ui }
        : current.ui,
    workspaces: Array.isArray(source.workspaces) ? source.workspaces : current.workspaces,
    slots: Array.isArray(source.slots) ? source.slots : current.slots,
  });
  writeState(userDataPath, next);
  return next;
}

module.exports = {
  VERSION,
  STATE_FILE,
  statePath,
  emptyState,
  normalizeState,
  readState,
  savePatch,
};
