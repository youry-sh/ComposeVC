# local-coding-agent (Mac) — кодинг-агент через чат WonkaAI

Твой WonkaAI получает доступ к файлам и терминалу на этом Mac:
ты пишешь в чате — он читает/правит файлы и выполняет команды.
15 инструментов: `system_info`, файлы (`fs_list`/`fs_read`/`fs_write`/`fs_edit`/
`fs_mkdir`/`fs_delete`), поиск (`fs_glob`/`fs_grep`),
терминал (`shell_run`, фоновый `shell_run_async` + `shell_poll`),
подтверждение новых папок (`approve_zone`, `list_zones`, `revoke_zone`).

Как устроено: на Маке крутится сервер → наружу его показывает туннель (URL) →
этот URL вставляешь в WonkaAI как Custom MCP.

Файлы запуска: `run.sh` (сервер + туннель), `watch.sh` (вотчдог),
`stop.sh` (kill-switch), `com.localcoding.agent.plist.template` (автозапуск).
Windows-версия тех же команд — в `README.txt` и `run.bat`/`watch.ps1`/`stop.bat`.

---

## 0. Что нужно

- Mac + интернет, Python 3.10+ (проверка ниже).
- Терминал: `Finder → Программы → Утилиты → Терминал`.

Всё ниже — команды для Терминала. Папку с этими файлами называем «папка проекта».

## 1. Распаковка и Python

```bash
cd ~/Downloads/WonkaAI-mcp-agent   # перейди в распакованную папку (путь свой!)
python3 --version                 # должно показать 3.10 или новее
```

Нет Python — скачай с https://www.python.org/downloads/ и установи
(или `brew install python`).

## 2. Токен (пароль от твоего сервера, один раз)

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
cp .env.example .env
```

Открой `.env` в любом редакторе и вставь вывод первой команды вместо
`CHANGE_ME...` после `MCP_TOKEN=`. Никому его не показывай — кто знает токен,
тот выполняет команды на твоём Маке.

## 3. Первый запуск (локально, без интернета наружу)

```bash
chmod +x run.sh watch.sh stop.sh
./run.sh
```

Первый запуск сам создаст `.venv` и поставит зависимости (mcp, uvicorn, pyyaml).
Увидишь `local-coding-agent MCP on http://127.0.0.1:8000/mcp` — работает.
Проверка во **втором** окне Терминала:

```bash
curl http://127.0.0.1:8000/health
```

Ожидаешь `{"ok":true,...}`. Останови сервер: вернись в первое окно, `Ctrl+C`.

## 4. Бесплатная публичная ссылка (без регистрации, за 1 минуту)

Облачный WonkaAI не достаёт до `localhost`, поэтому открываем туннель.
Самый простой — временный Cloudflare (минус: адрес меняется при каждом рестарте):

```bash
CF_QUICK=1 ./run.sh
```

В логе появится строка вида `https://что-то.trycloudflare.com` —
это и есть твой адрес (+ допиши `/mcp` в конце для WonkaAI).
`cloudflared` скачается сам при первом запуске (`run.sh` кладёт бинарник в `./bin`,
снимает с него карантин macOS и пишет лог в `cloudflared.log`, а адрес — в `.public_url`).

Альтернативы (по желанию):
- **ngrok static** — постоянный бесплатный адрес `xxx.ngrok-free.app`:
  регистрация на https://dashboard.ngrok.com → Domains → Claim →
  `NGROK_DOMAIN='xxx.ngrok-free.app' ./run.sh`.
  Учти: с некоторых IP/сетей ngrok может отказывать (`ERR_NGROK_9040`) —
  тогда используй Cloudflare.
- **Tailscale Funnel** — постоянный `https://имя.ts.net`, но требует установки
  Tailscale, входа и включения Funnel + HTTPS в админке.

## 5. Свой домен (если есть, постоянный красивый адрес)

Нужно один раз (минут 10 + ожидание DNS 1–15 мин):

```bash
# 1) cloudflared поставь ОДИН раз любым способом:
#    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
#    (или он уже скачался в ./bin при шаге 4 — скопируй его в PATH)
brew install cloudflared          # вариант для любителей Homebrew

# 2) войди в Cloudflare (откроется браузер):
cloudflared tunnel login

# 3) создай туннель и привяжи поддомен (пример: mcp.example.com):
cloudflared tunnel create mcp-pc
cloudflared tunnel route dns mcp-pc mcp.example.com
```

Домен при этом никуда переносить не надо: добавляется только CNAME-запись
на поддомен, основной сайт не трогается. Если DNS домена НЕ на Cloudflare —
команда `route dns` не сработает: тогда вручную добавь у своего DNS-хостера
`CNAME mcp → <tunnel-id>.cfargotunnel.com` (id покажет `tunnel create`).

```bash
# 4) в .env допиши две строки:
PUBLIC_URL=https://mcp.example.com
TUNNEL_NAME=mcp-pc

# 5) запуск:
CF_NAMED=1 ./run.sh
```

Проверка: `https://mcp.example.com/health` в браузере → `{"ok":true,...}`.

## 6. Подключение в WonkaAI (один раз)

1. WonkaAI → `Settings → Connections → Discover → Add Custom MCP`.
2. Name: `local-coding-agent`.
3. URL: твой адрес + `/mcp` (временный `https://...trycloudflare.com/mcp`
   или постоянный `https://mcp.example.com/mcp`).
