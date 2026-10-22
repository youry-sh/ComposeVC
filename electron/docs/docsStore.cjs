const fs = require("fs");
const path = require("path");

/**
 * ComposeVC Docs store.
 *
 * The IDE manual is stored as structured JSON under Electron userData (NOT
 * localStorage): a small manifest holds one entry per section (id, title,
 * summary, order), while each section's full Markdown body lives in its own
 * file so the list stays light and content can grow freely (and reference
 * images later).
 *
 * Layout:
 *   <userData>/docs/
 *     manifest.json          -> { version, createdAt, updatedAt, sections: [...] }
 *     sections/<id>.md       -> full Markdown body of a section
 */

const STORE_VERSION = 1;
/** Bump to re-write the built-in starter sections on the next launch. */
const SEED_VERSION = 2;
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 320;

function requireUserDataPath(userDataPath) {
  const value = typeof userDataPath === "string" ? userDataPath.trim() : "";
  if (!value) throw new Error("Docs require Electron userDataPath");
  return path.resolve(value);
}

function getDocsPaths(userDataPath) {
  const root = path.join(requireUserDataPath(userDataPath), "docs");
  return {
    root,
    sectionsDir: path.join(root, "sections"),
    manifestPath: path.join(root, "manifest.json"),
  };
}

function emptyManifest() {
  return { version: STORE_VERSION, seedVersion: SEED_VERSION, createdAt: Date.now(), updatedAt: Date.now(), sections: [] };
}

function makeSectionId(input) {
  const raw = String(input || "").trim().toLowerCase();
  const slug = raw
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `section-${Date.now().toString(36)}`;
}

function normalizeSection(entry) {
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || "").trim();
  if (!id) return null;
  return {
    id,
    title: String(entry.title || "Без названия").trim().slice(0, MAX_TITLE_CHARS),
    summary: String(entry.summary || "").trim().slice(0, MAX_SUMMARY_CHARS),
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
    file: String(entry.file || `sections/${id}.md`),
    createdAt: Number(entry.createdAt) || Date.now(),
    updatedAt: Number(entry.updatedAt) || Number(entry.createdAt) || Date.now(),
  };
}

async function ensureStore(userDataPath) {
  const paths = getDocsPaths(userDataPath);
  await fs.promises.mkdir(paths.sectionsDir, { recursive: true });
  try {
    await fs.promises.access(paths.manifestPath, fs.constants.F_OK);
  } catch {
    await fs.promises.writeFile(paths.manifestPath, JSON.stringify(emptyManifest(), null, 2), "utf8");
  }
  return paths;
}

async function readManifest(userDataPath) {
  const paths = await ensureStore(userDataPath);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(paths.manifestPath, "utf8"));
    const sections = Array.isArray(parsed?.sections)
      ? parsed.sections.map(normalizeSection).filter(Boolean)
      : [];
    sections.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
    return {
      version: STORE_VERSION,
      seedVersion: Number(parsed?.seedVersion) || 0,
      createdAt: Number(parsed?.createdAt) || Date.now(),
      updatedAt: Number(parsed?.updatedAt) || Date.now(),
      sections,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return emptyManifest();
    throw new Error(`Docs manifest is invalid: ${error?.message || error}`);
  }
}

/** Atomic write via temp file + rename so a crash never leaves half-written JSON. */
async function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

async function writeManifest(userDataPath, manifest) {
  const paths = await ensureStore(userDataPath);
  const next = {
    version: STORE_VERSION,
    seedVersion: Number(manifest?.seedVersion) || 0,
    createdAt: Number(manifest?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    sections: Array.isArray(manifest?.sections) ? manifest.sections.map(normalizeSection).filter(Boolean) : [],
  };
  await writeJsonAtomic(paths.manifestPath, next);
  return next;
}

function contentPath(userDataPath, section) {
  const paths = getDocsPaths(userDataPath);
  return path.join(paths.root, section.file);
}

async function readSectionContent(userDataPath, section) {
  const filePath = contentPath(userDataPath, section);
  const raw = await fs.promises.readFile(filePath, "utf8");
  // Skip an optional metadata front-matter block if present.
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0] && lines[0].startsWith("<!-- DOCS")) {
    const end = lines.findIndex((line) => line.includes("-->"));
    if (end >= 0) start = end + 1;
  }
  return lines.slice(start).join("\n").trim();
}

/** Light metadata list (no bodies) — what the sidebar renders. */
async function listDocs(userDataPath) {
  const manifest = await readManifest(userDataPath);
  return {
    version: manifest.version,
    sectionCount: manifest.sections.length,
    updatedAt: manifest.updatedAt,
    sections: manifest.sections.map(({ file, ...meta }) => meta),
  };
}

async function getDocsSection(userDataPath, id) {
  const manifest = await readManifest(userDataPath);
  const section = manifest.sections.find((entry) => entry.id === id);
  if (!section) throw new Error(`Docs section not found: ${id}`);
  const content = await readSectionContent(userDataPath, section);
  return { ...section, content };
}

async function upsertDocsSection(userDataPath, input = {}) {
  const id = makeSectionId(input.id || input.title);
  const content = String(input.content ?? input.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!content) throw new Error("Docs section requires non-empty content");
  const paths = await ensureStore(userDataPath);
  const manifest = await readManifest(userDataPath);
  const now = Date.now();
  const existing = manifest.sections.find((entry) => entry.id === id);
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : (existing?.order ?? manifest.sections.length + 1);
  const section = normalizeSection({
    id,
    title: input.title || existing?.title || id,
    summary: input.summary != null ? input.summary : existing?.summary || "",
    order,
    file: existing?.file || `sections/${id}.md`,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  });
  await writeJsonAtomic(path.join(paths.sectionsDir, `${id}.md`), content);
  const sections = existing
    ? manifest.sections.map((entry) => (entry.id === id ? section : entry))
    : [...manifest.sections, section];
  await writeManifest(userDataPath, { ...manifest, sections });
  return { ...section, content };
}

