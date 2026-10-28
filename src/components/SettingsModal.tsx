/**
 * SettingsModal - dense, typography-first system configuration module.
 *
 * Contracts:
 *  - deterministic FSM: idle -> dirty -> saving -> saved | error
 *  - all edits pass through one dispatcher and publish optimistically
 *  - persistence is asynchronous and isolated from immediate visual response
 *  - hierarchy is text/spacing/color, not card stacks or divider noise
 *  - motion is restricted to transform/opacity compositor-friendly transitions
 */

import React, {
  Component,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Eye,
  Keyboard,
  Layers,
  Mail,
  Mouse,
  Palette,
  Search,
  ShieldCheck,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { AppLanguage, languageNames, Translation } from "../i18n";
import { ProviderConfig, CfMailConfig, TokenCountingMode } from "../types";
import { applyTheme, getStoredTheme, THEMES, ThemeId } from "../themes";
import {
  DEFAULT_MOUSE_SNIPPETS,
  loadMouseSnippets,
  MouseSnippetsConfig,
  saveMouseSnippets,
} from "../utils/mouseSnippets";
import ChatMonoScroll from "./ChatMonoScroll";
import SetupSettings from "./SetupSettings";
import { IcoDownload } from "./topIcons";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  config: ProviderConfig;
  labels: Translation;
  language: AppLanguage;
  onLanguageChange: (lang: AppLanguage) => void;
  onChange: (config: ProviderConfig) => void | Promise<void | ProviderConfig>;
}

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";
type NavTab = "ai" | "shortcuts" | "appearance" | "cfmail" | "setup";

function keyboardShortcuts(labels: Translation): Array<{ keys: string; action: string }> {
  return [
    { keys: "Ctrl+1", action: labels.shortcutAgent },
    { keys: "Ctrl+2", action: labels.shortcutWebEngine },
    { keys: "Ctrl+3", action: labels.shortcutProxy },
    { keys: "Ctrl+4", action: labels.shortcutRunner },
    { keys: "Ctrl+5", action: labels.shortcutTerminal },
    { keys: "Ctrl+6", action: labels.shortcutCustomTools },
    { keys: "Ctrl+7", action: labels.shortcutKnowledge },
    { keys: "Ctrl+8", action: labels.shortcutDocs },
    { keys: "Ctrl+9", action: labels.shortcutUsage },
    { keys: "Ctrl+`", action: labels.shortcutTerminal },
    { keys: "Ctrl+Shift+F", action: labels.shortcutSearch },
    { keys: "Ctrl+,", action: labels.shortcutOpenSettings },
    { keys: "Ctrl+L", action: labels.shortcutFocusChat },
    { keys: "Ctrl+H", action: labels.shortcutChatSwitcher },
    { keys: "Ctrl+T", action: labels.shortcutStorage },
    { keys: "Ctrl+R", action: labels.shortcutRunnerSend },
    { keys: "Ctrl+S", action: labels.shortcutSave },
    { keys: "Ctrl+Shift+W", action: labels.shortcutFoldDock },
    { keys: "Mouse ◀", action: labels.shortcutSnippet1 },
    { keys: "Mouse ▶", action: labels.shortcutSnippet2 },
  ];
}

interface FsmState {
  status: SaveStatus;
  draft: ProviderConfig;
  errorMsg: string | null;
  tx: number;
}

type FsmAction =
  | { type: "EDIT"; payload: ProviderConfig }
  | { type: "SAVE_START"; tx: number }
  | { type: "SAVE_OK"; tx: number }
  | { type: "SAVE_ERR"; tx: number; payload: string }
  | { type: "RESET"; payload: ProviderConfig };

const transition = "opacity 180ms cubic-bezier(.22,1,.36,1), transform 180ms cubic-bezier(.22,1,.36,1)";
const uid = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const MAX_MODEL_CONTEXT_TOKENS = 256000;
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o";
/* Theme primary accent token */
const PRIMARY = "var(--accent)";

function fsmReducer(state: FsmState, action: FsmAction): FsmState {
  switch (action.type) {
    case "EDIT":
      return { ...state, status: "dirty", draft: action.payload, errorMsg: null };
    case "SAVE_START":
      return { ...state, status: "saving", tx: action.tx };
    case "SAVE_OK":
      return action.tx === state.tx ? { ...state, status: "saved", errorMsg: null } : state;
    case "SAVE_ERR":
      return action.tx === state.tx ? { ...state, status: "error", errorMsg: action.payload } : state;
    case "RESET":
      return { status: "idle", draft: action.payload, errorMsg: null, tx: state.tx };
    default:
      return state;
  }
}

class SettingsBoundary extends Component<{ children: ReactNode; labels?: Translation }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : "Configuration render failed" };
  }

  componentDidCatch(error: unknown) {
    console.error("Settings module recovered from an exception", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const labels = this.props.labels;
    return (
      <div className="fixed inset-0 z-50 grid place-items-center px-6" style={{ background: "var(--scrim)" }}>
        <div className="max-w-md text-center">
          <div className="text-[13px] font-semibold text-ink-950">{labels?.settingsRecovered || "Settings recovered"}</div>
          <div className="mt-2 text-[11px] leading-5 text-ink-600">{this.state.message || labels?.configRenderFailed}</div>
          <button
            onClick={() => this.setState({ failed: false, message: "" })}
            className="ui-btn-primary mt-5"
            style={{ willChange: "opacity" }}
          >
            {labels?.restoreVisualContext || "Restore visual context"}
          </button>
        </div>
      </div>
    );
  }
}

