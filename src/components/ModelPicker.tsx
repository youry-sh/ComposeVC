import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Sparkles, X } from "lucide-react";
import { AIModel, AIProvider } from "../types";

export type ModelPickerLabels = {
  selectModel: string;
  noModelsConfigured: string;
  searchModels?: string;
  noModelsFound?: string;
};

type ModelPickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: AIProvider[];
  models: AIModel[];
  selectedModelId?: string;
  onSelectModel: (modelId: string) => void;
  labels: ModelPickerLabels;
  className?: string;
  triggerClassName?: string;
};

type ProviderGroup = {
  providerId: string;
  providerName: string;
  models: AIModel[];
};

function formatCtx(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M ctx`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k ctx`;
  }
  return `${n.toLocaleString()} ctx`;
}

const ModelPicker: React.FC<ModelPickerProps> = ({
  open,
  onOpenChange,
  providers,
  models,
  selectedModelId,
  onSelectModel,
  labels,
  className = "",
  triggerClassName = "",
}) => {
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedModel = models.find((m) => m.id === selectedModelId);
  const selectedProvider = providers.find((p) => p.id === selectedModel?.providerId);

  const providerNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of providers) map.set(p.id, p.name);
    return map;
  }, [providers]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byProvider = new Map<string, AIModel[]>();

    for (const model of models) {
      const providerName = providerNameById.get(model.providerId) || "Unknown";
      if (q) {
        const hay = `${model.name} ${model.id} ${providerName}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const list = byProvider.get(model.providerId) || [];
      list.push(model);
      byProvider.set(model.providerId, list);
    }

    const ordered: ProviderGroup[] = [];
    const seen = new Set<string>();

    for (const p of providers) {
      const list = byProvider.get(p.id);
      if (!list?.length) continue;
      ordered.push({
        providerId: p.id,
        providerName: p.name,
        models: list,
      });
      seen.add(p.id);
    }

    for (const [providerId, list] of byProvider) {
      if (seen.has(providerId)) continue;
      ordered.push({
        providerId,
        providerName: providerNameById.get(providerId) || "Unknown",
        models: list,
      });
    }

    return ordered;
  }, [models, providers, providerNameById, query]);

  const totalVisible = groups.reduce((n, g) => n + g.models.length, 0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const t = window.setTimeout(() => {
      searchRef.current?.focus();
      searchRef.current?.select();
    }, 20);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onOpenChange]);

  const searchPlaceholder = labels.searchModels || "Search models…";
  const emptyFound = labels.noModelsFound || "No models found";

  return (
    <div className={`model-picker relative min-w-0 flex-1 ${className}`} ref={rootRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`chat-chip chat-chip-model ${open ? "is-open" : ""} ${triggerClassName}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-picker-trigger-text truncate">
          {selectedProvider && selectedModel ? (
            <>
              <Sparkles className="model-picker-ico w-3 h-3 flex-shrink-0" />
              <span className="model-picker-trigger-provider">{selectedProvider.name}</span>
              <span className="model-picker-trigger-sep">/</span>
              <span className="model-picker-trigger-model">{selectedModel.name}</span>
            </>
          ) : (
            labels.selectModel
          )}
        </span>
        <ChevronDown
          className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="model-picker-menu animate-fade-in" role="listbox">
          <div className="model-picker-search">
            <Search className="model-picker-search-icon" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="model-picker-search-input"
              spellCheck={false}
              autoComplete="off"
            />
            {query ? (
              <button
                type="button"
                className="model-picker-search-clear"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear"
              >
                <X className="w-3 h-3" />
              </button>
            ) : null}
          </div>

          <div className="model-picker-list scrollbar-thin">
            {models.length === 0 ? (
              <div className="model-picker-empty">{labels.noModelsConfigured}</div>
            ) : totalVisible === 0 ? (
              <div className="model-picker-empty">{emptyFound}</div>
            ) : (
              groups.map((group) => (
                <div key={group.providerId} className="model-picker-group">
                  <div className="model-picker-group-head">
                    <span className="model-picker-group-name">{group.providerName}</span>
                    <span className="model-picker-group-count">{group.models.length}</span>
                  </div>
                  {group.models.map((model) => {
                    const active = model.id === selectedModelId;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onClick={() => {
                          onSelectModel(model.id);
                          onOpenChange(false);
                        }}
                        className={`model-picker-item ${active ? "is-active" : ""}`}
                      >
                        <span className="model-picker-item-main">
                          <span className="model-picker-item-name">{model.name}</span>
                          <span className="model-picker-item-meta">{formatCtx(model.contextLimit)}</span>
                        </span>
                        {active ? <Check className="model-picker-item-check" /> : null}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModelPicker;
