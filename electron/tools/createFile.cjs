const fs = require("fs");
const path = require("path");
const fileBackup = require("../fileBackup.cjs");

module.exports = {
  name: "create_file",
  description:
      "Create a NEW file only. Does NOT overwrite or replace existing files (EEXIST if path exists). " +
      "Creates parent directories as needed. " +
      "After create, a snapshot is stored under the project .backup folder so restore_backup can recover it if deleted. " +
      "To change an existing file you MUST use edit_file (read_file first, then old_string → new_string). " +
      "Never call create_file on a path that already exists.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to create" },
      content: { type: "string", description: "Initial file content" },
    },
    required: ["path"],
  },
  async execute(input, context = {}) {
    const filePath = input.path;
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new Error("create_file requires a 'path' string.");
    }

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

    try {
      await fs.promises.writeFile(filePath, input.content ?? "", { flag: "wx" });
    } catch (error) {
      if (error && (error.code === "EEXIST" || error.code === "EISDIR")) {
        throw new Error(
          `EEXIST: file already exists, open '${filePath}'. ` +
            `create_file only creates NEW files. To change an existing file use edit_file ` +
            `(read_file first, then edit_file with a unique old_string → new_string). ` +
            `Do not retry create_file on this path.`
        );
      }
      throw error;
    }

    // Snapshot the just-created content so restore_backup can revive it if deleted later.
    let backup = null;
    try {
      const projectRoot = fileBackup.resolveProjectRoot(filePath, context.rootPath);
      if (projectRoot) {
        backup = await fileBackup.backupFileBeforeWrite(projectRoot, filePath, {
          reason: "create_file",
        });
      }
    } catch (err) {
      console.warn("fileBackup after create_file failed:", err?.message || err);
    }

    return {
      path: filePath,
      bytesWritten: Buffer.byteLength(input.content ?? "", "utf8"),
      created: true,
      backup: backup
        ? { id: backup.id, path: backup.path, createdAt: backup.createdAt }
        : null,
    };
  },
};
