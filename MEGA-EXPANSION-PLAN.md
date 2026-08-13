# ComposeVC — Mega Expansion Backlog

Дата съёмки: 2026-08-13  
**Обновление 2026-08-13:** вкладки Todo / Post / Books / YouTube удалены из продукта целиком (UI, IPC, сторы, тулы `posts`/`books`). Пункты про них в этом файле больше не актуальны.

Файл для выбора, не для слепой реализации. Каждый пункт — отдельная фича с ID. Бери по ID, не пачками «всё сразу».

---

## Как пользоваться этим файлом

1. Сначала закрой дыры из раздела 0 — это уже написанный код, который не торчит в продукт.
2. Потом бери вкладки и тулы из **P0**, потом **P1**, потом «вау».
3. Не подключай 50 тулов в системный промпт одновременно. У вас уже есть поиск кастомных тулов — тот же принцип нужен для встроенных: группы + `tool_search`.
4. Оценка: **S** = вечер, **M** = несколько дней, **L** = неделя+, **XL** = отдельный эпик.

Легенда приоритета:

| Тег | Смысл |
|-----|--------|
| P0 | Закрывает дыру или делает продукт «настоящим IDE» |
| P1 | Сильный мультипликатор к тому, что уже есть |
| P2 | Вау / космос, но можно жить без этого |
| P3 | Можно, если останется аппетит |

---

## Снимок того, что уже есть

### Вкладки (9)

| ID | Где | Что умеет сейчас |
|----|-----|------------------|
| MultiIDE | топбар | До 12 слотов чата, фон-стриминг, модель на слот, Soviet-7, Thinking-max, one-shot, Telegram-бот на слот, git aside |
| Proxy | топбар | Провайдеры, аккаунты, OAuth, роутинг, usage, ngrok, guard |
| Runner | топбар | Интервальные джобы, репорты, ретраи. Триггер только `interval` / `off` |
| Terminal | топбар | Ровно 2 pty (`1` и `2`), copy/paste, без вкладок/сессий |
| Custom Tools | топбар | Folder tools, import/export, агент пишет код тулы |

Модалки, не вкладки: Settings, Providers, Search, Storage, MCP, RunnerSend.

### Встроенные агент-тулы (~28, registry)

`read_file` `edit_file` `create_file` `list_dir` `grep` `bash` `wsl` `compact_history` `work_timer` `think` `web_search` `web_fetch` `http` `ask_user` `ask_otp` `cf_mail` `spawn_subagent` `spawn_subagent_batch` `wait_subagents` `restore_backup` `custom_tool` `proxy_manager` `telegram` `shodan` `mcp_manager` `git`

### Лежит в репо, но не в продукте

| Что | Где | Дыра |
|-----|-----|------|
| `checkCode.cjs` | `electron/tools/checkCode.cjs` | Название `chack_code`, **не зарегистрирован** в `registry.cjs` |
| `ShodanWorkspace.tsx` | `src/components/` | Пустышка: `export {}` |
| Monaco | `@monaco-editor/react` в package.json | Редактора кода в UI нет (MultiIDE — только чаты) |
| ANTI browser | папка `anti/` (Go + fingerprint Chromium) | Нет вкладки, нет агент-тулы, runner промпт врёт что browser/anti есть |
| Swarm | `electron/swarm/` | Оркестратор есть, отдельной вкладки/дашборда нет |
| Soviet-7 | `electron/soviet7/` | 7 советников, UI только бар в чате |
| `codeImpactEngine.cjs` | electron | Не выведен как тула/вкладка |
| `sizeworkout.cjs` | electron | IPC есть, вкладки нет |

### Провайдеры прокси (уже много)

openai, grok, antigravity, gemini-cli, gemini, claude-code, anthropic, kiro, cursor, windsurf, github-copilot, openrouter, perplexity, deepseek, qoder, qauth, codebuddy, codebuddy-cn, nous, zai, google-ai-studio, opencode, opencode-go, a6api, j3gb, orcarouter, customFactory.

### Темы

Только `mono`. Settings: AI / shortcuts / appearance — тонко.

---

## 0. Сначала докрутить то, что уже написано

Не новые вкладки. Быстрые победы.

- [ ] **W01** Зарегистрировать `check_code` (починить имя `chack_code` → `check_code`) и дать агенту гонять lint/test/audit. **S / P0**
- [ ] **W04** Вкладка Shodan вместо пустого `ShodanWorkspace.tsx`, поверх уже сохранённых JSON в `userData/shodan-results/`. **M / P0**
- [ ] **W05** Честно убрать «browser/anti tooling» из runner-промпта **или** сделать тулу `browser`. Сейчас ложь. **S / P0**
- [ ] **W06** Вынести MCP из модалки в нормальную вкладку (IPC уже полный). **M / P1**
- [ ] **W07** Вынести Storage из модалки во вкладку. **S / P1**
- [ ] **W08** Git Studio вкладка: GitPanel сейчас aside чата, на весь экран тесно. **M / P1**
- [ ] **W09** Tool groups + search для встроенных тулов (как у custom tools), иначе новый зоопарк убьёт контекст. **M / P0 архитектура**
- [ ] **W10** Третья+ вкладка терминала, а не хардкод `"1" \| "2"`. **M / P1**

---

## 1. Новые вкладки — 28 штук

Сейчас в топбаре 5 основных вкладок. Ниже — кандидаты. Не обязательно все в топбар: часть в overflow «More».

### Как встраивать, чтобы топбар не умер

- Топбар: MultiIDE, Proxy, Browser, Editor, Terminal, Runner (ядро).
- Группа **Agent**: Swarm, Soviet, MCP, Custom Tools.
- Группа **Library**: Mail, Telegram, Memory, Docs.
- Группа **Ops**: Git, Problems, Tests, Docker, Logs, Usage, Network.
- Overflow / command palette (`Ctrl+P` по вкладкам) — обязательно, иначе 28 кнопок = каша.

---

### TAB-01 Browser (ANTI) — P0 / L

Полноэкранный fingerprint-браузер: профили, seed, proxy, timezone/lang, captcha-helper, CDP. Агент управляет через тулу `browser`. Это ваш уникальный козырь — в репо уже движок `anti/`.

