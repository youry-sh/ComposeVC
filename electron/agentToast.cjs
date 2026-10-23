const { BrowserWindow, screen } = require("electron");

const TOAST_WIDTH = 300;
const TOAST_HEIGHT = 72;
const MARGIN = 14;
const AUTO_CLOSE_MS = 4200;

/** @type {BrowserWindow | null} */
let toastWin = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let closeTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let fadeTimer = null;

const THEME_PALETTES = {
  mono: {
    surface: "#0b0b0b",
    surface2: "#101010",
    border: "#1c1c1c",
    borderStrong: "#2b2b2b",
    text: "#e8e8e8",
    muted: "#6f6f6f",
    dim: "#9a9a9a",
    accent: "#e8e8e8",
    accentSoft: "rgba(255, 255, 255, 0.06)",
    accentBorder: "rgba(255, 255, 255, 0.14)",
    bar: "#e8e8e8",
    shadow: "0 12px 32px rgba(0, 0, 0, 0.55)",
  },
  winter: {
    surface: "#0b1015",
    surface2: "#0e141a",
    border: "#1a232b",
    borderStrong: "#2a3641",
    text: "#dfe7ed",
    muted: "#6d7d8a",
    dim: "#8e9eab",
    accent: "#9db9cb",
    accentSoft: "rgba(157, 185, 203, 0.09)",
    accentBorder: "rgba(157, 185, 203, 0.20)",
    bar: "#9db9cb",
    shadow: "0 12px 32px rgba(3, 6, 9, 0.6)",
  },
  crimson: {
    surface: "#0a0909",
    surface2: "#0e0c0c",
    border: "#1f1919",
    borderStrong: "#332626",
    text: "#f2ebeb",
    muted: "#7d6a6a",
    dim: "#a08d8d",
    accent: "#e5484d",
    accentSoft: "rgba(229, 72, 77, 0.10)",
    accentBorder: "rgba(229, 72, 77, 0.26)",
    bar: "#e5484d",
    shadow: "0 12px 32px rgba(3, 2, 2, 0.70)",
  },
};

function resolvePalette(theme) {
  // Resolve the native toast palette from the incoming theme key. Known keys
  // map to their matching palette; unknown/legacy keys (ink / signal-black /
  // ember) fall back to the neutral mono palette so the toast always matches.
  return THEME_PALETTES[theme] || THEME_PALETTES.mono;
}

function clearTimers() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
}

function hardDestroy() {
  clearTimers();
  const win = toastWin;
  toastWin = null;
  if (!win || win.isDestroyed()) return;
  try {
    win.destroy();
  } catch {
    /* ignore */
  }
}

function softClose() {
  const win = toastWin;
  if (!win || win.isDestroyed()) {
    hardDestroy();
    return;
  }
  clearTimers();
  win.webContents
    .executeJavaScript(
      `(() => { const c = document.getElementById("card"); if (c) c.classList.add("out"); })()`
    )
    .catch(() => undefined);
  fadeTimer = setTimeout(() => {
    hardDestroy();
  }, 180);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildToastHtml({ appName, body, durationMs, theme }) {
  const safeApp = escapeHtml(appName || "ComposeVC");
  const safeBody = escapeHtml(body || "Agent finished.");
  const lifeMs = Math.max(1800, Number(durationMs) || AUTO_CLOSE_MS);
  const p = resolvePalette(theme);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    font-family: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-user-select: none;
    user-select: none;
    cursor: pointer;
  }
  .card {
    position: absolute;
    inset: 7px;
    display: grid;
    grid-template-columns: 26px 1fr;
    gap: 10px;
    align-items: center;
    padding: 11px 13px 12px;
    border-radius: 10px;
    background: ${p.surface};
    border: 1px solid ${p.border};
    box-shadow: ${p.shadow};
    transition: border-color 0.12s ease;
    animation: slideIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .card:hover { border-color: ${p.borderStrong}; }
  .mark {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    display: grid;
    place-items: center;
    background: ${p.accentSoft};
    border: 1px solid ${p.accentBorder};
  }
  .mark svg {
    width: 13px;
    height: 13px;
    display: block;
  }
  .copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .app {
    font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: ${p.muted};
  }
  .body {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.35;
    color: ${p.text};
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    overflow: hidden;
    pointer-events: none;
    opacity: 0.7;
  }
  .progress > i {
    display: block;
    height: 100%;
    width: 100%;
    transform-origin: left center;
    background: ${p.bar};
    animation: shrink var(--life, 4.2s) linear forwards;
  }
  @keyframes shrink {
    from { transform: scaleX(1); }
    to { transform: scaleX(0); }
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(10px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .card.out {
    animation: slideOut 0.16s ease-in forwards;
  }
  @keyframes slideOut {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to { opacity: 0; transform: translateY(6px) scale(0.99); }
  }
</style>
</head>
<body>
  <div class="card" id="card">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M7.5 12.2l3.1 3.1 5.9-6.4" stroke="${p.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="copy">
      <div class="app">${safeApp}</div>
      <div class="body">${safeBody}</div>
    </div>
    <div class="progress" aria-hidden="true"><i style="--life:${lifeMs}ms"></i></div>
  </div>
</body>
</html>`;
}

function resolveDisplayBounds(anchorWin) {
  try {
    if (anchorWin && !anchorWin.isDestroyed()) {
      const b = anchorWin.getBounds();
      return screen.getDisplayMatching(b).workArea;
    }
  } catch {
    /* fall through */
  }
  return screen.getPrimaryDisplay().workArea;
}

/**
 * Compact theme-matched toast for agent completion.
 * @param {{
 *   appName?: string,
 *   body?: string,
 *   theme?: string,
 *   anchorWin?: import('electron').BrowserWindow | null,
 *   durationMs?: number,
 *   onClick?: () => void
 * }} opts
 */
function showAgentToast(opts = {}) {
  const appName = String(opts.appName || "ComposeVC");
  const body = String(opts.body || "Agent finished.");
  const theme = String(opts.theme || "mono");
  const durationMs = Math.max(1800, Number(opts.durationMs) || AUTO_CLOSE_MS);
  const anchorWin = opts.anchorWin || null;
  const onClick = typeof opts.onClick === "function" ? opts.onClick : null;

  hardDestroy();

  const work = resolveDisplayBounds(anchorWin);
  const x = Math.round(work.x + work.width - TOAST_WIDTH - MARGIN);
  const y = Math.round(work.y + work.height - TOAST_HEIGHT - MARGIN);

  const win = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    title: appName,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      spellcheck: false,
    },
  });

  toastWin = win;

  try {
    win.setAlwaysOnTop(true, "screen-saver");
  } catch {
    try {
      win.setAlwaysOnTop(true);
    } catch {
      /* ignore */
    }
  }

  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    /* ignore */
  }

  void win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      buildToastHtml({ appName, body, durationMs, theme })
    )}`
  );

  let activated = false;
  const handleActivate = () => {
    if (activated) return;
    activated = true;
    if (onClick) {
      try {
        onClick();
      } catch {
        /* ignore */
      }
    }
    softClose();
  };

  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    win.showInactive();
  });

  win.on("closed", () => {
    if (toastWin === win) toastWin = null;
    clearTimers();
  });

  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "mouseDown" && input.button === "left") {
      handleActivate();
    }
    if (input.type === "keyDown" && input.key === "Escape") {
      softClose();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  closeTimer = setTimeout(() => {
    softClose();
  }, durationMs);

  return { shown: true, mode: "custom-toast" };
}

function closeAgentToast() {
  softClose();
}

module.exports = {
  showAgentToast,
  closeAgentToast,
};
