import React, { useEffect, useState } from "react";

/**
 * Status line that sits above the live tool cards.
 *
 * The cards themselves are ALWAYS on screen while the turn runs — nothing is
 * folded behind a disclosure arrow, so you see every tool the moment it
 * starts. This line only reports state: spinner, the agent's own status (or a
 * rotating phrase) and the call counter.
 */

const PHRASES = [
  "Строю будущее на всех языках",
  "Читаю код между строк",
  "Складываю детали в целое",
  "Проверяю каждую мелочь",
  "Довожу до ума",
] as const;
const PHRASE_MS = 2600;

type Props = {
  /** How many tool calls this turn has made so far. */
  count: number;
  /** The agent's own status line, preferred over the rotating phrases. */
  statusLabel?: string | null;
  /** Still streaming — drives the spinner. */
  running?: boolean;
};

const LiveToolStrip: React.FC<Props> = ({ count, statusLabel, running = true }) => {
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (!running || statusLabel) return;
    const id = window.setInterval(() => setPhraseIndex((i) => (i + 1) % PHRASES.length), PHRASE_MS);
    return () => window.clearInterval(id);
  }, [running, statusLabel]);

  const text = statusLabel || PHRASES[phraseIndex];

  return (
    <div className={`tool-strip is-static${running ? " is-running" : ""}`}>
      <span className={`tool-strip-spin${running ? " is-running" : ""}`} aria-hidden>
        {running ? "⠋" : "·"}
      </span>

      {/* ONE text node, and deliberately NO key: keying it by the phrase made
          React remount the span on every rotation, which restarted the
          highlight from the top of its cycle and read as the glow dropping out
          for a second. Swapping the text content alone keeps it continuous. */}
      <span className="tool-strip-text">{text}</span>

      <span className="tool-strip-count" title={`${count} tool calls`}>
        {count}
      </span>
    </div>
  );
};

export default LiveToolStrip;
