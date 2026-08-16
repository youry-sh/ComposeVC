const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_VERSION = 1;
const DEFAULT_CHUNK_CHARS = 6000;
const MIN_CHUNK_CHARS = 800;
const MAX_CHUNK_CHARS = 16000;
const writeQueues = new Map();

function requireUserDataPath(userDataPath) {
  const value = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!value) throw new Error("LAB-IN knowledge requires Electron userDataPath");
  return path.resolve(value);
}

function getKnowledgePaths(userDataPath) {
  const root = path.join(requireUserDataPath(userDataPath), "lab-in", "knowledge");
  return {
    root,
    chunksDir: path.join(root, "chunks"),
    manifestPath: path.join(root, "manifest.json"),
  };
}

function emptyManifest() {
  return { version: STORE_VERSION, createdAt: Date.now(), updatedAt: Date.now(), chunks: [] };
}

async function ensureStore(userDataPath) {
  const paths = getKnowledgePaths(userDataPath);
  await fs.promises.mkdir(paths.chunksDir, { recursive: true });
  try {
    await fs.promises.access(paths.manifestPath, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(paths.manifestPath, JSON.stringify(emptyManifest(), null, 2), "utf8");
  }
  return paths;
}

function normalizeStringList(value, max = 64) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\n]/)
      : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const text = String(item || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text.slice(0, 180));
    if (result.length >= max) break;
  }
  return result;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || "").trim();
  if (!/^kb-[a-zA-Z0-9-]+$/.test(id)) return null;
  return {
    id,
    title: String(entry.title || "Untitled knowledge").trim().slice(0, 240),
    file: `chunks/${id}.md`,
    tags: normalizeStringList(entry.tags),
    links: normalizeStringList(entry.links).filter((link) => link !== id),
    source: String(entry.source || "user").trim().slice(0, 500),
    hash: String(entry.hash || ""),
    charCount: Math.max(0, Number(entry.charCount) || 0),
    createdAt: Number(entry.createdAt) || Date.now(),
    updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
  };
}

async function readManifest(userDataPath) {
  const paths = await ensureStore(userDataPath);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(paths.manifestPath, "utf8"));
    const chunks = Array.isArray(parsed?.chunks)
      ? parsed.chunks.map(normalizeEntry).filter(Boolean)
      : [];
    return {
      version: STORE_VERSION,
      createdAt: Number(parsed?.createdAt) || Date.now(),
      updatedAt: Number(parsed?.updatedAt) || Date.now(),
      chunks,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyManifest();
    throw new Error(`LAB-IN knowledge manifest is invalid: ${error?.message || error}`);
  }
}

