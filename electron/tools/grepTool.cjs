const fs = require("fs");
const path = require("path");

const LIMIT = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORE_DIRS = new Set([
  "node_modules", "dist", "build", "out", "coverage", "__pycache__", "venv", ".venv",
  "vendor", "third_party", ".git", ".svn", ".hg", ".lopster", ".backup",
]);
const IGNORE_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svg|woff2?|ttf|eot|otf|mp3|mp4|wav|avi|mov|zip|gz|7z|rar|exe|dll|so|dylib|bin|pdf|class|o|obj|pdb|sqlite|db)$/i;

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/");
}

function globToRegExp(pattern) {
  const raw = String(pattern || "*").replace(/\\/g, "/");
  let source = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "*") {
      if (raw[i + 1] === "*") { source += ".*"; i += 1; } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else if (".+^${}()|[]\\".includes(ch)) source += `\\${ch}`;
    else source += ch;
  }
  return new RegExp(`^${source}$`, "i");
}

function isBinary(buffer, filePath) {
  if (BINARY_EXT.test(filePath)) return true;
  for (const byte of buffer.subarray(0, Math.min(buffer.length, 8000))) if (byte === 0) return true;
  return false;
}

function walk(root, includeRe) {
  const files = [];
  const stack = [""];
  while (stack.length && files.length < 25000) {
    const relativeDir = stack.pop();
    const absoluteDir = relativeDir ? path.join(root, relativeDir) : root;
    let entries;
    try { entries = fs.readdirSync(absoluteDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const relative = normalizeRel(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(relative);
        continue;
      }
      if (
        !entry.isFile() ||
        IGNORE_FILES.has(entry.name) ||
        (includeRe && !includeRe.test(relative) && !includeRe.test(entry.name))
      ) continue;
      files.push(relative);
    }
  }
  return files;
}

function searchFile(root, relative, pattern) {
  const absolute = path.join(root, relative);
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
    const buffer = fs.readFileSync(absolute);
    if (isBinary(buffer, absolute)) return [];
    const lines = buffer.toString("utf8").split(/\r?\n/);
    const matches = [];
    for (let index = 0; index < lines.length && matches.length < LIMIT; index += 1) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[index])) matches.push({ path: absolute, line: index + 1, text: lines[index] });
    }
    return matches;
  } catch { return []; }
}

module.exports = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Uses pattern, optional path, and optional include file pattern. " +
    "Returns matching absolute file paths, line numbers, and text. Searches up to 100 results and skips generated, hidden, lock, and binary files.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for in file contents" },
      path: { type: "string", description: "Directory or file to search. Defaults to the open project directory." },
      include: { type: "string", description: 'File pattern to include, for example "*.js" or "*.{ts,tsx}"' },
    },
    required: ["pattern"],
  },
  async execute(input) {
    if (!input?.pattern) throw new Error("pattern is required");
    const requested = String(input.path || process.cwd());
    if (!fs.existsSync(requested)) throw new Error(`Path does not exist: ${requested}`);
    const stat = fs.statSync(requested);
    const root = stat.isDirectory() ? requested : path.dirname(requested);
    const includeRe = input.include ? globToRegExp(input.include) : null;
    let pattern;
    try { pattern = new RegExp(String(input.pattern)); }
    catch { pattern = new RegExp(String(input.pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); }
    const files = stat.isDirectory()
      ? walk(root, includeRe)
      : [path.basename(requested)].filter((file) => !includeRe || includeRe.test(file));
    const matches = [];
    for (const file of files) {
      matches.push(...searchFile(root, file, pattern));
      if (matches.length >= LIMIT) break;
    }
    const rows = matches.slice(0, LIMIT);
    const truncated = matches.length >= LIMIT;
    if (!rows.length) {
      return {
        title: input.pattern,
        matchCount: 0,
        totalFound: 0,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
        __toolText: "No files found",
      };
    }
    const output = [`Found ${rows.length} matches${truncated ? " (more matches available)" : ""}`];
    let current = "";
    for (const match of rows) {
      if (current !== match.path) { if (current) output.push(""); current = match.path; output.push(`${match.path}:`); }
      output.push(`  Line ${match.line}: ${match.text}`);
    }
    if (truncated) output.push("", "(Results truncated. Consider using a more specific path or pattern.)");
    const text = output.join("\n");
    return {
      title: input.pattern,
      matchCount: rows.length,
      totalFound: rows.length,
      metadata: { matches: rows.length, truncated },
      output: text,
      __toolText: text,
    };
  },
};
