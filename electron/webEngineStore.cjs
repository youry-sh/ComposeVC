const fs = require("fs");
const path = require("path");

/**
 * Per-chat URL binding for the Web Engine workspace.
 *
 * A chat's "web site" (usually the project's localhost dev server) is bound to
 * a stable key — the chat/session id, falling back to the project folder — so
 * two chats on the same machine never share one another's URL.
 *
 * Versioned JSON store (v1), atomic write (tmp + rename), safe read with
 * defaults for missing/corrupt fields. Small: one flat map, no per-item files.
 */

function target(userDataPath) {
  return path.join(userDataPath, "webengine", "bindings.json");
}

/** Read the bindings map, tolerant of a missing or corrupt file. */
function read(userDataPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(target(userDataPath), "utf8"));
    if (raw && typeof raw === "object" && raw.bindings && typeof raw.bindings === "object") {
      return raw.bindings;
    }
  } catch {
    /* missing / corrupt → start empty */
  }
  return {};
}

async function write(userDataPath, bindings) {
  const file = target(userDataPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  // tmp lives in the same directory so the final rename() stays atomic on one fs.
  await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, bindings }, null, 2), "utf8");
  await fs.promises.rename(tmp, file);
}

function get(userDataPath, key) {
  if (typeof key !== "string" || !key) return { url: null };
  const entry = read(userDataPath)[key];
  // Parse, don't trust: only keep a well-formed http(s) URL on read.
  if (entry && typeof entry === "object" && typeof entry.url === "string" && entry.url) {
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      return { url: null };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url: null };
    return {
      url: entry.url,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : null,
    };
  }
  return { url: null };
}

async function set(userDataPath, key, url) {
  if (typeof key !== "string" || !key) return { ok: false, error: "no-chat-key" };
  if (typeof url !== "string" || !url) return { ok: false, error: "no-url" };
  const bindings = read(userDataPath);
  bindings[key] = { url, updatedAt: Date.now() };
  await write(userDataPath, bindings);
  return { ok: true, url };
}

module.exports = { get, set };
