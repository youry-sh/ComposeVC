import React, {
  Component,
  ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Check,
  Clipboard,
  Cpu,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Translation } from "../i18n";
import { AIModel, AIProvider, ProviderConfig } from "../types";

export interface ProvidersModalProps {
  open: boolean;
  onClose: () => void;
  config: ProviderConfig;
  labels: Translation;
  onChange: (config: ProviderConfig) => void | Promise<void | ProviderConfig>;
}

type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const uid = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const MAX_MODEL_CONTEXT_TOKENS = 256000;
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const PRIMARY = "var(--accent)";

const PROVIDER_PRESETS: Array<{
  key: "openai" | "anthropic";
  name: string;
  type: AIProvider["type"];
  baseUrl: string;
  model: string;
  icon: string;
}> = [
  { key: "openai", name: "OpenAI", type: "openai", baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, icon: "./logo/providers/openai.png" },
  { key: "anthropic", name: "Anthropic", type: "anthropic", baseUrl: ANTHROPIC_BASE_URL, model: ANTHROPIC_MODEL, icon: "./logo/providers/anthropic.svg" },
];

function providerBrand(provider: AIProvider) {
  const name = provider.name.trim().toLowerCase();
  if (name.includes("openai") || provider.baseUrl.includes("api.openai.com")) return PROVIDER_PRESETS[0];
  if (name.includes("anthropic") || provider.baseUrl.includes("api.anthropic.com")) return PROVIDER_PRESETS[1];
  return null;
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

class ProvidersBoundary extends Component<{ children: ReactNode; labels?: Translation }, { failed: boolean; message: string }> {
  state = { failed: false, message: "" };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, message: error instanceof Error ? error.message : "Providers render failed" };
  }

  componentDidCatch(error: unknown) {
    console.error("Providers module recovered from an exception", error);
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
        className={`settings-field-input ${mono ? "font-mono" : ""} ${suffix ? "pr-14" : ""}`}
        style={{ caretColor: PRIMARY }}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-0 z-[1] flex w-14 items-center justify-center">
          <span className="pointer-events-auto flex h-7 items-center justify-center">{suffix}</span>
        </span>
      )}
    </span>
  </label>
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
      color: danger ? "var(--danger)" : active ? "var(--active-fg)" : undefined,
      willChange: "opacity",
      ...style,
    }}
  />
);

