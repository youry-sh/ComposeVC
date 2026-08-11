#!/usr/bin/env bash
# Helper for start-desktop.sh: runs the standalone proxy gateway inside a
# terminal window. userData is resolved from the same env vars the app uses
# (LOPSTER_COPY_ID / LOPSTER_USER_DATA), so it hits the SAME store file.
cd "$(dirname "$0")/.." || exit 1

if [ ! -d node_modules ]; then
  echo "[proxy] node_modules not found — run 'npm install' first"
  read -r -p "Press Enter to close... " _
  exit 1
fi

exec node electron/proxy/standalone.cjs
