import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ContextRingProps {
  usedTokens: number;
  limitTokens: number;
  compacting: boolean;
  onCompact: () => void;
  labels: {
    contextUsage: string;
    compacting: string;
    clickToCompact: string;
    justNow?: string;
    minutesAgo?: string;
    hoursAgo?: string;
    daysAgo?: string;
  };
}

const SIZE = 18;
const RADIUS = 7;
const STROKE = 1.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function ringStroke(percent: number): string {
  if (typeof document === "undefined") {
    if (percent > 0.85) return "#f87171";
    if (percent > 0.6) return "#fbbf24";
    return "#22c55e";
  }
  const styles = getComputedStyle(document.documentElement);
  const danger = styles.getPropertyValue("--danger").trim() || "#f87171";
  const warn = styles.getPropertyValue("--warn").trim() || "#fbbf24";
  const accent = styles.getPropertyValue("--accent").trim() || "#22c55e";
  if (percent > 0.85) return danger;
  if (percent > 0.6) return warn;
  return accent;
}

const ContextRing: React.FC<ContextRingProps> = ({
  usedTokens,
  limitTokens,
  compacting,
  onCompact,
  labels,
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [tipPos, setTipPos] = useState<{ top: number; left: number; place: "above" | "below" } | null>(
    null
  );

  const percent = limitTokens > 0 ? Math.min(usedTokens / limitTokens, 1) : 0;
  const offset = CIRCUMFERENCE * (1 - percent);
  const stroke = ringStroke(percent);
  const ringTitle = compacting ? labels.compacting : labels.contextUsage;

  const placeTip = (measured?: { width: number; height: number }) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const tipW = measured?.width || tipRef.current?.offsetWidth || 288;
    const tipH = measured?.height || tipRef.current?.offsetHeight || 120;
    const gap = 8;
    const placeAbove = rect.top >= tipH + gap;
    let left = rect.right - tipW;
    left = Math.max(8, Math.min(left, window.innerWidth - tipW - 8));
    const top = placeAbove
      ? Math.max(8, rect.top - tipH - gap)
      : Math.min(window.innerHeight - tipH - 8, rect.bottom + gap);
    setTipPos({ top, left, place: placeAbove ? "above" : "below" });
  };

  useLayoutEffect(() => {
    if (!hovered) {
      setTipPos(null);
      return;
    }
    placeTip();
    const id = window.requestAnimationFrame(() => {
      const tipEl = tipRef.current;
      if (!tipEl) return;
      placeTip({ width: tipEl.offsetWidth || 288, height: tipEl.offsetHeight || 120 });
    });
    return () => window.cancelAnimationFrame(id);
  }, [hovered, usedTokens, limitTokens, compacting]);

  useEffect(() => {
    if (!hovered) return;
    const onWin = () => placeTip();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [hovered]);

  const tip =
    hovered
      ? createPortal(
          <div
            ref={tipRef}
            className="context-ring-tip"
            style={
              tipPos
                ? { top: tipPos.top, left: tipPos.left, visibility: "visible" }
                : { top: -9999, left: -9999, visibility: "hidden" }
            }
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <div className="context-ring-tip-title">
              {compacting ? labels.compacting : labels.contextUsage}
            </div>
            <div className="context-ring-tip-row">
              {usedTokens.toLocaleString()} / {limitTokens.toLocaleString()} tokens
            </div>
            <div className="context-ring-tip-muted">
              Full prompt ≈ messages + system + tools
            </div>
            <div className="context-ring-bar">
              <div
                className="context-ring-bar-fill"
                style={{
                  width: `${Math.round(percent * 100)}%`,
                  background: stroke,
                }}
              />
            </div>
            {!compacting && (
              <div className="context-ring-tip-muted">
                {Math.round(percent * 100)}% · {labels.clickToCompact}
              </div>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <div
      ref={rootRef}
      className="context-ring"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onCompact}
        disabled={compacting}
        className={`context-ring-btn ${compacting ? "is-busy" : ""} ${hovered ? "is-hover" : ""}`}
        title={ringTitle}
        aria-label={ringTitle}
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className={compacting ? "context-ring-spin" : undefined}
        >
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={STROKE}
          />
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={stroke}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={compacting ? CIRCUMFERENCE * 0.72 : offset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={{ transition: "stroke-dashoffset 0.45s ease, stroke 0.25s ease" }}
          />
        </svg>
      </button>
      {tip}
    </div>
  );
};

export default ContextRing;
