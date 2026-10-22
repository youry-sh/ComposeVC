import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiChatSlot, { MultiSlotPersist } from "./MultiChatSlot";
import ChatAside from "./ChatAside";
import ChatSwitcherModal from "./ChatSwitcherModal";
import GitBadge from "./GitBadge";
import ThinkingIndicator from "./ThinkingIndicator";
import { CustomTool, MainAgentMode, ProviderConfig } from "../types";
import { HotkeyDefinition, matchesHotkey } from "../utils/hotkeys";

/** Ctrl+H (Cmd+H on macOS) — the chat switcher, matched by physical key. */
const SWITCHER_HOTKEY: HotkeyDefinition = { code: "KeyH", modifiers: ["mod"] };

/**
 * Single centred chat panel + a left rail of chat panels.
 *
 * Every panel stays MOUNTED for the whole session — switching only toggles
 * visibility. A running request therefore keeps streaming in the background
 * and its progress is intact when you come back to it.
 */
export const MULTIIDE_STORAGE_KEY = "lopster-multiide-slots";
export const MULTIIDE_ACTIVE_KEY = "lopster-multiide-active";
const MULTIIDE_ROWS_KEY = "lopster-multiide-rows";
/** Hard ceiling — each panel holds a live agent session. */
export const MULTIIDE_MAX_SLOTS = 12;
/** Fixed id of the default workspace — pre-workspace chats attach here on migration. */
export const DEFAULT_WORKSPACE_ID = "ws-default";
const WORKSPACES_KEY = "lopster-multiide-workspaces";
const WORKSPACE_ACTIVE_KEY = "lopster-multiide-workspace-active";
/** How many chats can sit stacked in the centre at once. */
const MAX_ROWS = 3;

export type MultiIdeSlotState = {
  id: string;
  rootPath: string | null;
  sessionId: string | null;
  /** Per-panel model — independent of global settings */
  selectedModelId: string | null;
  /** Per-panel agent mode: lopster | soviet-7 | lab-in */
  agentMode: MainAgentMode;
  /** Which workspace this chat panel belongs to. */
  workspaceId: string;
};

/** A named group of chat panels. Per-workspace view state (active panel + open rows)
 *  lives here so switching workspaces restores exactly what the user left behind. */
