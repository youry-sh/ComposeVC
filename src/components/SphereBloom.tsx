import React from "react";

/**
 * Idle decoration for the right column: a white "anime spell" orb inside a
 * slowly turning gold magic circle of kanji, floating gently on an infinite
 * CSS loop. Pure SVG + CSS, no JS timers and no React re-renders.
 */

const GLYPHS = [
  "知",
  "識",
  "記",
  "憶",
  "心",
  "光",
  "空",
  "夢",
  "星",
  "時",
  "魂",
  "絆",
  "縁",
  "環",
  "想",
  "界",
  "道",
  "真",
  "理",
  "結",
];

const TICKS = 24;

function angleOf(i: number, n: number) {
  return (Math.PI * 2 * i) / n - Math.PI / 2;
}

const SphereBloom: React.FC = () => {
  const glyphs = GLYPHS.map((glyph, i) => {
    const a = angleOf(i, GLYPHS.length);
    return (
      <text
        key={`g${i}`}
        x={Math.cos(a) * 50}
        y={Math.sin(a) * 50}
        className="sphere-glyph"
        textAnchor="middle"
        dominantBaseline="central"
      >
        {glyph}
      </text>
    );
  });

  const ticks = Array.from({ length: TICKS }).map((_, i) => {
    const a = angleOf(i, TICKS);
    const r0 = i % 6 === 0 ? 40 : 42;
    return (
      <line
        key={`t${i}`}
        x1={Math.cos(a) * r0}
        y1={Math.sin(a) * r0}
        x2={Math.cos(a) * 45}
        y2={Math.sin(a) * 45}
        className="sphere-tick"
      />
    );
  });

  return (
    <div className="sphere-bloom" aria-hidden>
      <svg className="sphere-svg" viewBox="0 0 200 200">
        <defs>
          <radialGradient id="sb-sphere" cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="45%" stopColor="#f2f2f2" />
            <stop offset="78%" stopColor="#d4d4d4" />
            <stop offset="100%" stopColor="#8f8f8f" />
          </radialGradient>
          <radialGradient id="sb-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255, 255, 255, 0.30)" />
            <stop offset="55%" stopColor="rgba(255, 255, 255, 0.10)" />
            <stop offset="100%" stopColor="rgba(255, 255, 255, 0)" />
          </radialGradient>
        </defs>

        <g transform="translate(100 100)">
          <circle className="sphere-glow" r="76" fill="url(#sb-glow)" />

          <g className="sphere-ring-spin">
            <circle className="sphere-ring-outer" r="58" />
            <circle className="sphere-ring-inner" r="42" />
            {ticks}
          </g>

          <g className="sphere-glyphs">{glyphs}</g>

          <g className="sphere-core">
            <circle className="sphere-body" r="28" fill="url(#sb-sphere)" />
            <ellipse className="sphere-hl" cx="-8" cy="-8" rx="8" ry="5" fill="rgba(255, 255, 255, 0.6)" />
          </g>

          <g className="sphere-orbit">
            <circle className="sphere-dot" cy="-34" r="2.2" />
            <circle className="sphere-dot sphere-dot--2" cy="-34" r="1.5" />
          </g>
        </g>
      </svg>
    </div>
  );
};

export default SphereBloom;
