/**
 * Code Impact Host — production wiring for CodeImpactEngine.
 * Lazy per-project index, per-turn obligation session, safe after-write hooks.
 * Never throws into the agent tool path (best-effort).
 */

const path = require("path");
const { CodeImpactEngine, normPath } = require("./codeImpactEngine.cjs");

/** @type {Map<string, { engine: import('./codeImpactEngine.cjs').CodeImpactEngine, ready: Promise<void>|null, lastError: string|null }>} */
const PROJECTS = new Map();

/** Tools that mutate project files and must refresh impact after success. */
const WRITE_TOOLS = new Set(["edit_file", "create_file", "restore_backup"]);

const MAX_INJECT_CHARS = 2200;
const MAX_NUDGES_PER_TURN = 2;

function rootKey(rootPath) {
  if (!rootPath || typeof rootPath !== "string") return null;
  try {
    return path.resolve(rootPath);
  } catch {
    return null;
  }
}

function getProject(rootPath) {
  const key = rootKey(rootPath);
  if (!key) return null;
  let entry = PROJECTS.get(key);
  if (!entry) {
    entry = {
      engine: new CodeImpactEngine({ root: key }),
      ready: null,
      lastError: null,
      indexedAt: 0,
    };
    PROJECTS.set(key, entry);
  }
  return entry;
}

/**
 * Ensure project is indexed (lazy). Concurrent callers share one promise.
 */
async function ensureIndexed(rootPath, { force = false } = {}) {
  const entry = getProject(rootPath);
  if (!entry) return null;
  if (!force && entry.ready && entry.indexedAt > 0) {
    try {
      await entry.ready;
      return entry.engine;
    } catch {
      /* retry below */
    }
  }
  if (!force && entry.ready) {
    try {
      await entry.ready;
      return entry.engine;
    } catch {
      /* fallthrough */
    }
  }
  entry.ready = (async () => {
    try {
      await entry.engine.fullIndex();
      entry.indexedAt = Date.now();
      entry.lastError = null;
    } catch (err) {
      entry.lastError = err instanceof Error ? err.message : String(err);
      entry.indexedAt = 0;
      throw err;
    }
  })();
  try {
    await entry.ready;
  } catch {
    return entry.engine; // partial / empty ok
  }
  return entry.engine;
}

function toProjectRel(rootPath, filePath) {
  if (!rootPath || !filePath) return null;
  try {
    const root = path.resolve(rootPath);
    const abs = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return normPath(rel);
  } catch {
    return null;
  }
}

/**
 * Per-agent-turn session: obligations live HERE (not on shared engine.session)
 * so parallel chats / subagents cannot clobber each other.
 */
