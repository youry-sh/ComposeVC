import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiChatSlot, { MultiSlotPersist } from "./MultiChatSlot";
import ChatAside from "./ChatAside";
import ChatSwitcherModal from "./ChatSwitcherModal";
import GitBadge from "./GitBadge";
import ThinkingIndicator from "./ThinkingIndicator";
import { CustomTool, MainAgentMode, ProviderConfig } from "../types";
import { HotkeyDefinition, matchesHotkey } from "../utils/hotkeys";
import { LayoutGrid } from "lucide-react";

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
  labels: ChatLabels & {
    workspaces: string;
    newWorkspace: string;
    workspace: string;
  };
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

function emptySlot(id: string, workspaceId: string): MultiIdeSlotState {
  return {
    id,
    rootPath: null,
    sessionId: null,
    selectedModelId: null,
    agentMode: "lopster" as MainAgentMode,
    workspaceId,
  };
}

export function defaultMultiIdeSlots(): MultiIdeSlotState[] {
  return [emptySlot("multi-1", DEFAULT_WORKSPACE_ID)];
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
        workspaceId:
          typeof item?.workspaceId === "string" && item.workspaceId
            ? item.workspaceId
            : DEFAULT_WORKSPACE_ID,
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
          workspaceId: s.workspaceId,
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

function normalizeWorkspace(raw: unknown, index: number): WorkspaceState {
  const item = (raw ?? {}) as Partial<WorkspaceState>;
  return {
    id: typeof item.id === "string" && item.id ? item.id : `ws-${index + 1}`,
    activeId: typeof item.activeId === "string" ? item.activeId : null,
    openIds: Array.isArray(item.openIds)
      ? item.openIds.filter((x): x is string => typeof x === "string")
      : [],
  };
}

/** Legacy pre-workspace view state (active panel + open rows) seeds the default workspace,
 *  so existing chats land in workspace #1 and nothing is lost on upgrade. */
function seedDefaultWorkspace(slots: MultiIdeSlotState[]): {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
} {
  const firstId = slots[0]?.id || "multi-1";
  let legacyActive: string | null = null;
  let legacyOpen: string[] = [];
  try {
    legacyActive = window.localStorage.getItem(MULTIIDE_ACTIVE_KEY);
    const rawRows = JSON.parse(window.localStorage.getItem(MULTIIDE_ROWS_KEY) || "null") as unknown;
    if (Array.isArray(rawRows)) legacyOpen = rawRows.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignore */
  }
  const activeId =
    legacyActive && slots.some((s) => s.id === legacyActive) ? legacyActive : firstId;
  const openIds = (legacyOpen.length ? legacyOpen : [firstId]).filter((id) =>
    slots.some((s) => s.id === id)
  );
  return {
    workspaces: [
      {
        id: DEFAULT_WORKSPACE_ID,
        activeId,
        openIds: openIds.length ? openIds.slice(0, MAX_ROWS) : [firstId],
      },
    ],
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  };
}

/** Workspace store + active id, persisted alongside the slots array. */
export function loadWorkspaceState(slots: MultiIdeSlotState[]): {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
} {
  try {
    const raw = JSON.parse(window.localStorage.getItem(WORKSPACES_KEY) || "null") as unknown;
    const rawActive = window.localStorage.getItem(WORKSPACE_ACTIVE_KEY);
    if (Array.isArray(raw) && raw.length) {
      const workspaces = raw.map(normalizeWorkspace).filter((w) => Boolean(w.id));
      if (!workspaces.length) return seedDefaultWorkspace(slots);
      const active =
        rawActive && workspaces.some((w) => w.id === rawActive) ? rawActive : workspaces[0].id;
      return { workspaces, activeWorkspaceId: active };
    }
  } catch {
    /* fall through to migration */
  }
  return seedDefaultWorkspace(slots);
}

export function saveWorkspaceState(workspaces: WorkspaceState[], activeWorkspaceId: string) {
  try {
    window.localStorage.setItem(
      WORKSPACES_KEY,
      JSON.stringify(
        workspaces.map((w) => ({ id: w.id, activeId: w.activeId, openIds: w.openIds }))
      )
    );
    window.localStorage.setItem(WORKSPACE_ACTIVE_KEY, activeWorkspaceId);
  } catch {
    /* ignore */
  }
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
  const [workspaceState, setWorkspaceState] = useState(() => loadWorkspaceState(slots));
  const workspaces = workspaceState.workspaces;
  const activeWorkspaceId = workspaceState.activeWorkspaceId;
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) || workspaces[0];
  const activeId = activeWorkspace?.activeId ?? null;
  const openIds = activeWorkspace?.openIds ?? [];
  /** slotId → live status reported by the panel (streaming + chat count). */
  const [statusBySlot, setStatusBySlot] = useState<Record<string, SlotStatus>>({});
  /** Ctrl+H list — the only way to switch panels while the dock covers the rail. */
  const [switcherOpen, setSwitcherOpen] = useState(false);
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

  // Slots belonging to the active workspace — the rail only shows these.
  const activeWorkspaceSlots = useMemo(
    () => slots.filter((s) => s.workspaceId === activeWorkspaceId),
    [slots, activeWorkspaceId]
  );

  // Update the active workspace's view state (active panel + open rows) immutably.
  const patchActiveWorkspace = useCallback((patch: Partial<WorkspaceState>) => {
    setWorkspaceState((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((w) =>
        w.id === prev.activeWorkspaceId ? { ...w, ...patch } : w
      ),
    }));
  }, []);

  // Keep the active panel valid when the workspace loses a panel (or on first load).
  useEffect(() => {
    if (activeWorkspaceSlots.length && !activeWorkspaceSlots.some((s) => s.id === activeId)) {
      patchActiveWorkspace({ activeId: activeWorkspaceSlots[0].id });
    }
  }, [activeWorkspaceSlots, activeId, patchActiveWorkspace]);

  // Keep open rows valid (and never empty while the workspace has slots).
  useEffect(() => {
    const valid = openIds
      .filter((id) => activeWorkspaceSlots.some((s) => s.id === id))
      .slice(0, MAX_ROWS);
    const next = valid.length
      ? valid
      : [activeWorkspaceSlots[0]?.id].filter((id): id is string => Boolean(id));
    if (next.length !== openIds.length || next.some((id, i) => id !== openIds[i])) {
      patchActiveWorkspace({ openIds: next });
    }
  }, [activeWorkspaceSlots, openIds, patchActiveWorkspace]);

  // Persist workspace store + active id (activeId/openIds now live inside each workspace).
  useEffect(() => {
    saveWorkspaceState(workspaces, activeWorkspaceId);
  }, [workspaces, activeWorkspaceId]);

  const focusSlot = useCallback(
    (id: string) => {
      const prev = openIds;
      let nextOpenIds = prev;
      if (!prev.includes(id)) {
        const idx = Math.max(0, prev.indexOf(activeId ?? id));
        const copy = prev.slice();
        if (!copy.length) {
          nextOpenIds = [id];
        } else {
          copy[Math.min(idx, copy.length - 1)] = id;
          nextOpenIds = copy;
        }
      }
      patchActiveWorkspace({ activeId: id, openIds: nextOpenIds });
    },
    [activeId, openIds, patchActiveWorkspace]
  );

  /** Drop a rail chat onto the centre. A free row is added; the third drop replaces the row under the cursor. */
  const placeSlot = useCallback((dragged: string, targetId: string | null) => {
    if (!activeWorkspaceSlots.some((s) => s.id === dragged)) return;
    const prev = openIds;
    let nextOpenIds: string[] = prev;
    const from = prev.indexOf(dragged);
    if (targetId && from >= 0 && dragged !== targetId && prev.includes(targetId)) {
      const next = prev.slice();
      const to = next.indexOf(targetId);
      const held = next[from];
      next[from] = next[to];
      next[to] = held;
      nextOpenIds = next;
    } else if (from >= 0) {
      nextOpenIds = prev;
    } else if (!targetId || !prev.includes(targetId)) {
      nextOpenIds = prev.length >= MAX_ROWS ? prev : [...prev, dragged];
    } else if (prev.length < MAX_ROWS) {
      const next = prev.slice();
      next.splice(prev.indexOf(targetId) + 1, 0, dragged);
      nextOpenIds = next;
    } else {
      nextOpenIds = prev.map((id) => (id === targetId ? dragged : id));
    }
    patchActiveWorkspace({ activeId: dragged, openIds: nextOpenIds });
    setDropOn(null);
  }, [activeWorkspaceSlots, openIds, patchActiveWorkspace]);

  const unpinSlot = useCallback((id: string) => {
    const prev = openIds;
    if (prev.length <= 1) return;
    patchActiveWorkspace({ openIds: prev.filter((item) => item !== id) });
  }, [openIds, patchActiveWorkspace]);

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
    onSlotsChange([...slots, emptySlot(id, activeWorkspaceId)]);
    patchActiveWorkspace({ activeId: id });
  }, [onSlotsChange, slots, activeWorkspaceId, patchActiveWorkspace]);

  // Create a new workspace with one fresh empty panel, then switch to it.
  const handleAddWorkspace = useCallback(() => {
    const usedWs = new Set(workspaces.map((w) => w.id));
    let wsId = "";
    let n = workspaces.length + 1;
    do {
      wsId = `ws-${n}`;
      n += 1;
    } while (usedWs.has(wsId));
    const usedSlots = new Set(slots.map((s) => s.id));
    let slotId = "";
    let m = slots.length + 1;
    do {
      slotId = `multi-${m}`;
      m += 1;
    } while (usedSlots.has(slotId));
    const slot = emptySlot(slotId, wsId);
    onSlotsChange([...slots, slot]);
    setWorkspaceState((prev) => ({
      activeWorkspaceId: wsId,
      workspaces: [...prev.workspaces, { id: wsId, activeId: slotId, openIds: [slotId] }],
    }));
  }, [workspaces, slots, onSlotsChange]);

  const switchWorkspace = useCallback((id: string) => {
    setWorkspaceState((prev) =>
      prev.activeWorkspaceId === id ? prev : { ...prev, activeWorkspaceId: id }
    );
  }, []);

  const handleCloseSlot = useCallback(
    (slotId: string) => {
      if (activeWorkspaceSlots.length <= 1) return;
      const remaining = activeWorkspaceSlots.filter((s) => s.id !== slotId);
      const next = slots.filter((s) => s.id !== slotId);
      onSlotsChange(next);
      setStatusBySlot((prev) => {
        if (!(slotId in prev)) return prev;
        const copy = { ...prev };
        delete copy[slotId];
        return copy;
      });
      const nextOpenIds = openIds.filter((id) => id !== slotId);
      const nextActiveId = slotId === activeId ? remaining[0]?.id ?? null : activeId;
      patchActiveWorkspace({
        activeId: nextActiveId,
        openIds: nextOpenIds.length
          ? nextOpenIds
          : [remaining[0]?.id].filter((id): id is string => Boolean(id)),
      });
    },
    [activeWorkspaceSlots, slots, onSlotsChange, openIds, activeId, patchActiveWorkspace]
  );

  const stableSlots = useMemo(() => slots.slice(0, MULTIIDE_MAX_SLOTS), [slots]);
  const activeSlotId = activeWorkspaceSlots.some((s) => s.id === activeId)
    ? activeId
    : activeWorkspaceSlots[0]?.id;

  // Chat history is stored per project folder, so two panels on the same folder
  // report the SAME chats — count each folder once instead of double-counting.
  const { totalChats, runningPanels } = useMemo(() => {
    const byFolder = new Map<string, number>();
    let running = 0;
    for (const slot of activeWorkspaceSlots) {
      const status = statusBySlot[slot.id];
      if (!status) continue;
      if (status.running) running += 1;
      const key = slot.rootPath || "no-project";
      byFolder.set(key, Math.max(byFolder.get(key) ?? 0, status.sessionCount));
    }
    let chats = 0;
    for (const count of byFolder.values()) chats += count;
    return { totalChats: chats, runningPanels: running };
  }, [activeWorkspaceSlots, statusBySlot]);

  return (
    <div className="chat-shell theme-workspace flex-1 min-w-0 min-h-0 overflow-hidden">
      {/* ── Left rail: every chat panel, the running one is marked ── */}
      <aside className="chat-rail" aria-label={labels.chat || "Chats"}>
        <header className="chat-rail-head">
          <span className="chat-rail-title">{labels.workspaces || "Workspaces"}</span>
          <div className="chat-rail-actions">
            <button
              type="button"
              className="chat-rail-add"
              onClick={handleAddWorkspace}
              title={labels.newWorkspace || "New workspace"}
              aria-label={labels.newWorkspace || "New workspace"}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
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
          </div>
        </header>

        {/* Workspace switcher — one click switches the whole set of chat panels. */}
        <div className="chat-workspace-list">
          {workspaces.map((ws, i) => {
            const active = ws.id === activeWorkspaceId;
            const wsSlots = slots.filter((s) => s.workspaceId === ws.id);
            const wsRunning = wsSlots.some((s) => Boolean(statusBySlot[s.id]?.running));
            return (
              <button
                key={ws.id}
                type="button"
                className={`chat-workspace-item${active ? " is-active" : ""}${wsRunning ? " is-running" : ""}`}
                onClick={() => switchWorkspace(ws.id)}
                title={`${labels.workspace} ${i + 1}`}
              >
                <span className="chat-rail-dot" aria-hidden />
                <span className="chat-workspace-name">
                  {labels.workspace} {i + 1}
                </span>
                <span className="chat-workspace-count">{wsSlots.length}</span>
              </button>
            );
          })}
        </div>

        <header className="chat-rail-head chat-rail-subhead">
          <span className="chat-rail-title">{labels.chat || "Chats"}</span>
        </header>

        <div className="chat-rail-list">
          {activeWorkspaceSlots.map((slot, index) => {
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
                {activeWorkspaceSlots.length > 1 && (
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
          {activeWorkspaceSlots.length}/{MULTIIDE_MAX_SLOTS}
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
        activeRootPath={activeWorkspaceSlots.find((s) => s.id === activeSlotId)?.rootPath || null}
        onOpenRunners={onOpenRunners}
      />

      {switcherOpen && (
        <ChatSwitcherModal
          slots={activeWorkspaceSlots.map((slot) => ({
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
