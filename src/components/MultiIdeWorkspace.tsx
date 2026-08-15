import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiChatSlot, { MultiSlotPersist } from "./MultiChatSlot";
import AsideBrowser from "./AsideBrowser";
import ChatAside from "./ChatAside";
import GitBadge from "./GitBadge";
import ThinkingIndicator from "./ThinkingIndicator";
import { CustomTool, MainAgentMode, ProviderConfig } from "../types";

/**
 * Single centred chat panel + a left rail of chat panels.
 *
 * Every panel stays MOUNTED for the whole session — switching only toggles
 * visibility. A running request therefore keeps streaming in the background
 * and its progress is intact when you come back to it.
 */
export const MULTIIDE_STORAGE_KEY = "lopster-multiide-slots";
export const MULTIIDE_ACTIVE_KEY = "lopster-multiide-active";
/** Hard ceiling — each panel holds a live agent session. */
export const MULTIIDE_MAX_SLOTS = 12;

export type MultiIdeSlotState = {
  id: string;
  rootPath: string | null;
  sessionId: string | null;
  /** Per-panel model — independent of global settings */
  selectedModelId: string | null;
  /** Per-panel agent mode: lopster | soviet-7 */
  agentMode: MainAgentMode;
};

type ChatLabels = React.ComponentProps<typeof MultiChatSlot>["labels"];

