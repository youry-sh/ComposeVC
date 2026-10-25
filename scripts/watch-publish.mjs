/**
 * watch-publish.mjs — «изменил проект → у пользователей обновление».
 *
 * Watches the project folder (C:\…\ComposeVC) and, after the edits settle,
 * commits + pushes the repo, bumps the patch version, builds the hardened
 * installer and publishes a GitHub release. Installed apps pick it up on their
 * next automatic check.
 *
 * Guards:
 *   • build output folders (release/, release-assets/, dist/) are ignored so the
 *     publish itself never re-triggers the watcher
 *   • debounce — waits until you stop typing (default 45 s)
 *   • single flight — one publish at a time, extra changes are queued
 *   • clean-tree skip — if git has nothing to publish, nothing runs
 *   • throttle — at most one release per N minutes (default 10 min)
 *
 * Usage:
 *   npm run watch:publish
 *   node scripts/watch-publish.mjs --debounce 30 --min-gap 15
 *   node scripts/watch-publish.mjs --now        # publish current changes first
 *   node scripts/watch-publish.mjs --dry-run    # log only, never publish
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (has("--help") || has("-h")) {
  console.log(`watch-publish.mjs — auto-publish ComposeVC on every project change

Options:
  --debounce <sec>   quiet period before publishing (default 45)
  --min-gap <min>    minimum minutes between releases (default 10)
  --now              publish the current dirty tree immediately on start
  --dry-run          only log what would happen
  --no-push          build + release locally, skip git commit/push
`);
  process.exit(0);
}

const debounceMs = Math.max(5, Number(valueOf("--debounce") || 45)) * 1000;
const minGapMs = Math.max(0, Number(valueOf("--min-gap") || 10)) * 60 * 1000;
const dryRun = has("--dry-run");
const publishNow = has("--now");
const noPush = has("--no-push");

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".backup",
  ".agent-memory",
  "release",
  "release-assets",
  "dist",
  "build",
  "coverage",
  "profiles",
  "web-ide",
  ".vite",
]);

const IGNORED_FILE_RE = [
  /\.log$/i,
  /\.tmp$/i,
  /^build2?-out\.log$/i,
  /^build2?-err\.log$/i,
  /^crash\.log$/i,
  /^start-log\.txt$/i,
  /^test-file\.txt$/i,
  /~$/,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

let timer = null;
let publishing = false;
let pending = false;
let lastPublishAt = 0;
let skippedLogged = false;

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function log(message) {
  console.log(`[watch ${stamp()}] ${message}`);
}

function isRelevant(relative) {
  const parts = String(relative).split(/[\\/]+/);
  if (parts.some((part) => IGNORED_DIRS.has(part))) return false;
  return !IGNORED_FILE_RE.some((re) => re.test(relative));
}

function git(args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function isDirty() {
  const res = git(["status", "--porcelain"]);
  if (res.status !== 0) return false;
  return String(res.stdout || "").trim().length > 0;
}

function changedCount() {
  const res = git(["status", "--porcelain"]);
  if (res.status !== 0) return 0;
  return String(res.stdout || "")
    .split(/\r?\n/)
    .filter(Boolean).length;
}

function currentTree() {
  const res = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" });
  if (res.status !== 0) return "";
  return String(res.stdout || "").trim();
}

function publishStatePath() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || root;
  return path.join(base, "ComposeVC", "publish-state.json");
}

/** Tree hash of the last published release (written by publish-update / hotkey). */
function lastPublishedTree() {
  try {
    const raw = JSON.parse(fs.readFileSync(publishStatePath(), "utf8"));
    return String(raw?.tree || "").trim();
  } catch {
    return "";
  }
}

function runPublish() {
  if (publishing) {
    pending = true;
    return;
  }
  const gap = Date.now() - lastPublishAt;
  if (gap < minGapMs) {
    const waitSec = Math.ceil((minGapMs - gap) / 1000);
    log(`throttled — next release allowed in ${waitSec}s`);
    schedule(waitSec * 1000 + 500);
    return;
  }

  // The IDE auto-commits edits, so a clean `git status` does not mean "nothing
  // changed" — compare the current tree with the last published release.
  const tree = currentTree();
  const published = lastPublishedTree();
  const changed = isDirty() || !tree || !published || tree !== published;
  if (!changed) {
    log("nothing new since the last published release — skipping");
    return;
  }

  const count = changedCount();
  log(`publishing ${count} changed file(s)…`);
  if (dryRun) {
    log("dry-run: would run scripts/publish-update.mjs --bump patch");
    lastPublishAt = Date.now();
    return;
  }

  publishing = true;
  const started = Date.now();
  const args = [path.join("scripts", "publish-update.mjs"), "--bump", "patch"];
  if (noPush) args.push("--no-git");
  const res = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  publishing = false;
  lastPublishAt = Date.now();

  if (res.status === 0) {
    log(`release published in ${Math.round((Date.now() - started) / 1000)}s`);
  } else {
    log(`publish failed (exit ${res.status}) — watch continues; fix and save again`);
  }

  if (pending) {
    pending = false;
    schedule(2000);
  }
}

function schedule(delay = debounceMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    runPublish();
  }, delay);
}

function onFsEvent(event, filename) {
  const rel = filename ? String(filename) : "";
  if (rel && !isRelevant(rel)) return;
  if (!rel && skippedLogged) return;
  if (!rel) skippedLogged = true;
  schedule();
}

log(`watching ${root}`);
log(`debounce ${Math.round(debounceMs / 1000)}s · throttle ${Math.round(minGapMs / 60000)}min`);
log("every project change → git commit/push → build installer → GitHub release");

let watcher;
try {
  watcher = fs.watch(root, { recursive: true }, onFsEvent);
} catch (error) {
  console.error(`[watch] cannot watch ${root}: ${error.message}`);
  process.exit(1);
}

watcher.on("error", (error) => log(`watcher error: ${error.message}`));

if (publishNow) {
  schedule(1000);
} else if (isDirty()) {
  log("uncommitted changes detected — will publish them shortly");
  schedule();
}

const shutdown = () => {
  try {
    watcher.close();
  } catch {
    /* */
  }
  log("stopped");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
