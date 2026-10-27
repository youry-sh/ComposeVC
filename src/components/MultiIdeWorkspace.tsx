import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MultiChatSlot, { MultiSlotPersist } from "./MultiChatSlot";
import ChatAside from "./ChatAside";
import ChatSwitcherModal from "./ChatSwitcherModal";
import GitBadge from "./GitBadge";
import ThinkingIndicator from "./ThinkingIndicator";
import { CustomTool, MainAgentMode, ProviderConfig } from "../types";
import { HotkeyDefinition, matchesHotkey } from "../utils/hotkeys";
import { Cable, ChevronLeft, ChevronRight, ChevronsLeft, LayoutGrid, Pencil, X } from "lucide-react";
import { IcoDocs, IcoPrompts, IcoTasks, IcoTerminal, IcoUsage } from "./topIcons";

/** Ctrl+H (Cmd+H on macOS) — the chat switcher, matched by physical key. */
const SWITCHER_HOTKEY: HotkeyDefinition = { code: "KeyH", modifiers: ["mod"] };
/** Ctrl+B folds the chat rail away; Ctrl+Shift+B does the same for the aside. */
const RAIL_HOTKEY: HotkeyDefinition = { code: "KeyB", modifiers: ["mod"] };
const ASIDE_HOTKEY: HotkeyDefinition = { code: "KeyB", modifiers: ["mod", "shift"] };

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
/** Workspace ceiling — Alt+1…4 jump straight to these slots of the rail. */
export const MULTIIDE_MAX_WORKSPACES = 4;
/** Chats allowed inside ONE workspace (each workspace has its own budget). */
export const MULTIIDE_CHATS_PER_WORKSPACE = 6;
/** Global hard ceiling — every workspace filled to the brim (each panel holds a live session). */
export const MULTIIDE_MAX_SLOTS = MULTIIDE_MAX_WORKSPACES * MULTIIDE_CHATS_PER_WORKSPACE;
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
  /** Per-panel agent mode: lopster | lab-in | fortani */
  agentMode: MainAgentMode;
  /** Which workspace this chat panel belongs to. */
  workspaceId: string;
};

/** A named group of chat panels. Per-workspace view state (active panel + open rows)
 *  lives here so switching workspaces restores exactly what the user left behind. */
export type WorkspaceState = {
  id: string;
  /** User-visible name. "" → the rail falls back to "Workspace N". */
  name: string;
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
    workspaceWorking: string;
    workspaceDone: string;
    deleteWorkspace: string;
  };
  slots: MultiIdeSlotState[];
  onSlotsChange: (slots: MultiIdeSlotState[]) => void;
  /** Jump to the Runner workspace from the aside table. */
  onOpenRunners?: () => void;
  /** Open the Prompts workspace from the rail footer quick buttons. */
  onOpenPrompts?: () => void;
  /** Open the MCP connector modal from the rail footer quick buttons. */
  onOpenMcp?: () => void;
  /** Open the global tasks modal from the rail footer quick buttons. */
  onOpenTasks?: () => void;
  /** Open a workspace panel from the rail footer quick buttons (Terminal / Docs / Usage). */
  onOpenPanel?: (panel: "terminal" | "docs" | "usage") => void;
  /** Bring the MultiIDE panel to the front (used by the Alt+1…4 workspace hotkeys). */
  onRequestFocus?: () => void;
}