async function writeManifest(userDataPath, manifest) {
  const paths = await ensureStore(userDataPath);
  const next = {
    version: STORE_VERSION,
    createdAt: Number(manifest?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    chunks: Array.isArray(manifest?.chunks) ? manifest.chunks.map(normalizeEntry).filter(Boolean) : [],
  };
  await fs.promises.writeFile(paths.manifestPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function withWriteLock(userDataPath, operation) {
  const key = requireUserDataPath(userDataPath).toLowerCase();
  const previous = writeQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
}

function contentHash(content) {
  return crypto.createHash("sha256").update(String(content || "").trim()).digest("hex");
}

function makeChunkId() {
  return `kb-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function clampChunkChars(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CHUNK_CHARS;
  return Math.max(MIN_CHUNK_CHARS, Math.min(MAX_CHUNK_CHARS, Math.floor(number)));
}

function hardSplit(text, maxChars) {
  const chunks = [];
  let rest = String(text || "").trim();
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars + 1);
    const candidates = [window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" ")];
    const cut = candidates.find((index) => index >= Math.floor(maxChars * 0.55)) || maxChars;
    chunks.push(rest.slice(0, cut + (window[cut] === "." ? 1 : 0)).trim());
    rest = rest.slice(cut + (window[cut] === "." ? 1 : 0)).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function splitIntoChunks(content, chunkChars = DEFAULT_CHUNK_CHARS) {
  const maxChars = clampChunkChars(chunkChars);
  const clean = String(content || "").replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const blocks = clean.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const block of blocks) {
    if (block.length > maxChars) {
      flush();
      chunks.push(...hardSplit(block, maxChars));
      continue;
    }
    const joined = current ? `${current}\n\n${block}` : block;
    if (joined.length > maxChars) {
      flush();
      current = block;
    } else {
      current = joined;
    }
  }
  flush();
  return chunks;
}

function renderChunk(entry, content) {
  const metadata = {
    id: entry.id,
    title: entry.title,
    tags: entry.tags,
    links: entry.links,
    source: entry.source,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  return [
    `<!-- LAB-IN ${JSON.stringify(metadata)} -->`,
    `# ${entry.title}`,
    "",
    `Knowledge-ID: ${entry.id}`,
    `Tags: ${entry.tags.length ? entry.tags.join(", ") : "(none)"}`,
    `Links: ${entry.links.length ? entry.links.join(", ") : "(none)"}`,
    `Source: ${entry.source || "user"}`,
    "",
    String(content || "").trim(),
    "",
  ].join("\n");
}

async function readChunkContent(userDataPath, entry) {
  const paths = await ensureStore(userDataPath);
  const filePath = path.join(paths.root, entry.file);
  const raw = await fs.promises.readFile(filePath, "utf8");
  const markerEnd = raw.indexOf("\n", raw.indexOf("Source:"));
  return { raw, content: markerEnd >= 0 ? raw.slice(markerEnd).trim() : raw.trim(), filePath };
}

async function addKnowledge(userDataPath, input = {}) {
  const content = String(input.content || input.text || "").trim();
  if (!content) throw new Error("knowledge add requires non-empty content");
  const pieces = splitIntoChunks(content, input.chunkChars);
  const title = String(input.title || "User knowledge").trim().slice(0, 220) || "User knowledge";
  const tags = normalizeStringList(input.tags);
  const links = normalizeStringList(input.links);
  const source = String(input.source || "user-request").trim().slice(0, 500) || "user-request";

  return withWriteLock(userDataPath, async () => {
    const paths = await ensureStore(userDataPath);
    const manifest = await readManifest(userDataPath);
    const byHash = new Map(manifest.chunks.map((entry) => [entry.hash, entry]));
    const created = [];
    const duplicates = [];

    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const hash = contentHash(piece);
      const duplicate = byHash.get(hash);
      if (duplicate) {
        duplicates.push({ id: duplicate.id, title: duplicate.title });
        continue;
      }
      const id = makeChunkId();
      const now = Date.now();
      const entry = normalizeEntry({
        id,
        title: pieces.length > 1 ? `${title} (${index + 1}/${pieces.length})` : title,
        tags,
        links,
        source,
        hash,
        charCount: piece.length,
        createdAt: now,
        updatedAt: now,
      });
      await fs.promises.writeFile(path.join(paths.chunksDir, `${id}.md`), renderChunk(entry, piece), "utf8");
      manifest.chunks.push(entry);
      byHash.set(hash, entry);
      created.push(entry);
    }

    if (created.length) await writeManifest(userDataPath, manifest);
    return { created, duplicates, requestedChunks: pieces.length, root: paths.root };
  });
}

async function updateKnowledge(userDataPath, input = {}) {
  const id = String(input.id || "").trim();
  if (!id) throw new Error("knowledge update requires id");
  return withWriteLock(userDataPath, async () => {
    const paths = await ensureStore(userDataPath);
    const manifest = await readManifest(userDataPath);
    const index = manifest.chunks.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error(`Knowledge chunk not found: ${id}`);
    const previous = manifest.chunks[index];
    const read = await readChunkContent(userDataPath, previous);
    const content = input.content == null ? read.content : String(input.content).trim();
    if (!content) throw new Error("knowledge update content cannot be empty");
    const next = normalizeEntry({
      ...previous,
      title: input.title == null ? previous.title : input.title,
      tags: input.tags == null ? previous.tags : input.tags,
      links: input.links == null ? previous.links : input.links,
      source: input.source == null ? previous.source : input.source,
      hash: contentHash(content),
      charCount: content.length,
      updatedAt: Date.now(),
    });
    await fs.promises.writeFile(path.join(paths.chunksDir, `${id}.md`), renderChunk(next, content), "utf8");
    manifest.chunks[index] = next;
    await writeManifest(userDataPath, manifest);
    return next;
  });
}

async function getKnowledgeChunk(userDataPath, id) {
  const manifest = await readManifest(userDataPath);
  const entry = manifest.chunks.find((chunk) => chunk.id === String(id || "").trim());
  if (!entry) throw new Error(`Knowledge chunk not found: ${id}`);
  const read = await readChunkContent(userDataPath, entry);
  return { ...entry, content: read.content, path: read.filePath };
}

function tokenizeQuery(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])].slice(0, 32);
}

