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
const SEED_VERSION = 4;
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
  {
    id: "input-field",
    title: "Поле ввода сообщения",
    summary: "Куда вы пишете задачу для агента.",
    order: 3,
    content: `Это поле внизу чата, куда вы пишете задачу обычными словами.

## Как пользоваться

- Нажмите Enter, чтобы отправить сообщение.
- Нажмите Shift+Enter, чтобы перейти на новую строку внутри сообщения.
- Поле само растёт по мере ввода, но не бесконечно — дальше внутри появляется своя прокрутка.

## Что ещё можно

- Вставьте или перетащите картинку прямо в поле — она прикрепится к сообщению.`,
  },
  {
    id: "send",
    title: "Кнопка «Отправить»",
    summary: "Отправляет сообщение и запускает агента.",
    order: 4,
    content: `Кнопка отправки сообщения находится справа внизу, в виде круглой кнопки со стрелкой.

Она отправляет то, что вы написали (текст и прикреплённые картинки), и агент начинает работать. Пока сообщение пустое и нет картинок, кнопка неактивна.

Пока агент работает, кнопка отправки меняется на две другие: «Очередь» и «Стоп».`,
  },
  {
    id: "stop",
    title: "Кнопка «Стоп»",
    summary: "Прерывает текущую работу агента.",
    order: 5,
    content: `Останавливает текущую работу агента.

Появляется только в тот момент, когда агент что-то делает (пишет ответ или выполняет шаги). Нажатие сразу прерывает запуск — агент перестаёт вызывать инструменты и завершает.

Это безопасно: уже сделанные шаги сохраняются, а сам чат остаётся на месте.`,
  },
  {
    id: "queue",
    title: "Очередь сообщений",
    summary: "Отправляет следующее сообщение, не дожидаясь конца ответа.",
    order: 6,
    content: `Позволяет отправить следующее сообщение, не дожидаясь конца текущего ответа.

Когда агент ещё работает, вместо обычной кнопки «Отправить» появляется «Очередь». Нажмите её — сообщение встанет в очередь и выполнится автоматически сразу после того, как закончится текущая работа.

В очереди может стоять несколько сообщений подряд. Их видно над полем ввода, и любое можно убрать.`,
  },
  {
    id: "attach-images",
    title: "Прикрепить изображения",
    summary: "Добавляет картинки к сообщению.",
    order: 7,
    content: `Кнопка с иконкой картинки слева внизу открывает выбор изображений с компьютера.

Можно прикрепить сразу несколько картинок. Они появятся над полем ввода, и их можно удалить до отправки.

Также картинку можно просто вставить из буфера обмена или перетащить в поле ввода.`,
  },
  {
    id: "thinking-max",
    title: "Thinking-max",
    summary: "Включает расширенное размышление для каждого запроса.",
    order: 8,
    content: `Режим, который включает расширенное размышление для каждого запроса.

Когда он включён (кнопка с иконкой мозга подсвечена), агент перед ответом подробнее обдумывает задачу. Это помогает на сложных или неоднозначных задачах, но занимает чуть больше времени.

Выключается повторным нажатием.`,
  },
  {
    id: "context-ring",
    title: "Кольцо контекста",
    summary: "Показывает, насколько заполнена память разговора.",
    order: 9,
    content: `Маленькое кольцо показывает, насколько заполнена память разговора.

Оно показывает, сколько места уже занято от общего лимита. Цвет меняется: нормальный — спокойный, ближе к заполнению — жёлтый, почти заполнено — красный.

Когда место заканчивается, кольцо предлагает «сжать» разговор — агент сократит историю, сохранив суть, и продолжит работу.`,
  },
  {
    id: "mcp-connector",
    title: "Подключение MCP-серверов",
    summary: "Управление внешними инструментами (MCP-серверами).",
    order: 10,
    content: `Кнопка подключения внешних инструментов (MCP-серверов).

MCP — это способ подключать к агенту дополнительные инструменты и источники данных. Через эту кнопку видно, какие серверы подключены, и их можно включить или отключить прямо из чата.`,
  },
  {
    id: "web-engine",
    title: "Открыть сайт в Web Engine",
    summary: "Открывает проект во встроенном браузере.",
    order: 11,
    content: `Кнопка с глобусом открывает текущий проект в Web Engine.

Web Engine — это встроенный браузер IDE. Нажатие переносит папку проекта туда, чтобы посмотреть сайт или приложение в действии.`,
  },
  {
    id: "model-picker",
    title: "Выбор модели",
    summary: "Выбирает ИИ-модель для текущей панели.",
    order: 12,
    content: `Выпадающий список с выбором модели для этой панели.

Здесь выбирается, какая ИИ-модель будет отвечать в этом чате. Выбор работает только для текущей панели и не меняет общие настройки.

Если моделей нет, нужно сначала добавить их в настройках провайдеров.`,
  },
  {
    id: "agent-mode",
    title: "Режим агента",
    summary: "Выбирает, как агент работает над задачей.",
    order: 13,
    content: `Выпадающий список с режимом работы агента.

Доступны режимы:

- **ComposeVC** — основной агент, выполняет задачу сам.
- **LAB-IN** — сначала уточняет задачу и исследует, потом выполняет.
- **FoRtani + LAB-IN** — сначала проверяет результат, потом агент исправляет.

Режим выбирается на текущую панель.`,
  },
  {
    id: "tools-menu",
    title: "Меню инструментов",
    summary: "Дополнительные настройки чата.",
    order: 14,
    content: `Кнопка «Инструменты» открывает меню дополнительных настроек чата.

Внутри два пункта:

- **Авто-вставка** — список сообщений, которые подставляются автоматически.
- **Инструкции** — постоянные правила для агента.

Меню закрывается повторным нажатием или кликом мимо.`,
  },
  {
    id: "auto-insert",
    title: "Авто-вставка",
    summary: "Сообщения, которые подставляются к каждому запросу.",
    order: 15,
    content: `Список сообщений, которые автоматически добавляются к каждому вашему запросу.

Например, можно задать постоянную приписку вроде «отвечай коротко» — она будет подставляться сама при каждой отправке.

Включается и выключается, список можно редактировать: добавлять и удалять сообщения.`,
  },
  {
    id: "instructions",
    title: "Инструкции",
    summary: "Постоянные правила для агента.",
    order: 16,
    content: `Постоянные правила для агента.

Есть два уровня:

- **Общие** — действуют везде, во всех чатах и проектах.
- **Для проекта** — действуют только в открытой папке.

Здесь задаются правила, которые агент будет соблюдать в работе, например стиль кода или требования к ответам.`,
  },
  {
    id: "work-timer",
    title: "Таймер работы",
    summary: "Обратный отсчёт, когда агенту задана минимальная длительность.",
    order: 17,
    content: `Показывает оставшееся время, когда агенту задана минимальная длительность работы.

Если вы попросили агента работать определённое число минут, здесь появляется табло с обратным отсчётом и полоской прогресса.

Пока таймер идёт, агент продолжает работать и не завершает ответ раньше времени.`,
  },
  {
    id: "background-tasks",
    title: "Фоновые задачи",
    summary: "Процессы, которые агент запустил в фоне.",
    order: 18,
    content: `Показывает процессы, которые агент запустил в фоне, например серверы или сборку.

Видно, что сейчас работает, и можно остановить любой процесс вручную. Полезно, если агент запустил что-то долгое, а вы хотите это завершить.`,
  },
  {
    id: "webengine",
    title: "Web Engine — обзор",
    summary: "Встроенный браузер для открытия сайта прямо в IDE.",
    order: 19,
    content: `Web Engine — это вкладка, где можно открыть сайт или localhost-приложение прямо внутри IDE и посмотреть его в действии.

Здесь есть адресная строка, просмотр страницы, встроенные инструменты разработчика (F12), инспектор элементов и консоль.

Сайт привязывается к чату: каждый чат открывает свою страницу, и они не мешают друг другу.

В обычном браузере (без приложения) доступен только просмотр — инспектор, консоль и DevTools работают в десктопном приложении.`,
  },
  {
    id: "webengine-address",
    title: "Адресная строка",
    summary: "Ввод адреса сайта или localhost-страницы.",
    order: 20,
    content: `Адресная строка находится сверху. В неё можно ввести адрес сайта или localhost-страницы.

Как открыть: введите адрес и нажмите Enter или кнопку «Открыть» (лупа справа).

Адрес без порта (обычный сайт) открывается по https. Адрес localhost или с портом — по http. Это нужно для того, чтобы сразу открывать проекты, которые запущены локально.`,
  },
  {
    id: "webengine-navigation",
    title: "Назад, вперёд, перезагрузка",
    summary: "Навигация по странице.",
    order: 21,
    content: `Три кнопки слева управляют навигацией:

- **Назад** — вернуться на предыдущую страницу.
- **Вперёд** — перейти вперёд после «назад».
- **Перезагрузить / Стоп** — перезагрузить страницу, а во время загрузки — остановить её.

Кнопки активны только когда страница открыта.`,
  },
  {
    id: "webengine-find-localhost",
    title: "Найти localhost",
    summary: "Автоматический поиск запущенного dev-сервера.",
    order: 22,
    content: `Кнопка «Найти localhost» автоматически ищет запущенный dev-сервер проекта.

Когда открыта папка проекта, кнопка проверяет, запущен ли сервер, и если да — сразу открывает его адрес.

Полезно, когда не помнишь порт: кнопка находит сервер сама.`,
  },
  {
    id: "webengine-inspector",
    title: "Инспектор элементов",
    summary: "Рассматривание и выбор элементов страницы.",
    order: 23,
    content: `Инспектор (иконка прицела) позволяет рассматривать элементы страницы.

Включите инспектор, затем:

- наведите курсор на элемент — он подсветится, справа появится его описание;
- кликните по элементу — он зафиксируется, и справа будет виден его селектор, id, классы, HTML и текст.

Селектор и HTML можно скопировать одной кнопкой. Выключается инспектор повторным нажатием.`,
  },
  {
    id: "webengine-devtools",
    title: "DevTools (F12)",
    summary: "Встроенные инструменты разработчика.",
    order: 24,
    content: `Кнопка DevTools (иконка жука) открывает встроенные инструменты разработчика — те же, что в браузере по F12.

Там можно смотреть сеть, элементы, стили и отлаживать страницу как обычно.

Работает только в десктопном приложении.`,
  },
  {
    id: "webengine-console",
    title: "Консоль",
    summary: "Сообщения со страницы: ошибки, предупреждения, логи.",
    order: 25,
    content: `Консоль показывает сообщения со страницы: ошибки, предупреждения и обычные логи.

Она находится справа. Кнопка с иконкой терминала показывает или скрывает её.

Каждую запись можно выделить кликом, а потом скопировать выбранные. Также есть кнопки «Скопировать логи» и «Очистить».`,
  },
  {
    id: "webengine-external",
    title: "Открыть во внешнем браузере",
    summary: "Открывает страницу в системном браузере.",
    order: 26,
    content: `Кнопка «Открыть во внешнем браузере» (иконка с внешней ссылкой) открывает текущую страницу в системном браузере.

Полезно, если нужно посмотреть сайт вне IDE.`,
  },
  {
    id: "webengine-device-mode",
    title: "Режим устройства",
    summary: "Имитация мобильного, планшета и десктопа.",
    order: 27,
    content: `Режим устройства (иконка телефона) переключает ширину страницы, имитируя разные экраны.

Нажатия переключают: мобильный → планшет → обычный рабочий стол → и снова по кругу.

Удобно проверять, как сайт выглядит на телефоне и планшете.`,
  },
  {
    id: "webengine-zoom",
    title: "Масштаб страницы",
    summary: "Увеличение, уменьшение и сброс масштаба.",
    order: 28,
    content: `Кнопки масштаба меняют размер страницы.

- **Минус** — уменьшить.
- **Плюс** — увеличить.
- **Сброс** (иконка развернуть) — вернуть обычный размер (100%).

Текущий процент виден в подсказке кнопки сброса. Работает только в десктопном приложении.`,
  },
  {
    id: "webengine-screenshot",
    title: "Скриншот",
    summary: "Снимок страницы в буфер обмена.",
    order: 29,
    content: `Кнопка «Скриншот» (иконка камеры) делает снимок страницы и кладёт его в буфер обмена.

Дальше снимок можно вставить куда угодно. Работает только в десктопном приложении.`,
  },
  {
    id: "webengine-clear-cache",
    title: "Очистить кэш",
    summary: "Удаляет сохранённые данные страницы и перезагружает её.",
    order: 30,
    content: `Кнопка «Очистить кэш» (иконка ластика) удаляет сохранённые данные страницы и перезагружает её заново.

Полезно, когда сайт показывает старую версию или завис. Работает только в десктопном приложении.`,
  },
  {
    id: "webengine-copy-errors",
    title: "Скопировать ошибки",
    summary: "Копирует все ошибки консоли сразу.",
    order: 31,
    content: `Кнопка «Скопировать ошибки» (иконка восклицательного знака) копирует сразу все ошибки из консоли.

Если ошибок нет, кнопка неактивна. Удобно, когда нужно показать ошибки агенту или разработчику.`,
  },
  {
    id: "webengine-copy-html",
    title: "Скопировать HTML элемента",
    summary: "Копирует HTML-код выбранного элемента.",
    order: 32,
    content: `Кнопка «Скопировать HTML» (иконка кода) копирует HTML-код выбранного элемента.

Сначала выберите элемент в инспекторе (клик по нему), затем нажмите кнопку. Если элемент не выбран, кнопка неактивна.`,
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
