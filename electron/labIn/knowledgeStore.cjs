const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_VERSION = 1;
const DEFAULT_CHUNK_CHARS = 6000;
const MIN_CHUNK_CHARS = 800;
const MAX_CHUNK_CHARS = 16000;
const SEARCH_DEFAULT_LIMIT = 12;
const SEARCH_MAX_LIMIT = 30;
const writeQueues = new Map();
const searchCache = new Map();
const searchEpoch = new Map();
const corpusLoads = new Map();

const STOPWORDS = new Set(
  `a an the and or of to for in on at by from with without into over after before as is are was were be been being this that these those it its if then else when where how what which who whom not no nor so than too very just also only about between among per via using use used can may should would could will shall do does did done have has had having you your we our they their i me my
я ты вы мы он она они его ее её их меня мне нас вам этот эта это эти тот та те такой такая такое такие не ни да или но а в во на с со к ко по о об от до для без при через над под между из у же ли бы как что чем кто где когда какой какая какое какие уже еще ещё только можно нужно надо если то есть быть был была были будет все всё этот
the this that with from into your`.split(/\s+/).filter(Boolean)
);

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

function invalidateSearchCache(userDataPath) {
  try {
    const key = requireUserDataPath(userDataPath).toLowerCase();
    searchCache.delete(key);
    searchEpoch.set(key, (searchEpoch.get(key) || 0) + 1);
  } catch {
    /* invalid path is handled by the caller */
  }
}

async function writeManifest(userDataPath, manifest) {
  invalidateSearchCache(userDataPath);
  const paths = await ensureStore(userDataPath);
  const next = {
    version: STORE_VERSION,
    createdAt: Number(manifest?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    chunks: Array.isArray(manifest?.chunks) ? manifest.chunks.map(normalizeEntry).filter(Boolean) : [],
  };
  await writeFileAtomic(paths.manifestPath, JSON.stringify(next, null, 2));
  return next;
}

/** Atomic JSON write: a crash can never leave a half-written manifest. */
async function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, data, "utf8");
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    if (["EPERM", "EEXIST", "EACCES"].includes(error?.code)) {
      await fs.promises.rm(filePath, { force: true }).catch(() => undefined);
      await fs.promises.rename(tmpPath, filePath);
      return;
    }
    await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
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

async function deleteKnowledge(userDataPath, id) {
  const chunkId = String(id || "").trim();
  if (!chunkId) throw new Error("knowledge delete requires id");
  return withWriteLock(userDataPath, async () => {
    const paths = await ensureStore(userDataPath);
    const manifest = await readManifest(userDataPath);
    const target = manifest.chunks.find((entry) => entry.id === chunkId);
    if (!target) throw new Error(`Knowledge chunk not found: ${chunkId}`);

    const trashDir = path.join(paths.root, "trash");
    await fs.promises.mkdir(trashDir, { recursive: true });
    const sourcePath = path.join(paths.root, target.file);
    const trashPath = path.join(trashDir, `${chunkId}-${Date.now()}.md`);
    try {
      await fs.promises.rename(sourcePath, trashPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const remaining = [];
    for (const entry of manifest.chunks) {
      if (entry.id === chunkId) continue;
      if (!entry.links.includes(chunkId)) {
        remaining.push(entry);
        continue;
      }
      const read = await readChunkContent(userDataPath, entry);
      const next = normalizeEntry({
        ...entry,
        links: entry.links.filter((link) => link !== chunkId),
        updatedAt: Date.now(),
      });
      await fs.promises.writeFile(
        path.join(paths.root, next.file),
        renderChunk(next, read.content),
        "utf8"
      );
      remaining.push(next);
    }
    manifest.chunks = remaining;
    await writeManifest(userDataPath, manifest);
    return { deleted: target, trashPath };
  });
}

async function getKnowledgeChunk(userDataPath, id) {
  const manifest = await readManifest(userDataPath);
  const entry = manifest.chunks.find((chunk) => chunk.id === String(id || "").trim());
  if (!entry) throw new Error(`Knowledge chunk not found: ${id}`);
  const read = await readChunkContent(userDataPath, entry);
  return { ...entry, content: read.content, path: read.filePath };
}

function tokenize(value, limit = Infinity) {
  const found = String(value || "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [];
  const unique = [];
  const seen = new Set();
  for (const token of found) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= limit) break;
  }
  return unique;
}

function queryTerms(phrase) {
  const raw = tokenize(phrase, 32);
  const distinctive = raw.filter((term) => !STOPWORDS.has(term));
  return (distinctive.length ? distinctive : raw).slice(0, 12);
}

function setHasPrefix(tokens, prefix) {
  if (!prefix) return false;
  for (const token of tokens) {
    if (token.startsWith(prefix)) return true;
  }
  return false;
}

function excerptAround(content, terms) {
  const body = String(content || "");
  const lower = body.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - 180);
  return body.slice(start, start + 700);
}

