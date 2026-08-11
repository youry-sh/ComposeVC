const fs = require("fs");
const path = require("path");

const ignoredNames = new Set(["node_modules", ".git", "dist", "build", ".next", ".vite", "coverage"]);

module.exports = {
  name: "list_dir",
  description: "List files and folders inside a directory (non-recursive).",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the directory to list" },
    },
    required: ["path"],
  },
  async execute(input) {
    const dirPath = input.path;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    const items = entries
      .filter((entry) => !ignoredNames.has(entry.name) && !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "folder" : "file",
        path: path.join(dirPath, entry.name),
      }));

    return { path: dirPath, entries: items };
  },
};
