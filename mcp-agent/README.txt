# local-coding-agent (Windows) — кодинг-агент через чат WonkaAI

Твой WonkaAI Agent получает доступ к файлам и командной строке на этом ПК:
ты пишешь в чате — он читает/правит файлы и выполняет команды.
15 инструментов: файлы (`fs_list/read/write/edit`), поиск (`fs_glob/grep`),
терминал (`shell_run`, фоновый `shell_run_async` + `shell_poll`),
подтверждение новых папок (`approve_zone`, `list_zones`, `revoke_zone`).

Как устроено: на ПК крутится сервер → наружу его показывает туннель (URL) →
этот URL вставляешь в WonkaAI как Custom MCP.

---

## 0. Что нужно

- Windows 10/11 + интернет, Python 3.10+.
- Команды ниже вводятся в **cmd** (Командная строка): нажми `Win+R`, набери `cmd`, Enter.
  Папку с этими файлами называем «папка проекта».

## 1. Распаковка и Python

1. Распакуй архив, запомни путь (пример: `C:\mcp\WonkaAI-mcp-agent`).
2. Установи Python с https://www.python.org/downloads/ — **важно**:
   при установке поставь галочку **«Add python.exe to PATH»**.
3. Проверка в `cmd`:

```bat
cd /d C:\mcp\WonkaAI-mcp-agent
py -3 --version
```

Должно показать 3.10 или новее. Если `py` не найден — попробуй `python --version`.

## 2. Токен (пароль от твоего сервера, один раз)

```bat
py -3 -c "import secrets; print(secrets.token_urlsafe(32))"
copy .env.example .env
```

Открой `.env` в Блокноте и вставь вывод первой команды вместо
`CHANGE_ME...` после `MCP_TOKEN=`. Никому его не показывай — кто знает токен,
тот выполняет команды на твоём ПК.

## 3. Первый запуск (локально, без интернета наружу)

```bat
run.bat
```

Увидишь `local-coding-agent MCP on http://127.0.0.1:8000/mcp` — работает.
Проверка во **втором** окне `cmd`:

```bat
curl http://127.0.0.1:8000/health
```

Ожидаешь `{"ok":true,...}`. Останови сервер: вернись в первое окно, `Ctrl+C`.

## 4. Бесплатная публичная ссылка (без регистрации, за 1 минуту)

Облачный WonkaAI не достаёт до `localhost`, поэтому открываем туннель.
Самый простой — временный Cloudflare (минус: адрес меняется при каждом рестарте):

```bat
set CF_QUICK=1
run.bat
```

В логе появится строка вида `https://что-то.trycloudflare.com` —
это и есть твой адрес (+ допиши `/mcp` в конце для WonkaAI).
`cloudflared.exe` скачается сам при первом запуске в папку `bin`.

Альтернативы (по желанию):
- **ngrok static** — постоянный бесплатный адрес `xxx.ngrok-free.app`:
  регистрация на https://dashboard.ngrok.com → Domains → Claim →
  `set NGROK_DOMAIN=xxx.ngrok-free.app` + `run.bat`.
  Учти: с некоторых IP/сетей ngrok может отказывать (`ERR_NGROK_9040`) —
  тогда используй Cloudflare.
- **Tailscale Funnel** — постоянный `https://имя.ts.net`, но требует установки
  Tailscale, входа и включения Funnel + HTTPS в админке.

## 5. Свой домен (если есть, постоянный красивый адрес)

Нужно один раз (минут 10 + ожидание DNS 1–15 мин):

1. Скачай `cloudflared` для Windows:
   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   (или возьми готовый `bin\cloudflared.exe` после шага 4) и положи его так,
   чтобы команда `cloudflared` находилась (например, рядом или в PATH).
2. Войди в Cloudflare (откроется браузер):

```bat
cloudflared tunnel login
```

3. Создай туннель и привяжи поддомен (пример: `mcp.example.com`):

```bat
cloudflared tunnel create mcp-pc
cloudflared tunnel route dns mcp-pc mcp.example.com
```

