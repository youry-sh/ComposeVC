const fs = require("fs");
const os = require("os");
const path = require("path");
const knowledgeStore = require("./knowledgeStore.cjs");
const { compressDirToZip, expandZipToDir } = require("../ctl/toolZip.cjs");

const ARCHIVE_PREFIX = "composevc-knowledge";

function normalizeDir(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : "";
}

function samePath(a, b) {
  if (!a || !b) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

async function pathExists(target) {
  try {
    await fs.promises.access(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function buildArchiveName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
  return `${ARCHIVE_PREFIX}-${stamp}.zip`;
}

async function uniqueDestination(dir, fileName) {
  const extension = path.extname(fileName);
  const stem = path.basename(fileName, extension);
  let candidate = path.join(dir, fileName);
  for (let index = 2; await pathExists(candidate); index += 1) {
    candidate = path.join(dir, `${stem}-${index}${extension}`);
    if (index > 500) throw new Error(`Cannot find a free file name in ${dir}`);
  }
  return candidate;
}

/**
 * Export the whole LAB-IN knowledge base as a ZIP.
 * The archive is written to the desktop and to the open project folder
 * (each destination is best-effort; at least one must succeed).
 */
async function exportKnowledgeArchive(userDataPath, options = {}) {
  const destinations = [];
  const desktopPath = normalizeDir(options.desktopPath);
  const projectPath = normalizeDir(options.rootPath);
  if (desktopPath) destinations.push({ label: "desktop", dir: desktopPath });
  if (projectPath && !destinations.some((item) => samePath(item.dir, projectPath))) {
    destinations.push({ label: "project", dir: projectPath });
  }
  if (!destinations.length) {
    throw new Error("No export destination available (desktop or project folder)");
  }

  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-knowledge-export-"));
  const snapshotDir = path.join(staging, "knowledge");
  const zipPath = path.join(staging, "knowledge.zip");

  try {
    const snapshot = await knowledgeStore.buildKnowledgeSnapshot(userDataPath, snapshotDir);
    if (!snapshot.chunkCount) {
      throw new Error("Knowledge base is empty — nothing to export");
    }

    await compressDirToZip(snapshotDir, zipPath);
    const stat = await fs.promises.stat(zipPath);
    const archiveName = buildArchiveName();

    const copies = [];
    const failures = [];
    for (const destination of destinations) {
      try {
        await fs.promises.mkdir(destination.dir, { recursive: true });
        const target = await uniqueDestination(destination.dir, archiveName);
        await fs.promises.copyFile(zipPath, target);
        copies.push({
          label: destination.label,
          dir: destination.dir,
          path: target,
          bytes: stat.size,
        });
      } catch (error) {
        failures.push({
          label: destination.label,
          dir: destination.dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!copies.length) {
      const detail = failures.map((item) => `${item.label}: ${item.error}`).join(" | ");
      throw new Error(`Knowledge archive could not be saved: ${detail}`);
    }

    return {
      archiveName: path.basename(copies[0].path),
      bytes: stat.size,
      chunkCount: snapshot.chunkCount,
      totalChars: snapshot.totalChars,
      copies,
      failures,
    };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Pick the folder that actually contains the knowledge snapshot. */
async function resolveArchiveRoot(extractDir, depth = 0) {
  if (await pathExists(path.join(extractDir, "manifest.json"))) return extractDir;
  const entries = await fs.promises.readdir(extractDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());

  if (!files.length && dirs.length === 1 && depth < 3) {
    return resolveArchiveRoot(path.join(extractDir, dirs[0].name), depth + 1);
  }
  for (const dir of dirs.slice(0, 20)) {
    const child = path.join(extractDir, dir.name);
    if (await pathExists(path.join(child, "manifest.json"))) return child;
  }
  return extractDir;
}

/**
 * Extract a ZIP and restore it into the live knowledge store.
 * Normalisation, duplicate detection and link remapping live in the store.
 */
async function importKnowledgeArchive(userDataPath, zipPath) {
  const archivePath = normalizeDir(zipPath);
  if (!archivePath) throw new Error("Choose a knowledge ZIP archive");
  if (!/\.zip$/i.test(archivePath)) throw new Error("Knowledge import accepts .zip archives only");
  const stat = await fs.promises.stat(archivePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`ZIP archive not found: ${archivePath}`);

  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-knowledge-import-"));
  const extractDir = path.join(staging, "archive");
  try {
    await expandZipToDir(archivePath, extractDir);
    const root = await resolveArchiveRoot(extractDir);
    const result = await knowledgeStore.importKnowledgeSnapshot(userDataPath, root);
    return {
      ...result,
      archivePath,
      archiveName: path.basename(archivePath),
    };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = {
  exportKnowledgeArchive,
  importKnowledgeArchive,
  resolveArchiveRoot,
  buildArchiveName,
};
