/**
 * Posts store — Telegraph-style markdown posts.
 *
 * On disk (userData/posts/):
 *   index.json        { v:1, posts: [{ id, title, createdAt, updatedAt }] }
 *   <id>.md           the markdown body of each post
 *
 * The index carries metadata (fast list/search by title); the body lives in a
 * real .md file so posts are portable and the agent can read/write them.
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

function newId() {
  return `p-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function readIndex(userDataPath) {
  try {
    const raw = fs.readFileSync(indexPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    const posts = Array.isArray(parsed?.posts) ? parsed.posts : [];
    return posts
      .filter((p) => p && typeof p.id === "string")
      .map((p) => ({
        id: p.id,
        title: typeof p.title === "string" ? p.title : "Без названия",
        createdAt: Number(p.createdAt) || Date.now(),
        updatedAt: Number(p.updatedAt) || Number(p.createdAt) || Date.now(),
      }));
  } catch {
    return [];
  }
}

async function writeIndex(userDataPath, posts) {
  ensureDir(userDataPath);
  const tmp = indexPath(userDataPath) + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, posts }, null, 2), "utf8");
  await fs.promises.rename(tmp, indexPath(userDataPath));
}

/** Metadata list, newest-updated first. */
function listPosts(userDataPath) {
  return readIndex(userDataPath).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function readBody(userDataPath, id) {
  try {
    return await fs.promises.readFile(bodyPath(userDataPath, id), "utf8");
  } catch {
    return "";
  }
}

/** Full post: metadata + markdown body. */
async function getPost(userDataPath, id) {
  const meta = readIndex(userDataPath).find((p) => p.id === id);
  if (!meta) return null;
  const content = await readBody(userDataPath, id);
  return { ...meta, content };
}

async function createPost(userDataPath, input = {}) {
  ensureDir(userDataPath);
  const now = Date.now();
  const id = newId();
  const title = String(input.title || "").trim() || "Без названия";
  const content = typeof input.content === "string" ? input.content : "";
  await fs.promises.writeFile(bodyPath(userDataPath, id), content, "utf8");
  const posts = readIndex(userDataPath);
  const meta = { id, title, createdAt: now, updatedAt: now };
  posts.push(meta);
  await writeIndex(userDataPath, posts);
  return { ...meta, content };
}

async function updatePost(userDataPath, id, patch = {}) {
  const posts = readIndex(userDataPath);
  const idx = posts.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`post not found: ${id}`);
  const now = Date.now();
  if (typeof patch.title === "string") {
    posts[idx] = { ...posts[idx], title: patch.title.trim() || "Без названия" };
  }
  if (typeof patch.content === "string") {
    await fs.promises.writeFile(bodyPath(userDataPath, id), patch.content, "utf8");
  }
  posts[idx] = { ...posts[idx], updatedAt: now };
  await writeIndex(userDataPath, posts);
  const content = await readBody(userDataPath, id);
  return { ...posts[idx], content };
}

async function removePost(userDataPath, id) {
  const posts = readIndex(userDataPath);
  const next = posts.filter((p) => p.id !== id);
  if (next.length === posts.length) return { ok: false, reason: "not-found" };
  await writeIndex(userDataPath, next);
  try {
    await fs.promises.unlink(bodyPath(userDataPath, id));
  } catch {
    /* body already gone */
  }
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
  getPost,
  createPost,
  updatePost,
  removePost,
  searchPosts,
  readBody,
};
