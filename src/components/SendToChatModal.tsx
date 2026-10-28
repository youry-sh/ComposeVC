import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, LayoutGrid, Loader2, Send, X } from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";
import {
  readChatTargets,
  dispatchSendToChat,
  type SendTargetsSnapshot,
} from "../utils/sendToChat";

type Props = {
  open: boolean;
  onClose: () => void;
  prompt: string;
  onOpenMultiIde?: () => void;
};

function folderName(path: string | null): string {
  if (!path) return "no folder";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

const SendToChatModal: React.FC<Props> = ({ open, onClose, prompt, onOpenMultiIde }) => {
  const [snapshot, setSnapshot] = useState<SendTargetsSnapshot>({
    workspaces: [],
    activeWorkspaceId: "",
  });
  const [workspaceId, setWorkspaceId] = useState("");
  const [slotId, setSlotId] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setSent(null);
    setError(null);
    setSending(false);
    const next = readChatTargets();
    setSnapshot(next);
    const workspace =
      next.workspaces.find((item) => item.id === next.activeWorkspaceId) || next.workspaces[0];
    setWorkspaceId(workspace?.id || "");
    setSlotId(workspace?.targets[0]?.slotId || "");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const workspace = useMemo(
    () => snapshot.workspaces.find((item) => item.id === workspaceId) || null,
    [snapshot, workspaceId]
  );
  const targets = workspace?.targets || [];
  const selected = useMemo(
    () => targets.find((target) => target.slotId === slotId) || null,
    [targets, slotId]
  );

  const selectWorkspace = useCallback(
    (id: string) => {
      const next = snapshot.workspaces.find((item) => item.id === id);
      setWorkspaceId(id);
      setSlotId(next?.targets[0]?.slotId || "");
      setError(null);
      setSent(null);
    },
    [snapshot]
  );

  const openMultiIde = useCallback(() => {
    onClose();
    onOpenMultiIde?.();
  }, [onClose, onOpenMultiIde]);

  const handleSend = useCallback(() => {
    if (!selected || sending) return;
    setSending(true);
    setError(null);
    const result = dispatchSendToChat({ text: prompt, target: selected });
    if (!result.ok) {
      setSending(false);
      setError(result.error || "Не удалось отправить промпт");
      return;
    }
    setSending(false);
    setSent(`${selected.workspaceName} / ${selected.label}`);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      onClose();
      onOpenMultiIde?.();
    }, 900);
  }, [onClose, onOpenMultiIde, prompt, selected, sending]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "A") return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    handleSend();
  };

  if (!open || !prompt.trim()) return null;

  const noWorkspaces = snapshot.workspaces.length === 0;

  return (
    <div
      className="runner-editor-scrim fixed inset-0 z-[90] flex items-start justify-center theme-scrim p-6 animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="send-to-chat-modal theme-panel mt-24 w-full max-w-md overflow-hidden rounded-xl shadow-modal"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink-950">
            <Send className="h-4 w-4 text-accent" />
            Отправить в чат
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

        <div className="send-to-chat-body">
          {noWorkspaces ? (
            <div className="send-to-chat-empty">
              <div>Нет доступных воркспейсов.</div>
              {onOpenMultiIde && (
                <button type="button" onClick={openMultiIde} className="theme-soft send-to-chat-open">
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Открыть MultiIDE
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label
                  htmlFor="send-to-chat-workspace"
                  className="text-[10px] font-medium uppercase tracking-wide text-ink-500"
                >
                  Workspace
                </label>
                <select
                  id="send-to-chat-workspace"
                  value={workspaceId}
                  onChange={(event) => selectWorkspace(event.target.value)}
                  className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
                >
                  {snapshot.workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.targets.length ? ` · ${item.targets.length}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                  Чат
                </span>
                {targets.length === 0 ? (
                  <div className="send-to-chat-empty">
                    <div>В этом воркспейсе нет чатов</div>
                    {onOpenMultiIde && (
                      <button type="button" onClick={openMultiIde} className="theme-soft send-to-chat-open">
                        <LayoutGrid className="h-3.5 w-3.5" />
                        Открыть MultiIDE
                      </button>
                    )}
                  </div>
                ) : (
                  <ChatMonoScroll className="send-to-chat-list">
                    {targets.map((target, index) => {
                      const active = target.slotId === slotId;
                      return (
                        <button
                          key={target.slotId}
                          type="button"
                          onClick={() => {
                            setSlotId(target.slotId);
                            setError(null);
                            setSent(null);
                          }}
                          className={`send-to-chat-row${active ? " is-active" : ""}`}
                          title={`${target.label} · ${target.sessionId || "new chat"}`}
                        >
                          <span className="send-to-chat-row-index">to{index + 1}</span>
                          <span className="send-to-chat-row-main">
                            <span className="send-to-chat-row-name">
                              {target.sessionId
                                ? `session ${target.sessionId.slice(0, 10)}`
                                : "new chat"}
                            </span>
                            <span className="send-to-chat-row-path">{folderName(target.rootPath)}</span>
                          </span>
                          {!target.sessionId && <span className="send-to-chat-new">new</span>}
                          {active && <Check className="send-to-chat-check" />}
                        </button>
                      );
                    })}
                  </ChatMonoScroll>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                    Промпт
                  </span>
                  <span className="text-[10px] text-ink-500">уйдёт сразу в работу</span>
                </div>
                <div className="send-to-chat-preview scrollbar-thin">{prompt}</div>
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
                  Промпт ушёл в {sent}
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
            onClick={handleSend}
            disabled={!selected || sending}
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

export default SendToChatModal;