const StatusText: React.FC<{ status: SaveStatus; errorMsg: string | null; labels: Translation }> = ({ status, errorMsg, labels }) => {
  const visible = status !== "idle";
  const label =
    status === "dirty"
      ? labels.statusQueued
      : status === "saving"
        ? labels.statusSyncing
        : status === "saved"
          ? labels.statusSaved
          : status === "error"
            ? errorMsg || labels.statusError
            : "";
  const color =
    status === "error"
      ? "var(--danger)"
      : status === "saved"
        ? "var(--ink-950)"
        : status === "saving"
          ? "var(--ink-700)"
          : "var(--ink-600)";
  return (
    <span
      className="inline-block max-w-[140px] truncate text-[10px] tracking-[0.03em]"
      style={{
        color,
        opacity: visible ? 1 : 0,
        transform: visible ? "translate3d(0,0,0)" : "translate3d(0,3px,0)",
        transition,
        willChange: "opacity, transform",
      }}
    >
      {label}
    </span>
  );
};

const NavItem: React.FC<{
  active: boolean;
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
}> = ({ active, icon, label, hint, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-current={active ? "page" : undefined}
    className={`settings-nav-item ${active ? "is-active" : ""}`}
    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
  >
    <span className="settings-nav-icon">{icon}</span>
    <span className="settings-nav-label">
      {label}
      {hint ? <span className="settings-nav-hint">{hint}</span> : null}
    </span>
  </button>
);

const QuietButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; danger?: boolean }
> = ({ active, danger, className = "", style, ...props }) => (
  <button
    {...props}
    className={`inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ${
      active
        ? "theme-active-pill"
        : danger
          ? "ui-btn-danger h-7"
          : "theme-soft"
    } ${className}`}
    style={{
      color: danger
        ? "var(--danger)"
        : active
          ? "var(--active-fg)"
          : undefined,
      willChange: "opacity",
      ...style,
    }}
  />
);

const FieldLabel: React.FC<{ children: ReactNode }> = ({ children }) => (
  <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">{children}</span>
);

const Field: React.FC<{
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  type?: string;
  onChange: (value: string) => void;
  suffix?: ReactNode;
}> = ({ label, value, placeholder, mono, type = "text", onChange, suffix }) => (
  <label className="grid min-w-0 gap-1.5">
    <FieldLabel>{label}</FieldLabel>
    <span className="relative block min-w-0">
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`settings-field-input ${mono ? "font-mono" : ""} ${suffix ? "pr-8" : ""}`}
        style={{ caretColor: PRIMARY }}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-0 z-[1] flex w-8 items-center justify-center">
          <span className="pointer-events-auto flex h-7 w-7 items-center justify-center">{suffix}</span>
        </span>
      )}
    </span>
  </label>
);

/** Dark monochrome custom select — no OS white popup. */
type UiSelectOption = { value: string; label: string };

