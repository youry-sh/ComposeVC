const fs = require("fs");
const fileBackup = require("../fileBackup.cjs");

const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

function normalizeQuotes(str) {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

function stripTrailingWhitespace(str) {
  return str.replace(/[^\S\r\n]+(?=\r\n|\n|\r|$)/g, "");
}

function detectLineEnding(content) {
  const crlf = (content.match(/\r\n/g) || []).length;
  const lf = (content.match(/(?<!\r)\n/g) || []).length;
  const cr = (content.match(/\r(?!\n)/g) || []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

function normalizeLineEndings(str, eol) {
  return str.replace(/\r\n|\r|\n/g, eol);
}

/**
 * Models / JSON parsers often turn Windows path segments into control chars:
 *   C:\tools → "C:" + TAB + "ools",  go\bin → "go" + BACKSPACE + "in"
 * Only repair when the control char sits in a path-like place (after drive ":",
 * letter, or slash) — NOT after a digit (read_file "12\\tcode") or at indent.
 */
function repairWindowsPathControlChars(str) {
  if (typeof str !== "string" || !str) return str;
  if (!/[\t\b\f]/.test(str)) return str;
  return str
    .replace(/([A-Za-z:\\/])\t(?=[A-Za-z0-9_.])/g, "$1\\t")
    .replace(/([A-Za-z0-9_.:\\/])\x08(?=[A-Za-z0-9_.])/g, "$1\\b")
    .replace(/([A-Za-z0-9_.:\\/])\f(?=[A-Za-z0-9_.])/g, "$1\\f");
}

function findAllLiteral(haystack, needle, strategy = "exact", replacementMapper) {
  if (needle === "") return [];
  const matches = [];
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    matches.push({
      start: index,
      end: index + needle.length,
      actual: haystack.slice(index, index + needle.length),
      strategy,
      replacementMapper,
    });
    start = index + Math.max(needle.length, 1);
  }
  return matches;
}

function dedupeMatches(matches) {
  const seen = new Set();
  const result = [];
  for (const match of matches) {
    const key = `${match.start}:${match.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(match);
    }
  }
  return result;
}

function isOpeningQuoteContext(chars, index) {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return prev === " " || prev === "\t" || prev === "\n" || prev === "\r" || prev === "(" || prev === "[" || prev === "{" || prev === "—" || prev === "–";
}

function applyCurlyDoubleQuotes(str) {
  return [...str].map((char, index, chars) => char === '"' ? (isOpeningQuoteContext(chars, index) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE) : char).join("");
}

function applyCurlySingleQuotes(str) {
  return [...str].map((char, index, chars) => {
    if (char !== "'") return char;
    const prev = index > 0 ? chars[index - 1] : undefined;
    const next = index < chars.length - 1 ? chars[index + 1] : undefined;
    const isApostrophe = prev !== undefined && next !== undefined && /\p{L}/u.test(prev) && /\p{L}/u.test(next);
    return isApostrophe ? RIGHT_SINGLE_CURLY_QUOTE : (isOpeningQuoteContext(chars, index) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE);
  }).join("");
}

function preserveQuoteStyle(oldString, actualOldString, newString) {
  if (oldString === actualOldString) return newString;
  const hasDoubleQuotes = actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes = actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) || actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);
  return result;
}

function findNormalizedQuoteMatches(content, oldString) {
  const normalizedContent = normalizeQuotes(content);
  const normalizedOld = normalizeQuotes(oldString);
  if (normalizedContent === content && normalizedOld === oldString) return [];

  const matches = [];
  let start = 0;
  while (true) {
    const index = normalizedContent.indexOf(normalizedOld, start);
    if (index === -1) break;
    matches.push({
      start: index,
      end: index + oldString.length,
      actual: content.slice(index, index + oldString.length),
      strategy: "quote-normalized",
      replacementMapper: (replacement, actual) => preserveQuoteStyle(oldString, actual, replacement),
    });
    start = index + Math.max(normalizedOld.length, 1);
  }
  return matches;
}

function findStrippedTrailingWhitespaceMatches(content, oldString) {
  const strippedContent = stripTrailingWhitespace(content);
  const strippedOld = stripTrailingWhitespace(oldString);
  if (strippedContent === content && strippedOld === oldString) return [];
  if (!strippedOld) return [];

  const contentLines = content.split(/(?<=\r\n|\n|\r)/);
  const oldLines = oldString.split(/(?<=\r\n|\n|\r)/);
  const oldComparable = normalizeLineEndings(stripTrailingWhitespace(oldLines.join("")), "\n");
  const matches = [];

  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    const actual = contentLines.slice(i, i + oldLines.length).join("");
    const comparable = normalizeLineEndings(stripTrailingWhitespace(actual), "\n");
    if (comparable === oldComparable) {
      const start = contentLines.slice(0, i).join("").length;
      matches.push({ start, end: start + actual.length, actual, strategy: "trailing-whitespace-normalized" });
    }
  }

  return dedupeMatches(matches);
}

/** Models often paste read_file output which includes "123\\t" line prefixes. */
function stripReadFileLineNumbers(str) {
  if (!str) return str;
  const lines = str.split(/\r?\n/);
  let numbered = 0;
  const stripped = lines.map((line) => {
    // "12\\tcode" or "12|code" or "12: code"
    const m = line.match(/^\s*(\d+)[\t|:]\s?(.*)$/);
    if (m) {
      numbered += 1;
      return m[2];
    }
    return line;
  });
  // Only accept if most lines looked numbered — avoid stripping real code that starts with digits.
  if (numbered === 0 || numbered < Math.ceil(lines.length * 0.5)) return str;
  return stripped.join("\n");
}

function splitKeepingEol(str) {
  return str.split(/(?<=\r\n|\n|\r)/);
}

function lineBody(lineWithEol) {
  return lineWithEol.replace(/\r\n$|\n$|\r$/, "");
}

function findIndentFlexibleMatches(content, oldString) {
  const contentLines = splitKeepingEol(content);
  const oldLines = splitKeepingEol(oldString);
  if (oldLines.length === 0) return [];
  const oldBodies = oldLines.map((l) => lineBody(l).trimStart());
  // Require at least one non-empty line so we don't match empty noise.
  if (!oldBodies.some((b) => b.length > 0)) return [];

  const matches = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      const actualBody = lineBody(contentLines[i + j]).trimStart();
      if (actualBody !== oldBodies[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = contentLines.slice(0, i).join("").length;
    const actual = contentLines.slice(i, i + oldLines.length).join("");
    matches.push({
      start,
      end: start + actual.length,
      actual,
      strategy: "indent-flexible",
    });
  }
  return matches;
}

function collapseWs(str) {
  return normalizeUnicodeSpaces(str)
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .trimEnd();
}

/** NBSP / thin spaces / BOM-ish spaces → regular space (models often lose these). */
function normalizeUnicodeSpaces(str) {
  return String(str || "").replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ");
}

/** Em/en/box-drawing dashes → ASCII hyphen; collapse runs so ─── ≈ --- ≈ - */
function normalizeDashes(str) {
  return String(str || "")
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D\u2500\u2501\u30FC]/g, "-")
    .replace(/-{2,}/g, "-");
}

/**
 * Models often emit literal "\\n" / "\\t" sequences inside tool JSON when escapes
 * were double-encoded or the proxy left them unparsed.
 */
function expandLiteralEscapes(str) {
  if (typeof str !== "string" || !str) return str;
  if (!/\\[nrt"'\\]/.test(str)) return str;
  // Only expand when it looks like escaped source (has \\n or \\t runs), not lone backslashes in paths.
  if (!/\\n|\\r\\n|\\t/.test(str)) return str;
  return str
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

/**
 * Fuzzy line body: unicode spaces, dashes, curly quotes, collapse ws,
 * and normalize spaces around common punctuation so "a,b" ≈ "a, b".
 */
function fuzzyLineBody(lineWithEol) {
  let s = normalizeDashes(normalizeUnicodeSpaces(normalizeQuotes(lineBody(lineWithEol))));
  s = s.replace(/[ \t]+/g, " ").trim();
  // Strip spaces around punctuation / operators the model often drops or adds.
  s = s
    .replace(/\s*([,;:(){}\[\]])\s*/g, "$1")
    .replace(/\s*([=+\-*/%<>!&|^?:])\s*/g, "$1");
  // Normalize any quote style to double for comparison only.
  s = s.replace(/['’‘`]/g, '"');
  return s;
}

function findCollapsedWhitespaceMatches(content, oldString) {
  // Map each content index through a collapsed view that keeps only single spaces for runs of spaces/tabs.
  // For multi-line edits this is expensive if naive; use line-based collapse instead.
  const contentLines = splitKeepingEol(content);
  const oldLines = splitKeepingEol(oldString);
  if (oldLines.length === 0) return [];
  const oldCollapsed = oldLines.map((l) => collapseWs(lineBody(l)));
  if (!oldCollapsed.some((b) => b.length > 0)) return [];

  const matches = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (collapseWs(lineBody(contentLines[i + j])) !== oldCollapsed[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = contentLines.slice(0, i).join("").length;
    const actual = contentLines.slice(i, i + oldLines.length).join("");
    matches.push({
      start,
      end: start + actual.length,
      actual,
      strategy: "whitespace-collapsed",
    });
  }
  return matches;
}

/** Stronger fuzzy: punctuation spacing, dashes, NBSP, quote style ('' vs ""). */
function findFuzzyNormalizedMatches(content, oldString) {
  const contentLines = splitKeepingEol(content);
  const oldLines = splitKeepingEol(oldString);
  if (oldLines.length === 0) return [];
  const oldFuzzy = oldLines.map(fuzzyLineBody);
  if (!oldFuzzy.some((b) => b.length > 0)) return [];
  // Require enough signal so we don't match "a" everywhere.
  const signal = oldFuzzy.join("").replace(/\s+/g, "");
  if (signal.length < 8 && oldFuzzy.filter((b) => b.length > 0).length < 2) return [];

  const matches = [];
  for (let i = 0; i <= contentLines.length - oldLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (fuzzyLineBody(contentLines[i + j]) !== oldFuzzy[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = contentLines.slice(0, i).join("").length;
    const actual = contentLines.slice(i, i + oldLines.length).join("");
    matches.push({
      start,
      end: start + actual.length,
      actual,
      strategy: "fuzzy-normalized",
    });
  }
  return matches;
}

/** Ignore blank-line count differences (model often drops empty lines). */
function findBlankLineFlexibleMatches(content, oldString) {
  const contentLines = splitKeepingEol(content);
  const oldLines = splitKeepingEol(oldString);
  const oldNonEmpty = oldLines.map(lineBody).map((l) => collapseWs(l)).filter((l) => l.length > 0);
  if (oldNonEmpty.length === 0) return [];
  if (oldNonEmpty.length < 2 && oldNonEmpty.join("").length < 12) return [];

  const matches = [];
  for (let i = 0; i < contentLines.length; i += 1) {
    // A blank start line can never carry matching signal. Starting from every
    // blank before the same block produced several ranges for one logical
    // match, which was then incorrectly reported as "old_string is not unique".
    const firstBody = collapseWs(lineBody(contentLines[i]));
    if (firstBody.length === 0 || firstBody !== oldNonEmpty[0]) continue;

    let ci = i;
    let oi = 0;
    const startLine = i;
    while (oi < oldNonEmpty.length && ci < contentLines.length) {
      const body = collapseWs(lineBody(contentLines[ci]));
      if (body.length === 0) {
        ci += 1;
        continue;
      }
      if (body !== oldNonEmpty[oi]) break;
      oi += 1;
      ci += 1;
    }
    if (oi !== oldNonEmpty.length) continue;
    // Include trailing blank lines that sit between last matched and next content? keep exact span of matched lines.
    const actual = contentLines.slice(startLine, ci).join("");
    const start = contentLines.slice(0, startLine).join("").length;
    matches.push({
      start,
      end: start + actual.length,
      actual,
      strategy: "blank-line-flexible",
    });
  }
  return matches;
}

/**
 * Model truncated old_string with "…" / "..." (often from error previews or context limits).
 * If the non-ellipsis prefix uniquely occurs, match that span only.
 */
function findEllipsisPrefixMatches(content, oldString) {
  const raw = String(oldString || "");
  const m = raw.match(/^(.*?)(?:\u2026|\.\.\.)\s*$/s);
  if (!m) return [];
  let prefix = m[1];
  // Drop a dangling partial token after last whitespace/newline so "if (!" can match.
  // Keep prefix as-is first; only accept if unique.
  prefix = stripReadFileLineNumbers(repairWindowsPathControlChars(prefix));
  if (!prefix || prefix.length < 16) return [];
  const fileEol = detectLineEnding(content);
  const candidates = [prefix, normalizeLineEndings(prefix, fileEol)];
  const matches = [];
  for (const p of candidates) {
    if (!p) continue;
    let start = 0;
    while (true) {
      const index = content.indexOf(p, start);
      if (index === -1) break;
      matches.push({
        start: index,
        end: index + p.length,
        actual: content.slice(index, index + p.length),
        strategy: "ellipsis-prefix",
      });
      start = index + Math.max(p.length, 1);
    }
    if (matches.length) break;
  }
  // Also try fuzzy line-aligned prefix without trailing partial line
  if (matches.length === 0) {
    const lines = prefix.split(/\r?\n/);
    if (lines.length >= 2) {
      // drop last (likely truncated) line
      const shorter = lines.slice(0, -1).join("\n");
      if (shorter.length >= 16) {
        return findEllipsisPrefixMatches(content, shorter + "…");
      }
    }
  }
  return matches;
}

function findEditMatches(content, oldString, newString) {
  const strategies = [];
  const fileEol = detectLineEnding(content);

  // Pre-clean: if model pasted numbered read_file output into old_string, strip it once.
  const cleanedOld = stripReadFileLineNumbers(oldString);
  // Also repair path control-char corruption from under-escaped tool JSON (\tools→TAB).
  const pathRepaired = repairWindowsPathControlChars(cleanedOld);
  const expandedEscapes = expandLiteralEscapes(pathRepaired);
  const candidates = [];
  for (const c of [oldString, cleanedOld, pathRepaired, expandedEscapes]) {
    if (typeof c === "string" && c && !candidates.includes(c)) candidates.push(c);
  }

  for (const candidate of candidates) {
    const eolNormalizedOld = normalizeLineEndings(candidate, fileEol);

    // Claude Code-compatible deletion convenience: if deleting a block and the
    // model omitted the final newline, prefer consuming it so empty lines are not left behind.
    if (newString === "" && !candidate.endsWith("\n") && !candidate.endsWith("\r") && content.includes(candidate + fileEol)) {
      strategies.push(findAllLiteral(content, candidate + fileEol, "delete-trailing-newline"));
    }

    strategies.push(findAllLiteral(content, candidate, "exact"));

    if (eolNormalizedOld !== candidate) {
      strategies.push(findAllLiteral(content, eolNormalizedOld, "line-ending-normalized"));
    }

    strategies.push(findNormalizedQuoteMatches(content, candidate));
    strategies.push(findStrippedTrailingWhitespaceMatches(content, candidate));
    strategies.push(findIndentFlexibleMatches(content, eolNormalizedOld));
    strategies.push(findCollapsedWhitespaceMatches(content, eolNormalizedOld));
    strategies.push(findFuzzyNormalizedMatches(content, eolNormalizedOld));
    strategies.push(findBlankLineFlexibleMatches(content, eolNormalizedOld));
    strategies.push(findEllipsisPrefixMatches(content, candidate));
  }

  for (const matches of strategies) {
    const unique = dedupeMatches(matches);
    if (unique.length > 0) return unique;
  }
  return [];
}

function applyMatches(content, matches, newString, replaceAll) {
  const selected = replaceAll ? matches : [matches[0]];
  let result = "";
  let cursor = 0;
  const fileEol = detectLineEnding(content);
  // Keep file EOL style: models usually emit \n even for CRLF files.
  const normalizedNew = normalizeLineEndings(repairWindowsPathControlChars(newString), fileEol);

  for (const match of selected.sort((a, b) => a.start - b.start)) {
    if (match.start < cursor) continue;
    const replacement = match.replacementMapper
      ? match.replacementMapper(normalizedNew, match.actual)
      : normalizedNew;
    result += content.slice(cursor, match.start) + replacement;
    cursor = match.end;
  }

  return result + content.slice(cursor);
}

function buildNotFoundError(content, oldString) {
  const fileEol = detectLineEnding(content);
  const cleaned = stripReadFileLineNumbers(oldString);
  const expanded = expandLiteralEscapes(cleaned);
  const hints = [];
  if (cleaned !== oldString) hints.push("stripped read_file line numbers from old_string");
  if (expanded !== cleaned) hints.push("literal \\\\n/\\\\t escapes in old_string");
  if (normalizeLineEndings(oldString, fileEol) !== oldString) hints.push("line endings differ");
  if (stripTrailingWhitespace(content).includes(stripTrailingWhitespace(cleaned))) {
    hints.push("trailing whitespace differs");
  }
  if (normalizeQuotes(content).includes(normalizeQuotes(cleaned))) hints.push("quote style differs");
  const fuzzyOld = fuzzyLineBody(cleaned);
  if (fuzzyOld && splitKeepingEol(content).some((l) => fuzzyLineBody(l) === fuzzyOld)) {
    hints.push("partial fuzzy line match exists — enlarge old_string with more unique context");
  }
  // Show a short preview so the model can see what it tried to match.
  const preview = String(cleaned || oldString).replace(/\s+/g, " ").slice(0, 120);
  const suffix = hints.length ? ` Tried tolerant matching (${hints.join(", ")}).` : "";
  return new Error(
    `old_string not found in file.${suffix} ` +
      `Preview of old_string: "${preview}${String(cleaned || oldString).length > 120 ? "…" : ""}". ` +
      `Recovery: read_file this path again, copy a unique exact snippet from the result as old_string, then retry edit_file. ` +
      `Prefer a smaller unique hunk (3–12 lines) over a huge block. ` +
      `Do not create _tmp scripts or rewrite the file via create_file/bash to bypass this.`,
  );
}

module.exports = {
  name: "edit_file",
  description:
    "Replace text inside a file. Uses exact matching first, then safe Claude Code-style fallbacks for line endings, quote style, trailing whitespace, indent, collapsed whitespace, punctuation/spacing fuzzy match, unicode dashes/NBSP, blank-line flexibility, ellipsis-truncated prefixes, literal \\\\n escapes, read_file line-number prefixes, Windows path control-char repair (\\t/\\b from under-escaped JSON), and deletion newlines. " +
    "old_string must match uniquely unless replace_all is set. Copy old_string from the real file content — do NOT include read_file line number prefixes (e.g. '12\\t'). " +
    "If this fails (not found / not unique): read_file the same path again, take a fresh unique snippet (prefer 3–12 lines), and retry edit_file. " +
    "Before each successful write, a full snapshot of the previous file is stored under the project .backup/ folder. " +
    "To undo: restore_backup action=list|diff|restore (full-file rollback) — do not re-edit to reverse a bad change. " +
    "Do not bypass with _tmp_*.mjs scripts, create_file rewrites, or bash/node patch scripts.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to edit" },
      old_string: { type: "string", description: "Text to replace (exact preferred; tolerant fallbacks for whitespace/quotes/line endings/indent/line-number prefixes)" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, context = {}) {
    const filePath = input.path;
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("edit_file requires a 'path' string");
    }

    // Defensive alias normalization (also done in registry, but keep tool self-contained).
    let oldString =
      input.old_string ?? input.oldString ?? input.old ?? input.old_text ?? input.oldText ?? input.before ?? input.search;
    let newString =
      input.new_string ?? input.newString ?? input.new ?? input.new_text ?? input.newText ?? input.after ?? input.replace ?? input.replacement;
    const replaceAll = Boolean(input.replace_all ?? input.replaceAll);

    if (typeof oldString !== "string" || typeof newString !== "string") {
      throw new Error("edit_file requires string old_string and new_string");
    }

    // Repair \tools/\bin path corruption from under-escaped tool-call JSON (TAB/BS).
    oldString = repairWindowsPathControlChars(oldString);
    newString = repairWindowsPathControlChars(newString);

    let content;
    try {
      content = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(`File not found: ${filePath}. Use create_file for new files, or check the path.`);
      }
      throw error;
    }

    if (oldString === newString) {
      throw new Error("old_string and new_string are identical");
    }
    if (oldString === "") {
      throw new Error("old_string cannot be empty for edit_file; use create_file or a full-file replacement instead");
    }

    const matches = findEditMatches(content, oldString, newString);
    if (matches.length === 0) {
      throw buildNotFoundError(content, oldString);
    }
    if (matches.length > 1 && !replaceAll) {
      const strategies = [...new Set(matches.map((match) => match.strategy))].join(", ");
      throw new Error(
        `old_string is not unique (${matches.length} matches via ${strategies}). Provide more context or set replace_all.`
      );
    }

    const nextContent = applyMatches(content, matches, newString, replaceAll);
    if (nextContent === content) {
      throw new Error("Replacement produced no file changes");
    }

    // Per-project .backup snapshot of the pre-edit content (agent can restore_backup later).
    let backup = null;
    try {
      const projectRoot = fileBackup.resolveProjectRoot(filePath, context.rootPath);
      if (projectRoot) {
        backup = await fileBackup.backupFileBeforeWrite(projectRoot, filePath, { reason: "edit_file" });
      }
    } catch (err) {
      console.warn("fileBackup before edit_file failed:", err?.message || err);
    }

    await fs.promises.writeFile(filePath, nextContent, "utf8");

    return {
      path: filePath,
      replacements: replaceAll ? matches.length : 1,
      matchStrategy: matches[0].strategy,
      backup: backup
        ? { id: backup.id, path: backup.path, createdAt: backup.createdAt }
        : null,
    };
  },
};