function createTurnSession(rootPath) {
  const key = rootKey(rootPath);
  const state = {
    rootPath: key,
    enabled: Boolean(key),
    nudgeCount: 0,
    lastCard: null,
    lastWritePaths: [],
    writeCount: 0,
    injectCount: 0,
    softAllowed: false,
    // Private obligation maps — engine is index-only for concurrent safety
    open: new Map(),
    closed: new Set(),
  };

  // Still reset engine.session for legacy code paths; primary state is on `state`.
  if (key) {
    const entry = getProject(key);
    try {
      entry.engine.resetSession();
    } catch {
      /* */
    }
  }

  function getOpenList() {
    return [...state.open.values()].sort((a, b) => {
      const rank = { blocker: 0, should: 1, info: 2 };
      return (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9);
    });
  }

  function formatOpenCard(engine, impactResult) {
    const open = getOpenList();
    return engine.formatImpactCard({
      touched: impactResult?.touched || state.lastWritePaths,
      obligations: open.slice(0, engine.budget?.maxObligations || 12),
      openBlockers: open.filter((o) => o.severity === "blocker").length,
      openShould: open.filter((o) => o.severity === "should").length,
      truncated: open.length > (engine.budget?.maxObligations || 12),
      totalCandidates: open.length,
    });
  }

  /**
   * Merge pure impact obligations into this turn's open set (after real writes).
   */
  function mergeImpactIntoSession(engine, imp, writtenRels) {
    const written = new Set((writtenRels || []).map(normPath));
    engine.purgeInvalidObligations?.();
    for (const o of imp.obligations || []) {
      if (state.closed.has(o.id)) continue;
      if (
        (o.kind === "registers" || o.edge === "registers") &&
        /tests\/|\.test\.(cjs|js|mjs|ts)/i.test(String(o.reason || "") + String(o.id || ""))
      ) {
        state.closed.add(o.id);
        continue;
      }
      // auto-close non-blockers whose path was just written
      if (written.has(normPath(o.path)) && o.severity !== "blocker") {
        state.closed.add(o.id);
        state.open.delete(o.id);
        continue;
      }
      if (written.has(normPath(o.path)) && o.kind === "registers") {
        state.closed.add(o.id);
        state.open.delete(o.id);
        continue;
      }
      state.open.set(o.id, { ...o, sinceWrite: state.writeCount });
    }
    // close any open obligation whose path was written this batch
    for (const [id, o] of [...state.open]) {
      if (written.has(normPath(o.path))) {
        state.closed.add(id);
        state.open.delete(id);
      }
    }
    // structural: if reg-missing but tool now required — close
    for (const [id, o] of [...state.open]) {
      if (o.kind === "registers" && o.severity === "blocker" && /reg-missing:/.test(id)) {
        const still = (imp.obligations || []).some((x) => x.id === id);
        if (!still) {
          state.closed.add(id);
          state.open.delete(id);
        }
      }
      if (o.kind === "ipc" && /ipc-missing-handle:/.test(id)) {
        const still = (imp.obligations || []).some((x) => x.id === id);
        if (!still) {
          state.closed.add(id);
          state.open.delete(id);
        }
      }
    }
  }

  async function afterWritePaths(paths) {
    if (!state.enabled || !key) return null;
    const rels = [];
    for (const p of paths || []) {
      const rel = toProjectRel(key, p);
      if (rel) rels.push(rel);
    }
    if (!rels.length) return null;

    try {
      const engine = await ensureIndexed(key);
      if (!engine) return null;
      // reindex written paths only (index mutation); session merge is local
      await engine.reindexPaths(rels);
      const imp = engine.impact({ paths: rels });
      state.writeCount += 1;
      state.lastWritePaths = rels;
      mergeImpactIntoSession(engine, imp, rels);
      // keep engine.session in sync for any legacy beforeFinal on engine
      try {
        engine.session.open = new Map(state.open);
        engine.session.closed = new Set(state.closed);
        engine.session.writeCount = state.writeCount;
      } catch {
        /* */
      }
      const open = getOpenList();
      const card = formatOpenCard(engine, imp);
      state.lastCard = card;
      state.injectCount += 1;
      return {
        card,
        open,
        openBlockers: open.filter((o) => o.severity === "blocker").length,
        impact: imp,
      };
    } catch (err) {
      const entry = getProject(key);
      if (entry) entry.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Extract written path(s) from a successful write tool outcome and update impact.
   */
  async function noteWriteTool(toolName, data) {
    if (!state.enabled) return null;
    if (!WRITE_TOOLS.has(toolName)) return null;
    if (!data || typeof data !== "object") return null;
    // edit_file / create_file / restore_backup → path; restore may also return paths[]
    const paths = [];
    if (typeof data.path === "string" && data.path) paths.push(data.path);
    if (Array.isArray(data.paths)) {
      for (const p of data.paths) if (typeof p === "string" && p) paths.push(p);
    }
    if (typeof data.restoredPath === "string" && data.restoredPath) {
      paths.push(data.restoredPath);
    }
    if (!paths.length) return null;
    return afterWritePaths(paths);
  }

  /**
   * Batch coalesced after-write (one reindex+card for many paths).
   */
  async function noteWritePaths(paths) {
    return afterWritePaths(paths);
  }

  function beforeFinal() {
    if (!state.enabled || !key) {
      return { allowFinal: true, nudge: null, openBlockers: 0 };
    }
    try {
      const entry = getProject(key);
      if (!entry) return { allowFinal: true, nudge: null, openBlockers: 0 };
      const open = getOpenList();
      const blockers = open.filter((o) => o.severity === "blocker");
      if (blockers.length === 0) {
        return { allowFinal: true, nudge: null, openBlockers: 0, openShould: open.length };
      }
      if (state.nudgeCount >= MAX_NUDGES_PER_TURN) {
        state.softAllowed = true;
        const residual = blockers
          .slice(0, 6)
          .map((o) => `- ${o.path} — ${o.reason}`)
          .join("\n");
        return {
          allowFinal: true,
          nudge: null,
          openBlockers: blockers.length,
          softAllowed: true,
          residualNote:
            `## code_impact_soft_allow\nopen blockers abandoned after ${MAX_NUDGES_PER_TURN} nudges:\n` +
            residual,
        };
      }
      state.nudgeCount += 1;
      const lines = [
        "## code_impact_nudge",
        `open blockers: ${blockers.length} — do NOT finish yet`,
        "required:",
      ];
      for (const o of blockers.slice(0, 6)) {
        lines.push(`- ${o.path} — ${o.reason}${o.id ? ` id=${o.id}` : ""}`);
      }
      lines.push(
        "action: read_file/edit_file these paths after verify"
      );
      return {
        allowFinal: false,
        nudge: lines.join("\n"),
        openBlockers: blockers.length,
        openShould: open.filter((o) => o.severity === "should").length,
      };
    } catch {
      return { allowFinal: true, nudge: null, openBlockers: 0 };
    }
  }

  function markReviewed(paths, opts = {}) {
    if (!state.enabled || !key) return [];
    try {
      const entry = getProject(key);
      if (!entry) return [];
      const rels = (paths || [])
        .map((p) => toProjectRel(key, p) || normPath(p))
        .filter(Boolean);
      // Use engine path-matching logic against OUR open map
      const saved = entry.engine.session;
      entry.engine.session = {
        open: state.open,
        closed: state.closed,
        lastInject: state.lastCard,
        writeCount: state.writeCount,
      };
      try {
        entry.engine.markReviewed(rels, opts);
      } finally {
        // keep maps (same object refs if mutated in place)
        state.open = entry.engine.session.open;
        state.closed = entry.engine.session.closed;
        entry.engine.session = saved;
      }
      return getOpenList();
    } catch {
      return getOpenList();
    }
  }

  /**
   * Auto-close should/info (and optionally blockers) when agent successfully read a path.
   */
  function markSeenOnRead(filePath, { closeBlockers = false } = {}) {
    if (!state.enabled || !key || !filePath) return getOpenList();
    const rel = toProjectRel(key, filePath) || normPath(filePath);
    if (!rel) return getOpenList();
    for (const [id, o] of [...state.open]) {
      const op = normPath(o.path);
      const hit =
        op === rel ||
        op.endsWith("/" + rel) ||
        path.posix.basename(op) === path.posix.basename(rel);
      if (!hit) continue;
      if (o.severity === "blocker" && !closeBlockers) {
        // still credit should-level: leave blocker but mark seen
        o.seen = true;
        continue;
      }
      state.closed.add(id);
      state.open.delete(id);
    }
    return getOpenList();
  }

  function getOpen() {
    return getOpenList();
  }

  function getLastCard() {
    return state.lastCard;
  }

  return {
    state,
    afterWritePaths,
    noteWriteTool,
    noteWritePaths,
    beforeFinal,
    markReviewed,
    markSeenOnRead,
    getOpen,
    getLastCard,
    ensureIndexed: () => ensureIndexed(key),
  };
}

/**
 * Append impact card under a write tool result (budgeted).
 */
function appendCardToToolText(baseText, card) {
  if (!card || typeof card !== "string") return baseText;
  const trimmed = card.trim();
  if (!trimmed) return baseText;
  const sep = "\n\n";
  let combined = `${baseText || ""}${sep}${trimmed}`;
  // Keep total tool display reasonable (write result + card).
  const hard = TOOL_WRITE_DISPLAY_LIMIT;
  if (combined.length > hard) {
    combined = combined.slice(0, hard - 20) + "\n…(impact truncated)";
  }
  return combined;
}

const TOOL_WRITE_DISPLAY_LIMIT = 6000;

/**
 * Invalidate / drop cached engine (tests or project close).
 */
function dropProject(rootPath) {
  const key = rootKey(rootPath);
  if (key) PROJECTS.delete(key);
}

function dropAll() {
  PROJECTS.clear();
}

module.exports = {
  createTurnSession,
  ensureIndexed,
  getProject,
  toProjectRel,
  appendCardToToolText,
  dropProject,
  dropAll,
  WRITE_TOOLS,
  MAX_INJECT_CHARS,
  MAX_NUDGES_PER_TURN,
};
