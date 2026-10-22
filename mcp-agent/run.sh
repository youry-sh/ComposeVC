#!/usr/bin/env bash
# local-coding-agent: запуск MCP-сервера (+ опционально туннель наружу).
#
#   ./run.sh                          — только локально (http://127.0.0.1:8000)
#   CF_QUICK=1 ./run.sh               — + бесплатный временный URL (без регистрации,
#                                       адрес меняется при каждом перезапуске)
#   CF_NAMED=1 ./run.sh               — + постоянный именованный туннель (свой домен,
#                                       см. README раздел "Свой домен")
#   NGROK_DOMAIN=xxx ./run.sh         — + ngrok (нужен static-домен в аккаунте ngrok)
#
# Скрипт написан под штатный bash 3.2 на macOS/Linux (без bash4-фич).
set -u

cd "$(dirname "$0")" || exit 1
PROJECT_DIR="$PWD"

say() { printf '%s\n' "$*"; }
die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

# ---------- .env (KEY=VALUE, # комментарии, кавычки) ----------
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
    if [ "${already:-}" != "set" ]; then
      export "$key=$val"
    fi
    unset already
  done < .env
  unset line key val
fi

# ---------- Python 3.10+ ----------
have() { command -v "$1" >/dev/null 2>&1; }
py_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 10) else 1)' \
    >/dev/null 2>&1
}

PY=""
for cand in python3 python3.14 python3.13 python3.12 python3.11 python3.10 \
            /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if have "$cand" && py_ok "$cand"; then PY="$cand"; break; fi
done
[ -n "$PY" ] || die "Python 3.10+ не найден. Установи с https://www.python.org/downloads/ \
и проверь в терминале: python3 --version"

# ---------- виртуальное окружение + зависимости ----------
if [ ! -x .venv/bin/python ]; then
  say "-> создаю виртуальное окружение..."
  "$PY" -m venv .venv || die "не смог создать .venv (нужен python3 -m venv)"
fi
VPY="$PROJECT_DIR/.venv/bin/python"

if ! "$VPY" -c 'import mcp, yaml, uvicorn, starlette' >/dev/null 2>&1; then
  say "-> ставлю зависимости..."
  "$VPY" -m pip install -q --upgrade pip >/dev/null 2>&1
  "$VPY" -m pip install -q -r requirements.txt || die "pip install не удался (см. вывод выше)"
fi

# ---------- токен ----------
token_bad=0
case "${MCP_TOKEN:-}" in ""|*CHANGE_ME*) token_bad=1 ;; esac
if [ "$token_bad" = "1" ]; then
  if grep -q 'CHANGE_ME' config.yaml 2>/dev/null; then
    say "ОШИБКА: задай токен."
    say "  1) $PY -c \"import secrets; print(secrets.token_urlsafe(32))\""
    say "  2) cp .env.example .env  и вставь токен в MCP_TOKEN"
    exit 1
  fi
fi

# ---------- туннели ----------
PORT="${MCP_PORT:-8000}"
TUNNEL_PIDS=""

cleanup_tunnels() {
  [ -z "$TUNNEL_PIDS" ] && return
  for pid in $TUNNEL_PIDS; do
    if kill "$pid" 2>/dev/null; then say "-> туннель остановлен (pid $pid)"; fi
  done
  TUNNEL_PIDS=""
  rm -f .cf_pid .ngrok_pid .cf_named_pid 2>/dev/null
  return 0
}
trap 'cleanup_tunnels' EXIT
trap 'cleanup_tunnels; exit 130' INT TERM

cloudflared_bin() {
  if have cloudflared; then command -v cloudflared; return 0; fi
  if [ -x bin/cloudflared ]; then printf '%s' "$PROJECT_DIR/bin/cloudflared"; return 0; fi
  return 1
}

download_cloudflared() {
  case "$(uname -m)" in
    arm64|aarch64) asset="cloudflared-darwin-arm64.tgz" ;;
    *)             asset="cloudflared-darwin-amd64.tgz" ;;
  esac
  mkdir -p bin || die "не могу создать папку bin"
  say "-> качаю cloudflared ($asset)..."
  curl -fL --progress-bar \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$asset" \
    -o bin/cloudflared.tgz || die "не скачался cloudflared (проверь интернет)"
  tar -xzf bin/cloudflared.tgz -C bin || die "не распаковался cloudflared.tgz"
  rm -f bin/cloudflared.tgz
  chmod +x bin/cloudflared
  xattr -d com.apple.quarantine bin/cloudflared 2>/dev/null || true
}

if [ -n "${CF_NAMED:-}" ]; then
  TUNNEL_NAME="${TUNNEL_NAME:-mcp-pc}"
  CF_BIN="$(cloudflared_bin)" || die "cloudflared не найден. Установи его (см. README раздел 5) \
или сначала запусти CF_QUICK=1 ./run.sh — он скачает бинарник в ./bin"
  say "-> поднимаю именованный туннель '$TUNNEL_NAME'..."
  nohup "$CF_BIN" tunnel run "$TUNNEL_NAME" --no-autoupdate > cloudflared.log 2>&1 &
  TUNNEL_PIDS="$TUNNEL_PIDS $!"
  echo "$!" > .cf_named_pid
  sleep 5
  if [ -n "${PUBLIC_URL:-}" ]; then
    say "  Твой URL: $PUBLIC_URL/mcp"
  else
    say "  ВНИМАНИЕ: PUBLIC_URL не задан в .env — внешний адрес не проверить."
  fi

elif [ -n "${NGROK_DOMAIN:-}" ]; then
  have ngrok || die "ngrok не найден: https://ngrok.com/download"
  say "-> поднимаю ngrok: https://$NGROK_DOMAIN --> http://127.0.0.1:$PORT"
  nohup ngrok http "$PORT" --url="$NGROK_DOMAIN" > ngrok.log 2>&1 &
  TUNNEL_PIDS="$TUNNEL_PIDS $!"
  echo "$!" > .ngrok_pid
  sleep 3
  say "  Твой URL: https://$NGROK_DOMAIN/mcp"

elif [ -n "${CF_QUICK:-}" ]; then
  CF_BIN="$(cloudflared_bin)" || { download_cloudflared; CF_BIN="$PROJECT_DIR/bin/cloudflared"; }
  say "-> поднимаю временный туннель..."
  rm -f cloudflared.log
  nohup "$CF_BIN" tunnel --url "http://127.0.0.1:$PORT" --no-autoupdate > cloudflared.log 2>&1 &
  TUNNEL_PIDS="$TUNNEL_PIDS $!"
  echo "$!" > .cf_pid
  url=""
  i=0
  while [ "$i" -lt 60 ]; do
    url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' cloudflared.log 2>/dev/null | tail -1)"
    [ -n "$url" ] && break
    i=$((i + 1))
    sleep 1
  done
  if [ -n "$url" ]; then
    printf '%s\n' "$url" > .public_url
    say "  Твой URL: $url/mcp  (вставь в WonkaAI, + /mcp в конце)"
  else
    say "  ВНИМАНИЕ: URL не появился за 60с — смотри cloudflared.log"
  fi
fi

say "-> старт MCP: http://127.0.0.1:$PORT/mcp"
"$VPY" server.py
exit $?
