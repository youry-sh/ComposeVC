import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Minus, Square, X } from "lucide-react";
import {
  IcoMulti,
  IcoProxy,
  IcoRunner,
  IcoTools,
  IcoSettings,
  IcoProviders,
  IcoTerminal,
  IcoKnowledge,
  IcoWebEngine,
  IcoDocs,
  IcoUsage,
  IcoPrompts,
} from "./topIcons";
import PromptsWorkspace from "./PromptsWorkspace";
import UpdateBadge from "./UpdateBadge";
import {
  CONTEXT_METRICS_EVENT,
  ContextMetricsDetail,
  formatBytes,
  formatTokenCount,
} from "./StatusBar";

type Panel = "multiide" | "webengine" | "proxy" | "settings" | "customtools" | "runner" | "terminal" | "knowledge" | "docs" | "usage";

interface TitleBarProps {
  subtitle?: string;
  active: Panel;
  onSelect: (panel: Panel) => void;
  onOpenProviders?: () => void;
  labels?: {
    multiIde?: string;
    proxy?: string;
    settings?: string;
    providers?: string;
  };
}

const WAVE_PATTERN = [4, 7, 11, 15, 18, 15, 11, 7, 4, 6, 10, 14, 18, 14, 10, 6];

/** Sound-wave equalizer bars, white, scaled by the live data ratio. */
function Wave({ ratio }: { ratio: number }) {
  const r = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
  return (
    <div className="topbar-wave-bars" aria-hidden>
      {WAVE_PATTERN.map((h, i) => (
        <i
          key={i}
          className="topbar-wave-bar"
          style={{
            height: `${Math.max(2, Math.round(h * (0.35 + 0.65 * r)))}px`,
            animationDelay: `${(i % 4) * 0.14}s`,
          }}
        />
      ))}
    </div>
  );
}

