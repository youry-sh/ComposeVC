import React, { useEffect, useState } from "react";

/**
 * One line instead of a wall of tool cards.
 *
 * While a turn runs the tools collapse into a single shimmering status line
 * with a counter; clicking it reveals the full stream. Streaming answer text
 * is never hidden by this — only the tool cards are.
 */

const PHRASES = [
  "Строю будущее на всех языках",
  "Читаю код между строк",
  "Складываю детали в целое",
  "Проверяю каждую мелочь",
  "Довожу до ума",
] as const;
const PHRASE_MS = 2600;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_MS = 90;

type Props = {
  /** How many tool calls this turn has made so far. */
  count: number;
  open: boolean;
  onToggle: () => void;
  /** The agent's own status line, preferred over the rotating phrases. */
  statusLabel?: string | null;
  /** Still streaming — drives the spinner and the shimmer. */
  running?: boolean;
};

const LiveToolStrip: React.FC<Props> = ({ count, open, onToggle, statusLabel, running = true }) => {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!running || statusLabel) return;
    const id = window.setInterval(() => setPhraseIndex((i) => (i + 1) % PHRASES.length), PHRASE_MS);
    return () => window.clearInterval(id);
  }, [running, statusLabel]);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTick((t) => (t + 1) % SPINNER.length), SPINNER_MS);
    return () => window.clearInterval(id);
  }, [running]);

  const text = statusLabel || PHRASES[phraseIndex];

  return (
    <button
      type="button"
      className={`tool-strip${open ? " is-open" : ""}${running ? " is-running" : ""}`}
      onClick={onToggle}
      title={open ? "Hide tool calls" : "Show tool calls"}
    >
      <span className="tool-strip-spin" aria-hidden>
        {running ? SPINNER[tick] : "·"}
      </span>

      {/* ONE text node, and deliberately NO key: keying it by the phrase made
          React remount the span on every rotation, which restarted the
          highlight from the top of its cycle and read as the glow dropping out
          for a second. Swapping the text content alone keeps it continuous. */}
      <span className={`tool-strip-text${running ? " is-shining" : ""}`}>{text}</span>

      <span className="tool-strip-count" title={`${count} tool calls`}>
        {count}
      </span>
      <span className="tool-strip-chevron" aria-hidden>
        {open ? "▾" : "▸"}
      </span>
    </button>
  );
};

export default LiveToolStrip;
