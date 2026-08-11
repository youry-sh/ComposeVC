import React, { useEffect, useRef, useState } from "react";
import { Clock3, Database, HardDrive, Layers } from "lucide-react";

export const CONTEXT_METRICS_EVENT = "lopster-context-metrics";

export type ContextMetricsDetail = {
  slotId: string;
  tokens: number;
};

export function formatTokenCount(value?: string | number | null): string {
  if (value == null || value === "") return "0";
  let s = String(value).trim().replace(/[,_\s]/g, "");
  if (!s) return "0";
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return "0";
    s = String(Math.trunc(n));
  }
  s = s.replace(/^0+(?=\d)/, "") || "0";
  if (s.length <= 4) return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const units: Array<{ suffix: string; digits: number }> = [
    { suffix: "T", digits: 12 },
    { suffix: "B", digits: 9 },
    { suffix: "M", digits: 6 },
    { suffix: "K", digits: 3 },
  ];
  for (const u of units) {
    if (s.length > u.digits) {
      const whole = s.slice(0, s.length - u.digits);
      const frac = s.slice(s.length - u.digits, s.length - u.digits + 1);
      const trimmed = frac.replace(/0+$/, "");
      return trimmed ? `${whole}.${trimmed}${u.suffix}` : `${whole}${u.suffix}`;
    }
  }
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatBytes(bytes?: number | null): string {
  const n = Number(bytes) || 0;
  if (n <= 0) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(2) : gb.toFixed(1)} GB`;
}

export function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${r}`;
}

const StatusBar: React.FC<{ label?: string }> = ({ label = "MultiIDE" }) => {
  const [uptime, setUptime] = useState("00:00:00");
  const uptimeSecRef = useRef(0);
  const uptimeSyncAtRef = useRef(Date.now());
  const [memoryLabel, setMemoryLabel] = useState("—");
  const [tokensLabel, setTokensLabel] = useState("0");
  const [contextLabel, setContextLabel] = useState("0");
  const [contextBySlot, setContextBySlot] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    const refreshMetrics = async () => {
      try {
        const sys = await window.lopster?.getSystemMetrics?.();
        if (cancelled) return;
        if (sys?.ok) {
          setMemoryLabel(formatBytes(sys.workingSetBytes || sys.rss || sys.heapUsed || 0));
          if (typeof sys.uptimeSec === "number") {
            uptimeSecRef.current = sys.uptimeSec;
            uptimeSyncAtRef.current = Date.now();
            setUptime(formatUptime(sys.uptimeSec));
          }
        } else {
          const perf = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
          if (perf?.usedJSHeapSize) setMemoryLabel(formatBytes(perf.usedJSHeapSize));
        }
      } catch {
        /* ignore */
      }

      try {
        const usage = await window.lopster?.proxyGetUsageStats?.();
        if (cancelled) return;
        const total = usage?.ok ? usage.usage?.totals?.totalTokens : null;
        setTokensLabel(formatTokenCount(total ?? 0));
      } catch {
        if (!cancelled) setTokensLabel("0");
      }
    };

    void refreshMetrics();
    const id = window.setInterval(() => {
      void refreshMetrics();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Smooth 1s uptime tick — the 2s metrics poll only re-syncs the base value.
  useEffect(() => {
    const id = window.setInterval(() => {
      setUptime(
        formatUptime(uptimeSecRef.current + Math.floor((Date.now() - uptimeSyncAtRef.current) / 1000))
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<ContextMetricsDetail>).detail;
      if (!detail || typeof detail.slotId !== "string") return;
      const tokens = Math.max(0, Number(detail.tokens) || 0);
      setContextBySlot((prev) => {
        if (prev[detail.slotId] === tokens) return prev;
        return { ...prev, [detail.slotId]: tokens };
      });
    };
    window.addEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
    return () => window.removeEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
  }, []);

  useEffect(() => {
    const total = Object.values(contextBySlot).reduce((sum, n) => sum + (Number(n) || 0), 0);
    setContextLabel(formatTokenCount(total));
  }, [contextBySlot]);

  return (
    <div className="status-strip">
      <div className="status-strip-left">
        <span className="text-ink-500 truncate max-w-[200px]">{label}</span>
      </div>

      <div className="status-strip-metrics">
        <span className="status-metric" title="App process memory">
          <HardDrive />
          Memory: {memoryLabel}
        </span>
        <span className="status-metric" title="Proxy usage total tokens">
          <Layers />
          Tokens: {tokensLabel}
        </span>
        <span className="status-metric" title="Current chat context (all MultiIDE slots)">
          <Database />
          Context: {contextLabel}
        </span>
        <span className="status-metric" title="Process uptime">
          <Clock3 />
          Uptime: {uptime}
        </span>
      </div>

      <div className="status-strip-right" />
    </div>
  );
};

export default StatusBar;
