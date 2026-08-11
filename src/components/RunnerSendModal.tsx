import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, X, Satellite, Loader2, CheckCircle2, AlertTriangle, Plus } from "lucide-react";
import type { RunnerJob } from "../types";

type Props = {
  open: boolean;
  onClose: () => void;
  initialRunnerId?: string | null;
  onOpenRunnerTab?: () => void;
};

function statusDot(runner: RunnerJob) {
  if (runner.running) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-sky-400"><span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />работает</span>;
  }
  if (runner.queued) {
    return <span className="inline-flex items-center gap-1 text-[10px] text-amber-400"><span className="h-1.5 w-1.5 rounded-full bg-amber-400" />в очереди</span>;
  }
  if (runner.enabled === false) {
    return <span className="text-[10px] text-ink-500">выключен</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />готов</span>;
}

const RunnerSendModal: React.FC<Props> = ({ open, onClose, initialRunnerId, onOpenRunnerTab }) => {
  const [runners, setRunners] = useState<RunnerJob[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.lopster?.listRunners();
      const list = (res?.runners || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      setRunners(list);
      if (list.length) {
        setSelectedId((prev) => {
          if (prev && list.some((r) => r.id === prev)) return prev;
          if (initialRunnerId && list.some((r) => r.id === initialRunnerId)) {
            return initialRunnerId;
          }
          return list[0].id;
        });
      }
    } catch {
      /* */
    }
  }, [initialRunnerId]);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setSent(null);
    setError(null);
    setSending(false);
    void refresh();
    const unsub = window.lopster?.onRunnersChanged?.(() => {
      void refresh();
    });
    const timer = setTimeout(() => {
      textareaRef.current?.focus();
    }, 120);
    return () => {
      unsub?.();
      clearTimeout(timer);
    };
  }, [open, refresh]);

  const selected = useMemo(
    () => runners.find((r) => r.id === selectedId) || null,
    [runners, selectedId]
  );

  const canSend = Boolean(selectedId && message.trim() && !sending);

  const handleSend = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const res = await window.lopster?.runRunner(selectedId, { message: message.trim() });
      if (res?.ok) {
        setSent(selected?.name || "ранера");
        const timer = setTimeout(() => {
          onClose();
        }, 900);
        return;
      }
      setError(res?.error || "Не удалось отправить запрос");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
    if (event.key === "Escape") {
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center theme-scrim p-6 animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="theme-panel mt-16 w-full max-w-lg overflow-hidden rounded-xl shadow-modal"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink-950">
            <Satellite className="h-4 w-4 text-accent" />
            Отправить запрос ранеру
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
            aria-label="Закрыть"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {runners.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-300 p-5 text-center">
              <div className="text-[12px] text-ink-600">Ранеры ещё не созданы</div>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenRunnerTab?.();
                }}
                className="theme-soft mt-2 inline-flex h-8 items-center gap-1 rounded-md px-3 text-[11px]"
              >
                <Plus className="h-3.5 w-3.5" />
                Создать ранера
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                  Ранер
                </label>
                <select
                  value={selectedId}
                  onChange={(event) => setSelectedId(event.target.value)}
                  className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
                >
                  {runners.map((runner) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.name}
                    </option>
                  ))}
                </select>
                {selected && (
                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="truncate font-mono text-[10px] text-ink-500">
                      {selected.modelId}
                      {selected.trigger?.type === "interval"
                        ? ` · каждые ${selected.trigger.intervalMinutes} мин`
                        : " · вручную"}
                    </div>
                    {statusDot(selected)}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                  Сообщение
                </label>
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  rows={4}
                  placeholder={"Например: пошел, проверь и обнови отчёты, собери статистику…"}
                  className="theme-input w-full resize-y rounded-md px-2 py-2 text-[12px] outline-none placeholder:text-ink-500"
                />
                <div className="text-right text-[10px] text-ink-400">
                  Enter — отправить, Shift+Enter — новая строка
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-1.5 rounded-md border border-status-err-border bg-status-err-bg px-2 py-1.5 text-[11px] text-status-err">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  {error}
                </div>
              )}

              {sent && (
                <div className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-[11px] text-emerald-500">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  Отправлено → {sent}. Ранер приступил к работе.
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-ink-300 px-3 text-[11px] text-ink-700 hover:bg-ink-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="theme-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Отправить
          </button>
        </div>
      </div>
    </div>
  );
};

export default RunnerSendModal;
