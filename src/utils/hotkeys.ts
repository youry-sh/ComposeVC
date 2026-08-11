import type React from "react";

export type HotkeyModifier = "ctrl" | "meta" | "alt" | "shift" | "mod";

export interface HotkeyDefinition {
  /** Physical KeyboardEvent.code, e.g. "KeyT", "KeyS", "Slash". Layout-independent. */
  code: string;
  modifiers?: HotkeyModifier[];
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

const hasModifier = (event: KeyboardEvent | React.KeyboardEvent, modifier: HotkeyModifier): boolean => {
  if (modifier === "ctrl") return event.ctrlKey;
  if (modifier === "meta") return event.metaKey;
  if (modifier === "alt") return event.altKey;
  if (modifier === "shift") return event.shiftKey;
  // Cross-platform command key: Ctrl on Windows/Linux, Cmd on macOS.
  return event.ctrlKey || event.metaKey;
};

/**
 * Matches shortcuts by KeyboardEvent.code instead of KeyboardEvent.key.
 * code is the physical key (KeyT, KeyS, Digit1), so Ctrl+T keeps working on
 * Russian/other layouts where event.key becomes a localized character.
 */
export function matchesHotkey(event: KeyboardEvent | React.KeyboardEvent, definition: HotkeyDefinition): boolean {
  if (event.code !== definition.code) return false;

  const modifiers = definition.modifiers || [];
  return modifiers.every((modifier) => hasModifier(event, modifier));
}

export function runHotkey(
  event: KeyboardEvent | React.KeyboardEvent,
  definition: HotkeyDefinition,
  handler: () => void,
): boolean {
  if (!matchesHotkey(event, definition)) return false;
  if (definition.preventDefault !== false) event.preventDefault();
  if (definition.stopPropagation) event.stopPropagation();
  handler();
  return true;
}