function isAgentMode(value: unknown): value is MainAgentMode {
  // Legacy "planner" falls through to default "lopster".
  return (
    value === "lopster" ||
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

export const WORKSPACE_NAME_MAX = 48;

/** Read the disk-backed layout once (sync bridge keeps the existing
 *  synchronous state initializers). Null when the file is absent/unreadable. */
function readDiskState(): MultiIdeDiskState | null {
  try {
    const state = window.lopster?.multiIdeLoadStateSync?.();
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

type LayoutPatch = {
  slots?: MultiIdeDiskSlot[];
  workspaces?: MultiIdeDiskWorkspace[];
  activeWorkspaceId?: string | null;
  ui?: MultiIdeDiskUi;
};

/** Which of the two side columns are folded away. Persisted with the layout. */
type ChatShellUi = { railCollapsed: boolean; asideCollapsed: boolean };

const DEFAULT_SHELL_UI: ChatShellUi = { railCollapsed: false, asideCollapsed: false };

function readShellUi(): ChatShellUi {
  const ui = readDiskState()?.ui;
  if (!ui || typeof ui !== "object") return DEFAULT_SHELL_UI;
  return {
    railCollapsed: ui.railCollapsed === true,
    asideCollapsed: ui.asideCollapsed === true,
  };
}

/** Folding is pure chrome — a missing bridge just leaves it in-memory for the session. */
function saveShellUi(ui: ChatShellUi) {
  writeLayoutPatch({ ui }, () => {});
}

/**
 * Disk is the source of truth. localStorage is only (a) read once to migrate a
 * pre-store layout and (b) a fallback when the bridge is unavailable (plain web
 * dev) or an IPC write fails — so a failed write can never lose the layout.
 */
function writeLayoutPatch(patch: LayoutPatch, fallback: () => void): void {
  const api = window.lopster;
  if (!api?.multiIdeSaveState) {
    fallback();
    return;
  }
  try {
    void Promise.resolve(api.multiIdeSaveState(patch))
      .then((result) => {
        if (!result || result.ok === false) fallback();
      })
      .catch(fallback);
  } catch {
    fallback();
  }
}

/** Synchronous write used on pagehide — async IPC would not land in time. */
function flushLayoutPatch(patch: LayoutPatch): boolean {
  const api = window.lopster;
  if (!api?.multiIdeSaveStateSync) return false;
  try {
    const result = api.multiIdeSaveStateSync(patch);
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

/** Shared validation for both the legacy localStorage payload and disk state. */
function normalizeSlots(parsed: unknown): MultiIdeSlotState[] {
  if (!Array.isArray(parsed) || parsed.length === 0) return [];
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
  return slots;
}

export function loadMultiIdeSlots(): MultiIdeSlotState[] {
  const diskSlots = normalizeSlots(readDiskState()?.slots);
  if (diskSlots.length) return diskSlots;
  try {
    const raw = window.localStorage.getItem(MULTIIDE_STORAGE_KEY);
    if (!raw) return defaultMultiIdeSlots();
    const legacy = normalizeSlots(JSON.parse(raw) as unknown);
    if (legacy.length) return legacy;
  } catch {
    /* corrupt legacy payload → fresh default */
  }
  return defaultMultiIdeSlots();
}

export function saveMultiIdeSlots(slots: MultiIdeSlotState[]) {
  const payload = slots.map((s) => ({
    id: s.id,
    rootPath: s.rootPath,
    sessionId: s.sessionId,
    selectedModelId: s.selectedModelId,
    agentMode: s.agentMode,
    workspaceId: s.workspaceId,
  }));
  writeLayoutPatch({ slots: payload }, () => {
    try {
      window.localStorage.setItem(MULTIIDE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  });
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
    name:
      typeof item.name === "string"
        ? item.name.replace(/\s+/g, " ").trim().slice(0, WORKSPACE_NAME_MAX)
        : "",
    activeId: typeof item.activeId === "string" ? item.activeId : null,
    openIds: Array.isArray(item.openIds)
      ? item.openIds
          .filter((x): x is string => typeof x === "string")
          .slice(0, MAX_ROWS)
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
        name: "",
        activeId,
        openIds: openIds.length ? openIds.slice(0, MAX_ROWS) : [firstId],
      },
    ],
    activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  };
}

function uniqueWorkspaces(raw: unknown): WorkspaceState[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: WorkspaceState[] = [];
  raw.forEach((entry, index) => {
    const workspace = normalizeWorkspace(entry, index);
    if (!workspace.id || seen.has(workspace.id)) return;
    seen.add(workspace.id);
    out.push(workspace);
  });
  return out;
}

/** Every chat panel must belong to a rendered workspace, otherwise its chats are
 *  unreachable after a partial/corrupt store. */
function ensureWorkspaceCoverage(
  workspaces: WorkspaceState[],
  slots: MultiIdeSlotState[]
): WorkspaceState[] {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  const missing = Array.from(
    new Set(slots.map((slot) => slot.workspaceId).filter((id) => Boolean(id) && !known.has(id)))
  );
  if (!missing.length) return workspaces;
  return [
    ...workspaces,
    ...missing.map((id) => {
      const own = slots.filter((slot) => slot.workspaceId === id);
      return {
        id,
        name: "",
        activeId: own[0]?.id ?? null,
        openIds: own.slice(0, MAX_ROWS).map((slot) => slot.id),
      };
    }),
  ];
}

function pickActiveWorkspaceId(
  requested: string | null | undefined,
  workspaces: WorkspaceState[]
): string {
  return requested && workspaces.some((workspace) => workspace.id === requested)
    ? requested
    : workspaces[0].id;
}

/** Workspace store + active id — disk first, legacy localStorage only to migrate. */
export function loadWorkspaceState(slots: MultiIdeSlotState[]): {
  workspaces: WorkspaceState[];
  activeWorkspaceId: string;
} {
  const disk = readDiskState();
  const diskWorkspaces = uniqueWorkspaces(disk?.workspaces);
  if (diskWorkspaces.length) {
    const workspaces = ensureWorkspaceCoverage(diskWorkspaces, slots);
    return {
      workspaces,
      activeWorkspaceId: pickActiveWorkspaceId(disk?.activeWorkspaceId, workspaces),
    };
  }
  try {
    const raw = JSON.parse(window.localStorage.getItem(WORKSPACES_KEY) || "null") as unknown;
    const rawActive = window.localStorage.getItem(WORKSPACE_ACTIVE_KEY);
    const legacyWorkspaces = uniqueWorkspaces(raw);
    if (legacyWorkspaces.length) {
      const workspaces = ensureWorkspaceCoverage(legacyWorkspaces, slots);
      return {
        workspaces,
        activeWorkspaceId: pickActiveWorkspaceId(rawActive, workspaces),
      };
    }
  } catch {
    /* fall through to a fresh default workspace */
  }
  return seedDefaultWorkspace(slots);
}

export function saveWorkspaceState(workspaces: WorkspaceState[], activeWorkspaceId: string) {
  const payload = workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    activeId: workspace.activeId,
    openIds: workspace.openIds,
  }));
  writeLayoutPatch({ workspaces: payload, activeWorkspaceId }, () => {
    try {
      window.localStorage.setItem(
        WORKSPACES_KEY,
        JSON.stringify(
          payload.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            activeId: workspace.activeId,
            openIds: workspace.openIds,
          }))
        )
      );
      window.localStorage.setItem(WORKSPACE_ACTIVE_KEY, activeWorkspaceId);
    } catch {
      /* ignore */
    }
  });
}

