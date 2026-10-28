import {
  MULTIIDE_ACTIVE_KEY,
  WORKSPACE_ACTIVE_KEY,
  flushWorkspaceState,
  loadMultiIdeSlots,
  loadWorkspaceState,
  saveWorkspaceState,
} from "../components/MultiIdeWorkspace";
import { dispatchInsertChatInput } from "./mouseSnippets";

/** One sendable MultiIDE chat column. */
export type SendTarget = {
  workspaceId: string;
  workspaceName: string;
  slotId: string;
  /** Short rail name — "to1", "to2 · new" … */
  label: string;
  sessionId: string | null;
  rootPath: string | null;
};

export type SendWorkspace = {
  id: string;
  name: string;
  targets: SendTarget[];
};

export type SendTargetsSnapshot = {
  workspaces: SendWorkspace[];
  activeWorkspaceId: string;
};

export type SendToChatResult = { ok: boolean; error?: string };

/** Host listens to bring the chosen workspace/column to the front. */
export const SEND_TO_CHAT_EVENT = "lopster-send-to-chat";
/** MultiIDE announces that its chat panels are mounted. */
const FLUSH_EVENT = "lopster-send-to-chat-flush";
/** A prompt sent while MultiIDE was not mounted yet. */
const PENDING_KEY = "lopster-send-to-chat-pending";
const PENDING_TTL = 120_000;
const MAX_OPEN_ROWS = 3;

type PendingSend = {
  requestId: string;
  text: string;
  target: SendTarget;
  at: number;
  /** Expert composer button sends straight to the model, not into the input. */
  autoSend?: boolean;
};

function readWorkspaceState() {
  const slots = loadMultiIdeSlots();
  const state = loadWorkspaceState(slots);
  return { slots, state };
}

/** All workspaces + their chat columns, ready for the picker. */
export function readChatTargets(): SendTargetsSnapshot {
  if (typeof window === "undefined") return { workspaces: [], activeWorkspaceId: "" };
  try {
    const { slots, state } = readWorkspaceState();
    const workspaces: SendWorkspace[] = state.workspaces.map((workspace, index) => {
      const name = (workspace.name || "").trim() || `Workspace ${index + 1}`;
      const targets = slots
        .filter((slot) => slot.workspaceId === workspace.id)
        .map((slot, slotIndex) => ({
          workspaceId: workspace.id,
          workspaceName: name,
          slotId: slot.id,
          label: slot.sessionId ? `to${slotIndex + 1}` : `to${slotIndex + 1} · new`,
          sessionId: slot.sessionId,
          rootPath: slot.rootPath,
        }));
      return { id: workspace.id, name, targets };
    });
    const activeWorkspaceId = workspaces.some((w) => w.id === state.activeWorkspaceId)
      ? state.activeWorkspaceId
      : workspaces[0]?.id || "";
    return { workspaces, activeWorkspaceId };
  } catch {
    return { workspaces: [], activeWorkspaceId: "" };
  }
}

function readPending(): PendingSend | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingSend> | null;
    if (!parsed || typeof parsed.text !== "string" || !parsed.target?.slotId) return null;
    if (!parsed.requestId || Date.now() - Number(parsed.at || 0) > PENDING_TTL) {
      window.localStorage.removeItem(PENDING_KEY);
      return null;
    }
    return parsed as PendingSend;
  } catch {
    return null;
  }
}

function writePending(pending: PendingSend) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* quota/private mode — the direct insert still runs when MultiIDE is mounted */
  }
}

function clearPending(requestId?: string) {
  if (typeof window === "undefined") return;
  try {
    if (requestId) {
      const pending = readPending();
      if (pending && pending.requestId !== requestId) return;
    }
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** Make the target workspace + column the active ones (memory, localStorage, disk). */
function focusTarget(target: SendTarget, slots: ReturnType<typeof loadMultiIdeSlots>) {
  const state = loadWorkspaceState(slots);
  if (!state.workspaces.some((workspace) => workspace.id === target.workspaceId)) return;
  const workspaces = state.workspaces.map((workspace) => {
    if (workspace.id !== target.workspaceId) return workspace;
    const openIds = workspace.openIds.includes(target.slotId)
      ? workspace.openIds
      : [...workspace.openIds, target.slotId].slice(-MAX_OPEN_ROWS);
    return { ...workspace, activeId: target.slotId, openIds };
  });
  saveWorkspaceState(workspaces, target.workspaceId);
  try {
    flushWorkspaceState(workspaces, target.workspaceId);
  } catch {
    /* no sync bridge (plain web dev) — saveWorkspaceState already fell back */
  }
  try {
    window.localStorage.setItem(WORKSPACE_ACTIVE_KEY, target.workspaceId);
    window.localStorage.setItem(MULTIIDE_ACTIVE_KEY, target.slotId);
  } catch {
    /* ignore */
  }
}

/** ChatPanels render a `.multi-slot` section; absent means MultiIDE is not mounted. */
function hasMountedChatHost(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.querySelector(".multi-slot"));
}

function replayPending() {
  const pending = readPending();
  if (!pending) return;
  const slots = loadMultiIdeSlots();
  if (!slots.some((slot) => slot.id === pending.target.slotId)) {
    clearPending(pending.requestId);
    return;
  }
  clearPending(pending.requestId);
  focusTarget(pending.target, slots);
  dispatchInsertChatInput(pending.text, false, {
    targetSlotId: pending.target.slotId,
    requestId: pending.requestId,
    autoSend: pending.autoSend !== false,
  });
}

let flushBound = false;
function bindFlushListener() {
  if (flushBound || typeof window === "undefined") return;
  flushBound = true;
  window.addEventListener(FLUSH_EVENT, replayPending);
}

bindFlushListener();

/**
 * Fill the composer of the chosen MultiIDE chat (replace, not append).
 * Only the existing INSERT_INPUT_EVENT bridge is used — no new IPC.
 */
export function dispatchSendToChat(detail: { text: string; target: SendTarget }): SendToChatResult {
  if (typeof window === "undefined") return { ok: false, error: "Окно приложения недоступно" };
  bindFlushListener();
  const text = typeof detail?.text === "string" ? detail.text : "";
  if (!text.trim()) return { ok: false, error: "Промпт пуст" };
  const target = detail?.target;
  if (!target?.workspaceId || !target.slotId) {
    return { ok: false, error: "Не выбран чат" };
  }
  const slots = loadMultiIdeSlots();
  const slot = slots.find((item) => item.id === target.slotId);
  if (!slot) {
    return { ok: false, error: "Этот чат больше не существует — выберите другой" };
  }
  if (slot.workspaceId !== target.workspaceId) {
    return { ok: false, error: "Чат переехал в другой воркспейс — выберите его заново" };
  }

  focusTarget(target, slots);
  const requestId = `stc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { requestId, text, target };
  window.dispatchEvent(new CustomEvent(SEND_TO_CHAT_EVENT, { detail: payload }));

  const hostReady = hasMountedChatHost();
  if (!hostReady) writePending({ ...payload, at: Date.now() });
  dispatchInsertChatInput(text, false, { targetSlotId: target.slotId, requestId });
  if (hostReady) clearPending(requestId);
  return { ok: true };
}