Функции вкладки: список профилей, create/clone/delete, launch visible/headless, proxy bind, cookie/session, скриншот, DOM snapshot, network log, captcha status, fingerprint report, import/export persona.

### TAB-02 Editor — P0 / L

Monaco уже в зависимостях. Настоящий редактор файлов: табы, dirty, language, minimap, jump-to-line из агента, preview markdown/image. MultiIDE сейчас без редактора — агент пишет вслепую.

### TAB-03 Review / Diff — P0 / M

Просмотр патчей агента, accept/reject hunk, side-by-side, restore_backup UI, очередь изменений по слотам. Сейчас diff есть утилита, UI почти нет.

### TAB-04 Problems — P1 / M

Диагностика: `ProblemItem` тип уже есть в `types.ts`, UI нет. Линтер, tsc, eslint, go vet — лента ошибок → клик в Editor.

### TAB-05 Git Studio — P1 / M

Полноэкран: graph, staging hunks, commit composer, stash, branches, PR list через `gh`, blame. Сейчас GitPanel урезан (fetch/pull/push/checkout + auto commit/push).

### TAB-06 MCP Hub — P1 / S

Серверы, тулы, inspect, import vscode/opencode json, test-call, логи stdio. Сейчас модалка.

### TAB-07 Storage — P1 / S

Telegram upload/accounts UI на весь экран. Сейчас модалка.

### TAB-08 Shodan Intel — P1 / M

История запросов, карта хостов, фильтры, export, сравнение прогонов. Тул уже пишет JSON.

### TAB-09 Mail — P1 / M

Inbox для `cf_mail`: ящики, письма, OTP highlight, вложения, правила. Агент уже умеет, человек — нет.

### TAB-10 Telegram Studio — P1 / L

Не бот слота, а user-client UI над тулой `telegram`: аккаунты, диалоги, поиск, отправка, реакции, inline. Сейчас только агент ходит в MTProto.

### TAB-11 Memory / Knowledge — P1 / L

Долгая память проекта: факты, решения, «как мы тут деплоим», вектор/файловый индекс, pin, forget. Сейчас память = чат-сессии.

### TAB-12 Swarm Board — P1 / M

Канбан воркеров: plan → N workers → verify. Живые карточки, файловые локи, abort one, replay. Оркестратор уже есть.

### TAB-13 Soviet Chamber — P2 / M

Стена 7 советников: полный текст слотов, голосование, dissenting opinion, replay council, смена модели совета (поле `soviet7ModelId` уже есть).

### TAB-14 Usage / FinOps — P1 / M

Не только proxy totals: стоимость по модели/слоту/дню, бюджеты, алерты, export CSV. Proxy usage уже собирается.

### TAB-15 Logs — P1 / M

Единый лог: agent loop, tools, proxy, runner, mcp, telegram, anti. Фильтры, tail, copy correlation-id.

### TAB-16 Vault — P1 / M

Секреты отдельно от чата: API keys, .env, OTP seeds. Агент запрашивает по имени, в лог не пишет. Сейчас ключи размазаны по proxy store / config.

### TAB-17 Snippets Lab — P2 / S

Мышиные кнопки 3/4 уже вставляют сниппеты. Вкладка: библиотека сниппетов, хоткеи, шаблоны промптов, переменные `$selection $file $git`.

### TAB-18 Workflows — P1 / L

Граф: trigger → agent → tools → notify. Сильнее Runner (там только interval). Визуальный пайплайн, условия, ветки.

### TAB-19 Database — P2 / L

Подключения sqlite/postgres/mysql: schema, query, explain, export. Агент-тула `db` рядом.

### TAB-20 Docker — P2 / M

Контейнеры, логи, compose up/down, exec. Для вашего electron/go стека очень практично.

### TAB-21 API Lab — P2 / M

Постман внутри: коллекции, env, история. Тула `http` уже есть — дать человеку тот же клиент.

### TAB-22 Canvas — P2 / L

Белая доска / architecture map: ноды файлов, потоки агентов, soviet seats. Cursor Canvas-like, но в вашем mono chrome.

### TAB-23 Voice — P2 / M

STT в композер, TTS ответа, push-to-talk, per-slot mute. Для «космос шумит» — must.

### TAB-24 Tests — P1 / M

Запуск test:* из package.json / go test / pytest, лента, coverage heat. Связка с `check_code`.

### TAB-25 Docs / RAG — P1 / L

Индексация открытой папки + Books + Posts: семантический поиск, цитаты со ссылкой на файл:строка. Сейчас только `grep`.

### TAB-26 Network Inspector — P2 / M

Трафик локального AI-прокси: запрос/ответ, SSE frames, какой аккаунт взял роутер, limit-detect причина. Для отладки провайдеров бесценно.

### TAB-27 Marketplace — P2 / L

Каталог folder-tools, MCP серверов, ANTI профилей, runner-шаблонов. Import из URL/gist. Custom Tools уже умеют zip import — это витрина.

### TAB-28 Notify Center — P1 / S

Единый инбокс: agent done, runner fail, mail OTP, telegram mention, budget. Сейчас звук completion разрозненный.

### Ещё вкладки, если мало (P2–P3)

- [ ] **TAB-29 PDF Lab** — читать/аннотировать PDF (pdf-parse уже в deps)
- [ ] **TAB-30 Sheets** — csv/xlsx грид, агент правит таблицы
- [ ] **TAB-31 RSS / Feeds** — подписки, дайджест в Runner
- [ ] **TAB-32 Contacts / CRM** — люди, компании, рядом с Telegram
- [ ] **TAB-33 Debugger** — breakpoints не обязательно; replay tool-trace шага агента
- [ ] **TAB-34 Plugins** — JS/folder plugin API, хуки на agent start/end
- [ ] **TAB-35 Calendar** — расписание поверх Runner + habits из Todo
- [ ] **TAB-36 Maps** — гео точек из Shodan (без атакующих сценариев)
- [ ] **TAB-37 Audio studio** — нарезка/транскрипт подкастов к Books
- [ ] **TAB-38 Screenshot wall** — галерея скринов браузера/агента
- [ ] **TAB-39 Compare models** — один промпт в 2–4 слота, scorecard
- [ ] **TAB-40 Release** — changelog, version bump, dist/package wizard

