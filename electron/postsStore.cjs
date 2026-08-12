/**
 * Posts store — Telegraph-style markdown posts, organised in folders.
 *
 * On disk (userData/posts/):
 *   index.json   { v:2, folders:[{id,name,createdAt}],
 *                        posts:[{id,title,folderId,createdAt,updatedAt}] }
 *   <id>.md      the markdown body of each post
 *
 * folderId === null means the post is unfiled (root). The index carries
 * metadata (fast list/search); bodies live in real .md files.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function postsDir(userDataPath) {
  return path.join(userDataPath, "posts");
}
function indexPath(userDataPath) {
  return path.join(postsDir(userDataPath), "index.json");
}
function bodyPath(userDataPath, id) {
  return path.join(postsDir(userDataPath), `${id}.md`);
}
function ensureDir(userDataPath) {
  fs.mkdirSync(postsDir(userDataPath), { recursive: true });
}
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Read the whole index, migrating v1 (no folders) → v2. */
function readAll(userDataPath) {
  try {
    const raw = fs.readFileSync(indexPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    const folders = (Array.isArray(parsed?.folders) ? parsed.folders : [])
      .filter((f) => f && typeof f.id === "string")
      .map((f) => ({
        id: f.id,
        name: typeof f.name === "string" ? f.name : "Папка",
        createdAt: Number(f.createdAt) || Date.now(),
      }));
    const folderIds = new Set(folders.map((f) => f.id));
    const posts = (Array.isArray(parsed?.posts) ? parsed.posts : [])
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({
        id: p.id,
        title: typeof p.title === "string" ? p.title : "Без названия",
        // A post pointing at a deleted folder falls back to root.
        folderId: typeof p.folderId === "string" && folderIds.has(p.folderId) ? p.folderId : null,
        createdAt: Number(p.createdAt) || Date.now(),
        updatedAt: Number(p.updatedAt) || Number(p.createdAt) || Date.now(),
      }));
    return { folders, posts };
  } catch {
    return { folders: [], posts: [] };
  }
}

async function writeAll(userDataPath, data) {
  ensureDir(userDataPath);
  const payload = { v: 2, folders: data.folders || [], posts: data.posts || [] };
  const tmp = indexPath(userDataPath) + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.promises.rename(tmp, indexPath(userDataPath));
}

function listPosts(userDataPath) {
  return readAll(userDataPath).posts.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function listFolders(userDataPath) {
  return readAll(userDataPath).folders.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function readBody(userDataPath, id) {
  try {
    return await fs.promises.readFile(bodyPath(userDataPath, id), "utf8");
  } catch {
    return "";
  }
}

async function getPost(userDataPath, id) {
  const meta = readAll(userDataPath).posts.find((p) => p.id === id);
  if (!meta) return null;
  const content = await readBody(userDataPath, id);
  return { ...meta, content };
}

async function createPost(userDataPath, input = {}) {
  ensureDir(userDataPath);
  const now = Date.now();
  const id = newId("p");
  const title = String(input.title || "").trim() || "Без названия";
  const content = typeof input.content === "string" ? input.content : "";
  const data = readAll(userDataPath);
  const folderId =
    typeof input.folderId === "string" && data.folders.some((f) => f.id === input.folderId)
      ? input.folderId
      : null;
  await fs.promises.writeFile(bodyPath(userDataPath, id), content, "utf8");
  const meta = { id, title, folderId, createdAt: now, updatedAt: now };
  data.posts.push(meta);
  await writeAll(userDataPath, data);
  return { ...meta, content };
}

async function updatePost(userDataPath, id, patch = {}) {
  const data = readAll(userDataPath);
  const idx = data.posts.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`post not found: ${id}`);
  const now = Date.now();
  if (typeof patch.title === "string") {
    data.posts[idx] = { ...data.posts[idx], title: patch.title.trim() || "Без названия" };
  }
  if (typeof patch.content === "string") {
    await fs.promises.writeFile(bodyPath(userDataPath, id), patch.content, "utf8");
  }
  if ("folderId" in patch) {
    const fid =
      typeof patch.folderId === "string" && data.folders.some((f) => f.id === patch.folderId)
        ? patch.folderId
        : null;
    data.posts[idx] = { ...data.posts[idx], folderId: fid };
  }
  data.posts[idx] = { ...data.posts[idx], updatedAt: now };
  await writeAll(userDataPath, data);
  const content = await readBody(userDataPath, id);
  return { ...data.posts[idx], content };
}

/** Move a post into a folder (folderId=null → root). */
async function movePost(userDataPath, id, folderId) {
  const data = readAll(userDataPath);
  const idx = data.posts.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`post not found: ${id}`);
  const fid =
    typeof folderId === "string" && data.folders.some((f) => f.id === folderId) ? folderId : null;
  data.posts[idx] = { ...data.posts[idx], folderId: fid, updatedAt: Date.now() };
  await writeAll(userDataPath, data);
  return data.posts[idx];
}

async function removePost(userDataPath, id) {
  const data = readAll(userDataPath);
  const next = data.posts.filter((p) => p.id !== id);
  if (next.length === data.posts.length) return { ok: false, reason: "not-found" };
  await writeAll(userDataPath, { ...data, posts: next });
  try {
    await fs.promises.unlink(bodyPath(userDataPath, id));
  } catch {
    /* body already gone */
  }
  return { ok: true, id };
}

async function createFolder(userDataPath, input = {}) {
  const data = readAll(userDataPath);
  const folder = { id: newId("f"), name: String(input.name || "").trim() || "Новая папка", createdAt: Date.now() };
  data.folders.push(folder);
  await writeAll(userDataPath, data);
  return folder;
}

async function renameFolder(userDataPath, id, name) {
  const data = readAll(userDataPath);
  const idx = data.folders.findIndex((f) => f.id === id);
  if (idx === -1) throw new Error(`folder not found: ${id}`);
  data.folders[idx] = { ...data.folders[idx], name: String(name || "").trim() || data.folders[idx].name };
  await writeAll(userDataPath, data);
  return data.folders[idx];
}

/** Delete a folder; its posts fall back to root (not deleted). */
async function removeFolder(userDataPath, id) {
  const data = readAll(userDataPath);
  const next = data.folders.filter((f) => f.id !== id);
  if (next.length === data.folders.length) return { ok: false, reason: "not-found" };
  const posts = data.posts.map((p) => (p.folderId === id ? { ...p, folderId: null } : p));
  await writeAll(userDataPath, { folders: next, posts });
  return { ok: true, id };
}

/** Search across title AND body; returns matching metadata, newest first. */
async function searchPosts(userDataPath, query) {
  const q = String(query || "").trim().toLowerCase();
  const all = listPosts(userDataPath);
  if (!q) return all;
  const out = [];
  for (const meta of all) {
    if (meta.title.toLowerCase().includes(q)) {
      out.push(meta);
      continue;
    }
    const body = await readBody(userDataPath, meta.id);
    if (body.toLowerCase().includes(q)) out.push(meta);
  }
  return out;
}

module.exports = {
  listPosts,
  listFolders,
  getPost,
  createPost,
  updatePost,
  movePost,
  removePost,
  createFolder,
  renameFolder,
  removeFolder,
  searchPosts,
  readBody,
};
