/**
 * Standalone Runtime companion app entry.
 * Fully separate Electron process from the main ComposeVC IDE.
 * Launch: npm run runtime  |  start-runtime.bat
 *
 * Hosts the same runtime-app/ UI + API via runtimeApp.cjs.
 * Does NOT load the main IDE (main.cjs / Vite / React).
 */

const { app } = require("electron");
const path = require("path");
const runtimeApp = require("./runtimeApp.cjs");

const appRootPath = path.resolve(__dirname, "..");
const appIconIcoPath = path.join(appRootPath, "public", "logo", "app-icon.ico");
const appIconPngPath = path.join(appRootPath, "public", "logo", "app-icon.png");

// Isolate userData from the main IDE (settings port etc.)
const runtimeUserData = path.join(app.getPath("appData"), "lopster-runtime-app");
app.setName("ComposeVC Runtime");
app.setPath("userData", runtimeUserData);

let cachedIconPath = null;
function getAppIconPath() {
  if (cachedIconPath) return cachedIconPath;
  // PNG first (most reliable nativeImage format), then ICO, then JPG fallback
  try {
    const fs = require("fs");
    if (fs.existsSync(appIconPngPath)) { cachedIconPath = appIconPngPath; return cachedIconPath; }
    if (process.platform === "win32" && fs.existsSync(appIconIcoPath)) { cachedIconPath = appIconIcoPath; return cachedIconPath; }
  } catch {
    /* */
  }
  // Fallback: logo/Compose.jpg directly
  try {
    const fs = require("fs");
    const jpgFallback = path.join(appRootPath, "logo", "Compose.jpg");
    if (fs.existsSync(jpgFallback)) { cachedIconPath = jpgFallback; return cachedIconPath; }
  } catch {
    /* */
  }
  cachedIconPath = null;
  return null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    try {
      runtimeApp.focus();
    } catch {
      /* */
    }
  });

  app.whenReady().then(async () => {
    try {
      const res = await runtimeApp.start({
        userDataPath: app.getPath("userData"),
        appIconPath: getAppIconPath(),
      });
      if (!res?.ok) {
        console.error("[runtime] failed to start:", res?.error || "unknown error");
        app.quit();
      } else {
        console.log(
          `[runtime] ready · ${res.url || `http://127.0.0.1:${res.port}/`}${
            res.alreadyRunning ? " (already running)" : ""
          }`
        );
      }
    } catch (error) {
      console.error("[runtime] start error:", error?.message || error);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    void (async () => {
      try {
        await runtimeApp.stop();
      } catch {
        /* */
      }
      if (process.platform !== "darwin") app.quit();
    })();
  });

  app.on("activate", () => {
    const st = runtimeApp.getStatus();
    if (!st.running) {
      void runtimeApp.start({
        userDataPath: app.getPath("userData"),
        appIconPath: getAppIconPath(),
      });
    } else {
      runtimeApp.focus();
    }
  });

  app.on("before-quit", () => {
    try {
      runtimeApp.disposeSync();
    } catch {
      /* */
    }
  });
}