Итого вкладок-кандидатов: **40**. В топбар физически влезут ~8. Остальное — группы + palette.

---

## 2. Новые агент-тулы — 60 штук

Каждая тула = файл `electron/tools/<name>.cjs` + запись в `registry.cjs` + aliases.  
**Не класть все 60 в schema сразу.** Группы: `core` `browser` `git` `data` `ops` `comms` `intel` `media`.

### Ядро кода и IDE

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T01 | `check_code` | Уже написан. Lint/test/audit/scan. | S | P0 |
| T02 | `apply_patch` | Единый unified diff вместо кучи `edit_file`. Меньше промахов. | M | P0 |
| T03 | `delete_file` | Сейчас агент только create/edit. Удаление через bash — грязно. | S | P0 |
| T04 | `move_file` | Rename/move с обновлением git. | S | P0 |
| T05 | `glob` | Отделить от grep. Быстрый поиск путей. | S | P0 |
| T06 | `read_lints` | Диагностика файла/папки → Problems tab. | M | P1 |
| T07 | `code_symbols` | Outline/goto: functions, classes, exports (ts/go/py). | L | P1 |
| T08 | `semantic_search` | RAG по проекту. Grep не заменяет смысл. | L | P1 |
| T09 | `format_file` | prettier/gofmt/ruff по файлу. | S | P1 |
| T10 | `open_in_editor` | Сказать UI открыть path:line. | S | P0 |
| T11 | `project_map` | Компактная карта репо для старта задачи. | M | P1 |
| T12 | `code_impact` | Движок уже есть — кто сломается от патча. | M | P1 |

### Браузер / ANTI

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T13 | `browser` | CDP: goto, click, type, wait, eval, screenshot, cookies. Профили ANTI. | L | P0 |
| T14 | `browser_profile` | CRUD fingerprint persona, proxy, locale, seed. | M | P1 |
| T15 | `browser_network` | HAR/export запросов вкладки. | M | P2 |
| T16 | `captcha_status` | Статус captcha-helper, не «решатель капчи с улицы». | S | P2 |

### Git / GitHub

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T17 | `github` | `gh`: issues, PR create/review/comment, checks. У вас уже user-rule на gh. | M | P1 |
| T18 | `git_worktree` | Изолированные ветки как best-of-n. | M | P2 |
| T19 | `pr_diff` | Сводка PR + файлы для ревью. | S | P1 |

### Данные и файлы

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T20 | `todo` | Задачи/привычки вкладки Todo. | M | P0 |
| T21 | `youtube` | Плейлист + мета + транскрипт. | M | P0 |
| T22 | `pdf` | Читать/извлекать (pdf-parse уже есть). | S | P1 |
| T23 | `image` | Resize/ocr/describe через vision-модель. sharp уже в deps. | M | P1 |
| T24 | `zip` | Pack/unpack (JSZip уже есть в CTL). | S | P1 |
| T25 | `sqlite` | Локальные .db: schema/query. | M | P1 |
| T26 | `db` | Postgres/mysql readonly+write с confirm. | L | P2 |
| T27 | `csv` | Таблицы: filter, join, to markdown. | S | P2 |
| T28 | `jsonl` | Большие логи: sample, grep, stats. | S | P2 |
| T29 | `env` | Читать/писать .env через Vault, не в чат. | M | P1 |
| T30 | `notes` | Быстрые заметки ≠ Post (скретчпад агента). | S | P2 |

### Коммы и автоматизация

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T31 | `notify` | Toast/sound/telegram/desktop. | S | P1 |
| T32 | `clipboard` | Читать/писать буфер **только по явной просьбе пользователя в этом чате**. | S | P2 |
| T33 | `cron` | Создавать/менять Runner из чата. | M | P1 |
| T34 | `webhook` | Принять HTTP и стартовать агента (пара к ngrok). | M | P2 |
| T35 | `email_send` | SMTP/send из Vault, отдельно от temp-mail. | M | P2 |
| T36 | `rss` | Читать фиды → дайджест. | S | P2 |
| T37 | `calendar` | События + next-up. | M | P2 |
| T38 | `contacts` | Адресная книга. | M | P3 |

### Ops / девсреда

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T39 | `docker` | ps/logs/compose/exec. | M | P1 |
| T40 | `process` | Список процессов IDE, kill hung tool. | S | P1 |
| T41 | `sysinfo` | OS, RAM, GPU, disk — для агента, не только titlebar. | S | P2 |
| T42 | `port` | Что слушает порт, kill by port. | S | P2 |
| T43 | `npm` / `pkg` | package.json scripts, outdated, why. | S | P1 |
| T44 | `test_runner` | Запуск тестов с парсом fail list. | M | P1 |
| T45 | `coverage` | Отчёт покрытия. | M | P2 |
| T46 | `bench` | Запуск benchmark scripts. | S | P2 |
| T47 | `lsp` | Hover/def/refs через язык-сервер. | XL | P2 |
| T48 | `regex_tester` | Прогон regex на корпусе. | S | P3 |
| T49 | `diff_tool` | Diff двух путей/буферов. | S | P1 |
| T50 | `hex` | Бинарники: head, strings, hash. | S | P3 |

### Интеллект агента

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T51 | `memory` | Write/read/forget долгую память. | M | P1 |
| T52 | `recall` | Семантический поиск по прошлым чатам. | L | P1 |
| T53 | `plan` | Явный план (не todo агента): фазы, риски, стоп-условия. | S | P1 |
| T54 | `critique` | Второй проход по своему же ответу. | S | P2 |
| T55 | `model_switch` | Сменить модель слота на лету. | S | P1 |
| T56 | `delegate_slot` | Кинуть задачу в другой MultiIDE слот. | M | P2 |
| T57 | `eval` | Прогнать чеклист по результату (build+tests+diff size). | M | P1 |
| T58 | `tool_search` | Найти тулу по описанию, не держать 80 схем в контексте. | M | P0 |
| T59 | `skill` | Загрузить SKILL.md / инструкции пакета. | M | P1 |
| T60 | `canvas` | Писать/обновлять артефакт на Canvas вкладке. | M | P2 |

