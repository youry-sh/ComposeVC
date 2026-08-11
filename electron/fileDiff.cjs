const DEFAULT_CONTEXT = 3;
const MAX_LINES_FOR_FULL = 8000;
const MAX_HUNKS = 40;
const MAX_DIFF_CHARS = 48000;

function splitLines(text) {
  if (text == null) return [];
  const raw = String(text);
  if (raw.length === 0) return [];
  const parts = raw.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function hashLine(line) {
  let h = 2166136261;
  for (let i = 0; i < line.length; i += 1) {
    h ^= line.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const prev = new Uint16Array(m + 1);
  const curr = new Uint16Array(m + 1);
  const rows = new Array(n + 1);
  rows[0] = prev.slice();
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j += 1) {
      if (ai === b[j - 1]) curr[j] = prev[j - 1] + 1;
      else curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
    }
    rows[i] = curr.slice();
    prev.set(curr);
  }
  return rows;
}

function buildOps(a, b) {
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) {
    return b.map((line, i) => ({ op: "add", line, newLine: i + 1 }));
  }
  if (b.length === 0) {
    return a.map((line, i) => ({ op: "del", line, oldLine: i + 1 }));
  }

  if (a.length * b.length > MAX_LINES_FOR_FULL * MAX_LINES_FOR_FULL) {
    return buildOpsGreedy(a, b);
  }

  const table = lcsTable(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ op: "eq", line: a[i - 1], oldLine: i, newLine: j });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
      ops.push({ op: "add", line: b[j - 1], newLine: j });
      j -= 1;
    } else {
      ops.push({ op: "del", line: a[i - 1], oldLine: i });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

function buildOpsGreedy(a, b) {
  const bMap = new Map();
  for (let j = 0; j < b.length; j += 1) {
    const h = hashLine(b[j]);
    if (!bMap.has(h)) bMap.set(h, []);
    bMap.get(h).push(j);
  }
  const used = new Set();
  const ops = [];
  let jCursor = 0;
  for (let i = 0; i < a.length; i += 1) {
    const h = hashLine(a[i]);
    const candidates = bMap.get(h) || [];
    let match = -1;
    for (const j of candidates) {
      if (j >= jCursor && !used.has(j) && b[j] === a[i]) {
        match = j;
        break;
      }
    }
    if (match >= 0) {
      while (jCursor < match) {
        ops.push({ op: "add", line: b[jCursor], newLine: jCursor + 1 });
        jCursor += 1;
      }
      ops.push({ op: "eq", line: a[i], oldLine: i + 1, newLine: match + 1 });
      used.add(match);
      jCursor = match + 1;
    } else {
      ops.push({ op: "del", line: a[i], oldLine: i + 1 });
    }
  }
  while (jCursor < b.length) {
    ops.push({ op: "add", line: b[jCursor], newLine: jCursor + 1 });
    jCursor += 1;
  }
  return ops;
}

function summarizeOps(ops) {
  let added = 0;
  let removed = 0;
  let equal = 0;
  for (const op of ops) {
    if (op.op === "add") added += 1;
    else if (op.op === "del") removed += 1;
    else equal += 1;
  }
  return {
    added,
    removed,
    equal,
    changed: added + removed > 0,
  };
}

function groupHunks(ops, context = DEFAULT_CONTEXT) {
  const changeIdx = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].op !== "eq") changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  const ranges = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k += 1) {
    const c = changeIdx[k];
    const nextStart = Math.max(0, c - context);
    if (nextStart <= end + 1) {
      end = Math.min(ops.length - 1, c + context);
    } else {
      ranges.push([start, end]);
      start = nextStart;
      end = Math.min(ops.length - 1, c + context);
    }
  }
  ranges.push([start, end]);
  return ranges;
}

