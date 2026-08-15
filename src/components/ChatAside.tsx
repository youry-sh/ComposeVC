import React, { useEffect, useState } from "react";
import AsciiWar from "./AsciiWar";
import GitPanel from "./GitPanel";
import { RunnerJob } from "../types";
import {
  CONTEXT_METRICS_EVENT,
  ContextMetricsDetail,
  formatTokenCount,
} from "./StatusBar";

/**
 * Right column of the chat shell: a compact stats block on top and the table
 * of configured runners underneath. Read-only — every mutation still lives in
 * the Runner workspace; a row click just switches to it.
 */

const METRICS_POLL_MS = 3000;

type Props = {
  /** Chats held by the panels of the shell (sum of every panel's history). */
  chatCount: number;
  /** How many panels are streaming right now. */
  runningPanels: number;
  /** Folder of the panel currently on screen — drives the Git section. */
  activeRootPath: string | null;
  onOpenRunners?: () => void;
};

function relativeTime(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts)) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) {
    const ahead = Math.abs(diff);
    if (ahead < 60_000) return `in ${Math.round(ahead / 1000)}s`;
    if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)}m`;
    return `in ${Math.round(ahead / 3_600_000)}h`;
  }
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function triggerLabel(runner: RunnerJob): string {
  if (runner.trigger?.type === "interval") return `${runner.trigger.intervalMinutes}m`;
  return "manual";
}

/** Neutral status tone — the theme has no decorative colour, only semantics. */
function statusTone(runner: RunnerJob): "run" | "ok" | "err" | "off" | "idle" {
  if (runner.running) return "run";
  if (!runner.enabled) return "off";
  const status = String(runner.lastStatus || "").toLowerCase();
  if (status === "error") return "err";
  if (status === "success") return "ok";
  return "idle";
}

function statusText(runner: RunnerJob): string {
  if (runner.running) return "running";
  if (runner.queued) return "queued";
  if (!runner.enabled) return "off";
  const status = String(runner.lastStatus || "").toLowerCase();
  return status || "idle";
}

const StatTile: React.FC<{ label: string; value: string; title?: string }> = ({
  label,
  value,
  title,
}) => (
  <div className="aside-stat" title={title}>
    <span className="aside-stat-label">{label}</span>
    <span className="aside-stat-value">{value}</span>
  </div>
);

const ChatAside: React.FC<Props> = ({ chatCount, runningPanels, activeRootPath, onOpenRunners }) => {
  const [tokens, setTokens] = useState("0");
  const [requests, setRequests] = useState("0");
  const [contextBySlot, setContextBySlot] = useState<Record<string, number>>({});
  const [runners, setRunners] = useState<RunnerJob[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const usage = await window.lopster?.proxyGetUsageStats?.();
        if (cancelled) return;
        const totals = usage?.ok ? usage.usage?.totals : null;
        setTokens(formatTokenCount(totals?.totalTokens ?? 0));
        setRequests(formatTokenCount(totals?.requests ?? 0));
      } catch {
        /* ignore */
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), METRICS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Same live context feed the status strip uses — every panel reports its own.
  useEffect(() => {
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<ContextMetricsDetail>).detail;
      if (!detail || typeof detail.slotId !== "string") return;
      const value = Math.max(0, Number(detail.tokens) || 0);
      setContextBySlot((prev) => (prev[detail.slotId] === value ? prev : { ...prev, [detail.slotId]: value }));
    };
    window.addEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
    return () => window.removeEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await window.lopster?.listRunners?.();
        if (!cancelled && res?.ok && Array.isArray(res.runners)) setRunners(res.runners);
      } catch {
        /* ignore */
      }
    };
    void load();
    const unsubChanged = window.lopster?.onRunnersChanged?.((payload) => {
      if (Array.isArray(payload?.runners)) setRunners(payload.runners);
      else void load();
    });
    const unsubStatus = window.lopster?.onRunnerStatus?.(() => void load());
    return () => {
      cancelled = true;
      unsubChanged?.();
      unsubStatus?.();
    };
  }, []);

  const contextTotal = Object.values(contextBySlot).reduce((sum, n) => sum + (Number(n) || 0), 0);
  const activeRunners = runners.filter((r) => r.enabled).length;

  return (
    <aside className="chat-aside" aria-label="Overview">
      <section className="aside-block">
        <header className="aside-head">
          <span className="aside-title">Overview</span>
          {runningPanels > 0 && <span className="aside-head-note">{runningPanels} active</span>}
        </header>
        <div className="aside-stats">
          <StatTile label="Tokens" value={tokens} title="Proxy usage — total tokens" />
          <StatTile label="Context" value={formatTokenCount(contextTotal)} title="Live context across all panels" />
          <StatTile label="Requests" value={requests} title="Proxy usage — requests" />
          <StatTile label="Chats" value={String(chatCount)} title="Saved chats across all panels" />
        </div>
      </section>

      <GitPanel rootPath={activeRootPath} />

      <section className="aside-block aside-block-grow">
        <header className="aside-head">
          <span className="aside-title">Runners</span>
          <span className="aside-head-note">
            {activeRunners}/{runners.length}
          </span>
        </header>

        {runners.length === 0 ? (
          <p className="aside-empty">No runners configured</p>
        ) : (
          <div className="aside-table" role="table">
            <div className="aside-tr aside-tr-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Every</span>
              <span role="columnheader">Last</span>
            </div>
            {runners.map((runner) => (
              <button
                key={runner.id}
                type="button"
                className={`aside-tr aside-tr-row tone-${statusTone(runner)}`}
                role="row"
                onClick={onOpenRunners}
                title={runner.rootPath || runner.name}
              >
                <span className="aside-td-name" role="cell">
                  <span className="aside-dot" aria-hidden />
                  <span className="aside-name-text">{runner.name}</span>
                </span>
                <span className="aside-td-mono" role="cell">
                  {triggerLabel(runner)}
                </span>
                <span className="aside-td-mono" role="cell">
                  {relativeTime(runner.lastRunAt)}
                </span>
                <span className="aside-td-status" role="cell">
                  {statusText(runner)}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Idle decoration — runs on its own, nothing to configure. */}
      <section className="aside-block aside-block-war">
        <AsciiWar />
      </section>
    </aside>
  );
};

export default ChatAside;
