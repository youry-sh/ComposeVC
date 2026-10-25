/**
 * ComposeVC auto-updater — GitHub Releases feed for the private project repo.
 *
 * Flow: on launch (packaged build) → check the newest release → download the
 * NSIS installer in the background → install it on quit (or on demand from the
 * title bar). The update artefacts are produced by scripts/publish-update.mjs,
 * which uploads `ComposeVC-Setup-<version>-x64.exe` + `latest.yml` to GitHub.
 *
 * Client auth is normally NOT required: the feed lives in the public releases
 * repo (owner/repo below). A token is only needed if you point the updater at a
 * private mirror — sources, in this order (never logged, never committed):
 *   1. userData/updater.json          { "token": "github_pat_…", "private": true }
 *   2. env LOPSTER_UPDATE_TOKEN / GH_TOKEN / GITHUB_TOKEN
 *   3. resources/update-token.txt     (optional build-time token, see
 *      scripts/package-dist.mjs → LOPSTER_UPDATE_TOKEN)
 *
 * IPC (renderer): update:status | update:check | update:download |
 * update:install | update:set-config | update:open-release
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_OWNER = "youry-sh";
// Public releases repo (installers + latest.yml). The source repo stays private.
const DEFAULT_REPO = "ComposeVC-releases";
// Launch → check immediately, then keep polling every 5 minutes while the app runs.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CONFIG_FILE = "updater.json";

let app = null;
let shell = null;
let autoUpdater = null;
let configPath = null;
let config = defaultConfig();
let intervalTimer = null;
/** True while a timed background poll runs — it must not flip the visible badge. */
let backgroundCheck = false;
let started = false;
let packagedToken = "";

let state = {
  status: "idle", // idle | dev | checking | available | downloading | downloaded | up-to-date | error
  currentVersion: "0.0.0",
  version: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  releaseNotes: "",
  releaseDate: null,
  checkedAt: null,
  error: null,
};

function defaultConfig() {
  return {
    owner: DEFAULT_OWNER,
    repo: DEFAULT_REPO,
    // Public release repo by default → no token needed on client machines.
    private: false,
    token: "",
    channel: "latest",
    autoCheck: true,
    // Consent-only updates: nothing is downloaded until the user clicks
    // "Скачать и обновить" in the update panel.
    autoDownload: false,
  };
}

function readConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const merged = { ...defaultConfig(), ...(raw && typeof raw === "object" ? raw : {}) };
    merged.owner = String(merged.owner || DEFAULT_OWNER).trim() || DEFAULT_OWNER;
    merged.repo = String(merged.repo || DEFAULT_REPO).trim() || DEFAULT_REPO;
    merged.token = typeof merged.token === "string" ? merged.token.trim() : "";
    merged.private = merged.private === true;
    merged.channel = merged.channel === "beta" ? "beta" : "latest";
    merged.autoCheck = merged.autoCheck !== false;
    merged.autoDownload = merged.autoDownload === true;
    return merged;
  } catch {
    return defaultConfig();
  }
}

function saveConfig() {
  if (!configPath) return;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
    fs.renameSync(tmp, configPath);
  } catch (error) {
    console.error("[updater] config save failed:", error?.message || error);
  }
}

function readPackagedToken() {
  try {
    const file = path.join(process.resourcesPath || "", "update-token.txt");
    if (!fs.existsSync(file)) return "";
    return String(fs.readFileSync(file, "utf8") || "").trim();
  } catch {
    return "";
  }
}

function resolveToken() {
  const fromEnv =
    process.env.LOPSTER_UPDATE_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  return String(fromEnv || config.token || packagedToken || "").trim();
}

function repoLabel() {
  return `${config.owner}/${config.repo}`;
}

function releasesUrl() {
  return `https://github.com/${repoLabel()}/releases`;
}

function publicState() {
  return {
    ...state,
    repo: repoLabel(),
    channel: config.channel,
    autoCheck: config.autoCheck,
    autoDownload: config.autoDownload,
    hasToken: Boolean(resolveToken()),
    releasesUrl: releasesUrl(),
  };
}