async function loadCorpus(userDataPath) {
  const key = requireUserDataPath(userDataPath).toLowerCase();
  const manifest = await readManifest(userDataPath);
  const cached = searchCache.get(key);
  if (cached && cached.updatedAt === manifest.updatedAt && cached.size === manifest.chunks.length) return cached;
  const pending = corpusLoads.get(key);
  if (pending) return pending;

  const epoch = searchEpoch.get(key) || 0;
  const load = (async () => {
    const docs = [];
    for (const entry of manifest.chunks) {
      let read;
      try {
        read = await readChunkContent(userDataPath, entry);
      } catch {
        continue;
      }
      const body = String(read.content || "");
      docs.push({
        entry,
        path: read.filePath,
        body,
        titleText: entry.title.toLowerCase(),
        tagText: entry.tags.join(" ").toLowerCase(),
        bodyText: body.toLowerCase(),
        titleTokens: new Set(tokenize(entry.title)),
        tagTokens: new Set(tokenize(entry.tags.join(" "))),
        bodyTokens: new Set(tokenize(body)),
      });
    }
    const corpus = { updatedAt: manifest.updatedAt, size: manifest.chunks.length, docs };
    if ((searchEpoch.get(key) || 0) === epoch) searchCache.set(key, corpus);
    return corpus;
  })().finally(() => {
    if (corpusLoads.get(key) === load) corpusLoads.delete(key);
  });
  corpusLoads.set(key, load);
  return load;
}

function documentFrequency(docs, terms) {
  const df = new Map();
  for (const term of terms) {
    let count = 0;
    for (const doc of docs) {
      if (doc.titleTokens.has(term) || doc.tagTokens.has(term) || doc.bodyTokens.has(term)) count += 1;
    }
    df.set(term, count);
  }
  return df;
}

function termWeight(df, term, total) {
  const seen = df.get(term) || 0;
  return Math.log(1 + (total - seen + 0.5) / (seen + 0.5));
}

function classifyHit(doc, phrase, terms, df, total, usePhrase) {
  const phraseInTitle = usePhrase && doc.titleText.includes(phrase);
  const phraseInTags = usePhrase && doc.tagText.includes(phrase);
  const phraseInBody = usePhrase && doc.bodyText.includes(phrase);
  let score = 0;
  if (phraseInTitle) score += 36;
  if (phraseInTags) score += 24;
  if (phraseInBody) score += 14;

  let titleHits = 0;
  let tagHits = 0;
  let bodyHits = 0;
  for (const term of terms) {
    const weight = termWeight(df, term, total);
    if (doc.titleTokens.has(term)) {
      score += 8 * weight;
      titleHits += 1;
    } else if (doc.tagTokens.has(term)) {
      score += 5 * weight;
      tagHits += 1;
    } else if (doc.bodyTokens.has(term)) {
      score += 1.5 * weight;
      bodyHits += 1;
    }
  }
  if (!score) return null;

  const rareCutoff = Math.max(3, total * 0.2);
  const midCutoff = Math.max(4, total * 0.5);
  const rareTitle = terms.some((term) => doc.titleTokens.has(term) && (df.get(term) || 0) <= rareCutoff);
  const midField = terms.some((term) => (
    doc.titleTokens.has(term) || doc.tagTokens.has(term) || doc.bodyTokens.has(term)
  ) && (df.get(term) || 0) <= midCutoff);
  let strength = "weak";
  if (phraseInTitle || phraseInTags || phraseInBody || rareTitle || titleHits + tagHits >= 2) strength = "strong";
  else if (midField && (titleHits || tagHits || bodyHits)) strength = "partial";

  return { score, strength, titleHits, tagHits, bodyHits };
}

