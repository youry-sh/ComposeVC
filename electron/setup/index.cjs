const { platform, detectAll } = require("./detect.cjs");
const registry = require("./registry.cjs");
const store = require("./store.cjs");
const installer = require("./install.cjs");
const setupPaths = require("./paths.cjs");

/**
 * Public surface of the Setup engine. electron/main.cjs only talks to this
 * module; the renderer only talks to the `setup:*` IPC channels.
 */

async function scan(userDataPath, { force = false } = {}) {
  const plat = platform();
  const results = await detectAll(userDataPath, { force });
  const state = store.mergeDetection(userDataPath, plat, results);
  return {
    ok: true,
    platform: plat,
    components: registry.toPublic(state),
    active: installer.activeJobs(),
    scannedAt: Date.now(),
  };
}

function install(userDataPath, id) {
  return installer.installComponent(userDataPath, id, { wait: true });
}

function installAll(userDataPath) {
  return installer.installAll(userDataPath);
}

function cancel(id) {
  return installer.cancel(id);
}

/** Persisted view — available instantly after a restart, before any probe. */
function state(userDataPath) {
  const saved = store.read(userDataPath);
  return {
    ok: true,
    platform: platform(),
    savedPlatform: saved.platform,
    components: registry.toPublic(saved),
    ui: saved.ui,
    updatedAt: saved.updatedAt,
  };
}

function setCollapsedGroups(userDataPath, groups) {
  const saved = store.setCollapsedGroups(userDataPath, groups);
  return { ok: true, ui: saved.ui };
}

function manualUrl(id) {
  return registry.getComponent(id)?.manualUrl || null;
}

function ensureDownloads(userDataPath) {
  setupPaths.ensureSetupDir(userDataPath);
  return setupPaths.downloadsDir(userDataPath);
}

function downloadsPath(userDataPath) {
  return setupPaths.downloadsDir(userDataPath);
}

function flush(userDataPath) {
  store.flushSync(userDataPath);
}

function jobView(id) {
  return installer.jobView(id);
}

module.exports = {
  scan,
  install,
  installAll,
  cancel,
  state,
  setCollapsedGroups,
  manualUrl,
  ensureDownloads,
  downloadsPath,
  flush,
  jobView,
  COMPONENTS: registry.COMPONENTS,
};
