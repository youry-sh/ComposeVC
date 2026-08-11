import React, { useCallback, useEffect, useState } from "react";
import ChatMonoScroll from "./ChatMonoScroll";
import { AUTO_DEFAULT, AutoPrefs, loadAutoPrefs, saveAutoPrefs } from "./GitBadge";
import type { GitBranch, GitChangedFile, GitStatus } from "../global";

/**
 * Git for the active chat, inline in the right column — no modal, no popover.
 *
 * The history is `git log --graph --all` rendered as-is: git already draws the
 * DAG in ASCII, so the branch lines are the real topology, not a redrawing.
 */

const POLL_MS = 10000;
const GRAPH_LIMIT = 60;

type Props = { rootPath: string | null };

type Details = {
  branches: GitBranch[];
  files: GitChangedFile[];
  graph: string[];
  totalCommits: number;
};

const EMPTY: Details = { branches: [], files: [], graph: [], totalCommits: 0 };

/** "<graph>\t<hash>\t<date>\t<author>\t<subject>" — the tab split keeps the
 *  graph column intact even when a subject contains spaces. */
function splitGraphLine(line: string) {
  const tab = line.indexOf("\t");
  if (tab === -1) return { graph: line, hash: "", date: "", author: "", subject: "" };
  const graph = line.slice(0, tab);
  const [hash = "", date = "", author = "", ...rest] = line.slice(tab + 1).split("\t");
  return { graph, hash, date, author, subject: rest.join("\t") };
}