### Медиа и контент

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T61 | `tts` | Озвучить ответ. | M | P2 |
| T62 | `stt` | Транскрипт файла/микрофона. | M | P2 |
| T63 | `screenshot` | Скрин окна ComposeVC / браузера. | S | P1 |
| T64 | `ocr` | Текст с картинки. | M | P2 |
| T65 | `translate` | Перевод куска/файла. | S | P2 |
| T66 | `summarize_url` | Спец. поверх web_fetch: статья → тезисы + цитаты. | S | P1 |
| T67 | `book_annotate` | Цитаты/закладки Books (частично в store есть). | S | P1 |
| T68 | `post_publish` | Post → telegram/dev.to/md файл. | M | P2 |

### Прокси / модели

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T69 | `usage` | Спросить spend/quota без лезть в proxy_manager. | S | P1 |
| T70 | `route_explain` | Почему взяли этот аккаунт/модель. | M | P1 |
| T71 | `health_probe` | Пинг провайдера одной дешёвой моделью. | S | P1 |
| T72 | `catalog` | Живой список моделей аккаунта. | S | P1 |

### Безопасность продукта (оборона, не атака)

| ID | Имя | Зачем | Effort | Pri |
|----|-----|-------|--------|-----|
| T73 | `secrets_scan` | Найти ключи в репо до коммита. | M | P1 |
| T74 | `dep_audit` | npm audit / go govulncheck обёртка. | S | P1 |
| T75 | `guard_explain` | Почему proxy guard срезал запрос. | S | P2 |
| T76 | `sbom` | CycloneDX/syft если бинарь есть. | M | P3 |

Итого новых тулов: **76**. Минимум для «космоса»: T01–T13, T20–T21, T31, T51, T58, T69.

---

## 3. Функции к тому, что уже есть — 220+

Это не новые вкладки. Это кнопки, IPC, actions, UX внутри текущих модулей. Нумеруй **Fxxx** когда выбираешь.

### 3.1 MultiIDE / ChatPanel — F001–F045

Сейчас: слоты, фон-ран, one-shot, soviet-7, thinking-max, bookmarks, auto-insert, telegram bot, images, compact, queue.

- [ ] **F001** Свернуть слот в «чип» без размонтирования (место на экране).
- [ ] **F002** Drag-and-drop перестановка слотов.
- [ ] **F003** Имя слота вручную («Auth», «Docs»), не Slot N.
- [ ] **F004** Цвет/метка слота.
- [ ] **F005** Дублировать слот с тем же folder+model, пустой чат.
- [ ] **F006** Split view 2×2 без скрытия остальных (сейчас active+rail).
- [ ] **F007** Синхронный промпт во все слоты (compare models) — кнопка.
- [ ] **F008** Стоп всех слотов одной кнопкой.
- [ ] **F009** Pause агента (не abort): добить текущий tool, не брать новый.
- [ ] **F010** Retry last user message без перепечатывания.
- [ ] **F011** Edit user message + fork conversation.
- [ ] **F012** Regenerate assistant с другой моделью.
- [ ] **F013** Pin message в шапке слота.
- [ ] **F014** Jump to tool call по имени из LiveToolStrip.
- [ ] **F015** Копировать только финальный ответ, без tool dump.
- [ ] **F016** Export чата в md/json/html.
- [ ] **F017** Import чата (у вас copy/paste session IPC уже есть — кнопка в UI).
- [ ] **F018** Ветки чата (tree), не линейный лог.
- [ ] **F019** Per-chat system overlay (поверх global/project instructions).
- [ ] **F020** Per-chat tool allowlist (выключить telegram/shodan в этом слоте).
- [ ] **F021** Per-chat max iterations.
- [ ] **F022** Per-chat temperature / thinking budget UI.
- [ ] **F023** Показать raw request (для отладки прокси).
- [ ] **F024** Token breakdown: tools vs memory vs messages vs images.
- [ ] **F025** Предупреждение «контекст 90%» с кнопкой compact / new chat.
- [ ] **F026** Авто-compact уже есть по порогу — сделать видимый undo compact.
- [ ] **F027** One-shot: превью «этот чат сотрётся после ответа».
- [ ] **F028** Bookmarks: папки, поиск, open in new slot.
- [ ] **F029** История: фильтр running / one-shot / soviet / с картинками.
- [ ] **F030** История: bulk delete, bulk export.
- [ ] **F031** Drag файл/папка в композер → attach path, не только картинка.
- [ ] **F032** Attach folder as context map (file tree digest).
- [ ] **F033** Голосовой ввод в композер.
- [ ] **F034** Slash-commands: `/compact` `/todo` `/pr` `/browser`.
- [ ] **F035** Mention файла `@src/App.tsx` → авто read.
- [ ] **F036** Mention тулы `@git status`.
- [ ] **F037** Очередь сообщений: drag reorder, edit queued.
- [ ] **F038** Agent todos: drag, due, связка с вкладкой Todo.
- [ ] **F039** Показ seedTodos после краша — «продолжить задачи».
- [ ] **F040** Индикатор «этот слот пишет файлы» (dirty git).
- [ ] **F041** Confirm перед bash destructive (rm, git push) — UI ask_user шаблон.
- [ ] **F042** Картинки: paste из буфера, resize, vision toggle.
- [ ] **F043** Lightbox: annotate стрелкой, отправить кроп обратно в чат.
- [ ] **F044** Streaming markdown: таблицы/katex уже есть — добавить mermaid.
- [ ] **F045** Цитата сообщения → reply-context блок в следующем запросе.

### 3.2 Agent loop / Soviet-7 / Swarm / Thinking-max — F046–F075