const TitleBar: React.FC<TitleBarProps> = ({
  active,
  onSelect,
  onOpenProviders,
  labels,
}) => {
  const [memoryLabel, setMemoryLabel] = useState("—");
  const [memoryRatio, setMemoryRatio] = useState(0);
  const [tokensLabel, setTokensLabel] = useState("0");
  const [tokensRatio, setTokensRatio] = useState(0);
  const [contextLabel, setContextLabel] = useState("0");
  const [contextRatio, setContextRatio] = useState(0);
  const [clock, setClock] = useState("");
  const [dateStr, setDateStr] = useState("");
  const contextBySlot = useRef<Record<string, number>>({});
  const memPeak = useRef(1);
  const tokPeak = useRef(1);
  const ctxPeak = useRef(1);
  const [blindsOpen, setBlindsOpen] = useState(false);
  const [blindsTab, setBlindsTab] = useState<"prompts">("prompts");
  const blindsTabRef = useRef<HTMLButtonElement>(null);

  /** Roll the blind up and hand focus back to the tab that unrolled it. */
  const closeBlinds = () => {
    setBlindsOpen(false);
    blindsTabRef.current?.focus();
  };

  // Esc rolls the blinds back up: the drawer is a full-width overlay, so the
  // keyboard needs a way out that does not require hunting for the pull rail.
  useEffect(() => {
    if (!blindsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setBlindsOpen(false);
      blindsTabRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [blindsOpen]);

  // live clock + date (1s tick)
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      setClock(
        d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      );
      setDateStr(
        d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      );
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  // system metrics: memory + proxy tokens
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const sys = await window.lopster?.getSystemMetrics?.();
        if (cancelled || !sys?.ok) return;
        const memBytes = sys.workingSetBytes || sys.rss || sys.heapUsed || 0;
        setMemoryLabel(formatBytes(memBytes));
        const mb = memBytes / (1024 * 1024);
        if (mb > memPeak.current) memPeak.current = mb;
        setMemoryRatio(mb / memPeak.current);
      } catch {
        /* ignore */
      }

      try {
        const usage = await window.lopster?.proxyGetUsageStats?.();
        if (cancelled) return;
        const total = usage?.ok && usage.usage?.totals?.totalTokens ? Number(usage.usage.totals.totalTokens) : 0;
        setTokensLabel(formatTokenCount(total));
        if (total > tokPeak.current) tokPeak.current = total;
        setTokensRatio(total / tokPeak.current);
      } catch {
        /* ignore */
      }
    };

    void refresh();
    const id = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // live chat context (all MultiIDE slots)
  useEffect(() => {
    const onContext = (event: Event) => {
      const detail = (event as CustomEvent<ContextMetricsDetail>).detail;
      if (!detail || typeof detail.slotId !== "string") return;
      const tokens = Math.max(0, Number(detail.tokens) || 0);
      contextBySlot.current[detail.slotId] = tokens;
      const total = Object.values(contextBySlot.current).reduce((a, b) => a + b, 0);
      setContextLabel(formatTokenCount(total));
      if (total > ctxPeak.current) ctxPeak.current = total;
      setContextRatio(total / ctxPeak.current);
    };
    window.addEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
    return () => window.removeEventListener(CONTEXT_METRICS_EVENT, onContext as EventListener);
  }, []);

  const tabs: Array<{ id: Panel; title: string; icon: React.ReactNode }> = [
    { id: "multiide", title: labels?.multiIde || "MultiIDE", icon: <IcoMulti className="topbar-tab-ico" /> },
    { id: "webengine", title: "Web Engine", icon: <IcoWebEngine className="topbar-tab-ico" /> },
    { id: "proxy", title: labels?.proxy || "Proxy", icon: <IcoProxy className="topbar-tab-ico" /> },
    { id: "runner", title: "Runner", icon: <IcoRunner className="topbar-tab-ico" /> },
    { id: "terminal", title: "Terminal", icon: <IcoTerminal className="topbar-tab-ico" /> },
    { id: "knowledge", title: "Knowledge", icon: <IcoKnowledge className="topbar-tab-ico" /> },
    { id: "docs", title: "Docs", icon: <IcoDocs className="topbar-tab-ico" /> },
    { id: "usage", title: "Usage", icon: <IcoUsage className="topbar-tab-ico" /> },
    { id: "customtools", title: "Plugin", icon: <IcoTools className="topbar-tab-ico" /> },
  ];

  return (
    <div className="titlebar-root">
      {/* Шторы (blinds) — a low tab that hangs off the bottom edge of the bar.
          It rolls the drawer down like a real roller blind (see .blinds-roll). */}
      <button
        ref={blindsTabRef}
        type="button"
        id="titlebar-blinds-tab"
        title="Шторы — Prompts и будущие вкладки"
        aria-label={blindsOpen ? "Свернуть шторы" : "Развернуть шторы"}
        aria-expanded={blindsOpen}
        aria-controls="titlebar-blinds"
        onClick={() => setBlindsOpen((v) => !v)}
        className={`titlebar-blinds-tab ${blindsOpen ? "is-open" : ""}`}
      >
        <span className="titlebar-blinds-grip" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="titlebar-blinds-tab-label">ШТОРЫ</span>
        <ChevronDown className="titlebar-blinds-caret" aria-hidden />
      </button>

      <nav className="topbar-tabs" aria-label="Workspace panels">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            title={tab.title}
            onClick={() => onSelect(tab.id)}
            className={`topbar-tab ${active === tab.id ? "is-active" : ""}`}
          >
            {tab.icon}
            <span className="topbar-tab-label">{tab.title}</span>
          </button>
        ))}
        <span className="topbar-tab-sep" />
        <button
          type="button"
          title={labels?.providers || "Providers"}
          onClick={onOpenProviders}
          className="topbar-tab topbar-tab-icon"
        >
          <IcoProviders className="topbar-tab-ico" />
        </button>
        <button
          type="button"
          title={labels?.settings || "Settings"}
          onClick={() => onSelect("settings")}
          className={`topbar-tab topbar-tab-icon ${active === "settings" ? "is-active" : ""}`}
        >
          <IcoSettings className="topbar-tab-ico" />
        </button>
      </nav>

      <div className="titlebar-spacer" />

      <div className="topbar-metrics">
        <div className="topbar-wave-group" title="App process memory">
          <Wave ratio={memoryRatio} />
          <div className="topbar-wave-copy">
            <span className="topbar-wave-value">{memoryLabel}</span>
            <span className="topbar-wave-label">MEM</span>
          </div>
        </div>

        <div className="topbar-wave-group" title="Proxy usage total tokens">
          <Wave ratio={tokensRatio} />
          <div className="topbar-wave-copy">
            <span className="topbar-wave-value">{tokensLabel}</span>
            <span className="topbar-wave-label">TOK</span>
          </div>
        </div>

        <div className="topbar-wave-group" title="Current chat context (all MultiIDE slots)">
          <Wave ratio={contextRatio} />
          <div className="topbar-wave-copy">
            <span className="topbar-wave-value">{contextLabel}</span>
            <span className="topbar-wave-label">CTX</span>
          </div>
        </div>

        <div className="topbar-clock">
          <span className="topbar-clock-time">{clock}</span>
          <span className="topbar-clock-date">{dateStr}</span>
        </div>
      </div>

      <div className="titlebar-controls">
        <UpdateBadge />
        <button
          type="button"
          onClick={() => window.lopster?.minimize()}
          className="titlebar-btn"
          aria-label="Minimize"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => window.lopster?.toggleMaximize()}
          className="titlebar-btn"
          aria-label="Maximize"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => window.lopster?.close()}
          className="titlebar-btn titlebar-btn-close"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── ШТОРЫ (blinds) drawer ──────────────────────────────────────────
          The drawer is clipped to zero at the top and unrolls downward; the
          roller bar rides the leading edge and settles as the pull rail that
          rolls it back up. Tabs register here — each one is a
          <button className="blinds-tab"> in the head, its workspace renders in
          the body. "Prompts" is the first tab. */}
      <div
        id="titlebar-blinds"
        className={`titlebar-blinds-panel ${blindsOpen ? "is-open" : ""}`}
        aria-hidden={!blindsOpen}
      >
        {/* Roller: travels with the reveal, then doubles as the close handle. */}
        <button
          type="button"
          className="blinds-roll"
          onClick={closeBlinds}
          title="Свернуть шторы"
          aria-label="Свернуть шторы"
          tabIndex={blindsOpen ? 0 : -1}
        >
          <span className="blinds-roll-grip" aria-hidden>
            <i />
            <i />
            <i />
            <i />
          </span>
        </button>
        <div className="blinds-panel-head">
          <span className="titlebar-blinds-panel-title">ШТОРЫ</span>
          <button
            type="button"
            className={`blinds-tab${blindsTab === "prompts" ? " is-active" : ""}`}
            onClick={() => setBlindsTab("prompts")}
            aria-pressed={blindsTab === "prompts"}
          >
            <IcoPrompts className="blinds-tab-ico" />
            <span>Prompts</span>
          </button>
        </div>
        <div className="blinds-panel-body">
          {blindsTab === "prompts" && <PromptsWorkspace />}
        </div>
      </div>
    </div>
  );
};

export default TitleBar;
