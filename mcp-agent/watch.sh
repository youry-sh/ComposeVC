#!/usr/bin/env bash
# Супервизор для macOS/Linux: держит сервер (и именованный туннель, если настроен) поднятыми.
# Запуск вручную: ./watch.sh      Автозапуск: см. README раздел 9 (LaunchAgent).
# Лог: watchdog.log (сервер пишет в server.log).
set -u

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$PWD"
LOG="$PROJECT_DIR/watchdog.log"
SERVER_LOG="$PROJECT_DIR/server.log"
LOG_MAX_BYTES=1048576

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# ---------- .env ----------
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

PORT="${MCP_PORT:-8000}"
BASE_URL="http://127.0.0.1:$PORT"
PUBLIC_URL="${PUBLIC_URL:-}"
TUNNEL_NAME="${TUNNEL_NAME:-mcp-pc}"
WATCH_NAMED="${CF_NAMED:-}"
[ -n "$PUBLIC_URL" ] && WATCH_NAMED="1"

healthy() { curl -fsS -m 10 "$1" >/dev/null 2>&1; }

# одна копия вотчдога
if [ -f .watchdog.pid ]; then
  old_pid="$(tr -cd '0-9' < .watchdog.pid)"
  if [ -n "$old_pid" ] && [ "$old_pid" != "$$" ] && kill -0 "$old_pid" 2>/dev/null; then
    say "вотчдог уже запущен (pid $old_pid) — выхожу"
    exit 0
  fi
fi
echo "$$" > .watchdog.pid

trim_log() {
  [ -f "$LOG" ] || return 0
  size="$(wc -c < "$LOG" 2>/dev/null | tr -d ' ')"
  if [ -n "$size" ] && [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    tail -c 262144 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  fi
}

find_python() {
  for cand in python3 python3.14 python3.13 python3.12 python3.11 python3.10 \
              /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' \
           >/dev/null 2>&1; then
        command -v "$cand"
        return 0
      fi
    fi
  done
  return 1
}

ensure_server() {
  healthy "$BASE_URL/health" && return 0
  log "server DOWN -> restart"

  # гасим зависшие процессы этого проекта (иначе новый упадёт на занятом порту)
  if [ -f .server_pid ]; then
    pid="$(tr -cd '0-9' < .server_pid)"
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  fi
  pkill -f "$PROJECT_DIR/.venv/bin/python server.py" 2>/dev/null
  sleep 2

  if [ ! -x .venv/bin/python ]; then
    PY="$(find_python)" || { log "Python 3.10+ не найден — сервер не поднять"; return 1; }
    log "создаю .venv ($PY)"
    "$PY" -m venv .venv >> "$LOG" 2>&1 || { log ".venv не создался"; return 1; }
  fi

  VPY="$PROJECT_DIR/.venv/bin/python"
  if ! "$VPY" -c 'import mcp, yaml, uvicorn, starlette' >/dev/null 2>&1; then
    log "pip install -r requirements.txt"
    "$VPY" -m pip install -q -r requirements.txt >> "$LOG" 2>&1
  fi

  nohup "$VPY" server.py >> "$SERVER_LOG" 2>&1 &
  echo "$!" > .server_pid
  sleep 5
  if healthy "$BASE_URL/health"; then
    log "server UP (pid $!)"
  else
    log "server FAILED to start, see server.log"
    return 1
  fi
}

ensure_tunnel() {
  # Следим только за именованным (постоянным) туннелем.
  [ -n "$WATCH_NAMED" ] || return 0
  if [ -z "$PUBLIC_URL" ]; then
    log "CF_NAMED/PUBLIC_URL задан не полностью — проверка туннеля пропущена"
    return 0
  fi
  healthy "$PUBLIC_URL/health" && return 0
  log "tunnel DOWN (or 5xx) -> restart"

  if [ -f .cf_named_pid ]; then
    pid="$(tr -cd '0-9' < .cf_named_pid)"
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
    rm -f .cf_named_pid
  fi
  pkill -f "cloudflared tunnel run $TUNNEL_NAME" 2>/dev/null
  sleep 3

  CF_BIN="$(command -v cloudflared 2>/dev/null || true)"
  [ -n "$CF_BIN" ] || { [ -x bin/cloudflared ] && CF_BIN="$PROJECT_DIR/bin/cloudflared"; }
  if [ -z "${CF_BIN:-}" ]; then
    log "cloudflared не найден в PATH и в ./bin — туннель не поднять"
    return 1
  fi

  nohup "$CF_BIN" tunnel run "$TUNNEL_NAME" --no-autoupdate >> "$PROJECT_DIR/cloudflared.log" 2>&1 &
  echo "$!" > .cf_named_pid
  sleep 12
  if healthy "$PUBLIC_URL/health"; then
    log "tunnel check -> $PUBLIC_URL = 200"
  else
    log "tunnel check -> $PUBLIC_URL FAILED, see cloudflared.log"
  fi
}

cleanup() { rm -f .watchdog.pid; }
trap 'cleanup' EXIT INT TERM

log "watchdog started (pid $$, port $PORT)"
while :; do
  ensure_server
  ensure_tunnel
  trim_log
  sleep 60
done