function formatUnifiedDiff(oldPath, newPath, ops, opts = {}) {
  const context = Number.isFinite(opts.context) ? opts.context : DEFAULT_CONTEXT;
  const maxHunks = Number.isFinite(opts.maxHunks) ? opts.maxHunks : MAX_HUNKS;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : MAX_DIFF_CHARS;
  const hunks = groupHunks(ops, context);
  const stats = summarizeOps(ops);

  if (hunks.length === 0) {
    return {
      unified: `--- a/${oldPath}\n+++ b/${newPath}\n(no changes)`,
      stats,
      hunkCount: 0,
      truncated: false,
    };
  }

  const lines = [`--- a/${oldPath}`, `+++ b/${newPath}`];
  let truncated = false;
  let shown = 0;

  for (const [hs, he] of hunks) {
    if (shown >= maxHunks) {
      truncated = true;
      break;
    }
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (let i = hs; i <= he; i += 1) {
      const op = ops[i];
      if (op.op === "eq") {
        if (!oldStart) oldStart = op.oldLine;
        if (!newStart) newStart = op.newLine;
        oldCount += 1;
        newCount += 1;
      } else if (op.op === "del") {
        if (!oldStart) oldStart = op.oldLine;
        oldCount += 1;
      } else if (op.op === "add") {
        if (!newStart) newStart = op.newLine;
        newCount += 1;
      }
    }
    if (!oldStart) oldStart = 1;
    if (!newStart) newStart = 1;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = hs; i <= he; i += 1) {
      const op = ops[i];
      if (op.op === "eq") lines.push(` ${op.line}`);
      else if (op.op === "del") lines.push(`-${op.line}`);
      else lines.push(`+${op.line}`);
    }
    shown += 1;
    if (lines.join("\n").length > maxChars) {
      truncated = true;
      break;
    }
  }

  if (truncated) {
    lines.push(`... truncated (${hunks.length - shown} more hunks, +${stats.added}/-${stats.removed})`);
  }

  let unified = lines.join("\n");
  if (unified.length > maxChars) {
    unified = unified.slice(0, maxChars) + "\n... truncated by size";
    truncated = true;
  }

  return {
    unified,
    stats,
    hunkCount: hunks.length,
    shownHunks: shown,
    truncated,
  };
}

function diffTexts(oldText, newText, opts = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = buildOps(oldLines, newLines);
  const oldPath = opts.oldPath || "old";
  const newPath = opts.newPath || "new";
  const formatted = formatUnifiedDiff(oldPath, newPath, ops, opts);
  return {
    oldLines: oldLines.length,
    newLines: newLines.length,
    ...formatted,
  };
}

function quickChanged(oldText, newText) {
  if (oldText === newText) {
    return { changed: false, added: 0, removed: 0, equal: splitLines(oldText).length };
  }
  if (oldText == null || newText == null) {
    const a = splitLines(oldText || "");
    const b = splitLines(newText || "");
    return {
      changed: true,
      added: b.length,
      removed: a.length,
      equal: 0,
    };
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > 2500 * 2500) {
    let equal = 0;
    const n = Math.min(oldLines.length, newLines.length);
    for (let i = 0; i < n; i += 1) {
      if (oldLines[i] === newLines[i]) equal += 1;
      else break;
    }
    let equalEnd = 0;
    for (let i = 0; i < n - equal; i += 1) {
      if (oldLines[oldLines.length - 1 - i] === newLines[newLines.length - 1 - i]) equalEnd += 1;
      else break;
    }
    const removed = oldLines.length - equal - equalEnd;
    const added = newLines.length - equal - equalEnd;
    return {
      changed: added + removed > 0,
      added: Math.max(0, added),
      removed: Math.max(0, removed),
      equal: equal + equalEnd,
      approx: true,
    };
  }
  return summarizeOps(buildOps(oldLines, newLines));
}

module.exports = {
  splitLines,
  diffTexts,
  quickChanged,
  summarizeOps,
  DEFAULT_CONTEXT,
  MAX_DIFF_CHARS,
};