/** Synchronous flush for pagehide — guarantees a fresh rename is on disk. */
export function flushWorkspaceState(
  workspaces: WorkspaceState[],
  activeWorkspaceId: string,
  ui?: ChatShellUi
): boolean {
  return flushLayoutPatch({
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      activeId: workspace.activeId,
      openIds: workspace.openIds,
    })),
    activeWorkspaceId,
    ...(ui ? { ui } : {}),
  });
}

/** Live per-panel status pushed up by MultiChatSlot. */
type SlotStatus = { running: boolean; sessionCount: number };

const SLOT_DRAG = "application/x-composevc-slot";

function hasSlotDrag(data: DataTransfer): boolean {
  return Array.from(data.types).includes(SLOT_DRAG);
}

/**
 * Every workspace row in the rail is underlined by its own soft hue, so the
 * list (Workspace-1, Workspace-2, …) is scannable at a glance. Hues walk the
 * colour wheel by the golden angle, so the sequence reads as random yet two
 * neighbouring workspaces are always ~137° apart — never the same colour.
 * Pure function of the row position: no state, no timers, no flicker.
 */
function workspaceAccent(index: number): string {
  const hue = Math.round((index * 137.508 + 210) % 360);
  return `hsl(${hue} 68% 62%)`;
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
  onOpenPrompts,
  onOpenMcp,
  onOpenTasks,
  onOpenPanel,
  onRequestFocus,
}) => {
  const [workspaceState, setWorkspaceState] = useState(() => loadWorkspaceState(slots));
  /** Folded side columns — restored from disk, saved on every toggle. */
  const [shellUi, setShellUi] = useState<ChatShellUi>(readShellUi);
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
  /** Inline workspace rename: which workspace is being edited + its draft. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCancelRef = useRef(false);
  /** Latest persisted state for the sync pagehide flush. */
  const workspacesRef = useRef(workspaces);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const shellUiRef = useRef(shellUi);
  workspacesRef.current = workspaces;
  activeWorkspaceIdRef.current = activeWorkspaceId;
  shellUiRef.current = shellUi;

  const toggleRail = useCallback(() => {
    const next = { ...shellUiRef.current, railCollapsed: !shellUiRef.current.railCollapsed };
    setShellUi(next);
    saveShellUi(next);
  }, []);

  const toggleAside = useCallback(() => {
    const next = { ...shellUiRef.current, asideCollapsed: !shellUiRef.current.asideCollapsed };
    setShellUi(next);
    saveShellUi(next);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesHotkey(event, SWITCHER_HOTKEY)) {
        event.preventDefault();
        setSwitcherOpen((prev) => !prev);
        return;
      }
      // Shift is required for the aside, so test it before the plain rail stroke.
      if (matchesHotkey(event, ASIDE_HOTKEY)) {
        event.preventDefault();
        toggleAside();
        return;
      }
      if (matchesHotkey(event, RAIL_HOTKEY)) {
        event.preventDefault();
        toggleRail();
      }
    };
    window.addEventListener("keydown", onKey);
    // Same stroke from inside a <webview>: the guest owns the keyboard there,
    // so the main process forwards it (see installPackagedWindowHardening).
    const unsub = window.lopster?.onOpenChatSwitcher?.(() => setSwitcherOpen((prev) => !prev));
    return () => {
      window.removeEventListener("keydown", onKey);
      unsub?.();
    };
  }, [toggleAside, toggleRail]);

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

  // A rename must survive even an instant quit / reload: flush synchronously when
  // the window goes away instead of relying on an async IPC round-trip.
  useEffect(() => {
    const flush = () => {
      flushWorkspaceState(workspacesRef.current, activeWorkspaceIdRef.current, shellUiRef.current);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /** Rail label — custom name, else the numbered default. */
  const workspaceLabel = useCallback(
    (workspace: WorkspaceState, index: number) =>
      (workspace.name || "").trim() || `${labels.workspace} ${index + 1}`,
    [labels.workspace]
  );

  useEffect(() => {
    if (!renamingId) return;
    const input = renameInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [renamingId]);

  const beginRename = useCallback(
    (workspace: WorkspaceState, index: number) => {
      setRenameDraft(workspaceLabel(workspace, index));
      renameCancelRef.current = false;
      setRenamingId(workspace.id);
    },
    [workspaceLabel]
  );

  /** Enter / blur: keep a custom name; empty (or the default label) → default. */
  const commitRename = useCallback(
    (workspaceId: string) => {
      const index = workspaces.findIndex((workspace) => workspace.id === workspaceId);
      if (index < 0) {
        setRenamingId(null);
        return;
      }
      const fallbackName = `${labels.workspace} ${index + 1}`;
      const value = renameDraft.replace(/\s+/g, " ").trim().slice(0, WORKSPACE_NAME_MAX);
      const name = value === fallbackName ? "" : value;
      const nextWorkspaces = workspaces.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, name } : workspace
      );
      setWorkspaceState((prev) => ({ ...prev, workspaces: nextWorkspaces }));
      saveWorkspaceState(nextWorkspaces, activeWorkspaceId);
      setRenamingId(null);
    },
    [activeWorkspaceId, labels.workspace, renameDraft, workspaces]
  );

  const cancelRename = useCallback(() => {
    renameCancelRef.current = true;
    setRenamingId(null);
  }, []);

  const handleRenameKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, workspaceId: string) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        commitRename(workspaceId);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancelRename();
        return;
      }
      if (event.key === " ") event.stopPropagation();
    },
    [cancelRename, commitRename]
  );

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
    // Each workspace owns its own chat budget, so the cap is per workspace here;
    // the global ceiling is only the sum of all four budgets.
    if (activeWorkspaceSlots.length >= MULTIIDE_CHATS_PER_WORKSPACE) return;
    if (slots.length >= MULTIIDE_MAX_SLOTS) return;
    const used = new Set(slots.map((s) => s.id));
    let id = "";
    do {
      seqRef.current += 1;
      id = `multi-${slots.length + seqRef.current}`;
    } while (used.has(id));
    onSlotsChange([...slots, emptySlot(id, activeWorkspaceId)]);
    patchActiveWorkspace({ activeId: id });
  }, [activeWorkspaceSlots, onSlotsChange, slots, activeWorkspaceId, patchActiveWorkspace]);

  // Create a new workspace with one fresh empty panel, then switch to it.
  const handleAddWorkspace = useCallback(() => {
    if (workspaces.length >= MULTIIDE_MAX_WORKSPACES) return;
    if (slots.length >= MULTIIDE_MAX_SLOTS) return;
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
      workspaces: [
        ...prev.workspaces,
        { id: wsId, name: "", activeId: slotId, openIds: [slotId] },
      ],
    }));
  }, [workspaces, slots, onSlotsChange]);

  const switchWorkspace = useCallback((id: string) => {
    setWorkspaceState((prev) =>
      prev.activeWorkspaceId === id ? prev : { ...prev, activeWorkspaceId: id }
    );
  }, []);

  /**
   * Alt+1…4 — jump straight to that workspace in rail order. The rail is the
   * single source of truth, so the mapping is positional: Alt+1 is the first
   * workspace, Alt+4 the fourth (which is also the ceiling).
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      if (!match) return;
      const index = Number(match[1]) - 1;
      if (index < 0 || index >= MULTIIDE_MAX_WORKSPACES) return;
      const target = workspacesRef.current[index];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      switchWorkspace(target.id);
      onRequestFocus?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onRequestFocus, switchWorkspace]);

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

  // Delete a workspace: close all its chat panels via the same slot-removal path as
  // handleCloseSlot (drop from `slots` + status), then drop the workspace and re-point
  // activeWorkspaceId if it was active. Last remaining workspace cannot be deleted.
  const handleDeleteWorkspace = useCallback(
    (wsId: string) => {
      if (workspaces.length <= 1) return;
      setRenamingId((current) => (current === wsId ? null : current));
      const targetIds = new Set(slots.filter((s) => s.workspaceId === wsId).map((s) => s.id));
      // Stop any running chat before its panel is unmounted, so deleting a workspace
      // never leaves an orphaned run in the main process (same path as the Stop button).
      for (const slot of slots) {
        if (!targetIds.has(slot.id)) continue;
        if (statusBySlot[slot.id]?.running && slot.sessionId) {
          void window.lopster?.stopGeneration(slot.sessionId).catch(() => undefined);
        }
      }
      onSlotsChange(slots.filter((s) => !targetIds.has(s.id)));
      setStatusBySlot((prev) => {
        if (!targetIds.size) return prev;
        const copy = { ...prev };
        for (const id of targetIds) delete copy[id];
        return copy;
      });
      setWorkspaceState((prev) => {
        const remaining = prev.workspaces.filter((w) => w.id !== wsId);
        if (remaining.length === prev.workspaces.length) return prev;
        const activeWorkspaceId =
          prev.activeWorkspaceId === wsId ? remaining[0]?.id ?? prev.activeWorkspaceId : prev.activeWorkspaceId;
        return { activeWorkspaceId, workspaces: remaining };
      });
    },
    [workspaces, slots, statusBySlot, onSlotsChange]
  );

  const stableSlots = useMemo(() => slots.slice(0, MULTIIDE_MAX_SLOTS), [slots]);
  const activeSlotId: string | undefined =
    activeId && activeWorkspaceSlots.some((s) => s.id === activeId)
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
    <div
      className={`chat-shell theme-workspace flex-1 min-w-0 min-h-0 overflow-hidden${
        shellUi.railCollapsed ? " is-rail-collapsed" : ""
      }${shellUi.asideCollapsed ? " is-aside-collapsed" : ""}`}
    >
      {/* ── Left rail: every chat panel, the running one is marked ── */}
      <aside className="chat-rail" aria-label={labels.chat || "Chats"} aria-hidden={shellUi.railCollapsed}>
        <header className="chat-rail-head">
          <span className="chat-rail-title">{labels.workspaces || "Workspaces"}</span>
          <div className="chat-rail-actions">
            <button
              type="button"
              className="chat-rail-add"
              onClick={handleAddWorkspace}
              disabled={workspaces.length >= MULTIIDE_MAX_WORKSPACES}
              title={labels.newWorkspace || "New workspace"}
              aria-label={labels.newWorkspace || "New workspace"}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              className="chat-rail-add"
              onClick={handleAddSlot}
              disabled={activeWorkspaceSlots.length >= MULTIIDE_CHATS_PER_WORKSPACE}
              title={`${labels.newChat || "New chat panel"} (${activeWorkspaceSlots.length}/${MULTIIDE_CHATS_PER_WORKSPACE})`}
              aria-label={labels.newChat || "New chat panel"}
            >
              +
            </button>
            <button
              type="button"
              className="chat-rail-add chat-rail-collapse"
              onClick={toggleRail}
              title="Скрыть панель чатов (Ctrl+B)"
              aria-label="Скрыть панель чатов"
              aria-expanded={!shellUi.railCollapsed}
            >
              <ChevronsLeft className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>
        </header>

        {/* Workspace switcher — one click switches the whole set of chat panels. */}
        <div className="chat-workspace-list">
          {workspaces.map((ws, i) => {
            const active = ws.id === activeWorkspaceId;
            const wsSlots = slots.filter((s) => s.workspaceId === ws.id);
            const working = wsSlots.filter((s) => statusBySlot[s.id]?.running === true).length;
            const completed = wsSlots.filter((s) => {
              const st = statusBySlot[s.id];
              return Boolean(st) && st.running === false && st.sessionCount > 0;
            }).length;
            const wsRunning = working > 0;
            return (
              <div
                key={ws.id}
                className={`chat-workspace-item${active ? " is-active" : ""}${wsRunning ? " is-running" : ""}`}
                style={{ "--ws-accent": workspaceAccent(i) } as React.CSSProperties}
              >
                {renamingId === ws.id ? (
                  <div className="chat-workspace-btn is-editing">
                    <span className="chat-rail-dot" aria-hidden />
                    <input
                      ref={renameInputRef}
                      className="chat-workspace-rename"
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onKeyDown={(event) => handleRenameKeyDown(event, ws.id)}
                      onBlur={() => {
                        if (renameCancelRef.current) {
                          renameCancelRef.current = false;
                          return;
                        }
                        commitRename(ws.id);
                      }}
                      maxLength={WORKSPACE_NAME_MAX}
                      spellCheck={false}
                      aria-label="Имя воркспейса"
                      title="Enter — сохранить · Esc — отмена"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="chat-workspace-btn"
                    onClick={() => switchWorkspace(ws.id)}
                    onDoubleClick={() => beginRename(ws, i)}
                    title={`${workspaceLabel(ws, i)}${i < MULTIIDE_MAX_WORKSPACES ? ` · Alt+${i + 1}` : ""} · двойной клик — переименовать`}
                  >
                    <span className="chat-rail-dot" aria-hidden />
                    <span className="chat-workspace-name">{workspaceLabel(ws, i)}</span>
                    <span
                      className="chat-workspace-stats"
                      title={`${labels.workspaceWorking}: ${working} · ${labels.workspaceDone}: ${completed}`}
                      aria-label={`${labels.workspaceWorking}: ${working}, ${labels.workspaceDone}: ${completed}`}
                    >
                      <span className="chat-workspace-stat is-working">{working}</span>
                      <span className="chat-workspace-stat-divider" aria-hidden>
                        ·
                      </span>
                      <span className="chat-workspace-stat is-done">{completed}</span>
                    </span>
                  </button>
                )}
                {renamingId !== ws.id && (
                  <div className="chat-workspace-actions">
                    <button
                      type="button"
                      className="chat-workspace-action chat-workspace-rename-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(ws, i);
                      }}
                      title="Переименовать воркспейс"
                      aria-label="Переименовать воркспейс"
                    >
                      <Pencil size={13} strokeWidth={1.9} aria-hidden />
                    </button>
                    {workspaces.length > 1 && (
                      <button
                        type="button"
                        className="chat-workspace-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteWorkspace(ws.id);
                        }}
                        title={labels.deleteWorkspace}
                        aria-label={labels.deleteWorkspace}
                      >
                        <X size={13} strokeWidth={2} aria-hidden />
                      </button>
                    )}
                  </div>
                )}
              </div>
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
                    <X size={12} strokeWidth={2} aria-hidden />
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
          <div className="chat-rail-quick">
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={onOpenPrompts}
              title="Prompts"
            >
              <IcoPrompts />
              <span>Prompts</span>
            </button>
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={onOpenMcp}
              title="MCP"
            >
              <Cable aria-hidden />
              <span>MCP</span>
            </button>
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={onOpenTasks}
              title="Tasks"
            >
              <IcoTasks aria-hidden />
              <span>Tasks</span>
            </button>
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={() => onOpenPanel?.("terminal")}
              title="Terminal"
            >
              <IcoTerminal />
              <span>Terminal</span>
            </button>
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={() => onOpenPanel?.("docs")}
              title="Docs"
            >
              <IcoDocs />
              <span>Docs</span>
            </button>
            <button
              type="button"
              className="chat-rail-quick-btn"
              onClick={() => onOpenPanel?.("usage")}
              title="Usage"
            >
              <IcoUsage />
              <span>Usage</span>
            </button>
          </div>
          <span className="chat-rail-foot-count">
            {activeWorkspaceSlots.length}/{MULTIIDE_CHATS_PER_WORKSPACE}
          </span>
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
                  <X size={12} strokeWidth={2} aria-hidden />
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
        onCollapse={toggleAside}
      />

      {/* ── Folded columns leave a pull tab on the edge they came from ── */}
      {shellUi.railCollapsed && (
        <button
          type="button"
          className="chat-shell-handle is-left"
          onClick={toggleRail}
          title="Показать панель чатов (Ctrl+B)"
          aria-label="Показать панель чатов"
        >
          <ChevronRight size={13} strokeWidth={2} aria-hidden />
        </button>
      )}
      {shellUi.asideCollapsed && (
        <button
          type="button"
          className="chat-shell-handle is-right"
          onClick={toggleAside}
          title="Показать панель статистики (Ctrl+Shift+B)"
          aria-label="Показать правую панель"
        >
          <ChevronLeft size={13} strokeWidth={2} aria-hidden />
        </button>
      )}

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
