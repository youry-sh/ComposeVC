import React from "react";

/**
 * Idle decoration for the bottom of the right column: an ouroboros — a skeletal
 * snake coiled into a ring and swallowing its own tail — turning slowly in
 * place.
 *
 * The body is one filled polygon sampled from a wobbling circle (so the coil
 * reads as organic instead of geometric) with hairline vertebra spikes along
 * its outer edge, and the head is a single path whose open jaws, eye and
 * nostril are cut out by `fill-rule`. All geometry is computed once at module
 * load; every frame is one composited CSS rotation plus a tongue-flick opacity
 * tween, so there are no timers, no React re-renders and no layout work per
 * frame. Colours come from the theme tokens, so the single palette drives it
 * on its own, and `prefers-reduced-motion` freezes it into a readable still
 * frame.
 */

const VIEW = 120;
const CX = 60;
const CY = 60;
const RAD = Math.PI / 180;
/** 340° of body, ending at the top of the circle with the jaws over the tail. */
const ANGLE_START = -430;
const ANGLE_END = -90;
const COIL_R = 41.5;
const STEPS = 108;

type Pt = { x: number; y: number };

const n2 = (v: number): string => String(Math.round(v * 100) / 100);

/** Half thickness at t (0 = tail tip, 1 = neck): whip tail, full barrel, neck taper. */
const halfWidth = (t: number): number => {
  const rise = Math.pow(Math.min(1, t / 0.3), 0.5);
  const body = 0.55 + 4.6 * rise;
  const neck = 1 - 0.2 * Math.max(0, (t - 0.74) / 0.26);
  return body * neck;
};

/** Centreline point at t, with a slow radial wobble so the coil is not a perfect ring. */
const centreAt = (t: number): Pt => {
  const a = (ANGLE_START + (ANGLE_END - ANGLE_START) * t) * RAD;
  const r = COIL_R + Math.sin(t * Math.PI * 5.2) * (1 - t * 0.3) * 1.4;
  return { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r };
};

const normalAt = (p: Pt): Pt => {
  const dx = p.x - CX;
  const dy = p.y - CY;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
};

/** Body silhouette + the vertebra spikes, resolved once. */
const { bodyPath, spinePath } = (() => {
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  const spines: string[] = [];

  for (let i = 0; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const p = centreAt(t);
    const n = normalAt(p);
    const w = halfWidth(t);

    outer.push({ x: p.x + n.x * w, y: p.y + n.y * w });
    inner.push({ x: p.x - n.x * w, y: p.y - n.y * w });

    if (i % 3 === 0 && t > 0.05 && t < 0.96) {
      const len = 1.5 + 1.5 * (w / 5.1);
      spines.push(
        `M${n2(p.x + n.x * w * 0.8)} ${n2(p.y + n.y * w * 0.8)}` +
          `L${n2(p.x + n.x * (w + len))} ${n2(p.y + n.y * (w + len))}`,
      );
    }
  }

  const d = [
    `M${n2(outer[0].x)} ${n2(outer[0].y)}`,
    ...outer.slice(1).map((p) => `L${n2(p.x)} ${n2(p.y)}`),
    ...inner.reverse().map((p) => `L${n2(p.x)} ${n2(p.y)}`),
    "Z",
  ].join("");

  return { bodyPath: d, spinePath: spines.join("") };
})();

/** Neck joint: where the body ends, plus the tangent the head grows along. */
const HEAD = (() => {
  const p = centreAt(1);
  const n = normalAt(p);
  return { x: p.x, y: p.y, deg: (Math.atan2(n.x, -n.y) * 180) / Math.PI };
})();

/* Head in its own frame: +x points along the body, y+ is the outer side.
   One continuous outline (neck → upper jaw → snout → mouth corner → lower jaw
   → throat → neck), so `evenodd` punches the eye and nostril as real holes. */
const HEAD_SHAPE = [
  "M-4 -4.6",
  "C2 -5.6 9 -4.9 14.2 -2.4",
  "C15.6 -1.9 16.2 -1.2 16.3 -0.4",
  "C13.5 0.2 7 0.6 1.2 1.2",
  "C7 2.6 12 4.4 14.6 6.2",
  "C11 6.6 4 4.6 -4 2.6",
  "Z",
  "M5.4 -2.4a1.15 1.15 0 1 0 2.3 0a1.15 1.15 0 1 0 -2.3 0Z",
  "M13.5 -1.4a.45 .45 0 1 0 .9 0a.45 .45 0 1 0 -.9 0Z",
].join(" ");

const FANGS = [
  "M6.5 0.55L7.4 0.55L6.95 1.95Z",
  "M10.1 0.38L10.95 0.38L10.5 1.8Z",
  "M11.9 3.6L12.7 3.75L12.15 2.3Z",
].join("");

const TONGUE = "M15.6 0.9C18.6 1.8 20.8 2.8 23.2 3.9M23.2 3.9L26.3 2.7M23.2 3.9L25.6 5.9";

const AsideSnake: React.FC = () => (
  <div className="aside-snake" aria-hidden>
    <svg
      className="aside-snake-svg"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      fill="none"
      focusable="false"
      role="presentation"
    >
      <path className="aside-snake-body" d={bodyPath} />
      <path className="aside-snake-spines" d={spinePath} />
      <g transform={`translate(${n2(HEAD.x)} ${n2(HEAD.y)}) rotate(${n2(HEAD.deg)})`}>
        <path className="aside-snake-body" d={HEAD_SHAPE} fillRule="evenodd" />
        <path className="aside-snake-fang" d={FANGS} />
        <path className="aside-snake-tongue" d={TONGUE} />
      </g>
    </svg>
  </div>
);

export default AsideSnake;
