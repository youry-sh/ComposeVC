/**
 * Cross-process lock for userData/proxy/store.json.
 *
 * External importers (e.g. the Grok bulk-login script) mutate the same file.
 * Without a shared lock, app save + script save interleave and one side wins
 * with a stale snapshot — which wipes freshly imported accounts.
 *
 * Protocol (must stay identical to script/grok/lopster_store.py FileLock):
 * - winner atomically creates <store>.lock via O_EXCL
 * - lock content is the owner pid
 * - locks older than STALE_MS are considered abandoned and broken
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 20000;
const STALE_MS = 30000;
const RETRY_MS = 60;

function lockPathFor(file) {
  return `${file}.lock`;
}

async function isStale(lockFile) {
  try {
    const st = await fs.promises.stat(lockFile);
    return Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}

async function acquire(file, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const lockFile = lockPathFor(file);
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.promises.open(lockFile, "wx");
      try {
        await handle.writeFile(String(process.pid), "utf8");
      } finally {
        await handle.close();
      }
      return lockFile;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (await isStale(lockFile)) {
        await fs.promises.unlink(lockFile).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

async function release(lockFile) {
  if (!lockFile) return;
  await fs.promises.unlink(lockFile).catch(() => {});
}

/**
 * Run fn while holding the cross-process lock.
 * On timeout the work still runs (availability over strictness) — the store's
 * own anti-wipe guards remain the last line of defence.
 */
async function withFileLock(file, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const lockFile = await acquire(file, timeoutMs);
  if (!lockFile) {
    console.error(`storeLock: timeout waiting for ${lockPathFor(file)} — proceeding unlocked`);
    return fn();
  }
  try {
    return await fn();
  } finally {
    await release(lockFile);
  }
}

module.exports = { withFileLock, acquire, release, lockPathFor, STALE_MS };
