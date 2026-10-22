import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Copy,
  Play,
  Square,
  Plus,
  Trash2,
  Radio,
  RefreshCw,
  Settings2,
  ExternalLink,
  Loader2,
  ChevronLeft,
  Star,
  Search,
  Unlock,
  Lock,
  Activity,
  BarChart3,
  X,
} from "lucide-react";
import type { Translation } from "../i18n";
import LocalAgentMcpPanel from "./LocalAgentMcpPanel";

const PROVIDER_FAVORITES_KEY = "lopster.proxy.providerFavorites";

function loadProviderFavorites(): string[] {
  try {
    const raw = window.localStorage.getItem(PROVIDER_FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveProviderFavorites(ids: string[]) {
  try {
    window.localStorage.setItem(PROVIDER_FAVORITES_KEY, JSON.stringify(ids));
  } catch {
    /* */
  }
}

type DetailPane = "accounts" | "models";
type MainView = "providers" | "usage" | "settings";
type ProxyPopupView = "usage" | "settings";
type ProxyCtxMenu = { x: number; y: number; view: ProxyPopupView } | null;

type UsageBucket = {
  requests?: string;
  promptTokens?: string;
  completionTokens?: string;
  totalTokens?: string;
  reasoningTokens?: string;
  cacheReadTokens?: string;
  cacheCreationTokens?: string;
  streamRequests?: string;
  jsonRequests?: string;
  errorRequests?: string;
};

type UsageModelRow = UsageBucket & { id: string };
type UsageProviderRow = UsageBucket & { id: string };

type ProxyUsageStats = {
  totals?: UsageBucket;
  models?: UsageModelRow[];
  providers?: UsageProviderRow[];
  modelCount?: number;
  providerCount?: number;
  updatedAt?: number;
  createdAt?: number;
};

type QuotaWindow = {
  name?: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: string | null;
  used?: number;
  total?: number;
};

type AccountUsage = {
  plan?: string;
  limitReached?: boolean;
  quotas?: Record<string, QuotaWindow>;
  note?: string;
  balance?: number;
  remaining?: number;
  unit?: string;
  balanceOnly?: boolean;
  detail?: {
    email?: string | null;
    usageRecords?: number;
    totalTokens?: number;
    costUsdMicros?: number;
    userId?: string;
    balances?: Array<{
      currency?: string;
      remaining?: number;
    }>;
  };
};

type RoutingState = {
  status?: string;
  blockedUntil?: number | null;
  lastError?: string | null;
  available?: boolean;
};

type ProxyAccount = {
  id: string;
  providerId: string;
  authType: string;
  name: string;
  email?: string | null;
  planType?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  enabled: boolean;
  hasCredentials: boolean;
  apiKeyMasked?: string;
  baseUrl?: string;
  usage?: AccountUsage | null;
  usageError?: string | null;
  usageUpdatedAt?: number | null;
  routing?: RoutingState | null;
  priority?: number | null;
  createdAt?: number | null;
};

type ProxyKey = {
  id: string;
  label: string;
  key: string;
  masked: string;
  enabled: boolean;
};

type NgrokConfig = {
  enabled: boolean;
  authtoken: string;
  authtokenMasked?: string;
  hasAuthtoken?: boolean;
  domain: string;
  region: string;
};

type NgrokStatus = {
  enabled?: boolean;
  running?: boolean;
  url?: string | null;
  publicBaseUrl?: string | null;
  error?: string | null;
  domain?: string;
  region?: string;
  hasAuthtoken?: boolean;
};

type ProxyConfig = {
  host: string;
  port: number;
  baseUrl: string;
  keys: ProxyKey[];
  accounts: ProxyAccount[];
  customProviders?: Array<{
    id: string;
    name: string;
    baseUrl: string;
    modelTag?: string;
    description?: string;
    createdAt?: number | null;
  }>;
  ngrok?: NgrokConfig;
};

type ProviderMeta = {
  id: string;
  name: string;
  wireFormat: string;
  defaultBaseUrl: string;
  description?: string;
  supportsOauth?: boolean;
  supportsApiKey?: boolean;
  supportsCliImport?: boolean;
  modelTag?: string;
  alias?: string;
  consoleUrl?: string | null;
  custom?: boolean;
  isCustom?: boolean;
};

type ModelRow = {
  id: string;
  bareId?: string;
  taggedId?: string;
  name?: string;
  owned_by?: string;
  kind?: string;
  created?: number | null;
  source?: string;
  providerId?: string;
};

type LogEntry = { ts: number; level: string; msg: string; model?: string };

type OauthUi = {
  sessionId: string;
  userCode: string | null;
  verificationUri: string;
  status: string;
  error?: string | null;
  needsPasteCode?: boolean;
  providerId?: string;
  authorizeUrl?: string | null;
} | null;

function formatReset(iso?: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** Format huge token/request counters (supports trillions+ via digit strings). */
function formatBigCount(value?: string | number | null, compact = false): string {
  if (value == null || value === "") return "0";
  let s = String(value).trim().replace(/[,_\s]/g, "");
  if (!s) return "0";
  if (!/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return "0";
    s = String(Math.trunc(n));
  }
  s = s.replace(/^0+(?=\d)/, "") || "0";
  if (!compact || s.length <= 4) {
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  const units: { suffix: string; digits: number }[] = [
    { suffix: "T", digits: 12 },
    { suffix: "B", digits: 9 },
    { suffix: "M", digits: 6 },
    { suffix: "K", digits: 3 },
  ];
  for (const u of units) {
    if (s.length > u.digits) {
      const whole = s.slice(0, s.length - u.digits);
      const frac = s.slice(s.length - u.digits, s.length - u.digits + 2);
      const trimmed = frac.replace(/0+$/, "");
      return trimmed ? `${whole}.${trimmed}${u.suffix}` : `${whole}${u.suffix}`;
    }
  }
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatUsageTime(ts?: number | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** Compare two digit-strings (or numbers) as magnitude for bar widths — BigInt-safe via prefix. */
function digitSharePct(value?: string | number | null, maxDigits?: string | null): number {
  const t = String(value ?? "0").replace(/\D/g, "") || "0";
  const m = String(maxDigits ?? "0").replace(/\D/g, "") || "0";
  if (t === "0" || m === "0") return 0;
  const maxLen = Math.max(t.length, m.length);
  const a = Number(t.padStart(maxLen, "0").slice(0, 10));
  const b = Number(m.padStart(maxLen, "0").slice(0, 10));
  if (!b) return 0;
  return Math.max(2, Math.min(100, Math.round((a / b) * 100)));
}

function digitMagnitude(value?: string | number | null): number {
  const t = String(value ?? "0").replace(/\D/g, "") || "0";
  if (t === "0") return 0;
  const head = Number(t.slice(0, 12));
  return Number.isFinite(head) ? head : 0;
}

/** Horizontal share bar — theme-token colors only. */
function UsageBar({
  pct,
  color = "var(--accent)",
  height = 6,
  track = "var(--hover-bg)",
  className = "",
}: {
  pct: number;
  color?: string;
  height?: number;
  track?: string;
  className?: string;
}) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div
      className={`w-full rounded-full overflow-hidden ${className}`}
      style={{ height, background: track }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300 ease-out"
        style={{
          width: `${w}%`,
          background: color,
          boxShadow: w > 0 ? `0 0 10px color-mix(in srgb, ${color} 35%, transparent)` : undefined,
        }}
      />
    </div>
  );
}

/** Vertical bar column for model ranking chart. */
function UsageColBar({
  pct,
  color = "var(--accent)",
  label,
  value,
  title,
}: {
  pct: number;
  color?: string;
  label: string;
  value: string;
  title?: string;
}) {
  const h = Math.max(pct > 0 ? 6 : 0, Math.min(100, pct));
  return (
    <div className="flex flex-col items-center min-w-0 flex-1 h-full" title={title || label}>
      <div
        className="text-[9px] font-mono tabular-nums leading-none whitespace-nowrap px-0.5"
        style={{ color: "var(--text-muted)" }}
      >
        {value}
      </div>
      <div className="relative w-full flex-1 min-h-[60px] flex items-end justify-center my-0.5">
        <div
          className="w-full max-w-[28px] min-w-[6px] rounded-t-sm transition-[height] duration-300 ease-out"
          style={{
            height: `${h}%`,
            background: `linear-gradient(180deg, ${color} 0%, color-mix(in srgb, ${color} 50%, transparent) 100%)`,
          }}
        />
      </div>
      <div
        className="text-[8px] font-mono whitespace-nowrap max-w-full text-center leading-tight px-0.5 overflow-hidden text-ellipsis"
        style={{ color: "var(--text-dim)" }}
        title={label}
      >
        {label.length > 10 ? `${label.slice(0, 8)}..` : label}
      </div>
    </div>
  );
}

/** Provider brand icons (OmniRoute assets + Grok/X + Antigravity) */
const PROVIDER_ICONS: Record<string, string> = {
  openai: "./logo/providers/openai.png",
  openrouter: "./logo/providers/openrouter.svg",
  zai: "./logo/providers/zai.svg",
  deepseek: "./logo/providers/deepseek.svg",
  grok: "./logo/providers/grok.svg",
  antigravity: "./logo/providers/antigravity.svg",
  "gemini-cli": "./logo/providers/gemini-cli.svg",
  "google-ai-studio": "./logo/providers/google-ai-studio.svg",
  "claude-code": "./logo/providers/claude-code.svg",
  anthropic: "./logo/providers/anthropic.svg",
  perplexity: "./logo/providers/perplexity.svg",
  nous: "./logo/providers/nous.svg",
  kiro: "./logo/providers/kiro.svg",
  "github-copilot": "./logo/providers/github-copilot.svg",
  windsurf: "./logo/providers/windsurf.svg",
  cursor: "./logo/providers/cursor.svg",
  codebuddy: "./logo/providers/codebuddy.svg",
  "codebuddy-cn": "./logo/providers/codebuddy-cn.svg",
  qoder: "./logo/providers/qoder.svg",
  qauth: "./logo/providers/cline.svg",
  "opencode-go": "./logo/providers/opencode-go.svg",
  opencode: "./logo/providers/opencode.svg",
};

function ProviderIcon({
  id,
  name,
  size = 28,
  className = "",
  custom = false,
}: {
  id: string;
  name?: string;
  size?: number;
  className?: string;
  custom?: boolean;
}) {
  const brandTone = ["kiro", "perplexity", "antigravity", "gemini-cli"].includes(id)
    ? `proxy-brand-${id}`
    : "";

  // User-defined providers always use the shared "Custom" badge (name shown next to it)
  if (custom) {
    return (
      <div
        className={`proxy-provider-icon proxy-provider-icon-custom text-ink-800 ${className}`}
        style={{
          width: size,
          height: size,
        }}
        title={name || "Custom"}
      >
        <svg width={Math.max(16, size * 0.52)} height={Math.max(16, size * 0.52)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M8.5 8.5h7v7h-7z" stroke="currentColor" strokeWidth="1.7" />
          <path d="M5 5h3.5M15.5 5H19M5 19h3.5M15.5 19H19M5 5v3.5M19 5v3.5M5 15.5V19M19 15.5V19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </div>
    );
  }
  if (id === "opencode" || id === "opencode-go") {
    return (
      <div
        className={`proxy-provider-icon text-ink-800 ${className}`}
        style={{ width: size, height: size }}
        title={name || id}
      >
        <svg width={Math.max(18, size * 0.62)} height={Math.max(18, size * 0.62)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          {id === "opencode" ? (
            <path d="M8.4 17.4h10.8V21H4.8v-7.2h3.6v3.6Zm7.2-7.2v3.6H8.4v-3.6h7.2Zm3.6 0h-3.6V6.6H4.8V3h14.4v7.2Z" fill="currentColor" />
          ) : (
            <path d="M19.4 21H5V3h14.4v3.6H8.6v10.8h7.2v-3.6h-3.6v-3.6h7.2V21Z" fill="currentColor" />
          )}
        </svg>
      </div>
    );
  }
  const src = PROVIDER_ICONS[id];
  if (src) {
    return (
      <img
        src={src}
        alt={name || id}
        width={size}
        height={size}
        className={`proxy-provider-logo rounded-md object-contain flex-shrink-0 ${brandTone} ${className}`}
        draggable={false}
      />
    );
  }
  const letter = (name || id || "?").slice(0, 2).toUpperCase();
  return (
    <div
      className={`rounded-md bg-ink-100 text-ink-700 grid place-items-center font-medium flex-shrink-0 ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
    >
      {letter}
    </div>
  );
}

function BalanceCell({ usage }: { usage?: AccountUsage | null }) {
  const balances = Array.isArray(usage?.detail?.balances)
    ? usage.detail.balances
        .map((item) => ({
          currency: String(item?.currency || "").trim().toUpperCase(),
          remaining: Number(item?.remaining),
        }))
        .filter((item) => item.currency && Number.isFinite(item.remaining))
    : [];
  const fallback = Number(usage?.remaining ?? usage?.balance);
  const rows = balances.length
    ? balances
    : Number.isFinite(fallback)
      ? [{ currency: usage?.unit || "USD", remaining: fallback }]
      : [];
  if (!rows.length) return <span className="text-ink-500">—</span>;
  const title = rows.map((item) => `${item.currency} ${item.remaining.toFixed(5)}`).join(" · ");
  return (
    <div className="min-w-[7rem] font-mono" title={title}>
      {rows.map((item) => {
        const color =
          item.remaining <= 0
            ? "text-status-err"
            : item.remaining < 1
              ? "text-status-warn"
              : "text-ink-800";
        return (
          <div key={item.currency} className="whitespace-nowrap">
            <span className={`text-[12px] ${color}`}>{item.remaining.toLocaleString()}</span>
            <span className="ml-1 text-[9px] text-ink-500">{item.currency}</span>
          </div>
        );
      })}
    </div>
  );
}

function compactCount(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function QuotaCell({ q }: { q?: QuotaWindow | null }) {
  if (!q) return <span className="text-ink-500">—</span>;
  const pct = Math.min(100, Math.max(0, q.usedPercent));
  const color =
    pct >= 90 ? "bg-status-err" : pct >= 70 ? "bg-status-warn" : "bg-ink-600";
  const detail =
    q.used != null && q.total != null
      ? `${compactCount(q.used)}/${compactCount(q.total)}`
      : `${Math.round(pct)}%`;
  const label =
    q.name === "monthly"
      ? "mo"
      : q.name === "daily"
        ? "24h"
        : q.name === "supergrok"
          ? "wk"
        : q.name === "weekly"
          ? "wk"
          : q.name === "credits"
            ? "cr"
            : q.name === "on_demand"
              ? "od"
              : q.name === "agentic_request"
                ? "ag"
                : q.name === "session" || q.name === "session_5h"
                  ? "5h"
                  : q.name
                    ? String(q.name).slice(0, 3)
                    : "";
  return (
    <div className="min-w-[7rem] space-y-0.5" title={q.name ? `${q.name} · ${detail}` : detail}>
      <div className="flex justify-between text-[9px] text-ink-500 font-mono">
        <span>
          {label ? `${label} ` : ""}
          {detail}
        </span>
        <span className="text-ink-500/80">{formatReset(q.resetAt)}</span>
      </div>
      <div className="h-1 rounded-full bg-ink-200 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** UI Usage column: Codex session, Claude primary/session_5h, Kiro session/agentic_request */
function pickUsageQuota(usage?: AccountUsage | null): QuotaWindow | null {
  const q = usage?.quotas;
  if (!q || typeof q !== "object") return null;
  return (
    q.daily ||
    q.session ||
    q.primary ||
    q.session_5h ||
    q.agentic_request ||
    q.credit ||
    null
  );
}

/** UI Weekly column: weekly / secondary / free-trial mirror */
function pickWeeklyQuota(usage?: AccountUsage | null): QuotaWindow | null {
  const q = usage?.quotas;
  if (!q || typeof q !== "object") return null;
  return (
    q.weekly ||
    q.secondary ||
    q.supergrok ||
    q.agentic_request_freetrial ||
    q.credit_freetrial ||
    null
  );
}

const pxBtn = "proxy-action";
const pxGhost = "proxy-action proxy-action-ghost";
const pxQuiet = "proxy-action proxy-action-quiet";
const pxSolid = "proxy-action theme-primary";
const pxSeg = "proxy-seg";
const pxInput =
  "h-7 px-2.5 rounded-none theme-input text-[11px] outline-none placeholder:text-ink-500";
const pxHairline = "theme-hairline";

const ProxyWorkspace: React.FC<{
  labels?: Translation;
  popupView?: ProxyPopupView | null;
}> = ({ labels, popupView }) => {
  const L = labels;
  const isPopup = popupView === "usage" || popupView === "settings";
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [detailPane, setDetailPane] = useState<DetailPane>("accounts");
  const [mainView, setMainView] = useState<MainView>(popupView || "providers");
  const [ctxMenu, setCtxMenu] = useState<ProxyCtxMenu>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxMenu]);

  const [config, setConfig] = useState<ProxyConfig | null>(null);
  const [running, setRunning] = useState(false);
  const [statusBase, setStatusBase] = useState("");
  const [port, setPort] = useState(8787);
  const [host, setHost] = useState("127.0.0.1");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const clearLogs = useCallback(() => setLogs([]), []);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [oauth, setOauth] = useState<OauthUi>(null);
  const [usageStats, setUsageStats] = useState<ProxyUsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);

  // ngrok public tunnel (persisted in proxy store)
  const [ngrokEnabled, setNgrokEnabled] = useState(false);
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokDomain, setNgrokDomain] = useState("");
  const [ngrokRegion, setNgrokRegion] = useState("");
  const [ngrokStatus, setNgrokStatus] = useState<NgrokStatus | null>(null);
  const [ngrokSaving, setNgrokSaving] = useState(false);

  const [apiKey, setApiKey] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [showApiForm, setShowApiForm] = useState(false);
  const [grokTxtInput, setGrokTxtInput] = useState("");
  const [codexTxtInput, setCodexTxtInput] = useState("");
  const [claudeCodePaste, setClaudeCodePaste] = useState("");
  const [claudeJsonInput, setClaudeJsonInput] = useState("");
  const [claudeTokenInput, setClaudeTokenInput] = useState("");
  const [kiroTokenInput, setKiroTokenInput] = useState("");
  const [oauthTokenInput, setOauthTokenInput] = useState("");

  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelsSource, setModelsSource] = useState<string>("");
  const [modelsWarning, setModelsWarning] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modelsAccountId, setModelsAccountId] = useState<string>("");
  const [newModelId, setNewModelId] = useState("");

  // Add custom OpenAI-compatible provider (name + endpoint + models)
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customModelsText, setCustomModelsText] = useState("");

  // Reveal/hide proxy client keys in Settings
  const [showKeys, setShowKeys] = useState(false);

  const [providerQuery, setProviderQuery] = useState("");
  const [providerFavorites, setProviderFavorites] = useState<string[]>(() =>
    typeof window !== "undefined" ? loadProviderFavorites() : []
  );

  const applyNgrokFromConfig = (cfg: ProxyConfig | null | undefined, status?: any) => {
    const n = cfg?.ngrok;
    if (n) {
      setNgrokEnabled(Boolean(n.enabled));
      setNgrokToken(n.authtoken || "");
      setNgrokDomain(n.domain || "");
      setNgrokRegion(n.region || "");
    }
    if (status?.ngrok) {
      setNgrokStatus(status.ngrok as NgrokStatus);
    }
  };

  const loadUsageStats = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await window.lopster?.proxyGetUsageStats?.();
      if (res?.ok && res.usage) setUsageStats(res.usage as ProxyUsageStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const resetUsageStats = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyResetUsageStats?.();
      if (res?.ok) setUsageStats((res.usage as ProxyUsageStats) || null);
      else if (res?.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const res = await window.lopster?.proxyGetConfig?.();
      if (res?.ok && res.config) {
        setConfig(res.config as ProxyConfig);
        setPort(res.config.port);
        setHost(res.config.host);
        setRunning(Boolean(res.status?.running));
        setStatusBase(res.status?.baseUrl || res.config.baseUrl);
        applyNgrokFromConfig(res.config as ProxyConfig, res.status);
      }
      const st = await window.lopster?.proxyStatus?.();
      if (st?.ok) {
        setRunning(Boolean(st.status?.running));
        if (st.status?.baseUrl) setStatusBase(st.status.baseUrl);
        if (st.status?.ngrok) setNgrokStatus(st.status.ngrok as NgrokStatus);
        if (st.logs) setLogs(st.logs as LogEntry[]);
      }
      const pr = await window.lopster?.proxyListProviders?.();
      if (pr?.ok && pr.providers) setProviders(pr.providers as ProviderMeta[]);
      void loadUsageStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadUsageStats]);

  const applyModelsResult = (res: {
    ok?: boolean;
    models?: ModelRow[];
    source?: string;
    warning?: string;
    error?: string;
  }) => {
    if (res?.ok) {
      setModels((res.models || []) as ModelRow[]);
      setModelsSource(res.source || "");
      setModelsWarning(res.warning || null);
    } else {
      setModelsWarning(res?.error || "Failed to load models");
    }
  };

  const loadModels = useCallback(async (providerId: string, accountId?: string) => {
    setModelsLoading(true);
    setModelsWarning(null);
    try {
      const res = await window.lopster?.proxyListModels?.({
        providerId,
        accountId: accountId || null,
        chatOnly: true,
        refreshLive: true,
      });
      applyModelsResult(res || {});
      if (!res?.ok) setModels([]);
    } catch (e) {
      setModels([]);
      setModelsWarning(e instanceof Error ? e.message : String(e));
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const addModelManual = async () => {
    if (!selectedProviderId || !newModelId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Allow multi-add: newline / comma / semicolon separated
      const ids = newModelId
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ids.length) return;
      let last: any = null;
      const errors: string[] = [];
      for (const id of ids) {
        const res = await window.lopster?.proxyAddModel?.({
          providerId: selectedProviderId,
          id,
        });
        if (!res?.ok) errors.push(`${id}: ${res?.error || "add failed"}`);
        else last = res;
      }
      if (last) applyModelsResult(last);
      else if (errors.length) throw new Error(errors[0]);
      // Reload list so multi-add all show up
      if (ids.length > 1) {
        void loadModels(selectedProviderId, modelsAccountId || undefined);
      }
      setNewModelId("");
      if (errors.length && last) setError(`Some models failed: ${errors.join("; ")}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importSingleModel = async (id: string) => {
    if (!selectedProviderId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyAddModel?.({
        providerId: selectedProviderId,
        id,
      });
      if (res?.ok) {
        applyModelsResult(res);
        setError(`Added ${id} to provider settings`);
      } else if (res?.error) {
        setError(res.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closeCustomModal = () => {
    setShowCustomForm(false);
    setCustomName("");
    setCustomEndpoint("");
    setCustomModelsText("");
  };

  const addCustomProvider = async () => {
    const name = customName.trim();
    const endpoint = customEndpoint.trim();
    if (!name || !endpoint) {
      setError("Name and endpoint are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyAddCustomProvider?.({
        name,
        baseUrl: endpoint,
        models: customModelsText,
      });
      if (!res?.ok) throw new Error(res?.error || "failed to add custom provider");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (res.providers) setProviders(res.providers as ProviderMeta[]);
      else {
        const pr = await window.lopster?.proxyListProviders?.();
        if (pr?.ok && pr.providers) setProviders(pr.providers as ProviderMeta[]);
      }
      closeCustomModal();
      if (res.providerId) openProvider(res.providerId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteCustomProvider = async (providerId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyDeleteCustomProvider?.(providerId);
      if (!res?.ok) throw new Error(res?.error || "delete failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (res.providers) setProviders(res.providers as ProviderMeta[]);
      else {
        const pr = await window.lopster?.proxyListProviders?.();
        if (pr?.ok && pr.providers) setProviders(pr.providers as ProviderMeta[]);
      }
      if (selectedProviderId === providerId) setSelectedProviderId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeModelManual = async (id: string) => {
    if (!selectedProviderId) return;
    const res = await window.lopster?.proxyRemoveModel?.({
      providerId: selectedProviderId,
      id,
    });
    if (res?.ok) applyModelsResult(res);
    else if (res?.error) setError(res.error);
  };

  useEffect(() => {
    void refresh();
    const offs = [
      window.lopster?.onProxyLog?.((payload: any) => {
        // Preload hands us either a single {entry} or a batched {batch: LogEntry[]}.
        const incoming: LogEntry[] = Array.isArray(payload?.batch)
          ? payload.batch
          : payload && "entry" in payload
            ? [payload.entry]
            : [payload];
        if (!incoming.length) return;
        setLogs((prev) => {
          const next = prev.length + incoming.length <= 200
            ? [...prev, ...incoming]
            : [...incoming, ...prev].slice(-200);
          return next;
        });
      }),
      window.lopster?.onProxyOauth?.((payload: any) => {
        if (payload?.status === "done") {
          setOauth(null);
          if (payload.config) setConfig(payload.config as ProxyConfig);
          else void refresh();
          if (payload.warning) setError(payload.warning);
        } else if (payload?.status === "error") {
          setOauth((o) =>
            o && o.sessionId === payload.sessionId
              ? { ...o, status: "error", error: payload.error }
              : o
          );
          setError(payload.error || "OAuth failed");
        }
      }),
      window.lopster?.onProxyConfig?.((payload: any) => {
        if (payload?.config) setConfig(payload.config as ProxyConfig);
      }),
      window.lopster?.onProxyUsage?.((payload: any) => {
        if (payload && typeof payload === "object") {
          setUsageStats(payload as ProxyUsageStats);
        }
      }),
    ];
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void window.lopster?.proxyRefreshUsage?.(null).then((r) => {
          if (r?.ok && r.config) setConfig(r.config as ProxyConfig);
        });
        // Soft-poll usage so numbers stay fresh even if a live event was missed
        void window.lopster?.proxyGetUsageStats?.().then((r) => {
          if (r?.ok && r.usage) setUsageStats(r.usage as ProxyUsageStats);
        });
      }
    }, 5 * 60 * 1000);
    return () => {
      offs.forEach((off) => off?.());
      window.clearInterval(t);
    };
  }, [refresh]);

  useEffect(() => {
    if (!oauth?.sessionId || oauth.status === "done" || oauth.status === "error") return;
    const t = window.setInterval(async () => {
      const st = await window.lopster?.proxyOauthStatus?.(oauth.sessionId);
      if (!st?.ok) return;
      setOauth((o) =>
        o
          ? {
              ...o,
              status: st.status || o.status,
              userCode: st.userCode ?? o.userCode,
              verificationUri: st.verificationUri || o.verificationUri,
              error: st.error,
            }
          : o
      );
      if (st.status === "done") {
        setOauth(null);
        void refresh();
      }
    }, 1200);
    return () => window.clearInterval(t);
  }, [oauth?.sessionId, oauth?.status, refresh]);

  // Load models when opening provider detail / models pane
  useEffect(() => {
    if (selectedProviderId && detailPane === "models") {
      void loadModels(selectedProviderId, modelsAccountId || undefined);
    }
  }, [selectedProviderId, detailPane, modelsAccountId, loadModels]);

  useEffect(() => {
    if (selectedProviderId && modelsAccountId && detailPane !== "models") {
      void loadModels(selectedProviderId, modelsAccountId);
    }
  }, [selectedProviderId, modelsAccountId, detailPane, loadModels]);

  const providerAccounts = useMemo(() => {
    if (!selectedProviderId) return [];
    return (config?.accounts || []).filter((a) => a.providerId === selectedProviderId);
  }, [config?.accounts, selectedProviderId]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId) || null;

  const toggleProviderFavorite = useCallback((providerId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    e?.preventDefault();
    setProviderFavorites((prev) => {
      const next = prev.includes(providerId)
        ? prev.filter((id) => id !== providerId)
        : [...prev, providerId];
      saveProviderFavorites(next);
      return next;
    });
  }, []);

  /** Favorites first (stable order of starring), then the rest A–Z; search filters both. */
  const displayProviders = useMemo(() => {
    const q = providerQuery.trim().toLowerCase();
    const favSet = new Set(providerFavorites);
    const filtered = providers.filter((p) => {
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.wireFormat || "").toLowerCase().includes(q) ||
        (p.description || "").toLowerCase().includes(q) ||
        (p.defaultBaseUrl || "").toLowerCase().includes(q) ||
        (p.modelTag || "").toLowerCase().includes(q) ||
        (p.alias || "").toLowerCase().includes(q)
      );
    });
    const favOrder = new Map(providerFavorites.map((id, i) => [id, i]));
    const starred = filtered
      .filter((p) => favSet.has(p.id))
      .sort((a, b) => (favOrder.get(a.id) ?? 0) - (favOrder.get(b.id) ?? 0));
    const rest = filtered
      .filter((p) => !favSet.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...starred, ...rest];
  }, [providers, providerFavorites, providerQuery]);

  const isCustomProvider = useCallback(
    (p: ProviderMeta) => Boolean(p.custom || p.isCustom),
    []
  );

  const customProvidersList = useMemo(
    () => displayProviders.filter((p) => isCustomProvider(p)),
    [displayProviders, isCustomProvider]
  );

  // API and Auth are capabilities, so a built-in provider may appear in both
  // tables when it supports both API keys and OAuth.
  const authProviders = useMemo(
    () => displayProviders.filter((p) => !isCustomProvider(p) && p.supportsOauth),
    [displayProviders, isCustomProvider]
  );
  const apiProviders = useMemo(
    () => displayProviders.filter((p) => !isCustomProvider(p) && p.supportsApiKey !== false),
    [displayProviders, isCustomProvider]
  );

  const renderProviderTable = (
    title: string,
    list: ProviderMeta[],
    custom: boolean,
    emptyText: string
  ) => (
    <section className="proxy-panel flex flex-col min-h-0">
      <div className="proxy-table-header">
        <span>{title}</span>
        <span className="proxy-pill flex-shrink-0">{list.length}</span>
      </div>
      <div className="proxy-table-wrap overflow-x-auto overflow-y-auto overscroll-contain scrollbar-thin">
        <table className="proxy-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Format</th>
              <th>Endpoint</th>
              <th className="text-right">Keys</th>
              <th className="w-9"></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const n = (config?.accounts || []).filter((a) => a.providerId === p.id).length;
              const fav = providerFavorites.includes(p.id);
              return (
                <tr
                  key={p.id}
                  className="cursor-pointer"
                  onClick={() => openProvider(p.id)}
                >
                  <td>
                    <div className="flex items-center gap-2 min-w-0">
                      <ProviderIcon id={p.id} name={p.name} size={20} custom={custom} />
                      <span className="text-[12px] font-medium text-ink-950 truncate">{p.name}</span>
                      {custom ? <span className="text-[9px] text-ink-500">Custom</span> : null}
                    </div>
                  </td>
                  <td className="text-[10px] text-ink-500 font-mono">
                    {p.modelTag || p.wireFormat || "—"}
                  </td>
                  <td>
                    <code className="text-[10px] text-ink-600 font-mono truncate block max-w-[16rem]">
                      {p.defaultBaseUrl.replace(/^https?:\/\//, "")}
                    </code>
                  </td>
                  <td className="text-right">
                    <span className={`proxy-pill ${n > 0 ? "is-ready" : ""}`}>{n}</span>
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      onClick={(e) => toggleProviderFavorite(p.id, e)}
                      className="proxy-header-icon !w-6 !h-6"
                      title={fav ? "Unpin from top" : "Pin to top"}
                      aria-label={fav ? "Unpin provider" : "Pin provider"}
                    >
                      <Star
                        className={`w-3.5 h-3.5 ${
                          fav ? "fill-ink-800 text-ink-800" : "text-ink-500 group-hover:text-ink-700"
                        }`}
                      />
                    </button>
                  </td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="proxy-empty !py-8">{emptyText}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.taggedId || "").toLowerCase().includes(q) ||
        (m.name || "").toLowerCase().includes(q) ||
        (m.kind || "").toLowerCase().includes(q) ||
        (m.owned_by || "").toLowerCase().includes(q)
    );
  }, [models, modelQuery]);

  const copyText = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* */
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Persist local endpoint + ngrok fields before start so tunnel can come up with proxy
      await window.lopster?.proxySaveConfig?.({
        host,
        port,
        ngrok: {
          enabled: ngrokEnabled,
          authtoken: ngrokToken,
          domain: ngrokDomain,
          region: ngrokRegion,
        },
      });
      const res = await window.lopster?.proxyStart?.({ host, port });
      if (!res?.ok) throw new Error(res?.error || "start failed");
      setRunning(true);
      setStatusBase(res.status?.baseUrl || `http://${host}:${port}/v1`);
      if (res.status?.ngrok) setNgrokStatus(res.status.ngrok as NgrokStatus);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await window.lopster?.proxyStop?.();
      setRunning(false);
      setNgrokStatus((prev) =>
        prev
          ? { ...prev, running: false, url: null, publicBaseUrl: null, error: null }
          : prev
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveNgrokSettings = async (patch?: Partial<NgrokConfig>) => {
    setNgrokSaving(true);
    setError(null);
    try {
      const enabled = patch?.enabled != null ? Boolean(patch.enabled) : ngrokEnabled;
      const authtoken = patch?.authtoken != null ? String(patch.authtoken) : ngrokToken;
      const domain = patch?.domain != null ? String(patch.domain) : ngrokDomain;
      const region = patch?.region != null ? String(patch.region) : ngrokRegion;

      setNgrokEnabled(enabled);
      setNgrokToken(authtoken);
      setNgrokDomain(domain);
      setNgrokRegion(region);

      const res = await window.lopster?.proxySaveConfig?.({
        host,
        port,
        ngrok: { enabled, authtoken, domain, region },
      });
      if (!res?.ok) throw new Error(res?.error || "save failed");
      if (res.config) {
        setConfig(res.config as ProxyConfig);
        applyNgrokFromConfig(res.config as ProxyConfig, res.status);
      }
      if (res.status?.ngrok) setNgrokStatus(res.status.ngrok as NgrokStatus);
      if (res.status?.ngrok?.error) {
        setError(`ngrok: ${res.status.ngrok.error}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNgrokSaving(false);
    }
  };

  const openProvider = (id: string) => {
    setMainView("providers");
    setSelectedProviderId(id);
    setDetailPane("accounts");
    setShowApiForm(false);
    setApiKey("");
    setModelQuery("");
    const meta = providers.find((p) => p.id === id);
    setApiBase(meta?.defaultBaseUrl || "");
    const accs = (config?.accounts || []).filter((a) => a.providerId === id);
    setModelsAccountId(accs[0]?.id || "");
  };

  const startOauth = async (providerId: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyOauthStart?.(providerId);
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: res.userCode || null,
        verificationUri: res.verificationUri || "https://auth.openai.com/codex/device",
        status: res.status || "waiting_user",
        error: res.error,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importGrokCli = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportGrokCli?.();
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (selectedProviderId === "grok") {
        void loadModels("grok");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importGrokTxt = async () => {
    const text = grokTxtInput.trim();
    if (!text) {
      setError("Paste a Grok JWT or email:password:JWT TXT line");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportGrokTxt?.({ text });
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setGrokTxtInput("");
      if (selectedProviderId === "grok") {
        void loadModels("grok");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importGrokTxtFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportGrokTxtFile?.();
      if (res?.canceled) return;
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (selectedProviderId === "grok") {
        void loadModels("grok");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importGeminiCli = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportGeminiCli?.();
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (selectedProviderId === "gemini-cli") {
        void loadModels("gemini-cli");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const setGeminiCliProject = async (accountId: string, projectId: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxySetGeminiCliProject?.({
        accountId,
        projectId,
      });
      if (!res?.ok) throw new Error(res?.error || "set project failed");
      if (res.config) setConfig(res.config as ProxyConfig);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startGeminiCliOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyGeminiCliOauthStart?.();
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: null,
        verificationUri: res.authorizeUrl || "https://accounts.google.com",
        status: res.status || "waiting_callback",
        error: res.error,
      });
      if (res.authorizeUrl) {
        void window.lopster?.openExternal?.(res.authorizeUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startClaudeCodeOauth = async () => {
    setError(null);
    setBusy(true);
    setClaudeCodePaste("");
    try {
      const res = await window.lopster?.proxyClaudeCodeOauthStart?.();
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: null,
        verificationUri: res.authorizeUrl || "https://claude.ai/oauth/authorize",
        status: res.status || "waiting_code",
        needsPasteCode: true,
        providerId: "claude-code",
        authorizeUrl: res.authorizeUrl || null,
        error: res.error,
      });
      if (res.authorizeUrl) {
        void window.lopster?.openExternal?.(res.authorizeUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const completeClaudeCodeOauth = async () => {
    if (!oauth?.sessionId) return;
    const code = claudeCodePaste.trim();
    if (!code) {
      setError("Paste authorization code (code#state) from the browser page");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyClaudeCodeOauthComplete?.({
        sessionId: oauth.sessionId,
        code,
      });
      if (!res?.ok) throw new Error(res?.error || "code exchange failed");
      setOauth((o) => (o ? { ...o, status: res.status || "exchanging" } : o));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importClaudeCodeCli = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportClaudeCodeCli?.();
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (selectedProviderId === "claude-code") {
        void loadModels("claude-code");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startKiroOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyKiroOauthStart?.({});
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "Kiro oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: res.userCode || null,
        verificationUri:
          res.verificationUri || res.authorizeUrl || "https://view.awsapps.com/start",
        status: res.status || "waiting_user",
        authorizeUrl: res.authorizeUrl,
        providerId: "kiro",
        error: res.error,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importKiroToken = async () => {
    const text = kiroTokenInput.trim();
    if (!text) {
      setError("Paste a Kiro refresh token");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportKiroToken?.({ refreshToken: text });
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setKiroTokenInput("");
      if (selectedProviderId === "kiro") void loadModels("kiro");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importKiroCli = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportKiroCli?.();
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (selectedProviderId === "kiro") void loadModels("kiro");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importClaudeCodeJson = async () => {
    const text = claudeJsonInput.trim();
    if (!text) {
      setError('Paste Claude credentials JSON ({ "claudeAiOauth": { ... } })');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportClaudeCodeJson?.(text);
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setClaudeJsonInput("");
      if (selectedProviderId === "claude-code") {
        void loadModels("claude-code");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startGrokBrowserOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyGrokOauthStart?.();
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: null,
        verificationUri: res.authorizeUrl || "https://auth.x.ai",
        status: res.status || "waiting_callback",
        error: res.error,
      });
      if (res.authorizeUrl) {
        void window.lopster?.openExternal?.(res.authorizeUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const startAntigravityOauth = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyAntigravityOauthStart?.();
      if (!res?.ok || !res.sessionId) throw new Error(res?.error || "oauth failed");
      setOauth({
        sessionId: res.sessionId,
        userCode: null,
        verificationUri: res.authorizeUrl || "https://accounts.google.com",
        status: res.status || "waiting_callback",
        error: res.error,
      });
      if (res.authorizeUrl) {
        void window.lopster?.openExternal?.(res.authorizeUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelOauth = async () => {
    if (oauth?.sessionId) await window.lopster?.proxyOauthCancel?.(oauth.sessionId);
    setOauth(null);
  };

  const importOauthToken = async () => {
    if (!selectedProviderId || !oauthTokenInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const parts = oauthTokenInput.trim().split(/\s*::\s*/);
      const res = await window.lopster?.proxyImportOauthToken?.({
        providerId: selectedProviderId,
        accessToken: parts[0],
        refreshToken: parts[1] || "",
        baseUrl: selectedProvider?.defaultBaseUrl || "",
        name: selectedProvider?.name || selectedProviderId,
      });
      if (!res?.ok) throw new Error(res?.error || "failed to import account");
      if (res.config) setConfig(res.config as ProxyConfig);
      setOauthTokenInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importCodexTxt = async () => {
    const text = codexTxtInput.trim();
    if (!text) {
      setError("Paste Codex JWT or JWT:refresh lines (email:pass:JWT:refresh also works)");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportOauthTokens?.({
        providerId: "openai",
        text,
      });
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setCodexTxtInput("");
      if (res.failed && res.failed > 0) {
        setError(
          `Imported ${res.added || 0} new, ${res.updated || 0} updated, ${res.failed || 0} failed` +
            (res.errors?.[0]?.error ? ` — ${res.errors[0].error}` : "")
        );
      }
      if (selectedProviderId === "openai") {
        void loadModels("openai");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importCodexTxtFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportOauthTokensFile?.({ providerId: "openai" });
      if (res?.canceled) return;
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      if (res.failed && res.failed > 0) {
        setError(
          `Imported ${res.added || 0} new, ${res.updated || 0} updated, ${res.failed || 0} failed` +
            (res.errors?.[0]?.error ? ` — ${res.errors[0].error}` : "")
        );
      }
      if (selectedProviderId === "openai") {
        void loadModels("openai");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const importClaudeToken = async () => {
    const text = claudeTokenInput.trim();
    if (!text) {
      setError("Paste Claude access:refresh tokens or credentials JSON");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await window.lopster?.proxyImportOauthTokens?.({
        providerId: "claude-code",
        text,
      });
      if (!res?.ok) throw new Error(res?.error || "import failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setClaudeTokenInput("");
      if (res.failed && res.failed > 0) {
        setError(
          `Imported ${res.added || 0} new, ${res.updated || 0} updated, ${res.failed || 0} failed` +
            (res.errors?.[0]?.error ? ` — ${res.errors[0].error}` : "")
        );
      }
      if (selectedProviderId === "claude-code") {
        void loadModels("claude-code");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openProviderLogin = async () => {
    const url = selectedProvider?.consoleUrl || selectedProvider?.defaultBaseUrl;
    if (url) await window.lopster?.openExternal?.(url);
  };

  const addApiKey = async (confirmDuplicate = false) => {
    if (!selectedProviderId || !apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const meta = selectedProvider;
      const res = await window.lopster?.proxyAddApiKeyAccount?.({
        providerId: selectedProviderId,
        apiKey: apiKey.trim(),
        baseUrl: apiBase || meta?.defaultBaseUrl || "",
        name: meta?.name || selectedProviderId,
        confirmDuplicate,
      });
      if (res?.duplicateKey && !confirmDuplicate) {
        const providersText = res.duplicateProviders?.length
          ? ` Провайдеры: ${res.duplicateProviders.join(", ")}.`
          : "";
        if (window.confirm(`Такой API-ключ уже добавлен.${providersText} Уверены, что хотите добавить его еще раз?`)) {
          await addApiKey(true);
        }
        return;
      }
      if (!res?.ok) throw new Error(res?.error || "failed");
      if (res.config) setConfig(res.config as ProxyConfig);
      setShowApiForm(false);
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async (id: string) => {
    const res = await window.lopster?.proxyDeleteAccount?.(id);
    if (res?.ok && res.config) setConfig(res.config as ProxyConfig);
  };

  const refreshUsage = async (id?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyRefreshUsage?.(id || null);
      if (res?.ok && res.config) setConfig(res.config as ProxyConfig);
      else if (res?.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Reload accounts table from disk (proxy store) without restarting the app. */
  const reloadAccountsTable = async () => {
    setBusy(true);
    setError(null);
    try {
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Manual unlock: clear quota / rate-limit routing block (24h auto-wait may be too long). */
  const clearAccountQuota = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.lopster?.proxyClearAccountQuota?.(id);
      if (res?.ok && res.config) setConfig(res.config as ProxyConfig);
      else if (res?.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const baseUrl = statusBase || config?.baseUrl || `http://${host}:${port}/v1`;
  const publicBaseUrl =
    (ngrokStatus?.running && ngrokStatus?.publicBaseUrl) ||
    ngrokStatus?.publicBaseUrl ||
    "";
  const accountCount = (config?.accounts || []).filter((a) => a.providerId === "openai").length;
  const usageTotals = usageStats?.totals || {};
  const usageModels = usageStats?.models || [];
  const usageProviders = usageStats?.providers || [];
  const maxModelTokensDigits = usageModels.reduce((m, row) => {
    const t = String(row.totalTokens || "0").replace(/\D/g, "") || "0";
    return t.length > m.length || (t.length === m.length && t > m) ? t : m;
  }, "0");
  const maxProviderTokensDigits = usageProviders.reduce((m, row) => {
    const t = String(row.totalTokens || "0").replace(/\D/g, "") || "0";
    return t.length > m.length || (t.length === m.length && t > m) ? t : m;
  }, "0");

  const modelSharePct = (totalTokens?: string) => digitSharePct(totalTokens, maxModelTokensDigits);
  const providerSharePct = (totalTokens?: string) => digitSharePct(totalTokens, maxProviderTokensDigits);

  const promptMag = digitMagnitude(usageTotals.promptTokens);
  const completionMag = digitMagnitude(usageTotals.completionTokens);
  const reasoningMag = digitMagnitude(usageTotals.reasoningTokens);
  const tokenComposeTotal = promptMag + completionMag + reasoningMag;
  const streamMag = digitMagnitude(usageTotals.streamRequests);
  const jsonMag = digitMagnitude(usageTotals.jsonRequests);
  const reqComposeTotal = streamMag + jsonMag;
  const chartModels = usageModels.slice(0, 10);
  const hasUsageData =
    digitMagnitude(usageTotals.requests) > 0 ||
    digitMagnitude(usageTotals.totalTokens) > 0 ||
    usageModels.length > 0 ||
    usageProviders.length > 0;

  return (
    <div className="proxy-workspace flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <div className="proxy-header-bar">
        <div
          className={`proxy-status-mark ${running ? "is-live" : ""}`}
          title={running ? "Proxy online" : "Proxy offline"}
        >
          <Radio className="w-3.5 h-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="proxy-header-title">Proxy</div>
          <div className="proxy-header-sub" title={baseUrl}>{baseUrl}</div>
          {publicBaseUrl ? (
            <div className="proxy-header-sub is-live" title="Public ngrok endpoint">
              {publicBaseUrl}
            </div>
          ) : null}
        </div>

        {isPopup ? (
          <div className="proxy-seg-group">
            <span
              className={`${pxSeg} is-active`}
              style={{ cursor: "default", pointerEvents: "none" }}
            >
              {popupView === "settings" ? (
                <Settings2 className="w-3 h-3" />
              ) : (
                <Activity className="w-3 h-3" />
              )}
              {popupView === "settings" ? "Settings" : L?.proxyUsage || "Usage"}
            </span>
          </div>
        ) : (
          <div className="proxy-seg-group">
            <button
              type="button"
              onClick={() => {
                setMainView("providers");
                setSelectedProviderId(null);
              }}
              className={`${pxSeg} ${mainView === "providers" ? "is-active" : ""}`}
            >
              01 · {L?.proxyProviders || "Providers"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMainView("usage");
                setSelectedProviderId(null);
                void loadUsageStats();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, view: "usage" });
              }}
              className={`${pxSeg} ${mainView === "usage" ? "is-active" : ""}`}
              title={L?.proxyUsage || "Usage"}
            >
              <Activity className="w-3 h-3" />
              02 · {L?.proxyUsage || "Usage"}
            </button>
            <button
              type="button"
              onClick={() => {
                setMainView("settings");
                setSelectedProviderId(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY, view: "settings" });
              }}
              className={`${pxSeg} ${mainView === "settings" ? "is-active" : ""}`}
              title="Settings"
            >
              <Settings2 className="w-3 h-3" />
              03 · Settings
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            void refresh();
            if (mainView === "usage") void loadUsageStats();
          }}
          className="proxy-header-icon"
          title={L?.proxyRefresh || "Refresh"}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${usageLoading ? "animate-spin" : ""}`} />
        </button>
        {running ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void stop()}
            className={`${pxBtn} theme-btn-danger`}
          >
            <Square className="w-3 h-3" />
            {L?.proxyStop || "Stop"}
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className={`${pxBtn} theme-btn-ok`}
          >
            <Play className="w-3 h-3" />
            {L?.proxyStart || "Start"}
          </button>
        )}
      </div>

      {error && <div className="proxy-error-banner">{error}</div>}

      {oauth && (
        <div className="proxy-oauth-card">
          <Loader2 className="w-3.5 h-3.5 text-ink-500 animate-spin flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-ink-900">
              {oauth.needsPasteCode || oauth.providerId === "claude-code"
                ? "Sign in with Claude Code"
                : oauth.providerId === "kiro"
                  ? "Sign in with Kiro (AWS Builder ID)"
                  : oauth.userCode
                    ? "Sign in with ChatGPT"
                    : "Sign in with browser (Google / X)"}
            </div>
            <div className="text-[10px] text-ink-500">
              {oauth.needsPasteCode || oauth.providerId === "claude-code"
                ? `After approve, paste code#state below · ${oauth.status}`
                : oauth.providerId === "kiro"
                  ? `Enter code on AWS page · ${oauth.status}`
                  : oauth.userCode
                    ? `Enter code in browser · ${oauth.status}`
                    : `Complete login in browser · ${oauth.status}`}
            </div>
          </div>
          {(oauth.needsPasteCode || oauth.providerId === "claude-code") && (
            <>
              <input
                value={claudeCodePaste}
                onChange={(e) => setClaudeCodePaste(e.target.value)}
                placeholder="code#state or full callback URL"
                className={`${pxInput} min-w-[220px] flex-1 font-mono`}
              />
              <button
                type="button"
                disabled={busy || !claudeCodePaste.trim()}
                onClick={() => void completeClaudeCodeOauth()}
                className={pxQuiet}
              >
                Submit code
              </button>
            </>
          )}
          {oauth.userCode ? (
            <button
              type="button"
              onClick={() => void copyText(oauth.userCode!, "code")}
              className="h-7 px-2.5 rounded-lg border border-ink-200 bg-ink-50 font-mono text-[13px] tracking-widest text-ink-950 outline-none hover:bg-ink-100"
            >
              {oauth.userCode}
              <span className="ml-2 text-[10px] text-ink-500 tracking-normal">
                {copied === "code" ? "copied" : "copy"}
              </span>
            </button>
          ) : !(oauth.needsPasteCode || oauth.providerId === "claude-code") ? (
            <span className="text-[11px] text-ink-500">Waiting for browser…</span>
          ) : null}
          <button
            type="button"
            onClick={() => void window.lopster?.openExternal?.(oauth.verificationUri)}
            className={pxGhost}
          >
            <ExternalLink className="w-3 h-3" />
            Open
          </button>
          <button
            type="button"
            onClick={() => void cancelOauth()}
            className={pxGhost}
          >
            Cancel
          </button>
        </div>
      )}

      {mainView === "usage" && !selectedProviderId && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 h-10 px-3 sm:px-4 flex-shrink-0 min-w-0">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold tracking-[-0.02em]" style={{ color: "var(--ink-950)" }}>
                Usage
              </div>
              <div className="text-[10px] truncate" style={{ color: "var(--ink-500)" }}>
                {usageLoading
                  ? "updating"
                  : `updated ${formatUsageTime(usageStats?.updatedAt)}`}
                {usageStats?.createdAt
                  ? ` · since ${formatUsageTime(usageStats.createdAt)}`
                  : ""}
              </div>
            </div>
            <button
              type="button"
              disabled={busy || usageLoading}
              onClick={() => void loadUsageStats()}
              className="w-7 h-7 grid place-items-center rounded-lg border-0 outline-none cursor-pointer flex-shrink-0"
              style={{ color: "var(--ink-500)" }}
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${usageLoading ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetUsageStats()}
              className="h-7 px-2.5 rounded-lg border-0 outline-none cursor-pointer flex-shrink-0 text-[11px]"
              style={{ color: "var(--ink-500)" }}
              title="Zero all counters"
            >
              Reset
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            <div className="h-full min-h-full p-3 sm:p-4 flex flex-col gap-3">
              {/* KPI row — large numbers, clean typography */}
              <div className="grid grid-cols-4 gap-3 flex-shrink-0">
                {[
                  { label: "Tokens", value: usageTotals.totalTokens, hint: "total" },
                  { label: "In", value: usageTotals.promptTokens, hint: "context" },
                  { label: "Out", value: usageTotals.completionTokens, hint: "output" },
                  { label: "Requests", value: usageTotals.requests, hint: `${formatBigCount(usageTotals.streamRequests, true)} stream / ${formatBigCount(usageTotals.jsonRequests, true)} json` },
                ].map((card) => (
                  <div key={card.label} className="min-w-0">
                    <div className="text-[10px] font-medium tracking-[0.12em] text-ink-500 mb-0.5 uppercase">
                      {card.label}
                    </div>
                    <div className="text-[28px] sm:text-[32px] font-semibold tracking-[-0.04em] tabular-nums font-mono leading-none truncate text-ink-950">
                      {formatBigCount(card.value, true)}
                    </div>
                    <div className="mt-1 text-[10px] text-ink-500 truncate">{card.hint}</div>
                  </div>
                ))}
              </div>

              {/* Charts: Token composition + Model ranking + Providers */}
              {hasUsageData ? (
                <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 min-h-0 flex-1">
                  {/* Token composition — horizontal stacked bar */}
                  <section className="proxy-panel xl:col-span-5 min-h-[200px]">
                    <div className="proxy-panel-head">
                      <div className="text-[11px] font-medium text-ink-900">Token composition</div>
                      <span className="proxy-pill ml-auto">{formatBigCount(usageTotals.totalTokens, true)} total</span>
                    </div>
                    <div className="p-4 flex flex-col gap-3.5">
                      {/* Stacked bar */}
                      <div className="h-3 rounded-full overflow-hidden flex" style={{ background: "var(--hover-bg)" }}>
                        {tokenComposeTotal > 0 && (
                          <>
                            <div style={{ width: `${Math.round((promptMag / tokenComposeTotal) * 100)}%`, background: "var(--info)" }} />
                            <div style={{ width: `${Math.round((completionMag / tokenComposeTotal) * 100)}%`, background: "var(--warn)" }} />
                            <div style={{ width: `${Math.round((reasoningMag / tokenComposeTotal) * 100)}%`, background: "var(--accent-2)" }} />
                          </>
                        )}
                      </div>
                      {/* Legend */}
                      <div className="space-y-2.5">
                        {[
                          { label: "Prompt", value: usageTotals.promptTokens, mag: promptMag, color: "var(--info)" },
                          { label: "Completion", value: usageTotals.completionTokens, mag: completionMag, color: "var(--warn)" },
                          { label: "Reasoning", value: usageTotals.reasoningTokens, mag: reasoningMag, color: "var(--accent-2)" },
                        ].map((r) => {
                          const pct = tokenComposeTotal > 0 ? Math.round((r.mag / tokenComposeTotal) * 100) : 0;
                          return (
                            <div key={r.label} className="flex items-center gap-2.5 min-w-0">
                              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
                              <div className="text-[11px] flex-1" style={{ color: "var(--text-dim)" }}>{r.label}</div>
                              <div className="text-[11px] font-mono tabular-nums font-medium" style={{ color: r.color }} title={formatBigCount(r.value, false)}>
                                {formatBigCount(r.value, true)}
                              </div>
                              <div className="text-[10px] font-mono tabular-nums w-8 text-right" style={{ color: "var(--text-muted)" }}>{pct}%</div>
                            </div>
                          );
                        })}
                      </div>
                      <div className="pt-2 space-y-2">
                        <div className="flex items-center justify-between text-[10px]">
                          <span style={{ color: "var(--text-muted)" }}>Stream / JSON</span>
                          <span className="font-mono tabular-nums" style={{ color: "var(--text-dim)" }}>
                            {formatBigCount(usageTotals.streamRequests, true)} / {formatBigCount(usageTotals.jsonRequests, true)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full overflow-hidden flex" style={{ background: "var(--hover-bg)" }}>
                          {reqComposeTotal > 0 && (
                            <>
                              <div style={{ width: `${Math.round((streamMag / reqComposeTotal) * 100)}%`, background: "var(--ok)" }} title={`stream ${formatBigCount(usageTotals.streamRequests, false)}`} />
                              <div style={{ width: `${Math.round((jsonMag / reqComposeTotal) * 100)}%`, background: "var(--info)" }} title={`json ${formatBigCount(usageTotals.jsonRequests, false)}`} />
                            </>
                          )}
                        </div>
                        {(String(usageTotals.cacheReadTokens || "0") !== "0" || String(usageTotals.cacheCreationTokens || "0") !== "0") && (
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] font-mono tabular-nums" style={{ color: "var(--text-soft)" }}>
                            <span>cache read {formatBigCount(usageTotals.cacheReadTokens, true)}</span>
                            <span>cache create {formatBigCount(usageTotals.cacheCreationTokens, true)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </section>

                  {/* Model ranking */}
                  <section className="proxy-panel xl:col-span-4 min-h-[200px]">
                    <div className="proxy-panel-head">
                      <div className="text-[11px] font-medium text-ink-900">Models</div>
                      <span className="proxy-pill ml-auto">top {chartModels.length || 0} / {usageStats?.modelCount ?? usageModels.length}</span>
                    </div>
                    {chartModels.length === 0 ? (
                      <div className="flex-1 grid place-items-center py-12 text-center">
                        <div className="text-[12px] text-ink-500">No traffic yet</div>
                        <div className="mt-1 text-[11px] text-ink-500">Run chat through proxy to fill</div>
                      </div>
                    ) : (
                      <div className="flex-1 min-h-0 flex flex-col p-3.5 gap-3">
                        {/* Bar chart strip */}
                        <div className="flex items-end gap-1 h-[110px] px-1 pt-4" style={{
                          background: "transparent",
                          borderRadius: 8,
                        }}>
                          {chartModels.map((row) => (
                            <UsageColBar
                              key={row.id}
                              pct={modelSharePct(row.totalTokens)}
                              color="var(--accent)"
                              label={row.id}
                              value={formatBigCount(row.totalTokens, true)}
                              title={`${row.id}\n${formatBigCount(row.totalTokens, false)} tokens · ${formatBigCount(row.requests, false)} req`}
                            />
                          ))}
                        </div>
                        {/* Full list */}
                        <div className="space-y-2 max-h-[45%] overflow-y-auto scrollbar-thin pr-0.5">
                          {usageModels.map((row, idx) => {
                            const share = modelSharePct(row.totalTokens);
                            return (
                              <div key={row.id} className="min-w-0">
                                <div className="flex items-center gap-2 min-w-0 mb-0.5">
                                  <span className="w-4 text-[10px] font-mono tabular-nums text-ink-500">{String(idx + 1).padStart(2, "0")}</span>
                                  <span className="min-w-0 flex-1 text-[11px] font-mono truncate text-ink-950" title={row.id}>{row.id}</span>
                                  <span className="text-[10px] font-mono tabular-nums text-ink-500">{formatBigCount(row.requests, true)} req</span>
                                  <span className="text-[11px] font-mono tabular-nums font-medium text-ink-950 w-[4.5rem] text-right" title={formatBigCount(row.totalTokens, false)}>
                                    {formatBigCount(row.totalTokens, true)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 pl-6">
                                  <UsageBar pct={share} color="var(--accent)" height={4} className="flex-1" />
                                  <div className="flex items-center gap-1.5 flex-shrink-0">
                                    <span className="text-[9px] font-mono tabular-nums" style={{ color: "var(--info)" }}>in {formatBigCount(row.promptTokens, true)}</span>
                                    <span className="text-[9px] font-mono tabular-nums" style={{ color: "var(--warn)" }}>out {formatBigCount(row.completionTokens, true)}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </section>

                  {/* Providers */}
                  <section className="proxy-panel xl:col-span-3 min-h-[200px]">
                    <div className="proxy-panel-head">
                      <div className="text-[11px] font-medium text-ink-900">Providers</div>
                      <span className="proxy-pill ml-auto">{usageStats?.providerCount ?? usageProviders.length}</span>
                    </div>
                    {usageProviders.length === 0 ? (
                      <div className="proxy-empty flex-1">—</div>
                    ) : (
                      <ul className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                        {usageProviders.map((p) => {
                          const meta = providers.find((x) => x.id === p.id);
                          const share = providerSharePct(p.totalTokens);
                          return (
                            <li key={p.id} className="px-3.5 py-2.5 min-w-0 theme-hairline hover:bg-[var(--hover-bg)]">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="proxy-provider-icon !w-8 !h-8 !rounded-lg">
                                  <ProviderIcon id={p.id} name={meta?.name || p.id} size={18} custom={Boolean(meta?.custom || meta?.isCustom)} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <div className="text-[12px] truncate text-ink-950">{meta?.name || p.id}</div>
                                    <div className="ml-auto text-[12px] font-mono tabular-nums font-medium text-ink-950 flex-shrink-0" title={formatBigCount(p.totalTokens, false)}>
                                      {formatBigCount(p.totalTokens, true)}
                                    </div>
                                  </div>
                                  <div className="mt-1 flex items-center gap-2">
                                    <UsageBar pct={share} color="var(--accent)" height={4} className="flex-1" />
                                    <span className="text-[10px] font-mono tabular-nums text-ink-500">{formatBigCount(p.requests, true)} req</span>
                                  </div>
                                  <div className="mt-1 flex gap-2 text-[9px] font-mono tabular-nums text-ink-500">
                                    <span style={{ color: "var(--info)" }}>in {formatBigCount(p.promptTokens, true)}</span>
                                    <span style={{ color: "var(--warn)" }}>out {formatBigCount(p.completionTokens, true)}</span>
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </section>
                </div>
              ) : (
                <div className="flex-1 grid place-items-center py-16">
                  <div className="text-center">
                    <div className="mx-auto mb-3 w-12 h-12 rounded-2xl grid place-items-center" style={{ background: "var(--hover-bg)" }}>
                      <BarChart3 className="w-5 h-5" style={{ color: "var(--text-muted)" }} />
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--text-muted)" }}>No traffic yet</div>
                    <div className="mt-1 text-[11px]" style={{ color: "var(--text-soft)" }}>Run chat through the proxy to fill charts</div>
                  </div>
                </div>
              )}

              {/* Footer */}
              <div className="text-[10px] leading-relaxed flex-shrink-0 px-1 py-2" style={{ color: "var(--ink-500)" }}>
                Counters track successful <code className="font-mono" style={{ color: "var(--info)" }}>/v1/chat/completions</code> responses from all providers. 
                Stored in <code className="font-mono" style={{ color: "var(--info)" }}>userData/proxy/usage-stats.json</code>.
              </div>
            </div>
          </div>
        </div>
      )}

      {mainView === "providers" && !selectedProviderId && (
        <div className="flex-1 min-h-0 flex overflow-hidden">
          <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-3 sm:p-4 flex flex-col">
            <div className="proxy-provider-toolbar mb-3 flex flex-wrap items-center gap-2 flex-shrink-0">
              <div className="proxy-terminal-search relative flex-1 min-w-[12rem] max-w-md">
                <span className="proxy-terminal-search-prompt">$</span>
                <Search
                  className="absolute left-7 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
                />
                <input
                  value={providerQuery}
                  onChange={(e) => setProviderQuery(e.target.value)}
                  placeholder="find provider"
                  className="proxy-search"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowCustomForm(true)}
                className={pxQuiet}
                title="Add OpenAI-compatible custom provider (endpoint + models)"
              >
                <Plus className="w-3 h-3" />
                Custom
              </button>
              <span className="text-[10px] text-ink-500 font-mono">
                {displayProviders.length}
                {providerFavorites.length > 0
                  ? ` · ${providerFavorites.filter((id) => providers.some((p) => p.id === id)).length} ★`
                  : ""}
              </span>
            </div>

            {providerFavorites.length > 0 && !providerQuery.trim() && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] text-ink-500 mr-0.5">Pinned</span>
                {providerFavorites
                  .map((id) => providers.find((p) => p.id === id))
                  .filter(Boolean)
                  .map((p) => (
                    <button
                      key={p!.id}
                      type="button"
                      onClick={() => openProvider(p!.id)}
                      className="proxy-pin-chip"
                      title="Open pinned provider"
                    >
                      <Star className="w-3 h-3 fill-ink-700 text-ink-700" />
                      {p!.name}
                    </button>
                  ))}
              </div>
            )}

            <div className="proxy-provider-matrix min-h-0 flex-1">
              {renderProviderTable("01 · API providers", apiProviders, false, "No API providers.")}
              {renderProviderTable("02 · Auth providers", authProviders, false, "No auth providers.")}
              {renderProviderTable("03 · Custom providers", customProvidersList, true, "No custom providers. Use Custom to add one.")}
            </div>
          </div>
        </div>
      )}

      {mainView === "settings" && (
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3 p-3 sm:p-4 overflow-y-auto lg:overflow-hidden scrollbar-thin">
          {/* LEFT — Local Coding Agent MCP */}
          <div className="min-h-0 flex flex-col">
            <LocalAgentMcpPanel pxBtn={pxBtn} />
          </div>

          {/* RIGHT — Local / Tunnel / Keys / Logs */}
          <div className="min-h-0 flex flex-col gap-3">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 flex-shrink-0 items-stretch">
            {/* Local */}
            <section className="proxy-panel flex flex-col">
              <div className="proxy-table-header">
                <span>Local</span>
                <span
                  className={`ml-auto text-[10px] font-mono normal-case tracking-normal ${
                    running ? "text-ink-800" : "text-ink-500"
                  }`}
                >
                  {running ? "on" : "off"}
                </span>
              </div>
              <div className="p-3 space-y-2.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <code className="proxy-mono-box">{baseUrl}</code>
                  <button
                    type="button"
                    onClick={() => void copyText(baseUrl, "url")}
                    className="proxy-header-icon"
                    title="Copy"
                  >
                    {copied === "url" ? <span className="text-[9px] text-ink-800">ok</span> : <Copy className="w-3 h-3" />}
                  </button>
                </div>
                <div className="grid grid-cols-[1fr_4.5rem] gap-1.5">
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    disabled={running}
                    placeholder="host"
                    className={`${pxInput} w-full font-mono disabled:opacity-45`}
                  />
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 8787)}
                    disabled={running}
                    placeholder="port"
                    className={`${pxInput} w-full font-mono disabled:opacity-45`}
                  />
                </div>
              </div>
            </section>

            {/* Tunnel */}
            <section className="proxy-panel flex flex-col">
              <div className="proxy-table-header">
                <span>Tunnel</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ngrokEnabled}
                  onClick={() => {
                    const next = !ngrokEnabled;
                    setNgrokEnabled(next);
                    void saveNgrokSettings({ enabled: next });
                  }}
                  className={`ml-auto relative h-4 w-7 rounded-full border transition-colors outline-none ${
                    ngrokEnabled ? "theme-toggle-on" : "bg-ink-300 border-ink-300"
                  }`}
                  title={ngrokEnabled ? "Disable" : "Enable"}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-ink-950 transition-transform ${
                      ngrokEnabled ? "translate-x-3" : ""
                    }`}
                  />
                </button>
              </div>
              <div className="p-3 space-y-2.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <code className={`proxy-mono-box ${publicBaseUrl ? "" : "is-muted"}`}>
                    {publicBaseUrl ||
                      (ngrokEnabled
                        ? ngrokStatus?.running
                          ? "…"
                          : running
                            ? "connecting…"
                            : "start proxy"
                        : "—")}
                  </code>
                  {publicBaseUrl ? (
                    <button
                      type="button"
                      onClick={() => void copyText(publicBaseUrl, "ngrok-url")}
                      className="proxy-header-icon"
                      title="Copy"
                    >
                      {copied === "ngrok-url" ? <span className="text-[9px] text-ink-800">ok</span> : <Copy className="w-3 h-3" />}
                    </button>
                  ) : null}
                  {running && ngrokEnabled ? (
                    <button
                      type="button"
                      disabled={ngrokSaving || busy}
                      onClick={async () => {
                        setNgrokSaving(true);
                        try {
                          await saveNgrokSettings();
                          const res = await window.lopster?.proxyNgrokRestart?.();
                          if (!res?.ok) throw new Error(res?.error || "restart failed");
                          if (res.status?.ngrok) setNgrokStatus(res.status.ngrok as NgrokStatus);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setNgrokSaving(false);
                        }
                      }}
                      className="proxy-header-icon"
                      title="Restart tunnel"
                    >
                      {ngrokSaving ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                    </button>
                  ) : null}
                </div>
                {ngrokStatus?.error ? (
                  <div className="text-[10px] text-status-err font-mono truncate" title={ngrokStatus.error}>
                    {ngrokStatus.error}
                  </div>
                ) : null}
                <input
                  type="password"
                  value={ngrokToken}
                  onChange={(e) => setNgrokToken(e.target.value)}
                  placeholder="authtoken"
                  autoComplete="off"
                  className={`${pxInput} w-full font-mono`}
                />
                <div className="grid grid-cols-[1fr_3.5rem_auto] gap-1.5">
                  <input
                    value={ngrokDomain}
                    onChange={(e) => setNgrokDomain(e.target.value)}
                    placeholder="domain"
                    className={`${pxInput} w-full font-mono`}
                  />
                  <input
                    value={ngrokRegion}
                    onChange={(e) => setNgrokRegion(e.target.value)}
                    placeholder="region"
                    className={`${pxInput} w-full font-mono`}
                  />
                  <button
                    type="button"
                    disabled={ngrokSaving || busy}
                    onClick={() => void saveNgrokSettings()}
                    className={pxSolid}
                  >
                    {ngrokSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    Save
                  </button>
                </div>
              </div>
            </section>
          </div>

            {/* Keys */}
            <section className="proxy-panel flex flex-col flex-shrink-0">
              <div className="proxy-table-header">
                <span>Keys</span>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await window.lopster?.proxyCreateKey?.("client");
                    if (res?.ok && res.config) setConfig(res.config as ProxyConfig);
                  }}
                  className="proxy-header-icon ml-auto !w-6 !h-6"
                  title="New key"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowKeys((v) => !v)}
                  className="proxy-header-icon !w-6 !h-6"
                  title={showKeys ? "Hide keys" : "Show keys"}
                  aria-label={showKeys ? "Hide keys" : "Show keys"}
                >
                  {showKeys ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                </button>
              </div>
              <div className="p-3">
                {(config?.keys || []).length === 0 ? (
                  <div className="text-[11px] text-ink-500 py-1">No keys</div>
                ) : (
                  <ul className="space-y-1 max-h-36 overflow-y-auto scrollbar-thin">
                    {(config?.keys || []).map((k) => (
                      <li
                        key={k.id}
                        className="group flex items-center gap-1 h-8 px-2 rounded-lg"
                        style={{ background: "var(--surface-2)" }}
                      >
                        <code className="min-w-0 flex-1 text-[11px] font-mono text-ink-800 truncate px-1">
                          {showKeys ? k.key : "sk-" + "•".repeat(Math.min(28, Math.max(k.key.length - 3, 6)))}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copyText(k.key, k.id)}
                          className="h-6 w-6 grid place-items-center rounded-md text-ink-500 opacity-0 group-hover:opacity-100 hover:text-ink-900 outline-none transition-opacity"
                          title="Copy"
                        >
                          {copied === k.id ? (
                            <span className="text-[9px] text-ink-800">ok</span>
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await window.lopster?.proxyDeleteKey?.(k.id);
                            if (res?.ok && res.config) setConfig(res.config as ProxyConfig);
                          }}
                          className="h-6 w-6 grid place-items-center rounded-md text-ink-500 opacity-0 group-hover:opacity-100 hover:text-status-err outline-none transition-opacity"
                          title="Delete"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

          {/* Logs — fills the rest of the right column */}
          <section className="proxy-panel flex flex-col flex-1 min-h-[14rem]">
            <div className="flex items-center gap-2 h-9 px-3 flex-shrink-0 theme-hairline-bottom">
              <span className="proxy-section-label">Logs</span>
              <span className="ml-auto text-[10px] font-mono tabular-nums normal-case tracking-normal text-ink-500">
                {logs.length}
              </span>
              <button
                type="button"
                onClick={() => void clearLogs()}
                className="proxy-header-icon !w-6 !h-6"
                title="Clear logs"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
            <div className="proxy-terminal">
              {logs.length === 0 ? (
                <div className="text-[11px] text-ink-500 px-3 py-2">—</div>
              ) : (
                (() => {
                  // Virtualized tail render — only paint the last N rows so a
                  // long-running proxy stream (hundreds of failover log lines)
                  // never freezes the renderer. Time strings are precomputed once.
                  const RENDER_TAIL = 60;
                  const view = logs.slice(-RENDER_TAIL);
                  const rows = [];
                  for (let ri = view.length - 1; ri >= 0; ri--) {
                    const l = view[ri];
                    const d = new Date(l.ts);
                    const hh = String(d.getHours()).padStart(2, "0");
                    const mm = String(d.getMinutes()).padStart(2, "0");
                    const ss = String(d.getSeconds()).padStart(2, "0");
                    rows.push(
                      <div key={`${l.ts}-${ri}`} className="proxy-terminal-row">
                        <span className="proxy-term-time">{`${hh}:${mm}:${ss}`}</span>
                        <span className={`proxy-term-msg ${l.level === "error" ? "is-err" : ""}`}>
                          {l.model ? <span className="proxy-term-model">{l.model}</span> : null}
                          {l.msg}
                        </span>
                      </div>
                    );
                  }
                  return rows;
                })()
              )}
            </div>
          </section>
          </div>
        </div>
      )}

      {mainView === "providers" && selectedProvider && (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div className="proxy-detail-strip">
            <button
              type="button"
              onClick={() => setSelectedProviderId(null)}
              className={pxGhost}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Providers
            </button>
            <div className="proxy-provider-icon !w-8 !h-8 !rounded-lg">
              <ProviderIcon
                id={selectedProvider.id}
                name={selectedProvider.name}
                size={20}
                custom={Boolean(selectedProvider.custom || selectedProvider.isCustom)}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="proxy-header-title">
                {selectedProvider.name}
                {(selectedProvider.custom || selectedProvider.isCustom) && (
                  <span className="ml-1.5 text-[10px] font-normal text-ink-500">Custom</span>
                )}
              </div>
              <div className="proxy-header-sub">
                {selectedProvider.defaultBaseUrl}
              </div>
            </div>
            {(selectedProvider.custom || selectedProvider.isCustom) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void deleteCustomProvider(selectedProvider.id)}
                className={pxGhost}
                title="Delete custom provider, its keys and models"
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
            )}

            <div className="proxy-seg-group">
              <button
                type="button"
                onClick={() => setDetailPane("accounts")}
                className={`${pxSeg} ${detailPane === "accounts" ? "is-active" : ""}`}
              >
                Accounts
              </button>
              <button
                type="button"
                onClick={() => setDetailPane("models")}
                className={`${pxSeg} ${detailPane === "models" ? "is-active" : ""}`}
              >
                Models
              </button>
            </div>
          </div>

          {detailPane === "accounts" && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="proxy-detail-strip !items-start flex-col !gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5 w-full">
                {selectedProvider.id === "openai" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || Boolean(oauth)}
                      onClick={() => void startOauth("openai")}
                      className={pxQuiet}
                      title="ChatGPT device login — opens auth.openai.com/codex/device"
                    >
                      Sign in with browser
                    </button>
                    <input
                      value={codexTxtInput}
                      onChange={(event) => setCodexTxtInput(event.target.value)}
                      placeholder="Codex JWT / JWT:refresh / auth.json (multi-line OK)"
                      className={`${pxInput} min-w-[240px] flex-1 font-mono`}
                      title="Paste Codex JWT (eyJ...) or JWT:refresh_token (rt.1...) per line, or full ~/.codex/auth.json JSON (tokens.access_token / refresh_token / account_id / last_refresh)"
                    />
                    <button
                      type="button"
                      disabled={busy || !codexTxtInput.trim()}
                      onClick={() => void importCodexTxt()}
                      className={pxGhost}
                      title="Import pasted Codex JWT / JWT:refresh lines (ChatGPT Pro etc.)"
                    >
                      Import JWT
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importCodexTxtFile()}
                      className={pxGhost}
                      title="Choose a .txt file with Codex JWT / JWT:refresh lines"
                    >
                      TXT file
                    </button>
                  </>
                )}
                {selectedProvider.id === "grok" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || Boolean(oauth)}
                      onClick={() => void startGrokBrowserOauth()}
                      className={pxQuiet}
                      title="Browser OAuth — Google / X / email (same as Grok CLI)"
                    >
                      Sign in with browser
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importGrokCli()}
                      className={pxGhost}
                      title="Import ~/.grok/auth.json after: grok login --device-auth"
                    >
                      Import Grok CLI
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyText("grok login --device-auth", "grok-device-auth")}
                      className={pxGhost}
                      title="Copy official headless login command. Run it, approve code, then Import Grok CLI."
                    >
                      {copied === "grok-device-auth" ? "Copied" : "Copy device login"}
                    </button>
                    <input
                      value={grokTxtInput}
                      onChange={(event) => setGrokTxtInput(event.target.value)}
                      placeholder="email:pass:JWT or JWT or JWT:refresh"
                      className={`${pxInput} min-w-[220px] flex-1 font-mono`}
                    />
                    <button
                      type="button"
                      disabled={busy || !grokTxtInput.trim()}
                      onClick={() => void importGrokTxt()}
                      className={pxGhost}
                      title="Import pasted Grok JWT or email:password:JWT lines. Passwords are ignored."
                    >
                      Import TXT
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importGrokTxtFile()}
                      className={pxGhost}
                      title="Choose a .txt file with Grok JWT or email:password:JWT lines. Passwords are ignored."
                    >
                      TXT file
                    </button>
                  </>
                )}
                {selectedProvider.id === "antigravity" && (
                  <button
                    type="button"
                    disabled={busy || Boolean(oauth)}
                    onClick={() => void startAntigravityOauth()}
                    className={pxQuiet}
                    title="Google OAuth → Cloud Code"
                  >
                    Sign in with Google
                  </button>
                )}
                {selectedProvider.id === "gemini-cli" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || Boolean(oauth)}
                      onClick={() => void startGeminiCliOauth()}
                      className={pxQuiet}
                      title="Google OAuth for Gemini CLI / Code Assist"
                    >
                      Sign in with Google
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importGeminiCli()}
                      className={pxGhost}
                      title="Import ~/.gemini/oauth_creds.json after: gemini (CLI login)"
                    >
                      Import Gemini CLI
                    </button>
                  </>
                )}
                {selectedProvider.id === "claude-code" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || Boolean(oauth)}
                      onClick={() => void startClaudeCodeOauth()}
                      className={pxQuiet}
                      title="Claude Pro/Max OAuth (PKCE) — paste code#state after browser login"
                    >
                      Sign in with Claude
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importClaudeCodeCli()}
                      className={pxGhost}
                      title="Import ~/.claude/.credentials.json after: claude login"
                    >
                      Import Claude CLI
                    </button>
                    <input
                      value={claudeJsonInput}
                      onChange={(event) => setClaudeJsonInput(event.target.value)}
                      placeholder='{"claudeAiOauth":{...}}'
                      className={`${pxInput} min-w-[200px] flex-1 font-mono`}
                    />
                    <button
                      type="button"
                      disabled={busy || !claudeJsonInput.trim()}
                      onClick={() => void importClaudeCodeJson()}
                      className={pxGhost}
                      title="Paste Claude credentials.json contents"
                    >
                      Import JSON
                    </button>
                    <input
                      value={claudeTokenInput}
                      onChange={(event) => setClaudeTokenInput(event.target.value)}
                      placeholder="access:refresh (paste JWT pair)"
                      className={`${pxInput} min-w-[200px] flex-1 font-mono`}
                      title="Paste Claude access_token:refresh_token (or credentials JSON)"
                    />
                    <button
                      type="button"
                      disabled={busy || !claudeTokenInput.trim()}
                      onClick={() => void importClaudeToken()}
                      className={pxGhost}
                      title="Import pasted Claude access:refresh token pair"
                    >
                      Import token
                    </button>
                  </>
                )}
                {["github-copilot", "windsurf", "cursor", "codebuddy", "codebuddy-cn", "qoder", "qauth"].includes(
                  selectedProvider.id
                ) && (
                  <button
                    type="button"
                    disabled={busy || Boolean(oauth)}
                    onClick={() => void startOauth(selectedProvider.id)}
                    className={pxQuiet}
                    title="Start native OAuth authorization"
                  >
                    Sign in with browser
                  </button>
                )}
                {(selectedProvider.id === "opencode-go" || selectedProvider.id === "opencode") && (
                  <span className="text-[10px] text-ink-500">
                    Add an {selectedProvider.id === "opencode" ? "OpenCode Zen" : "OpenCode Go"} API key below.
                  </span>
                )}
                {selectedProvider.id === "kiro" && (
                  <>
                    <button
                      type="button"
                      disabled={busy || Boolean(oauth)}
                      onClick={() => void startKiroOauth()}
                      className={pxQuiet}
                      title="AWS Builder ID device-code login for Kiro / CodeWhisperer"
                    >
                      Sign in with Builder ID
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void importKiroCli()}
                      className={pxGhost}
                      title="Import local Kiro / AWS SSO auth file if present"
                    >
                      Import local
                    </button>
                    <input
                      value={kiroTokenInput}
                      onChange={(event) => setKiroTokenInput(event.target.value)}
                      placeholder="paste Kiro refresh token"
                      className={`${pxInput} min-w-[200px] flex-1 font-mono`}
                    />
                    <button
                      type="button"
                      disabled={busy || !kiroTokenInput.trim()}
                      onClick={() => void importKiroToken()}
                      className={pxGhost}
                      title="Import Kiro refresh token (Builder ID / social)"
                    >
                      Import token
                    </button>
                  </>
                )}
                {selectedProvider.supportsApiKey !== false && (
                <button
                  type="button"
                  onClick={() => setShowApiForm((v) => !v)}
                  className={showApiForm ? pxSolid : pxGhost}
                >
                  <Plus className="w-3 h-3" />
                  API key
                </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reloadAccountsTable()}
                  className={pxGhost}
                  title="Reload accounts table from disk — picks up newly added accounts without restarting the app"
                >
                  <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
                  Reload accounts
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void refreshUsage()}
                  className={pxGhost}
                  title="Refresh quota / limits for all accounts in parallel (no app restart)"
                >
                  <RefreshCw className={`w-3 h-3 ${busy ? "animate-spin" : ""}`} />
                  Refresh limits
                </button>
                <span className="text-[10px] text-ink-500 ml-auto">
                  {providerAccounts.length} account{providerAccounts.length === 1 ? "" : "s"} ·
                  smart route
                </span>
                </div>
                <div className="text-[10px] text-ink-500 leading-relaxed">
                Order = add order. On limit → next account. After reset → first free again.
                {selectedProvider.id === "openai" ? (
                  <span className="block mt-0.5">
                    Browser device-login (ChatGPT), or paste Codex JWT (ChatGPT Pro,{" "}
                    <code className="font-mono text-ink-600">gpt-5.5</code> etc.) + refresh token via{" "}
                    <b>Import JWT</b>. JWT auto-refreshes only when a{" "}
                    <code className="font-mono text-ink-600">rt.…</code> refresh token is present.
                    OAuth uses Codex backend; API keys use Platform. Models:{" "}
                    <code className="font-mono text-ink-600">openai/gpt-5.5</code>,{" "}
                    <code className="font-mono text-ink-600">openai/gpt-5.1-codex</code>.
                  </span>
                ) : null}
                {selectedProvider.id === "grok" ? (
                  <span className="block mt-0.5">
                    Grok: browser, CLI, or TXT/JWT. Auto-refresh only if refresh_token present (password cannot re-login). Models:{" "}
                    <code className="font-mono text-ink-600">xai/grok-4.5</code> (or bare{" "}
                    <code className="font-mono text-ink-600">grok-4.5</code>).
                  </span>
                ) : null}
                {selectedProvider.id === "antigravity" ? (
                  <span className="block mt-0.5">
                    Google → Cloud Code. Models:{" "}
                    <code className="font-mono text-ink-600">antigravity/gemini-3.1-pro-high</code>
                  </span>
                ) : null}
                {selectedProvider.id === "gemini-cli" ? (
                  <span className="block mt-0.5">
                    Like OmniRoute: free Gemini CLI Code Assist is discontinued —{" "}
                    <b>prefer Antigravity</b> (auto project). Gemini CLI reuses Antigravity/agy
                    GCP project for the same Google account, or set Project ID. Models:{" "}
                    <code className="font-mono text-ink-600">gemini-2.5-pro/flash</code>.
                  </span>
                ) : null}
                {selectedProvider.id === "claude-code" ? (
                  <span className="block mt-0.5">
                    Claude Pro/Max OAuth (same as Claude Code CLI). Browser → paste{" "}
                    <code className="font-mono text-ink-600">code#state</code>, or Import CLI /
                    credentials JSON. Multi-account failover on 5h/weekly limits. Models:{" "}
                    <code className="font-mono text-ink-600">claude-code/claude-sonnet-4-6</code>,{" "}
                    <code className="font-mono text-ink-600">claude-code/claude-opus-4-7</code>.
                  </span>
                ) : null}
                {selectedProvider.id === "kiro" ? (
                  <span className="block mt-0.5">
                    AWS Kiro / CodeWhisperer OAuth (Builder ID device code or paste refresh token).
                    Quota via GetUsageLimits when profileArn is available. Models:{" "}
                    <code className="font-mono text-ink-600">kiro/claude-sonnet-4.5</code>,{" "}
                    <code className="font-mono text-ink-600">kiro/claude-haiku-4.5</code>,{" "}
                    <code className="font-mono text-ink-600">kiro/deepseek-3.2</code>. Tag{" "}
                    <code className="font-mono text-ink-600">kr/*</code> also works.
                  </span>
                ) : null}
                {selectedProvider.id === "a6api" ? (
                  <span className="block mt-0.5">
                    API keys only ·{" "}
                    <button
                      type="button"
                      className="underline text-ink-700 outline-none"
                      onClick={() =>
                        void window.lopster?.openExternal?.(
                          selectedProvider.consoleUrl || "https://a6api.com/console"
                        )
                      }
                    >
                      a6api.com/console
                    </button>
                    {" · "}
                    models manual · tag{" "}
                    <code className="font-mono text-ink-600">a6api/...</code>
                    {" · "}
                    {"any error -> next key (<=30)"}
                  </span>
                ) : null}
                {selectedProvider.id === "j3gb" ? (
                  <span className="block mt-0.5">
                    API keys only ·{" "}
                    <button
                      type="button"
                      className="underline text-ink-700 outline-none"
                      onClick={() =>
                        void window.lopster?.openExternal?.(
                          selectedProvider.consoleUrl || "https://vip.j3gb.com/"
                        )
                      }
                    >
                      vip.j3gb.com
                    </button>
                    {" · "}
                    balance via <code className="font-mono text-ink-600">/v1/usage</code>
                    {" · tag "}
                    <code className="font-mono text-ink-600">j3gb/...</code>
                    {" · "}
                    {"empty balance -> next key"}
                  </span>
                ) : null}
                </div>
              </div>

              {showApiForm && (
                <div className="proxy-detail-strip flex-wrap gap-1.5">
                  <input
                    type="password"
                    placeholder="sk-… or project key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className={`${pxInput} flex-1 min-w-[12rem] font-mono`}
                  />
                  <input
                    placeholder="Base URL"
                    value={apiBase}
                    onChange={(e) => setApiBase(e.target.value)}
                    className={`${pxInput} w-64 font-mono text-[10px]`}
                  />
                  <button
                    type="button"
                    disabled={busy || !apiKey}
                    onClick={() => void addApiKey()}
                    className={pxSolid}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowApiForm(false)}
                    className={pxGhost}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="proxy-table-wrap scrollbar-thin">
                <table className="proxy-table min-w-[720px]">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Account</th>
                      <th>Type</th>
                      <th>Route</th>
                      <th>Plan</th>
                      <th title="Primary window (OpenAI 5h / Grok monthly credits)">
                        Usage
                      </th>
                      <th title="Secondary window (OpenAI weekly / Grok SuperGrok weekly)">
                        Weekly
                      </th>
                      <th>Updated</th>
                      <th className="w-20" />
                    </tr>
                  </thead>
                  <tbody>
                    {providerAccounts.length === 0 && (
                      <tr>
                        <td colSpan={9}>
                          <div className="proxy-empty">
                            No accounts — sign in with browser or add an API key. Add several for
                            automatic failover.
                          </div>
                        </td>
                      </tr>
                    )}
                    {[...providerAccounts]
                      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
                      .map((a, idx) => {
                        const rt = a.routing;
                        const avail = rt?.available !== false && rt?.status !== "rate_limited" && rt?.status !== "quota";
                        const routeLabel = !rt
                          ? "ready"
                          : rt.available === false || rt.status === "rate_limited" || rt.status === "quota"
                            ? rt.status || "blocked"
                            : "ready";
                        const until =
                          rt?.blockedUntil && rt.blockedUntil > Date.now()
                            ? formatReset(new Date(rt.blockedUntil).toISOString())
                            : null;
                        const canUnlock =
                          Boolean(rt) &&
                          (rt?.status === "quota" ||
                            rt?.status === "rate_limited" ||
                            rt?.available === false ||
                            (typeof rt?.blockedUntil === "number" && rt.blockedUntil > Date.now()));
                        return (
                      <tr key={a.id}>
                        <td className="text-[11px] font-mono text-ink-500">{idx + 1}</td>
                        <td>
                          <div className="text-[12px] text-ink-950 truncate max-w-[12rem]">
                            {a.email || a.name}
                          </div>
                          {a.apiKeyMasked ? (
                            <div className="text-[9px] font-mono text-ink-500">{a.apiKeyMasked}</div>
                          ) : null}
                          {selectedProviderId === "gemini-cli" ? (
                            <div className="mt-0.5 flex items-center gap-1 max-w-[14rem]">
                              <span className="text-[8px] text-ink-500 shrink-0">proj</span>
                              <input
                                type="text"
                                defaultValue={a.projectId || a.workspaceId || ""}
                                placeholder="GCP project id"
                                title="Google Cloud project for Code Assist"
                                className="h-5 min-w-0 flex-1 px-1.5 rounded-md theme-input text-[9px] font-mono outline-none"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    const v = (e.target as HTMLInputElement).value.trim();
                                    if (v) void setGeminiCliProject(a.id, v);
                                  }
                                }}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  const cur = a.projectId || a.workspaceId || "";
                                  if (v && v !== cur) void setGeminiCliProject(a.id, v);
                                }}
                              />
                            </div>
                          ) : null}
                          {a.usageError ? (
                            <div className="text-[9px] text-status-err mt-0.5 max-w-[14rem] truncate" title={a.usageError}>
                              {a.usageError}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <span className="proxy-pill">
                            {a.authType}
                          </span>
                        </td>
                        <td>
                          <span className={`proxy-pill ${avail ? "is-ready" : "is-blocked"}`}>
                            {routeLabel}
                          </span>
                          {until ? (
                            <div className="text-[8px] text-ink-500 mt-0.5">until {until}</div>
                          ) : null}
                          {rt?.lastError && !avail ? (
                            <div className="text-[8px] text-ink-500 truncate max-w-[8rem]" title={rt.lastError}>
                              {rt.lastError}
                            </div>
                          ) : null}
                        </td>
                        <td className="text-[11px] text-ink-700 font-mono">
                          {a.providerId === "j3gb" ? "—" : a.planType || a.usage?.plan || "—"}
                        </td>
                        <td>
                          {a.providerId === "j3gb" || a.providerId === "deepseek" || a.usage?.balanceOnly || a.providerId === "qauth" ? (
                            <BalanceCell usage={a.usage} />
                          ) : (
                            <QuotaCell q={pickUsageQuota(a.usage)} />
                          )}
                          {a.providerId === "qauth" && a.usage?.detail?.totalTokens != null ? (
                            <div className="text-[8px] text-ink-500 mt-0.5" title={a.usage.note}>
                              {compactCount(a.usage.detail.totalTokens)} tokens
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {a.providerId === "j3gb" || a.usage?.balanceOnly ? (
                            <span className="text-ink-500">—</span>
                          ) : (
                            <QuotaCell q={pickWeeklyQuota(a.usage)} />
                          )}
                        </td>
                        <td className="text-[10px] text-ink-500 font-mono whitespace-nowrap">
                          {a.usageUpdatedAt
                            ? new Date(a.usageUpdatedAt).toLocaleTimeString(undefined, {
                                hour: "2-digit",
                                minute: "2-digit",
                              })
                            : "—"}
                        </td>
                        <td>
                          <div className="flex items-center gap-0.5 justify-end">
                            {canUnlock ? (
                              <button
                                type="button"
                                title="Clear quota / unlock account"
                                disabled={busy}
                                onClick={() => void clearAccountQuota(a.id)}
                                className="proxy-header-icon !w-7 !h-7 text-status-warn"
                              >
                                <Unlock className="w-3.5 h-3.5" />
                              </button>
                            ) : null}
                            <button
                              type="button"
                              title="Refresh"
                              onClick={() => void refreshUsage(a.id)}
                              className="proxy-header-icon !w-7 !h-7"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              title="Delete"
                              onClick={() => void deleteAccount(a.id)}
                              className="proxy-header-icon !w-7 !h-7 hover:!text-status-err"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {detailPane === "models" && (
            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <div className="proxy-detail-strip !items-start flex-col !gap-2">
                <div className="flex flex-wrap items-center gap-1.5 w-full">
                <input
                  value={modelQuery}
                  onChange={(e) => setModelQuery(e.target.value)}
                  placeholder="Filter models…"
                  className={`${pxInput} w-44`}
                />
                {providerAccounts.length > 0 && (
                  <select
                    value={modelsAccountId}
                    onChange={(e) => setModelsAccountId(e.target.value)}
                    className={`${pxInput} max-w-[12rem]`}
                    title="Account for live model list"
                  >
                    <option value="">Auto</option>
                    {providerAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email || a.name || a.id}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  disabled={modelsLoading}
                  onClick={() =>
                    selectedProviderId &&
                    void loadModels(selectedProviderId, modelsAccountId || undefined)
                  }
                  className={pxGhost}
                >
                  {modelsLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                  Refresh
                </button>
                <span className="text-[10px] text-ink-500 ml-auto font-mono">
                  {filteredModels.length}
                  {modelsSource ? ` · ${modelsSource}` : ""}
                </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 w-full">
                <Plus className="w-3.5 h-3.5 text-ink-500 flex-shrink-0" />
                <input
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addModelManual();
                  }}
                  placeholder="Add models (gpt-4o, claude… — comma or newline for several)"
                  className={`${pxInput} flex-1 min-w-[12rem] font-mono`}
                  title="One id, or several separated by comma / newline"
                />
                <button
                  type="button"
                  disabled={busy || !newModelId.trim()}
                  onClick={() => void addModelManual()}
                  className={pxQuiet}
                >
                  Add
                </button>
                </div>

              {modelsWarning && (
                <div className="text-[10px] text-ink-500 leading-relaxed w-full">
                  {modelsWarning}
                </div>
              )}
              </div>

              <div className="proxy-table-wrap scrollbar-thin">
                <table className="proxy-table min-w-[620px]">
                  <thead>
                    <tr>
                      <th>Tag / model</th>
                      <th>Bare id</th>
                      <th>Kind</th>
                      <th>Source</th>
                      <th className="w-28" />
                    </tr>
                  </thead>
                  <tbody>
                    {modelsLoading && filteredModels.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <div className="proxy-empty">Loading models…</div>
                        </td>
                      </tr>
                    )}
                    {!modelsLoading && filteredModels.length === 0 && (
                      <tr>
                        <td colSpan={5}>
                          <div className="proxy-empty">No models — add one manually above</div>
                        </td>
                      </tr>
                    )}
                    {filteredModels.map((m) => {
                      const tagged = m.taggedId || m.id;
                      return (
                      <tr key={tagged}>
                        <td>
                          <code className="text-[12px] text-ink-950 font-mono">{tagged}</code>
                          {m.name && m.name !== m.id ? (
                            <div className="text-[10px] text-ink-500 mt-0.5">{m.name}</div>
                          ) : null}
                        </td>
                        <td>
                          <code className="text-[11px] text-ink-600 font-mono">{m.id}</code>
                        </td>
                        <td>
                          <span className="proxy-pill">
                            {m.kind || "chat"}
                          </span>
                        </td>
                        <td>
                          <span className="text-[10px] font-mono text-ink-500">
                            {m.source || "catalog"}
                          </span>
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            onClick={() => void copyText(tagged, tagged)}
                            className={pxGhost}
                            title="Copy provider/model tag"
                          >
                            {copied === tagged ? "OK" : "Copy tag"}
                          </button>
                          {m.source === "manual" ? (
                            <button
                              type="button"
                              onClick={() => void removeModelManual(m.id)}
                              className={`${pxGhost} hover:!text-status-err`}
                            >
                              Del
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void importSingleModel(m.id)}
                              className={pxQuiet}
                              title={`Add ${m.id} to provider settings`}
                            >
                              Add
                            </button>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {showCustomForm && (
        <div
          className="fixed inset-0 z-50 grid place-items-center theme-scrim px-4 animate-fade-in"
          onClick={closeCustomModal}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="proxy-custom-provider-title"
            className="proxy-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="proxy-modal-head">
              <div className="w-8 h-8 rounded-xl bg-ink-900 text-ink-0 grid place-items-center text-[9px] font-semibold flex-shrink-0">
                Custom
              </div>
              <div className="min-w-0 flex-1">
                <div
                  id="proxy-custom-provider-title"
                  className="proxy-header-title"
                >
                  Add custom provider
                </div>
                <div className="text-[10px] text-ink-500 leading-tight">
                  OpenAI-compatible · keys in Accounts · multi-key rotation
                </div>
              </div>
              <button
                type="button"
                onClick={closeCustomModal}
                className="proxy-header-icon"
                title="Close"
                aria-label="Close"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="proxy-modal-body">
              <label className="block">
                <span className="proxy-field-label">Name</span>
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="My Router"
                  autoFocus
                  className="proxy-field-input"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeCustomModal();
                  }}
                />
              </label>
              <label className="block">
                <span className="proxy-field-label">Endpoint</span>
                <input
                  value={customEndpoint}
                  onChange={(e) => setCustomEndpoint(e.target.value)}
                  placeholder="https://api.example.com/v1"
                  className="proxy-field-input font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addCustomProvider();
                    if (e.key === "Escape") closeCustomModal();
                  }}
                />
              </label>
              <label className="block">
                <span className="proxy-field-label">
                  Models
                  <span className="ml-1 font-normal normal-case tracking-normal text-ink-400">
                    optional · comma or newline
                  </span>
                </span>
                <textarea
                  value={customModelsText}
                  onChange={(e) => setCustomModelsText(e.target.value)}
                  placeholder={"gpt-4o\nclaude-3-5-sonnet"}
                  rows={3}
                  className="proxy-field-textarea"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeCustomModal();
                  }}
                />
              </label>
            </div>

            <div className="proxy-modal-foot">
              <button type="button" onClick={closeCustomModal} className={pxGhost}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !customName.trim() || !customEndpoint.trim()}
                onClick={() => void addCustomProvider()}
                className={pxSolid}
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Add provider
              </button>
            </div>
          </div>
        </div>
      )}
      {ctxMenu && (
        <>
          <div
            className="fixed inset-0 z-[120]"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu(null);
            }}
          />
          <div
            className="fixed z-[121] min-w-[190px] rounded-lg p-1 shadow-xl"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 200),
              top: Math.min(ctxMenu.y, window.innerHeight - 70),
              background: "var(--surface-2)",
            }}
          >
            <button
              type="button"
              className="w-full h-8 px-2.5 rounded-md text-[12px] flex items-center gap-2 outline-none text-ink-900 hover:bg-ink-100"
              onClick={() => {
                const view = ctxMenu.view;
                setCtxMenu(null);
                if (typeof window.lopster?.openProxySubview === "function") {
                  void window.lopster.openProxySubview(view);
                } else {
                  setError(
                    "Popup window needs an app restart — main process/preload are not updated yet."
                  );
                }
              }}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in new window
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ProxyWorkspace;
