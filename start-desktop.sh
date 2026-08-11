#!/usr/bin/env bash
# ComposeVC desktop launcher (used by ~/Desktop/ComposeVC.desktop).
#
# 1) Opens the proxy gateway in its OWN terminal window (separate process),
# 2) launches the app, which then detects the external proxy and does not
#    spawn a duplicate instance (LOPSTER_PROXY_EXTERNAL=1).
#
# Close the proxy window (Ctrl+C) to stop the gateway; the app keeps working.

set -u
cd "$(dirname "$0")" || exit 1

export LOPSTER_COPY_ID="${LOPSTER_COPY_ID:-lopster1-4-copy}"
export LOPSTER_APP_NAME="${LOPSTER_APP_NAME:-ComposeVC}"
export ELECTRON_FORCE_NEW_INSTANCE="${ELECTRON_FORCE_NEW_INSTANCE:-1}"

# Node.js (local install) + pipx CLIs + gh CLI — same PATH setup as start.sh
if [ -d "$HOME/.local/nodejs/bin" ]; then
  export PATH="$HOME/.local/nodejs/bin:$PATH"
fi
if [ -d "$HOME/.local/bin" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi
if [ -d "$HOME/.local/gh/usr/bin" ]; then
  export PATH="$HOME/.local/gh/usr/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install it first."
  read -r -p "Press Enter to close... " _
  exit 1
fi

# userData dir the app resolves (dev mode): ~/.config/lopster-ide-copy-<COPY_ID>
export LOPSTER_USER_DATA="${LOPSTER_USER_DATA:-$HOME/.config/lopster-ide-copy-${LOPSTER_COPY_ID}}"

# ── 1) proxy gateway in its own terminal ─────────────────────────────────────
PROXY_WRAPPER="$PWD/scripts/proxy-terminal.sh"
TERM_EMU=""
for t in gnome-terminal xfce4-terminal x-terminal-emulator konsole mate-terminal kitty alacritty xterm; do
  if command -v "$t" >/dev/null 2>&1; then TERM_EMU="$t"; break; fi
done

if [ -n "$TERM_EMU" ]; then
  case "$TERM_EMU" in
    gnome-terminal)
      "$TERM_EMU" --title="Lopster Proxy" -- bash "$PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    xfce4-terminal)
      "$TERM_EMU" --title="Lopster Proxy" -e "bash $PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    konsole)
      "$TERM_EMU" --title "Lopster Proxy" -e "bash $PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    mate-terminal)
      "$TERM_EMU" --title="Lopster Proxy" -e "bash $PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    kitty)
      "$TERM_EMU" --title "Lopster Proxy" -e bash "$PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    alacritty)
      "$TERM_EMU" -t "Lopster Proxy" -e bash "$PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    x-terminal-emulator)
      "$TERM_EMU" -e "bash $PROXY_WRAPPER" >/dev/null 2>&1 & ;;
    xterm)
      "$TERM_EMU" -T "Lopster Proxy" -e bash "$PROXY_WRAPPER" >/dev/null 2>&1 & ;;
  esac
  # Tell the app: proxy already runs in its own terminal — detect, don't spawn.
  export LOPSTER_PROXY_EXTERNAL=1
else
  echo "[warn] No terminal emulator found — the app will start the proxy itself."
fi

# Give the proxy a moment to bind the port before the app probes /health.
sleep 2

# ── 2) the app (same as start.sh) ────────────────────────────────────────────
echo "============================================"
echo "  Starting ComposeVC (Lopster)..."
echo "  userData id: $LOPSTER_COPY_ID"
echo "  proxy:      $([ -n "$TERM_EMU" ] && echo "own terminal (external)" || echo "app-managed")"
echo "============================================"

npm run app
EXITCODE=$?

echo ""
echo "============================================"
echo "  App exited. Exit code: $EXITCODE"
echo "  (proxy terminal window stays open — Ctrl+C to stop it)"
echo "============================================"
exit $EXITCODE
