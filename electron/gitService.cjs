/**
 * Git plumbing shared by the UI (IPC handlers) and the agent's `git` tool.
 *
 * Everything goes through execFile with an argv array — never a shell string —
 * so a branch or path with spaces, quotes or `;` can never turn into another
 * command. Every call is scoped to an explicit cwd.
 */

const { execFile } = require("child_process");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;
/** ASCII unit separator — cannot appear in a commit subject or author name. */
const SEP = "\u001f";
const LOG_FORMAT = `--format=%h%x1f%s%x1f%an%x1f%ar`;

/**
 * Operations that can silently destroy work the user has not pushed anywhere.
 * Blocked in the tool regardless of the requested action; the bash tool stays
 * available for the rare case where the user really wants one of these.
 */
const DESTRUCTIVE_PATTERNS = [
  /^--force$/i,
  /^-f$/,
  /^--force-with-lease.*/i,
  /^--hard$/i,
  /^--delete$/i,
  /^-D$/,
  /^-fd$/,
  /^-fdx$/,
  /^--prune$/i,
];
const DESTRUCTIVE_SUBCOMMANDS = new Set(["clean", "filter-branch", "reflog", "gc", "prune"]);

function execGit(args, cwd, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim(),
          error: error ? String(error.message || error) : null,
        });
      }
    );
  });
}

/** `git status --porcelain=v2 --branch` in one shot: branch, ahead/behind, counts. */
function parsePorcelainV2(stdout) {
  const out = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicted: 0,
  };
  for (const line of String(stdout || "").split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice(14).trim();
      out.detached = head === "(detached)";
      out.branch = out.detached ? null : head;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      out.upstream = line.slice(18).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.slice(12).trim().match(/^\+(\d+)\s+-(\d+)$/);
      if (match) {
        out.ahead = Number(match[1]) || 0;
        out.behind = Number(match[2]) || 0;
      }
      continue;
    }
    if (line.startsWith("# ")) continue;
    if (line.startsWith("? ")) {
      out.untracked += 1;
      continue;
    }
    if (line.startsWith("u ")) {
      out.conflicted += 1;
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // "1 XY ..." — X is the staged state, Y the worktree state.
      const xy = line.slice(2, 4);
      if (xy[0] && xy[0] !== ".") out.staged += 1;
      if (xy[1] && xy[1] !== ".") out.modified += 1;
    }
  }
  return out;
}

/** Human name for a remote URL: git@host:acme/app.git → acme/app */
function repoNameFromRemote(remoteUrl) {
  const url = String(remoteUrl || "").trim();
  if (!url) return null;
  const cleaned = url.replace(/\.git$/i, "");
  const sshMatch = cleaned.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  if (sshMatch) return sshMatch[1].replace(/^\/+/, "");
  // Require a real scheme: `new URL("C:\\repos\\app")` happily parses "c:" as
  // one and would hand back "\repos\app" for a plain Windows path.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(cleaned)) {
    try {
      const parsed = new URL(cleaned);
      return parsed.pathname.replace(/^\/+/, "") || parsed.host;
    } catch {
      /* fall through to the path split */
    }
  }
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}

async function isRepo(cwd) {
  if (!cwd) return false;
  const res = await execGit(["rev-parse", "--is-inside-work-tree"], cwd, { timeout: 5000 });
  return res.ok && res.stdout === "true";
}

/** Full snapshot for the rail badge and the popover header. */
async function getStatus(cwd) {
  if (!cwd) return { isRepo: false, reason: "no-folder" };
  const inside = await execGit(["rev-parse", "--is-inside-work-tree"], cwd, { timeout: 5000 });
  if (!inside.ok || inside.stdout !== "true") {
    const missing = /ENOENT|not recognized|command not found/i.test(inside.error || "");
    return { isRepo: false, reason: missing ? "git-missing" : "not-a-repo" };
  }

  const [statusRes, rootRes, remoteRes, logRes] = await Promise.all([
    execGit(["status", "--porcelain=v2", "--branch"], cwd),
    execGit(["rev-parse", "--show-toplevel"], cwd, { timeout: 5000 }),
    execGit(["remote", "get-url", "origin"], cwd, { timeout: 5000 }),
    execGit(["log", "-1", LOG_FORMAT], cwd, { timeout: 5000 }),
  ]);

  const parsed = parsePorcelainV2(statusRes.stdout);
  const root = rootRes.ok ? rootRes.stdout : cwd;
  const remoteUrl = remoteRes.ok ? remoteRes.stdout : null;
  let lastCommit = null;
  if (logRes.ok && logRes.stdout) {
    const [hash, subject, author, when] = logRes.stdout.split(SEP);
    lastCommit = { hash, subject, author, when };
  }

  return {
    isRepo: true,
    root,
    folderName: path.basename(root),
    repoName: repoNameFromRemote(remoteUrl) || path.basename(root),
    remoteUrl,
    ...parsed,
    dirty: parsed.staged + parsed.modified + parsed.untracked + parsed.conflicted > 0,
    lastCommit,
  };
}

async function listBranches(cwd) {
  const res = await execGit(
    ["for-each-ref", "--sort=-committerdate", "--count=60", "--format=%(HEAD)%(refname:short)", "refs/heads"],
    cwd
  );
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ name: line.slice(1).trim(), current: line[0] === "*" }))
    .filter((branch) => branch.name);
}

/** Changed files with their porcelain XY code, for the popover list. */
async function listChangedFiles(cwd, limit = 200) {
  const res = await execGit(["status", "--porcelain"], cwd);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => ({
      code: line.slice(0, 2).trim() || "?",
      staged: line[0] !== " " && line[0] !== "?",
      path: line.slice(3).trim(),
    }));
}

async function recentCommits(cwd, limit = 8) {
  const res = await execGit(["log", `-${Math.max(1, Math.min(50, limit))}`, LOG_FORMAT], cwd);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, when] = line.split(SEP);
      return { hash, subject, author, when };
    });
}

/**
 * `git log --graph` across every branch — the ASCII graph is exactly what the
 * shell's right column renders, so no client-side layout of the DAG is needed.
 */
async function graphLog(cwd, limit = 40) {
  const count = Math.max(1, Math.min(200, Number(limit) || 40));
  const res = await execGit(
    ["log", "--graph", "--decorate=short", "--all", `-${count}`, "--date=short", "--format=%h%x09%ad%x09%an%x09%s"],
    cwd,
    { timeout: 20000 }
  );
  if (!res.ok) return [];
  return res.stdout.split("\n").filter((line) => line.length > 0);
}

/** Total commits reachable from HEAD — the "history is bigger than this" number. */
async function commitCount(cwd) {
  const res = await execGit(["rev-list", "--count", "HEAD"], cwd, { timeout: 8000 });
  return res.ok ? Number(res.stdout) || 0 : 0;
}

function findDestructive(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list.length && DESTRUCTIVE_SUBCOMMANDS.has(list[0])) return list[0];
  return list.find((arg) => DESTRUCTIVE_PATTERNS.some((re) => re.test(arg))) || null;
}

module.exports = {
  execGit,
  isRepo,
  parsePorcelainV2,
  getStatus,
  listBranches,
  listChangedFiles,
  recentCommits,
  graphLog,
  commitCount,
  repoNameFromRemote,
  findDestructive,
};