- [ ] **F046** Выбор N советников 3/5/7, не только 7.
- [ ] **F047** Разные модели на разные seats (сейчас одна soviet7ModelId).
- [ ] **F048** Советник с тулами (research seat) vs tool-free (как сейчас).
- [ ] **F049** Сохранять полный council log в session, не только summary.
- [ ] **F050** Replay council без повторного user prompt.
- [ ] **F051** Голосование: majority / architect-veto / user picks winner.
- [ ] **F052** Swarm: ручной edit плана до запуска воркеров.
- [ ] **F053** Swarm: disjoint file lock visible + conflict resolver.
- [ ] **F054** Swarm: worker limit слайдер в UI (сейчас константы).
- [ ] **F055** Swarm: retry only failed workers.
- [ ] **F056** Swarm: «verify» шаг показать diff до применения.
- [ ] **F057** Thinking-max: выбрать 1/2/3 цикла в UI, не только on/off.
- [ ] **F058** Thinking-max: не глотать весь ответ, показать progress reasons (без private chain).
- [ ] **F059** Subagent: выбрать модель ≠ parent.
- [ ] **F060** Subagent: readonly mode по умолчанию для research.
- [ ] **F061** Subagent: timeout и budget tokens в spawn.
- [ ] **F062** `wait_subagents`: UI кнопка «дождаться всех» в ChatPanel.
- [ ] **F063** Лимит параллельных subagents глобально (не убить машину).
- [ ] **F064** Worker pool stats в titlebar (IPC `workerPool:stats` уже есть).
- [ ] **F065** Авто-продолжение после compact — показать banner «continued».
- [ ] **F066** Retry policy UI: сколько, какой backoff (сейчас внутри loop).
- [ ] **F067** Tool result truncation: «open full in panel».
- [ ] **F068** Parallel tool calls: визуально side-by-side, не стопка.
- [ ] **F069** Abort одного tool, остальные продолжают.
- [ ] **F070** После spawn_batch — кнопка «открыть Swarm Board».
- [ ] **F071** System prompt preview (что реально ушло, с instructions merged).
- [ ] **F072** Custom agent prompts per tool (`agentPrompts:saveTool` IPC уже есть) — редактор в Settings.
- [ ] **F073** Режим «ask then act»: всегда ask_user перед первой записью файла.
- [ ] **F074** Режим «plan only»: запрет edit/bash до явного Go.
- [ ] **F075** Корреляционный runId во все логи/UI.

### 3.3 Proxy — F076–F110

Сейчас: providers, accounts, oauth, routing, usage, ngrok, guard, custom providers.

- [ ] **F076** Стоимость $ по прайсу модели, не только токены.
- [ ] **F077** Бюджет на день/неделю, hard-stop роутера.
- [ ] **F078** Алерт в Notify когда аккаунт quota-block.
- [ ] **F079** Причина блока: показать raw limit-detect snippet.
- [ ] **F080** Ручной приоритет аккаунтов drag-and-drop (поле priority уже есть).
- [ ] **F081** Sticky session: один чат = один аккаунт.
- [ ] **F082** Failover policy editor (сейчас внутри accountRouter).
- [ ] **F083** Health worker: интервал, disable per provider.
- [ ] **F084** Кнопка «probe this account» (дешёвый ping).
- [ ] **F085** Скрыть ключи по умолчанию, reveal hold.
- [ ] **F086** Export аккаунтов encrypted, не plaintext json.
- [ ] **F087** Import из нескольких CLI сразу (у вас точечные importGrokCli / Gemini / Kiro / Claude).
- [ ] **F088** Массовый enable/disable.
- [ ] **F089** Теги аккаунтов: `cheap` `vision` `long-ctx`.
- [ ] **F090** Роут по тегу модели, не только точному id.
- [ ] **F091** Custom provider: wizard (base url, wire format, auth header).
- [ ] **F092** Проверка custom provider: list models + hello world.
- [ ] **F093** Usage: фильтр по слоту MultiIDE / runner / subagent.
- [ ] **F094** Usage: график по часам (не только totals).
- [ ] **F095** Reset usage per account, не global only.
- [ ] **F096** Ngrok: выбор региона, reserved domain, статус в titlebar.
- [ ] **F097** Локальный OpenAI-compatible endpoint уже есть — страница «как подключить Cline/OpenCode».
- [ ] **F098** API keys прокси: scopes (chat-only, no admin).
- [ ] **F099** Rate limit на входящие ключи.
- [ ] **F100** Guard: UI редактор rules.json / allowlist проектных путей.
- [ ] **F101** Guard activity live feed (activity.cjs уже пишет).
- [ ] **F102** Per-provider timeout / max tokens override.
- [ ] **F103** Vision/image: показать, умеет ли выбранный аккаунт.
- [ ] **F104** Streaming vs json mode stats (поля в usage уже есть).
- [ ] **F105** Сравнение latency p50/p95 по провайдеру.
- [ ] **F106** Авто-refresh usage на интервале с backoff.
- [ ] **F107** Duplicate key warning в UI (логика findApiKeyDuplicates уже в tool).
- [ ] **F108** OAuth session cancel заметнее, progress steps.
- [ ] **F109** Proxy popup: открепить usage в маленькое окно (частично есть) + always on top.
- [ ] **F110** Dark/light не нужно — но contrast таблиц usage, sticky header, csv export.

### 3.4 Runner — F111–F130

Сейчас: interval | off, reports, retries, max 60 concurrent.

- [ ] **F111** Триггер cron expression, не только N minutes.
- [ ] **F112** Триггер webhook.
- [ ] **F113** Триггер file-watch (chokidar на rootPath).
- [ ] **F114** Триггер git hook / после autopush.
- [ ] **F115** Триггер telegram keyword.
- [ ] **F116** Триггер «после завершения другого runner».
- [ ] **F117** Quiet hours.
- [ ] **F118** Jitter чтобы пачка джоб не стартовала в одну секунду.
- [ ] **F119** Выбор tool allowlist на джобу.
- [ ] **F120** Выбор agentMode soviet-7 / swarm на джобу.
- [ ] **F121** Dry-run.
- [ ] **F122** Diff report: что изменилось в git за прогон.
- [ ] **F123** Notify on fail → telegram/desktop.
- [ ] **F124** Retention: авто-чистка старых reports.
- [ ] **F125** Клонировать runner.
- [ ] **F126** Папки/теги раннеров.
- [ ] **F127** Calendar view расписания.
- [ ] **F128** Ручной «run with extra message» уже есть модалка — история этих сообщений.
- [ ] **F129** Concurrent limit per runner, не только global 60.
- [ ] **F130** Метрики: avg duration, cost, toolCount sparkline.

