import React, { useEffect, useState } from "react";

const WORDS = ["Coding", "Work", "Jump"] as const;
const CYCLE_MS = 2200;
const GLYPHS = ["*", "+", "×", "✦", "✱", "✶"] as const;
const GLYPH_MS = 320;

type ThinkingIndicatorProps = {
  label?: string;
};

function ThinkingMorphGlyph() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % GLYPHS.length);
    }, GLYPH_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span className="thinking-glyph-wrap" aria-hidden>
      <span key={index} className="thinking-glyph">
        {GLYPHS[index]}
      </span>
    </span>
  );
}

export function ThinkingIndicator({ label }: ThinkingIndicatorProps) {
  const [index, setIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (label) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % WORDS.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [label]);

  const isTimedThinking = label?.startsWith("Thinking") === true;
  useEffect(() => {
    if (!isTimedThinking) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [isTimedThinking]);

  const elapsedText = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const displayText = isTimedThinking
    ? `${label}${elapsed ? ` · ${elapsedText}` : ""} · analyzing`
    : label || WORDS[index];

  return (
    <div className="thinking-indicator" role="status" aria-live="polite" aria-label={displayText}>
      <ThinkingMorphGlyph />

      <span className={`thinking-label${isTimedThinking ? " thinking-label-max" : ""}`} key={isTimedThinking ? "thinking-process" : label ? `l-${label}` : `w-${index}`}>
        <span className="thinking-label-base">
          {displayText}
          {!label && <span className="thinking-ellipsis">…</span>}
        </span>
        <span className="thinking-label-shine" aria-hidden>
          {displayText}
          {!label && <span className="thinking-ellipsis">…</span>}
        </span>
      </span>
    </div>
  );
}

export default ThinkingIndicator;