function makeHit(doc, score, strength, via, terms) {
  return {
    id: doc.entry.id,
    title: doc.entry.title,
    tags: doc.entry.tags,
    links: doc.entry.links,
    score: Math.round(score * 10) / 10,
    strength,
    via,
    path: doc.path,
    excerpt: excerptAround(doc.body, terms),
  };
}

function sortHits(hits) {
  const strengthOrder = { strong: 3, partial: 2, weak: 1 };
  return hits.sort((a, b) =>
    b.score - a.score ||
    (strengthOrder[b.strength] || 0) - (strengthOrder[a.strength] || 0) ||
    a.id.localeCompare(b.id)
  );
}

function selectHits(sorted, limit) {
  const useful = sorted.filter((item) => item.strength === "strong" || item.strength === "partial");
  if (!useful.length) return sorted.filter((item) => item.score > 0).slice(0, Math.min(5, limit));
  const top = useful[0].score || 1;
  return useful
    .filter((item, index) => item.strength === "strong" || index < 4 || item.score >= top * 0.22)
    .slice(0, limit);
}

function finishHits(hits, limit, broadened) {
  const selected = selectHits(sortHits(hits), limit);
  selected.forEach((item, index) => {
    item.rank = index + 1;
  });
  selected.broadened = broadened;
  selected.strongest = selected[0]?.strength || "none";
  return selected;
}

async function searchKnowledge(userDataPath, query, options = {}) {
  const phrase = String(query || "").trim().toLowerCase();
  if (!phrase) throw new Error("knowledge search requires query");
  const terms = queryTerms(phrase);
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number(options.limit) || SEARCH_DEFAULT_LIMIT));
  const corpus = await loadCorpus(userDataPath);
  const docs = corpus.docs;
  const total = Math.max(1, docs.length);
  const df = documentFrequency(docs, terms);
  const usePhrase = phrase.length >= 4 && phrase.length <= 80 && terms.length > 0 && terms.length <= 6;
  const byId = new Map(docs.map((doc) => [doc.entry.id, doc]));
  const direct = [];

  for (const doc of docs) {
    const classified = classifyHit(doc, phrase, terms, df, total, usePhrase);
    if (!classified) continue;
    direct.push(makeHit(doc, classified.score, classified.strength, "direct", terms));
  }

  const directSorted = sortHits(direct);
  const directUseful = directSorted.some((item) => item.strength === "strong" || item.strength === "partial");
  if (directUseful || !docs.length) return finishHits(directSorted, limit, false);

  const broadened = new Map(directSorted.map((hit) => [hit.id, hit]));
  for (const term of terms) {
    const prefix = term.length >= 7 ? term.slice(0, 5) : term.length >= 5 ? term.slice(0, 4) : "";
    if (!prefix) continue;
    const matched = docs.filter((doc) => setHasPrefix(doc.titleTokens, prefix) || setHasPrefix(doc.tagTokens, prefix));
    if (!matched.length || matched.length > 8) continue;
    const weight = Math.max(1, termWeight(df, term, total));
    for (const doc of matched) {
      const hit = makeHit(doc, 6 + weight, "partial", "broad", terms);
      const existing = broadened.get(doc.entry.id);
      if (existing && existing.strength !== "weak" && existing.score >= hit.score) continue;
      broadened.set(doc.entry.id, hit);
    }
  }

  const parents = sortHits([...broadened.values()]).slice(0, 4);
  let linked = 0;
  for (const parent of parents) {
    const doc = byId.get(parent.id);
    if (!doc || linked >= 8) break;
    const neighborIds = new Set(doc.entry.links);
    for (const other of docs) {
      if (other.entry.links.includes(parent.id)) neighborIds.add(other.entry.id);
    }
    for (const neighborId of neighborIds) {
      if (linked >= 8 || broadened.has(neighborId)) continue;
      const neighbor = byId.get(neighborId);
      if (!neighbor) continue;
      broadened.set(neighborId, makeHit(neighbor, parent.score * 0.42, "partial", "link", terms));
      linked += 1;
    }
  }

  return finishHits([...broadened.values()], limit, true);
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

