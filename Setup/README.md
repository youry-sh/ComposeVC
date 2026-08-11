# Agent-Reach + IDE Setup (Windows)

Полная одноразовая установка на чистой машине:
все интернет-каналы для ComposeVC (семантический поиск Exa, YouTube-субтитры,
GitHub, B站, RSS, V2EX, чтение любых страниц) + все зависимости самой IDE,
после чего `start.bat` запускает приложение.

## Как запустить

1. Запусти `00-run-all.bat` **от имени обычного пользователя** (двойной клик).
2. Он сам по порядку:
   - `01-install-node.bat` — Node.js LTS + npm (если нет)
   - `02-install-python.bat` — Python 3.12 + pip (если нет)
   - `03-install-agent-reach.bat` — mcporter + Exa MCP, agent-reach, pipx, bili-cli, twitter-cli, opencli, yt-dlp, gh CLI
   - `04-verify.bat` — проверка: версии, живой Exa-тест, `agent-reach doctor`
   - `05-install-ide.bat` — `npm install`, проверка нативных модулей (sharp/impers/electron), прогрев impers, `vite build` (тот же шаг, что в start.bat)
3. Дождись конца и **дважды кликни `start.bat`** — приложение запустится.

Если что-то поставилось криво — можно перезапустить только нужный шаг:
`01`, `02`, `03`, `04` или `05` отдельно.

## Что получишь

| Канал | Статус после установки |
|-------|------------------------|
| Веб-поиск (DuckDuckGo → Bing → Exa семантика) | работает сразу |
| Чтение любой страницы (Jina Reader) | работает сразу |
| YouTube (инфо + субтитры) | работает сразу |
| GitHub (репозитории + поиск) | работает сразу |
| RSS / Atom ленты | работает сразу |
| V2EX | работает сразу |
| B站 (поиск видео) | работает сразу |
| Twitter/X, Reddit, Facebook, Instagram, 小红书, 雪球, LinkedIn | нужен логин/Cookie — скажи агенту «настрой Twitter» и т.д. |
| Сама IDE (start.bat) | работает сразу после `05` |

## Если `agent-reach doctor` показывает канал как off/error

- **Exa**: `mcporter config add exa https://mcp.exa.ai/mcp --scope home`
- **bili/twitter**: `pipx install bilibili-cli` / `pipx install twitter-cli` (после установки перезапусти терминал, чтобы PATH подхватился)
- **OpenCLI**: `npm install -g @jackwener/opencli`
- **gh**: установить с https://cli.github.com

## Примечания

- agent-reach НЕ публикуется на PyPI — ставится из GitHub-архива (`pip install https://github.com/Panniantong/agent-reach/archive/main.zip`), это уже заложено в `03`.
- Все Cookie хранятся только локально у пользователя, никуда не отправляются.
- Если winget недоступен (старая Windows), скрипты скачают Node/Python напрямую с официальных сайтов.
- Если `npm install` падает на нативной сборке (node-gyp) — нужны Visual Studio Build Tools: https://visualstudio.microsoft.com/visual-cpp-build-tools/ — затем перезапусти `05`.
