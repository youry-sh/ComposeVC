import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Search, X } from "lucide-react";

type Prompt = {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

interface PromptCopyModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Mini copy modal (Ctrl/Cmd+Shift+P). Search prompts by title, pick one with
 * ArrowUp/Down + Enter (or click), and its full text is copied to the
 * clipboard. Escape or the close button dismisses.
 */
const PromptCopyModal: React.FC<PromptCopyModalProps> = ({ open, onClose }) => {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");
  const [copyMessage, setCopyMessage] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirmTimer = useRef<number | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  const shortcutLabel = isMac ? "⌘⇧P" : "Ctrl+Shift+P";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter((prompt) => prompt.title.toLowerCase().includes(q));
  }, [prompts, query]);

  const resetCopyState = useCallback(() => {
    if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setCopyState("idle");
    setCopyMessage("");
  }, []);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelectedIndex(0);
    resetCopyState();

    let cancelled = false;
    (async () => {
      try {
        const result = await window.lopster?.promptsList?.();
        if (cancelled) return;
        if (result?.error) {
          setCopyState("error");
          setCopyMessage(result.error);
        } else if (result && Array.isArray(result.prompts)) {
          setPrompts(result.prompts);
        } else {
          setCopyState("error");
          setCopyMessage("Хранилище промтов недоступно.");
        }
      } catch (cause) {
        if (!cancelled) {
          setCopyState("error");
          setCopyMessage(cause instanceof Error ? cause.message : String(cause));
        }
      }
    })();

    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
      returnFocusRef.current?.focus?.();
    };
  }, [open, resetCopyState]);

  // Keep the highlighted item visible while navigating with the arrow keys.
  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const close = useCallback(() => {
    onClose();
  }, [onClose]);

  const doCopy = useCallback(
    async (prompt: Prompt) => {
      resetCopyState();
      const result = await window.lopster?.promptsCopy?.(prompt.id);
      if (result?.ok) {
        setCopyState("ok");
        setCopyMessage(`Скопировано: ${prompt.title}`);
        if (confirmTimer.current) window.clearTimeout(confirmTimer.current);
        confirmTimer.current = window.setTimeout(resetCopyState, 2000);
      } else {
        setCopyState("error");
        setCopyMessage(result?.error || "Не удалось скопировать промт.");
      }
    },
    [resetCopyState]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, Math.max(0, filtered.length - 1)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected) void doCopy(selected);
        return;
      }
      if (event.key === "Tab") {
        // Minimal focus trap: cycle Tab among the modal's own focusable nodes.
        const root = rootRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0 && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (event.shiftKey) {
          if (active === first || !root.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else if (active === last || !root.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    [close, filtered, selectedIndex, doCopy]
  );

  if (!open) return null;

  return (
    <div
      className="prompt-copy-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-label="Копировать промт"
        className="prompt-copy-modal"
        onKeyDown={handleKeyDown}
      >
        <div className="prompt-copy-head">
          <Search className="prompt-copy-head-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
              resetCopyState();
            }}
            placeholder="Найти промт по заголовку…"
            spellCheck={false}
            aria-label="Поиск промта по заголовку"
          />
          <button
            type="button"
            className="prompt-copy-close"
            onClick={close}
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="prompt-copy-meta">
          <span>Быстрое копирование промта</span>
          <span className="prompt-copy-kbd">{shortcutLabel}</span>
        </div>

        <div className="prompt-copy-list">
          {filtered.length === 0 ? (
            <div className="prompt-copy-empty">
              {query ? "Ничего не найдено" : "Промтов пока нет"}
            </div>
          ) : (
            filtered.map((prompt, index) => (
              <button
                type="button"
                key={prompt.id}
                tabIndex={-1}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                className={`prompt-copy-item${index === selectedIndex ? " is-selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => void doCopy(prompt)}
              >
                <span className="prompt-copy-item-title">{prompt.title}</span>
                <Copy className="prompt-copy-item-icon" />
              </button>
            ))
          )}
        </div>

        {copyState !== "idle" ? (
          <div className={`prompt-copy-status is-${copyState}`}>
            {copyState === "ok" ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            <span>{copyMessage}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default PromptCopyModal;
