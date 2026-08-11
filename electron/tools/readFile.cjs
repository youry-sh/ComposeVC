const fs = require("fs");

const MAX_BYTES = 512 * 1024;
/** Hard max lines per read_file call — keeps context tokens under control. */
const MAX_LINES = 400;
/** Soft default when agent omits limit (same as hard max). */
const DEFAULT_LINES = 400;

module.exports = {
  name: "read_file",
  description:
    "Read a file from disk. Returns content with 1-indexed line numbers. " +
    `HARD CAP: at most ${MAX_LINES} lines per call (default ${DEFAULT_LINES} if limit omitted). ` +
    "For larger files: pass offset (1-indexed start) + limit (<=400), then call again with " +
    "offset=nextOffset to continue. Prefer targeted slices over full-file dumps.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file to read" },
      offset: {
        type: "number",
        description: "1-indexed line number to start reading from (optional; default 1)",
      },
      limit: {
        type: "number",
        description: `Number of lines to read (optional; default ${DEFAULT_LINES}, hard max ${MAX_LINES})`,
      },
    },
    required: ["path"],
  },
  async execute(input) {
    const filePath = input.path;
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("read_file requires a 'path' string. Use the exact absolute or project-relative file path.");
    }
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }
    if (stat.size > MAX_BYTES) {
      throw new Error(`File too large to read (${stat.size} bytes, limit ${MAX_BYTES})`);
    }

    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;

    const offset = input.offset && input.offset > 0 ? Math.floor(input.offset) : 1;
    let limit =
      input.limit && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LINES;
    if (limit > MAX_LINES) limit = MAX_LINES;

    if (offset > totalLines) {
      return {
        path: filePath,
        totalLines,
        offset,
        limit,
        returnedLines: 0,
        truncated: false,
        content: "",
        note: `offset ${offset} is past end of file (${totalLines} lines).`,
      };
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const returnedLines = slice.length;
    const endLine = offset + returnedLines - 1;
    const truncated = endLine < totalLines;
    const nextOffset = truncated ? endLine + 1 : null;

    const numbered = slice
      .map((line, index) => `${offset + index}\t${line}`)
      .join("\n");

    const result = {
      path: filePath,
      totalLines,
      offset,
      limit,
      returnedLines,
      truncated,
      content: numbered,
    };
    if (nextOffset != null) {
      result.nextOffset = nextOffset;
      result.note =
        `Showing lines ${offset}–${endLine} of ${totalLines}. ` +
        `Call again with offset=${nextOffset} limit=${MAX_LINES} to continue.`;
    }
    return result;
  },
};
