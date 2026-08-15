import React, { useCallback, useEffect, useState } from "react";

/**
 * Ctrl+H — pick a chat panel without the rail.
 *
 * The media dock can cover the whole rail (a film playing fullscreen inside
 * the column), so the list of panels has to be reachable from a keystroke as
 * well. Same rows as the rail: index, folder, path, live state.
 */

export type SwitcherSlot = {
  id: string;
  rootPath: string | null;
  running: boolean;
  sessionCount: number;
};

type Props = {
  slots: SwitcherSlot[];
  activeId: string | undefined;
  onPick: (slotId: string) => void;
  onClose: () => void;
};

function folderName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

const ChatSwitcherModal: React.FC<Props> = ({ slots, activeId, onPick, onClose }) => {
  const [cursor, setCursor] = useState(() => {
    const index = slots.findIndex((slot) => slot.id === activeId);
    return index >= 0 ? index : 0;
  });

  const pick = useCallback(
    (index: number) => {
      const slot = slots[index];
      if (!slot) return;
      onPick(slot.id);
      onClose();
    },
    [onClose, onPick, slots]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || (event.ctrlKey && event.code === "KeyH")) {
        // Ctrl+H again steps through the list — hold Ctrl, tap H.
        event.preventDefault();
        setCursor((prev) => (slots.length ? (prev + 1) % slots.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCursor((prev) => (slots.length ? (prev - 1 + slots.length) % slots.length : 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        pick(cursor);
        return;
      }
      // 1…9 jumps straight to a panel.
      if (/^Digit[1-9]$/.test(event.code)) {
        const index = Number(event.code.slice(5)) - 1;
        if (index < slots.length) {
          event.preventDefault();
          pick(index);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cursor, onClose, pick, slots.length]);

  return (
    <div className="chat-switcher-scrim" role="dialog" aria-modal="true" aria-label="Chats" onMouseDown={onClose}>
      <div className="chat-switcher" onMouseDown={(event) => event.stopPropagation()}>
        <header className="chat-switcher-head">
          <span className="chat-switcher-title">Chats</span>
          <span className="chat-switcher-hint">↑↓ · 1–9 · Enter · Esc</span>
        </header>
        <div className="chat-switcher-list">
          {slots.map((slot, index) => {
            const name = folderName(slot.rootPath);
            const classes = [
              "chat-switcher-row",
              index === cursor ? "is-cursor" : "",
              slot.id === activeId ? "is-active" : "",
              slot.running ? "is-running" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={slot.id}
                type="button"
                className={classes}
                onMouseEnter={() => setCursor(index)}
                onClick={() => pick(index)}
                title={slot.rootPath || undefined}
              >
                <span className="chat-switcher-dot" aria-hidden />
                <span className="chat-switcher-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="chat-switcher-name">{name || "Agent Work"}</span>
                {slot.sessionCount > 0 && <span className="chat-switcher-count">{slot.sessionCount}</span>}
                <span className="chat-switcher-path">{slot.rootPath || "No folder"}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ChatSwitcherModal;
