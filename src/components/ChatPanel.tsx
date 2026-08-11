import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import AsciiLogo from "./AsciiLogo";
import {
  Bookmark,
  BrainCircuit,
  Check,
  ChevronDown,
  ClipboardPaste,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FolderTree,
  History,
  ImagePlus,
  Layers,
  ListPlus,
  PenLine,
  Pencil,
  Plus,
  Save,
  Search,
  Send,
  Square,
  Sparkles,
  Trash2,
  Users,
  Wrench,
  X,
  ListTodo,
  Clock,
  Zap,
} from "lucide-react";
import {
  AgentToolProgress,
  AIModel,
  AIProvider,
  ChatBookmark,
  ChatImageAttachment,
  ChatMessage,
  ChatSessionPage,
  ChatSessionSummary,
  CompactionInfo,
  CustomTool,
  ProjectTask,
  TodoItem,
  MainAgentMode,
  TelegramBotConfig,
  TelegramBotStatus,
} from "../types";
import ContextRing from "./ContextRing";
import { ThinkingIndicator } from "./ThinkingIndicator";
import ChatMonoScroll, { type ChatMonoScrollHandle } from "./ChatMonoScroll";
import ModelPicker from "./ModelPicker";
import MarkdownContent from "./markdown/MarkdownContent";
import { computeLineDiff } from "../utils/diff";
import { INSERT_INPUT_EVENT, InsertChatInputDetail } from "../utils/mouseSnippets";

export type LiveTimelineItem =
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; toolCallId: string };

/**
 * Live roots of every mounted ChatPanel (MultiIDE = up to 4).
 * Global insert/hotkeys resolve exactly ONE target: hover first, then focus.
 * Never fan-out to all columns.
 */
const chatPanelHotkeyRoots = new Map<string, HTMLElement>();

function resolveActiveChatPanelRoot(): HTMLElement | null {
  // Hover wins (side-button mouse / cursor over a column)
  for (const el of chatPanelHotkeyRoots.values()) {
    try {
      if (el?.matches?.(":hover")) return el;
    } catch {
      /* ignore */
    }
  }
  // Fallback: panel that contains the focused element (typing in composer)
  const active = document.activeElement;
  if (active) {
    for (const el of chatPanelHotkeyRoots.values()) {
      if (el && el.contains(active)) return el;
    }
  }
  // Single panel only (side chat) — if exactly one mounted, use it
  if (chatPanelHotkeyRoots.size === 1) {
    return chatPanelHotkeyRoots.values().next().value || null;
  }
  return null;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  thinking: boolean;
  toolActivity?: AgentToolProgress[];
  assistantDrafts?: string[];
  /** Chronological live turn stream — text + tools in arrival order. */
  liveTimeline?: LiveTimelineItem[];
  /**
   * Ephemeral model think/reasoning while the turn is live.
   * Shown only during the response; never written into messages.
   */
  thinkingDraft?: string | null;
  messageQueue?: Array<{ id: string; content: string; images?: ChatImageAttachment[] }>;
  onRemoveQueuedMessage?: (id: string) => void;
  onClearMessageQueue?: () => void;
  statusLabel?: string;
  usedTokens: number;
  contextLimit: number;
  compacting: boolean;
  compactionBanner: CompactionInfo | null;
  compactNotice: { text: string; tone: "info" | "error" } | null;
  onCompact: () => void;
  sessions: ChatSessionSummary[];
  activeSessionId?: string | null;
  runningSessionIds?: Record<string, boolean>;
  onNewChat: () => void;
  onCopySession: () => void;
  onPasteSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  /** Per-chat one-shot context mode (unique to this session). */
  oneShotEnabled?: boolean;
  onToggleOneShot?: () => void;
  /** Refresh session list when history modal opens */
  onRefreshSessions?: () => void;
  autoInsertEnabled: boolean;
  autoInsertMessages: string[];
  onToggleAutoInsert: () => void;
  onAddAutoInsertMessage: (text: string) => void;
  onRemoveAutoInsertMessage: (index: number) => void;
  agentTodos: TodoItem[];
  rootPath: string | null;
  providers: AIProvider[];
  models: AIModel[];
  selectedModelId?: string;
  onSelectModel: (modelId: string) => void;
  agentMode: MainAgentMode;
  onSelectAgentMode: (mode: MainAgentMode) => void;
  thinkingMaxEnabled?: boolean;
  onToggleThinkingMax?: () => void;
  /** Send text and optional images (data URLs) together. Images-only is allowed. */
  onSend: (content: string, images?: ChatImageAttachment[]) => void;
  onStop: () => void;
  /** MultiIDE: fill parent instead of fixed resizable width */
  fill?: boolean;
  /** MultiIDE column index (0-based) for empty watermark */
  slotIndex?: number;
  /** MultiIDE slot id — enables per-chat Telegram bot settings */
  telegramSlotId?: string | null;
  labels: {
    chat: string;
    askAnything: string;
    noConversationYet?: string;
    askAnythingToStart?: string;
    send: string;
    stop: string;
    thinking: string;
    selectModel: string;
    noModelsConfigured: string;
    searchModels?: string;
    noModelsFound?: string;
    contextUsage: string;
    compacting: string;
    clickToCompact: string;
    compactedBanner: string;
    newChat: string;
    oneShot: string;
    oneShotOn: string;
    oneShotOff: string;
    chatHistory: string;
    noChatsYet: string;
    searchChats?: string;
    usedTools: string;
    tool: string;
    toolsPlural: string;
    queue: string;
    queueClear: string;
    queueWaiting: string;
    tools: string;
    autoInsert: string;
    autoInsertHint: string;
    autoInsertOn: string;
    autoInsertOff: string;
    autoInsertEmpty: string;
    autoInsertPlaceholder: string;
    autoInsertAdd: string;
    autoInsertSearch: string;
	    noResults: string;    agentTodo: string;
    agentTodoHint: string;
    agentTodoEmpty: string;
    instructions: string;
    instructionsHint: string;
    instructionsGlobal: string;
    instructionsProject: string;
    instructionsGlobalHint: string;
    instructionsProjectHint: string;
    instructionsProjectNoFolder: string;
    instructionsPlaceholder: string;
    instructionsSave: string;
	    instructionsSaved: string;
		  more?: string;
		    moreCount?: string;    collapse?: string;
    collapseUnits?: string;
    allUnitsCount?: string;
    msgsSavedTokens?: string;
    justNow?: string;
    minutesAgo?: string;
    hoursAgo?: string;
    daysAgo?: string;
  };
}

const CompactionBanner: React.FC<{ info: CompactionInfo; label: string; msgsSavedTokens?: string }> = ({
  info,
  label,
  msgsSavedTokens,
}) => {
  const saved = Math.max(info.tokensBefore - info.tokensAfter, 0);
  const suffix = (msgsSavedTokens || " · {msgs} msgs · saved ~{tokens} tokens")
    .replace("{msgs}", String(info.removedCount))
    .replace("{tokens}", saved.toLocaleString());
  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 w-[calc(100%-24px)] -translate-x-1/2 animate-fade-in">
      <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-100/95 px-3 py-2 shadow-menu backdrop-blur-sm">
        <Sparkles className="w-3.5 h-3.5 flex-shrink-0 text-ink-700" />
        <div className="min-w-0 text-[11px] text-ink-800">
          <span className="font-medium text-ink-950">{label}</span>
          <span className="text-ink-600">{suffix}</span>
        </div>
      </div>
    </div>
  );
};

/** Console-style tool ids (raw snake_case preferred over human titles). */
const TOOL_META: Record<string, { label: string }> = {
  read_file: { label: "read_file" },
  edit_file: { label: "edit_file" },
  create_file: { label: "create_file" },
  list_dir: { label: "list_dir" },
  glob: { label: "glob" },
  bash: { label: "bash" },
  wsl: { label: "wsl" },
  compact_history: { label: "compact_history" },
  todo: { label: "todo" },
  web_search: { label: "web_search" },
  web_fetch: { label: "web_fetch" },
  ask_user: { label: "ask_user" },
  ask_otp: { label: "ask_otp" },
  spawn_subagent: { label: "spawn_subagent" },
  spawn_subagent_batch: { label: "spawn_subagent_batch" },
  soviet_7_council: { label: "soviet_7_council" },
  swarm_council: { label: "swarm_council" },
  cf_mail: { label: "cf_mail" },
  restore_backup: { label: "restore_backup" },
  timezone: { label: "timezone" },
};

/** Prefer raw tool id for console look; fall back to snake-ish unknown names. */
function humanizeToolName(name?: string): string {
  const raw = String(name || "").trim();
  if (!raw) return "tool";
  return raw.replace(/\s+/g, "_");
}

function getToolMeta(name?: string): { label: string } {
  if (name && TOOL_META[name]) return TOOL_META[name];
  return { label: humanizeToolName(name) };
}

/** Display path for console lines — keep relative feel, don't dump huge absolutes mid-line. */
function consolePath(p?: string): string {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  // Prefer last 3 segments if absolute-looking
  if (/^[A-Za-z]:\//.test(s) || s.startsWith("/")) {
    const parts = s.split("/").filter(Boolean);
    if (parts.length > 3) return parts.slice(-3).join("/");
  }
  return s;
}