### 3.5 Terminal — F131–F145

- [ ] **F131** N сессий, не 2.
- [ ] **F132** Имя вкладки, иконка cwd.
- [ ] **F133** Split panes внутри Terminal workspace.
- [ ] **F134** Выбор shell: pwsh, cmd, git-bash, wsl distro.
- [ ] **F135** cwd = active MultiIDE folder одной кнопкой.
- [ ] **F136** Send selection to chat.
- [ ] **F137** Send command output to chat as tool-context.
- [ ] **F138** Command palette history.
- [ ] **F139** Search in buffer.
- [ ] **F140** Save buffer to file.
- [ ] **F141** Theme follow app tokens (сейчас хардкод #090909).
- [ ] **F142** Font size zoom.
- [ ] **F143** Clickable paths → Editor.
- [ ] **F144** GPU / WebGL renderer option.
- [ ] **F145** Kill process tree кнопкой, не только exit event.

### 3.6 Custom Tools — F146–F165

- [ ] **F146** Шаблоны: http client, file watcher, parser, notifier.
- [ ] **F147** Встроенный Monaco на код тулы (сейчас скорее textarea).
- [ ] **F148** Run with test payload из UI.
- [ ] **F149** Логи последнего execute.
- [ ] **F150** Timeout per tool в UI.
- [ ] **F151** Permissions: net / fs / child_process flags.
- [ ] **F152** Версии тулы + rollback.
- [ ] **F153** Зависимости npm install в toolDir кнопка (осторожно, sandbox).
- [ ] **F154** README.md превью в карточке.
- [ ] **F155** Теги фильтр + AND/OR (поиск уже есть).
- [ ] **F156** Disabled tools скрывать из агента — проверить что schema search это чтит.
- [ ] **F157** «Used N times this week» счётчик.
- [ ] **F158** Publish to Marketplace.
- [ ] **F159** Diff при import overwrite.
- [ ] **F160** Duplicate tool.
- [ ] **F161** Hot reload без рестарта Electron.
- [ ] **F162** Schema builder UI (json schema form).
- [ ] **F163** Secret refs из Vault вместо хардкода в коде тулы.
- [ ] **F164** Concurrent run lock.
- [ ] **F165** Crash report если execute кинул.

### 3.7 Todo — F166–F180

- [ ] **F166** Main-process store, не localStorage.
- [ ] **F167** Синк с agent todos.
- [ ] **F168** Приоритет / проект / теги.
- [ ] **F169** Recurring tasks.
- [ ] **F170** Напоминание desktop.
- [ ] **F171** Привычки: подписи недель, streak, heatmap compact.
- [ ] **F172** Экспорт привычек CSV.
- [ ] **F173** Несколько досок.
- [ ] **F174** Фильтр done / today.
- [ ] **F175** Markdown в задаче.
- [ ] **F176** Чеклист внутри задачи.
- [ ] **F177** Связь задачи с чатом/сессией.
- [ ] **F178** Undo delete.
- [ ] **F179** Горячая клавиша «быстрая задача».
- [ ] **F180** Агент отмечает квадрат привычки через тулу.

### 3.8 Post — F181–F195

- [ ] **F181** Поиск по телу, не только list meta.
- [ ] **F182** Теги и pin.
- [ ] **F183** Templates.
- [ ] **F184** Preview split (md уже рендерится в чате — тот же MarkdownContent).
- [ ] **F185** Wiki-links `[[other post]]`.
- [ ] **F186** Backlinks.
- [ ] **F187** Version history / restore.
- [ ] **F188** Export folder as md tree.
- [ ] **F189** Publish to Telegram.
- [ ] **F190** Cover image.
- [ ] **F191** Word count / reading time.
- [ ] **F192** Daily note кнопка.
- [ ] **F193** Nested folders.
- [ ] **F194** Drag post between folders (move IPC есть).
- [ ] **F195** Full-text в Docs/RAG индекс.

### 3.9 Books — F196–F210

- [ ] **F196** EPUB/PDF import качество (worker уже есть — прогресс в UI).
- [ ] **F197** Оглавление клик.
- [ ] **F198** Поиск по книге.
- [ ] **F199** Цитаты: список, export, агент `book_annotate`.
- [ ] **F200** Закладки позиций сильнее (positions в meta уже есть — UI).
- [ ] **F201** Ночной/дневной читалка, шрифт, ширина колонки.
- [ ] **F202** TTS чтение главы.
- [ ] **F203** Прогресс % в библиотеке крупнее.
- [ ] **F204** Коллекции/полки.
- [ ] **F205** Серия книг.
- [ ] **F206** Импорт из URL.
- [ ] **F207** Агент: «прочитай главу N и законспектируй в Post».
- [ ] **F208** Словарь/перевод выделенного.
- [ ] **F209** Cover fetch.
- [ ] **F210** Удаление с confirm и undo.

### 3.10 YouTube — F211–F225

- [ ] **F211** Авто-title oEmbed.
- [ ] **F212** Длительность, канал, thumbnail hq.
- [ ] **F213** Плейлисты / папки.
- [ ] **F214** Транскрипт (captions) кнопка + тула.
- [ ] **F215** Заметки таймкода.
- [ ] **F216** Speed 1.25/1.5/2, remember position.
- [ ] **F217** Mini-player поверх другой вкладки.
- [ ] **F218** Watch later / favorites.
- [ ] **F219** Импорт playlist URL.
- [ ] **F220** Агент: саммари видео в Post.
- [ ] **F221** Не только YouTube: vimeo/local file.
- [ ] **F222** Keyboard space/f в плеере.
- [ ] **F223** Карточки: фильтр watched.
- [ ] **F224** Queue autoplay next.
- [ ] **F225** Open in ANTI browser profile.

### 3.11 Git panel / git tool — F226–F245

Тула: status, log, diff, show, branches, add, commit, checkout, create_branch, stash*, fetch, pull, push, raw. UI: graph 60, auto commit/push.

- [ ] **F226** Stage hunk, не весь файл.
- [ ] **F227** Unstage / discard hunk с confirm.
- [ ] **F228** Commit template + conventional commits.
- [ ] **F229** Amend только если свой HEAD и не pushed (правила как в Cursor).
- [ ] **F230** Create PR кнопка.
- [ ] **F231** Blame view.
- [ ] **F232** File history.
- [ ] **F233** Merge / rebase UI (сейчас destructive filter в tool).
- [ ] **F234** Conflict editor.
- [ ] **F235** Stash apply/drop/show.
- [ ] **F236** Tag / release.
- [ ] **F237** LFS indicator.
- [ ] **F238** Submodule status.
- [ ] **F239** Graph limit 60 → pager / virtual scroll.
- [ ] **F240** Клик по hash → show.
- [ ] **F241** Auto-commit prefix настраиваемый в GitBadge (частично есть).
- [ ] **F242** Не коммитить secrets (связка T73).
- [ ] **F243** git tool: `branch_delete` безопасный merged-only.
- [ ] **F244** git tool: `worktree` actions.
- [ ] **F245** Per-slot repo (уже rootPath на слот) — badge всегда от active slot.

### 3.12 Telegram tool + bot — F246–F265

Тула: login/verify/2fa, chats, send, forward, pin, reaction, inline, delete, search, get_me, config. Бот: per-slot.

- [ ] **F246** UI логина (сейчас только агент).
- [ ] **F247** Список диалогов с пагинацией и аватарками.
- [ ] **F248** Медиа send (фото/файл) из Storage.
- [ ] **F249** Download media to vault/folder.
- [ ] **F250** Saved messages shortcut.
- [ ] **F251** Mute / archive flags.
- [ ] **F252** Drafts.
- [ ] **F253** Multi-account switcher в шапке.
- [ ] **F254** Rate-limit meter.
- [ ] **F255** Бот: команды /status /stop /model /compact.
- [ ] **F256** Бот: voice notes → stt → агент.
- [ ] **F257** Бот: картинка → vision.
- [ ] **F258** Бот: whitelist UI удобнее.
- [ ] **F259** Бот: typing action пока агент думает.
- [ ] **F260** Связка OTP: telegram login + ask_otp один wizard.
- [ ] **F261** Логи ошибок сессии (PHONE_MIGRATE и т.д.) человеческим языком.
- [ ] **F262** Export chat json.
- [ ] **F263** Search globally across accounts.
- [ ] **F264** Auto-reply rules → Runner.
- [ ] **F265** Privacy: never echo bot token / api_hash в tool result.

### 3.13 cf_mail / ask_otp / http / web — F266–F285

- [ ] **F266** Mail UI inbox (см. TAB-09) + badge непрочитанных.
- [ ] **F267** Правила: если subject contains OTP → Notify.
- [ ] **F268** Вложения сохранить.
- [ ] **F269** Категории ящиков UI (поле category уже в туле).
- [ ] **F270** TTL ящика и авто-delete.
- [ ] **F271** ask_otp: история запросов, timeout visible, cancel.
- [ ] **F272** ask_otp: не генерировать identity без явного kind — audit log.
- [ ] **F273** http: сохранённые коллекции (API Lab).
- [ ] **F274** http: pretty JSON, timing, size.
- [ ] **F275** http: mTLS / client cert из Vault.
- [ ] **F276** web_fetch: читаемый mode (уже cheerio?) — вынести readability.
- [ ] **F277** web_search: выбор движка, locale, time range.
- [ ] **F278** web_search: cache + cite links карточками в чате.
- [ ] **F279** shodan: пагинация UI, saved queries, compare.
- [ ] **F280** shodan: не сканить, не эксплойтить — только то что тула уже делает (InternetDB + titles).
- [ ] **F281** grep: include/exclude UI для человека (агент умеет).
- [ ] **F282** grep: открыть матч в Editor.
- [ ] **F283** read_file: pdf/xlsx/image ветки.
- [ ] **F284** edit_file: показать diff в чате всегда (частично есть computeLineDiff).
- [ ] **F285** restore_backup: timeline UI файлов.

### 3.14 Settings / i18n / themes / hotkeys — F286–F305

- [ ] **F286** Больше тем: carbon, paper, phosphor, soviet-red (сейчас только mono).
- [ ] **F287** Accent color picker.
- [ ] **F288** Density: compact / comfortable.
- [ ] **F289** Font family для UI и моно.
- [ ] **F290** Словарь хоткеев расширить (сейчас Ctrl+L + mouse).
- [ ] **F291** Command palette глобальный.
- [ ] **F292** Настройки AI: max iterations, tool groups default.
- [ ] **F293** soviet7ModelId picker нормальный (поле есть).
- [ ] **F294** Звук completion: выбрать файл, volume (сейчас 0.75 хардкод).
- [ ] **F295** Язык UI: добавить en/ru/uk consistency audit (i18n уже 3 языка).
- [ ] **F296** Telemetry opt-in local only.
- [ ] **F297** Backup userData zip.
- [ ] **F298** Reset workspace layout.
- [ ] **F299** Onboarding checklist первого запуска.
- [ ] **F300** About: version, electron, chromium, anti engine.
- [ ] **F301** Auto-update checker.
- [ ] **F302** Hardware accel toggle.
- [ ] **F303** Proxy для самого Electron (системный).
- [ ] **F304** Mouse snippets: больше кнопок, условия по вкладке.
- [ ] **F305** Settings search.

### 3.15 MCP / Storage / Search overlay / Titlebar — F306–F320

- [ ] **F306** MCP: логи stdio live.
- [ ] **F307** MCP: per-tool enable.
- [ ] **F308** MCP: env editor secrets masked.
- [ ] **F309** MCP: reconnect backoff UI.
- [ ] **F310** Storage: прогресс upload крупнее, retry, checksum.
- [ ] **F311** Storage: browse remote files если API позволяет.
- [ ] **F312** Search overlay: превью файла, фильтр type, open in editor.
- [ ] **F313** Search: include chats/posts/books in one overlay.
- [ ] **F314** Titlebar: клик по tokens → Usage tab.
- [ ] **F315** Titlebar: клик по memory → Logs/diagnostics.
- [ ] **F316** Titlebar overflow «More tabs».
- [ ] **F317** Window: always on top, opacity, mini mode.
- [ ] **F318** Multi-window: уже `window:new` — раскидать вкладки по окнам.
- [ ] **F319** Fullscreen zen: только активный чат.
- [ ] **F320** Status: текущий run (модель, iteration, tools/min).

---

## 4. Функции сверх 220 — добор до запаса

Чтобы точно было больше 200 с запасом на выбор.

- [ ] **F321** `list_dir` recursive + glob + ignore rules (.gitignore).
- [ ] **F322** `create_file` mkdir parents + template by extension.
- [ ] **F323** `bash` PTY mode (сейчас spawn) для интерактива.
- [ ] **F324** `bash` profile allowlist команд в Settings.
- [ ] **F325** `wsl` picker distro UI + file path translation preview.
- [ ] **F326** `work_timer` показать в titlebar remaining.
- [ ] **F327** `think` опционально показывать synthesis в UI (сейчас private-ish).
- [ ] **F328** `compact_history` keep_recent слайдер.
- [ ] **F329** `proxy_manager` action `set_priority` / `set_route` которых не хватает в списке.
- [ ] **F330** `mcp_manager` test_call из UI.
- [ ] **F331** `custom_tool` dry-run.
- [ ] **F332** `spawn_subagent` preset library (research, test, docs).
- [ ] **F333** `http` retry/backoff flags.
- [ ] **F334** `web_fetch` respect robots optional toggle.
- [ ] **F335** `telegram` draft + scheduled send.
- [ ] **F336** `git` signed commits если ключ в Vault.
- [ ] **F337** `posts` search action.
- [ ] **F338** `books` search action.
- [ ] **F339** Runner report markdown render как чат.
- [ ] **F340** Chat images: generate via provider если модель умеет (поле images в response уже есть).
- [ ] **F341** Token counting mode UI (provider vs auto — тип есть).
- [ ] **F342** Context ring click → breakdown modal.
- [ ] **F343** AsciiWar / easter eggs не трогать — не мешают.
- [ ] **F344** Hardening dist: опции light vs full в UI, не только scripts.
- [ ] **F345** `package-dist` профили: portable zip, installer, dir.
- [ ] **F346** Crash dump кнопка «скопировать отчёт».
- [ ] **F347** Safe mode: без MCP, без custom tools, без anti.
- [ ] **F348** Per-project `.composevc/` конфиг (instructions уже project-level).
- [ ] **F349** Editor: LSP later — хотя бы treesitter-like highlight.
- [ ] **F350** MultiIDE: shared clipboard snippets across slots.

Итого функций к существующему: **F001–F350 = 350 пунктов**.

---

## 5. Архитектура, без которой «50 тулов» взорвут продукт

1. **Tool search / groups.** Схема на каждый запрос должна быть короткой: core 12 + найденные. Иначе Soviet-7 × 7 × гигантский schema = счёт за воздух.
2. **Permissions.** Browser, telegram, bash, docker — разные уровни. Per-chat allowlist (F020).
3. **Не класть новые вкладки все в TitleBar.** Palette + группы.
4. **Один store pattern.** Todo сейчас localStorage, posts/books — userData. Унифицировать.
5. **UI kit.** 40 вкладок в разных стилях убьют mono-эстетику. Любая новая вкладка копирует shell Books/Post (head + ChatMonoScroll).
6. **Честные промпты.** Runner не должен обещать anti, пока тулы нет.
7. **Тесты.** У вас уже `test:tools`, `test:mcp`, `test:soviet7`, `test:custom-tools-*`. Каждый новый тул — тест на dispatch + aliases.
8. **Не делать «атакующий» зоопарк.** Shodan/http/browser — исследование и автоматизация своих профилей. Без эксплойтов, сканеров уязвимостей «под ключ», логов клавиатуры и прочего мусора.

---

## 6. Рекомендуемый порядок, если хочется космоса быстро

### Неделя 1 — закрыть стыд

W01 check_code, W02 todo tool+store, W03 youtube tool, W05 честный промпт, W09 tool groups, F034 slash-commands, F291 command palette.

### Неделя 2 — IDE перестаёт быть «только чат»

TAB-02 Editor, T02 apply_patch, T03 delete_file, T05 glob, T10 open_in_editor, TAB-03 Review, F031 drag files, F284 diffs in chat.

### Неделя 3 — ваш уникальный moat

TAB-01 Browser + T13 browser + T14 profiles. Связать YouTube F225. Captcha helper уже в anti/extensions.

### Неделя 4 — агентная оркестрация видна

TAB-12 Swarm Board, TAB-13 Soviet Chamber, F046–F056, TAB-28 Notify, F123 runner notify.

### Потом по голоду

Mail UI, Telegram Studio, Memory/RAG, Git Studio, Usage$, Marketplace.

---

## 7. Чего специально нет в списке (и не надо)

- Эксплойты, PoC атак, malware, keylogger, stealth steal.
- Массовый спам, накрутка, обход чужих аккаунтов.
- «Ещё 15 провайдеров» ради галочки — у вас уже толстый registry. Новый провайдер имеет смысл только если вы им реально пользуетесь.
- Второй движок чата «как Cursor». Догоняйте редактором, диффом, браузером и памятью — чат у вас уже жирный.

---

## 8. Карточка выбора (скопируй в свой чеклист)

```
Дата: ____
Беру вкладки: TAB-__
Беру тулы: T__
Беру функции: F__
Не беру: ____
Почему: ____
```

Минимальный «уже космос» набор, если выбрать 10 пунктов из всего файла:

1. TAB-02 Editor  
2. TAB-01 Browser  
3. TAB-03 Review  
4. T01 check_code  
5. T02 apply_patch  
6. T13 browser  
7. T20 todo  
8. T58 tool_search  
9. F007 compare models  
10. F291 command palette  

Остальное — меню. Сядешь — отмечаешь ID. Не пытайся скормить агенту все 76 тулов в один системный промпт.