const UiSelect: React.FC<{
  value: string;
  options: UiSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  compact?: boolean;
  ariaLabel?: string;
}> = ({ value, options, onChange, className = "", compact = false, ariaLabel }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) || options[0];
  const label = selected?.label ?? "";

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`settings-square-select flex w-full min-w-0 items-center gap-1.5 rounded-md theme-input px-2 text-left text-ink-950 outline-none transition-colors hover:bg-ink-100 ${
          compact ? "h-7 text-[11px]" : "h-9 text-[12.5px]"
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-600 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="settings-square-select-menu absolute left-0 right-0 top-[calc(100%+4px)] z-[80] max-h-56 overflow-y-auto rounded-md theme-panel py-1 shadow-menu scrollbar-thin animate-fade-in"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <button
                key={opt.value || "__empty"}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2.5 text-left outline-none transition-colors ${
                  compact ? "h-7 text-[11px]" : "h-8 text-[12px]"
                } ${active ? "bg-ink-150 text-ink-950" : "text-ink-800 hover:bg-ink-100 hover:text-ink-950"}`}
              >
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                {active ? <Check className="h-3.5 w-3.5 shrink-0 text-ink-700" /> : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/* ---------------------------------------------------------------------------
 * AI Runtime tab: model choices, floating model picker, two-column workspace.
 * Presentation only — every edit still flows through updateAiRuntime.
 * ------------------------------------------------------------------------- */

type ModelChoice = {
  value: string;
  label: string;
  providerName: string;
  modelName: string;
  contextLabel: string;
  providerId: string;
};

const INHERIT_MODEL_LABEL = "Same as main model (default)";

function formatContextLabel(limit?: number): string {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return "";
  if (limit >= 1000) {
    const k = limit / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k ctx`;
  }
  return `${limit} ctx`;
}

function buildModelChoices(draft: ProviderConfig): ModelChoice[] {
  return draft.models.map((model) => {
    const provider = draft.providers.find((p) => p.id === model.providerId);
    const apiName = model.name || model.id;
    const idHint = model.id && model.id !== apiName ? ` · id ${model.id}` : "";
    return {
      value: model.id,
      label: provider ? `${provider.name} / ${apiName}${idHint}` : `${apiName}${idHint}`,
      providerName: provider ? provider.name : "Unassigned provider",
      modelName: apiName,
      contextLabel: formatContextLabel(model.contextLimit),
      providerId: model.providerId || "",
    };
  });
}

/** Deterministic provider hue so one provider always reads the same across the tab. */
function providerAccent(providerId: string): string {
  if (!providerId) return "var(--accent)";
  let hash = 0;
  for (let i = 0; i < providerId.length; i += 1) hash = (hash * 31 + providerId.charCodeAt(i)) % 360;
  return `hsl(${hash} 58% 54%)`;
}

const ModelSelect: React.FC<{
  value: string;
  choices: ModelChoice[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
}> = ({ value, choices, onChange, ariaLabel, placeholder }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState(0);
  const [isUp, setIsUp] = useState(false);
  const [isEnd, setIsEnd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listIdRef = useRef(`settings-model-${uid()}`);
  const selected = choices.find((choice) => choice.value === value) || null;
  const inheritLabel = placeholder || INHERIT_MODEL_LABEL;

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? choices.filter((choice) =>
          `${choice.label} ${choice.providerName} ${choice.modelName}`.toLowerCase().includes(needle)
        )
      : choices;
    const map = new Map<string, ModelChoice[]>();
    filtered.forEach((choice) => {
      const bucket = map.get(choice.providerName);
      if (bucket) bucket.push(choice);
      else map.set(choice.providerName, [choice]);
    });
    return Array.from(map, ([name, items]) => ({ name, items }));
  }, [choices, query]);

  const flat = useMemo(
    () => [{ value: "", label: inheritLabel }, ...groups.flatMap((group) => group.items)],
    [groups, inheritLabel]
  );

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.querySelector<HTMLElement>('[data-hot="true"]');
    node?.scrollIntoView({ block: "nearest" });
  }, [open, hot]);

  const openPopup = () => {
    if (typeof window !== "undefined") {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        setIsUp(window.innerHeight - rect.bottom < 300);
        setIsEnd(rect.right + 420 > window.innerWidth - 24);
      }
    }
    const index = flat.findIndex((option) => option.value === value);
    setHot(index > -1 ? index : 0);
    setQuery("");
    setOpen(true);
  };

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openPopup();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHot((index) => Math.min(index + 1, flat.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHot((index) => Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setHot(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHot(flat.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(flat[hot]?.value ?? "");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="settings-model-select" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openPopup())}
        className="settings-model-trigger"
      >
        <span
          className="settings-model-dot"
          style={{ background: selected ? providerAccent(selected.providerId) : "var(--accent)" }}
        />
        <span className={`settings-model-trigger-label ${selected ? "" : "is-empty"}`}>
          {selected ? selected.modelName : inheritLabel}
        </span>
        {selected?.contextLabel ? <span className="settings-model-ctx">{selected.contextLabel}</span> : null}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-ink-600 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          className={`settings-model-popup ${isUp ? "is-up" : ""} ${isEnd ? "is-end" : ""}`}
        >
          <div className="settings-model-search-wrap">
            <Search className="settings-model-search-icon" />
            <input
              className="settings-model-search"
              value={query}
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listIdRef.current}
              aria-activedescendant={flat[hot] ? `${listIdRef.current}-${hot}` : undefined}
              placeholder="Search models or providers"
              onChange={(event) => {
                setQuery(event.target.value);
                setHot(event.target.value.trim() && flat.length > 1 ? 1 : 0);
              }}
            />
          </div>

          <div ref={listRef} id={listIdRef.current} className="settings-model-list">
            <button
              type="button"
              role="option"
              id={`${listIdRef.current}-0`}
              aria-selected={value === ""}
              data-hot={hot === 0}
              onMouseEnter={() => setHot(0)}
              onClick={() => pick("")}
              className={`settings-model-option ${value === "" ? "is-selected" : ""} ${hot === 0 ? "is-hot" : ""}`}
            >
              <span className="settings-model-option-label">{inheritLabel}</span>
              {value === "" ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>

            {groups.map((group) => (
              <div key={group.name} className="settings-model-group">
                <div className="settings-model-group-head">
                  <span
                    className="settings-model-group-dot"
                    style={{ background: providerAccent(group.items[0]?.providerId || "") }}
                  />
                  <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  <span className="settings-model-group-count">{group.items.length}</span>
                </div>
                {group.items.map((choice) => {
                  const index = flat.findIndex((option) => option.value === choice.value);
                  const isSelected = choice.value === value;
                  return (
                    <button
                      key={choice.value}
                      type="button"
                      role="option"
                      id={`${listIdRef.current}-${index}`}
                      aria-selected={isSelected}
                      data-hot={hot === index}
                      onMouseEnter={() => setHot(index)}
                      onClick={() => pick(choice.value)}
                      className={`settings-model-option ${isSelected ? "is-selected" : ""} ${hot === index ? "is-hot" : ""}`}
                    >
                      <span className="settings-model-option-label">{choice.modelName}</span>
                      {choice.contextLabel ? <span className="settings-model-meta">{choice.contextLabel}</span> : null}
                      {isSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}

            {groups.length === 0 ? (
              <div className="settings-model-empty">No models match “{query.trim()}”.</div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

type AiRuntimeState = NonNullable<ProviderConfig["aiRuntime"]>;

type RuntimeRow = { key: string; label: string; value: string; provider: string; inherit: boolean };

const AiRuntimeTab: React.FC<{
  draft: ProviderConfig;
  aiRuntime: AiRuntimeState;
  matches: { labInPrompt: boolean; labInSearch: boolean; fortani: boolean; inlineHint: boolean; vision: boolean };
  choices: ModelChoice[];
  labels: Translation;
  onPatch: (updates: Partial<AiRuntimeState>) => void;
  onTokenCountingMode: (mode: TokenCountingMode) => void;
}> = ({ draft, aiRuntime, matches, choices, labels, onPatch, onTokenCountingMode }) => {
  const readId = (raw?: string) => (typeof raw === "string" ? raw.trim() : "");
  const selectValue = (raw?: string) => {
    const id = readId(raw);
    return id && choices.some((choice) => choice.value === id) ? id : "";
  };
  const inlineHintEnabled = aiRuntime.inlineHintEnabled === true;

  const promptId = readId(aiRuntime.labInPromptModelId);
  const searchId = readId(aiRuntime.labInSearchModelId);
  const visionId = readId(aiRuntime.visionModelId);
  const fortaniId = readId(aiRuntime.fortaniModelId);
  const inlineHintId = readId(aiRuntime.inlineHintModelId);

  const mainModel =
    draft.models.find((model) => model.id === draft.selectedModelId || model.name === draft.selectedModelId) || null;
  const mainProvider = mainModel ? draft.providers.find((provider) => provider.id === mainModel.providerId) : null;
  const mainProviderName = mainModel ? mainProvider?.name || "Unassigned provider" : "";

  const stage = (raw: string, missing: boolean): Omit<RuntimeRow, "key" | "label"> => {
    const choice = raw ? choices.find((item) => item.value === raw) || null : null;
    if (!raw || missing || !choice) {
      return { value: "main model", provider: mainProviderName, inherit: true };
    }
    return { value: choice.modelName, provider: choice.providerName, inherit: false };
  };

  const runtimeRows: RuntimeRow[] = [
    {
      key: "main",
      label: "Main model",
      value: mainModel ? mainModel.name || mainModel.id : "Not selected",
      provider: mainModel ? mainProviderName : "Active chat model",
      inherit: false,
    },
    { key: "prompt", label: "Prompt refiner", ...stage(promptId, matches.labInPrompt) },
    { key: "search", label: "Knowledge search", ...stage(searchId, matches.labInSearch) },
    { key: "vision", label: "Vision", ...stage(visionId, matches.vision) },
    { key: "fortani", label: "FoRtani", ...stage(fortaniId, matches.fortani) },
    { key: "autocomplete", label: "Autocomplete", ...stage(inlineHintId, matches.inlineHint) },
  ];

  const routing: Array<{
    key: string;
    title: string;
    description: string;
    titleText: string;
    icon: ReactNode;
    aria: string;
    value: string;
    onChange: (next: string) => void;
    warning: string;
  }> = [
    {
      key: "prompt",
      title: "LAB-IN prompt refiner",
      description: "Rewrites the task into a precise brief before the agent run. Empty = active chat model.",
      titleText:
        "Stage models inherit the active chat model when left empty. The main task always executes with the active chat model.",
      icon: <Sparkles className="h-3.5 w-3.5" />,
      aria: "LAB-IN prompt refiner model",
      value: selectValue(aiRuntime.labInPromptModelId),
      onChange: (next) => onPatch({ labInPromptModelId: next || "" }),
      warning:
        promptId && matches.labInPrompt
          ? `Saved prompt model "${promptId}" is missing — falls back to main model.`
          : "",
    },
    {
      key: "search",
      title: "LAB-IN knowledge search",
      description: "Searches shared knowledge memory for reusable notes before answering. Empty = active chat model.",
      titleText:
        "Stage models inherit the active chat model when left empty. The main task always executes with the active chat model.",
      icon: <Search className="h-3.5 w-3.5" />,
      aria: "LAB-IN knowledge search model",
      value: selectValue(aiRuntime.labInSearchModelId),
      onChange: (next) => onPatch({ labInSearchModelId: next || "" }),
      warning:
        searchId && matches.labInSearch
          ? `Saved search model "${searchId}" is missing — falls back to main model.`
          : "",
    },
    {
      key: "vision",
      title: "Vision",
      description: "Reads screenshots, reference photos and Blender renders. Empty = active chat model.",
      titleText:
        "Model used by the vision tool to read screenshots, reference photos and Blender renders. DeepSeek flash/v4 accept images (PNG/JPEG/WebP/GIF); leave empty to use the active chat model.",
      icon: <Eye className="h-3.5 w-3.5" />,
      aria: "Vision model",
      value: selectValue(aiRuntime.visionModelId),
      onChange: (next) => onPatch({ visionModelId: next || "" }),
      warning:
        visionId && matches.vision
          ? `Saved vision model "${visionId}" is missing — falls back to the active chat model.`
          : "",
    },
    {
      key: "fortani",
      title: "FoRtani follow-up",
      description: "Reviews the task and the agent's diff, then sends corrections back. Does not edit files.",
      titleText:
        "Model that reviews the task and the agent's diff, then sends corrections back. It does not edit files. Empty = active chat model. The main agent still applies the fixes.",
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      aria: "FoRtani follow-up model",
      value: selectValue(aiRuntime.fortaniModelId),
      onChange: (next) => onPatch({ fortaniModelId: next || "" }),
      warning:
        fortaniId && matches.fortani
          ? `Saved FoRtani model "${fortaniId}" is missing — falls back to main model.`
          : "",
    },
    {
      key: "autocomplete",
      title: "Composer autocomplete",
      description: "Faint ghost text continues the prompt while typing; Tab inserts it. Empty = active chat model.",
      titleText:
        "While you type a prompt, the model continues it as faint ghost text inside the input. Tab inserts the suggestion; keep typing and a fresh one appears.",
      icon: <Wand2 className="h-3.5 w-3.5" />,
      aria: "Composer autocomplete model",
      value: selectValue(aiRuntime.inlineHintModelId),
      onChange: (next) => onPatch({ inlineHintModelId: next || "" }),
      warning:
        inlineHintId && matches.inlineHint
          ? `Saved autocomplete model "${inlineHintId}" is missing — falls back to the main model.`
          : "",
    },
  ];

  return (
    <div className="settings-body-scroll settings-chat-scrollbar">
      <div className="settings-section settings-ai-section">
        <div className="settings-ai-grid">
          <div className="settings-ai-col">
            <div className="settings-card">
              <div className="mb-2 flex items-center gap-2">
                <Layers className="h-3.5 w-3.5 shrink-0 text-ink-600" />
                <div className="settings-card-title !mb-0">Model routing</div>
              </div>
              <p className="mb-3 text-[11px] leading-snug text-ink-500">
                Stage models inherit the active chat model when left empty. The main task always executes with the
                active chat model.
              </p>

              <div className="settings-routing-list">
                {routing.map((row) => (
                  <div key={row.key} className="settings-routing-entry">
                    <div className="settings-routing-row">
                      <span className="settings-routing-icon" title={row.title}>
                        {row.icon}
                      </span>
                      <div className="settings-routing-body">
                        <div className="settings-routing-title" title={row.titleText}>
                          {row.title}
                        </div>
                        <p className="settings-routing-desc" title={row.titleText}>
                          {row.description}
                        </p>
                      </div>
                      <div className="settings-routing-picker">
                        <ModelSelect
                          value={row.value}
                          choices={choices}
                          ariaLabel={row.aria}
                          onChange={row.onChange}
                        />
                      </div>
                    </div>
                    {row.warning ? (
                      <p className="settings-routing-warning" style={{ color: "var(--danger)" }}>
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        <span className="min-w-0">{row.warning}</span>
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">Composer autocomplete</div>
              <p className="mb-2 text-[11px] leading-snug text-ink-500">
                While you type a prompt, the model continues it as faint ghost text inside the input. Tab inserts the
                suggestion; keep typing and a fresh one appears. It sees the whole input and the current caret
                position.
              </p>
              <button
                type="button"
                onClick={() => onPatch({ inlineHintEnabled: !inlineHintEnabled })}
                className="settings-toggle-row"
              >
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                    inlineHintEnabled ? "theme-toggle-on" : "border-ink-300 bg-ink-300"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-3.5 w-3.5 rounded-full theme-toggle-thumb shadow-sm transition-transform ${
                      inlineHintEnabled ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </span>
                <span
                  className="min-w-0 text-[12px] leading-none"
                  style={{ color: inlineHintEnabled ? "var(--ink-950)" : "var(--ink-700)" }}
                >
                  {inlineHintEnabled ? "Ghost suggestions on · Tab to insert" : "Ghost suggestions off"}
                </span>
              </button>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">Cloudflare image</div>
              <p className="mb-3 text-[11px] leading-snug text-ink-500">
                Used by generate_image. Flux 2 Dev draws the subject on a flat green screen, then the tool removes only
                that green.
              </p>
              <div className="settings-grid-2">
                <Field
                  label="Account ID"
                  mono
                  value={typeof aiRuntime.cloudflareAccountId === "string" ? aiRuntime.cloudflareAccountId : ""}
                  placeholder="account id"
                  onChange={(next) => onPatch({ cloudflareAccountId: next.trim() })}
                />
                <Field
                  label="API token"
                  mono
                  type="password"
                  value={typeof aiRuntime.cloudflareApiToken === "string" ? aiRuntime.cloudflareApiToken : ""}
                  placeholder="cfut_…"
                  onChange={(next) => onPatch({ cloudflareApiToken: next.trim() })}
                />
              </div>
            </div>
          </div>

          <aside className="settings-ai-aside">
            <div className="settings-card">
              <div className="mb-2 flex items-center gap-2">
                <Bot className="h-3.5 w-3.5 shrink-0 text-ink-600" />
                <div className="settings-card-title !mb-0">Runtime map</div>
              </div>
              <div className="settings-runtime-map">
                {runtimeRows.map((row) => (
                  <div key={row.key} className="settings-runtime-row">
                    <div className="settings-runtime-label">{row.label}</div>
                    {row.inherit ? (
                      <div className="settings-runtime-value is-inherit">main model</div>
                    ) : (
                      <div className="settings-runtime-value" title={row.value}>
                        {row.value}
                      </div>
                    )}
                    {row.provider ? (
                      <div className="settings-runtime-provider" title={row.provider}>
                        {row.provider}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">{labels.notifications}</div>
              <button
                type="button"
                onClick={() => onPatch({ agentCompletionNotifications: !aiRuntime.agentCompletionNotifications })}
                className="settings-toggle-row"
              >
                <span
                  className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                    aiRuntime.agentCompletionNotifications ? "theme-toggle-on" : "border-ink-300 bg-ink-300"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-3.5 w-3.5 rounded-full theme-toggle-thumb shadow-sm transition-transform ${
                      aiRuntime.agentCompletionNotifications ? "translate-x-4" : "translate-x-0.5"
                    }`}
                  />
                </span>
                <span
                  className="min-w-0 text-[12px] leading-none"
                  style={{ color: aiRuntime.agentCompletionNotifications ? "var(--ink-950)" : "var(--ink-700)" }}
                >
                  {aiRuntime.agentCompletionNotifications
                    ? labels.notifyWhenAgentFinishes
                    : labels.finishNotificationsOff}
                </span>
              </button>
            </div>

            <div className="settings-card">
              <div className="settings-card-title">Token counting</div>
              <div className="settings-lang-row">
                {[
                  { value: "provider" as const, title: "Provider" },
                  { value: "auto" as const, title: "Estimate" },
                ].map((mode) => {
                  const active = (draft.tokenCountingMode || "provider") === mode.value;
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => onTokenCountingMode(mode.value)}
                      className={`settings-chip ${active ? "is-active" : ""}`}
                    >
                      {mode.title}
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
};

/**
 * CF Mail (cf_mail) credentials editor — reads/writes the shared
 * runtime-app/data/config.json store used by the cf_mail tool.
 * Self-contained: loads on mount, saves explicitly, can probe the worker.
 */
const CfMailSettings: React.FC = () => {
  const [cfg, setCfg] = useState<CfMailConfig | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string; status?: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.lopster
      ?.readCfMailConfig?.()
      .then((loaded) => {
        if (!cancelled && loaded) setCfg(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setErrorMsg(error instanceof Error ? error.message : "Failed to load CF Mail config");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<CfMailConfig>) =>
    setCfg((prev) => (prev ? { ...prev, ...patch } : (patch as CfMailConfig)));

  const save = useCallback(async () => {
    if (!cfg) return;
    setStatus("saving");
    setErrorMsg(null);
    try {
      const saved = await window.lopster?.writeCfMailConfig?.(cfg);
      if (saved) {
        setCfg(saved);
        setStatus("saved");
      } else {
        setStatus("error");
        setErrorMsg("CF Mail bridge is unavailable");
      }
    } catch (error: unknown) {
      setStatus("error");
      setErrorMsg(error instanceof Error ? error.message : "Failed to save CF Mail config");
    }
  }, [cfg]);

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setErrorMsg(null);
    try {
      // Persist first so the probe always runs against the latest values.
      if (cfg) await window.lopster?.writeCfMailConfig?.(cfg);
      const res = await window.lopster?.testCfMail?.();
      setTestResult(res || null);
    } catch (error: unknown) {
      setErrorMsg(error instanceof Error ? error.message : "CF Mail test failed");
    } finally {
      setTesting(false);
    }
  }, [cfg]);

  if (!cfg) {
    return <div className="settings-empty">Loading CF Mail configuration…</div>;
  }

  const configured = Boolean(cfg.cfworker_api_url && cfg.cfworker_admin_token);

  return (
    <div className="settings-body-scroll settings-chat-scrollbar">
      <div className="settings-section">
        <div className="settings-card">
          <div className="flex h-7 items-center gap-2">
            <Mail className="h-3.5 w-3.5 shrink-0 text-ink-600" />
            <div className="settings-card-title !mb-0">CF Worker temp-mail</div>
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: configured ? "var(--ok)" : "var(--ink-400)" }}
              title={configured ? "Configured" : "Not configured"}
            />
          </div>
          <p className="mt-1 text-[11px] leading-snug text-ink-500">
            Credentials for the <span className="font-mono">cf_mail</span> tool. Saved to{" "}
            <span className="font-mono text-ink-700">runtime-app/data/config.json</span>.
          </p>

          <div className="mt-3 grid gap-2">
            <Field
              label="API URL"
              mono
              value={cfg.cfworker_api_url}
              placeholder="https://…workers.dev"
              onChange={(next) => set({ cfworker_api_url: next.trim() })}
            />
            <Field
              label="Admin token"
              mono
              type="password"
              value={cfg.cfworker_admin_token}
              placeholder="x-admin-auth token"
              onChange={(next) => set({ cfworker_admin_token: next.trim() })}
            />
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="Domain"
                mono
                value={cfg.cfworker_domain}
                placeholder="default domain"
                onChange={(next) => set({ cfworker_domain: next.trim() })}
              />
              <Field
                label="Fingerprint"
                mono
                value={cfg.cfworker_fingerprint}
                placeholder="optional"
                onChange={(next) => set({ cfworker_fingerprint: next.trim() })}
              />
            </div>

            <button
              type="button"
              onClick={() => set({ enable_prefix: !cfg.enable_prefix })}
              className="settings-toggle-row"
            >
              <span className="text-[12px] leading-none" style={{ color: cfg.enable_prefix ? "var(--ink-950)" : "var(--ink-700)" }}>
                Enable prefix on new addresses
              </span>
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
                  cfg.enable_prefix ? "theme-toggle-on" : "border-ink-300 bg-ink-300"
                }`}
              >
                <span
                  className={`absolute top-[3px] h-3.5 w-3.5 rounded-full theme-toggle-thumb shadow-sm transition-transform ${
                    cfg.enable_prefix ? "translate-x-4" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          </div>

          <div className="mt-4 flex items-center gap-2">
            <button type="button" onClick={save} disabled={status === "saving"} className="ui-btn-primary">
              {status === "saving" ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={test}
              disabled={testing || !configured}
              className="theme-soft"
              style={{ color: "var(--ink-800)" }}
            >
              {testing ? "Testing…" : "Test connection"}
            </button>
            <span className="min-w-0 truncate text-[10px] tracking-[0.03em]" style={{ color: "var(--ink-600)" }}>
              {status === "saved"
                ? "Saved to JSON"
                : status === "error"
                  ? errorMsg || "Save failed"
                  : ""}
            </span>
          </div>

          {testResult ? (
            <div
              className="mt-2 rounded-md border px-2.5 py-2 text-[11px] leading-snug"
              style={{
                borderColor: testResult.ok ? "var(--border-strong)" : "var(--danger)",
                color: testResult.ok ? "var(--ink-800)" : "var(--danger)",
              }}
            >
              {testResult.ok
                ? `Worker reachable (HTTP ${testResult.status ?? "ok"}).`
                : testResult.reason === "missing_credentials"
                  ? "Add API URL and Admin token first."
                  : testResult.reason === "bad_token"
                    ? "Worker rejected the admin token (401/403)."
                    : testResult.reason === "timeout"
                      ? "Worker timed out — check the API URL."
                      : `Worker unreachable (${testResult.reason ?? "error"}).`}
            </div>
          ) : null}

          {cfg.config_path ? (
            <p className="mt-2 truncate text-[10px] text-ink-500" title={cfg.config_path}>
              {cfg.config_path}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const SettingsContent: React.FC<SettingsModalProps> = ({ open, onClose, config, labels, language, onLanguageChange, onChange }) => {
  const [state, dispatch] = useReducer(fsmReducer, { status: "idle", draft: config, errorMsg: null, tx: 0 });
  const [activeTab, setActiveTab] = useState<NavTab>("appearance");
  const [theme, setTheme] = useState<ThemeId>(() =>
    typeof window !== "undefined" ? getStoredTheme() : "mono"
  );
  const [mouseSnippets, setMouseSnippets] = useState<MouseSnippetsConfig>(() =>
    typeof window !== "undefined" ? loadMouseSnippets() : { ...DEFAULT_MOUSE_SNIPPETS }
  );
  const txRef = useRef(0);
  const statusRef = useRef<SaveStatus>("idle");

  useEffect(() => { statusRef.current = state.status; }, [state.status]);
  useEffect(() => {
    if (!open) {
      dispatch({ type: "RESET", payload: config });
      return;
    }
    if (statusRef.current === "idle" || statusRef.current === "saved") {
      dispatch({ type: "RESET", payload: config });
    }
  }, [config, open]);

  useEffect(() => {
    if (open) setMouseSnippets(loadMouseSnippets());
  }, [open]);

  const updateMouseSnippets = (next: MouseSnippetsConfig) => {
    setMouseSnippets(next);
    saveMouseSnippets(next);
  };

  const commitConfig = useCallback((next: ProviderConfig) => {
    const tx = ++txRef.current;
    dispatch({ type: "EDIT", payload: next });
    dispatch({ type: "SAVE_START", tx });
    Promise.resolve()
      .then(() => onChange(next))
      .then((saved) => {
        if (saved && typeof saved === "object" && Array.isArray((saved as ProviderConfig).providers)) {
          dispatch({ type: "RESET", payload: saved as ProviderConfig });
        }
        dispatch({ type: "SAVE_OK", tx });
      })
      .catch((error: unknown) => dispatch({ type: "SAVE_ERR", tx, payload: error instanceof Error ? error.message : labels.failedToSaveConfig }));
  }, [onChange, labels.failedToSaveConfig]);

  if (!open) return null;

  const draft = state.draft;
  const aiRuntime = draft.aiRuntime || {
    agentCompletionNotifications: true,
    labInPromptModelId: "",
    labInSearchModelId: "",
    fortaniModelId: "",
    cloudflareAccountId: "",
    cloudflareApiToken: "",
    inlineHintEnabled: false,
    inlineHintModelId: "",
  };
  const labInPromptModelId =
    typeof aiRuntime.labInPromptModelId === "string" ? aiRuntime.labInPromptModelId.trim() : "";
  const labInSearchModelId =
    typeof aiRuntime.labInSearchModelId === "string" ? aiRuntime.labInSearchModelId.trim() : "";
  const labInPromptModelMatch = labInPromptModelId
    ? draft.models.find((m) => m.id === labInPromptModelId || m.name === labInPromptModelId)
    : null;
  const labInSearchModelMatch = labInSearchModelId
    ? draft.models.find((m) => m.id === labInSearchModelId || m.name === labInSearchModelId)
    : null;
  const fortaniModelId =
    typeof aiRuntime.fortaniModelId === "string" ? aiRuntime.fortaniModelId.trim() : "";
  const fortaniModelMatch = fortaniModelId
    ? draft.models.find((m) => m.id === fortaniModelId || m.name === fortaniModelId)
    : null;
  const inlineHintModelId =
    typeof aiRuntime.inlineHintModelId === "string" ? aiRuntime.inlineHintModelId.trim() : "";
  const inlineHintModelMatch = inlineHintModelId
    ? draft.models.find((m) => m.id === inlineHintModelId || m.name === inlineHintModelId)
    : null;
  const visionModelId =
    typeof aiRuntime.visionModelId === "string" ? aiRuntime.visionModelId.trim() : "";
  const visionModelMatch = visionModelId
    ? draft.models.find((m) => m.id === visionModelId || m.name === visionModelId)
    : null;
  const modelChoices = buildModelChoices(draft);

  const updateAiRuntime = (updates: Partial<typeof aiRuntime>) => commitConfig({ ...draft, aiRuntime: { ...aiRuntime, ...updates } });
  const tabTitle = {
    appearance: labels.appearance,
    ai: labels.settingsAiRuntime,
    shortcuts: labels.settingsShortcuts,
    cfmail: "CF Mail",
    setup: "Setup",
  }[activeTab];
  const tabSubtitle = {
    appearance: "Theme, language and mouse snippets",
    ai: "Model routing, stage models and runtime behavior",
    shortcuts: labels.mouseSnippets,
    cfmail: "cf_mail credentials",
    setup: "Install runtimes",
  }[activeTab];

  return (
    <div className="settings-scrim animate-fade-in" onClick={onClose}>
      <div
        className="settings-modal"
        onClick={(event) => event.stopPropagation()}
        style={{ contain: "layout paint", transform: "translateZ(0)" }}
      >
        <aside className="settings-rail">
          <div className="settings-rail-brand">
            <div className="min-w-0">
              <div className="settings-rail-brand-title">Settings</div>
              <div className="settings-rail-brand-sub">ComposeVC</div>
            </div>
          </div>
          <nav className="settings-rail-nav scrollbar-thin">
            <NavItem
              active={activeTab === "appearance"}
              icon={<Palette className="h-4 w-4" />}
              label={labels.appearance}
              hint={labels.languages}
              onClick={() => setActiveTab("appearance")}
            />
            <NavItem
              active={activeTab === "ai"}
              icon={<Cpu className="h-4 w-4" />}
              label={labels.settingsAiRuntime}
              hint="Models & routing"
              onClick={() => setActiveTab("ai")}
            />
            <NavItem
              active={activeTab === "shortcuts"}
              icon={<Keyboard className="h-4 w-4" />}
              label={labels.settingsShortcuts}
              hint={labels.mouseSnippets}
              onClick={() => setActiveTab("shortcuts")}
            />
            <NavItem
              active={activeTab === "cfmail"}
              icon={<Mail className="h-4 w-4" />}
              label="CF Mail"
              hint="cf_mail"
              onClick={() => setActiveTab("cfmail")}
            />
            <NavItem
              active={activeTab === "setup"}
              icon={<IcoDownload className="h-4 w-4" />}
              label="Setup"
              hint="Установка сред"
              onClick={() => setActiveTab("setup")}
            />
          </nav>
          <div className="settings-rail-foot">
            <StatusText status={state.status} errorMsg={state.errorMsg} labels={labels} />
          </div>
        </aside>

        <section className="settings-main">
          <header className="settings-header">
            <div className="min-w-0 flex items-center gap-3">
              <div className="settings-header-mark">C</div>
              <div className="min-w-0">
                <h2 className="settings-header-title truncate">{tabTitle}</h2>
                <p className="settings-header-subtitle">{tabSubtitle}</p>
              </div>
            </div>
            <div className="settings-header-actions">
              <button type="button" onClick={onClose} aria-label={labels.close} className="settings-icon-btn">
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <ChatMonoScroll className="settings-modal-scroll">
          <div className="settings-body settings-body-all">
            {activeTab === "appearance" && (
              <div className="settings-body-scroll">
              <div className="settings-section">
                <div className="settings-card">
                  <div className="settings-card-title">Theme</div>
                  <div className="grid gap-2">
                    {THEMES.map((t) => {
                      const active = theme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            applyTheme(t.id);
                            setTheme(t.id);
                          }}
                          className="settings-theme-row"
                          aria-pressed={active}
                        >
                          <span className="settings-theme-swatches">
                            {t.swatches.map((c, i) => (
                              <span
                                key={i}
                                className="settings-theme-swatch"
                                style={{ backgroundColor: c }}
                              />
                            ))}
                          </span>
                          <span className="min-w-0 flex-1 text-left">
                            <span className="block text-[13px] font-semibold leading-5 text-ink-950">
                              {t.name}
                            </span>
                            <span className="block text-[11px] leading-snug text-ink-500">
                              {t.description}
                            </span>
                          </span>
                          <span
                            className="settings-theme-active-dot"
                            style={{ backgroundColor: active ? "var(--accent)" : "transparent" }}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-title">{labels.languages}</div>
                  <p className="mb-3 text-[11px] leading-snug text-ink-500">
                    Interface language — applies immediately across the whole app.
                  </p>
                  <div className="settings-lang-row">
                    {(Object.keys(languageNames) as AppLanguage[]).map((code) => {
                      const selected = language === code;
                      return (
                        <button
                          key={code}
                          type="button"
                          onClick={() => onLanguageChange(code)}
                          className={`settings-chip ${selected ? "is-active" : ""}`}
                        >
                          {languageNames[code]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              </div>
            )}

            {activeTab === "shortcuts" && (
              <div className="settings-body-scroll settings-chat-scrollbar">
              <div className="settings-section">
                <div className="settings-card">
                  <div className="settings-card-title">{labels.settingsShortcuts}</div>
                  <div className="settings-grid-2">
                    {keyboardShortcuts(labels).map((item) => (
                      <div key={item.keys} className="settings-shortcut-row">
                        <kbd className="settings-kbd">{item.keys}</kbd>
                        <div className="min-w-0 text-[12px] leading-5 text-ink-800">{item.action}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="settings-card">
                  <div className="flex h-7 items-center gap-2 mb-2">
                    <Mouse className="h-3.5 w-3.5 shrink-0 text-ink-600" />
                    <div className="settings-card-title !mb-0">{labels.mouseSnippets}</div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => updateMouseSnippets({ ...mouseSnippets, enabled: !mouseSnippets.enabled })}
                      className="inline-flex h-7 items-center gap-2 px-2 text-left outline-none"
                    >
                      <span
                        className="inline-flex items-center gap-2 text-[12px] leading-none"
                        style={{ color: mouseSnippets.enabled ? "var(--ink-950)" : "var(--ink-700)" }}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: mouseSnippets.enabled ? "var(--ok)" : "var(--ink-400)" }}
                        />
                        {mouseSnippets.enabled ? labels.snippetsOn : labels.snippetsOff}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => updateMouseSnippets({ ...mouseSnippets, append: !mouseSnippets.append })}
                      className="inline-flex h-7 items-center px-2 text-[11px] leading-none text-ink-700 outline-none"
                    >
                      {mouseSnippets.append ? labels.appendToInput : labels.replaceInput}
                    </button>
                  </div>

                  <div className="mt-3 settings-grid-2">
                    {([1, 2] as const).map((slotNum) => {
                      const key = slotNum === 1 ? "slot1" : "slot2";
                      const slot = mouseSnippets[key];
                      return (
                        <div key={key} className="min-w-0">
                          <div className="mb-1.5 flex h-7 items-center justify-between gap-2">
                            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                              {labels.slotN.replace("{n}", String(slotNum))}
                            </span>
                            <UiSelect
                              compact
                              className="w-[7.5rem] shrink-0"
                              ariaLabel={labels.mouseSlotAria.replace("{n}", String(slotNum))}
                              value={String(slot.button === 4 ? 4 : 3)}
                              options={[
                                { value: "3", label: labels.mouseBack },
                                { value: "4", label: labels.mouseForward },
                              ]}
                              onChange={(next) => {
                                const button = next === "4" ? 4 : 3;
                                updateMouseSnippets({
                                  ...mouseSnippets,
                                  [key]: { ...slot, button },
                                });
                              }}
                            />
                          </div>
                          <textarea
                            value={slot.text}
                            onChange={(e) =>
                              updateMouseSnippets({
                                ...mouseSnippets,
                                [key]: { ...slot, text: e.target.value },
                              })
                            }
                            rows={3}
                            placeholder={labels.mouseSnippetPlaceholder}
                            className="settings-field-textarea"
                            style={{ caretColor: PRIMARY }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
              </div>
            )}


            {activeTab === "ai" && (
              <AiRuntimeTab
                draft={draft}
                aiRuntime={aiRuntime}
                matches={{
                  labInPrompt: !!labInPromptModelId && !labInPromptModelMatch,
                  labInSearch: !!labInSearchModelId && !labInSearchModelMatch,
                  fortani: !!fortaniModelId && !fortaniModelMatch,
                  inlineHint: !!inlineHintModelId && !inlineHintModelMatch,
                  vision: !!visionModelId && !visionModelMatch,
                }}
                choices={modelChoices}
                labels={labels}
                onPatch={updateAiRuntime}
                onTokenCountingMode={(mode) => commitConfig({ ...draft, tokenCountingMode: mode })}
              />
            )}

            {activeTab === "cfmail" && <CfMailSettings />}

            {activeTab === "setup" && <SetupSettings labels={labels} />}

          </div>
          </ChatMonoScroll>
        </section>
      </div>
    </div>
  );
};

const SettingsModal: React.FC<SettingsModalProps> = (props) => (
  <SettingsBoundary labels={props.labels}>
    <SettingsContent {...props} />
  </SettingsBoundary>
);

export default SettingsModal;