async function searchKnowledge(userDataPath, query, options = {}) {
  const manifest = await readManifest(userDataPath);
  const phrase = String(query || "").trim().toLowerCase();
  if (!phrase) throw new Error("knowledge search requires query");
  const terms = tokenizeQuery(phrase);
  const scored = [];
  for (const entry of manifest.chunks) {
    let read;
    try {
      read = await readChunkContent(userDataPath, entry);
    } catch {
      continue;
    }
    const title = entry.title.toLowerCase();
    const tags = entry.tags.join(" ").toLowerCase();
    const body = read.content.toLowerCase();
    let score = 0;
    if (title.includes(phrase)) score += 25;
    if (tags.includes(phrase)) score += 18;
    if (body.includes(phrase)) score += 12;
    for (const term of terms) {
      if (title.includes(term)) score += 6;
      if (tags.includes(term)) score += 5;
      if (body.includes(term)) score += 1;
    }
    if (!score) continue;
    const firstTerm = terms.find((term) => body.includes(term));
    const at = firstTerm ? body.indexOf(firstTerm) : 0;
    const start = Math.max(0, at - 180);
    scored.push({
      id: entry.id,
      title: entry.title,
      tags: entry.tags,
      links: entry.links,
      score,
      path: read.filePath,
      excerpt: read.content.slice(start, start + 700),
    });
  }
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 20));
  return scored.sort((a, b) => b.score - a.score || b.id.localeCompare(a.id)).slice(0, limit);
}

async function knowledgeLinks(userDataPath, id) {
  const manifest = await readManifest(userDataPath);
  const target = manifest.chunks.find((entry) => entry.id === String(id || "").trim());
  if (!target) throw new Error(`Knowledge chunk not found: ${id}`);
  const byId = new Map(manifest.chunks.map((entry) => [entry.id, entry]));
  const outgoing = target.links.map((link) => byId.get(link)).filter(Boolean);
  const incoming = manifest.chunks.filter((entry) => entry.links.includes(target.id));
  const targetTags = new Set(target.tags.map((tag) => tag.toLowerCase()));
  const related = manifest.chunks
    .filter((entry) => entry.id !== target.id && !outgoing.some((x) => x.id === entry.id) && !incoming.some((x) => x.id === entry.id))
    .map((entry) => ({
      entry,
      sharedTags: entry.tags.filter((tag) => targetTags.has(tag.toLowerCase())),
    }))
    .filter((item) => item.sharedTags.length)
    .sort((a, b) => b.sharedTags.length - a.sharedTags.length)
    .slice(0, 20)
    .map((item) => ({ ...item.entry, sharedTags: item.sharedTags }));
  return { target, outgoing, incoming, related };
}

async function listKnowledge(userDataPath, options = {}) {
  const manifest = await readManifest(userDataPath);
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.max(1, Math.min(250, Number(options.limit) || 100));
  return {
    total: manifest.chunks.length,
    offset,
    limit,
    chunks: manifest.chunks.slice(offset, offset + limit),
    hasMore: offset + limit < manifest.chunks.length,
  };
}

async function knowledgeStats(userDataPath) {
  const paths = await ensureStore(userDataPath);
  const manifest = await readManifest(userDataPath);
  return {
    root: paths.root,
    manifestPath: paths.manifestPath,
    chunkCount: manifest.chunks.length,
    totalChars: manifest.chunks.reduce((sum, entry) => sum + entry.charCount, 0),
    updatedAt: manifest.updatedAt,
  };
}

module.exports = {
  STORE_VERSION,
  DEFAULT_CHUNK_CHARS,
  getKnowledgePaths,
  ensureStore,
  readManifest,
  splitIntoChunks,
  addKnowledge,
  updateKnowledge,
  getKnowledgeChunk,
  searchKnowledge,
  knowledgeLinks,
  listKnowledge,
  knowledgeStats,
};
