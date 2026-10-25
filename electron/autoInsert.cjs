const fs = require("fs");
const path = require("path");

const FILE_NAME = "auto-insert.json";

function getStorePath(userDataPath) {
  return path.join(userDataPath, FILE_NAME);
}

/** Per-message switches for auto-insert.
 *  Anything that is not an explicit `false` stays ON, so stores written before
 *  the checkboxes existed keep inserting every message they contain. */
function normalizeMessageEnabled(value, length) {
  const source = Array.isArray(value) ? value : [];
  const flags = [];
  for (let index = 0; index < length; index += 1) {
    flags.push(source[index] !== false);
  }
  return flags;
}

function normalizeStore(value) {
  const parsed = value && typeof value === "object" ? value : {};
  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.filter((message) => typeof message === "string")
    : [];
  const sessions = {};
  if (parsed.sessions && typeof parsed.sessions === "object") {
    for (const [sessionId, entry] of Object.entries(parsed.sessions)) {
      if (typeof sessionId !== "string") continue;
      sessions[sessionId] = { enabled: !(entry && entry.enabled === false) };
    }
  }
  if (!Array.isArray(parsed.messages)) {
    for (const [sessionId, entry] of Object.entries(parsed)) {
      if (sessionId === "sessions" || sessionId === "messages" || !entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.messages)) {
        for (const message of entry.messages) {
          if (typeof message === "string" && !messages.includes(message)) messages.push(message);
        }
      }
      sessions[sessionId] = { enabled: entry.enabled !== false };
    }
  }
  const legacyEnabled = Object.values(sessions).every((entry) => entry.enabled !== false);
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : legacyEnabled,
    messages,
    messageEnabled: normalizeMessageEnabled(parsed.messageEnabled, messages.length),
    sessions,
  };
}

async function readAutoInsertStore(userDataPath) {
  try {
    const raw = await fs.promises.readFile(getStorePath(userDataPath), "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch {
    return { enabled: true, messages: [], messageEnabled: [], sessions: {} };
  }
}

async function saveAutoInsert(userDataPath, data) {
  const store = await readAutoInsertStore(userDataPath);
  store.enabled = data.enabled !== false;
  if (Array.isArray(data.messages)) {
    store.messages = data.messages.filter((message) => typeof message === "string");
  }
  const flags = Array.isArray(data.messageEnabled) ? data.messageEnabled : store.messageEnabled;
  store.messageEnabled = normalizeMessageEnabled(flags, store.messages.length);
  await fs.promises.writeFile(getStorePath(userDataPath), JSON.stringify(store, null, 2), "utf8");
  return true;
}

module.exports = {
  readAutoInsertStore,
  saveAutoInsert,
};