Домен при этом никуда переносить не надо: добавляется только CNAME-запись
на поддомен, основной сайт не трогается. Если DNS домена НЕ на Cloudflare —
команда `route dns` не сработает: тогда вручную добавь у своего DNS-хостера
`CNAME mcp → <tunnel-id>.cfargotunnel.com` (id покажет `tunnel create`).

4. В `.env` допиши две строки:

```
PUBLIC_URL=https://mcp.example.com
TUNNEL_NAME=mcp-pc
```

5. Запуск:

```bat
set CF_NAMED=1
run.bat
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

1. `Через local-coding-agent вызови system_info` → вернёт инфо о ПК.
2. `Через local-coding-agent покажи файлы в папке <твоя папка> через fs_list`.
3. `Через local-coding-agent найди через fs_grep слово <любое> в <папка>`.
4. Создай и прочитай: `создай файл test-WonkaAI.txt ... через fs_write`,
   потом `прочитай его через fs_read`, потом `удали через fs_delete`.
5. **Главный тест — новая папка:** `покажи файлы в C:\Temp через fs_list` →
   агент ОБЯЗАН спросить «дать доступ к C:\Temp (или диску)?». Ответь «да» — покажет.
   Второй раз та же команда уже не спрашивает (запомнил).
   Посмотреть что подтверждено: `покажи зоны через list_zones`.

## 8. Безопасность (прочитай!)

- Токен = ключ от квартиры. Не свети на скриншотах, не клади в общие страницы.
- История чата (команды и содержимое файлов) хранится в облаке WonkaAI.
- `stop.bat` — kill-switch: гасит сервер и туннели, ПК недоступен снаружи.
- Все вызовы пишутся в `audit.log` — видно что агент реально делал.
- Защитник Windows может спросить про `cloudflared.exe` / Python при первом
  запуске — разреши (это наши же файлы).
- Засветил токен — сгенерируй новый (шаг 2), обнови `.env` и в WonkaAI.

## 9. Автозапуск (чтобы само поднималось после перезагрузки)

Вотчдог `watch.ps1` следит: упал сервер/туннель — перезапустит в течение минуты
(лог `watchdog.log`). Для именованного туннеля в `.env` должны быть
`PUBLIC_URL` и `TUNNEL_NAME`. Ставим задачу в Планировщик:

```bat
schtasks /create /tn "LocalCodingAgent" /tr "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\mcp\WonkaAI-mcp-agent\watch.ps1\"" /sc onlogon /rl limited /f
```

(путь к `watch.ps1` — свой!). Проверка: перезайди в Windows, открой
`http://127.0.0.1:8000/health`. Удалить задачу: `schtasks /delete /tn "LocalCodingAgent" /f`.
Полная остановка всего: `stop.bat`.

## Troubleshooting

| Симптом | Что делать |
|---|---|
| `Python не найден` | Переустанови с python.org с галочкой Add to PATH, закрой и открой cmd заново |
| `ОШИБКА: задай токен` | Шаг 2 не выполнен: создай `.env` с токеном |
| `401 unauthorized` в WonkaAI | Токен в WonkaAI ≠ токену в `.env`. Сверь |
| `MCP tool discovery failed` / WonkaAI не достаёт | Сервер или туннель упали (сон ПК). Проверь `curl <твой-URL>/health`, перезапусти `run.bat` |
| Временный URL перестал работать | Quick-туннели умирают — подними заново (`set CF_QUICK=1` + `run.bat`) и обнови URL в WonkaAI. Надоело — делай свой домен (шаг 5) |
| `need_approval` / «НОВАЯ ПАПКА» | Так задумано: ответь в чате «да», агент вызовет `approve_zone` и повторит |
| WonkaAI спрашивает на КАЖДЫЙ вызов | В настройках подключения смени Always ask → auto-run |
| `port 8000 already in use` | Старый сервер висит: запусти `stop.bat`, потом `run.bat` |
| PowerShell ругается на `watch.ps1` | Запускай так: `powershell -ExecutionPolicy Bypass -File watch.ps1` |
| SmartScreen/антивирус на `.exe` | Это наши `cloudflared.exe`/Python — разреши однократно |
