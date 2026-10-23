const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * ComposeVC Prompts store — user prompt snippets for the "Prompts" tab in the
 * Шторы (blinds) drawer.
 *
 * Stored as a single versioned JSON file under Electron userData (NOT
 * localStorage / IndexedDB), written atomically (temp file in the same
 * directory → fsync → rename) so a crash never leaves half-written JSON.
 *
 * Layout:
 *   <userData>/prompts/prompts.json  -> { version, createdAt, updatedAt, prompts: [...] }
 *
 * Corrupt/unparseable data is reported as an error and the file is NEVER
 * overwritten until a valid state is read back — the renderer shows the error
 * and blocks edits instead of silently wiping the user's prompts.
 */

const STORE_VERSION = 1;
const MAX_TITLE_CHARS = 300;
const MAX_TEXT_CHARS = 1_000_000;

function requireUserDataPath(userDataPath) {
  const value = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!value) throw new Error("Prompts require Electron userDataPath");
  return path.resolve(value);
}

function target(userDataPath) {
  return path.join(requireUserDataPath(userDataPath), "prompts", "prompts.json");
}

function emptyStore() {
  return { version: STORE_VERSION, createdAt: Date.now(), updatedAt: Date.now(), prompts: [] };
}

function makeId() {
  return `pr-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

/** Parse, don't trust: normalize a single entry into a typed prompt or drop it. */
function normalizePrompt(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = String(entry.id || "").trim();
  if (!id) return null;
  const title = String(entry.title == null ? "" : entry.title);
  const text = String(entry.text == null ? "" : entry.text).replace(/\r\n?/g, "\n");
  return {
    id,
    title,
    text,
    createdAt: Number(entry.createdAt) || Date.now(),
    updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
  };
}

async function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  // tmp lives beside the target so the final rename() stays atomic on one fs.
  const handle = await fs.promises.open(tmpPath, "w");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmpPath, filePath);
  try {
    const dirHandle = await fs.promises.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is best-effort (unsupported on some platforms).
  }
}

async function ensureStore(userDataPath) {
  const file = target(userDataPath);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.promises.access(file, fs.constants.F_OK);
  } catch {
    await writeJsonAtomic(file, emptyStore());
  }
  return file;
}

/**
 * Read the whole store. Throws on corrupt JSON (caller shows the message and
 * refuses to write); returns an empty store when the file is missing.
 */
async function readAll(userDataPath) {
  const file = await ensureStore(userDataPath);
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    throw new Error(`Файл промтов повреждён и не был изменён: ${error?.message || error}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Файл промтов повреждён (не является объектом) и не был изменён.");
  }
  const prompts = Array.isArray(parsed.prompts)
    ? parsed.prompts.map(normalizePrompt).filter(Boolean)
    : [];
  return {
    version: STORE_VERSION,
    createdAt: Number(parsed.createdAt) || Date.now(),
    updatedAt: Number(parsed.updatedAt) || Date.now(),
    prompts,
  };
}

function validateInput(input) {
  const title = String(input?.title ?? "").trim();
  const text = String(input?.text ?? "").replace(/\r\n?/g, "\n");
  if (!title) throw new Error("Заголовок промта не может быть пустым.");
  if (!text.trim()) throw new Error("Текст промта не может быть пустым.");
  if (title.length > MAX_TITLE_CHARS) {
    throw new Error(`Заголовок длиннее ${MAX_TITLE_CHARS} символов.`);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`Текст длиннее ${MAX_TEXT_CHARS} символов.`);
  }
  return { title, text };
}

async function create(userDataPath, input) {
  const clean = validateInput(input);
  const store = await readAll(userDataPath);
  const now = Date.now();
  const prompt = {
    id: makeId(),
    title: clean.title,
    text: clean.text,
    createdAt: now,
    updatedAt: now,
  };
  store.prompts.unshift(prompt);
  store.updatedAt = now;
  await writeJsonAtomic(target(userDataPath), store);
  return prompt;
}

async function update(userDataPath, id, input) {
  if (typeof id !== "string" || !id) throw new Error("Не указан id промта.");
  const store = await readAll(userDataPath);
  const index = store.prompts.findIndex((prompt) => prompt.id === id);
  if (index < 0) throw new Error("Промт не найден.");
  const existing = store.prompts[index];
  const title = input?.title != null ? String(input.title) : existing.title;
  const text = input?.text != null ? String(input.text) : existing.text;
  const clean = validateInput({ title, text });
  const prompt = {
    ...existing,
    title: clean.title,
    text: clean.text,
    updatedAt: Date.now(),
  };
  store.prompts[index] = prompt;
  store.updatedAt = Date.now();
  await writeJsonAtomic(target(userDataPath), store);
  return prompt;
}

async function remove(userDataPath, id) {
  if (typeof id !== "string" || !id) throw new Error("Не указан id промта.");
  const store = await readAll(userDataPath);
  const next = store.prompts.filter((prompt) => prompt.id !== id);
  if (next.length === store.prompts.length) throw new Error("Промт не найден.");
  store.prompts = next;
  store.updatedAt = Date.now();
  await writeJsonAtomic(target(userDataPath), store);
  return { deleted: true, id };
}

module.exports = { readAll, create, update, remove };
