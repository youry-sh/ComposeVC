#!/usr/bin/env bash
# ComposeVC / Lopster — Linux launcher (Kali & friends)
# Аналог start.bat: собирает frontend и запускает Electron.

set -u
cd "$(dirname "$0")"

export LOPSTER_COPY_ID="${LOPSTER_COPY_ID:-lopster1-4-copy}"
export LOPSTER_APP_NAME="${LOPSTER_APP_NAME:-ComposeVC}"
export ELECTRON_FORCE_NEW_INSTANCE="${ELECTRON_FORCE_NEW_INSTANCE:-1}"

# Node.js (local install) + pipx CLIs + gh CLI
if [ -d "$HOME/.local/nodejs/bin" ]; then
  export PATH="$HOME/.local/nodejs/bin:$PATH"
fi
if [ -d "$HOME/.local/bin" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
if [ -d "$HOME/.local/gh/usr/bin" ]; then
  export PATH="$HOME/.local/gh/usr/bin:$PATH"
fi

# Если нет node — показать ошибку
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install it first."
  exit 1
fi

echo "============================================"
echo "  Starting ComposeVC (Lopster)..."
echo "  userData id: $LOPSTER_COPY_ID"
echo "============================================"

# npm run app = vite build && node scripts/run-electron.cjs .
npm run app
EXITCODE=$?

echo ""
echo "============================================"
echo "  App exited. Exit code: $EXITCODE"
echo "============================================"
exit $EXITCODE