interface MultiIdeWorkspaceProps {
  providerConfig: ProviderConfig;
  customTools: CustomTool[];
  onAddCustomTool: (input: {
    name: string;
    title?: string;
    description?: string;
    body: Record<string, unknown> | string;
    tags?: string[];
  }) => Promise<void>;
  onUpdateCustomTool: (
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
  onRemoveCustomTool: (toolId: string) => Promise<void>;
  labels: ChatLabels;
  slots: MultiIdeSlotState[];
  onSlotsChange: (slots: MultiIdeSlotState[]) => void;
  /** Jump to the Runner workspace from the aside table. */
  onOpenRunners?: () => void;
}

function isAgentMode(value: unknown): value is MainAgentMode {
  // Legacy "planner" falls through to default "lopster".
  return (
    value === "lopster" ||
    value === "soviet-7"
  );
}

function emptySlot(id: string): MultiIdeSlotState {
  return {
    id,
    rootPath: null,
    sessionId: null,
    selectedModelId: null,
    agentMode: "lopster" as MainAgentMode,
  };
}

export function defaultMultiIdeSlots(): MultiIdeSlotState[] {
  return [emptySlot("multi-1")];
}

export function loadMultiIdeSlots(): MultiIdeSlotState[] {
  try {
    const raw = window.localStorage.getItem(MULTIIDE_STORAGE_KEY);
    if (!raw) return defaultMultiIdeSlots();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultMultiIdeSlots();
    // A session belongs to exactly one panel. Older builds could save the same
    // session ID into two slots when they opened the same folder, so keep the
    // first owner and return the later panel(s) to an empty draft.
    const claimedSessionIds = new Set<string>();
    const usedIds = new Set<string>();
    const slots = parsed.slice(0, MULTIIDE_MAX_SLOTS).map((entry, index) => {
      const item = entry as Partial<MultiIdeSlotState> | undefined;
      let id = typeof item?.id === "string" && item.id ? item.id : `multi-${index + 1}`;
      while (usedIds.has(id)) id = `${id}-${index + 1}`;
      usedIds.add(id);
      const requestedSessionId = typeof item?.sessionId === "string" ? item.sessionId : null;
      const sessionId = requestedSessionId && !claimedSessionIds.has(requestedSessionId)
        ? requestedSessionId
        : null;
      if (sessionId) claimedSessionIds.add(sessionId);
      return {
        id,
        rootPath: typeof item?.rootPath === "string" ? item.rootPath : null,
        sessionId,
        selectedModelId: typeof item?.selectedModelId === "string" ? item.selectedModelId : null,
        agentMode: isAgentMode(item?.agentMode) ? item.agentMode : ("lopster" as MainAgentMode),
      };
    });
    return slots.length ? slots : defaultMultiIdeSlots();
  } catch {
    return defaultMultiIdeSlots();
  }
}

export function saveMultiIdeSlots(slots: MultiIdeSlotState[]) {
  try {
    window.localStorage.setItem(
      MULTIIDE_STORAGE_KEY,
      JSON.stringify(
        slots.map((s) => ({
          id: s.id,
          rootPath: s.rootPath,
          sessionId: s.sessionId,
          selectedModelId: s.selectedModelId,
          agentMode: s.agentMode,
        }))
      )
    );
  } catch {
    /* ignore */
  }
}

function folderName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Live per-panel status pushed up by MultiChatSlot. */
type SlotStatus = { running: boolean; sessionCount: number };

const MultiIdeWorkspace: React.FC<MultiIdeWorkspaceProps> = ({
  providerConfig,
  customTools,
  onAddCustomTool,
  onUpdateCustomTool,
  onRemoveCustomTool,
  labels,
  slots,
  onSlotsChange,
  onOpenRunners,
}) => {
  const [activeId, setActiveId] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(MULTIIDE_ACTIVE_KEY);
      if (saved && slots.some((s) => s.id === saved)) return saved;
    } catch {
      /* ignore */
    }
    return slots[0]?.id || "multi-1";
  });
  /** slotId → live status reported by the panel (streaming + chat count). */
  const [statusBySlot, setStatusBySlot] = useState<Record<string, SlotStatus>>({});
  const seqRef = useRef(0);

  // Keep the selection valid when a panel is closed elsewhere.
  useEffect(() => {
    if (slots.length && !slots.some((s) => s.id === activeId)) {
      setActiveId(slots[0].id);
    }
  }, [slots, activeId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MULTIIDE_ACTIVE_KEY, activeId);
    } catch {
      /* ignore */
    }
  }, [activeId]);

  const handlePersist = useCallback(
    (next: MultiSlotPersist) => {
      onSlotsChange(
        slots.map((slot) =>
          slot.id === next.id
            ? {
                ...slot,
                rootPath: next.rootPath,
                sessionId: next.sessionId,
                selectedModelId: next.selectedModelId,
                agentMode: next.agentMode,
              }
            : slot
        )
      );
    },
    [onSlotsChange, slots]
  );

  const handleStatusChange = useCallback((slotId: string, next: SlotStatus) => {
    setStatusBySlot((prev) => {
      const current = prev[slotId];
      if (current && current.running === next.running && current.sessionCount === next.sessionCount) {
        return prev;
      }
      return { ...prev, [slotId]: next };
    });
  }, []);

  const handleAddSlot = useCallback(() => {
    if (slots.length >= MULTIIDE_MAX_SLOTS) return;
    const used = new Set(slots.map((s) => s.id));
    let id = "";
    do {
      seqRef.current += 1;
      id = `multi-${slots.length + seqRef.current}`;
    } while (used.has(id));
    onSlotsChange([...slots, emptySlot(id)]);
    setActiveId(id);
  }, [onSlotsChange, slots]);

  const handleCloseSlot = useCallback(
    (slotId: string) => {
      if (slots.length <= 1) return;
      const index = slots.findIndex((s) => s.id === slotId);
      const next = slots.filter((s) => s.id !== slotId);
      onSlotsChange(next);
      setStatusBySlot((prev) => {
        if (!(slotId in prev)) return prev;
        const copy = { ...prev };
        delete copy[slotId];
        return copy;
      });
      if (slotId === activeId) {
        const fallback = next[Math.max(0, index - 1)] || next[0];
        if (fallback) setActiveId(fallback.id);
      }
    },
    [activeId, onSlotsChange, slots]
  );

  const stableSlots = useMemo(() => slots.slice(0, MULTIIDE_MAX_SLOTS), [slots]);
  const activeSlotId = stableSlots.some((s) => s.id === activeId)
    ? activeId
    : stableSlots[0]?.id;

  // Chat history is stored per project folder, so two panels on the same folder
  // report the SAME chats — count each folder once instead of double-counting.
  const { totalChats, runningPanels } = useMemo(() => {
    const byFolder = new Map<string, number>();
    let running = 0;
    for (const slot of stableSlots) {
      const status = statusBySlot[slot.id];
      if (!status) continue;
      if (status.running) running += 1;
      const key = slot.rootPath || "no-project";
      byFolder.set(key, Math.max(byFolder.get(key) ?? 0, status.sessionCount));
    }
    let chats = 0;
    for (const count of byFolder.values()) chats += count;
    return { totalChats: chats, runningPanels: running };
  }, [stableSlots, statusBySlot]);

  return (
    <div className="chat-shell theme-workspace flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* ── Left rail: every chat panel, the running one is marked ── */}
      <aside className="chat-rail" aria-label={labels.chat || "Chats"}>
        <header className="chat-rail-head">
          <span className="chat-rail-title">{labels.chat || "Chats"}</span>
          <button
            type="button"
            className="chat-rail-add"
            onClick={handleAddSlot}
            disabled={stableSlots.length >= MULTIIDE_MAX_SLOTS}
            title={labels.newChat || "New chat panel"}
            aria-label={labels.newChat || "New chat panel"}
          >
            +
          </button>
        </header>

        <div className="chat-rail-list">
          {stableSlots.map((slot, index) => {
            const status = statusBySlot[slot.id];
            const running = Boolean(status?.running);
            const sessionCount = status?.sessionCount ?? 0;
            const isActive = slot.id === activeSlotId;
            const name = folderName(slot.rootPath);
            return (
              <div
                key={slot.id}
                className={`chat-rail-item${isActive ? " is-active" : ""}${running ? " is-running" : ""}`}
              >
                <div className="chat-rail-main">
                <button
                  type="button"
                  className="chat-rail-btn"
                  onClick={() => setActiveId(slot.id)}
                  title={slot.rootPath || undefined}
                >
                  <span className="chat-rail-head-row">
                    <span className="chat-rail-dot" aria-hidden />
                    <span className="chat-rail-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="chat-rail-name">{name || labels.chat || "Agent Work"}</span>
                    {sessionCount > 0 && (
                      <span className="chat-rail-count" title={labels.chatHistory || "Chats"}>
                        {sessionCount}
                      </span>
                    )}
                  </span>
                  {/* Full directory path, dimmed — the panel's working folder. */}
                  <span className="chat-rail-path">{slot.rootPath || labels.selectFolder || "No folder"}</span>
                  {running && (
                    <span className="chat-rail-think">
                      <ThinkingIndicator label="think" />
                    </span>
                  )}
                </button>
                {stableSlots.length > 1 && (
                  <button
                    type="button"
                    className="chat-rail-close"
                    onClick={() => handleCloseSlot(slot.id)}
                    title="Close panel"
                    aria-label="Close panel"
                  >
                    ×
                  </button>
                )}
                </div>
                {/* Repository this panel's folder is connected to. */}
                <GitBadge rootPath={slot.rootPath} />
              </div>
            );
          })}
        </div>

        <footer className="chat-rail-foot">
          {stableSlots.length}/{MULTIIDE_MAX_SLOTS}
        </footer>

        {/* Bottom dock: open a film page or a video by link, right in the rail. */}
        <AsideBrowser />
      </aside>

      {/* ── Centre: exactly one visible chat panel ──
          The others stay mounted (hidden) so their run never dies. */}
      <main className="chat-stage">
        {stableSlots.map((slot, index) => (
          <div
            key={slot.id}
            className={`chat-stage-pane${slot.id === activeSlotId ? " is-visible" : ""}`}
            aria-hidden={slot.id !== activeSlotId}
          >
            <div className="chat-stage-frame">
              <MultiChatSlot
                slotId={slot.id}
                index={index}
                rootPath={slot.rootPath}
                sessionId={slot.sessionId}
                selectedModelId={slot.selectedModelId}
                agentMode={slot.agentMode}
                onPersist={handlePersist}
                onStatusChange={handleStatusChange}
                providerConfig={providerConfig}
                customTools={customTools}
                onAddCustomTool={onAddCustomTool}
                onUpdateCustomTool={onUpdateCustomTool}
                onRemoveCustomTool={onRemoveCustomTool}
                labels={labels}
              />
            </div>
          </div>
        ))}
      </main>

      {/* ── Right: shell stats + configured runners ── */}
      <ChatAside
        chatCount={totalChats}
        runningPanels={runningPanels}
        activeRootPath={stableSlots.find((s) => s.id === activeSlotId)?.rootPath || null}
        onOpenRunners={onOpenRunners}
      />
    </div>
  );
};

export default MultiIdeWorkspace;