/* ── Archive snapshots (ZIP export / import) ──────────────────────────────── */

function safeChild(root, relative) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, String(relative || ""));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Archive path escapes the knowledge folder: ${relative}`);
  }
  return target;
}

function markerList(value) {
  return normalizeStringList(value).filter((item) => item.toLowerCase() !== "(none)");
}

/** Parse a stored knowledge Markdown file (with or without the LAB-IN header). */
function parseChunkFile(raw, fallbackId = "") {
  const text = String(raw || "").replace(/\r\n?/g, "\n").trim();
  const lines = text ? text.split("\n") : [];
  let meta = {};
  let markerLines = 0;
  if (lines[0]?.includes("LAB-IN")) {
    const start = lines[0].indexOf("{");
    const end = lines[0].lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        meta = JSON.parse(lines[0].slice(start, end + 1)) || {};
      } catch {
        meta = {};
      }
    }
    markerLines = 1;
  }

  const readField = (prefix) => {
    const limit = Math.min(lines.length, markerLines + 10);
    for (let index = markerLines; index < limit; index += 1) {
      const line = lines[index];
      if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
      const trimmed = line.trim();
      if (
        trimmed &&
        !line.startsWith("# ") &&
        !line.startsWith("Knowledge-ID:") &&
        !line.startsWith("Tags:") &&
        !line.startsWith("Links:") &&
        !line.startsWith("Source:")
      ) {
        break;
      }
    }
    return "";
  };

  const headingLine = lines[markerLines]?.startsWith("# ") ? lines[markerLines].slice(2).trim() : "";
  const sourceIndex = lines.findIndex(
    (line, index) => index >= markerLines && line.startsWith("Source:")
  );

  let content;
  if (sourceIndex >= 0) {
    content = lines.slice(sourceIndex + 1).join("\n").trim();
  } else {
    let start = markerLines;
    if (lines[start]?.startsWith("# ")) start += 1;
    while (start < lines.length) {
      const line = lines[start];
      if (
        !line.trim() ||
        line.startsWith("Knowledge-ID:") ||
        line.startsWith("Tags:") ||
        line.startsWith("Links:") ||
        line.startsWith("Source:")
      ) {
        start += 1;
        continue;
      }
      break;
    }
    content = lines.slice(start).join("\n").trim();
  }

  return {
    id: String(meta.id || readField("Knowledge-ID:") || fallbackId || "").trim(),
    title: String(meta.title || headingLine || "Imported knowledge").trim(),
    tags: markerList(Array.isArray(meta.tags) && meta.tags.length ? meta.tags : readField("Tags:")),
    links: markerList(Array.isArray(meta.links) && meta.links.length ? meta.links : readField("Links:")),
    source: String(meta.source || readField("Source:") || "knowledge-archive").trim(),
    content,
  };
}

/**
 * Materialise the whole knowledge base as a portable folder:
 * manifest.json + chunks/<id>.md + README.txt.
 * `destDir` must be a fresh, empty directory (the archive module owns it).
 */
async function buildKnowledgeSnapshot(userDataPath, destDir) {
  const destination = String(destDir || "").trim();
  if (!destination) throw new Error("Knowledge snapshot requires a destination directory");
  const paths = await ensureStore(userDataPath);
  const manifest = await readManifest(userDataPath);
  const destRoot = path.resolve(destination);
  const destChunks = path.join(destRoot, "chunks");
  await fs.promises.mkdir(destChunks, { recursive: true });

  const chunks = [];
  let totalChars = 0;
  for (const entry of manifest.chunks) {
    const sourcePath = safeChild(paths.root, entry.file);
    const targetPath = path.join(destChunks, `${entry.id}.md`);
    try {
      await fs.promises.copyFile(sourcePath, targetPath);
    } catch {
      continue;
    }
    chunks.push({ ...entry, file: `chunks/${entry.id}.md` });
    totalChars += entry.charCount;
  }

  const exportedAt = Date.now();
  const snapshot = {
    format: "composevc-knowledge-archive",
    archiveVersion: 1,
    version: STORE_VERSION,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    exportedAt,
    chunkCount: chunks.length,
    totalChars,
    chunks,
  };
  await writeFileAtomic(path.join(destRoot, "manifest.json"), JSON.stringify(snapshot, null, 2));
  await fs.promises.writeFile(
    path.join(destRoot, "README.txt"),
    [
      "ComposeVC / LAB-IN knowledge archive",
      "",
      `Exported: ${new Date(exportedAt).toISOString()}`,
      `Chunks: ${chunks.length}`,
      `Characters: ${totalChars}`,
      "",
      "Restore it from the Knowledge workspace with the Import ZIP button.",
      "The importer normalises chunks, skips exact duplicates and remaps links.",
      "",
    ].join("\n"),
    "utf8"
  );
  return { root: destRoot, chunkCount: chunks.length, totalChars };
}

/**
 * Restore a knowledge folder/archive into the live store.
 * - accepts manifest.json + chunks/*.md, or any tree of knowledge .md files
 * - normalises metadata, regenerates colliding ids, remaps links
 * - deduplicates by content hash and reports what happened
 */
async function importKnowledgeSnapshot(userDataPath, sourceDir) {
  const sourceRoot = path.resolve(String(sourceDir || ""));
  const sourceStat = await fs.promises.stat(sourceRoot).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`Knowledge archive folder not found: ${sourceDir || "(empty)"}`);
  }

  const candidates = new Map();
  let sourceManifest = null;
  try {
    sourceManifest = JSON.parse(
      await fs.promises.readFile(path.join(sourceRoot, "manifest.json"), "utf8")
    );
  } catch {
    sourceManifest = null;
  }

  const manifestChunks = Array.isArray(sourceManifest?.chunks) ? sourceManifest.chunks : [];
  for (const rawEntry of manifestChunks) {
    if (!rawEntry || typeof rawEntry !== "object") continue;
    const relative = String(
      rawEntry.file || (rawEntry.id ? `chunks/${rawEntry.id}.md` : "")
    ).replace(/\\/g, "/");
    if (!relative || !/\.md$/i.test(relative)) continue;
    let absolute;
    try {
      absolute = safeChild(sourceRoot, relative);
    } catch {
      continue;
    }
    const raw = await fs.promises.readFile(absolute, "utf8").catch(() => null);
    if (raw != null && !candidates.has(absolute)) candidates.set(absolute, { raw, entry: rawEntry });
  }

  // Also accept hand-made archives: any .md file inside the extracted tree.
  const stack = [sourceRoot];
  let walked = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      walked += 1;
      if (walked > 4000) break;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["__MACOSX", "trash", "node_modules"].includes(entry.name)) continue;
        stack.push(absolute);
      } else if (entry.isFile() && /\.md$/i.test(entry.name) && !candidates.has(absolute)) {
        const raw = await fs.promises.readFile(absolute, "utf8").catch(() => null);
        if (raw != null) candidates.set(absolute, { raw, entry: null });
      }
    }
  }

  if (!candidates.size) {
    throw new Error("The archive contains no knowledge chunks (.md files)");
  }

  let skipped = 0;
  const parsed = [];
  for (const [absolute, candidate] of candidates) {
    const fallbackId = path.basename(absolute, path.extname(absolute));
    const info = parseChunkFile(candidate.raw, fallbackId);
    const content = info.content.trim();
    if (!content) {
      skipped += 1;
      continue;
    }
    const meta = candidate.entry && typeof candidate.entry === "object" ? candidate.entry : {};
    const title =
      String(meta.title || info.title || "Imported knowledge").trim().slice(0, 240) ||
      "Imported knowledge";
    const tags = markerList(Array.isArray(meta.tags) ? meta.tags : info.tags);
    const links = markerList(Array.isArray(meta.links) ? meta.links : info.links);
    const source =
      String(meta.source || info.source || "knowledge-archive").trim().slice(0, 500) ||
      "knowledge-archive";
    parsed.push({
      importedId: String(meta.id || info.id || fallbackId || "").trim(),
      title,
      tags,
      links,
      source,
      content,
      hash: contentHash(content),
      createdAt: Number(meta.createdAt) || Date.now(),
      updatedAt: Number(meta.updatedAt) || Number(meta.createdAt) || Date.now(),
    });
  }

  if (!parsed.length) {
    throw new Error("The archive contains no readable knowledge content");
  }

  return withWriteLock(userDataPath, async () => {
    const paths = await ensureStore(userDataPath);
    const manifest = await readManifest(userDataPath);
    const byHash = new Map();
    for (const entry of manifest.chunks) {
      if (entry.hash) byHash.set(entry.hash, entry);
    }

    const idMap = new Map();
    const created = [];
    const sourceLinks = new Map();
    let duplicates = 0;

    for (const item of parsed) {
      const duplicate = byHash.get(item.hash);
      if (duplicate) {
        duplicates += 1;
        if (item.importedId) idMap.set(item.importedId, duplicate.id);
        continue;
      }

      let id = /^kb-[a-zA-Z0-9-]+$/.test(item.importedId) ? item.importedId : makeChunkId();
      if (manifest.chunks.some((entry) => entry.id === id)) id = makeChunkId();

      const entry = normalizeEntry({
        id,
        title: item.title,
        tags: item.tags,
        links: item.links,
        source: item.source,
        hash: item.hash,
        charCount: item.content.length,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      });
      if (!entry) continue;

      await fs.promises.writeFile(
        path.join(paths.chunksDir, `${id}.md`),
        renderChunk(entry, item.content),
        "utf8"
      );
      manifest.chunks.push(entry);
      byHash.set(entry.hash, entry);
      created.push(entry);
      sourceLinks.set(entry.id, item.links);
      if (item.importedId) idMap.set(item.importedId, id);
    }

    // Links point at ids from the archive; remap them to the ids that now exist.
    const validIds = new Set(manifest.chunks.map((entry) => entry.id));
    let remappedLinks = 0;
    for (let index = 0; index < created.length; index += 1) {
      const entry = created[index];
      const original = sourceLinks.get(entry.id) || [];
      const nextLinks = [];
      for (const link of original) {
        const mapped = idMap.get(link) || link;
        if (mapped !== link) remappedLinks += 1;
        if (mapped !== entry.id && validIds.has(mapped) && !nextLinks.includes(mapped)) {
          nextLinks.push(mapped);
        }
      }
      if (nextLinks.join("\u0000") === entry.links.join("\u0000")) continue;

      const read = await readChunkContent(userDataPath, entry);
      const next = normalizeEntry({
        ...entry,
        links: nextLinks,
        updatedAt: Date.now(),
      });
      await fs.promises.writeFile(
        path.join(paths.chunksDir, `${entry.id}.md`),
        renderChunk(next, read.content),
        "utf8"
      );
      const manifestIndex = manifest.chunks.findIndex((item) => item.id === entry.id);
      if (manifestIndex >= 0) manifest.chunks[manifestIndex] = next;
      created[index] = next;
    }

    if (created.length) await writeManifest(userDataPath, manifest);

    return {
      root: paths.root,
      imported: created.length,
      duplicates,
      skipped,
      remappedLinks,
      totalChunks: manifest.chunks.length,
      created,
      importedIds: created.map((entry) => entry.id),
      totalChars: created.reduce((sum, entry) => sum + entry.charCount, 0),
    };
  });
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
  deleteKnowledge,
  getKnowledgeChunk,
  searchKnowledge,
  knowledgeLinks,
  listKnowledge,
  knowledgeStats,
  buildKnowledgeSnapshot,
  importKnowledgeSnapshot,
};
