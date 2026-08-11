const path = require("path");
const fileBackup = require("../fileBackup.cjs");

module.exports = {
  name: "restore_backup",
  description:
    "Project file rollback / diff store (<project>/.backup). " +
    "Every edit_file and create_file auto-saves a full pre-write snapshot. " +
    "Use this tool to list rollbacks, show unified line diffs, restore a file to a past snapshot " +
    "(atomic full-file write — no partial line rewrite / no delete-then-recreate dance), " +
    "or clean old snapshots so .backup does not bloat. " +
    "Actions: list | diff | restore | status | cleanup. " +
    "Each open project has its own .backup — never shared across projects. " +
    "Prefer restore over re-editing when undoing a bad agent change.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "list | diff | restore | status | cleanup " +
          "(default: restore when id/path given, else list)",
      },
      path: {
        type: "string",
        description: "Absolute or project-relative file path (list filter / diff / restore target)",
      },
      id: {
        type: "string",
        description: "Backup version id from list (preferred for diff/restore; prefix match OK)",
      },
      limit: {
        type: "number",
        description: "Max entries for list (default 40, max 100)",
      },
      with_stats: {
        type: "boolean",
        description: "list: include +N/-M vs current file (slower; default false)",
      },
      context: {
        type: "number",
        description: "diff: unified context lines around changes (default 3, max 12)",
      },
      keep_per_file: {
        type: "number",
        description: "cleanup: max versions to keep per path (default 20)",
      },
      max_total: {
        type: "number",
        description: "cleanup: max total versions across project (default 800)",
      },
      max_age_days: {
        type: "number",
        description: "cleanup: drop snapshots older than N days (default 7; 0 = ignore age)",
      },
      clear_all: {
        type: "boolean",
        description: "cleanup: wipe entire .backup folder",
      },
      dry_run: {
        type: "boolean",
        description: "cleanup: report what would be removed without deleting",
      },
    },
    required: [],
  },
  async execute(input, context = {}) {
    const projectRoot = context.rootPath || null;
    if (!projectRoot) {
      throw new Error(
        "restore_backup needs an open project folder (rootPath). Open a project first."
      );
    }

    const actionRaw = String(input.action || "").trim().toLowerCase();
    const filePath =
      input.path || input.file || input.filePath || input.file_path || null;
    const id = input.id || input.backup_id || input.backupId || null;
    let action = actionRaw;
    if (!action) {
      action = id || filePath ? "restore" : "list";
    }

    if (
      action === "list" ||
      action === "ls" ||
      action === "show" ||
      action === "history" ||
      action === "log"
    ) {
      const limit = Math.min(
        100,
        Math.max(1, Number(input.limit) || fileBackup.DEFAULT_LIST_LIMIT || 40)
      );
      const withStats = Boolean(
        input.with_stats ?? input.withStats ?? input.stats ?? false
      );
      const all = await fileBackup.listBackups(projectRoot, filePath || null, {
        withStats,
      });
      const items = all.slice(0, limit);
      const byFile = new Map();
      for (const b of all) {
        byFile.set(b.path, (byFile.get(b.path) || 0) + 1);
      }
      return {
        ok: true,
        action: "list",
        projectRoot,
        backupDir: path.join(projectRoot, fileBackup.BACKUP_DIR),
        count: items.length,
        total: all.length,
        uniqueFiles: byFile.size,
        withStats,
        backups: items,
        tip:
          items.length === 0
            ? "No rollbacks yet. They appear automatically when edit_file / create_file mutates a file."
            : "Next: action=diff id=<id> to see line changes, or action=restore id=<id> for full-file rollback. " +
              "action=cleanup when .backup grows large.",
      };
    }

    if (
      action === "diff" ||
      action === "compare" ||
      action === "show_diff" ||
      action === "udiff"
    ) {
      if (!id && !filePath) {
        throw new Error(
          "diff requires id= (from list) or path= (latest for that file)"
        );
      }
      const contextLines =
        input.context ?? input.context_lines ?? input.contextLines;
      return await fileBackup.diffBackup(projectRoot, {
        id: id || null,
        path: filePath || null,
        context: contextLines,
      });
    }

    if (
      action === "restore" ||
      action === "undo" ||
      action === "revert" ||
      action === "rollback" ||
      action === "roll_back"
    ) {
      const result = await fileBackup.restoreBackup(projectRoot, {
        id: id || null,
        path: filePath || null,
      });
      return {
        ok: true,
        action: "restore",
        ...result,
      };
    }

    if (action === "status" || action === "info" || action === "stats") {
      return await fileBackup.getBackupStatus(projectRoot);
    }

    if (
      action === "cleanup" ||
      action === "prune" ||
      action === "gc" ||
      action === "clean" ||
      action === "purge"
    ) {
      return await fileBackup.cleanupBackups(projectRoot, {
        keepPerFile: input.keep_per_file ?? input.keepPerFile,
        maxTotal: input.max_total ?? input.maxTotal,
        maxAgeDays: input.max_age_days ?? input.maxAgeDays,
        maxAgeMs: input.max_age_ms ?? input.maxAgeMs,
        clearAll: input.clear_all ?? input.clearAll ?? input.wipe,
        dryRun: input.dry_run ?? input.dryRun,
      });
    }

    throw new Error(
      `Unknown restore_backup action "${action}". ` +
        `Use action=list | diff | restore | status | cleanup.`
    );
  },
};