const GitPanel: React.FC<Props> = ({ rootPath }) => {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [details, setDetails] = useState<Details>(EMPTY);
  const [auto, setAuto] = useState<AutoPrefs>(AUTO_DEFAULT);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setStatus(null);
      setDetails(EMPTY);
      return;
    }
    try {
      const next = await window.lopster?.gitStatus?.(rootPath);
      if (next) setStatus(next);
      if (next?.isRepo) {
        const res = await window.lopster?.gitDetails?.(rootPath, { limit: GRAPH_LIMIT });
        if (res?.ok) {
          setDetails({
            branches: res.branches || [],
            files: res.files || [],
            graph: res.graph || [],
            totalCommits: res.totalCommits || 0,
          });
        }
      } else {
        setDetails(EMPTY);
      }
    } catch {
      /* keep the last snapshot */
    }
  }, [rootPath]);

  useEffect(() => {
    setAuto(loadAutoPrefs(rootPath));
    void refresh();
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rootPath, refresh]);

  const toggleAuto = (patch: Partial<AutoPrefs>) => {
    if (!rootPath) return;
    const next = { ...auto, ...patch };
    setAuto(next);
    saveAutoPrefs(rootPath, next);
  };

  const runAction = async (action: "fetch" | "pull" | "push", label: string) => {
    if (!rootPath || busy) return;
    setBusy(action);
    setNotice(null);
    try {
      const res = await window.lopster?.gitAction?.(rootPath, action, {});
      const text = (res?.output || res?.error || (res?.ok ? "done" : "failed")).trim();
      setNotice({ text: `${label}: ${text}`.slice(0, 300), error: !res?.ok });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const switchBranch = async (branch: string) => {
    if (!rootPath || busy) return;
    setBusy(branch);
    setNotice(null);
    try {
      const res = await window.lopster?.gitAction?.(rootPath, "checkout", { branch });
      if (!res?.ok) setNotice({ text: res?.error || "checkout failed", error: true });
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  if (!rootPath) return null;

  if (!status) {
    return (
      <section className="aside-block">
        <header className="aside-head">
          <span className="aside-title">Git</span>
        </header>
        <p className="aside-empty">…</p>
      </section>
    );
  }

  if (!status.isRepo) {
    return (
      <section className="aside-block">
        <header className="aside-head">
          <span className="aside-title">Git</span>
        </header>
        <p className="aside-empty">
          {status.reason === "git-missing" ? "git is not installed" : "this folder is not a repository"}
        </p>
      </section>
    );
  }

  return (
    <section className="aside-block git-panel">
      <header className="aside-head">
        <span className="aside-title">Git</span>
        <span className="aside-head-note" title={status.remoteUrl || "no remote"}>
          {status.repoName}
        </span>
      </header>

      {/* numbers, no modal */}
      <div className="git-panel-nums">
        <span className="git-panel-branch" title={status.upstream || "no upstream"}>
          ⎇ {status.branch || "detached"}
        </span>
        <span className="git-num is-ahead" title="to push">↑{status.ahead}</span>
        <span className="git-num is-behind" title="to pull">↓{status.behind}</span>
        <span className="git-num is-staged" title="staged">+{status.staged}</span>
        <span className="git-num is-modified" title="modified">~{status.modified}</span>
        <span className="git-num is-untracked" title="new">?{status.untracked}</span>
        {status.conflicted > 0 && (
          <span className="git-num is-conflicted" title="conflicts">!{status.conflicted}</span>
        )}
        <span className="git-panel-total" title="commits in this branch">
          {details.totalCommits}
        </span>
      </div>

      <div className="git-panel-actions">
        <button type="button" disabled={!!busy} onClick={() => void runAction("fetch", "fetch")}>
          {busy === "fetch" ? "…" : "fetch"}
        </button>
        <button type="button" disabled={!!busy} onClick={() => void runAction("pull", "pull")}>
          {busy === "pull" ? "…" : "pull"}
        </button>
        <button type="button" disabled={!!busy} onClick={() => void runAction("push", "push")}>
          {busy === "push" ? "…" : "push"}
        </button>
        <label className="git-panel-switch" title="Commit every change automatically">
          <input type="checkbox" checked={auto.commit} onChange={() => toggleAuto({ commit: !auto.commit })} />
          commit
        </label>
        <label className="git-panel-switch" title="Push new commits automatically">
          <input type="checkbox" checked={auto.push} onChange={() => toggleAuto({ push: !auto.push })} />
          push
        </label>
      </div>

      {notice && <p className={`git-panel-notice${notice.error ? " is-error" : ""}`}>{notice.text}</p>}

      {details.branches.length > 0 && (
        <div className="git-panel-branches">
          {details.branches.slice(0, 10).map((branch) => (
            <button
              key={branch.name}
              type="button"
              className={`git-panel-branch-item${branch.current ? " is-current" : ""}`}
              disabled={!!busy || branch.current}
              onClick={() => void switchBranch(branch.name)}
            >
              {branch.name}
            </button>
          ))}
        </div>
      )}

      {details.files.length > 0 && (
        <div className="git-panel-files">
          {details.files.slice(0, 30).map((file) => (
            <div key={file.path} className="git-panel-file" title={file.path}>
              <span className={`git-panel-code${file.staged ? " is-staged" : ""}`}>{file.code}</span>
              <span className="git-panel-path">{file.path}</span>
            </div>
          ))}
          {details.files.length > 30 && (
            <div className="git-panel-more">+{details.files.length - 30} more</div>
          )}
        </div>
      )}

      <div className="git-panel-graph-head">
        <span>History</span>
        <span className="git-panel-graph-count">
          {Math.min(details.graph.length, GRAPH_LIMIT)} / {details.totalCommits}
        </span>
      </div>
      <div className="git-panel-graph">
        {details.graph.length === 0 && <span className="aside-empty">no commits</span>}
        {details.graph.map((line, index) => {
          const row = splitGraphLine(line);
          return (
            <div key={`${index}-${row.hash}`} className="git-graph-row" title={`${row.author} · ${row.date}`}>
              <span className="git-graph-rails">{row.graph}</span>
              {row.hash && <span className="git-graph-hash">{row.hash}</span>}
              <span className="git-graph-subject">{row.subject}</span>
              {row.date && <span className="git-graph-date">{row.date}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default GitPanel;