async function deleteDocsSection(userDataPath, id) {
  const manifest = await readManifest(userDataPath);
  const section = manifest.sections.find((entry) => entry.id === id);
  if (!section) return { deleted: false };
  const paths = await ensureStore(userDataPath);
  const filePath = contentPath(userDataPath, section);
  await fs.promises.rm(filePath, { force: true });
  await writeManifest(userDataPath, {
    ...manifest,
    sections: manifest.sections.filter((entry) => entry.id !== id),
  });
  return { deleted: true, id };
}

/* ───────────────────────────── Seed content ───────────────────────────── */

const SEED_SECTIONS = [
  {
    id: "workspace",
    title: "Рабочие области (Workspace)",
    summary: "Как устроены рабочие области, чат-панели и переключение между ними.",
    order: 1,
    content: `Рабочая область — это группа чат-панелей, собранных вместе. Она помогает держать задачи по разным проектам отдельно: у каждой области свои чаты, свои папки и своё расположение окон.

## Что находится слева

На левой панели два списка:

- **Сверху — рабочие области.** Один клик переключает сразу весь набор чатов.
- **Снизу — чаты текущей области.** Это отдельные агенты, каждый привязан к своей папке проекта.

## Как это работает

- У каждой чат-панели свой агент и своя папка. Переключение между панелями и областями ничего не закрывает — работа, которая уже запущена, продолжается в фоне, и прогресс не теряется.
- При возврате в область всё восстанавливается ровно в том виде, как вы оставили: активный чат, открытые ряды и их порядок.

## Основные действия

- **«+»** — добавить новую чат-панель в текущую область.
- **Значок сетки** — создать новую рабочую область (в ней сразу будет одна пустая панель).
- **«×» рядом с областью** — удалить область вместе с её чатами. Запущенная в ней работа сначала останавливается. Последнюю область удалить нельзя.
- **«×» рядом с чатом** — закрыть панель.
- **Перетаскивание панели** — собрать её в один ряд с другой, чтобы видеть несколько чатов одновременно.
- **Ctrl+H** (Cmd+H на Mac) — быстрый список для переключения чатов.

## Ограничения

- Всего можно держать до 12 чат-панелей.
- Одновременно в центре видно до 3 панелей в ряд.`,
  },
  {
    id: "chats-agent",
    title: "Чаты и работа агента",
    summary: "Что умеет агент, как он выполняет задачу и что есть в чате.",
    order: 2,
    content: `Каждая чат-панель — это разговор с ИИ-агентом, который не только отвечает, но и сам выполняет действия: читает файлы, правит код, ищет по проекту и запускает команды.

## Как начать

1. Откройте папку проекта (кнопка с названием папки сверху панели).
2. Напишите, что нужно сделать, обычными словами.
3. Отправьте сообщение.

Дальше агент работает сам: делает шаги, проверяет результат и продолжает, пока задача не будет выполнена. Прогресс виден прямо в чате.

## Что можно настраивать

- **Модель.** Для каждой панели можно выбрать свою модель — это не зависит от общих настроек.
- **Режим агента.** Есть основной режим и специальные (например, режим совета, который собирает несколько мнений, или лабораторный режим). Режим выбирается в панели чата.
- **Stop** — в любой момент прерывает текущую работу агента.

## Как хранится история

История чатов сохраняется отдельно для каждой папки проекта. Все чаты одной папки видны в одной панели, их можно переключать, копировать, вставлять и удалять.

## Полезные мелочи

- **Очередь сообщений** — можно отправить несколько сообщений подряд, они выполнятся по очереди.
- **Компакция** — когда разговор становится очень длинным, агент сжимает его, чтобы продолжить работу без потери смысла.
- **One-shot** — режим, при котором после ответа чат не сохраняет продолжение.
- **Список задач агента** — видно, что агент собирается сделать по пунктам.
- **Инструкции** — можно задать постоянные правила для агента (общие или для проекта).`,
  },
];

/** Create the docs store on first launch, and re-write the built-in starter
 *  sections when SEED_VERSION bumps. User-added sections are left untouched. */
async function seedIfEmpty(userDataPath) {
  const paths = await ensureStore(userDataPath);
  const manifest = await readManifest(userDataPath);
  const seedVersion = Number(manifest.seedVersion) || 0;
  if (manifest.sections.length && seedVersion >= SEED_VERSION) return manifest;

  const now = Date.now();
  const byId = new Map(manifest.sections.map((entry) => [entry.id, entry]));
  for (const seed of SEED_SECTIONS) {
    const existing = byId.get(seed.id);
    const section = normalizeSection({
      id: seed.id,
      title: seed.title,
      summary: seed.summary,
      order: seed.order,
      file: existing?.file || `sections/${seed.id}.md`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    });
    await fs.promises.writeFile(
      path.join(paths.sectionsDir, `${seed.id}.md`),
      seed.content.replace(/\r\n?/g, "\n").trim(),
      "utf8"
    );
    if (existing) {
      manifest.sections = manifest.sections.map((entry) => (entry.id === seed.id ? section : entry));
    } else {
      manifest.sections.push(section);
    }
  }
  await writeManifest(userDataPath, { ...manifest, seedVersion: SEED_VERSION });
  return readManifest(userDataPath);
}

module.exports = {
  STORE_VERSION,
  getDocsPaths,
  ensureStore,
  readManifest,
  listDocs,
  getDocsSection,
  upsertDocsSection,
  deleteDocsSection,
  seedIfEmpty,
};