export type WorkspaceState = {
  id: string;
  activeId: string | null;
  openIds: string[];
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
    value === "soviet-7" ||
    value === "lab-in" ||
    value === "fortani"
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

const SLOT_DRAG = "application/x-composevc-slot";

function hasSlotDrag(data: DataTransfer): boolean {
  return Array.from(data.types).includes(SLOT_DRAG);
}

function loadOpenRows(validIds: string[], fallback: string): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MULTIIDE_ROWS_KEY) || "null") as unknown;
    if (!Array.isArray(raw)) return [fallback];
    const ids = raw.filter((id): id is string => typeof id === "string" && validIds.includes(id)).slice(0, MAX_ROWS);
    return ids.length ? ids : [fallback];
  } catch {
    return [fallback];
  }
}

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
  /** Ctrl+H list — the only way to switch panels while the dock covers the rail. */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /** Chats stacked in the centre. Drag from the rail adds a row, up to three. */
  const [openIds, setOpenIds] = useState<string[]>(() =>
    loadOpenRows(slots.map((s) => s.id), slots[0]?.id || "multi-1")
  );
  const [dropOn, setDropOn] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!matchesHotkey(event, SWITCHER_HOTKEY)) return;
      event.preventDefault();
      setSwitcherOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    // Same stroke from inside a <webview>: the guest owns the keyboard there,
    // so the main process forwards it (see installPackagedWindowHardening).
    const unsub = window.lopster?.onOpenChatSwitcher?.(() => setSwitcherOpen((prev) => !prev));
    return () => {
      window.removeEventListener("keydown", onKey);
      unsub?.();
    };
  }, []);

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

  useEffect(() => {
    setOpenIds((prev) => {
      const ids = prev.filter((id) => slots.some((s) => s.id === id)).slice(0, MAX_ROWS);
      if (ids.length === prev.length && ids.every((id, i) => id === prev[i])) return prev;
      return ids.length ? ids : [slots[0]?.id].filter((id): id is string => Boolean(id));
    });
  }, [slots]);

  useEffect(() => {
    try {
      window.localStorage.setItem(MULTIIDE_ROWS_KEY, JSON.stringify(openIds));
    } catch {
      /* ignore */
    }
  }, [openIds]);

  const focusSlot = useCallback(
    (id: string) => {
      setActiveId(id);
      setOpenIds((prev) => {
        if (prev.includes(id)) return prev;
        const idx = Math.max(0, prev.indexOf(activeId));
        const next = prev.slice();
        if (!next.length) return [id];
        next[Math.min(idx, next.length - 1)] = id;
        return next;
      });
    },
    [activeId]
  );

  /** Drop a rail chat onto the centre. A free row is added; the third drop replaces the row under the cursor. */
  const placeSlot = useCallback((dragged: string, targetId: string | null) => {
    if (!slots.some((s) => s.id === dragged)) return;
    setOpenIds((prev) => {
      const from = prev.indexOf(dragged);
      if (targetId && from >= 0 && dragged !== targetId && prev.includes(targetId)) {
        const next = prev.slice();
        const to = next.indexOf(targetId);
        const held = next[from];
        next[from] = next[to];
        next[to] = held;
        return next;
      }
      if (from >= 0) return prev;
      if (!targetId || !prev.includes(targetId)) {
        return prev.length >= MAX_ROWS ? prev : [...prev, dragged];
      }
      if (prev.length < MAX_ROWS) {
        const next = prev.slice();
        next.splice(prev.indexOf(targetId) + 1, 0, dragged);
        return next;
      }
      return prev.map((id) => (id === targetId ? dragged : id));
    });
    setActiveId(dragged);
    setDropOn(null);
  }, [slots]);

  const unpinSlot = useCallback((id: string) => {
    setOpenIds((prev) => (prev.length <= 1 ? prev : prev.filter((item) => item !== id)));
  }, []);

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
      setOpenIds((prev) => prev.filter((id) => id !== slotId));
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
            const isOpen = openIds.includes(slot.id);
            const name = folderName(slot.rootPath);
            return (
              <div
                key={slot.id}
                className={`chat-rail-item${isActive ? " is-active" : ""}${running ? " is-running" : ""}${isOpen ? " is-open" : ""}`}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(SLOT_DRAG, slot.id);
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <div className="chat-rail-main">
                <button
                  type="button"
                  className="chat-rail-btn"
                  onClick={() => focusSlot(slot.id)}
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
      </aside>

      {/* ── Centre: exactly one visible chat panel ──
          The others stay mounted (hidden) so their run never dies. */}
      <main
        className={`chat-stage${openIds.length > 1 ? " is-split" : ""}`}
        onDragOver={(event) => {
          if (!hasSlotDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          const id = event.dataTransfer.getData(SLOT_DRAG);
          if (!id) return;
          event.preventDefault();
          placeSlot(id, null);
        }}
      >
        {stableSlots.map((slot, index) => {
          const row = openIds.indexOf(slot.id);
          const visible = row >= 0;
          return (
          <div
            key={slot.id}
            className={`chat-stage-pane${visible ? " is-visible" : ""}${dropOn === slot.id ? " is-drop" : ""}`}
            aria-hidden={!visible}
            onDragOver={
              visible
                ? (event) => {
                    if (!hasSlotDrag(event.dataTransfer)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "copy";
                    if (dropOn !== slot.id) setDropOn(slot.id);
                  }
                : undefined
            }
            onDragLeave={visible ? () => setDropOn((current) => (current === slot.id ? null : current)) : undefined}
            onDrop={
              visible
                ? (event) => {
                    const id = event.dataTransfer.getData(SLOT_DRAG);
                    if (!id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    placeSlot(id, slot.id);
                  }
                : undefined
            }
          >
            <div className="chat-stage-frame" style={row > 0 ? { borderLeft: "1px solid var(--border)" } : undefined}>
              {openIds.length > 1 && visible && (
                <button
                  type="button"
                  className="chat-stage-unpin"
                  title="Убрать ряд"
                  aria-label="Убрать ряд"
                  onClick={() => unpinSlot(slot.id)}
                >
                  ×
                </button>
              )}
              <MultiChatSlot
                slotId={slot.id}
                index={index}
                focused={slot.id === activeSlotId}
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
          );
        })}
      </main>

      {/* ── Right: shell stats + configured runners ── */}
      <ChatAside
        chatCount={totalChats}
        runningPanels={runningPanels}
        activeRootPath={stableSlots.find((s) => s.id === activeSlotId)?.rootPath || null}
        onOpenRunners={onOpenRunners}
      />

      {switcherOpen && (
        <ChatSwitcherModal
          slots={stableSlots.map((slot) => ({
            id: slot.id,
            rootPath: slot.rootPath,
            running: Boolean(statusBySlot[slot.id]?.running),
            sessionCount: statusBySlot[slot.id]?.sessionCount ?? 0,
          }))}
          activeId={activeSlotId}
          onPick={focusSlot}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
    </div>
  );
};

export default MultiIdeWorkspace;
