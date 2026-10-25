import React from "react";

/**
 * Idle decoration for the bottom of the right column: a monospace radar scope.
 *
 * A hairline grid, two range rings, a slowly turning accent wedge with a bright
 * leading edge and three blips that flash as the beam reaches them. The whole
 * motion is one composited CSS rotation plus a few opacity tweens, so it costs
 * no JS timers, no React re-renders and no layout work per frame. Every colour
 * comes from the theme tokens, so mono / winter / crimson re-tint it on their
 * own, and `prefers-reduced-motion` freezes it into a readable still frame.
 */
const AsideRadar: React.FC = () => (
  <div className="aside-radar" aria-hidden>
    <div className="aside-radar-scope">
      <span className="aside-radar-grid" />
      <span className="aside-radar-ring aside-radar-ring--outer" />
      <span className="aside-radar-ring aside-radar-ring--inner" />
      <span className="aside-radar-axis aside-radar-axis--h" />
      <span className="aside-radar-axis aside-radar-axis--v" />
      <span className="aside-radar-sweep" />
      <span className="aside-radar-blip aside-radar-blip--1" />
      <span className="aside-radar-blip aside-radar-blip--2" />
      <span className="aside-radar-blip aside-radar-blip--3" />
      <span className="aside-radar-core" />
    </div>
  </div>
);

export default AsideRadar;
