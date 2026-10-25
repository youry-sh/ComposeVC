import React, { useEffect } from "react";
import { X } from "lucide-react";
import PromptsWorkspace from "./PromptsWorkspace";
import { IcoPrompts } from "./topIcons";

interface PromptsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Prompts as an overlay window instead of a workspace tab: the rail footer
 * button opens it on top of whatever panel is showing, so switching to the
 * prompts library never tears down the chat layout underneath.
 */
const PromptsModal: React.FC<PromptsModalProps> = ({ open, onClose }) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center theme-scrim p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex h-[min(860px,94vh)] w-[min(1240px,96vw)] min-h-0 flex-col overflow-hidden border border-ink-300"
        style={{ background: "var(--bg)" }}
        role="dialog"
        aria-modal="true"
        aria-label="Prompts"
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ink-200 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <IcoPrompts className="h-4 w-4 shrink-0" />
            <b className="truncate text-[13px] font-medium tracking-[-0.01em] text-ink-950">Prompts</b>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ide-quiet-btn inline-flex h-7 shrink-0 items-center justify-center px-2 text-[11px] leading-none theme-soft"
            title="Close (Esc)"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <PromptsWorkspace />
        </div>
      </div>
    </div>
  );
};

export default PromptsModal;
