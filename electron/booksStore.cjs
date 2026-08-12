const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const JSZip = require("jszip");
const iconv = require("iconv-lite");

const SUPPORTED = new Set([".txt", ".fb2", ".fb3", ".epub", ".pdf"]);

function rootDir(userDataPath) { return path.join(userDataPath, "books"); }
function indexPath(userDataPath) { return path.join(rootDir(userDataPath), "index.json"); }
function itemDir(userDataPath, id) { return path.join(rootDir(userDataPath), id); }
function contentPath(userDataPath, id) { return path.join(itemDir(userDataPath, id), "content.json"); }
function ensureRoot(userDataPath) { fs.mkdirSync(rootDir(userDataPath), { recursive: true }); }
function id() { return `b-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`; }
function cleanText(value) { return String(value || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim(); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function decodeXml(value) { return String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
function tag(xml, name) { return decodeXml((String(xml).match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i")) || [])[1] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function attr(xml, name) { return ((String(xml).match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i")) || [])[1] || "").trim(); }
function mimeFor(file) { const ext = path.extname(file).toLowerCase(); return ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" })[ext] || "application/octet-stream"; }
function dataUrl(buffer, name) { return `data:${mimeFor(name)};base64,${Buffer.from(buffer).toString("base64")}`; }
function plainToHtml(text) { return cleanText(text).split(/\n\s*\n/).filter(Boolean).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("\n"); }
function sanitizeHtml(html) {
  return String(html || "")
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button|video|audio)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:src|href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");
}
async function readEncodedText(filePath, xml = false) {
  const buffer = await fs.promises.readFile(filePath);
  const head = buffer.subarray(0, 256).toString("ascii");
  const declared = xml ? (head.match(/encoding\s*=\s*["']([^"']+)/i) || [])[1] : "";
  let encoding = declared || "utf8";
  if (/^(?:windows-1251|cp1251)$/i.test(encoding)) encoding = "win1251";
  let text = iconv.decode(buffer, encoding);
  if (!declared && (text.match(/�/g) || []).length > 2) text = iconv.decode(buffer, "win1251");
  return text.replace(/^\uFEFF/, "");
}
function chunks(text, size = 6500) {
  const paragraphs = cleanText(text).split(/\n\s*\n/).filter(Boolean);
  const out = []; let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length > size) { out.push(current); current = ""; }
    current += `${current ? "\n\n" : ""}${p}`;
  }
  if (current || !out.length) out.push(current);
  return out.map((part, i) => ({ id: `page-${i + 1}`, title: `Страница ${i + 1}`, html: plainToHtml(part) }));
}

function readIndex(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(userDataPath), "utf8"));
    return Array.isArray(parsed?.books) ? parsed.books : [];
  } catch { return []; }
}
async function writeIndex(userDataPath, books) {
  ensureRoot(userDataPath);
  const tmp = `${indexPath(userDataPath)}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, books }, null, 2), "utf8");
  await fs.promises.rename(tmp, indexPath(userDataPath));
}
function publicMeta(meta) { const { sourcePath, ...safe } = meta; return safe; }
function listBooks(userDataPath, query = "") {
  const q = String(query).trim().toLowerCase();
  return readIndex(userDataPath).filter((b) => !q || `${b.title} ${b.author} ${b.description}`.toLowerCase().includes(q)).sort((a, b) => b.updatedAt - a.updatedAt).map(publicMeta);
}
async function getBook(userDataPath, bookId) {
  const meta = readIndex(userDataPath).find((b) => b.id === bookId);
  if (!meta) return null;
  const content = JSON.parse(await fs.promises.readFile(contentPath(userDataPath, bookId), "utf8"));
  return { ...publicMeta(meta), chapters: content.chapters || [] };
}

async function parseTxt(filePath) {
  const text = await readEncodedText(filePath);
  const first = cleanText(text).split("\n")[0] || path.basename(filePath, path.extname(filePath));
  return { title: first.slice(0, 100), author: "", description: cleanText(text).slice(0, 240), cover: null, chapters: chunks(text) };
}
function fbXmlToHtml(xml, binaries) {
  let html = String(xml || "");
  html = html.replace(/<(?:\w+:)?image\b[^>]*(?:href|l:href|xlink:href)=["']#?([^"']+)["'][^>]*\/?\s*>/gi, (_m, key) => binaries.get(key) ? `<img src="${binaries.get(key)}" alt="">` : "");
  html = html.replace(/<(?:\w+:)?title\b[^>]*>([\s\S]*?)<\/(?:\w+:)?title>/gi, "<h2>$1</h2>")
    .replace(/<(?:\w+:)?subtitle\b[^>]*>([\s\S]*?)<\/(?:\w+:)?subtitle>/gi, "<h3>$1</h3>")
    .replace(/<(?:\w+:)?section\b[^>]*>/gi, "<section>").replace(/<\/(?:\w+:)?section>/gi, "</section>")
    .replace(/<(?:\w+:)?p\b[^>]*>/gi, "<p>").replace(/<\/(?:\w+:)?p>/gi, "</p>")
    .replace(/<(?:\w+:)?(?:emphasis|strong)\b[^>]*>/gi, "<strong>").replace(/<\/(?:\w+:)?(?:emphasis|strong)>/gi, "</strong>")
    .replace(/<(?:\w+:)?empty-line\b[^>]*\/?\s*>/gi, "<br>");
  return sanitizeHtml(html.replace(/<\/?(?:\w+:)?(?:body|FictionBook|description|title-info)[^>]*>/gi, ""));
}
async function parseFb2(filePath) {
  const xml = await readEncodedText(filePath, true);
  const binaries = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?binary\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?binary>/gi)) {
    const key = attr(m[1], "id"); const type = attr(m[1], "content-type") || "image/jpeg";
    if (key) binaries.set(key, `data:${type};base64,${m[2].replace(/\s/g, "")}`);
  }
  const body = (xml.match(/<(?:\w+:)?body\b[^>]*>([\s\S]*?)<\/(?:\w+:)?body>/i) || [])[1] || xml;
  const sections = [...body.matchAll(/<(?:\w+:)?section\b[^>]*>([\s\S]*?)<\/(?:\w+:)?section>/gi)];
  const chapters = (sections.length ? sections.map((m) => m[1]) : [body]).map((part, i) => ({ id: `chapter-${i + 1}`, title: tag(part, "title") || `Глава ${i + 1}`, html: fbXmlToHtml(part, binaries) }));
  const coverKey = attr((xml.match(/<(?:\w+:)?coverpage[\s\S]*?<(?:\w+:)?image\b([^>]*)/i) || [])[1], "href").replace(/^#/, "");
  const author = [tag(xml, "first-name"), tag(xml, "middle-name"), tag(xml, "last-name")].filter(Boolean).join(" ");
  return { title: tag(xml, "book-title") || path.basename(filePath, ".fb2"), author, description: tag(xml, "annotation"), cover: binaries.get(coverKey) || [...binaries.values()][0] || null, chapters };
}
async function zipImages(zip) {
  const images = new Map();
  await Promise.all(Object.values(zip.files).filter((f) => !f.dir && /^image\//.test(mimeFor(f.name))).map(async (f) => images.set(f.name.replace(/\\/g, "/"), dataUrl(await f.async("nodebuffer"), f.name))));
  return images;
}
function resolveZipPath(base, relative) { return path.posix.normalize(path.posix.join(path.posix.dirname(base), relative.split(/[?#]/)[0])).replace(/^\.\//, ""); }
async function parseEpubLike(filePath, isFb3 = false) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const names = Object.keys(zip.files);
  const images = await zipImages(zip);
  if (isFb3) {
    const bodyName = names.find((n) => /(?:^|\/)body\.xml$/i.test(n)) || names.find((n) => /\.xml$/i.test(n));
    if (!bodyName) throw new Error("FB3 body.xml not found");
    const xml = await zip.file(bodyName).async("string");
    const binaries = new Map([...images].map(([name, value]) => [path.posix.basename(name), value]));
    return { title: tag(xml, "book-title") || path.basename(filePath, ".fb3"), author: tag(xml, "author"), description: tag(xml, "annotation"), cover: [...images.values()][0] || null, chapters: [{ id: "chapter-1", title: tag(xml, "title") || "Книга", html: fbXmlToHtml(xml, binaries) }] };
  }
  const container = zip.file("META-INF/container.xml") ? await zip.file("META-INF/container.xml").async("string") : "";
  const opfName = attr((container.match(/<rootfile\b([^>]*)/i) || [])[1], "full-path") || names.find((n) => /\.opf$/i.test(n));
  if (!opfName || !zip.file(opfName)) throw new Error("EPUB package document not found");
  const opf = await zip.file(opfName).async("string");
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b([^>]*)\/?\s*>/gi)) manifest.set(attr(m[1], "id"), { href: attr(m[1], "href"), media: attr(m[1], "media-type"), props: attr(m[1], "properties") });
  const spine = [...opf.matchAll(/<itemref\b([^>]*)\/?\s*>/gi)].map((m) => attr(m[1], "idref"));
  const chapters = [];
  for (const key of spine) {
    const item = manifest.get(key); if (!item?.href) continue;
    const name = resolveZipPath(opfName, item.href); const entry = zip.file(name); if (!entry) continue;
    let html = await entry.async("string");
    html = html.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, "").replace(/<img\b([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (_m, a, src, b) => `<img ${a}src="${images.get(resolveZipPath(name, src)) || ""}"${b}>`);
    const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [])[1] || html;
    chapters.push({ id: `chapter-${chapters.length + 1}`, title: tag(html, "title") || `Глава ${chapters.length + 1}`, html: sanitizeHtml(body) });
  }
  const coverItem = [...manifest.values()].find((v) => /cover-image/.test(v.props)) || manifest.get(attr((opf.match(/<meta\b[^>]*name=["']cover["'][^>]*>/i) || [])[0], "content"));
  const cover = coverItem?.href ? images.get(resolveZipPath(opfName, coverItem.href)) : [...images.values()][0];
  return { title: tag(opf, "title") || path.basename(filePath, ".epub"), author: tag(opf, "creator"), description: tag(opf, "description"), cover: cover || null, chapters: chapters.length ? chapters : [{ id: "chapter-1", title: "Книга", html: "<p>Нет доступного текста.</p>" }] };
}
async function parsePdf(filePath) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: await fs.promises.readFile(filePath) });
  try {
    const result = await parser.getText();
    let imagePages = [];
    let cover = null;
    try { imagePages = (await parser.getImage({ imageThreshold: 120, imageBuffer: false, imageDataUrl: true })).pages || []; } catch {}
    try { cover = (await parser.getScreenshot({ partial: [1], desiredWidth: 420, imageBuffer: false, imageDataUrl: true })).pages?.[0]?.dataUrl || null; } catch {}
    const byPage = new Map(imagePages.map((p) => [p.pageNumber, p.images || []]));
    return { title: path.basename(filePath, ".pdf"), author: "", description: cleanText(result.text).slice(0, 240), cover, chapters: result.pages.map((p) => ({ id: `page-${p.num}`, title: `Страница ${p.num}`, html: `${plainToHtml(p.text)}${(byPage.get(p.num) || []).map((img) => `<img src="${img.dataUrl}" alt="">`).join("")}` })) };
  } finally { await parser.destroy(); }
}
async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.has(ext)) throw new Error(`Unsupported book format: ${ext}`);
  if (ext === ".txt") return parseTxt(filePath);
  if (ext === ".fb2") return parseFb2(filePath);
  if (ext === ".epub") return parseEpubLike(filePath, false);
  if (ext === ".fb3") return parseEpubLike(filePath, true);
  return parsePdf(filePath);
}
async function saveNormalized(userDataPath, parsed, extra = {}) {
  const books = readIndex(userDataPath); const now = Date.now(); const bookId = id();
  const chapters = Array.isArray(parsed.chapters) && parsed.chapters.length ? parsed.chapters : chunks(parsed.content || "");
  const wordCount = chapters.reduce((sum, c) => sum + String(c.html || "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length, 0);
  const meta = { id: bookId, title: String(extra.title || parsed.title || "Без названия"), author: String(extra.author || parsed.author || ""), description: String(extra.description || parsed.description || ""), cover: extra.cover || parsed.cover || null, format: extra.format || "book", createdAt: now, updatedAt: now, progress: 0, lastChapter: 0, positions: {}, read: false, wordCount, quotes: [] };
  await fs.promises.mkdir(itemDir(userDataPath, bookId), { recursive: true });
  await fs.promises.writeFile(contentPath(userDataPath, bookId), JSON.stringify({ v: 1, chapters }), "utf8");
  books.push(meta); await writeIndex(userDataPath, books); return publicMeta(meta);
}
async function importBook(userDataPath, filePath) { const parsed = await parseFile(filePath); return saveNormalized(userDataPath, parsed, { format: path.extname(filePath).slice(1).toUpperCase() }); }
async function cachedRemoteCover(value) {
  const url = String(value || "");
  if (!/^https?:\/\//i.test(url)) return value || null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return null;
    return `data:${response.headers.get("content-type") || "image/jpeg"};base64,${bytes.toString("base64")}`;
  } catch { return null; }
}
async function createBook(userDataPath, input = {}) {
  const cover = await cachedRemoteCover(input.cover);
  return saveNormalized(userDataPath, { title: input.title, author: input.author, description: input.description, cover, content: input.content || "", chapters: chunks(input.content || "") }, { ...input, cover, format: "AI" });
}
async function updateBook(userDataPath, bookId, patch = {}) {
  const books = readIndex(userDataPath); const i = books.findIndex((b) => b.id === bookId); if (i < 0) throw new Error("book not found");
  const allowed = ["title", "author", "description", "cover", "progress", "lastChapter", "positions", "read", "quotes"];
  const next = { ...books[i] }; for (const key of allowed) if (key in patch) next[key] = patch[key];
  next.progress = Math.max(0, Math.min(1, Number(next.progress) || 0)); next.lastChapter = Math.max(0, Number(next.lastChapter) || 0); next.updatedAt = Date.now(); books[i] = next;
  await writeIndex(userDataPath, books); return publicMeta(next);
}
async function removeBook(userDataPath, bookId) { const books = readIndex(userDataPath); const next = books.filter((b) => b.id !== bookId); if (next.length === books.length) return false; await writeIndex(userDataPath, next); await fs.promises.rm(itemDir(userDataPath, bookId), { recursive: true, force: true }); return true; }

module.exports = { SUPPORTED, listBooks, getBook, importBook, createBook, updateBook, removeBook };
