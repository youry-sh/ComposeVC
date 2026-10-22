#!/usr/bin/env bash
# Kill-switch: гасит вотчдог, сервер и туннели.
# Если включён автозапуск (LaunchAgent com.localcoding.agent) — сначала выгружает его,
# иначе launchd тут же поднимет вотчдог заново и сервер вернётся.
#
# Обратно включить автозапуск:
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.localcoding.agent.plist
set -u

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$PWD"
PORT="${MCP_PORT:-8000}"

stop_pidfile() {
  f="$1"
  [ -f "$f" ] || return 0
  pid="$(tr -cd '0-9' < "$f")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null
    echo "остановлен $(basename "$f") (pid $pid)"
  fi
  rm -f "$f"
  return 0
}

# .env (нужен для TUNNEL_NAME / MCP_PORT)
if [ -f .env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    [ -z "$key" ] && continue
    eval "already=\${$key+set}"
    if [ "${already:-}" != "set" ]; then export "$key=$val"; fi
    unset already
  done < .env
  unset line key val
fi

echo "Останавливаю вотчдог, сервер и туннели..."

# 1) launchd (автозапуск) — иначе он перезапустит вотчдог
if command -v launchctl >/dev/null 2>&1; then
  if launchctl print "gui/$(id -u)/com.localcoding.agent" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/com.localcoding.agent" >/dev/null 2>&1 \
      && echo "автозапуск (LaunchAgent com.localcoding.agent) выгружен"
  fi
fi

# 2) по pid-файлам (сначала вотчдог, чтобы не поднял сервер обратно)
for f in .watchdog.pid .server_pid .cf_pid .cf_named_pid .ngrok_pid; do
  stop_pidfile "$f"
done

# 3) добор по командной строке — только процессы ЭТОГО проекта
pkill -f "$PROJECT_DIR/.venv/bin/python server.py" 2>/dev/null && echo "сервер остановлен"
pkill -f "$PROJECT_DIR/watch.sh" 2>/dev/null && echo "вотчдог остановлен"
pkill -f "$PROJECT_DIR/bin/cloudflared" 2>/dev/null && echo "туннель cloudflared остановлен"
if [ -n "${TUNNEL_NAME:-}" ]; then
  pkill -f "cloudflared tunnel run $TUNNEL_NAME" 2>/dev/null && echo "именованный туннель остановлен"
fi
pkill -f "ngrok http $PORT" 2>/dev/null && echo "ngrok остановлен"

rm -f .public_url
echo "Готово. Проверка: http://127.0.0.1:$PORT/health в браузере не должен открыться."
echo "Автозапуск выключен до следующего входа в систему / ручного bootstrap."
