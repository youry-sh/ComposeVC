import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Clock,
  FilePlus,
  GitCommitHorizontal,
  MessageSquare,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";

/** Mirrors the `usage:getSnapshot` IPC payload (see src/global.d.ts). */
type UsageToolRow = { name: string; calls: number; errors: number };
type UsageDailyRow = {
  date: string;
  toolCalls: number;
  promptChars: number;
  filesCreated: number;
  linesAdded: number;
  linesRemoved: number;
  terminals: number;
};
type UsageCounters = {
  filesCreated: number;
  linesAdded: number;
  linesRemoved: number;
  terminalsOpened: number;
  toolCalls: number;
  toolErrors: number;
  userPromptChars: number;
  userPrompts: number;
};
type UsageSnapshot = {
  v: number;
  createdAt: string;
  updatedAt: string;
  counters: UsageCounters;
  tools: UsageToolRow[];
  daily: UsageDailyRow[];
};
type UsagePayload = {
  ok: boolean;
  error?: string;
  usage: UsageSnapshot;
  runtime: { totalRuntimeSec: number; uptimeSec: number; sessions: number };
};

const DAYS_IN_CHART = 14;
const TOP_TOOLS = 8;
const POLL_MS = 1000;

function formatCount(value?: number | null): string {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  return n.toLocaleString("en-US");
}