function broadcast() {
  try {
    for (const win of require("electron").BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send("update:status", publicState());
      } catch {
        /* window closing */
      }
    }
  } catch {
    /* no windows yet */
  }
}

function setState(patch) {
  state = { ...state, ...patch };
  broadcast();
  return publicState();
}

/** Only actionable text reaches the renderer/logs — never tokens or headers. */
function describeError(error) {
  const raw = String(error?.message || error || "update failed");
  if (/404/.test(raw)) {
    return `no published release found for ${repoLabel()} — run "npm run publish:update" to ship one`;
  }
  if (/401|403/.test(raw)) {
    return `GitHub denied the update request for ${repoLabel()} — check that the releases repo is public or configure a token`;
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network/i.test(raw)) {
    return "update server unreachable — check the internet connection";
  }
  return raw.split("\n")[0].slice(0, 300);
}

function safeNotes(notes) {
  if (!notes) return "";
  const text = typeof notes === "string" ? notes : String(notes);
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

function applyFeed() {
  if (!autoUpdater) return;
  const token = resolveToken();
  const feed = {
    provider: "github",
    owner: config.owner,
    repo: config.repo,
    private: config.private === true,
  };
  if (token) feed.token = token;
  autoUpdater.setFeedURL(feed);
}

function attachEvents() {
  autoUpdater.on("checking-for-update", () => {
    // A background poll must not blank an update that is already announced —
    // otherwise the red badge would blink to a spinner every 5 minutes.
    if (backgroundCheck && (state.status === "available" || state.status === "downloaded")) return;
    setState({ status: "checking", error: null });
  });

  autoUpdater.on("update-available", (info) => {
    setState({
      status: "available",
      version: info?.version || null,
      releaseNotes: safeNotes(info?.releaseNotes),
      releaseDate: info?.releaseDate || null,
      percent: 0,
      error: null,
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on("update-not-available", () => {
    setState({ status: "up-to-date", version: null, percent: 0, error: null, checkedAt: Date.now() });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      percent: Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0))),
      transferred: Number(progress?.transferred) || 0,
      total: Number(progress?.total) || 0,
      bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
      error: null,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setState({
      status: "downloaded",
      version: info?.version || state.version,
      releaseNotes: safeNotes(info?.releaseNotes) || state.releaseNotes,
      percent: 100,
      error: null,
      checkedAt: Date.now(),
    });
  });

  autoUpdater.on("error", (error) => {
    setState({ status: "error", error: describeError(error), checkedAt: Date.now() });
  });
}

function init(userDataPath) {
  const electron = require("electron");
  app = electron.app;
  shell = electron.shell;
  state.currentVersion = app.getVersion();
  configPath = path.join(userDataPath, CONFIG_FILE);
  config = readConfig(configPath);
  packagedToken = readPackagedToken();

  try {
    // eslint-disable-next-line global-require
    autoUpdater = require("electron-updater").autoUpdater;
  } catch (error) {
    console.error("[updater] electron-updater missing:", error?.message || error);
    setState({ status: "error", error: "electron-updater module is missing from this build" });
    return publicState();
  }

  autoUpdater.autoDownload = config.autoDownload === true;
  // Never install behind the user's back: the panel's "Обновить и перезапустить"
  // is the only path (autoInstallOnAppQuit would apply it on quit).
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = config.channel === "beta";
  autoUpdater.allowDowngrade = false;
  // electron-updater logs header/URL details; keep our own quiet logger.
  autoUpdater.logger = {
    info: (msg) => console.log("[updater]", String(msg).slice(0, 200)),
    warn: (msg) => console.warn("[updater]", String(msg).slice(0, 200)),
    error: (msg) => console.warn("[updater]", String(msg).slice(0, 200)),
    debug: () => {},
  };

  attachEvents();

  if (!app.isPackaged) {
    setState({ status: "dev", error: null });
  }
  return publicState();
}

async function check(options) {
  const silent = options?.silent === true;
  if (!autoUpdater) return publicState();
  if (!app?.isPackaged) {
    return setState({ status: "dev", error: null });
  }
  if (state.status === "checking" || state.status === "downloading") return publicState();

  // An already announced update survives a failed poll — the badge keeps
  // pointing at it instead of dropping back to a neutral state.
  const known =
    state.status === "available" || state.status === "downloaded"
      ? {
          status: state.status,
          version: state.version,
          releaseNotes: state.releaseNotes,
          releaseDate: state.releaseDate,
        }
      : null;

  backgroundCheck = silent;
  try {
    applyFeed();
    if (!silent) setState({ status: "checking", error: null });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (known) {
      setState({ ...known, error: null, checkedAt: Date.now() });
    } else if (silent) {
      // Polls run every few minutes; a transient network hiccup must not park
      // the title bar in a permanent error state. Manual checks still report it.
      setState({ status: "idle", error: null, checkedAt: Date.now() });
    } else {
      setState({ status: "error", error: describeError(error), checkedAt: Date.now() });
    }
  } finally {
    backgroundCheck = false;
  }
  return publicState();
}

async function download() {
  if (!autoUpdater) return publicState();
  if (!app?.isPackaged) return setState({ status: "dev", error: null });
  try {
    applyFeed();
    setState({ status: "downloading", percent: 0, error: null });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setState({ status: "error", error: describeError(error) });
  }
  return publicState();
}

function install() {
  if (!autoUpdater) return { ok: false, error: "updater unavailable" };
  if (state.status !== "downloaded") {
    return { ok: false, error: "no downloaded update yet" };
  }
  try {
    // isSilent=true → unattended NSIS update; forceRunAfter=true → the app
    // reopens by itself once the installer finishes (close → update → open).
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function setConfig(patch) {
  const next = { ...config };
  if (!patch || typeof patch !== "object") return publicState();
  if (typeof patch.token === "string") next.token = patch.token.trim();
  if (typeof patch.owner === "string" && patch.owner.trim()) next.owner = patch.owner.trim();
  if (typeof patch.repo === "string" && patch.repo.trim()) next.repo = patch.repo.trim();
  if (patch.channel === "beta" || patch.channel === "latest") next.channel = patch.channel;
  if (typeof patch.autoCheck === "boolean") next.autoCheck = patch.autoCheck;
  if (typeof patch.private === "boolean") next.private = patch.private;
  if (typeof patch.autoDownload === "boolean") {
    next.autoDownload = patch.autoDownload;
    if (autoUpdater) autoUpdater.autoDownload = patch.autoDownload;
  }
  config = next;
  saveConfig();
  if (autoUpdater) {
    autoUpdater.allowPrerelease = config.channel === "beta";
    applyFeed();
  }
  if (config.autoCheck) schedule();
  else stopSchedule();
  return publicState();
}

function openReleasePage() {
  try {
    if (shell) void shell.openExternal(releasesUrl());
  } catch {
    /* ignore */
  }
  return { ok: true, url: releasesUrl() };
}

function schedule() {
  stopSchedule();
  if (!config.autoCheck) return;
  // Immediate check on launch (nothing waits for a delay), then a steady poll.
  void check({ silent: true });
  intervalTimer = setInterval(() => void check({ silent: true }), CHECK_INTERVAL_MS);
  if (typeof intervalTimer.unref === "function") intervalTimer.unref();
}

function stopSchedule() {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

function startAutoCheck() {
  if (started) return publicState();
  started = true;
  if (!app?.isPackaged) {
    setState({ status: "dev", error: null });
    return publicState();
  }
  schedule();
  return publicState();
}

function register(ipcMain) {
  ipcMain.handle("update:status", () => publicState());
  ipcMain.handle("update:check", () => check());
  ipcMain.handle("update:download", () => download());
  ipcMain.handle("update:install", () => install());
  ipcMain.handle("update:set-config", (_event, patch) => setConfig(patch));
  ipcMain.handle("update:open-release", () => openReleasePage());
}

module.exports = {
  init,
  register,
  startAutoCheck,
  check,
  download,
  install,
  setConfig,
  status: publicState,
  openReleasePage,
};
