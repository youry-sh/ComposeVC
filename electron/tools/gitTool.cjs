const path = require("path");
const gitService = require("../gitService.cjs");

/**
 * Structured git for the agent.
 *
 * Actions map to a fixed argv, so the model cannot smuggle a second command
 * through a branch name or a path. `raw` exists for the long tail, but it is
 * still argv (never a shell string) and goes through the same destructive
 * filter as everything else.
 */

const ACTIONS = {
  status: () => ["status", "--short", "--branch"],
  log: (input) => [
    "log",
    `-${clampCount(input.count, 10, 50)}`,
    "--format=%h %ad %an: %s",
    "--date=short",
    ...(input.path ? ["--", input.path] : []),
  ],
  diff: (input) => [
    "diff",
    ...(input.staged ? ["--staged"] : []),
    ...(input.stat ? ["--stat"] : []),
    ...(input.path ? ["--", input.path] : []),
  ],
  show: (input) => ["show", "--stat", input.ref || "HEAD"],
  branch_list: () => ["branch", "-vv", "--all"],
  current_branch: () => ["rev-parse", "--abbrev-ref", "HEAD"],
  remote_list: () => ["remote", "-v"],
  add: (input) => ["add", "--", ...filePaths(input)],
  commit: (input) => ["commit", "-m", requireText(input.message, "message")],
  checkout: (input) => ["checkout", requireText(input.branch, "branch")],
  create_branch: (input) => ["checkout", "-b", requireText(input.branch, "branch")],
  stash: (input) => ["stash", "push", ...(input.message ? ["-m", input.message] : [])],
  stash_pop: () => ["stash", "pop"],
  stash_list: () => ["stash", "list"],
  fetch: (input) => ["fetch", input.remote || "origin", ...(input.branch ? [input.branch] : [])],
  pull: (input) => ["pull", input.remote || "origin", ...(input.branch ? [input.branch] : [])],
  push: (input) => [
    "push",
    ...(input.setUpstream ? ["--set-upstream"] : []),
    input.remote || "origin",
    ...(input.branch ? [input.branch] : []),
  ],
  raw: (input) => {
    if (!Array.isArray(input.args) || input.args.length === 0) {
      throw new Error("raw requires args: an array like [\"log\", \"--oneline\"]");
    }
    return input.args.map(String);
  },
};

function clampCount(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.floor(n));
}

function requireText(value, field) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${field} is required for this action`);
  return text;
}

function filePaths(input) {
  const list = Array.isArray(input.paths) ? input.paths : input.path ? [input.path] : [];
  const cleaned = list.map((p) => String(p).trim()).filter(Boolean);
  if (!cleaned.length) throw new Error("paths is required for add (use [\".\"] for everything)");
  return cleaned;
}

module.exports = {
  name: "git",
  description:
    "Run git in a project folder: status, log, diff, show, branch_list, current_branch, remote_list, " +
    "add, commit, checkout, create_branch, stash, stash_pop, stash_list, fetch, pull, push, or raw argv. " +
    "History-destroying operations (force push, reset --hard, clean, branch -D, filter-branch, gc/prune) " +
    "are refused — ask the user and use the terminal if one is genuinely needed.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: Object.keys(ACTIONS),
        description: "Which git operation to run",
      },
      cwd: {
        type: "string",
        description: "Repository folder. Defaults to the chat's project root.",
      },
      message: { type: "string", description: "Commit message (commit) or stash message" },
      branch: { type: "string", description: "Branch name (checkout, create_branch, fetch, pull, push)" },
      remote: { type: "string", description: "Remote name, default origin" },
      path: { type: "string", description: "Limit to one path (log, diff) or stage one file (add)" },
      paths: { type: "array", items: { type: "string" }, description: "Files to stage (add)" },
      ref: { type: "string", description: "Commit-ish for show, default HEAD" },
      count: { type: "number", description: "How many commits for log (default 10, max 50)" },
      staged: { type: "boolean", description: "diff: show the staged changes instead of the worktree" },
      stat: { type: "boolean", description: "diff: summary instead of full patch" },
      setUpstream: { type: "boolean", description: "push: also set the upstream branch" },
      args: { type: "array", items: { type: "string" }, description: "raw: full argv after `git`" },
    },
    required: ["action"],
  },

  async execute(input = {}, context = {}) {
    const action = String(input.action || "").trim();
    const build = ACTIONS[action];
    if (!build) {
      return { ok: false, error: `Unknown action "${action}". Known: ${Object.keys(ACTIONS).join(", ")}` };
    }

    // Validate the call itself before the environment: "message is required"
    // is far more actionable to the caller than "no project folder".
    let args;
    try {
      args = build(input);
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }

    // A refusal must not depend on whether a folder happens to be open.
    const destructive = gitService.findDestructive(args);
    if (destructive) {
      return {
        ok: false,
        error:
          `Refused: "${destructive}" can destroy uncommitted or unpushed work. ` +
          "Tell the user what you want to do and let them run it in the terminal.",
      };
    }

    const cwd = String(input.cwd || context.rootPath || "").trim();
    if (!cwd) return { ok: false, error: "No project folder — pass cwd or open a folder for this chat." };

    if (!(await gitService.isRepo(cwd))) {
      return { ok: false, error: `Not a git repository (or git is not installed): ${cwd}` };
    }

    const res = await gitService.execGit(args, cwd);
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return {
      ok: res.ok,
      action,
      command: `git ${args.join(" ")}`,
      cwd: path.resolve(cwd),
      output: output || (res.ok ? "(no output)" : "(no output)"),
      ...(res.ok ? {} : { error: res.error || `git exited with code ${res.code}` }),
    };
  },
};