4. Authentication: **Bearer token**, Prefix `Bearer`, Token — твой `MCP_TOKEN`.
5. Нажми Connect (WonkaAI проверит связь — сервер и туннель должны быть запущены).
6. В чате: `All sources → MCP servers` → выбери подключение.
7. Режим разрешений: поставь **auto-run** (выполнять без лишних вопросов).
   Не бойся: защита от дурака — на сервере: новую папку агент всё равно
   сначала спросит у тебя в чате (механизм зон, см. ниже).

Текст для Custom instructions агента — в файле `AGENT.md` (скопируй оттуда).

## 7. Проверка из чата WonkaAI

По очереди:

1. `Через local-coding-agent вызови system_info` → вернёт инфо о Маке.
2. `Через local-coding-agent покажи файлы в папке <твоя папка> через fs_list`.
3. `Через local-coding-agent найди через fs_grep слово <любое> в <папка>`.
4. Создай и прочитай: `создай файл test-WonkaAI.txt ... через fs_write`,
   потом `прочитай его через fs_read`, потом `удали через fs_delete`.
5. **Главный тест — новая папка:** `покажи файлы в /tmp через fs_list` →
   агент ОБЯЗАН спросить «дать доступ к /private?» (на macOS `/tmp` — симлинк
   на `/private/tmp`). Ответь «да» — покажет.
   Второй раз та же команда уже не спрашивает (запомнил).
   Посмотреть что подтверждено: `покажи зоны через list_zones`.

## 8. Безопасность (прочитай!)

- Токен = ключ от квартиры. Не свети на скриншотах, не клади в общие страницы.
- История чата (команды и содержимое файлов) хранится в облаке WonkaAI.
- `./stop.sh` — kill-switch: выгружает автозапуск, гасит вотчдог, сервер
  и туннели: Мак недоступен снаружи.
- Все вызовы пишутся в `audit.log` — видно что агент реально делал.
- Засветил токен — сгенерируй новый (шаг 2), обнови `.env` и в WonkaAI.

## 9. Автозапуск (чтобы само поднималось после перезагрузки)

```bash
# подставь СВОЙ путь вместо __PROJECT_DIR__ в файле com.localcoding.agent.plist.template,
# сохрани как com.localcoding.agent.plist, затем:
sed -i '' 's|__PROJECT_DIR__|'"$PWD"'|g' com.localcoding.agent.plist.template
cp com.localcoding.agent.plist.template ~/Library/LaunchAgents/com.localcoding.agent.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.localcoding.agent.plist
```

Вотчдог `watch.sh` дальше сам следит: упал сервер/туннель — перезапустит в течение
минуты (лог `watchdog.log`, сервер пишет в `server.log`). Важно: для именованного
туннеля в `.env` должны быть `PUBLIC_URL` и `TUNNEL_NAME`.
Выключить всё: `./stop.sh` (он же делает `launchctl bootout` — иначе launchd
поднимет вотчдог заново). Обратно включить:
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.localcoding.agent.plist`.

Полное удаление автозапуска:

```bash
rm ~/Library/LaunchAgents/com.localcoding.agent.plist
```

## Troubleshooting

| Симптом | Что делать |
|---|---|
| `ОШИБКА: задай токен` | Шаг 2 не выполнен: создай `.env` с токеном |
| `ОШИБКА: Python 3.10+ не найден` | Поставь Python с python.org или `brew install python`, проверь `python3 --version` |
| `401 unauthorized` в WonkaAI | Токен в WonkaAI ≠ токену в `.env`. Сверь |
| `MCP tool discovery failed` / WonkaAI не достаёт | Сервер или туннель упали (сон Мака). Проверь `curl <твой-URL>/health`, перезапусти `./run.sh` |
| Временный URL перестал работать | Quick-туннели умирают — подними заново (`CF_QUICK=1 ./run.sh`) и обнови URL в WonkaAI. Надоело — делай свой домен (шаг 5) |
| `need_approval` / «НОВАЯ ПАПКА» | Так задумано: ответь в чате «да», агент вызовет `approve_zone` и повторит |
| WonkaAI спрашивает на КАЖДЫЙ вызов | В настройках подключения смени Always ask → auto-run |
| `Operation not permitted` в `~/Documents`, `~/Downloads` | Это macOS TCC, не сервер: `Системные настройки → Конфиденциальность → Full Disk Access` → добавь Терминал (или Python), перезапусти сервер |
| `port 8000 already in use` | Старый сервер висит: `./stop.sh`, потом запускай. Другой порт — `MCP_PORT=8010 ./run.sh` (+ туннель пойдёт на него же) |
| `command not found: cloudflared` (шаг 5) | Установи cloudflared с сайта Cloudflare, `brew install cloudflared` или скопируй из `./bin` в `/usr/local/bin` |
| `cloudflared` не запускается: «cannot be opened because the developer cannot be verified» | `xattr -d com.apple.quarantine ./bin/cloudflared` (run.sh делает это сам для `./bin`) |
| `./run.sh: Permission denied` | `chmod +x run.sh watch.sh stop.sh` |
| Вотчдог не поднимает сервер | Смотри `watchdog.log` и `server.log`; проверь, что `.venv/bin/python` на месте |
