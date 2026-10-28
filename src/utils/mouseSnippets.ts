/** Side-button mouse snippets → chat input */

export const MOUSE_SNIPPETS_KEY = "lopster-mouse-snippets";
export const INSERT_INPUT_EVENT = "lopster-insert-chat-input";

/** MouseEvent.button: 3 = Back (side), 4 = Forward (side) */
export type MouseSideButton = 3 | 4;

export interface MouseSnippetSlot {
  text: string;
  /** Which mouse side button triggers this slot */
  button: MouseSideButton;
}

export interface MouseSnippetsConfig {
  enabled: boolean;
  /** Append to existing input (true) or replace (false) */
  append: boolean;
  slot1: MouseSnippetSlot;
  slot2: MouseSnippetSlot;
}

export const DEFAULT_MOUSE_SNIPPETS: MouseSnippetsConfig = {
  enabled: true,
  append: true,
  slot1: { text: "", button: 3 },
  slot2: { text: "", button: 4 },
};

export function loadMouseSnippets(): MouseSnippetsConfig {
  try {
    const raw = window.localStorage.getItem(MOUSE_SNIPPETS_KEY);
    if (!raw) return { ...DEFAULT_MOUSE_SNIPPETS, slot1: { ...DEFAULT_MOUSE_SNIPPETS.slot1 }, slot2: { ...DEFAULT_MOUSE_SNIPPETS.slot2 } };
    const parsed = JSON.parse(raw) as Partial<MouseSnippetsConfig>;
    return {
      enabled: parsed.enabled !== false,
      append: parsed.append !== false,
      slot1: {
        text: typeof parsed.slot1?.text === "string" ? parsed.slot1.text : "",
        button: parsed.slot1?.button === 4 ? 4 : 3,
      },
      slot2: {
        text: typeof parsed.slot2?.text === "string" ? parsed.slot2.text : "",
        button: parsed.slot2?.button === 3 ? 3 : 4,
      },
    };
  } catch {
    return { ...DEFAULT_MOUSE_SNIPPETS, slot1: { ...DEFAULT_MOUSE_SNIPPETS.slot1 }, slot2: { ...DEFAULT_MOUSE_SNIPPETS.slot2 } };
  }
}

export function saveMouseSnippets(config: MouseSnippetsConfig) {
  try {
    window.localStorage.setItem(MOUSE_SNIPPETS_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

export function textForMouseButton(config: MouseSnippetsConfig, button: number): string | null {
  if (!config.enabled) return null;
  if (button === config.slot1.button && config.slot1.text.trim()) return config.slot1.text;
  if (button === config.slot2.button && config.slot2.text.trim()) return config.slot2.text;
  return null;
}

/**
 * Broadcast insert into chat composers. Each ChatPanel listens and applies
 * only if it is the active MultiIDE column (focus/hover) — never all 4 at once.
 */
export type InsertChatInputOptions = {
  /** Deliver only to this MultiIDE slot (bypasses the hover/focus heuristic). */
  targetSlotId?: string;
  /** Stable id so a repeated delivery of the same insert is applied once. */
  requestId?: string;
};

export function dispatchInsertChatInput(
  text: string,
  append: boolean,
  options?: InsertChatInputOptions
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<InsertChatInputDetail>(INSERT_INPUT_EVENT, {
      detail: {
        text,
        append,
        ...(options?.targetSlotId ? { targetSlotId: options.targetSlotId } : {}),
        ...(options?.requestId ? { requestId: options.requestId } : {}),
      },
    })
  );
}

export type InsertChatInputDetail = {
  text: string;
  append: boolean;
  targetSlotId?: string;
  requestId?: string;
};