function formatSigned(value?: number | null): string {
  const n = Math.trunc(Number(value) || 0);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n).toLocaleString("en-US")}`;
}

function formatCompact(value?: number | null): string {
  const n = Math.max(0, Math.floor(Number(value) || 0));
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Cumulative active time: `12d 04:03:02` when ≥1 day, else `hh:mm:ss`. */
function formatActiveTime(sec?: number | null): string {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return d > 0 ? `${d}d ${h}:${m}:${r}` : `${h}:${m}:${r}`;
}

function barPct(value: number, max: number): number {
  if (!max || value <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

function truePct(value: number, total: number): number {
  if (!total || value <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="usage-kpi">
      <div className="usage-kpi-top">
        <span className="usage-kpi-icon" style={accent ? { color: accent } : undefined}>
          {icon}
        </span>
        <span className="usage-kpi-label">{label}</span>
      </div>
      <div className="usage-kpi-value" title={value}>
        {value}
      </div>
      {hint ? (
        <div className="usage-kpi-hint" title={hint}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function UsageBar({ pct, color = "var(--accent)", track = "var(--hover-bg)" }: { pct: number; color?: string; track?: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="usage-bar" style={{ background: track }}>
      <div
        className="usage-bar-fill"
        style={{ width: `${w}%`, background: color, boxShadow: w > 0 ? `0 0 10px color-mix(in srgb, ${color} 35%, transparent)` : undefined }}
      />
    </div>
  );
}

const UsageWorkspace: React.FC = () => {
  const [data, setData] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const snap = (await window.lopster?.usageGetSnapshot?.()) as UsagePayload | undefined;
      if (!mountedRef.current) return;
      if (snap && snap.ok) {
        setData(snap);
        setError(null);
        setLastSync(Date.now());
      } else if (snap && !snap.ok) {
        setError(snap.error || "Failed to load usage data");
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  const counters = data?.usage?.counters;
  const runtime = data?.runtime;

  const linesNet = useMemo(
    () => (counters ? counters.linesAdded - counters.linesRemoved : 0),
    [counters]
  );
  const toolsUsed = useMemo(() => data?.usage?.tools?.length ?? 0, [data]);

  const daily = useMemo(() => {
    const all = data?.usage?.daily ?? [];
    return all.slice(-DAYS_IN_CHART);
  }, [data]);

  const dailyMax = useMemo(() => {
    let m = 1;
    for (const d of daily) {
      m = Math.max(m, d.toolCalls, d.promptChars, d.filesCreated, d.linesAdded, d.linesRemoved, d.terminals);
    }
    return m;
  }, [daily]);

  const topTools = useMemo(() => (data?.usage?.tools ?? []).slice(0, TOP_TOOLS), [data]);
  const maxToolCalls = useMemo(() => {
    let m = 1;
    for (const t of topTools) m = Math.max(m, t.calls);
    return m;
  }, [topTools]);

  const hasAnyData = Boolean(
    data &&
      (counters?.toolCalls ||
        counters?.filesCreated ||
        counters?.terminalsOpened ||
        counters?.userPrompts ||
        (runtime?.sessions ?? 0) > 0)
  );

  const dailyShortLabel = (date: string) => {
    const parts = date.split("-");
    return parts.length === 3 ? `${parts[1]}-${parts[2]}` : date;
  };

  const totalCalls = counters?.toolCalls ?? 0;

  return (
    <div className="usage-workspace flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="usage-header-bar">
        <div className="usage-header-mark">
          <BarChart3 className="w-3.5 h-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="usage-header-title">Usage</div>
          <div className="usage-header-sub">
            {loading
              ? "loading…"
              : lastSync
                ? `synced ${new Date(lastSync).toLocaleTimeString([], { hour12: false })}`
                : "—"}
            {data?.usage?.createdAt ? ` · since ${new Date(data.usage.createdAt).toLocaleDateString()}` : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="usage-header-icon"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && <div className="usage-error-banner">{error}</div>}

      <ChatMonoScroll className="usage-scroll">
        <div className="usage-content">
          {/* KPI row 1 — headline numbers */}
          <div className="usage-kpi-grid">
            <KpiCard
              label="Active time"
              value={formatActiveTime(runtime?.totalRuntimeSec)}
              hint={`this session ${formatActiveTime(runtime?.uptimeSec)}`}
              icon={<Clock className="w-3.5 h-3.5" />}
              accent="var(--accent)"
            />
            <KpiCard
              label="Sessions"
              value={formatCount(runtime?.sessions)}
              hint="app launches"
              icon={<Activity className="w-3.5 h-3.5" />}
              accent="var(--info)"
            />
            <KpiCard
              label="Files created"
              value={formatCount(counters?.filesCreated)}
              hint="new files in IDE"
              icon={<FilePlus className="w-3.5 h-3.5" />}
              accent="var(--ok)"
            />
            <KpiCard
              label="Lines changed"
              value={formatSigned(linesNet)}
              hint={`+${formatCount(counters?.linesAdded)} / −${formatCount(counters?.linesRemoved)}`}
              icon={<GitCommitHorizontal className="w-3.5 h-3.5" />}
              accent="var(--accent-2)"
            />
          </div>

          {/* KPI row 2 */}
          <div className="usage-kpi-grid">
            <KpiCard
              label="Tool calls"
              value={formatCount(counters?.toolCalls)}
              hint={counters?.toolErrors ? `${formatCount(counters.toolErrors)} errors` : `${toolsUsed} tools used`}
              icon={<Wrench className="w-3.5 h-3.5" />}
              accent="var(--warn)"
            />
            <KpiCard
              label="Tools used"
              value={formatCount(toolsUsed)}
              hint="distinct tools"
              icon={<Wrench className="w-3.5 h-3.5" />}
            />
            <KpiCard
              label="Prompts"
              value={formatCount(counters?.userPrompts)}
              hint="messages sent"
              icon={<MessageSquare className="w-3.5 h-3.5" />}
              accent="var(--info)"
            />
            <KpiCard
              label="Prompt characters"
              value={formatCompact(counters?.userPromptChars)}
              hint={formatCount(counters?.userPromptChars)}
              icon={<MessageSquare className="w-3.5 h-3.5" />}
              accent="var(--accent-2)"
            />
          </div>

          {/* Charts row */}
          <div className="usage-charts">
            {/* Activity — daily time series */}
            <section className="proxy-panel usage-panel">
              <div className="proxy-panel-head">
                <div className="text-[11px] font-medium text-ink-900">Activity · last {DAYS_IN_CHART} days</div>
                <span className="proxy-pill ml-auto">
                  {formatCompact(totalCalls)} tool calls
                </span>
              </div>
              {daily.length === 0 ? (
                <div className="usage-empty flex-1">
                  <div className="text-[12px] text-ink-500">No activity yet</div>
                  <div className="mt-1 text-[11px] text-ink-500">Use tools or chat to fill the timeline</div>
                </div>
              ) : (
                <div className="usage-daily-chart">
                  {daily.map((row) => {
                    const toolPct = (row.toolCalls / dailyMax) * 100;
                    const promptPct = (row.promptChars / dailyMax) * 100;
                    return (
                      <div key={row.date} className="usage-daily-col" title={`${row.date}\ntool calls ${formatCount(row.toolCalls)}\nprompt chars ${formatCount(row.promptChars)}`}>
                        <div className="usage-daily-bars">
                          <div className="usage-daily-bar" style={{ height: `${Math.max(toolPct > 0 ? 6 : 0, toolPct)}%`, background: "linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 45%, transparent) 100%)" }} />
                          <div className="usage-daily-bar is-secondary" style={{ height: `${Math.max(promptPct > 0 ? 6 : 0, promptPct)}%`, background: "linear-gradient(180deg, var(--info) 0%, color-mix(in srgb, var(--info) 45%, transparent) 100%)" }} />
                        </div>
                        <div className="usage-daily-label">{dailyShortLabel(row.date)}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="usage-chart-legend">
                <span className="usage-legend-item"><i style={{ background: "var(--accent)" }} />tool calls</span>
                <span className="usage-legend-item"><i style={{ background: "var(--info)" }} />prompt chars</span>
              </div>
            </section>

            {/* Tool usage breakdown */}
            <section className="proxy-panel usage-panel">
              <div className="proxy-panel-head">
                <div className="text-[11px] font-medium text-ink-900">Tool usage</div>
                <span className="proxy-pill ml-auto">top {topTools.length} / {toolsUsed}</span>
              </div>
              {topTools.length === 0 ? (
                <div className="usage-empty flex-1">
                  <div className="text-[12px] text-ink-500">No tool calls yet</div>
                  <div className="mt-1 text-[11px] text-ink-500">Run an agent task to fill</div>
                </div>
              ) : (
                <div className="usage-tool-list">
                  {topTools.map((tool, idx) => (
                    <div key={tool.name} className="usage-tool-row">
                      <div className="flex items-center gap-2 min-w-0 mb-0.5">
                        <span className="w-4 text-[10px] font-mono tabular-nums text-ink-500 flex-shrink-0">{String(idx + 1).padStart(2, "0")}</span>
                        <span className="min-w-0 flex-1 text-[11px] font-mono truncate text-ink-950" title={tool.name}>{tool.name}</span>
                        {tool.errors > 0 ? (
                          <span className="usage-err" title={`${formatCount(tool.errors)} errors`}>{formatCount(tool.errors)} err</span>
                        ) : null}
                        <span className="text-[11px] font-mono tabular-nums font-medium text-ink-950 w-[4.5rem] text-right flex-shrink-0" title={formatCount(tool.calls)}>
                          {formatCount(tool.calls)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 pl-6">
                        <UsageBar pct={barPct(tool.calls, maxToolCalls)} color="var(--accent)" />
                        <span className="text-[9px] font-mono tabular-nums w-8 text-right" style={{ color: "var(--text-muted)" }}>{truePct(tool.calls, totalCalls)}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Detail row */}
          <div className="usage-charts">
            {/* Code + terminals */}
            <section className="proxy-panel usage-panel">
              <div className="proxy-panel-head">
                <div className="text-[11px] font-medium text-ink-900">Code &amp; terminals</div>
              </div>
              <div className="usage-detail">
                <div className="usage-detail-row">
                  <span className="usage-detail-key">Lines added</span>
                  <span className="usage-detail-val" style={{ color: "var(--ok)" }}>+{formatCount(counters?.linesAdded)}</span>
                </div>
                <div className="usage-detail-row">
                  <span className="usage-detail-key">Lines removed</span>
                  <span className="usage-detail-val" style={{ color: "var(--warn)" }}>−{formatCount(counters?.linesRemoved)}</span>
                </div>
                <div className="usage-detail-row">
                  <span className="usage-detail-key">Net lines</span>
                  <span className="usage-detail-val">{formatSigned(linesNet)}</span>
                </div>
                <div className="usage-detail-row">
                  <span className="usage-detail-key">Terminals opened</span>
                  <span className="usage-detail-val">{formatCount(counters?.terminalsOpened)}</span>
                </div>
                <div className="usage-detail-row">
                  <span className="usage-detail-key">Avg chars / prompt</span>
                  <span className="usage-detail-val">{counters?.userPrompts ? formatCount(Math.round((counters.userPromptChars || 0) / counters.userPrompts)) : "—"}</span>
                </div>
              </div>
            </section>

            {/* All tools table */}
            <section className="proxy-panel usage-panel">
              <div className="proxy-panel-head">
                <div className="text-[11px] font-medium text-ink-900">All tools</div>
                <span className="proxy-pill ml-auto">{toolsUsed} total</span>
              </div>
              {(data?.usage?.tools ?? []).length === 0 ? (
                <div className="usage-empty flex-1">—</div>
              ) : (
                <div className="usage-table">
                  <div className="usage-table-head">
                    <span className="flex-1">Tool</span>
                    <span className="w-16 text-right">Calls</span>
                    <span className="w-14 text-right">Errors</span>
                    <span className="w-14 text-right">Share</span>
                  </div>
                  {(data?.usage?.tools ?? []).map((tool) => (
                    <div key={tool.name} className="usage-table-row">
                      <span className="flex-1 truncate font-mono" title={tool.name}>{tool.name}</span>
                      <span className="w-16 text-right font-mono tabular-nums">{formatCount(tool.calls)}</span>
                      <span className="w-14 text-right font-mono tabular-nums" style={{ color: tool.errors ? "var(--warn)" : "var(--text-muted)" }}>{tool.errors || "—"}</span>
                      <span className="w-14 text-right font-mono tabular-nums" style={{ color: "var(--text-muted)" }}>{sharePct(tool.calls, totalCalls)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {!hasAnyData && !loading && (
            <div className="usage-empty-state">
              <Terminal className="w-4 h-4" />
              <span>Statistics will appear here as you use the IDE. Create a file, open a terminal, run a tool, or send a prompt.</span>
            </div>
          )}
        </div>
      </ChatMonoScroll>
    </div>
  );
};

export default UsageWorkspace;
