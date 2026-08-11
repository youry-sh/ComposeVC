import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { GitBranch, GitChangedFile, GitCommit, GitStatus } from "../global";

/**
 * Repository indicator for one chat panel: branch, counters and — on click —
 * a popover with the branch list, the changed files, recent commits and the
 * four safe remote actions.
 *
 * The status poll is cheap (one `git status --porcelain=v2`) but it still runs
 * per panel, so it pauses while the window is hidden and while the popover is
 * doing something.
 */

const POLL_MS = 8000;
const AUTOCOMMIT_KEY = "lopster-git-autocommit";

/**
 * Auto-commit is a property of the FOLDER, not of the panel. Two panels opened
 * on the same repo would otherwise both fire a commit on the same tick, so the
 * first mounted badge claims the folder and the others only render the state.
 */
const autoCommitOwners = new Map<string, symbol>();

function loadAutoCommitPrefs(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(AUTOCOMMIT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === "object") return parsed as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return {};
}

function saveAutoCommitPref(rootPath: string, enabled: boolean) {
  try {
    const prefs = loadAutoCommitPrefs();
    if (enabled) prefs[rootPath] = true;
    else delete prefs[rootPath];
    window.localStorage.setItem(AUTOCOMMIT_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function autoCommitSkipText(reason?: string, files?: number): string | null {
  switch (reason) {
    case "conflicts":
      return "auto-commit paused: resolve the conflicts first";
    case "merge-in-progress":
      return "auto-commit paused: merge/rebase in progress";
    case "too-many":
      return `auto-commit paused: ${files} changed files — add a .gitignore`;
    case "nothing-staged":
      return "auto-commit: everything is ignored, nothing to commit";
    case "add-failed":
    case "commit-failed":
    case "error":
      return "auto-commit failed";
    default:
      return null;
  }
}

type Props = {
  rootPath: string | null;
  /** Rendered inline in the rail row; the popover is portalled to <body>. */
  compact?: boolean;
};

type Details = {
  branches: GitBranch[];
  files: GitChangedFile[];
  commits: GitCommit[];
};

const EMPTY_DETAILS: Details = { branches: [], files: [], commits: [] };

const GitBadge: React.FC<Props> = ({ rootPath }) => {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY_DETAILS);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const [autoCommit, setAutoCommit] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** Identity of this badge, used to claim auto-commit for a folder. */
  const ownerRef = useRef<symbol>(Symbol("git-badge"));
  /** Last seen dirty signature — a commit only fires once it stops changing. */
  const lastSignatureRef = useRef<string | null>(null);
  const committingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      return;
    }
    try {
      const next = await window.lopster?.gitStatus?.(rootPath);
      if (next) setStatus(next);
    } catch {
      /* ignore — the badge just keeps its last known state */
    }
  }, [rootPath]);

  // Declared before the effects below: they list it as a dependency, and a
  // dependency array is evaluated during render — a `const` declared further
  // down would still be in its temporal dead zone and throw.
  const loadDetails = useCallback(async () => {
    if (!rootPath) return;
    try {
      const res = await window.lopster?.gitDetails?.(rootPath);
      if (res?.ok) {
        setDetails({
          branches: res.branches || [],
          files: res.files || [],
          commits: res.commits || [],
        });
      }
    } catch {
      /* ignore */
    }
  }, [rootPath]);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  // Claim (or release) auto-commit ownership of this folder.
  useEffect(() => {
    if (!rootPath) {
      setAutoCommit(false);
      return;
    }
    setAutoCommit(Boolean(loadAutoCommitPrefs()[rootPath]));
    const owner = ownerRef.current;
    if (!autoCommitOwners.has(rootPath)) autoCommitOwners.set(rootPath, owner);
    return () => {
      if (autoCommitOwners.get(rootPath) === owner) autoCommitOwners.delete(rootPath);
    };
  }, [rootPath]);

  // Commit once the working tree has been dirty AND unchanged for a full poll —
  // committing on the first sighting would catch half-written files mid-save.
  useEffect(() => {
    if (!autoCommit || !rootPath || !status?.isRepo) return;
    if (autoCommitOwners.get(rootPath) !== ownerRef.current) return;
    if (committingRef.current) return;

    const signature = `${status.staged}/${status.modified}/${status.untracked}/${status.conflicted}`;
    if (!status.dirty) {
      lastSignatureRef.current = null;
      return;
    }
    if (lastSignatureRef.current !== signature) {
      lastSignatureRef.current = signature;
      return;
    }

    committingRef.current = true;
    void (async () => {
      try {
        const res = await window.lopster?.gitAutoCommit?.(rootPath, {});
        if (res?.committed) {
          setNotice({ text: `auto-commit ${res.hash || ""} · ${res.message || ""}`.trim(), error: false });
          lastSignatureRef.current = null;
        } else {
          const text = autoCommitSkipText(res?.reason, res?.files);
          if (text) setNotice({ text, error: true });
        }
      } finally {
        committingRef.current = false;
        await refreshStatus();
        if (open) await loadDetails();
      }
    })();
  }, [autoCommit, rootPath, status, open, refreshStatus, loadDetails]);

  const toggleAutoCommit = () => {
    if (!rootPath) return;
    const next = !autoCommit;
    setAutoCommit(next);
    saveAutoCommitPref(rootPath, next);
    lastSignatureRef.current = null;
    // Whoever flips the switch takes over the folder.
    autoCommitOwners.set(rootPath, ownerRef.current);
    setNotice(next ? { text: "auto-commit on", error: false } : null);
  };

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      // Portalled to <body> so the rail's own scroll container cannot clip it.
      const width = 320;
      setAnchor({
        top: Math.min(window.innerHeight - 380, Math.max(8, rect.top)),
        left: Math.min(window.innerWidth - width - 8, rect.right + 8),
      });
    }
    setNotice(null);
    setOpen(true);
    void loadDetails();
  };

  const runAction = async (action: "fetch" | "pull" | "push", label: string) => {
    if (!rootPath || busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const res = await window.lopster?.gitAction?.(rootPath, action, {});
      const message = res?.output || res?.error || (res?.ok ? "done" : "failed");
      setNotice({ text: `${label}: ${message}`.slice(0, 400), error: !res?.ok });
    } catch (error) {
      setNotice({ text: String((error as Error)?.message || error), error: true });
    } finally {
      setBusy(null);
      await refreshStatus();
      await loadDetails();
    }
  };

  const switchBranch = async (branch: string) => {
    if (!rootPath || busy) return;
    setBusy(`checkout:${branch}`);
    setNotice(null);
    try {
      const res = await window.lopster?.gitAction?.(rootPath, "checkout", { branch });
      if (!res?.ok) setNotice({ text: res?.error || res?.output || "checkout failed", error: true });
    } finally {
      setBusy(null);
      await refreshStatus();
      await loadDetails();
    }
  };

  if (!rootPath) return null;
  if (!status) return null;

  if (!status.isRepo) {
    if (status.reason === "no-folder") return null;
    return (
      <span className="git-badge is-plain" title={status.reason === "git-missing" ? "git is not installed" : "Not a git repository"}>
        <span className="git-badge-icon" aria-hidden>⎇</span>
        <span className="git-badge-text">{status.reason === "git-missing" ? "no git" : "no repo"}</span>
      </span>
    );
  }

  const counters: Array<{ key: string; value: number; title: string; glyph: string }> = [
    { key: "staged", value: status.staged, title: "staged", glyph: "+" },
    { key: "modified", value: status.modified, title: "modified", glyph: "~" },
    { key: "untracked", value: status.untracked, title: "untracked", glyph: "?" },
    { key: "conflicted", value: status.conflicted, title: "conflicts", glyph: "!" },
  ].filter((item) => item.value > 0);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`git-badge${status.dirty ? " is-dirty" : ""}${open ? " is-open" : ""}`}
        onClick={toggle}
        title={`${status.repoName} · ${status.branch || "detached"}`}
      >
        <span className="git-badge-icon" aria-hidden>⎇</span>
        <span className="git-badge-branch">{status.branch || "detached"}</span>
        {status.ahead > 0 && <span className="git-badge-sync" title="ahead">↑{status.ahead}</span>}
        {status.behind > 0 && <span className="git-badge-sync" title="behind">↓{status.behind}</span>}
        {counters.map((item) => (
          <span key={item.key} className={`git-badge-count is-${item.key}`} title={item.title}>
            {item.glyph}
            {item.value}
          </span>
        ))}
        {!status.dirty && status.ahead === 0 && status.behind === 0 && (
          <span className="git-badge-clean" title="clean">clean</span>
        )}
        {autoCommit && (
          <span className="git-badge-auto" title="auto-commit is on for this folder">auto</span>
        )}
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="git-pop"
            style={{ top: anchor.top, left: anchor.left }}
            role="dialog"
            aria-label="Git"
          >
            <header className="git-pop-head">
              <span className="git-pop-repo" title={status.remoteUrl || status.root}>
                {status.repoName}
              </span>
              <span className="git-pop-branch">{status.branch || "detached"}</span>
            </header>
            <div className="git-pop-remote" title={status.remoteUrl || "no remote"}>
              {status.remoteUrl || "no remote"}
            </div>

            <div className="git-pop-actions">
              <button type="button" disabled={!!busy} onClick={() => void runAction("fetch", "fetch")}>
                {busy === "fetch" ? "…" : "fetch"}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void runAction("pull", "pull")}>
                {busy === "pull" ? "…" : "pull"}
              </button>
              <button type="button" disabled={!!busy} onClick={() => void runAction("push", "push")}>
                {busy === "push" ? "…" : "push"}
              </button>
              <span className="git-pop-sync">
                ↑{status.ahead} ↓{status.behind}
              </span>
            </div>

            <label className="git-pop-auto" title="Stage everything and commit it whenever the folder stops changing">
              <input type="checkbox" checked={autoCommit} onChange={toggleAutoCommit} />
              <span className="git-pop-auto-text">
                <span className="git-pop-auto-title">Auto-commit</span>
                <span className="git-pop-auto-hint">
                  commits `git add -A` ~{Math.round((POLL_MS * 2) / 1000)}s after the last change
                </span>
              </span>
            </label>

            {notice && (
              <p className={`git-pop-notice${notice.error ? " is-error" : ""}`}>{notice.text}</p>
            )}

            <section className="git-pop-section">
              <h4>Branches</h4>
              <div className="git-pop-branches">
                {details.branches.length === 0 && <span className="git-pop-empty">—</span>}
                {details.branches.slice(0, 12).map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    className={`git-pop-branch-item${branch.current ? " is-current" : ""}`}
                    disabled={!!busy || branch.current}
                    onClick={() => void switchBranch(branch.name)}
                    title={branch.current ? "current branch" : `switch to ${branch.name}`}
                  >
                    {branch.name}
                  </button>
                ))}
              </div>
            </section>

            <section className="git-pop-section">
              <h4>
                Changes <span className="git-pop-count">{details.files.length}</span>
              </h4>
              <div className="git-pop-list">
                {details.files.length === 0 && <span className="git-pop-empty">working tree clean</span>}
                {details.files.slice(0, 40).map((file) => (
                  <div key={file.path} className="git-pop-file" title={file.path}>
                    <span className={`git-pop-code${file.staged ? " is-staged" : ""}`}>{file.code}</span>
                    <span className="git-pop-path">{file.path}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="git-pop-section">
              <h4>Commits</h4>
              <div className="git-pop-list">
                {details.commits.length === 0 && <span className="git-pop-empty">—</span>}
                {details.commits.map((commit) => (
                  <div key={commit.hash} className="git-pop-commit" title={`${commit.author} · ${commit.when}`}>
                    <span className="git-pop-hash">{commit.hash}</span>
                    <span className="git-pop-subject">{commit.subject}</span>
                    <span className="git-pop-when">{commit.when}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>,
          document.body
        )}
    </>
  );
};

export default GitBadge;
