import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GitStatus } from "../global";

/**
 * Repository line under a chat in the rail: branch and plain numbers, nothing
 * clickable and no popover. The full picture (graph, branches, files, actions)
 * lives in the right column instead.
 *
 * This component also owns the unattended commit/push loop for its folder,
 * because it is the thing that already polls `git status` every few seconds.
 */

const POLL_MS = 8000;
const AUTO_PREFS_KEY = "lopster-git-autocommit";

export type AutoPrefs = { commit: boolean; push: boolean };

/** Both are ON unless the folder has an explicit stored preference. */
export const AUTO_DEFAULT: AutoPrefs = { commit: true, push: true };

/**
 * Auto-commit is a property of the FOLDER, not of the panel. Two panels opened
 * on the same repo would otherwise both fire a commit on the same tick, so the
 * first mounted badge claims the folder and the others only render the state.
 */
const autoOwners = new Map<string, symbol>();

/** Older builds stored a bare boolean per folder — read that as commit-only. */
function normalizePref(value: unknown): AutoPrefs {
  if (value === true) return { commit: true, push: false };
  if (value && typeof value === "object") {
    const record = value as Partial<AutoPrefs>;
    return { commit: record.commit !== false, push: record.push !== false };
  }
  return { ...AUTO_DEFAULT };
}

export function loadAutoPrefs(rootPath: string | null): AutoPrefs {
  if (!rootPath) return { ...AUTO_DEFAULT };
  try {
    const raw = window.localStorage.getItem(AUTO_PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (parsed && typeof parsed === "object" && rootPath in parsed) {
      return normalizePref(parsed[rootPath]);
    }
  } catch {
    /* ignore */
  }
  return { ...AUTO_DEFAULT };
}

export function saveAutoPrefs(rootPath: string, prefs: AutoPrefs) {
  try {
    const raw = window.localStorage.getItem(AUTO_PREFS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    all[rootPath] = prefs;
    window.localStorage.setItem(AUTO_PREFS_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent(GIT_AUTO_CHANGED, { detail: { rootPath, prefs } }));
  } catch {
    /* ignore */
  }
}

/** Fired when the right column flips a switch, so the rail badge follows. */
export const GIT_AUTO_CHANGED = "lopster-git-auto-changed";

type Props = { rootPath: string | null };

const GitBadge: React.FC<Props> = ({ rootPath }) => {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [auto, setAuto] = useState<AutoPrefs>(AUTO_DEFAULT);
  const ownerRef = useRef<symbol>(Symbol("git-badge"));
  const lastSignatureRef = useRef<string | null>(null);
  const committingRef = useRef(false);
  const pushingRef = useRef(false);
  const pushCooldownRef = useRef(0);

  const refreshStatus = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      return;
    }
    try {
      const next = await window.lopster?.gitStatus?.(rootPath);
      if (next) setStatus(next);
    } catch {
      /* keep the last known state */
    }
  }, [rootPath]);

  useEffect(() => {
    void refreshStatus();
    const id = window.setInterval(() => {
      if (!document.hidden) void refreshStatus();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  // Claim (or release) the unattended loop for this folder, and follow the
  // switches in the right column.
  useEffect(() => {
    if (!rootPath) {
      setAuto(AUTO_DEFAULT);
      return;
    }
    setAuto(loadAutoPrefs(rootPath));
    const owner = ownerRef.current;
    if (!autoOwners.has(rootPath)) autoOwners.set(rootPath, owner);

    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ rootPath: string; prefs: AutoPrefs }>).detail;
      if (detail?.rootPath !== rootPath) return;
      setAuto(detail.prefs);
      lastSignatureRef.current = null;
      pushCooldownRef.current = 0;
    };
    window.addEventListener(GIT_AUTO_CHANGED, onChanged as EventListener);
    return () => {
      window.removeEventListener(GIT_AUTO_CHANGED, onChanged as EventListener);
      if (autoOwners.get(rootPath) === owner) autoOwners.delete(rootPath);
    };
  }, [rootPath]);

  // Commit once the working tree has been dirty AND unchanged for a full poll —
  // committing on the first sighting would catch half-written files mid-save.
  useEffect(() => {
    if (!auto.commit || !rootPath || !status?.isRepo) return;
    if (autoOwners.get(rootPath) !== ownerRef.current) return;
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
        if (res?.committed) lastSignatureRef.current = null;
      } finally {
        committingRef.current = false;
        await refreshStatus();
      }
    })();
  }, [auto.commit, rootPath, status, refreshStatus]);

  // Auto-push: send whatever the branch is ahead by. `git push` transfers only
  // the commits the remote lacks, so nothing already pushed is ever re-sent.
  useEffect(() => {
    if (!auto.push || !rootPath || !status?.isRepo) return;
    if (autoOwners.get(rootPath) !== ownerRef.current) return;
    if (pushingRef.current || committingRef.current) return;
    if (status.ahead === 0 || status.detached) return;
    if (Date.now() < pushCooldownRef.current) return;

    pushingRef.current = true;
    void (async () => {
      try {
        const res = await window.lopster?.gitAutoPush?.(rootPath);
        // A rejected push must not retry every poll — back off for a minute.
        if (!res?.pushed && res?.reason !== "nothing-to-push") {
          pushCooldownRef.current = Date.now() + 60_000;
        }
      } finally {
        pushingRef.current = false;
        await refreshStatus();
      }
    })();
  }, [auto.push, rootPath, status, refreshStatus]);

  if (!rootPath || !status) return null;

  if (!status.isRepo) {
    if (status.reason === "no-folder") return null;
    return (
      <span className="git-line is-plain">
        <span className="git-line-icon" aria-hidden>⎇</span>
        <span>{status.reason === "git-missing" ? "git not installed" : "not a repo"}</span>
      </span>
    );
  }

  return (
    <span className="git-line" title={`${status.repoName} · ${status.branch || "detached"}`}>
      <span className="git-line-icon" aria-hidden>⎇</span>
      <span className="git-line-branch">{status.branch || "detached"}</span>
      {status.ahead > 0 && <span className="git-num is-ahead" title="commits to push">↑{status.ahead}</span>}
      {status.behind > 0 && <span className="git-num is-behind" title="commits to pull">↓{status.behind}</span>}
      {status.staged > 0 && <span className="git-num is-staged" title="staged">+{status.staged}</span>}
      {status.modified > 0 && <span className="git-num is-modified" title="modified">~{status.modified}</span>}
      {status.untracked > 0 && <span className="git-num is-untracked" title="new">?{status.untracked}</span>}
      {status.conflicted > 0 && <span className="git-num is-conflicted" title="conflicts">!{status.conflicted}</span>}
      {!status.dirty && status.ahead === 0 && status.behind === 0 && (
        <span className="git-num is-clean">clean</span>
      )}
      {(auto.commit || auto.push) && (
        <span
          className="git-num is-auto"
          title={`auto ${[auto.commit ? "commit" : null, auto.push ? "push" : null].filter(Boolean).join(" + ")}`}
        >
          {auto.commit && auto.push ? "auto↑" : "auto"}
        </span>
      )}
    </span>
  );
};

export default GitBadge;
