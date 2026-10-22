const fs = require("fs");
const path = require("path");

/**
 * Cumulative IDE usage statistics (Usage tab).
 *
 * Counts events that have no other durable source — files created, lines of
 * code added/removed by the agent, terminals opened, tool invocations (total +
 * per-tool + errors), and characters the user typed in prompts — and persists
 * them as a small versioned JSON document under userData.
 *
 * Deliberately does NOT re-derive anything Proxy already owns: total active
 * runtime and session count come from main.cjs's existing runtime.json
 * tracker (currentTotalRuntimeSec / runtimeSessions) and are merged into the
 * `usage:getSnapshot` IPC, so there is a single source of truth for each.
 *
 * Versioned schema (v1), atomic write (tmp + fsync + rename), debounced +
 * periodic flush, corrupt-file backup + fresh start. No secrets, tokens, or
 * prompt text are ever stored — only counters/aggregates.
 */

const SCHEMA_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const MAX_DAILY_BUCKETS = 400;
const MAX_TOOL_NAME = 120;

function nowIso() {
  return new Date().toISOString();
}

function localDateKey(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyCounters() {
  return {
    filesCreated: 0,
    linesAdded: 0,
    linesRemoved: 0,
    terminalsOpened: 0,
    toolCalls: 0,
    toolErrors: 0,
    userPromptChars: 0,
    userPrompts: 0,
  };
}

function emptyDailyBucket() {
  return {
    toolCalls: 0,
    promptChars: 0,
    filesCreated: 0,
    linesAdded: 0,
    linesRemoved: 0,
    terminals: 0,
  };
}

function emptyState() {
  return {
    v: SCHEMA_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    counters: emptyCounters(),
    tools: {}, // name -> { calls, errors }
    daily: {}, // "YYYY-MM-DD" -> daily bucket
  };
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

class UsageStore {
  constructor() {
    this.userDataPath = null;
    this.state = emptyState();
    this.dirty = false;
    this.flushTimer = null;
    this.flushInterval = null;
    this.disposed = false;
  }

  init(userDataPath) {
    if (!userDataPath || this.userDataPath) return;
    this.userDataPath = userDataPath;
    this._load();
    this.flushInterval = setInterval(() => {
      if (this.dirty) this.flushSync();
    }, FLUSH_INTERVAL_MS);
    if (this.flushInterval && typeof this.flushInterval.unref === "function") {
      this.flushInterval.unref();
    }
  }

  _file() {
    return path.join(this.userDataPath, "usage.json");
  }

  _load() {
    try {
      const raw = fs.readFileSync(this._file(), "utf8");
      this.state = this._normalize(JSON.parse(raw));
    } catch (err) {
      if (err && err.code === "ENOENT") {
        this.state = emptyState();
        return;
      }
      this._backupCorrupt(err);
      this.state = emptyState();
    }
  }

  _backupCorrupt(err) {
    try {
      const file = this._file();
      const backup = `${file}.corrupt-${Date.now()}.bak`;
      fs.copyFileSync(file, backup);
      console.error("[usage] corrupt store, backed up and reset", {
        event: "usage_store_corrupt",
        path: file,
        backupPath: backup,
        error: (err && err.message) || String(err),
      });
    } catch (e) {
      console.error("[usage] corrupt store backup failed:", (e && e.message) || e);
    }
  }

  _normalize(data) {
    const s = emptyState();
    if (!data || typeof data !== "object") return s;

    if (typeof data.v === "number" && data.v > SCHEMA_VERSION) {
      // Newer schema than we understand: keep safe defaults, never mangle fields.
      console.error("[usage] store schema newer than supported:", data.v);
    }

    const src = data.counters && typeof data.counters === "object" ? data.counters : {};
    for (const key of Object.keys(s.counters)) {
      s.counters[key] = toInt(src[key]);
    }

    if (data.tools && typeof data.tools === "object") {
      for (const [name, t] of Object.entries(data.tools)) {
        if (!t || typeof t !== "object") continue;
        const calls = toInt(t.calls);
        const errors = toInt(t.errors);
        if (calls > 0 || errors > 0) {
          s.tools[String(name).slice(0, MAX_TOOL_NAME)] = { calls, errors };
        }
      }
    }

    if (data.daily && typeof data.daily === "object") {
      for (const [key, d] of Object.entries(data.daily)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !d || typeof d !== "object") continue;
        const bucket = emptyDailyBucket();
        for (const k of Object.keys(bucket)) bucket[k] = toInt(d[k]);
        s.daily[key] = bucket;
      }
    }

    s.createdAt = typeof data.createdAt === "string" ? data.createdAt : nowIso();
    s.updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : nowIso();
    s.v = SCHEMA_VERSION;
    return s;
  }

  _mutate(fn) {
    if (this.disposed) return;
    fn(this.state);
    this.state.updatedAt = nowIso();
    this.dirty = true;
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSync();
    }, FLUSH_DEBOUNCE_MS);
    if (this.flushTimer && typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  _bumpDaily(daily, patch) {
    const key = localDateKey();
    const cur = daily[key] || emptyDailyBucket();
    for (const [k, v] of Object.entries(patch)) cur[k] = (cur[k] || 0) + v;
    daily[key] = cur;
    this._pruneDaily(daily);
  }

  _pruneDaily(daily) {
    const keys = Object.keys(daily);
    if (keys.length <= MAX_DAILY_BUCKETS) return;
    keys.sort();
    for (const k of keys.slice(0, keys.length - MAX_DAILY_BUCKETS)) delete daily[k];
  }

  recordToolCall(name, opts = {}) {
    const n = String(name || "unknown").slice(0, MAX_TOOL_NAME);
    const error = Boolean(opts && opts.error);
    this._mutate((s) => {
      s.counters.toolCalls += 1;
      if (error) s.counters.toolErrors += 1;
      const t = s.tools[n] || { calls: 0, errors: 0 };
      t.calls += 1;
      if (error) t.errors += 1;
      s.tools[n] = t;
      this._bumpDaily(s.daily, { toolCalls: 1 });
    });
  }

  recordFileCreate(lines = 0) {
    const added = toInt(lines);
    this._mutate((s) => {
      s.counters.filesCreated += 1;
      s.counters.linesAdded += added;
      this._bumpDaily(s.daily, { filesCreated: 1, linesAdded: added });
    });
  }

  recordLineChange(added = 0, removed = 0) {
    const a = toInt(added);
    const r = toInt(removed);
    if (a === 0 && r === 0) return;
    this._mutate((s) => {
      s.counters.linesAdded += a;
      s.counters.linesRemoved += r;
      this._bumpDaily(s.daily, { linesAdded: a, linesRemoved: r });
    });
  }

  recordTerminalOpen() {
    this._mutate((s) => {
      s.counters.terminalsOpened += 1;
      this._bumpDaily(s.daily, { terminals: 1 });
    });
  }

  recordUserPrompt(chars = 0) {
    const ch = toInt(chars);
    this._mutate((s) => {
      s.counters.userPrompts += 1;
      s.counters.userPromptChars += ch;
      this._bumpDaily(s.daily, { promptChars: ch });
    });
  }

  snapshot() {
    const s = this.state;
    return {
      v: s.v,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      counters: { ...s.counters },
      tools: Object.keys(s.tools)
        .map((name) => ({ name, ...s.tools[name] }))
        .sort((a, b) => b.calls - a.calls),
      daily: Object.keys(s.daily)
        .sort()
        .map((key) => ({ date: key, ...s.daily[key] })),
    };
  }

  flushSync() {
    if (!this.dirty || !this.userDataPath) return true;
    try {
      const file = this._file();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      const payload = JSON.stringify({ ...this.state, updatedAt: nowIso() }, null, 2);
      const fd = fs.openSync(tmp, "w");
      try {
        fs.writeSync(fd, payload, null, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      this.dirty = false;
      // Best-effort directory fsync so the rename survives power loss.
      try {
        const dirFd = fs.openSync(path.dirname(file), "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        /* some platforms don't allow fsync on a directory */
      }
      return true;
    } catch (err) {
      console.error("[usage] flush failed:", (err && err.message) || err);
      return false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flushSync();
  }
}

const store = new UsageStore();
module.exports = store;
module.exports.UsageStore = UsageStore;