/** Stats for console body under $ read_file — prefers returned slice size over full totalLines. */
function extractReadFileStats(result: unknown): {
  returnedLines: number;
  totalLines: number;
  truncated: boolean;
} {
  const empty = { returnedLines: 0, totalLines: 0, truncated: false };
  if (result == null) return empty;
  if (typeof result === "object" && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    const totalLines =
      typeof rec.totalLines === "number" && Number.isFinite(rec.totalLines)
        ? Math.max(0, Math.floor(rec.totalLines))
        : 0;
    let returnedLines =
      typeof rec.returnedLines === "number" && Number.isFinite(rec.returnedLines)
        ? Math.max(0, Math.floor(rec.returnedLines))
        : 0;
    if (!returnedLines && typeof rec.content === "string") {
      returnedLines = rec.content.split(/\r?\n/).length || 0;
    }
    // Older results: only totalLines (full read) → treat as returned = total
    if (!returnedLines && totalLines) returnedLines = totalLines;
    const truncated =
      rec.truncated === true ||
      (totalLines > 0 && returnedLines > 0 && returnedLines < totalLines);
    return { returnedLines, totalLines, truncated };
  }
  if (typeof result === "string") {
    const totalM = result.match(/totalLines["\s:]+(\d+)/i);
    const retM = result.match(/returnedLines["\s:]+(\d+)/i);
    const totalLines = totalM ? parseInt(totalM[1], 10) || 0 : 0;
    const returnedLines = retM ? parseInt(retM[1], 10) || 0 : totalLines;
    const truncated = /truncated:\s*true/i.test(result) || (totalLines > 0 && returnedLines < totalLines);
    return { returnedLines, totalLines, truncated };
  }
  return empty;
}

/**
 * Resolve glob tool match count for the "N matches" chip.
 * Live path: slim object with matchCount (see summarizeToolResultForLive).
 * Historical path: dense __toolText string (files N/M … | content hits N/M …).
 * Collapsed key-list string from older live summaries → 0 (unknown).
 */
function extractGrepMatchCount(result: unknown): number {
  if (result == null) return 0;
  if (typeof result === "number" && Number.isFinite(result)) return Math.max(0, Math.floor(result));

  if (typeof result === "object" && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if (typeof rec.matchCount === "number" && Number.isFinite(rec.matchCount)) {
      return Math.max(0, Math.floor(rec.matchCount));
    }
    if (typeof rec.totalFound === "number" && Number.isFinite(rec.totalFound)) {
      return Math.max(0, Math.floor(rec.totalFound));
    }
    if (rec.metadata && typeof rec.metadata === "object") {
      const metadata = rec.metadata as Record<string, unknown>;
      if (typeof metadata.matches === "number" && Number.isFinite(metadata.matches)) {
        return Math.max(0, Math.floor(metadata.matches));
      }
    }
    if (typeof rec.__toolText === "string") return extractGrepMatchCount(rec.__toolText);
    if (Array.isArray(rec.matches)) return rec.matches.length;
    return 0;
  }

  if (typeof result === "string") {
    const text = result.trim();
    if (!text) return 0;
    // Dense format from globTool.__toolText
    const contentHits = text.match(/content hits\s+(\d+)\s*\/\s*(\d+)/i);
    if (contentHits) return Math.max(0, parseInt(contentHits[1], 10) || 0);
    const filesHits = text.match(/files\s+(\d+)\s*\/\s*(\d+)/i);
    if (filesHits) return Math.max(0, parseInt(filesHits[1], 10) || 0);
    const found = text.match(/found\s+(\d+)\s+matches?/i);
    if (found) return Math.max(0, parseInt(found[1], 10) || 0);
    // Compact JSON string (if ever stored as JSON)
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        return extractGrepMatchCount(JSON.parse(text) as unknown);
      } catch {
        /* ignore */
      }
    }
    return 0;
  }

  return 0;
}

function shortPath(p?: string): string {
  if (!p) return "";
  // Console rows show a bit more path context than a bare basename.
  const s = consolePath(p);
  const parts = s.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || s;
  return parts.slice(-2).join("/");
}

function getDomain(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function openExternalLink(url: string) {
  void window.lopster?.openExternal(url);
}

const WEB_SEARCH_COLLAPSED_COUNT = 2;

const WebSearchResults: React.FC<{
  results: { title: string; url: string; snippet?: string }[];
  moreCount?: string;
  collapse?: string;
}> = ({ results, moreCount, collapse }) => {
  const [expanded, setExpanded] = useState(false);
  if (!results.length) return null;

  const visible = expanded ? results : results.slice(0, WEB_SEARCH_COLLAPSED_COUNT);
  const hiddenCount = results.length - visible.length;
  const moreLabel = (moreCount || "more {n}").replace("{n}", String(hiddenCount));

  return (
    <div className="tool-web">
      {visible.map((result, index) => (
        <button
          key={`${result.url}-${index}`}
          onClick={() => openExternalLink(result.url)}
          className="tool-web-row"
          title={result.url}
        >
          <div className="tool-web-top">
            <span className="tool-web-domain">{getDomain(result.url)}</span>
            <span className="tool-web-title">{result.title}</span>
          </div>
          {result.snippet && <div className="tool-web-snippet">{result.snippet}</div>}
        </button>
      ))}
      {hiddenCount > 0 && (
        <button onClick={() => setExpanded(true)} className="tool-web-more">
          {moreLabel}
        </button>
      )}
      {expanded && results.length > WEB_SEARCH_COLLAPSED_COUNT && (
        <button onClick={() => setExpanded(false)} className="tool-web-more">
          {collapse || "collapse"}
        </button>
      )}
    </div>
  );
};

const WebFetchPreview: React.FC<{ url: string; title?: string; text?: string; truncated?: boolean }> = ({
  url,
  title,
  text,
  truncated,
}) => {
  return (
    <div className="tool-web">
      <button onClick={() => openExternalLink(url)} className="tool-web-row" title={url}>
        <div className="tool-web-top">
          <span className="tool-web-domain">{getDomain(url)}</span>
          <span className="tool-web-title">{title || url}</span>
        </div>
        {text && (
          <div className="tool-web-snippet">
            {text.slice(0, 160)}
            {truncated || text.length > 160 ? "…" : ""}
          </div>
        )}
      </button>
    </div>
  );
};

function getToolSubtitle(step: AgentToolProgress): string {
  const input = (step.input || {}) as Record<string, unknown>;
  switch (step.name) {
    case "read_file":
    case "edit_file":
    case "create_file":
    case "list_dir":
    case "restore_backup":
      return consolePath(input.path as string | undefined) || shortPath(input.path as string | undefined);
    case "glob":
      return input.content ? `"${input.content}"` : input.pattern ? `"${input.pattern}"` : "";
    case "bash":
    case "wsl":
      return typeof input.command === "string" ? input.command : "";
    case "compact_history":
      return input.keep_recent ? `keep_recent ${input.keep_recent}` : "";
    case "todo": {
      const action = input.action as string | undefined;
      return action || "";
    }
    case "adr": {
      const action = input.action as string | undefined;
      const title = input.title as string | undefined;
      if (action && title) return `${action} ${title}`;
      return action || title || "";
    }
    case "web_search":
      return typeof input.query === "string" ? `"${input.query}"` : "";
    case "web_fetch":
      return typeof input.url === "string" ? input.url : "";
    case "ask_user": {
      const q = typeof input.question === "string" ? input.question.trim() : "";
      return q ? (q.length > 48 ? `${q.slice(0, 48)}…` : q) : "";
    }
    case "ask_otp": {
      const action = typeof input.action === "string" ? input.action : "wait";
      if (action.startsWith("generate")) {
        const c = typeof input.country === "string" ? input.country : "";
        return c ? `generate ${c}` : "generate";
      }
      const kind = typeof input.kind === "string" ? input.kind : "otp";
      const dest =
        (typeof input.destination === "string" && input.destination) ||
        (typeof input.email === "string" && input.email) ||
        (typeof input.phone === "string" && input.phone) ||
        "";
      const site =
        (typeof input.site === "string" && input.site) ||
        (typeof input.service === "string" && input.service) ||
        "";
      const head = site ? `${kind} ${site}` : kind;
      if (dest) {
        const d = dest.length > 28 ? `${dest.slice(0, 28)}…` : dest;
        return `${head} ${d}`;
      }
      return head || "";
    }
    case "spawn_subagent": {
      const desc =
        (typeof step.description === "string" && step.description) ||
        (typeof input.description === "string" ? input.description : "") ||
        "";
      const mode =
        (typeof step.mode === "string" && step.mode) ||
        (typeof input.mode === "string" ? input.mode : "explore");
      const head = desc ? (desc.length > 40 ? `${desc.slice(0, 40)}…` : desc) : "";
      return head ? `${mode} ${head}` : mode;
    }
    case "spawn_subagent_batch":
    case "soviet_7_council":
    case "swarm_council": {
      const count =
        input.count != null
          ? Number(input.count)
          : Array.isArray(input.tasks)
            ? input.tasks.length
            : step.total || 0;
      const wave =
        step.concurrency ||
        (typeof input.concurrency === "number" ? input.concurrency : 5);
      const mode =
        (typeof step.mode === "string" && step.mode) ||
        (typeof input.mode === "string" ? input.mode : "worker");
      return count ? `${count} units x${wave} ${mode}` : `batch x${wave} ${mode}`;
    }
    case "cf_mail": {
      const action = typeof input.action === "string" ? input.action : "";
      const email =
        (typeof input.email === "string" && input.email) ||
        (typeof input.address === "string" && input.address) ||
        "";
      if (action && email) {
        const e = email.length > 28 ? `${email.slice(0, 28)}…` : email;
        return `${action} ${e}`;
      }
      return action || email || "";
    }
    default: {
      const action = typeof input.action === "string" ? input.action : "";
      const pathish =
        typeof input.path === "string"
          ? consolePath(input.path)
          : typeof input.query === "string"
            ? input.query
            : typeof input.command === "string"
              ? input.command
              : typeof input.name === "string"
                ? input.name
                : "";
      if (action && pathish) return `${action} ${pathish}`;
      if (action) return action;
      if (pathish) return pathish.length > 48 ? `${pathish.slice(0, 48)}…` : pathish;
      return "";
    }
  }
}

type AskUserResult = {
  question?: string;
  answer?: string;
  selected?: string[];
  multiSelect?: boolean;
};

type AskOtpResult = {
  action?: string;
  ok?: boolean;
  kind?: string;
  destination?: string;
  site?: string;
  question?: string;
  code?: string;
  raw?: string;
  error?: string;
  note?: string;
  identity?: Record<string, string>;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
};

const AskUserCard: React.FC<{
  toolCallId?: string;
  question: string;
  options: string[];
  multiSelect: boolean;
  allowFreeText: boolean;
  isRunning: boolean;
  result?: AskUserResult;
}> = ({ toolCallId, question, options, multiSelect, allowFreeText, isRunning, result }) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const answered = !isRunning && (result?.answer || (result?.selected && result.selected.length > 0));

  const toggle = (opt: string) => {
    if (!isRunning || submitting) return;
    if (multiSelect) {
      setSelected((cur) => (cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt]));
    } else {
      setSelected([opt]);
    }
  };

  const submit = async (override?: { selected?: string[]; answer?: string }) => {
    if (!toolCallId || submitting || !isRunning) return;
    const sel = override?.selected ?? selected;
    const text = (override?.answer ?? freeText).trim();
    if (!sel.length && !text) return;
    setSubmitting(true);
    try {
      await window.lopster?.answerUser({
        toolCallId,
        selected: sel,
        answer: text || sel.join(", "),
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Single-select: pick immediately
  const pickOne = (opt: string) => {
    if (multiSelect) {
      toggle(opt);
      return;
    }
    void submit({ selected: [opt], answer: opt });
  };

  if (answered) {
    const shown =
      (result?.selected && result.selected.length ? result.selected.join(" · ") : "") ||
      result?.answer ||
      "";
    return (
      <div className="tool-ask is-done">
        {question && <div className="tool-ask-q">{question}</div>}
        <div className="tool-ask-a">→ {shown}</div>
      </div>
    );
  }

  if (!isRunning) return null;

  return (
    <div className="tool-ask is-live">
      {question && <div className="tool-ask-q">{question}</div>}
      {options.length > 0 && (
        <div className="tool-ask-opts">
          {options.map((opt) => {
            const on = selected.includes(opt);
            return (
              <button
                key={opt}
                type="button"
                disabled={submitting}
                onClick={() => pickOne(opt)}
                className={`tool-ask-opt ${on ? "is-on" : ""}`}
              >
                <span className="tool-ask-mark" aria-hidden>
                  {multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}
                </span>
                <span className="tool-ask-opt-label">{opt}</span>
              </button>
            );
          })}
        </div>
      )}
      {(allowFreeText || multiSelect) && (
        <div className="tool-ask-footer">
          {allowFreeText && (
            <input
              type="text"
              value={freeText}
              disabled={submitting}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={options.length ? "Or type your own…" : "Type your answer…"}
              className="tool-ask-input"
            />
          )}
          {(multiSelect || allowFreeText) && (
            <button
              type="button"
              disabled={submitting || (!selected.length && !freeText.trim())}
              onClick={() => void submit()}
              className="tool-ask-send"
            >
              {submitting ? "…" : "Send"}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/** Clean OTP / verification-code pause card (blocks agent until human pastes code). */
const AskOtpCard: React.FC<{
  toolCallId?: string;
  kind: string;
  destination: string;
  site: string;
  question: string;
  digits: number;
  isRunning: boolean;
  result?: AskOtpResult;
}> = ({ toolCallId, kind, destination, site, question, digits, isRunning, result }) => {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const answered = !isRunning && !!(result?.code || result?.raw || result?.error);

  const kindLabel =
    kind === "email" || kind === "mail"
      ? "Email code"
      : kind === "sms" || kind === "phone" || kind === "call"
        ? "SMS code"
        : kind === "app" || kind === "totp" || kind === "2fa"
          ? "App / 2FA"
          : "Verification code";

  const submit = async () => {
    if (!toolCallId || submitting || !isRunning) return;
    const text = code.trim();
    if (!text) return;
    setSubmitting(true);
    try {
      await window.lopster?.answerUser({
        toolCallId,
        selected: [],
        answer: text,
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (answered) {
    const shown = result?.code || result?.raw || result?.error || "";
    const masked =
      shown && shown.length > 2 && !result?.error
        ? `${shown.slice(0, 2)}${"•".repeat(Math.min(8, Math.max(0, shown.length - 2)))}`
        : shown;
    return (
      <div className="tool-ask tool-otp is-done">
        <div className="tool-otp-head">
          <span className="tool-otp-badge">{kindLabel}</span>
          {site ? <span className="tool-otp-site">{site}</span> : null}
        </div>
        {destination ? <div className="tool-otp-dest">{destination}</div> : null}
        <div className="tool-ask-a">→ {result?.error ? result.error : masked || "received"}</div>
      </div>
    );
  }

  if (!isRunning) return null;

  const ph = digits > 0 ? `${digits}-digit code…` : "Paste code…";

  return (
    <div className="tool-ask tool-otp is-live">
      <div className="tool-otp-head">
        <span className="tool-otp-badge is-live">{kindLabel}</span>
        {site ? <span className="tool-otp-site">{site}</span> : null}
      </div>
      {destination ? (
        <div className="tool-otp-dest" title={destination}>
          → {destination}
        </div>
      ) : null}
      {question ? <div className="tool-ask-q tool-otp-q">{question}</div> : null}
      <div className="tool-ask-footer tool-otp-footer">
        <input
          type="text"
          inputMode={digits > 0 ? "numeric" : "text"}
          autoComplete="one-time-code"
          autoFocus
          value={code}
          disabled={submitting}
          maxLength={digits > 0 ? digits + 4 : 64}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={ph}
          className="tool-ask-input tool-otp-input"
        />
        <button
          type="button"
          disabled={submitting || !code.trim()}
          onClick={() => void submit()}
          className="tool-ask-send tool-otp-send"
        >
          {submitting ? "…" : "Continue"}
        </button>
      </div>
      <div className="tool-otp-hint">Agent paused — paste the code, then Continue</div>
    </div>
  );
};

const DiffPreview: React.FC<{ oldText: string; newText: string }> = ({ oldText, newText }) => {
  const diff = useMemo(() => computeLineDiff(oldText, newText), [oldText, newText]);

  const preview = useMemo(() => {
    const contextRadius = 1;
    const rows: { line: (typeof diff)[number]; index: number }[] = [];
    const changed = new Uint8Array(diff.length);
    let added = 0;
    let removed = 0;
    let changedCount = 0;

    diff.forEach((line, index) => {
      if (line.type === "add") added += 1;
      if (line.type === "remove") removed += 1;
      if (line.type !== "same") {
        changedCount += 1;
        for (let cursor = Math.max(0, index - contextRadius); cursor <= Math.min(diff.length - 1, index + contextRadius); cursor += 1) {
          changed[cursor] = 1;
        }
      }
    });

    for (let index = 0; index < diff.length && rows.length < 28; index += 1) {
      if (changed[index]) rows.push({ line: diff[index], index });
    }

    const visibleChanged = rows.reduce(
      (count, row) => count + (row.line.type !== "same" ? 1 : 0),
      0,
    );
    return { rows, added, removed, hidden: changedCount - visibleChanged };
  }, [diff]);

  const { rows: visible, added, removed, hidden } = preview;

  return (
    <div className="tool-diff">
      <div className="tool-diff-meta">
        <span className="tool-diff-stat add">+{added}</span>
        <span className="tool-diff-stat del">−{removed}</span>
      </div>
      <div className="tool-diff-lines">
        {visible.map(({ line, index }) => {
          const kind = line.type === "add" ? "add" : line.type === "remove" ? "del" : "ctx";
          const mark = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
          return (
            <div key={index} className={`tool-diff-line ${kind}`}>
              <span className="tool-diff-mark" aria-hidden>
                {mark}
              </span>
              <span className="tool-diff-text">{line.text || " "}</span>
            </div>
          );
        })}
        {hidden > 0 && <div className="tool-diff-more">  … {hidden} more</div>}
      </div>
    </div>
  );
};

const ChangedFilesSummary: React.FC<{ steps: AgentToolProgress[]; rootPath: string | null }> = ({ steps, rootPath }) => {
  const changes = useMemo(() => {
    const byPath = new Map<string, { additions: number; deletions: number }>();
    for (const step of steps) {
      if (step.type !== "tool_end" || !step.ok) continue;
      if (step.name !== "create_file" && step.name !== "edit_file") continue;
      const input = step.input && typeof step.input === "object" ? (step.input as Record<string, unknown>) : {};
      const filePath = typeof input.path === "string" ? input.path : "";
      if (!filePath) continue;
      const current = byPath.get(filePath) || { additions: 0, deletions: 0 };
      if (step.name === "create_file") {
        const content = typeof input.content === "string" ? input.content : "";
        const lines = content ? content.split(/\r?\n/) : [];
        current.additions += lines.length - (lines.length > 0 && lines[lines.length - 1] === "" ? 1 : 0);
      } else {
        const oldText = typeof input.old_string === "string" ? input.old_string : "";
        const newText = typeof input.new_string === "string" ? input.new_string : "";
        const diff = computeLineDiff(oldText, newText);
        current.additions += diff.filter((line) => line.type === "add").length;
        current.deletions += diff.filter((line) => line.type === "remove").length;
      }
      byPath.set(filePath, current);
    }
    return [...byPath.entries()].map(([path, stats]) => ({ path, ...stats }));
  }, [steps]);

  if (!changes.length) return null;
  const additions = changes.reduce((sum, item) => sum + item.additions, 0);
  const deletions = changes.reduce((sum, item) => sum + item.deletions, 0);
  const displayPath = (filePath: string) => {
    if (!rootPath) return filePath;
    const root = rootPath.replace(/[\\/]$/, "").replace(/\\/g, "/");
    const file = filePath.replace(/\\/g, "/");
    if (file.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return file.slice(root.length + 1);
    return filePath;
  };
  return (
    <div className="changed-files-summary" aria-label="Changed files">
      <div className="changed-files-title">
        {changes.length} Changed files
        <span className="changed-files-add">+{additions}</span>
        <span className="changed-files-del">-{deletions}</span>
      </div>
      <div className="changed-files-list">
        {changes.map((item) => (
          <div className="changed-file-row" key={item.path}>
            <span className="changed-file-path" title={item.path}>{displayPath(item.path)}</span>
            <span className="changed-files-add">+{item.additions}</span>
            <span className="changed-files-del">-{item.deletions}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

type SubagentResult = {
  agentId?: string;
  description?: string;
  mode?: string;
  ok?: boolean;
  stopped?: boolean;
  answer?: string;
  total?: number;
  ok_count?: number;
  fail_count?: number;
  concurrency?: number;
  results?: Array<{
    agentId?: string;
    jobId?: string;
    description?: string;
    status?: "done" | "error" | "missing";
    ok?: boolean;
    stopped?: boolean;
    index?: number;
    answer?: string;
    error?: string;
    result?: {
      agentId?: string;
      index?: number;
      description?: string;
      ok?: boolean;
      stopped?: boolean;
      answer?: string;
      error?: string;
    };
  }>;
  summary?: string;
  /** Background spawn acknowledgement: scheduled, but not joined yet. */
  background?: boolean;
  /** wait_subagents aggregate result. */
  failed?: number;
};

/**
 * Nested tool under a subagent unit — for ask_user / ask_otp wait show full answer cards
 * so the human can reply and that subagent continues (works for 2+ parallel asks).
 */
const SubagentChildTool: React.FC<{
  child: AgentToolProgress;
  unitLabel?: string;
}> = ({ child, unitLabel }) => {
  const childMeta = getToolMeta(child.name);
  const childSub = getToolSubtitle(child);
  const childRunning = child.type === "tool_start";
  const input = (child.input || {}) as Record<string, unknown>;
  const isAskUser = child.name === "ask_user";
  const otpAction = typeof input.action === "string" ? input.action : "wait";
  const otpIsWait = child.name === "ask_otp" && !String(otpAction).startsWith("generate");
  const askResult =
    isAskUser && child.type === "tool_end" && child.ok && child.result && typeof child.result === "object"
      ? (child.result as AskUserResult)
      : undefined;
  const otpResult =
    otpIsWait && child.type === "tool_end" && child.ok && child.result && typeof child.result === "object"
      ? (child.result as AskOtpResult)
      : undefined;
  const askQuestion =
    typeof input.question === "string" ? input.question : askResult?.question || "";
  const askOptions = Array.isArray(input.options)
    ? (input.options as unknown[]).map((o) => String(o || "").trim()).filter(Boolean)
    : [];
  const askMulti = input.multi_select === true;
  const askFree = input.allow_free_text !== false;
  const otpKind = typeof input.kind === "string" ? input.kind : otpResult?.kind || "otp";
  const otpDestination =
    (typeof input.destination === "string" && input.destination) ||
    (typeof input.email === "string" && input.email) ||
    (typeof input.phone === "string" && input.phone) ||
    otpResult?.destination ||
    "";
  const otpSite =
    (typeof input.site === "string" && input.site) ||
    (typeof input.service === "string" && input.service) ||
    otpResult?.site ||
    "";
  const otpQuestion =
    (typeof input.message === "string" && input.message) || otpResult?.question || "";
  const otpDigits = Math.max(0, Math.min(12, Number(input.digits) || 0));

  return (
    <div
      className={`tool-subagent-child ${
        childRunning ? "is-running" : child.ok === false ? "is-fail" : "is-done"
      }${isAskUser || otpIsWait ? " is-ask-child" : ""}`}
    >
      <div className="tool-subagent-child-line">
        <span className="tool-prompt" aria-hidden>
          $
        </span>
        <span className="tool-subagent-child-name">{childMeta.label}</span>
        {unitLabel && (isAskUser || otpIsWait) && (
          <span className="tool-subagent-child-unit" title={unitLabel}>
            {unitLabel}
          </span>
        )}
        {childSub && (
          <span className="tool-subagent-child-sub" title={childSub}>
            {childSub}
          </span>
        )}
      </div>
      {isAskUser && (
        <AskUserCard
          toolCallId={child.toolCallId}
          question={askQuestion}
          options={askOptions}
          multiSelect={askMulti}
          allowFreeText={askFree}
          isRunning={childRunning}
          result={askResult}
        />
      )}
      {otpIsWait && (
        <AskOtpCard
          toolCallId={child.toolCallId}
          kind={otpKind}
          destination={otpDestination}
          site={otpSite}
          question={otpQuestion}
          digits={otpDigits}
          isRunning={childRunning}
          result={otpResult}
        />
      )}
    </div>
  );
};

const SubagentCard: React.FC<{
  step: AgentToolProgress;
  isRunning: boolean;
  failed: boolean;
  result?: SubagentResult;
  more?: string;
  collapse?: string;
  collapseUnits?: string;
  allUnitsCount?: string;
}> = React.memo(({ step, isRunning, failed, result, more, collapse, collapseUnits, allUnitsCount }) => {
  const [expanded, setExpanded] = useState(false);
  // Keep subagents compact by default: the live header is enough unless the
  // person wants to inspect individual workers or their nested tool activity.
  const [showUnits, setShowUnits] = useState(false);
  const [showAllUnits, setShowAllUnits] = useState(false);
  const input = (step.input || {}) as Record<string, unknown>;
  const isWait = step.name === "wait_subagents";
  const isBatch =
    step.name === "spawn_subagent_batch" ||
    step.name === "soviet_7_council" ||
    step.name === "swarm_council" ||
    step.batch === true ||
    Boolean(result?.results && Array.isArray(result.results));
  const desc =
    step.description ||
    result?.description ||
    result?.summary ||
    (typeof input.description === "string" ? input.description : "") ||
    (isWait ? "background agents" : isBatch ? "batch" : "subagent");
  const mode =
    isWait
      ? "wait"
      : step.mode || result?.mode || (typeof input.mode === "string" ? input.mode : isBatch ? "worker" : "explore");
  // Council / batch may attach the resolved API model — show name, not a stale config id.
  const modelLabel = String(
    step.displayLabel ||
      step.modelName ||
      (result as { displayLabel?: string; modelName?: string } | undefined)?.displayLabel ||
      (result as { modelName?: string } | undefined)?.modelName ||
      ""
  ).trim();
  const total = step.total ?? result?.total ?? (result?.results?.length || 0);
  const completed =
    step.completed ??
    (result
      ? (result.ok_count || 0) + (result.fail_count || 0)
      : undefined);
  const statusText = isRunning
    ? step.statusText ||
      (isBatch && total
        ? `${completed != null ? completed : 0}/${total} · wave ${step.concurrency || input.concurrency || 5}`
        : isWait
          ? "joining background jobs…"
          : "running…")
    : failed
      ? "failed"
      : result?.stopped
        ? "stopped"
        : isWait && result
          ? `joined ${result.total ?? 0} · failed ${result.failed ?? 0}`
          : result?.background === true
            ? "running in background"
            : isBatch && result
            ? `ok ${result.ok_count ?? 0} · fail ${result.fail_count ?? 0}`
            : "done";
  // Live units from MultiChatSlot merge; after finish, fall back to result.results
  const liveUnits = step.units || [];
  const resultUnits =
    !isRunning && result?.results
      ? result.results.map((r, i) => {
          const joined = r.result || r;
          const ok = joined.ok ?? r.status === "done";
          const stopped = joined.stopped;
          return {
            agentId: joined.agentId || r.jobId || `res-${i}`,
            index: joined.index ?? r.index ?? i,
            description: joined.description || r.description || `unit ${i + 1}`,
            status: stopped ? "stopped" : ok ? "done" : "error",
            statusText: ok ? "done" : String(joined.error || r.error || joined.answer || "fail").slice(0, 80),
            answer: joined.answer,
            ok,
            children: [] as AgentToolProgress[],
          };
        })
      : [];
  const units = liveUnits.length ? liveUnits : resultUnits;
  // Nested tools: prefer parent.children; single spawn usually stores under units[].children (agentId set)
  const parentChildren = (step.children || []).filter((child) => child.name);
  const unitFlatChildren = units.flatMap((u) => (u.children || []).filter((c) => c.name));
  const liveChildren = parentChildren.length ? parentChildren : unitFlatChildren;
  // Multi single-spawn under one parent? if multiple units without batch flag, show unit rows
  const multiUnitSingle = !isBatch && units.length > 1;
  const answer = result?.answer?.trim() || result?.summary?.trim() || "";
  const answerPreview = answer
    ? answer.length > 280
      ? `${answer.slice(0, 280)}…`
      : answer
    : "";

  return (
    <div
      className={`tool-subagent ${isBatch || multiUnitSingle ? "is-batch" : ""} ${
        isRunning ? "is-live" : failed ? "is-fail" : "is-done"
      }`}
    >
      <div className="tool-subagent-head">
        <span className="tool-prompt" aria-hidden>
          ›
        </span>
        <span className="tool-subagent-title" title={desc}>
          {desc}
        </span>
        <span className="tool-subagent-mode">{mode}</span>
        {modelLabel ? (
          <span className="tool-subagent-mode" title={`Model: ${modelLabel}`}>
            {modelLabel}
          </span>
        ) : null}
        {(isBatch || multiUnitSingle) && (total || units.length) ? (
          <span className="tool-subagent-count">
            {completed != null && total
              ? `${completed}/${total}`
              : `${units.length || total || ""}`}
          </span>
        ) : null}
        <span className="tool-subagent-status">{statusText}</span>
        {(isBatch || multiUnitSingle) && units.length > 0 && (
          <button
            type="button"
            className="tool-subagent-toggle"
            onClick={() => setShowUnits((value) => !value)}
            aria-expanded={showUnits}
            title={showUnits ? "hide agents" : "show agents"}
          >
            {showUnits ? "hide" : "agents"}
          </button>
        )}
      </div>

      {/* Batch / multi-unit: intentionally collapsed so concurrent workers never
          take over the chat; explicit expansion exposes the live unit list. */}
      {(isBatch || multiUnitSingle) && units.length > 0 && showUnits && (
        <div className="tool-subagent-units">
          {(showAllUnits ? units : units.slice(0, 8)).map((unit, ui) => {
            const uRunning = unit.status === "running" || unit.status === "queued";
            const uFail = unit.status === "error" || unit.ok === false;
            const uDone = unit.status === "done" || unit.ok === true;
            const uChildren = (unit.children || []).filter((c) => c.name);
            return (
              <div
                key={unit.agentId || `u-${unit.index ?? ui}`}
                className={`tool-subagent-unit ${
                  uRunning ? "is-running" : uFail ? "is-fail" : uDone ? "is-done" : ""
                }`}
              >
                <div className="tool-subagent-unit-head">
                  <span className="tool-subagent-unit-idx">
                    #{(unit.index != null ? unit.index : ui) + 1}
                  </span>
                  <span className="tool-subagent-unit-title" title={unit.description || ""}>
                    {unit.description || `unit ${(unit.index ?? ui) + 1}`}
                  </span>
                  <span className="tool-subagent-unit-status">
                    {unit.statusText || unit.status || ""}
                  </span>
                </div>
                {uChildren.length > 0 && (
                  <div className="tool-subagent-children">
                    {uChildren.slice(-8).map((child, ci) => (
                      <SubagentChildTool
                        key={`${child.toolCallId || child.name}-${ci}`}
                        child={child}
                        unitLabel={unit.description || `unit ${(unit.index ?? ui) + 1}`}
                      />
                    ))}
                  </div>
                )}
                {!uRunning && unit.answer && (
                  <div className="tool-subagent-unit-answer">
                    {String(unit.answer).length > 160
                      ? `${String(unit.answer).slice(0, 160)}…`
                      : unit.answer}
                  </div>
                )}
              </div>
            );
          })}
          {units.length > 8 && (
            <button
              type="button"
              className="tool-subagent-more"
              onClick={() => setShowAllUnits((v) => !v)}
            >
              {showAllUnits
                ? collapseUnits || "collapse units"
                : (allUnitsCount || "all {n} units").replace("{n}", String(units.length))}
            </button>
          )}
        </div>
      )}

      {/* Single spawn: nested tools + full ask cards (from children or unit[0]) */}
      {!isBatch && !multiUnitSingle && liveChildren.length > 0 && (
        <div className="tool-subagent-children">
          {liveChildren.slice(-8).map((child, index) => (
            <SubagentChildTool
              key={`${child.toolCallId || child.name}-${index}`}
              child={child}
              unitLabel={desc}
            />
          ))}
        </div>
      )}

      {!isRunning && answerPreview && (
        <div className="tool-subagent-answer">
          {expanded || answer.length <= 280 ? answer : answerPreview}
          {answer.length > 280 && (
            <button
              type="button"
              className="tool-subagent-more"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? collapse || "collapse" : more || "more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

const ToolActivityRow: React.FC<{
  step: AgentToolProgress;
  more?: string;
  moreCount?: string;
  collapse?: string;
  collapseUnits?: string;
  allUnitsCount?: string;
}> = React.memo(({ step, more, moreCount, collapse, collapseUnits, allUnitsCount }) => {
  const meta = getToolMeta(step.name);
  const subtitle = getToolSubtitle(step);
  const input = (step.input || {}) as Record<string, unknown>;
  const rawIsRunning = step.type === "tool_start";
  const failed = step.type === "tool_end" && step.ok === false;

  const bashResult =
    step.name === "bash" || step.name === "wsl" ? (step.result as { stdout?: string; stderr?: string } | undefined) : undefined;
  const bashOutput = bashResult ? (bashResult.stdout || bashResult.stderr || "").trim() : "";
  // Live path keeps slim { matchCount }; historical path stores dense __toolText string.
  const grepMatchCount = step.name === "grep" ? extractGrepMatchCount(step.result) : 0;
  const readStats =
    step.name === "read_file" ? extractReadFileStats(step.result) : null;
  const webSearchResult =
    step.name === "web_search"
      ? (step.result as { results?: { title: string; url: string; snippet?: string }[]; engine?: string } | undefined)
      : undefined;
  const webFetchResult =
    step.name === "web_fetch"
      ? (step.result as { url?: string; title?: string; text?: string; truncated?: boolean } | undefined)
      : undefined;
  const askResult =
    step.name === "ask_user" && step.type === "tool_end" && step.ok && step.result && typeof step.result === "object"
      ? (step.result as AskUserResult)
      : undefined;
  const otpResult =
    step.name === "ask_otp" && step.type === "tool_end" && step.ok && step.result && typeof step.result === "object"
      ? (step.result as AskOtpResult)
      : undefined;
  const isSubTool =
    step.name === "spawn_subagent" ||
    step.name === "spawn_subagent_batch" ||
    step.name === "wait_subagents" ||
    step.name === "soviet_7_council" ||
    step.name === "swarm_council";
  const subResult =
    isSubTool && step.result && typeof step.result === "object"
      ? (step.result as SubagentResult)
      : undefined;
  const isBackgroundSpawn =
    (step.name === "spawn_subagent" || step.name === "spawn_subagent_batch") &&
    subResult?.background === true;
  const isRunning = rawIsRunning || isBackgroundSpawn;
  const askQuestion =
    typeof input.question === "string" ? input.question : askResult?.question || "";
  const askOptions = Array.isArray(input.options)
    ? (input.options as unknown[]).map((o) => String(o || "").trim()).filter(Boolean)
    : [];
  const askMulti = input.multi_select === true;
  const askFree = input.allow_free_text !== false;
  const otpAction = typeof input.action === "string" ? input.action : "wait";
  const otpIsWait = step.name === "ask_otp" && !String(otpAction).startsWith("generate");
  const otpKind = typeof input.kind === "string" ? input.kind : otpResult?.kind || "otp";
  const otpDestination =
    (typeof input.destination === "string" && input.destination) ||
    (typeof input.email === "string" && input.email) ||
    (typeof input.phone === "string" && input.phone) ||
    otpResult?.destination ||
    "";
  const otpSite =
    (typeof input.site === "string" && input.site) ||
    (typeof input.service === "string" && input.service) ||
    otpResult?.site ||
    "";
  const otpQuestion =
    (typeof input.message === "string" && input.message) ||
    otpResult?.question ||
    "";
  const otpDigits = Math.max(0, Math.min(12, Number(input.digits) || 0));

  const stateClass = isRunning ? "is-running" : failed ? "is-fail" : "is-done";

  // Heavy/verbose tool payloads (diffs, bash output, web previews) render ONLY
  // after the user expands the row — the collapsed row is a single lightweight line.
  const hasDetails =
    step.name === "edit_file" ||
    step.name === "create_file" ||
    step.name === "bash" ||
    step.name === "wsl" ||
    step.name === "read_file" ||
    step.name === "grep" ||
    step.name === "web_search" ||
    step.name === "web_fetch";

  const [open, setOpen] = useState(false);

  return (
    <div
      className={`tool-row ${stateClass}${open ? " is-open" : ""}${
        step.name === "ask_user" || otpIsWait ? " is-ask" : ""
      }${isSubTool ? " is-subagent" : ""}${
        step.name === "spawn_subagent_batch" || step.name === "soviet_7_council" || step.name === "swarm_council" ? " is-batch" : ""
      }${
        step.name === "ask_otp" ? " is-otp" : ""
      }`}
      data-tool={step.name || undefined}
    >
      <div
        className={`tool-line${hasDetails ? " is-toggle" : ""}`}
        role={hasDetails ? "button" : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        aria-expanded={hasDetails ? open : undefined}
        title={hasDetails ? (open ? "collapse details" : "show details") : undefined}
        onClick={hasDetails ? () => setOpen((value) => !value) : undefined}
        onKeyDown={
          hasDetails
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setOpen((value) => !value);
                }
              }
            : undefined
        }
      >
        <span className="tool-prompt" aria-hidden>
          $
        </span>
        <span className="tool-name" title={step.name || meta.label}>
          {meta.label}
        </span>
        {subtitle && (
          <span className="tool-sub" title={subtitle}>
            {subtitle}
          </span>
        )}
        <span className="tool-status-mark" aria-hidden>
          {isRunning ? "…" : failed ? "✕" : "✓"}
        </span>
        {hasDetails && (
          <span className="tool-chev" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        )}
      </div>

      {step.name === "ask_user" && (
        <AskUserCard
          toolCallId={step.toolCallId}
          question={askQuestion}
          options={askOptions}
          multiSelect={askMulti}
          allowFreeText={askFree}
          isRunning={isRunning}
          result={askResult}
        />
      )}

      {step.name === "ask_otp" && otpIsWait && (
        <AskOtpCard
          toolCallId={step.toolCallId}
          kind={otpKind}
          destination={otpDestination}
          site={otpSite}
          question={otpQuestion}
          digits={otpDigits}
          isRunning={isRunning}
          result={otpResult}
        />
      )}

      {step.name === "ask_otp" && !otpIsWait && step.type === "tool_end" && step.ok && otpResult && (
        <div className="tool-body">
          <div className="tool-body-line">
            →{" "}
            {otpResult.email ||
              otpResult.phone ||
              otpResult.full_name ||
              otpResult.identity?.email ||
              otpResult.identity?.phone ||
              otpResult.action ||
              "generated"}
          </div>
        </div>
      )}

      {isSubTool && (
        <SubagentCard
          step={step}
          isRunning={isRunning}
          failed={failed}
          result={subResult}
          more={more}
          collapse={collapse}
          collapseUnits={collapseUnits}
          allUnitsCount={allUnitsCount}
        />
      )}

      {open && (
        <>
          {step.name === "read_file" &&
            step.type === "tool_end" &&
            step.ok &&
            readStats &&
            (readStats.returnedLines > 0 || readStats.totalLines > 0) && (
              <div className="tool-body">
                <div className="tool-body-line">
                  {readStats.truncated && readStats.totalLines > 0
                    ? `… ${readStats.returnedLines} / ${readStats.totalLines} lines`
                    : `… ${readStats.returnedLines || readStats.totalLines} lines`}
                </div>
              </div>
            )}

          {step.name === "edit_file" &&
            typeof input.old_string === "string" &&
            typeof input.new_string === "string" && (
              <DiffPreview
                oldText={input.old_string as string}
                newText={input.new_string as string}
              />
            )}

          {step.name === "create_file" &&
            typeof input.content === "string" &&
            input.content.length > 0 && <DiffPreview oldText="" newText={input.content as string} />}

          {(step.name === "bash" || step.name === "wsl") && step.type === "tool_end" && step.ok && bashOutput && (
            <div className="tool-body">
              <pre className="tool-detail-pre">
                {bashOutput.split("\n").slice(0, 8).join("\n")}
              </pre>
            </div>
          )}

          {step.name === "grep" && step.type === "tool_end" && step.ok && (
            <div className="tool-body">
              <div className="tool-body-line">
                … {grepMatchCount} match{grepMatchCount === 1 ? "" : "es"}
              </div>
            </div>
          )}

          {step.name === "web_search" && step.type === "tool_end" && step.ok && (
            <WebSearchResults
              results={webSearchResult?.results ?? []}
              moreCount={moreCount}
              collapse={collapse}
            />
          )}

          {step.name === "web_fetch" && step.type === "tool_end" && step.ok && webFetchResult?.url && (
            <WebFetchPreview
              url={webFetchResult.url}
              title={webFetchResult.title}
              text={webFetchResult.text}
              truncated={webFetchResult.truncated}
            />
          )}
        </>
      )}

      {failed && step.result != null && !isSubTool && (
        <div className="tool-body">
          <div className="tool-body-line is-fail">{String(step.result).slice(0, 400)}</div>
        </div>
      )}
    </div>
  );
});

const ToolActivityList: React.FC<{
  steps: AgentToolProgress[];
  more?: string;
  moreCount?: string;
  collapse?: string;
  collapseUnits?: string;
  allUnitsCount?: string;
}> = React.memo(({ steps, more, moreCount, collapse, collapseUnits, allUnitsCount }) => {
  const visibleSteps = steps.filter((step) => step.name);
  if (visibleSteps.length === 0) return null;

  return (
    <div className="tool-stack">
      {visibleSteps.map((step, index) => (
        <ToolActivityRow
          key={`${step.toolCallId || step.name}-${index}`}
          step={step}
          more={more}
          moreCount={moreCount}
          collapse={collapse}
          collapseUnits={collapseUnits}
          allUnitsCount={allUnitsCount}
        />
      ))}
    </div>
  );
});

/** Prefer completed tool_end rows; fall back to unique named tools so the bar never vanishes. */
function collectHistoricalToolSteps(steps: AgentToolProgress[]): AgentToolProgress[] {
  if (!Array.isArray(steps) || steps.length === 0) return [];

  const ended = steps.filter(
    (step) =>
      step.name &&
      (step.type === "tool_end" || step.ok !== undefined || step.result !== undefined)
  );
  if (ended.length > 0) {
    // Dedupe by toolCallId (keep last), keep order of first appearance.
    const byId = new Map<string, AgentToolProgress>();
    const order: string[] = [];
    ended.forEach((step, index) => {
      const key = step.toolCallId || `${step.name}-${index}`;
      if (!byId.has(key)) order.push(key);
      byId.set(key, step);
    });
    return order.map((key) => byId.get(key)!);
  }

  // Fallback: unique named tool rows (e.g. only tool_start survived in history).
  const byId = new Map<string, AgentToolProgress>();
  const order: string[] = [];
  steps.forEach((step, index) => {
    if (!step.name) return;
    if (step.type === "assistant_text" || step.type === "todo_update" || step.type === "context_usage") {
      return;
    }
    const key = step.toolCallId || `${step.name}-${index}`;
    if (!byId.has(key)) order.push(key);
    byId.set(key, step);
  });
  return order.map((key) => byId.get(key)!);
}

const HistoricalToolSteps: React.FC<{
  steps: AgentToolProgress[];
  usedLabel: string;
  toolLabel: string;
  toolsPluralLabel: string;
  more?: string;
  moreCount?: string;
  collapse?: string;
  collapseUnits?: string;
  allUnitsCount?: string;
}> = ({ steps, usedLabel, toolLabel, toolsPluralLabel, more, moreCount, collapse, collapseUnits, allUnitsCount }) => {
  const [expanded, setExpanded] = useState(false);
  const finished = collectHistoricalToolSteps(steps);
  if (finished.length === 0) return null;

  const count = finished.length;

  return (
    <div className="tool-history">
      <button
        onClick={() => setExpanded((value) => !value)}
        className={`tool-history-btn ${expanded ? "is-open" : ""}`}
      >
        <span className="tool-prompt" aria-hidden>
          $
        </span>
        <span className="tool-history-label">
          {usedLabel} {count} {count === 1 ? toolLabel : toolsPluralLabel}
        </span>
        <span className="tool-history-chevron" aria-hidden>
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div className="tool-history-panel">
          <ToolActivityList
            steps={finished}
            more={more}
            moreCount={moreCount}
            collapse={collapse}
            collapseUnits={collapseUnits}
            allUnitsCount={allUnitsCount}
          />
        </div>
      )}
    </div>
  );
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < day * 7) return `${Math.floor(diff / day)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const sortProjectTasks = (tasks: ProjectTask[]): ProjectTask[] =>
  [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) return (b.updatedAt || 0) - (a.updatedAt || 0);
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

const ProjectTasksModal: React.FC<{
  rootPath: string | null;
  onClose: () => void;
}> = ({ rootPath, onClose }) => {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [modalMode, setModalMode] = useState<"list" | "create" | "edit">("list");
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null);
  const [saving, setSaving] = useState(false);
  const submittingRef = useRef(false);

  const projectLabel = rootPath
    ? rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || rootPath
    : null;

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modalMode !== "list") {
        setModalMode("list");
        setEditingTask(null);
        setDraftText("");
        setNotice(null);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [modalMode, onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setModalMode("list");
    setEditingTask(null);
    setDraftText("");
    if (!rootPath) {
      setTasks([]);
      setLoading(false);
      return;
    }
    window.lopster
      ?.readTasks(rootPath)
      .then((list) => {
        if (!cancelled) setTasks(sortProjectTasks(list || []));
      })
      .catch(() => {
        if (!cancelled) {
          setTasks([]);
          setNotice("Failed to load tasks");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const persistTasks = async (next: ProjectTask[]) => {
    if (!rootPath) return;
    const sorted = sortProjectTasks(next);
    setTasks(sorted);
    try {
      const saved = await window.lopster?.saveTasks(rootPath, sorted);
      setTasks(sortProjectTasks(saved || sorted));
      setNotice(null);
    } catch {
      setNotice("Failed to save tasks");
    }
  };

  const openCreate = () => {
    if (!rootPath) return;
    setEditingTask(null);
    setDraftText("");
    setNotice(null);
    setModalMode("create");
  };

  const openEdit = (task: ProjectTask) => {
    setEditingTask(task);
    setDraftText(task.text);
    setNotice(null);
    setModalMode("edit");
  };

  const backToList = () => {
    setModalMode("list");
    setEditingTask(null);
    setDraftText("");
    setNotice(null);
  };

  const handleSaveDraft = async () => {
    if (!rootPath || submittingRef.current) return;
    const text = draftText.trim();
    if (!text) {
      setNotice("Title is required");
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    try {
      const now = Date.now();
      if (modalMode === "edit" && editingTask) {
        await persistTasks(
          tasks.map((task) =>
            task.id === editingTask.id ? { ...task, text, updatedAt: now } : task
          )
        );
      } else {
        await persistTasks([
          ...tasks,
          {
            id: `task-${now}-${Math.random().toString(16).slice(2)}`,
            text,
            completed: false,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      }
      backToList();
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  };

  const toggleTask = async (id: string) => {
    const now = Date.now();
    await persistTasks(
      tasks.map((task) =>
        task.id === id ? { ...task, completed: !task.completed, updatedAt: now } : task
      )
    );
  };

  const deleteTask = async (id: string) => {
    if (editingTask?.id === id) backToList();
    await persistTasks(tasks.filter((task) => task.id !== id));
  };

  const copyTask = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied");
    } catch {
      setNotice("Failed to copy");
    }
  };

  const activeCount = tasks.filter((task) => !task.completed).length;
  const doneCount = tasks.length - activeCount;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 theme-scrim animate-fade-in"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="w-[min(560px,94vw)] h-[min(680px,82vh)] max-h-[82vh] bg-ink-0 border border-ink-200 rounded-xl overflow-hidden flex flex-col shadow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Project tasks"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 theme-strip">
          <div className="min-w-0 flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-xl bg-ink-100 border border-ink-200 flex items-center justify-center flex-shrink-0">
              <ListTodo className="w-4 h-4 text-ink-800" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink-950 truncate">
                {modalMode === "create"
                  ? "New task"
                  : modalMode === "edit"
                    ? "Edit task"
                    : "Project tasks"}
              </div>
              <div className="text-[11px] text-ink-500 truncate">
                {projectLabel
                  ? `${projectLabel} · .lopster/task.json`
                  : "Open a project folder first"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {modalMode === "list" && rootPath && (
              <button
                type="button"
                onClick={openCreate}
                className="h-7 px-2.5 rounded-md text-[11px] font-medium theme-primary   inline-flex items-center gap-1 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded-lg text-ink-500 outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
              aria-label="Close tasks"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {modalMode !== "list" ? (
          <div className="flex-1 min-h-0 flex flex-col p-4 gap-3">
            <label className="grid gap-1.5 min-h-0 flex-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-500">
                Title
              </span>
              <textarea
                value={draftText}
                onChange={(event) => {
                  setDraftText(event.target.value);
                  if (notice) setNotice(null);
                }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void handleSaveDraft();
                  }
                }}
                autoFocus
                rows={6}
                placeholder="What needs to be done?"
                className="w-full min-h-[140px] resize-y rounded-xl theme-input px-3 py-2.5 text-[13px] leading-5 placeholder:text-ink-500 outline-none  "
              />
            </label>
            {notice && <div className="text-[11px] text-status-err">{notice}</div>}
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[10px] text-ink-500">Ctrl+Enter to save · Esc back</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={backToList}
                  className="h-8 px-3 rounded-lg text-[12px] text-ink-600 hover:text-ink-950 hover:bg-ink-100 active:bg-ink-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  disabled={saving || !draftText.trim()}
                  className="h-8 px-3 rounded-lg bg-ink-900 text-[12px] text-ink-0 hover:bg-ink-800 active:bg-ink-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-2 border-b border-ink-100 flex items-center gap-2 text-[11px] text-ink-500">
              {rootPath ? (
                <>
                  <span className="text-ink-800 font-medium">{activeCount} open</span>
                  <span>·</span>
                  <span>{doneCount} done</span>
                  <span className="ml-auto text-ink-400">completed sink to bottom</span>
                </>
              ) : (
                <span>Select a workspace folder to manage tasks for this project</span>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 pr-1.5 scrollbar-thin">
              {!rootPath ? (
                <div className="py-12 text-center text-[12px] text-ink-500 px-6">
                  Open a project folder in this panel first. Tasks are stored per project in
                  <span className="font-mono text-ink-700"> .lopster/task.json</span>
                </div>
              ) : loading ? (
                <div className="py-12 text-center text-[12px] text-ink-500">Loading…</div>
              ) : tasks.length === 0 ? (
                <div className="py-12 px-6 text-center space-y-3">
                  <div className="text-[12px] text-ink-500">No tasks yet for this project</div>
                  <button
                    type="button"
                    onClick={openCreate}
                    className="h-8 px-3 rounded-lg bg-ink-900 text-[12px] text-ink-0 hover:bg-ink-800 inline-flex items-center gap-1.5 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create first task
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  {tasks.map((task) => (
                    <div
                      key={task.id}
                      className="group flex items-start gap-2 rounded-xl px-2 py-2 transition-colors hover:bg-ink-50 min-w-0"
                    >
                      <button
                        type="button"
                        onClick={() => void toggleTask(task.id)}
                        className={`mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center transition-colors flex-shrink-0 ${
                          task.completed
                            ? "bg-ink-900 border-ink-900 text-ink-0"
                            : "bg-ink-0 border-ink-300 text-transparent hover:border-ink-700"
                        }`}
                        aria-label={task.completed ? "Mark incomplete" : "Mark complete"}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleTask(task.id)}
                        className={`flex-1 min-w-0 text-left text-[13px] leading-5 whitespace-pre-wrap break-words ${
                          task.completed ? "text-ink-500 line-through" : "text-ink-900"
                        }`}
                      >
                        {task.text}
                      </button>
                      <button
                        type="button"
                        onClick={() => void copyTask(task.text)}
                        className="p-1.5 rounded-lg text-ink-500 hover:text-ink-950 hover:bg-ink-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                        aria-label="Copy task"
                        title="Copy"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => openEdit(task)}
                        className="p-1.5 rounded-lg text-ink-500 hover:text-ink-950 hover:bg-ink-100 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                        aria-label="Edit task"
                        title="Edit"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteTask(task.id)}
                        className="p-1.5 rounded-lg text-ink-500 hover:text-status-err hover:bg-status-err-bg opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                        aria-label="Delete task"
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {notice && modalMode === "list" && (
              <div className="px-4 py-2 border-t border-ink-100 text-[11px] text-ink-500">{notice}</div>
            )}
          </>
        )}
      </section>
    </div>,
    document.body
  );
};

const CHAT_HISTORY_PAGE_SIZE = 20;

const ChatHistoryMenu: React.FC<{
  sessions: ChatSessionSummary[];
  rootPath: string | null;
  activeSessionId?: string | null;
  runningSessionIds?: Record<string, boolean>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onClose: () => void;
  title: string;
  emptyLabel: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
}> = ({ sessions, rootPath, activeSessionId, runningSessionIds = {}, onSelect, onDelete, onClose, title, emptyLabel, searchPlaceholder = "Search chats…", noResultsLabel = "No chats found" }) => {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<ChatSessionPage>({
    sessions,
    page: 1,
    pageSize: CHAT_HISTORY_PAGE_SIZE,
    total: sessions.length,
    totalPages: Math.max(1, Math.ceil(sessions.length / CHAT_HISTORY_PAGE_SIZE)),
    query: "",
  });
  const [loading, setLoading] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    const timer = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => { document.removeEventListener("keydown", handleKey); window.clearTimeout(timer); };
  }, [onClose]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPage(1), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const next = await window.lopster?.listChatSessionsPage?.(rootPath, {
          page,
          pageSize: CHAT_HISTORY_PAGE_SIZE,
          query,
        });
        if (!cancelled && next) setResult(next);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [rootPath, page, query]);

  const pageSessions = result.sessions;
  const isSearch = Boolean(query.trim());
  const goToPage = (next: number) => setPage(Math.min(Math.max(1, next), result.totalPages));

  return createPortal(
    <div className="chat-history-scrim animate-fade-in" style={{ zIndex: 200 }} onClick={onClose}>
      <div className="chat-history-modal chat-history-terminal" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="chat-history-head">
          <div className="chat-history-head-main">
            <History className="chat-history-head-icon" />
            <div className="min-w-0">
              <div className="chat-history-title">history://sessions</div>
              <div className="chat-history-sub">{result.total} {result.total === 1 ? "chat" : "chats"} · page {result.page}/{result.totalPages}</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="chat-history-close" aria-label="Close"><X className="w-3.5 h-3.5" /></button>
        </div>
        <div className="chat-history-command">$ sessions --page {result.page} --limit {CHAT_HISTORY_PAGE_SIZE}{isSearch ? ` --search ${query}` : ""}</div>
        <div className="chat-history-search">
          <Search className="chat-history-search-icon" />
          <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} className="chat-history-search-input" spellCheck={false} autoComplete="off" />
          {query ? <button type="button" className="chat-history-search-clear" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear"><X className="w-3 h-3" /></button> : null}
        </div>
        <div className="chat-history-list scrollbar-thin" aria-busy={loading}>
          {loading && pageSessions.length === 0 ? <div className="chat-history-empty"><span>loading history…</span></div> : result.total === 0 ? (
            <div className="chat-history-empty">{isSearch ? <><Search className="chat-history-empty-icon" /><span>{noResultsLabel}</span></> : <><History className="chat-history-empty-icon" /><span>{emptyLabel}</span></>}</div>
          ) : pageSessions.map((session, index) => {
            const running = Boolean(runningSessionIds[session.sessionId] || session.running);
            const active = session.sessionId === activeSessionId;
            return <div key={session.sessionId} className={`chat-history-row group ${active ? "is-active" : ""} ${running ? "is-running" : ""}`}>
              <button type="button" onClick={() => { onSelect(session.sessionId); onClose(); }} className="chat-history-row-main">
                <span className="chat-history-row-title-line"><span className="chat-history-index">{String((result.page - 1) * CHAT_HISTORY_PAGE_SIZE + index + 1).padStart(2, "0")}</span>{running ? <span className="chat-history-live" title="Running" /> : null}{active ? <span className="chat-history-active-mark" /> : null}<span className="chat-history-row-title">{session.title || "Untitled"}</span>{session.oneShot ? <span className="chat-history-badge">1-shot</span> : null}</span>
                <span className="chat-history-row-meta"><Clock className="chat-history-meta-icon" /><span>{running ? "running" : formatRelativeTime(session.updatedAt)}</span><span className="chat-history-meta-dot" /><span>{session.messageCount > 0 ? `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}` : "indexed"}</span></span>
              </button>
              <button type="button" onClick={(event) => { event.stopPropagation(); onDelete(session.sessionId); }} className="chat-history-delete" title="Delete" aria-label="Delete chat"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>;
          })}
        </div>
        <div className="chat-history-pager">
          <button type="button" onClick={() => goToPage(result.page - 1)} disabled={result.page <= 1 || loading}>← prev</button>
          <span>{loading ? "syncing…" : `${pageSessions.length} / ${result.total}`}</span>
          <button type="button" onClick={() => goToPage(result.page + 1)} disabled={result.page >= result.totalPages || loading}>next →</button>
        </div>
      </div>
    </div>,
    document.body
  );
};

const ChatBookmarksModal: React.FC<{
  activeSessionId?: string | null;
  onClose: () => void;
}> = ({ activeSessionId, onClose }) => {
  const [bookmarks, setBookmarks] = useState<ChatBookmark[]>([]);
  const [name, setName] = useState("");
  const [chatId, setChatId] = useState(activeSessionId || "");
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setBookmarks((await window.lopster?.listChatBookmarks?.()) || []);
    } catch {
      setNotice("Could not load saved chats.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (activeSessionId) setChatId(activeSessionId);
  }, [activeSessionId]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !chatId.trim()) {
      setNotice("Enter a chat name and ID.");
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await window.lopster?.saveChatBookmark?.({ name: name.trim(), chatId: chatId.trim() });
      setName("");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save the chat.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (bookmarkId: string) => {
    try {
      await window.lopster?.deleteChatBookmark?.(bookmarkId);
      await refresh();
    } catch {
      setNotice("Could not delete the saved chat.");
    }
  };

  return createPortal(
    <div className="chat-history-scrim animate-fade-in" style={{ zIndex: 200 }} onClick={onClose}>
      <div className="chat-history-modal max-w-[660px]" role="dialog" aria-modal="true" aria-label="Saved chat IDs" onClick={(event) => event.stopPropagation()}>
        <div className="chat-history-head">
          <div className="chat-history-head-main">
            <Bookmark className="chat-history-head-icon" />
            <div className="min-w-0">
              <div className="chat-history-title">Saved chat IDs</div>
              <div className="chat-history-sub">Your personal chat reference table</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="chat-history-close" aria-label="Close">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <form onSubmit={save} className="grid gap-2 border-b border-ink-100 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="What this chat is" className="chat-history-search-input rounded-lg border border-ink-200 px-3 py-2" maxLength={120} />
          <input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="Chat ID" className="chat-history-search-input rounded-lg border border-ink-200 px-3 py-2 font-mono" maxLength={200} />
          <button type="submit" disabled={saving} className="chat-bookmark-save-btn">{saving ? "Saving…" : "Save"}</button>
        </form>
        {notice ? <div className="px-4 pt-3 text-xs text-status-err">{notice}</div> : null}

        <div className="max-h-[360px] overflow-auto p-4 scrollbar-thin">
          {bookmarks.length === 0 ? (
            <div className="chat-history-empty"><Bookmark className="chat-history-empty-icon" /><span>No chat IDs saved yet.</span></div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-ink-200">
              <table className="w-full text-left text-xs">
                <thead className="bg-ink-50 text-ink-500"><tr><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Chat ID</th><th className="w-10 px-2 py-2" /></tr></thead>
                <tbody className="divide-y divide-ink-100">
                  {bookmarks.map((bookmark) => <tr key={bookmark.id} className="hover:bg-ink-50/70"><td className="max-w-[180px] truncate px-3 py-2 font-medium text-ink-800" title={bookmark.name}>{bookmark.name}</td><td className="max-w-[300px] truncate px-3 py-2 font-mono text-ink-500" title={bookmark.chatId}>{bookmark.chatId}</td><td className="px-2 py-1"><button type="button" onClick={() => void remove(bookmark.id)} className="chat-history-delete opacity-100" title="Delete saved chat" aria-label={`Delete ${bookmark.name}`}><Trash2 className="w-3.5 h-3.5" /></button></td></tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

const AutoInsertModal: React.FC<{
  enabled: boolean;
  messages: string[];
  onToggle: () => void;
  onAdd: (text: string) => void;
  onRemove: (index: number) => void;
  onClose: () => void;
  labels: {
    autoInsert: string;
    autoInsertHint: string;
    autoInsertOn: string;
    autoInsertOff: string;
    autoInsertEmpty: string;
    autoInsertPlaceholder: string;
    autoInsertAdd: string;
    autoInsertSearch: string;
    noResults: string;
  };
}> = ({ enabled, messages, onToggle, onAdd, onRemove, onClose, labels }) => {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? messages.filter((m) => m.toLowerCase().includes(search.trim().toLowerCase()))
    : messages;

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAdd(trimmed);
    setDraft("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center theme-scrim animate-fade-in" onClick={onClose}>
      <div
        className="w-[480px] h-[560px] max-h-[80vh] bg-ink-0 border border-ink-200 rounded-xl overflow-hidden flex flex-col shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink-950">{labels.autoInsert}</div>
            <div className="mt-0.5 text-[11px] text-ink-500 truncate">{labels.autoInsertHint}</div>
          </div>
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <span className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
              {enabled ? labels.autoInsertOn : labels.autoInsertOff}
            </span>
            <button
              onClick={onToggle}
              title={enabled ? labels.autoInsertOn : labels.autoInsertOff}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full border outline-none transition-colors ${
                enabled ? "theme-toggle-on" : "bg-ink-300 border-ink-300"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-ink-950 shadow-sm transition-transform ${
                  enabled ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded-md text-ink-500 outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {messages.length > 0 && (
          <div className="px-4 pt-2 pb-1">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-500" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={labels.autoInsertSearch}
                className="h-7 w-full min-w-0 rounded-md theme-input pl-8 pr-2.5 text-[12px] placeholder:text-ink-500 outline-none transition-colors hover:bg-ink-100  "
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-2">
          {messages.length === 0 ? (
            <div className="text-[12px] text-ink-500">{labels.autoInsertEmpty}</div>
          ) : filtered.length === 0 ? (
            <div className="text-[12px] text-ink-500">{labels.noResults}</div>
          ) : (
            filtered.map((message, index) => (
              <div
                key={index}
                className="group flex items-start gap-2 rounded-lg border border-ink-200 bg-ink-100 px-3 py-2"
              >
                <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] text-ink-800">
                  {message}
                </div>
                <button
                  onClick={() => onRemove(index)}
                  className="h-6 w-6 flex-shrink-0 flex items-center justify-center rounded-md text-ink-500 outline-none opacity-0 transition-colors hover:bg-status-err-bg hover:text-status-err group-hover:opacity-100"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-ink-200 flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAdd();
              }
            }}
            placeholder={labels.autoInsertPlaceholder}
            className="flex-1 h-8 min-w-0 rounded-md theme-input px-2.5 text-[12px] placeholder:text-ink-500 outline-none transition-colors hover:bg-ink-100  "
          />
          <button
            onClick={handleAdd}
            disabled={!draft.trim()}
            className="h-8 px-3 flex-shrink-0 flex items-center gap-1.5 rounded-md theme-primary text-[11px] font-medium outline-none transition-colors  disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Plus className="w-3.5 h-3.5" />
            {labels.autoInsertAdd}
          </button>
        </div>
      </div>
    </div>
  );
};

const InstructionsModal: React.FC<{
  rootPath: string | null;
  onClose: () => void;
  labels: {
    instructions: string;
    instructionsHint: string;
    instructionsGlobal: string;
    instructionsProject: string;
    instructionsGlobalHint: string;
    instructionsProjectHint: string;
    instructionsProjectNoFolder: string;
    instructionsPlaceholder: string;
    instructionsSave: string;
    instructionsSaved: string;
  };
}> = ({ rootPath, onClose, labels }) => {
  const [tab, setTab] = useState<"global" | "project">("global");
  const [globalText, setGlobalText] = useState("");
  const [projectText, setProjectText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    window.lopster?.readInstructions(rootPath).then((data) => {
      setGlobalText(data.global || "");
      setProjectText(data.project || "");
      setLoaded(true);
    });
  }, [rootPath]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (tab === "global") {
        await window.lopster?.saveGlobalInstructions(globalText);
      } else {
        await window.lopster?.saveProjectInstructions(rootPath, projectText);
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const currentText = tab === "global" ? globalText : projectText;
  const setCurrentText = tab === "global" ? setGlobalText : setProjectText;
  const canEdit = tab === "global" || Boolean(rootPath);

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 theme-scrim animate-fade-in"
      role="presentation"
      onClick={onClose}
    >
      <section
        className="w-[min(1040px,94vw)] h-[min(760px,86vh)] max-h-[86vh] bg-ink-0 border border-ink-200 rounded-xl overflow-hidden flex flex-col shadow-modal"
        role="dialog"
        aria-modal="true"
        aria-label={labels.instructions}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink-950">{labels.instructions}</div>
            <div className="mt-0.5 text-[11px] text-ink-500 truncate">{labels.instructionsHint}</div>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md text-ink-500 outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-4 pt-3">
          <button
            onClick={() => setTab("global")}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-md outline-none transition-colors ${
              tab === "global"
                ? "bg-ink-150 text-ink-950"
                : "text-ink-500 hover:bg-ink-100 hover:text-ink-800"
            }`}
          >
            <FileText className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
            {labels.instructionsGlobal}
          </button>
          <button
            onClick={() => setTab("project")}
            disabled={!rootPath}
            className={`px-3 py-1.5 text-[12px] font-medium rounded-md outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              tab === "project"
                ? "bg-ink-150 text-ink-950"
                : "text-ink-500 hover:bg-ink-100 hover:text-ink-800"
            }`}
          >
            <FolderTree className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
            {labels.instructionsProject}
          </button>
        </div>

        <div className="px-4 pt-2 pb-1">
          <div className="text-[11px] text-ink-500">
            {tab === "global" ? labels.instructionsGlobalHint : rootPath ? labels.instructionsProjectHint : labels.instructionsProjectNoFolder}
          </div>
        </div>

        <div className="flex-1 px-4 pb-2">
          {canEdit && loaded ? (
            <textarea
              value={currentText}
              onChange={(event) => setCurrentText(event.target.value)}
              placeholder={labels.instructionsPlaceholder}
              className="w-full h-full resize-none rounded-md theme-input px-3 py-2.5 text-[12px] placeholder:text-ink-500 outline-none transition-colors hover:bg-ink-100   scrollbar-thin font-mono"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-[12px] text-ink-500">
              {labels.instructionsProjectNoFolder}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-ink-200">
          <button
            onClick={handleSave}
            disabled={saving || !canEdit}
            className="h-8 px-3 flex items-center gap-1.5 rounded-md theme-primary text-[11px] font-medium outline-none transition-colors  disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PenLine className="w-3.5 h-3.5" />
            {savedFlash ? labels.instructionsSaved : labels.instructionsSave}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
};

const TodoPanel: React.FC<{
  todos: TodoItem[];
  labels: {
    agentTodo: string;
    agentTodoHint: string;
    agentTodoEmpty: string;
  };
}> = ({ todos, labels }) => {
  if (!todos || todos.length === 0) return null;

  const activeTodos = todos.filter((todo) => todo.status !== "completed");
  const doneCount = todos.length - activeTodos.length;
  const sorted = [...todos].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.status !== b.status) {
      const rank = (s: string) =>
        s === "in_progress" ? 0 : s === "completed" ? 2 : 1;
      return rank(a.status) - rank(b.status);
    }
    return a.createdAt - b.createdAt;
  });

  return (
    <div className="todo-console">
      <div className="todo-console-head">
        <span className="tool-prompt" aria-hidden>
          $
        </span>
        <span className="todo-console-title">todo</span>
        <span className="todo-console-meta" title={labels.agentTodoHint || labels.agentTodo}>
          {doneCount}/{todos.length}
          {activeTodos.length > 0 ? ` · ${activeTodos.length} open` : ""}
        </span>
      </div>
      <div className="todo-console-list">
        {sorted.map((todo) => {
          const done = todo.status === "completed";
          const running = todo.status === "in_progress";
          const mark = done ? "x" : running ? "~" : " ";
          return (
            <div
              key={todo.id}
              className={`todo-console-row ${
                done ? "is-done" : running ? "is-running" : "is-pending"
              }${todo.pinned && !done ? " is-pinned" : ""}`}
            >
              <span className="todo-console-mark" aria-hidden>
                [{mark}]
              </span>
              <span className="todo-console-text">{todo.content}</span>
              {todo.pinned && !done && (
                <span className="todo-console-pin" title="pinned">
                  *
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const TelegramIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    className={className}
  >
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.45 4.476-1.458z" />
  </svg>
);

const EMPTY_TELEGRAM_CONFIG: TelegramBotConfig = {
  enabled: false,
  botToken: "",
  allowedChatIds: [],
};

const ChatTelegramModal: React.FC<{
  slotId: string;
  onClose: () => void;
}> = ({ slotId, onClose }) => {
  const [draft, setDraft] = useState<TelegramBotConfig>(EMPTY_TELEGRAM_CONFIG);
  const [status, setStatus] = useState<TelegramBotStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [cfg, st] = await Promise.all([
          window.lopster?.getTelegramSlotConfig?.(slotId),
          window.lopster?.getTelegramSlotStatus?.(slotId),
        ]);
        if (cancelled) return;
        if (cfg) {
          setDraft({
            enabled: Boolean(cfg.enabled),
            botToken: typeof cfg.botToken === "string" ? cfg.botToken : "",
            allowedChatIds: Array.isArray(cfg.allowedChatIds)
              ? cfg.allowedChatIds.map(String)
              : [],
          });
        }
        if (st) setStatus(st as TelegramBotStatus);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load Telegram settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [slotId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const st = await window.lopster?.getTelegramSlotStatus?.(slotId);
        if (!cancelled && st) setStatus(st as TelegramBotStatus);
      } catch {
        /* ignore */
      }
    };
    const id = window.setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [slotId, saving]);

  const statusLabel = (() => {
    if (status?.running) {
      return status.botUsername ? `Running · @${status.botUsername}` : "Running · polling";
    }
    if (status?.lastError) return `Error · ${status.lastError}`;
    if (!draft.botToken.trim()) return "Stopped · paste bot token";
    if (!draft.enabled) return "Stopped · turn Enabled on";
    return "Stopped · starting…";
  })();

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaveNote(null);
    try {
      const next = await window.lopster?.configureTelegramSlot?.(slotId, {
        enabled: draft.enabled,
        botToken: draft.botToken,
        allowedChatIds: draft.allowedChatIds,
      });
      if (next) {
        setStatus(next as TelegramBotStatus);
        setDraft({
          enabled: Boolean(next.enabled),
          botToken: typeof next.botToken === "string" ? next.botToken : draft.botToken,
          allowedChatIds: Array.isArray(next.allowedChatIds)
            ? next.allowedChatIds.map(String)
            : draft.allowedChatIds,
        });
      }
      setSaveNote("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Telegram settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center theme-scrim animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[85vh] bg-ink-0 border border-ink-200 rounded-xl overflow-hidden flex flex-col shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-ink-200">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink-950">Telegram bot</div>
            <div className="mt-0.5 text-[11px] text-ink-500 truncate">
              Settings for this chat only · {slotId}
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md text-ink-500 outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin">
          {loading ? (
            <div className="text-[12px] text-ink-500">Loading…</div>
          ) : (
            <>
              <div
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-[11px] leading-4 ${
                  status?.running
                    ? "border-ink-300 bg-ink-100 text-ink-900"
                    : status?.lastError
                      ? "border-status-err-border bg-status-err-bg text-status-err"
                      : "border-ink-200 bg-ink-50 text-ink-700"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                    status?.running
                      ? "theme-live-dot animate-pulse"
                      : status?.lastError
                        ? "bg-status-err"
                        : "bg-ink-500"
                  }`}
                />
                <span className="min-w-0 break-words">{statusLabel}</span>
              </div>

              <button
                type="button"
                onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
                className="group relative py-1.5 text-left outline-none"
              >
                <span
                  className={`flex items-center gap-2 text-[12px] font-medium ${
                    draft.enabled ? "text-ink-950" : "text-ink-700"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      draft.enabled ? "bg-ink-950" : "bg-ink-500"
                    }`}
                  />
                  {draft.enabled ? "Enabled" : "Disabled"}
                  <Check
                    className={`h-3 w-3 text-ink-800 transition-all ${
                      draft.enabled ? "opacity-100 scale-100" : "opacity-0 scale-75"
                    }`}
                  />
                </span>
              </button>

              <label className="grid gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-[0.11em] text-ink-600">
                  Bot token
                </span>
                <span className="relative block">
                  <input
                    type={showToken ? "text" : "password"}
                    value={draft.botToken}
                    placeholder="123456:ABC-DEF..."
                    onChange={(event) => {
                      const value = event.target.value;
                      const trimmed = value.trim();
                      setDraft((d) => ({
                        ...d,
                        botToken: value,
                        ...(trimmed ? { enabled: true } : {}),
                      }));
                      setSaveNote(null);
                    }}
                    className="h-7 w-full bg-transparent pr-8 px-0 text-[12px] font-mono text-ink-950 placeholder-ink-500 outline-none"
                    style={{ borderBottom: "1px solid var(--ink-250)", caretColor: "var(--accent)" }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-0 top-1/2 -translate-y-1/2 h-6 px-1 text-ink-500 hover:text-ink-950"
                    aria-label="Toggle bot token visibility"
                  >
                    {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </span>
              </label>

              <label className="grid gap-1">
                <span className="text-[9px] font-semibold uppercase tracking-[0.11em] text-ink-600">
                  Allowed chat IDs
                </span>
                <input
                  type="text"
                  value={draft.allowedChatIds.join(", ")}
                  placeholder="optional: 123456789, -100..."
                  onChange={(event) => {
                    setDraft((d) => ({
                      ...d,
                      allowedChatIds: event.target.value
                        .split(/[\s,]+/)
                        .map((item) => item.trim())
                        .filter(Boolean),
                    }));
                    setSaveNote(null);
                  }}
                  className="h-7 w-full bg-transparent px-0 text-[12px] font-mono text-ink-950 placeholder-ink-500 outline-none"
                  style={{ borderBottom: "1px solid var(--ink-250)", caretColor: "var(--accent)" }}
                />
              </label>

              <div className="space-y-1 font-mono text-[11px] leading-5 text-ink-600">
                <div>/new — new IDE session for this chat</div>
                <div>/context · /sessions · /tools · /stop</div>
                <div>plain text — send to this chat’s agent</div>
              </div>

              {error && <div className="text-[11px] text-status-err">{error}</div>}
              {saveNote && !error && <div className="text-[11px] text-ink-800">{saveNote}</div>}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-ink-200">
          <button
            type="button"
            onClick={onClose}
            className="h-7 px-3 rounded-md text-[11px] font-medium text-ink-600 hover:bg-ink-100 hover:text-ink-950 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => void handleSave()}
            className="h-7 px-3 rounded-md text-[11px] font-medium text-ink-950 bg-ink-100 hover:bg-ink-200 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};







const DEFAULT_CTL_BODY = `{
  "kind": "pipeline"
}`;

const CustomToolsModal: React.FC<{
  tools: CustomTool[];
  onAdd: (input: {
    name: string;
    title?: string;
    description?: string;
    body: Record<string, unknown> | string;
    tags?: string[];
  }) => Promise<void>;
  onUpdate: (
    toolId: string,
    patch: {
      name?: string;
      title?: string;
      description?: string;
      body?: Record<string, unknown> | string;
      enabled?: boolean;
      tags?: string[];
    }
  ) => Promise<void>;
  onRemove: (toolId: string) => Promise<void>;
  onClose: () => void;
  labels: {
    customTools: string;
    customToolsHint: string;
    customToolsEmpty: string;
    customToolName: string;
    customToolNamePlaceholder: string;
    customToolTitle: string;
    customToolTitlePlaceholder: string;
    customToolDescription: string;
    customToolDescriptionPlaceholder: string;
    customToolBody: string;
    customToolBodyPlaceholder: string;
    customToolSave: string;
    customToolDelete: string;
    customToolEnabled: string;
    customToolDisabled: string;
    customToolsSearch: string;
    customToolTags: string;
    customToolTagsPlaceholder: string;
    customToolInvalidJson: string;
    customToolExport: string;
    customToolExportAll: string;
    customToolExportOne: string;
    customToolImport: string;
    customToolImportAll: string;
    customToolImportOne: string;
    customToolImportPick: string;
    customToolImportPickHint: string;
    customToolImportSelected: string;
    customToolImportCancel: string;
    customToolCopyPack: string;
    customToolCopyOne: string;
    customToolCopied: string;
    customToolExportSaved: string;
    customToolImportDone: string;
    customToolImportMode: string;
    customToolImportSkip: string;
    customToolImportOverwrite: string;
    customToolImportRename: string;
    noResults: string;
  };
}> = ({ tools, onAdd, onUpdate, onRemove, onClose, labels }) => {
  // Custom tools have their dedicated workspace; keep this legacy modal inert.
  return null;

  type PanelMode = "create" | "edit";
  type ImportMode = "skip" | "overwrite" | "rename";
  type ImportPreviewTool = {
    index?: number;
    id?: string;
    name?: string;
    title?: string;
    description?: string;
    kind?: string;
    enabled?: boolean;
    tags?: string[];
    valid?: boolean;
    error?: string | null;
  };
  type ImportPickState = {
    path?: string | null;
    text: string;
    format?: "zip" | "json" | string | null;
    tools: ImportPreviewTool[];
    selected: number[];
  };
  const [panelMode, setPanelMode] = useState<PanelMode>("create");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [bodyText, setBodyText] = useState(DEFAULT_CTL_BODY);
  const [tagsText, setTagsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyShare, setBusyShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("skip");
  const [importPick, setImportPick] = useState<ImportPickState | null>(null);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.tags || []).some((tag) => tag.toLowerCase().includes(q)) ||
        JSON.stringify(t.body || {}).toLowerCase().includes(q)
    );
  }, [tools, search]);

  useEffect(() => {
    if (selectedId && !tools.some((t) => t.id === selectedId)) {
      setSelectedId(null);
      setPanelMode("create");
      setName("");
      setTitle("");
      setDescription("");
      setBodyText(DEFAULT_CTL_BODY);
      setTagsText("");
      setError(null);
    }
  }, [tools, selectedId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const resetCreateForm = () => {
    setName("");
    setTitle("");
    setDescription("");
    setBodyText(DEFAULT_CTL_BODY);
    setTagsText("");
    setError(null);
  };

  const openCreate = () => {
    setPanelMode("create");
    setSelectedId(null);
    resetCreateForm();
  };

  const openEdit = (tool: CustomTool) => {
    setPanelMode("edit");
    setSelectedId(tool.id);
    setName(tool.name);
    setTitle(tool.title || "");
    setDescription(tool.description || "");
    try {
      setBodyText(JSON.stringify(tool.body || {}, null, 2));
    } catch {
      setBodyText(DEFAULT_CTL_BODY);
    }
    setTagsText((tool.tags || []).join(", "));
    setError(null);
  };

  const parseTags = (raw: string) =>
    raw
      .split(/[,;\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);

  const canSave = Boolean(name.trim() && bodyText.trim());

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedBody = bodyText.trim();
    if (!trimmedName || !trimmedBody) {
      setError("Name and CTL body are required");
      return;
    }
    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(trimmedBody);
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        throw new Error("body must be a JSON object");
      }
    } catch {
      setError(labels.customToolInvalidJson);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const tags = parseTags(tagsText);
      if (panelMode === "edit" && selectedId) {
        await onUpdate(selectedId, {
          name: trimmedName,
          title: trimmedTitle || undefined,
          description: trimmedDescription || undefined,
          body: parsedBody,
          tags,
        });
      } else {
        await onAdd({
          name: trimmedName,
          title: trimmedTitle || undefined,
          description: trimmedDescription || undefined,
          body: parsedBody,
          tags,
        });
        resetCreateForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save custom tool");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (toolId: string) => {
    try {
      await onRemove(toolId);
      if (selectedId === toolId) openCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete custom tool");
    }
  };

  const handleToggle = async (tool: CustomTool) => {
    try {
      await onUpdate(tool.id, { enabled: tool.enabled === false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle custom tool");
    }
  };

  const handleExport = async (opts?: { ids?: string[]; names?: string[] }) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.lopster?.exportCustomTools?.({
        ...(opts || {}),
        saveToFile: true,
        dialog: true,
        format: "zip",
      });
      if (result?.canceled) return;
      if (result?.saved && result.path) {
        setStatusMsg(`${labels.customToolExportSaved}: ${result.path} (${result.count || 0})`);
      } else if (result?.text) {
        try {
          await navigator.clipboard.writeText(result.text);
          setStatusMsg(`${labels.customToolCopied} · ${result.count || 0}`);
        } catch {
          setStatusMsg(`${labels.customToolExport}: ${result.count || 0}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusyShare(false);
    }
  };

  const handleCopyPack = async (opts?: { ids?: string[]; names?: string[] }) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.lopster?.exportCustomTools?.({
        ...(opts || {}),
        format: "json",
      });
      const text = result?.text || "";
      if (!text) throw new Error("Empty export pack");
      await navigator.clipboard.writeText(text);
      setStatusMsg(`${labels.customToolCopied} · ${result?.count || 0}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy pack failed");
    } finally {
      setBusyShare(false);
    }
  };

  const applyImportResult = (result: {
    imported?: unknown[];
    updated?: unknown[];
    skipped?: unknown[];
    errors?: Array<{ index?: number; name?: string; error?: string }>;
  } | null | undefined) => {
    const imported = result?.imported?.length || 0;
    const updated = result?.updated?.length || 0;
    const skipped = result?.skipped?.length || 0;
    const errors = result?.errors?.length || 0;
    setStatusMsg(
      `${labels.customToolImportDone}: +${imported}, ~${updated}, skip ${skipped}` +
        (errors ? `, err ${errors}` : "")
    );
    if (errors && result?.errors?.[0]?.error) {
      setError(String(result.errors[0].error));
    }
  };

  const runImportWithFilter = async (
    source: string | null | undefined,
    filter?: { indices?: number[]; names?: string[]; onlyOne?: boolean },
    fromPath?: string | null,
    format?: string | null
  ) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const isZip =
        format === "zip" ||
        (typeof fromPath === "string" && /\.zip$/i.test(fromPath));
      const result = await window.lopster?.importCustomTools?.({
        source: isZip ? undefined : source || undefined,
        path: fromPath || undefined,
        mode: importMode,
        indices: isZip ? undefined : filter?.indices,
        names: filter?.names,
        onlyOne: filter?.onlyOne === true,
        format: isZip ? "zip" : format === "json" ? "json" : undefined,
      });
      if (result?.canceled) return;
      applyImportResult(result);
      setImportPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusyShare(false);
    }
  };

  const handleImport = async () => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const preview = await window.lopster?.previewCustomToolsImport?.({
        dialog: true,
      });
      if (preview?.canceled) return;
      const packTools = Array.isArray(preview?.tools) ? preview.tools : [];
      const format =
        preview?.format === "zip" ||
        (typeof preview?.path === "string" && /\.zip$/i.test(preview.path))
          ? "zip"
          : "json";
      const text = preview?.text || "";
      if (packTools.length === 0) {
        throw new Error("Import pack is empty");
      }
      if (format === "json" && !text) {
        throw new Error("Import pack is empty");
      }
      if (format === "zip" && !preview?.path) {
        throw new Error("ZIP import requires a file path");
      }
      if (packTools.length === 1) {
        const only = packTools[0];
        setBusyShare(false);
        await runImportWithFilter(
          format === "zip" ? null : text,
          format === "zip"
            ? {
                names: only.name ? [String(only.name)] : undefined,
                onlyOne: true,
              }
            : {
                indices: only.index != null ? [only.index] : [0],
                onlyOne: true,
              },
          preview?.path,
          format
        );
        return;
      }
      setImportPick({
        path: preview?.path || null,
        text,
        format,
        tools: packTools,
        selected: packTools.length ? [Number(packTools[0].index ?? 0)] : [],
      });
      setStatusMsg(
        `${labels.customToolImportPick}: ${packTools.length} · ${preview?.path || ""}`.trim()
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusyShare(false);
    }
  };

  const toggleImportPickIndex = (index: number) => {
    setImportPick((prev) => {
      if (!prev) return prev;
      const has = prev.selected.includes(index);
      return {
        ...prev,
        selected: has ? prev.selected.filter((x) => x !== index) : [...prev.selected, index],
      };
    });
  };

  const handleImportSelected = async () => {
    if (!importPick) return;
    const indices = importPick.selected.slice().sort((a, b) => a - b);
    if (!indices.length) {
      setError(labels.customToolImportPick);
      return;
    }
    const format = importPick.format || "json";
    if (format === "zip") {
      const names = importPick.tools
        .filter((t) => indices.includes(Number(t.index ?? -1)))
        .map((t) => String(t.name || ""))
        .filter(Boolean);
      await runImportWithFilter(null, { names }, importPick.path, "zip");
      return;
    }
    await runImportWithFilter(importPick.text, { indices }, importPick.path, "json");
  };

  const handleImportAllFromPick = async () => {
    if (!importPick) return;
    await runImportWithFilter(
      importPick.format === "zip" ? null : importPick.text,
      undefined,
      importPick.path,
      importPick.format || "json"
    );
  };

  const fieldClass =
    "h-8 w-full min-w-0 bg-transparent pl-0 pr-0 text-[12.5px] leading-none text-ink-950 placeholder-ink-500 outline-none";
  const fieldStyle: React.CSSProperties = {
    borderBottom: "1px solid var(--ink-250)",
    caretColor: "var(--accent)",
  };
  const labelClass = "text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500";
  const quietBtn =
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 theme-soft";
  const primaryBtn =
    "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ui-btn-primary";
  const kindOf = (tool: CustomTool) => {
    const body = tool.body || {};
    return String((body as { kind?: string; type?: string }).kind || (body as { type?: string }).type || "pipeline");
  };

  // CLOSE PAREN
};

const COMPACT_SUMMARY_RE = /^\[Conversation summary — (\d+) earlier messages compacted\]\n([\s\S]*)$/;
const INPUT_MAX_HEIGHT = 160;

const CHAT_WIDTH_KEY = "lopster-chat-width";
const CHAT_WIDTH_DEFAULT = 360;
const CHAT_WIDTH_MIN = 280;
const CHAT_WIDTH_MAX = 820;

function clampChatWidth(value: number): number {
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, Math.round(value)));
}

function loadChatWidth(): number {
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_KEY);
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return clampChatWidth(parsed);
  } catch {
    /* ignore */
  }
  return CHAT_WIDTH_DEFAULT;
}

function saveChatWidth(width: number) {
  try {
    window.localStorage.setItem(CHAT_WIDTH_KEY, String(clampChatWidth(width)));
  } catch {
    /* ignore */
  }
}

const CompactedSummaryCard: React.FC<{ count: string; summary: string }> = ({ count, summary }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <button
      onClick={() => setExpanded((value) => !value)}
      className="w-full text-left rounded-lg border border-indigo-500/25 bg-indigo-500/[0.06] px-3 py-2 outline-none hover:bg-indigo-500/10 transition-colors"
    >
      <div className="flex items-center gap-2 text-[11px] font-medium text-indigo-300">
        <Layers className="w-3.5 h-3.5 flex-shrink-0" />
        <span>Compacted {count} earlier messages</span>
        <ChevronDown className={`w-3 h-3 ml-auto flex-shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </div>
      {expanded && (
        <div className="mt-2 text-[12px] leading-5 text-ink-700 whitespace-pre-wrap">{summary}</div>
      )}
    </button>
  );
};

const MessageActions: React.FC<{ content: string }> = ({ content }) => {
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    await navigator.clipboard?.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  };

  return (
    <div className="mt-2 flex items-center gap-1 text-ink-500">
      <button
        onClick={copyMessage}
        className="h-6 px-1.5 flex items-center gap-1 rounded-md outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
      >
        <Copy className="w-3.5 h-3.5" />
        {copied && <span className="text-[11px]">Copied</span>}
      </button>
    </div>
  );
};

const imageSrc = (img: ChatImageAttachment) => img.url || img.dataUrl || "";

/** Small square thumbs — used above composer and inside message bubbles. */
const ChatImageThumbs: React.FC<{
  images: ChatImageAttachment[];
  onOpen?: (index: number) => void;
  onRemove?: (id: string) => void;
  size?: "sm" | "md";
}> = ({ images, onOpen, onRemove, size = "sm" }) => {
  if (!images?.length) return null;
  const dim = size === "md" ? "w-14 h-14" : "w-11 h-11";
  return (
    <div className="chat-image-thumbs">
      {images.map((img, index) => {
        const src = imageSrc(img);
        return (
          <div key={img.id || `${index}-${src.slice(0, 24)}`} className="chat-image-thumb-wrap">
            <button
              type="button"
              className={`chat-image-thumb ${dim}`}
              onClick={() => onOpen?.(index)}
              title={img.name || "Open image"}
            >
              <img src={src} alt={img.name || "attachment"} draggable={false} />
            </button>
            {onRemove && (
              <button
                type="button"
                className="chat-image-thumb-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(img.id);
                }}
                title="Remove"
                aria-label="Remove image"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};

/** Full-screen lightbox for chat images (Esc / arrows / backdrop). */
const ChatImageLightbox: React.FC<{
  images: ChatImageAttachment[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}> = ({ images, index, onClose, onIndexChange }) => {
  const safeIndex = Math.max(0, Math.min(index, images.length - 1));
  const current = images[safeIndex];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowRight" && images.length > 1) {
        e.preventDefault();
        onIndexChange((safeIndex + 1) % images.length);
      } else if (e.key === "ArrowLeft" && images.length > 1) {
        e.preventDefault();
        onIndexChange((safeIndex - 1 + images.length) % images.length);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [images.length, onClose, onIndexChange, safeIndex]);

  if (!current) return null;
  const src = imageSrc(current);

  return (
    <div className="chat-image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="chat-image-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="chat-image-lightbox-bar">
          <span className="chat-image-lightbox-title">
            {current.name || "Image"}
            {images.length > 1 ? ` · ${safeIndex + 1}/${images.length}` : ""}
          </span>
          <button type="button" className="chat-image-lightbox-close" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="chat-image-lightbox-stage">
          {images.length > 1 && (
            <button
              type="button"
              className="chat-image-lightbox-nav prev"
              onClick={() => onIndexChange((safeIndex - 1 + images.length) % images.length)}
              aria-label="Previous"
            >
              ‹
            </button>
          )}
          <img src={src} alt={current.name || "image"} className="chat-image-lightbox-img" draggable={false} />
          {images.length > 1 && (
            <button
              type="button"
              className="chat-image-lightbox-nav next"
              onClick={() => onIndexChange((safeIndex + 1) % images.length)}
              aria-label="Next"
            >
              ›
            </button>
          )}
        </div>
        {images.length > 1 && (
          <div className="chat-image-lightbox-strip">
            {images.map((img, i) => (
              <button
                key={img.id || i}
                type="button"
                className={`chat-image-lightbox-strip-item ${i === safeIndex ? "is-active" : ""}`}
                onClick={() => onIndexChange(i)}
              >
                <img src={imageSrc(img)} alt="" draggable={false} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const MAX_CHAT_IMAGES = 12;
const MAX_CHAT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_CHAT_IMAGE_DATA_URL_LENGTH = 6 * 1024 * 1024;
const MAX_CHAT_IMAGE_DIMENSION = 2048;

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

async function prepareChatImage(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  const original = await readFileAsDataUrl(file);
  if (original.length <= MAX_CHAT_IMAGE_DATA_URL_LENGTH) {
    return { dataUrl: original, mimeType: file.type || "image/*" };
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_CHAT_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return { dataUrl: original, mimeType: file.type || "image/*" };
    context.drawImage(bitmap, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    return { dataUrl, mimeType: "image/jpeg" };
  } finally {
    bitmap.close();
  }
}

async function filesToChatImages(files: FileList | File[]): Promise<ChatImageAttachment[]> {
  const list = Array.from(files || []).filter((f) => f && f.type.startsWith("image/"));
  const out: ChatImageAttachment[] = [];
  for (const file of list) {
    if (file.size > MAX_CHAT_IMAGE_BYTES) continue;
    try {
      const prepared = await prepareChatImage(file);
      if (!prepared.dataUrl.startsWith("data:image/")) continue;
      out.push({
        id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        url: prepared.dataUrl,
        dataUrl: prepared.dataUrl,
        mimeType: prepared.mimeType,
        name: file.name || "image",
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  thinking,
  toolActivity = [],
  assistantDrafts = [],
  liveTimeline = [],
  thinkingDraft = null,
  messageQueue = [],
  onRemoveQueuedMessage,
  onClearMessageQueue,
  statusLabel,
  usedTokens,
  contextLimit,
  compacting,
  compactionBanner,
  compactNotice,
  onCompact,
  sessions,
  activeSessionId,
  runningSessionIds = {},
  onNewChat,
  onCopySession,
  onPasteSession,
  onSelectSession,
  onDeleteSession,
  oneShotEnabled = false,
  onToggleOneShot,
  onRefreshSessions,
  autoInsertEnabled,
  autoInsertMessages,
  onToggleAutoInsert,
  onAddAutoInsertMessage,
  onRemoveAutoInsertMessage,
  agentTodos,
  rootPath,
  providers,
  models,
  selectedModelId,
  onSelectModel,
  agentMode,
  onSelectAgentMode,
  thinkingMaxEnabled = false,
  onToggleThinkingMax,
  onSend,
  onStop,
  labels,
  fill = false,
  slotIndex,
  telegramSlotId = null,
}) => {
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([]);
  const [lightbox, setLightbox] = useState<{ images: ChatImageAttachment[]; index: number } | null>(
    null
  );
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [chatBookmarksModalOpen, setChatBookmarksModalOpen] = useState(false);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [showAgentModeMenu, setShowAgentModeMenu] = useState(false);
  const [autoInsertModalOpen, setAutoInsertModalOpen] = useState(false);
  const [instructionsModalOpen, setInstructionsModalOpen] = useState(false);
  const [telegramModalOpen, setTelegramModalOpen] = useState(false);
  const [projectTasksModalOpen, setProjectTasksModalOpen] = useState(false);
  const [telegramHeaderStatus, setTelegramHeaderStatus] = useState<TelegramBotStatus | null>(null);
  const [chatWidth, setChatWidth] = useState(loadChatWidth);
  const [isResizing, setIsResizing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Root of this chat column — used so mouse/hotkey insert only hits the active panel */
  const panelRootRef = useRef<HTMLDivElement>(null);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<ChatMonoScrollHandle>(null);
  const stickToBottomRef = useRef(true);
  const chatWidthRef = useRef(chatWidth);
  /** Previously sent composer texts (oldest → newest). ArrowUp/Down like a shell. */
  const inputHistoryRef = useRef<string[]>([]);
  /** -1 = live draft; 0..n-1 = browsing history */
  const historyIndexRef = useRef(-1);
  /** Draft saved when user first presses ArrowUp from live input */
  const draftBeforeHistoryRef = useRef("");
  const selectedAgentModeLabel = agentMode === "soviet-7" ? "Soviet-7" : "ComposeVC";

  useEffect(() => {
    chatWidthRef.current = chatWidth;
  }, [chatWidth]);

  useEffect(() => {
    const viewport = messagesScrollRef.current?.getViewport();
    if (!viewport) return;
    const onScroll = () => {
      const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = gap < 96;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const pin = () => messagesScrollRef.current?.scrollToBottom({ smooth: false });
    pin();
    const t1 = window.setTimeout(pin, 16);
    const t2 = window.setTimeout(pin, 80);
    const t3 = window.setTimeout(pin, 180);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [messages, toolActivity, assistantDrafts, liveTimeline, thinking, agentTodos]);

  // Poll per-slot Telegram status for the header indicator (only when slot is wired).
  useEffect(() => {
    if (!telegramSlotId) {
      setTelegramHeaderStatus(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const st = await window.lopster?.getTelegramSlotStatus?.(telegramSlotId);
        if (!cancelled && st) {
          // The IPC bridge returns a fresh object on every poll. Avoid repainting
          // an entire terminal when the small Telegram indicator did not change.
          setTelegramHeaderStatus((previous) => {
            const next = st as TelegramBotStatus;
            return previous?.running === next.running &&
              previous?.enabled === next.enabled &&
              previous?.botToken === next.botToken &&
              previous?.botUsername === next.botUsername
              ? previous
              : next;
          });
        }
      } catch {
        /* ignore */
      }
    };
    void refresh();
    // Six terminals otherwise issue six IPC polls every 2.5 seconds. The status
    // is not real-time data, so a calmer cadence keeps typing responsive.
    const id = window.setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [telegramSlotId, telegramModalOpen]);

  const startChatResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = chatWidthRef.current;
    setIsResizing(true);

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (moveEvent: PointerEvent) => {
      // Drag left edge leftward → wider chat
      const next = clampChatWidth(startWidth + (startX - moveEvent.clientX));
      chatWidthRef.current = next;
      setChatWidth(next);
    };

    const onUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      saveChatWidth(chatWidthRef.current);
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    };

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Register this column so global hotkeys/insert pick exactly ONE MultiIDE panel.
  useEffect(() => {
    const el = panelRootRef.current;
    if (!el) return;
    const id = telegramSlotId || `panel-${Math.random().toString(36).slice(2, 9)}`;
    chatPanelHotkeyRoots.set(id, el);
    return () => {
      chatPanelHotkeyRoots.delete(id);
    };
  }, [telegramSlotId]);

  /** True only for the single active MultiIDE column (hover → focus). Never all 4. */
  const isActiveChatPanel = useCallback((): boolean => {
    const root = panelRootRef.current;
    if (!root) return false;
    return resolveActiveChatPanelRoot() === root;
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === "KeyL") {
        // Only focus the active MultiIDE column (or the single side chat)
        if (!isActiveChatPanel()) return;
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [isActiveChatPanel]);

  // Mouse side-button snippets (Settings → Shortcuts) → only the active chat input
  useEffect(() => {
    const onInsert = (event: Event) => {
      const detail = (event as CustomEvent<InsertChatInputDetail>).detail;
      if (!detail?.text) return;
      // MultiIDE: 4 panels listen — apply only to the focused/hovered one
      if (!isActiveChatPanel()) return;
      const chunk = detail.text;
      setInput((current) => {
        if (!detail.append || !current.trim()) return chunk;
        const sep = current.endsWith("\n") ? "\n" : "\n\n";
        return `${current}${sep}${chunk}`;
      });
      // Focus after React paints
      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
      });
    };
    window.addEventListener(INSERT_INPUT_EVENT, onInsert as EventListener);
    return () => window.removeEventListener(INSERT_INPUT_EVENT, onInsert as EventListener);
  }, [isActiveChatPanel]);

  useEffect(() => {
    if (!showToolsMenu && !showAgentModeMenu && !showModelMenu) return;
    const handleClick = (event: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
        setShowToolsMenu(false);
        setShowAgentModeMenu(false);
        setShowModelMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showToolsMenu, showAgentModeMenu, showModelMenu]);

  // Auto-grow the composer with the typed content, up to INPUT_MAX_HEIGHT — past
  // that point the textarea's own scrollbar takes over instead of growing further.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_HEIGHT)}px`;
  }, [input]);

  const pushInputHistory = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const hist = inputHistoryRef.current;
    // Don't stack identical consecutive sends
    if (hist[hist.length - 1] === trimmed) return;
    hist.push(trimmed);
    const MAX = 100;
    if (hist.length > MAX) hist.splice(0, hist.length - MAX);
  };

  const applyHistoryEntry = (value: string) => {
    setInput(value);
    // Put caret at end after React paints the new value
    window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      const end = value.length;
      el.focus();
      el.setSelectionRange(end, end);
    });
  };

  const caretOnFirstLine = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    return !el.value.slice(0, pos).includes("\n");
  };

  const caretOnLastLine = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    return !el.value.slice(pos).includes("\n");
  };

  const addPendingImages = useCallback(async (files: FileList | File[] | null | undefined) => {
    if (!files || (files as FileList).length === 0) return;
    const next = await filesToChatImages(files);
    if (!next.length) return;
    setPendingImages((prev) => {
      const merged = [...prev, ...next];
      return merged.slice(0, MAX_CHAT_IMAGES);
    });
  }, []);

  const handleSend = () => {
    const text = input.trim();
    const images = pendingImages.length ? [...pendingImages] : undefined;
    if (!text && !images?.length) return;
    if (text) {
      pushInputHistory(text);
    }
    historyIndexRef.current = -1;
    draftBeforeHistoryRef.current = "";
    stickToBottomRef.current = true;
    onSend(text, images);
    setInput("");
    setPendingImages([]);
    const pin = () => messagesScrollRef.current?.scrollToBottom({ smooth: false });
    pin();
    requestAnimationFrame(pin);
    window.setTimeout(pin, 32);
    window.setTimeout(pin, 120);
    window.setTimeout(pin, 280);
  };

  const handlePasteImages = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    void addPendingImages(files);
  };

  const handleDropImages = (e: React.DragEvent) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    const hasImage = Array.from(files).some((f) => f.type.startsWith("image/"));
    if (!hasImage) return;
    e.preventDefault();
    e.stopPropagation();
    void addPendingImages(files);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shell-like input history: ↑ older / ↓ newer (only when not mid multi-line edit)
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const el = inputRef.current;
      const hist = inputHistoryRef.current;
      if (el && hist.length > 0) {
        if (e.key === "ArrowUp" && caretOnFirstLine(el)) {
          e.preventDefault();
          if (historyIndexRef.current === -1) {
            draftBeforeHistoryRef.current = input;
            historyIndexRef.current = hist.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current -= 1;
          }
          applyHistoryEntry(hist[historyIndexRef.current] || "");
          return;
        }
        if (e.key === "ArrowDown" && caretOnLastLine(el)) {
          if (historyIndexRef.current === -1) {
            // Already on live draft — let caret move normally if multi-line
          } else {
            e.preventDefault();
            if (historyIndexRef.current < hist.length - 1) {
              historyIndexRef.current += 1;
              applyHistoryEntry(hist[historyIndexRef.current] || "");
            } else {
              // Past newest → restore the draft that was there before browsing
              historyIndexRef.current = -1;
              applyHistoryEntry(draftBeforeHistoryRef.current);
            }
            return;
          }
        }
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      ref={panelRootRef}
      className={`relative flex flex-col min-w-0 overflow-hidden chat-col-glass ${
        fill
          ? "h-full w-full flex-1 border-0"
          : `flex-shrink-0 border-l border-ink-200 ${isResizing ? "" : "animate-fade-in"}`
      }`}
      style={
        fill
          ? { width: "100%", minWidth: 0, maxWidth: "none", height: "100%" }
          : { width: chatWidth, minWidth: CHAT_WIDTH_MIN, maxWidth: CHAT_WIDTH_MAX }
      }
    >
      {!fill && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          title="Drag to resize chat"
          onPointerDown={startChatResize}
          className={`chat-resize-handle ${isResizing ? "is-dragging" : ""}`}
        />
      )}

      {/* Header */}
      <div className="chat-header-bar">
        <div className="flex items-center gap-0.5 min-w-0 flex-shrink-0">
          <button
            onClick={onNewChat}
            title={labels.newChat}
            className="chat-header-icon"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setShowHistory(false);
              setChatBookmarksModalOpen(true);
            }}
            title="Saved chat IDs"
            aria-label="Saved chat IDs"
            className={`chat-header-icon ${chatBookmarksModalOpen ? "is-active" : ""}`}
          >
            <Bookmark className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onCopySession}
            title="Copy session"
            aria-label="Copy session"
            className="chat-header-icon"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onPasteSession}
            title="Paste copied session as a new chat"
            aria-label="Paste copied session"
            className="chat-header-icon"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
          </button>
          {onToggleOneShot && (
            <button
              onClick={onToggleOneShot}
              title={oneShotEnabled ? labels.oneShotOn : labels.oneShotOff}
              aria-pressed={oneShotEnabled}
              className={`chat-header-icon ${oneShotEnabled ? "is-oneshot" : ""}`}
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => {
              setShowHistory(false);
              setTelegramModalOpen(false);
              setProjectTasksModalOpen(true);
            }}
            title={rootPath ? "Project tasks" : "Project tasks (open a folder first)"}
            className={`chat-header-icon ${projectTasksModalOpen ? "is-active" : ""}`}
          >
            <ListTodo className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              setShowHistory((value) => {
                const next = !value;
                if (next) onRefreshSessions?.();
                return next;
              });
            }}
            title={labels.chatHistory}
            className={`chat-header-icon ${showHistory ? "is-active" : ""}`}
          >
            <History className="w-3.5 h-3.5" />
          </button>
          {telegramSlotId && (
            <button
              onClick={() => {
                setShowHistory(false);
                setProjectTasksModalOpen(false);
                setTelegramModalOpen(true);
              }}
              title={
                telegramHeaderStatus?.running
                  ? `Telegram · @${telegramHeaderStatus.botUsername || "bot"}`
                  : "Telegram bot settings"
              }
              className={`chat-header-icon relative ${telegramModalOpen ? "is-active" : ""}`}
            >
              <TelegramIcon className="w-3.5 h-3.5" />
              <span
                className={`absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${
                  telegramHeaderStatus?.running
                    ? "theme-live-dot animate-pulse"
                    : telegramHeaderStatus?.enabled && telegramHeaderStatus?.botToken
                      ? "bg-status-warn"
                      : "bg-transparent"
                }`}
              />
            </button>
          )}
          <button
            onClick={onToggleAutoInsert}
            title={autoInsertEnabled ? "Auto-insert: on" : "Auto-insert: off"}
            className={`chat-header-icon ${autoInsertEnabled ? "is-autoinsert" : ""}`}
          >
            <ListPlus className="w-3.5 h-3.5" />
          </button>
          </div>
	      </div>
      {showHistory && (
        <ChatHistoryMenu
          sessions={sessions}
          rootPath={rootPath}
          activeSessionId={activeSessionId}
          runningSessionIds={runningSessionIds}
          onSelect={onSelectSession}
          onDelete={onDeleteSession}
          onClose={() => setShowHistory(false)}
          title={labels.chatHistory}
          emptyLabel={labels.noChatsYet}
          searchPlaceholder={labels.searchChats || "Search chats…"}
          noResultsLabel={labels.noResults || "No chats found"}
        />
      )}

      {chatBookmarksModalOpen && (
        <ChatBookmarksModal activeSessionId={activeSessionId} onClose={() => setChatBookmarksModalOpen(false)} />
      )}

      {projectTasksModalOpen && (
        <ProjectTasksModal rootPath={rootPath} onClose={() => setProjectTasksModalOpen(false)} />
      )}

      {telegramModalOpen && telegramSlotId && (
        <ChatTelegramModal slotId={telegramSlotId} onClose={() => setTelegramModalOpen(false)} />
      )}

      {autoInsertModalOpen && (
        <AutoInsertModal
          enabled={autoInsertEnabled}
          messages={autoInsertMessages}
          onToggle={onToggleAutoInsert}
          onAdd={onAddAutoInsertMessage}
          onRemove={onRemoveAutoInsertMessage}
          onClose={() => setAutoInsertModalOpen(false)}
          labels={{
            autoInsert: labels.autoInsert,
            autoInsertHint: labels.autoInsertHint,
            autoInsertOn: labels.autoInsertOn,
            autoInsertOff: labels.autoInsertOff,
            autoInsertEmpty: labels.autoInsertEmpty,
            autoInsertPlaceholder: labels.autoInsertPlaceholder,
            autoInsertAdd: labels.autoInsertAdd,
            autoInsertSearch: labels.autoInsertSearch,
            noResults: labels.noResults,
          }}
        />
      )}

      {instructionsModalOpen && (
        <InstructionsModal
          rootPath={rootPath}
          onClose={() => setInstructionsModalOpen(false)}
          labels={{
            instructions: labels.instructions,
            instructionsHint: labels.instructionsHint,
            instructionsGlobal: labels.instructionsGlobal,
            instructionsProject: labels.instructionsProject,
            instructionsGlobalHint: labels.instructionsGlobalHint,
            instructionsProjectHint: labels.instructionsProjectHint,
            instructionsProjectNoFolder: labels.instructionsProjectNoFolder,
            instructionsPlaceholder: labels.instructionsPlaceholder,
            instructionsSave: labels.instructionsSave,
            instructionsSaved: labels.instructionsSaved,
          }}
        />
      )}


      {agentTodos.length > 0 && (
        <div className="px-4 pt-2 pb-0">
          <TodoPanel
            todos={agentTodos}
            labels={{
              agentTodo: labels.agentTodo,
              agentTodoHint: labels.agentTodoHint,
              agentTodoEmpty: labels.agentTodoEmpty,
            }}
          />
        </div>
      )}

      {/* Messages */}
      <ChatMonoScroll ref={messagesScrollRef} className="flex-1 min-h-0">
      <div className="relative px-4 py-4 space-y-5 min-h-full">
        {messages.length === 0 && !thinking && (
          <div className="chat-empty">
            {/* The banner owns its own motion (it sinks and surfaces); a scale
                "pop" on top of that just fought with it, so there is no click
                animation here any more. */}
            <div className="chat-center-logo-btn">
              <AsciiLogo />
            </div>
          </div>
        )}
        {messages.map((msg, msgIndex) => {
          const compactMatch = msg.role === "assistant" ? msg.content.match(COMPACT_SUMMARY_RE) : null;
          if (compactMatch) {
            return (
              <div key={msg.id} className="animate-fade-in">
                <CompactedSummaryCard count={compactMatch[1]} summary={compactMatch[2]} />
              </div>
            );
          }

          const isToolsOnly =
            msg.role === "assistant" &&
            (!msg.content || !msg.content.trim()) &&
            !(msg.images && msg.images.length) &&
            Boolean(msg.toolSteps && msg.toolSteps.length > 0);
          const summarySteps =
            msg.toolSteps && msg.toolSteps.length > 0
              ? msg.toolSteps
              : messages[msgIndex - 1]?.role === "assistant" &&
                  messages[msgIndex - 1]?.toolSteps &&
                  messages[msgIndex - 1]!.toolSteps!.length > 0
                ? messages[msgIndex - 1]!.toolSteps
                : undefined;

          return (
            <div key={msg.id} className="animate-fade-in">
              {!isToolsOnly && (
                <div className="mb-2 text-[11px] font-semibold text-ink-950 tracking-tight">
                  {msg.role === "assistant" ? "ComposeVC" : "You"}
                </div>
              )}
              {msg.toolSteps && msg.toolSteps.length > 0 && (
                <HistoricalToolSteps
                  steps={msg.toolSteps}
                  usedLabel={labels.usedTools}
                  toolLabel={labels.tool}
                  toolsPluralLabel={labels.toolsPlural}
                  more={labels.more}
                  moreCount={labels.moreCount}
                  collapse={labels.collapse}
                  collapseUnits={labels.collapseUnits}
                  allUnitsCount={labels.allUnitsCount}
                />
              )}
              {msg.images && msg.images.length > 0 && (
                <div className="mb-2">
                  <ChatImageThumbs
                    images={msg.images}
                    size="md"
                    onOpen={(index) => setLightbox({ images: msg.images || [], index })}
                  />
                </div>
              )}
              {msg.content?.trim() ? (
                <>
                  <MarkdownContent content={msg.content} />
                  {summarySteps && summarySteps.length > 0 && (
                    <ChangedFilesSummary steps={summarySteps} rootPath={rootPath} />
                  )}
                  <MessageActions content={msg.content} />
                </>
              ) : null}
            </div>
          );
        })}
        {thinking && (
          <div className="animate-fade-in space-y-2">
            <div className="mb-2 text-[11px] font-semibold text-ink-950 tracking-tight">
              ComposeVC
            </div>
            {/* Chronological stream: text appears under the tools that preceded it */}
            {liveTimeline.length > 0 ? (
              liveTimeline.map((item) => {
                if (item.kind === "text") {
                  return <MarkdownContent key={item.id} content={item.text} />;
                }
                const step = toolActivity.find((s) => s.toolCallId === item.toolCallId);
                if (!step) return null;
                return (
                  <ToolActivityList
                    key={item.id}
                    steps={[step]}
                    more={labels.more}
                    moreCount={labels.moreCount}
                    collapse={labels.collapse}
                    collapseUnits={labels.collapseUnits}
                    allUnitsCount={labels.allUnitsCount}
                  />
                );
              })
            ) : (
              <>
                {toolActivity.length > 0 && (
                  <ToolActivityList
                    steps={toolActivity}
                    more={labels.more}
                    moreCount={labels.moreCount}
                    collapse={labels.collapse}
                    collapseUnits={labels.collapseUnits}
                    allUnitsCount={labels.allUnitsCount}
                  />
                )}
                {assistantDrafts.map((text, index) => (
                  <MarkdownContent key={`${index}-${text.slice(0, 24)}`} content={text} />
                ))}
              </>
            )}
            {/* Tools that somehow missed timeline ids still show at the end */}
            {liveTimeline.length > 0 &&
              (() => {
                const shown = new Set(
                  liveTimeline.filter((i) => i.kind === "tool").map((i) => (i as { toolCallId: string }).toolCallId)
                );
                const orphan = toolActivity.filter((s) => s.toolCallId && !shown.has(s.toolCallId));
                return orphan.length > 0 ? (
                  <ToolActivityList
                    steps={orphan}
                    more={labels.more}
                    moreCount={labels.moreCount}
                    collapse={labels.collapse}
                    collapseUnits={labels.collapseUnits}
                    allUnitsCount={labels.allUnitsCount}
                  />
                ) : null;
              })()}
            <ThinkingIndicator label={statusLabel || undefined} />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      </ChatMonoScroll>

      {/* Input */}
      <div className="relative px-3 pb-3 pt-1.5 min-w-0 z-[1]">
        {messageQueue.length > 0 && (
          <div className="chat-queue mb-2">
            <div className="chat-queue-head">
              <span className="tool-prompt" aria-hidden>
                $
              </span>
              <span className="chat-queue-title">
                {labels.queue}
                <span className="chat-queue-count">{messageQueue.length}</span>
              </span>
              <span className="chat-queue-hint">{labels.queueWaiting}</span>
              {onClearMessageQueue && (
                <button type="button" onClick={onClearMessageQueue} className="chat-queue-clear">
                  {labels.queueClear}
                </button>
              )}
            </div>
            <div className="chat-queue-list">
              {messageQueue.map((item, index) => (
                <div key={item.id} className="chat-queue-item">
                  <span className="chat-queue-index">{String(index + 1).padStart(2, "0")}</span>
                  <span
                    className="chat-queue-text"
                    title={
                      item.content ||
                      (item.images?.length ? `${item.images.length} image(s)` : "")
                    }
                  >
                    {item.content ||
                      (item.images?.length ? `🖼 ${item.images.length} image(s)` : "")}
                  </span>
                  {onRemoveQueuedMessage && (
                    <button
                      type="button"
                      onClick={() => onRemoveQueuedMessage(item.id)}
                      className="chat-queue-remove"
                      title={labels.queueClear}
                      aria-label="Remove from queue"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {compactionBanner && (
          <CompactionBanner
            info={compactionBanner}
            label={labels.compactedBanner}
            msgsSavedTokens={labels.msgsSavedTokens}
          />
        )}
        {!compactionBanner && compactNotice && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-20 w-[calc(100%-24px)] -translate-x-1/2 animate-fade-in">
            <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-100/95 px-3 py-2 shadow-2xl backdrop-blur-sm">
              <Sparkles
                className={`w-3.5 h-3.5 flex-shrink-0 ${compactNotice.tone === "error" ? "text-status-err" : "text-ink-500"}`}
              />
              <div className="min-w-0 text-[11px] text-ink-800">{compactNotice.text}</div>
            </div>
          </div>
        )}
        <div
          className="chat-composer-shell"
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes("Files")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={handleDropImages}
        >
          {pendingImages.length > 0 && (
            <div className="chat-composer-images px-3 pt-2.5">
              <ChatImageThumbs
                images={pendingImages}
                size="sm"
                onOpen={(index) => setLightbox({ images: pendingImages, index })}
                onRemove={(id) => setPendingImages((prev) => prev.filter((img) => img.id !== id))}
              />
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePasteImages}
            placeholder={labels.askAnything}
            rows={1}
            style={{
              minHeight: "40px",
              maxHeight: `${INPUT_MAX_HEIGHT}px`,
            }}
            className="w-full bg-transparent px-3.5 pt-2.5 pb-1.5 text-[13px] leading-5 text-ink-950 placeholder-ink-600 resize-none outline-none scrollbar-chat overflow-y-auto"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void addPendingImages(e.target.files);
              e.target.value = "";
            }}
          />
          <div className="chat-composer-actions min-w-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images (or paste / drop)"
              className="chat-composer-icon-btn"
              aria-label="Attach images"
            >
              <ImagePlus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleThinkingMax}
              title={thinkingMaxEnabled ? "Thinking-max: always on" : "Enable Thinking-max for every request"}
              aria-label="Toggle Thinking-max"
              aria-pressed={thinkingMaxEnabled}
              className={`chat-composer-icon-btn ${thinkingMaxEnabled ? "bg-ink-200 text-ink-950 ring-1 ring-ink-400" : ""}`}
            >
              <BrainCircuit className="w-3.5 h-3.5" />
            </button>
            <ContextRing
              usedTokens={usedTokens}
              limitTokens={contextLimit}
              compacting={compacting}
              onCompact={onCompact}
              labels={{
                contextUsage: labels.contextUsage,
                compacting: labels.compacting,
                clickToCompact: labels.clickToCompact,
                justNow: labels.justNow,
                minutesAgo: labels.minutesAgo,
                hoursAgo: labels.hoursAgo,
                daysAgo: labels.daysAgo,
              }}
            />
            {thinking ? (
              <>
                <button
                  onClick={handleSend}
                  disabled={!input.trim() && pendingImages.length === 0}
                  title={labels.queue}
                  className="h-7 px-2 flex items-center gap-1 rounded-md border border-ink-300 bg-ink-100 text-ink-900 text-[11px] outline-none disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink-150 transition-colors flex-shrink-0"
                >
                  <ListPlus className="w-3.5 h-3.5" />
                  {labels.queue}
                </button>
                <button
                  onClick={onStop}
                  className="h-7 px-2 flex items-center gap-1 border border-status-err-border bg-status-err-bg text-status-err rounded-md text-[11px] outline-none hover:bg-ink-100 transition-colors flex-shrink-0"
                >
                  <Square className="w-3 h-3 fill-current" />
                  {labels.stop}
                </button>
              </>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && pendingImages.length === 0}
                className="chat-send-fab"
                title={labels.send}
                aria-label={labels.send}
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

        {/* Model / agent mode / tools live INSIDE the composer, on the same
            row as the send controls — one card instead of a stack of bars. */}
        <div className="chat-chip-row relative" ref={toolsMenuRef}>
            <ModelPicker
              open={showModelMenu}
              onOpenChange={(next) => {
                setShowModelMenu(next);
                if (next) {
                  setShowAgentModeMenu(false);
                  setShowToolsMenu(false);
                }
              }}
              providers={providers}
              models={models}
              selectedModelId={selectedModelId}
              onSelectModel={onSelectModel}
              labels={{
                selectModel: labels.selectModel,
                noModelsConfigured: labels.noModelsConfigured,
                searchModels: labels.searchModels,
                noModelsFound: labels.noModelsFound,
              }}
            />

            <div className="relative min-w-0 max-w-[8.5rem] flex-shrink">
              <button
                type="button"
                onClick={() => {
                  if (thinking) return;
                  setShowAgentModeMenu((value) => !value);
                  setShowToolsMenu(false);
                  setShowModelMenu(false);
                }}
                disabled={thinking}
                title="Agent mode"
                className={`chat-chip chat-chip-agent w-full ${showAgentModeMenu ? "is-open" : ""}`}
              >
                <span className="h-1.5 w-1.5 rounded-full flex-shrink-0 bg-ink-700" />
                <span className="truncate font-medium">{selectedAgentModeLabel}</span>
                <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform ${showAgentModeMenu ? "rotate-180" : ""}`} />
              </button>
              {showAgentModeMenu && (
                <div className="agent-mode-menu absolute left-0 bottom-[calc(100%+6px)] z-40 w-[min(250px,calc(100vw-24px))] max-w-full rounded-xl border border-ink-200 bg-ink-100 shadow-2xl overflow-x-hidden overflow-y-auto animate-fade-in">
                  <div className="px-3 py-2 border-b border-ink-200 bg-ink-150 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                    Agent mode
                  </div>
                  {([
                    {
                      mode: "lopster" as MainAgentMode,
                      title: "ComposeVC",
                      hint: "Default coding agent",
                    },
                    {
                      mode: "soviet-7" as MainAgentMode,
                      title: "Soviet-7",
                      hint: "7 advisors research → main executes",
                    },
                  ]).map((item) => (
                    <button
                      key={item.mode}
                      type="button"
                      onClick={() => {
                        onSelectAgentMode(item.mode);
                        setShowAgentModeMenu(false);
                      }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors ${
                        agentMode === item.mode ? "bg-ink-150 text-ink-950" : "text-ink-800 hover:bg-ink-150 hover:text-ink-950"
                      }`}
                    >
                      <span className={`h-7 w-7 rounded-lg flex-shrink-0 flex items-center justify-center border ${
                        agentMode === item.mode ? "border-ink-300 bg-ink-200 text-ink-900" : "border-ink-200 bg-ink-150 text-ink-600"
                      }`}>
                        {item.mode === "soviet-7" ? (
                          <Users className="w-3.5 h-3.5" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium truncate">{item.title}</span>
                        <span className="block text-[10px] text-ink-500 truncate">{item.hint}</span>
                      </span>
                      {agentMode === item.mode && <Check className="w-3.5 h-3.5 text-ink-700 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

	            <button
	              onClick={() => {
	                setShowToolsMenu((value) => !value);
	                setShowAgentModeMenu(false);
	                setShowModelMenu(false);
	              }}
	              className={`chat-chip chat-chip-tools ${showToolsMenu ? "is-open" : ""}`}
	            >
	              <Wrench className="w-3.5 h-3.5 flex-shrink-0" />
	              <span className="truncate max-w-[5rem]">{labels.tools}</span>
		            </button>
            {showToolsMenu && (
              <div className="chat-tools-menu absolute left-0 right-0 bottom-9 z-20 rounded-xl border border-ink-200 bg-ink-100 shadow-2xl overflow-hidden animate-fade-in">
                <div className="px-3 py-2 border-b border-ink-200 text-[10px] font-medium uppercase tracking-wider text-ink-500">
                  {labels.tools}
                </div>
                <div className="p-1">
                  <button
                    onClick={() => {
                      setShowToolsMenu(false);
                      setAutoInsertModalOpen(true);
                    }}
                    className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-ink-150"
                  >
                    <span className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md bg-ink-150 text-ink-600">
                      <ListPlus className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium text-ink-950 truncate">{labels.autoInsert}</span>
                      <span className="block text-[10px] text-ink-500 truncate">
                        {autoInsertEnabled ? labels.autoInsertOn : labels.autoInsertOff} · {autoInsertMessages.length}
                      </span>
                    </span>
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                        autoInsertEnabled ? "bg-ink-950" : "bg-ink-500"
                      }`}
                    />
                  </button>
                  <button
                    onClick={() => {
                      setShowToolsMenu(false);
                      setInstructionsModalOpen(true);
                    }}
                    className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-ink-150"
                  >
                    <span className="h-7 w-7 flex-shrink-0 flex items-center justify-center rounded-md bg-ink-150 text-ink-600">
                      <FileText className="w-3.5 h-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium text-ink-950 truncate">{labels.instructions}</span>
                      <span className="block text-[10px] text-ink-500 truncate">
                        {labels.instructionsGlobal} · {labels.instructionsProject}
                      </span>
                    </span>
                  </button>
                </div>
              </div>
            )}
        </div>
        </div>
      </div>

      {lightbox && (
        <ChatImageLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(next) => setLightbox((prev) => (prev ? { ...prev, index: next } : prev))}
        />
      )}
    </div>
  );
};

export default React.memo(ChatPanel);
