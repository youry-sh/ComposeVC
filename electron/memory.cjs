const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  isRealUserMessage,
  stripInternalUserNudges,
  messageContentToText,
} = require("./compact.cjs");

function getHistoryDir(app) {
  return path.join(app.getPath("userData"), "lopster_history");
}

function getLegacyHistoryDirs(app) {
  const appData = app.getPath("appData");
  const current = getHistoryDir(app);
  const known = [
    path.join(appData, "lopster-ide", "lopster_history"),
    path.join(appData, "ComposeVC Copy", "lopster_history"),
    path.join(appData, "lopster", "lopster_history"),
    path.join(appData, "lopster-ide-1-4-copy", "lopster_history"),
    path.join(appData, "lopster-ide-copy", "lopster_history"),
    path.join(appData, "lopster-ide-copy-lopster1-4-copy", "lopster_history"),
  ];

  // Also scan AppData for any other ComposeVC* / lopster* installs that keep
  // chat history under <name>/lopster_history (copies, hashed dev instances).
  try {
    for (const entry of fs.readdirSync(appData, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (!/lopster/i.test(name)) continue;
      known.push(path.join(appData, name, "lopster_history"));
    }
  } catch {
    // appData unreadable — fall back to known list only
  }

  const seen = new Set();
  const dirs = [];
  for (const dir of known) {
    const key = dir.toLowerCase();
    if (seen.has(key) || key === current.toLowerCase()) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

function projectKey(rootPath) {
  const key = rootPath || "no-project";
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function getProjectDir(app, rootPath) {
  return path.join(getHistoryDir(app), projectKey(rootPath));
}

function getSessionsDir(app, rootPath) {
  return path.join(getProjectDir(app, rootPath), "sessions");
}

function getSessionPath(app, rootPath, sessionId) {
  return path.join(getSessionsDir(app, rootPath), `${sessionId}.json`);
}

function getActivePointerPath(app, rootPath) {
  return path.join(getProjectDir(app, rootPath), "active.json");
}

function getBookmarksPath(app) {
  return path.join(getHistoryDir(app), "chat_bookmarks.json");
}

function deriveTitle(messages) {
  // Prefer a real user turn — never title the chat after an internal continue nudge.
  // Multimodal: content may be string | ChatContentPart[] (+ optional images[]).
  const firstUser = (messages || []).find((message) => isRealUserMessage(message));
  if (!firstUser) return "New chat";
  let text = messageContentToText(firstUser.content).trim().replace(/\s+/g, " ");
  if (!text) {
    const imgCount = Array.isArray(firstUser.images)
      ? firstUser.images.length
      : Array.isArray(firstUser.content)
        ? firstUser.content.filter(
            (p) => p && typeof p === "object" && (p.type === "image_url" || p.type === "image")
          ).length
        : 0;
    if (imgCount > 0) return imgCount === 1 ? "Photo" : `${imgCount} photos`;
    return "New chat";
  }
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

// In-memory session meta cache — avoids read-before-write on every tool step.
// Key: `${projectKey}::${sessionId}`
const sessionMetaCache = new Map();
// Last known active session per project (skip rewriting active.json when unchanged)
const activeSessionCache = new Map();

function metaKey(rootPath, sessionId) {
  return `${projectKey(rootPath)}::${sessionId}`;
}

function rememberSessionMeta(rootPath, sessionId, meta) {
  sessionMetaCache.set(metaKey(rootPath, sessionId), {
    title: meta.title || null,
    createdAt: meta.createdAt || Date.now(),
    contextTokens: typeof meta.contextTokens === "number" ? meta.contextTokens : null,
    usage: meta.usage && typeof meta.usage === "object" ? meta.usage : null,
    oneShot: meta.oneShot === true,
  });
}

async function getActiveSessionId(app, rootPath) {
  const cacheKey = projectKey(rootPath);
  if (activeSessionCache.has(cacheKey)) {
    return activeSessionCache.get(cacheKey);
  }
  try {
    const raw = await fs.promises.readFile(getActivePointerPath(app, rootPath), "utf8");
    const id = JSON.parse(raw).activeSessionId || null;
    activeSessionCache.set(cacheKey, id);
    return id;
  } catch {
    activeSessionCache.set(cacheKey, null);
    return null;
  }
}

async function setActiveSessionId(app, rootPath, sessionId) {
  const cacheKey = projectKey(rootPath);
  if (activeSessionCache.get(cacheKey) === sessionId) {
    return; // already pointing here — skip disk write
  }
  const dir = getProjectDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  if (sessionId) {
    await fs.promises.writeFile(
      getActivePointerPath(app, rootPath),
      JSON.stringify({ activeSessionId: sessionId }),
      "utf8"
    );
    activeSessionCache.set(cacheKey, sessionId);
  } else {
    try {
      await fs.promises.unlink(getActivePointerPath(app, rootPath));
    } catch {
      // missing is fine
    }
    activeSessionCache.set(cacheKey, null);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.setActive=true] — when false, do not steal UI active session pointer
 * @param {string} [options.title]
 */
async function createSession(app, rootPath, options = {}) {
  const setActive = options.setActive !== false;
  const title =
    typeof options.title === "string" && options.title.trim() ? options.title.trim() : "New chat";
  const sessionId = crypto.randomUUID();
  const dir = getSessionsDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const payload = {
    sessionId,
    title,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    oneShot: options.oneShot === true,
  };
  // Compact JSON — history files can get large; pretty-print was pure overhead.
  await fs.promises.writeFile(getSessionPath(app, rootPath, sessionId), JSON.stringify(payload), "utf8");
  if (setActive) {
    await setActiveSessionId(app, rootPath, sessionId);
  }
  rememberSessionMeta(rootPath, sessionId, payload);
  return payload;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.setActive=true] — when false, load without writing active.json
 */
async function loadSession(app, rootPath, sessionId, options = {}) {
  const setActive = options.setActive !== false;
  let targetId = sessionId || (await getActiveSessionId(app, rootPath));

  if (targetId) {
    try {
      const raw = await fs.promises.readFile(getSessionPath(app, rootPath, targetId), "utf8");
      const parsed = JSON.parse(raw);
      if (setActive) {
        await setActiveSessionId(app, rootPath, targetId);
      }
      // Scrub legacy sessions that still have internal continue messages as user turns.
      if (Array.isArray(parsed.messages)) {
        const cleaned = stripInternalUserNudges(parsed.messages);
        if (cleaned.length !== parsed.messages.length) {
          parsed.messages = cleaned;
          // Rewrite once so reopen stays clean without re-filtering forever.
          try {
            await fs.promises.writeFile(
              getSessionPath(app, rootPath, targetId),
              JSON.stringify({ ...parsed, updatedAt: Date.now() }),
              "utf8"
            );
          } catch {
            /* best-effort */
          }
        }
      }
      rememberSessionMeta(rootPath, targetId, parsed);
      return parsed;
    } catch {
      for (const historyDir of getLegacyHistoryDirs(app)) {
        try {
          const raw = await fs.promises.readFile(path.join(historyDir, projectKey(rootPath), "sessions", `${targetId}.json`), "utf8");
          const parsed = JSON.parse(raw);
          await saveSession(app, rootPath, targetId, parsed.messages || [], {
            usage: parsed.usage,
            contextTokens: parsed.contextTokens,
          });
          return parsed;
        } catch {
          // try next legacy history dir
        }
      }
    }
  }

  return createSession(app, rootPath, { setActive });
}

const SAVE_THROTTLE_MS = 900;
const pendingSaves = new Map();
const lastSaveAt = new Map();
const saveInFlight = new Map();

async function writeSessionPayload(app, rootPath, sessionId, messages, metadata = {}) {
  const dir = getSessionsDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  const sessionPath = getSessionPath(app, rootPath, sessionId);

  const cacheKey = metaKey(rootPath, sessionId);
  let cached = sessionMetaCache.get(cacheKey);
  let existingTitle = cached?.title || null;
  let createdAt = cached?.createdAt || Date.now();
  let existingContextTokens = cached?.contextTokens ?? null;
  let existingUsage = cached?.usage || null;
  let existingOneShot = cached?.oneShot === true;

  if (!cached) {
    try {
      const raw = await fs.promises.readFile(sessionPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.title && parsed.title !== "New chat") existingTitle = parsed.title;
      if (parsed.createdAt) createdAt = parsed.createdAt;
      if (typeof parsed.contextTokens === "number") existingContextTokens = parsed.contextTokens;
      if (parsed.usage && typeof parsed.usage === "object") existingUsage = parsed.usage;
      if (parsed.oneShot === true) existingOneShot = true;
    } catch {
    }
  }

  let contextTokens = existingContextTokens;
  if (typeof metadata.contextTokens === "number" && Number.isFinite(metadata.contextTokens)) {
    if (metadata.contextTokens > 0 || metadata.contextTokens === 0) {
      contextTokens = metadata.contextTokens;
    }
  }
  const usage = metadata.usage && typeof metadata.usage === "object" ? metadata.usage : existingUsage;
  const oneShot =
    typeof metadata.oneShot === "boolean" ? metadata.oneShot === true : existingOneShot;
  const cleanMessages = stripInternalUserNudges(messages);
  let title = existingTitle;
  if (!title || title === "New chat") {
    title = deriveTitle(cleanMessages);
  }
  const payload = {
    sessionId,
    title,
    messages: cleanMessages,
    createdAt,
    updatedAt: Date.now(),
    oneShot,
  };
  if (typeof contextTokens === "number") payload.contextTokens = contextTokens;
  if (usage) payload.usage = usage;

  await fs.promises.writeFile(sessionPath, JSON.stringify(payload), "utf8");
  await setActiveSessionId(app, rootPath, sessionId);
  rememberSessionMeta(rootPath, sessionId, payload);
  lastSaveAt.set(cacheKey, Date.now());
  return payload;
}

async function flushPendingSave(app, rootPath, sessionId) {
  const cacheKey = metaKey(rootPath, sessionId);
  if (saveInFlight.get(cacheKey)) return saveInFlight.get(cacheKey);
  const pending = pendingSaves.get(cacheKey);
  if (!pending) return null;
  pendingSaves.delete(cacheKey);
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  const job = writeSessionPayload(app, rootPath, sessionId, pending.messages, pending.metadata)
    .then((payload) => {
      pending.resolve?.(payload);
      return payload;
    })
    .catch((err) => {
      pending.reject?.(err);
      throw err;
    })
    .finally(() => {
      saveInFlight.delete(cacheKey);
      if (pendingSaves.has(cacheKey)) {
        void flushPendingSave(app, rootPath, sessionId);
      }
    });
  saveInFlight.set(cacheKey, job);
  return job;
}

async function saveSession(app, rootPath, sessionId, messages, metadata = {}) {
  const throttle = metadata.throttle === true;
  const force = metadata.force === true || !throttle;
  const cacheKey = metaKey(rootPath, sessionId);
  const meta = { ...metadata };
  delete meta.throttle;
  delete meta.force;

  if (!force) {
    const now = Date.now();
    const last = lastSaveAt.get(cacheKey) || 0;
    const wait = SAVE_THROTTLE_MS - (now - last);
    if (wait > 0) {
      return new Promise((resolve, reject) => {
        const existing = pendingSaves.get(cacheKey);
        if (existing) {
          existing.messages = messages;
          existing.metadata = { ...existing.metadata, ...meta };
          existing.rootPath = rootPath;
          existing.app = app;
          existing.resolve = resolve;
          existing.reject = reject;
          return;
        }
        const entry = {
          messages,
          metadata: meta,
          rootPath,
          app,
          resolve,
          reject,
          timer: setTimeout(() => {
            void flushPendingSave(app, rootPath, sessionId).catch(() => {});
          }, wait),
        };
        pendingSaves.set(cacheKey, entry);
      });
    }
  }

  if (pendingSaves.has(cacheKey)) {
    const existing = pendingSaves.get(cacheKey);
    existing.messages = messages;
    existing.metadata = { ...existing.metadata, ...meta };
    existing.rootPath = rootPath;
    existing.app = app;
    return flushPendingSave(app, rootPath, sessionId);
  }

  return writeSessionPayload(app, rootPath, sessionId, messages, meta);
}

async function flushAllPendingSaves(app) {
  const entries = [...pendingSaves.entries()];
  for (const [cacheKey, pending] of entries) {
    if (!pending) continue;
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const parts = String(cacheKey).split("::");
    if (parts.length < 2) continue;
    const sessionId = parts.slice(1).join("::");
    const rootPathHint = pending.rootPath || null;
    try {
      await writeSessionPayload(
        app,
        rootPathHint,
        sessionId,
        pending.messages,
        pending.metadata || {}
      );
      pending.resolve?.(true);
    } catch (err) {
      pending.reject?.(err);
    } finally {
      pendingSaves.delete(cacheKey);
    }
  }
}

async function listSessions(app, rootPath) {
  // Compatibility path for callers that explicitly request the legacy full list.
  const result = await listSessionsPage(app, rootPath, {
    page: 1,
    pageSize: Number.MAX_SAFE_INTEGER,
    unbounded: true,
  });
  return result.sessions;
}

/**
 * Read only the metadata required for the requested history window.
 * Current session files are already written with compact JSON, so extracting their
 * small header avoids parsing every transcript when opening the history dialog.
 */
async function listSessionsPage(app, rootPath, options = {}) {
  const requestedPageSize = Math.max(1, Number.parseInt(options.pageSize, 10) || 20);
  const pageSize = options.unbounded === true ? requestedPageSize : Math.min(100, requestedPageSize);
  const requestedPage = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const dirs = [
    getSessionsDir(app, rootPath),
    ...getLegacyHistoryDirs(app).map((historyDir) => path.join(historyDir, projectKey(rootPath), "sessions")),
  ];
  const seen = new Set();
  const allSessions = [];

  for (const dir of dirs) {
    try {
      const files = await fs.promises.readdir(dir);
      const jsonFiles = files.filter((file) => file.endsWith(".json"));
      const sessions = await Promise.all(
        jsonFiles.map(async (file) => {
          const sessionPath = path.join(dir, file);
          let handle;
          try {
            // Session payloads can contain long tool transcripts. Read only the
            // JSON header; mtime is the persisted update order, so no full file
            // parse is needed just to paint a history page.
            const [stat, opened] = await Promise.all([fs.promises.stat(sessionPath), fs.promises.open(sessionPath, "r")]);
            handle = opened;
            const buffer = Buffer.alloc(8192);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const header = buffer.subarray(0, bytesRead).toString("utf8");
            const sessionId = (header.match(/"sessionId":"([^"]+)"/) || [])[1] || file.replace(/\.json$/, "");
            const titleEncoded = (header.match(/"title":"((?:\\.|[^"\\])*)"/) || [])[1];
            let title = "New chat";
            if (titleEncoded) {
              try { title = JSON.parse(`"${titleEncoded}"`) || title; } catch { /* keep fallback */ }
            }
            return {
              sessionId,
              title,
              updatedAt: Number((header.match(/"updatedAt":(\d+)/) || [])[1]) || Math.floor(stat.mtimeMs),
              createdAt: Number((header.match(/"createdAt":(\d+)/) || [])[1]) || Math.floor(stat.birthtimeMs || stat.ctimeMs),
              // Counting messages requires parsing the entire transcript; 0 signals
              // that the compact page endpoint intentionally did not load it.
              messageCount: 0,
              oneShot: /"oneShot":true/.test(header),
            };
          } catch {
            return null;
          } finally {
            await handle?.close().catch(() => {});
          }
        })
      );
      for (const session of sessions) {
        if (!session || seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        if (session.title === "Wallpaper") continue;
        if (query && !session.title.toLowerCase().includes(query)) continue;
        allSessions.push(session);
      }
    } catch {
      // directory missing or unreadable
    }
  }

  allSessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const total = allSessions.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;
  return {
    sessions: allSessions.slice(start, start + pageSize),
    page,
    pageSize,
    total,
    totalPages,
    query,
  };
}

async function listChatBookmarks(app) {
  try {
    const raw = await fs.promises.readFile(getBookmarksPath(app), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === "string" && typeof item.chatId === "string")
      .map((item) => ({
        id: item.id,
        chatId: item.chatId,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Untitled chat",
        createdAt: Number(item.createdAt) || Date.now(),
        updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

async function saveChatBookmark(app, input = {}) {
  const chatId = typeof input.chatId === "string" ? input.chatId.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!chatId) throw new Error("Chat ID is required");
  if (!name) throw new Error("Chat name is required");

  const bookmarks = await listChatBookmarks(app);
  const now = Date.now();
  const existingIndex = bookmarks.findIndex((bookmark) => bookmark.chatId === chatId);
  const bookmark = {
    id: existingIndex >= 0 ? bookmarks[existingIndex].id : crypto.randomUUID(),
    chatId,
    name,
    createdAt: existingIndex >= 0 ? bookmarks[existingIndex].createdAt : now,
    updatedAt: now,
  };
  if (existingIndex >= 0) bookmarks.splice(existingIndex, 1, bookmark);
  else bookmarks.unshift(bookmark);
  await fs.promises.mkdir(getHistoryDir(app), { recursive: true });
  await fs.promises.writeFile(getBookmarksPath(app), JSON.stringify(bookmarks), "utf8");
  return bookmark;
}

async function deleteChatBookmark(app, bookmarkId) {
  const bookmarks = await listChatBookmarks(app);
  const next = bookmarks.filter((bookmark) => bookmark.id !== bookmarkId);
  await fs.promises.mkdir(getHistoryDir(app), { recursive: true });
  await fs.promises.writeFile(getBookmarksPath(app), JSON.stringify(next), "utf8");
  return { deleted: next.length !== bookmarks.length };
}

async function copySession(app, rootPath, sessionId) {
  if (!sessionId) return { copied: false, error: "sessionId required" };
  await flushPendingSave(app, rootPath, sessionId);
  try {
    const raw = await fs.promises.readFile(getSessionPath(app, rootPath, sessionId), "utf8");
    const parsed = JSON.parse(raw);
    return {
      copied: true,
      sessionId: parsed.sessionId || sessionId,
      messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    };
  } catch {
    return { copied: false, error: "session not found" };
  }
}

async function findSessionById(app, rootPath, sessionId) {
  if (typeof sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(sessionId)) return null;
  const directPaths = [getSessionPath(app, rootPath, sessionId)];
  const historyDirs = [getHistoryDir(app), ...getLegacyHistoryDirs(app)];
  for (const historyDir of historyDirs) {
    try {
      const projects = await fs.promises.readdir(historyDir, { withFileTypes: true });
      for (const project of projects) {
        if (!project.isDirectory()) continue;
        directPaths.push(path.join(historyDir, project.name, "sessions", `${sessionId}.json`));
      }
    } catch {
      // history directory missing or unavailable
    }
  }
  for (const sessionPath of [...new Set(directPaths)]) {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(sessionPath, "utf8"));
      if (parsed?.sessionId === sessionId) return parsed;
    } catch {
      // try the next location
    }
  }
  return null;
}

async function pasteSession(app, rootPath, sourceSessionId) {
  const source = await findSessionById(app, rootPath, sourceSessionId);
  if (!source) return null;
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const sourceTitle = typeof source.title === "string" && source.title.trim() ? source.title.trim() : "New chat";
  const payload = {
    ...source,
    sessionId,
    title: sourceTitle === "New chat" ? "New chat" : `Copy of ${sourceTitle}`,
    messages: stripInternalUserNudges(Array.isArray(source.messages) ? source.messages : []),
    createdAt: now,
    updatedAt: now,
    oneShot: source.oneShot === true,
  };
  const dir = getSessionsDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(getSessionPath(app, rootPath, sessionId), JSON.stringify(payload), "utf8");
  await setActiveSessionId(app, rootPath, sessionId);
  rememberSessionMeta(rootPath, sessionId, payload);
  return payload;
}

async function deleteSession(app, rootPath, sessionId) {
  try {
    await fs.promises.unlink(getSessionPath(app, rootPath, sessionId));
  } catch {
  }
  sessionMetaCache.delete(metaKey(rootPath, sessionId));
  const active = await getActiveSessionId(app, rootPath);
  if (active === sessionId) {
    activeSessionCache.delete(projectKey(rootPath));
    const remaining = await listSessions(app, rootPath);
    if (remaining[0]) {
      await setActiveSessionId(app, rootPath, remaining[0].sessionId);
    } else {
      await setActiveSessionId(app, rootPath, null);
    }
  }
  return { deleted: true };
}

/**
 * Patch session flags/meta without rewriting the full message transcript.
 * @param {{ oneShot?: boolean, title?: string }} patch
 */
async function updateSessionMeta(app, rootPath, sessionId, patch = {}) {
  if (!sessionId) throw new Error("sessionId required");
  const sessionPath = getSessionPath(app, rootPath, sessionId);
  let parsed = null;
  try {
    const raw = await fs.promises.readFile(sessionPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      sessionId,
      title: "New chat",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      oneShot: false,
    };
  }
  if (typeof patch.oneShot === "boolean") {
    parsed.oneShot = patch.oneShot === true;
  }
  if (typeof patch.title === "string" && patch.title.trim()) {
    parsed.title = patch.title.trim();
  }
  parsed.sessionId = sessionId;
  parsed.updatedAt = Date.now();
  if (!Array.isArray(parsed.messages)) parsed.messages = [];
  const dir = getSessionsDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(sessionPath, JSON.stringify(parsed), "utf8");
  rememberSessionMeta(rootPath, sessionId, parsed);
  return parsed;
}

async function clearSessionTranscript(app, rootPath, sessionId, options = {}) {
  if (!sessionId) throw new Error("sessionId required");
  const sessionPath = getSessionPath(app, rootPath, sessionId);
  let existing = null;
  try {
    const raw = await fs.promises.readFile(sessionPath, "utf8");
    existing = JSON.parse(raw);
  } catch {
    existing = null;
  }
  const oneShot =
    typeof options.oneShot === "boolean"
      ? options.oneShot === true
      : existing?.oneShot === true;
  const title =
    typeof options.title === "string" && options.title.trim()
      ? options.title.trim()
      : existing?.title || "New chat";
  const payload = {
    sessionId,
    title,
    messages: [],
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    oneShot,
  };
  const dir = getSessionsDir(app, rootPath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(sessionPath, JSON.stringify(payload), "utf8");
  rememberSessionMeta(rootPath, sessionId, payload);
  const cacheKey = metaKey(rootPath, sessionId);
  lastSaveAt.delete(cacheKey);
  const pending = pendingSaves.get(cacheKey);
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingSaves.delete(cacheKey);
  }
  return payload;
}

module.exports = {
  createSession,
  loadSession,
  saveSession,
  listSessions,
  listSessionsPage,
  listChatBookmarks,
  saveChatBookmark,
  deleteChatBookmark,
  copySession,
  pasteSession,
  deleteSession,
  updateSessionMeta,
  clearSessionTranscript,
  getActiveSessionId,
  setActiveSessionId,
  flushAllPendingSaves,
};