const ProvidersContent: React.FC<ProvidersModalProps> = ({ open, onClose, config, labels, onChange }) => {
  const [state, dispatch] = useReducer(fsmReducer, { status: "idle", draft: config, errorMsg: null, tx: 0 });
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [copiedKeys, setCopiedKeys] = useState<Record<string, boolean>>({});
  const copyResetTimers = useRef<Record<string, number>>({});
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
    if (!open) return;
    const providers = state.draft.providers;
    if (providers.length === 0) {
      setSelectedProviderId(null);
      return;
    }
    if (!selectedProviderId || !providers.some((p) => p.id === selectedProviderId)) {
      setSelectedProviderId(providers[0].id);
    }
  }, [open, state.draft.providers, selectedProviderId]);

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
      .catch((error: unknown) => dispatch({ type: "SAVE_ERR", tx, payload: error instanceof Error ? error.message : (labels.failedToSaveConfig || "Save failed") }));
  }, [onChange, labels.failedToSaveConfig]);

  if (!open) return null;

  const draft = state.draft;
  const activeProvider =
    draft.providers.find((p) => p.id === selectedProviderId) || draft.providers[0] || null;
  const activeProviderModels = activeProvider
    ? draft.models.filter((model) => model.providerId === activeProvider.id)
    : [];

  const addProvider = (preset?: (typeof PROVIDER_PRESETS)[number]) => {
    const providerId = uid();
    const modelId = uid();
    const n = draft.providers.length + 1;
    const provider: AIProvider = {
      id: providerId,
      name: preset?.name || `Provider ${n}`,
      type: preset?.type || "openai-compat",
      baseUrl: preset?.baseUrl || OPENAI_BASE_URL,
      apiKey: "",
    };
    const model: AIModel = {
      id: modelId,
      name: preset?.model || OPENAI_MODEL,
      providerId,
      contextLimit: MAX_MODEL_CONTEXT_TOKENS,
    };
    setSelectedProviderId(providerId);
    commitConfig({
      ...draft,
      providers: [...draft.providers, provider],
      models: [...draft.models, model],
      selectedModelId: draft.selectedModelId || modelId,
    });
  };

  const updateProvider = (id: string, updates: Partial<AIProvider>) =>
    commitConfig({
      ...draft,
      providers: draft.providers.map((provider) => (provider.id === id ? { ...provider, ...updates } : provider)),
    });

  const copyApiKey = async (provider: AIProvider) => {
    const key = provider.apiKey.trim();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      const id = provider.id;
      setCopiedKeys((current) => ({ ...current, [id]: true }));
      if (copyResetTimers.current[id]) window.clearTimeout(copyResetTimers.current[id]);
      copyResetTimers.current[id] = window.setTimeout(() => {
        setCopiedKeys((current) => ({ ...current, [id]: false }));
        delete copyResetTimers.current[id];
      }, 1200);
    } catch {
      /* Clipboard can be unavailable in a restricted renderer context. */
    }
  };

  const deleteProvider = (id: string) => {
    const nextProviders = draft.providers.filter((provider) => provider.id !== id);
    const nextModels = draft.models.filter((model) => model.providerId !== id);
    if (selectedProviderId === id) setSelectedProviderId(nextProviders[0]?.id ?? null);
    commitConfig({
      ...draft,
      providers: nextProviders,
      models: nextModels,
      selectedModelId: nextModels.some((model) => model.id === draft.selectedModelId)
        ? draft.selectedModelId
        : nextModels[0]?.id,
    });
  };

  const addModel = (providerId: string) => {
    const model: AIModel = { id: uid(), name: "new-model", providerId, contextLimit: MAX_MODEL_CONTEXT_TOKENS };
    commitConfig({ ...draft, models: [...draft.models, model], selectedModelId: draft.selectedModelId || model.id });
  };

  const updateModel = (id: string, updates: Partial<AIModel>) =>
    commitConfig({ ...draft, models: draft.models.map((model) => (model.id === id ? { ...model, ...updates } : model)) });

  const deleteModel = (id: string) => {
    const nextModels = draft.models.filter((model) => model.id !== id);
    commitConfig({
      ...draft,
      models: nextModels,
      selectedModelId: draft.selectedModelId === id ? nextModels[0]?.id : draft.selectedModelId,
    });
  };

  const statusVisible = state.status !== "idle";
  const statusLabel =
    state.status === "dirty"
      ? labels.statusQueued
      : state.status === "saving"
        ? labels.statusSyncing
        : state.status === "saved"
          ? labels.statusSaved
          : state.status === "error"
            ? state.errorMsg || labels.statusError
            : "";

  return (
    <div className="providers-scrim" onClick={onClose}>
      <div
        className="providers-modal animate-fade-in"
        onClick={(event) => event.stopPropagation()}
        style={{ transform: "translate3d(0,0,0)", willChange: "opacity, transform" }}
      >
        <header className="providers-header">
          <div className="min-w-0 flex items-center gap-3">
            <div className="settings-header-mark">
              <Cpu className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="settings-header-title truncate">{labels.settingsRouting}</h2>
              <p className="settings-header-subtitle">{labels.settingsRoutingDescription}</p>
            </div>
          </div>
          <div className="settings-header-actions">
            <span
              className="inline-block max-w-[140px] truncate text-[10px] tracking-[0.03em]"
              style={{
                color:
                  state.status === "error"
                    ? "var(--danger)"
                    : state.status === "saved"
                      ? "var(--ink-950)"
                      : "var(--ink-600)",
                opacity: statusVisible ? 1 : 0,
                transition: "opacity 180ms cubic-bezier(.22,1,.36,1)",
              }}
            >
              {statusLabel}
            </span>
            <div className="flex items-center gap-1">
              <QuietButton onClick={() => addProvider()} className="h-8 px-2.5" title="Add provider">
                <Plus className="h-3.5 w-3.5" />
                {labels.addProvider}
              </QuietButton>
            </div>
            <button type="button" onClick={onClose} aria-label={labels.close} className="settings-icon-btn">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="providers-body">
          <div className="settings-providers">
            <div className="settings-providers-list">
              <div className="providers-list-head">
                <span>{labels.models}</span>
                <span className="providers-count">{draft.providers.length}</span>
              </div>
              <div className="settings-providers-list-scroll scrollbar-thin">
                {draft.providers.length === 0 ? (
                  <div className="settings-empty">{labels.noProvidersYet}</div>
                ) : (
                  <div className="providers-square-grid">
                    {draft.providers.map((provider) => {
                      const models = draft.models.filter((model) => model.providerId === provider.id);
                      const active = activeProvider?.id === provider.id;
                      const brand = providerBrand(provider);
                      return (
                        <button
                          key={provider.id}
                          type="button"
                          onClick={() => setSelectedProviderId(provider.id)}
                          className={`settings-provider-row ${active ? "is-active" : ""}`}
                        >
                          <span className={`providers-square-mark ${brand ? "is-brand" : ""}`}>
                            {brand ? <img src={brand.icon} alt="" /> : provider.name.trim().slice(0, 1).toUpperCase() || "P"}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12px] font-semibold">{provider.name || "Provider"}</span>
                            <span className="mt-0.5 block truncate font-mono text-[10px] text-ink-500">
                              {models.length} {models.length === 1 ? "model" : "models"}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="settings-providers-detail scrollbar-thin">
              {!activeProvider ? (
                <div className="settings-empty">{labels.addProviderHint}</div>
              ) : (
                <div className="settings-providers-detail-inner">
                  <div className="flex items-center gap-2">
                    <input
                      value={activeProvider.name}
                      onChange={(event) => updateProvider(activeProvider.id, { name: event.target.value })}
                      placeholder="e.g. Work OpenAI, A6, Local LM"
                      className="settings-field-input min-w-0 flex-1 !text-[14px] !font-medium"
                    />
                    <QuietButton
                      onClick={() => deleteProvider(activeProvider.id)}
                      className="h-8 w-8 p-0"
                      danger
                      aria-label={labels.close}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </QuietButton>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                      label={labels.baseUrl}
                      value={activeProvider.baseUrl}
                      placeholder="https://api.example.com/v1"
                      mono
                      onChange={(value) => updateProvider(activeProvider.id, { baseUrl: value })}
                    />
                    <Field
                      label={labels.apiKey}
                      value={activeProvider.apiKey}
                      placeholder="sk-..."
                      mono
                      type={showKeys[activeProvider.id] ? "text" : "password"}
                      onChange={(value) => updateProvider(activeProvider.id, { apiKey: value })}
                      suffix={
                        <span className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => void copyApiKey(activeProvider)}
                            className={`provider-key-action ${copiedKeys[activeProvider.id] ? "is-copied" : ""}`}
                            aria-label="Copy API key"
                            title={copiedKeys[activeProvider.id] ? "Copied" : "Copy API key"}
                            disabled={!activeProvider.apiKey.trim()}
                            tabIndex={-1}
                          >
                            {copiedKeys[activeProvider.id] ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setShowKeys((current) => ({
                                ...current,
                                [activeProvider.id]: !current[activeProvider.id],
                              }))
                            }
                            className="provider-key-action"
                            aria-label="Toggle API key visibility"
                            title={showKeys[activeProvider.id] ? "Hide API key" : "Show API key"}
                            tabIndex={-1}
                          >
                            {showKeys[activeProvider.id] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </span>
                      }
                    />
                  </div>

                  <div>
                    <div className="mb-2 flex h-7 items-center justify-between gap-3">
                      <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                        {labels.models}
                      </div>
                      <QuietButton onClick={() => addModel(activeProvider.id)} className="h-7 px-2">
                        <Plus className="h-3.5 w-3.5" />
                        {labels.addModel}
                      </QuietButton>
                    </div>
                    <div className="provider-model-grid">
                      {activeProviderModels.length === 0 && (
                        <div className="py-2 text-[11px] leading-4 text-ink-500">
                          {labels.noModelsForProvider}
                        </div>
                      )}
                      {activeProviderModels.map((model) => {
                        const selected = draft.selectedModelId === model.id;
                        return (
                          <div key={model.id} className={`provider-model-tile ${selected ? "is-selected" : ""}`}>
                            <button
                              type="button"
                              onClick={() => commitConfig({ ...draft, selectedModelId: model.id })}
                              className="provider-model-select"
                              title="Use this model"
                            >
                              <span className="provider-model-indicator" />
                            </button>
                            <input
                              value={model.name}
                              onChange={(event) => updateModel(model.id, { name: event.target.value })}
                              placeholder="model-name"
                              className="provider-model-input"
                            />
                            <button
                              type="button"
                              onClick={() => deleteModel(model.id)}
                              aria-label="Delete model"
                              title="Delete model"
                              className="provider-model-delete"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const ProvidersModal: React.FC<ProvidersModalProps> = (props) => (
  <ProvidersBoundary labels={props.labels}>
    <ProvidersContent {...props} />
  </ProvidersBoundary>
);

export default ProvidersModal;
