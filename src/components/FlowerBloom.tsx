import React from "react";

/**
 * Idle decoration for the right column: a red spider lily (the Tokyo Ghoul
 * flower) that keeps growing and blooming on an infinite CSS loop while the IDE
 * runs. Pure SVG + CSS animation — no JS timers, no React re-renders.
 */

const PETALS = 6;
const STAMENS = 6;

// Narrow, recurving petal drawn pointing "up" from the flower center (0,0).
const PETAL_PATH =
  "M0 0 C -9 -16 -14 -36 -7 -54 C -4 -60 0 -62 0 -62 C 0 -62 4 -60 7 -54 C 14 -36 9 -16 0 0 Z";

// Thin curved stamen with an anther at the tip.
const STAMEN_PATH = "M0 0 C -2 -22 -7 -44 -4 -64 C -3 -72 0 -76 0 -76";

// Floating pollen seeds (viewBox coordinates), staggered into the sky.
const POLLEN = [
  { x: 72, y: 124, delay: 0.3, dur: 6.0, r: 1.8 },
  { x: 130, y: 120, delay: 1.2, dur: 7.0, r: 1.5 },
  { x: 88, y: 132, delay: 2.4, dur: 6.4, r: 2.2 },
  { x: 118, y: 128, delay: 3.5, dur: 5.8, r: 1.6 },
  { x: 100, y: 126, delay: 4.3, dur: 7.2, r: 1.9 },
  { x: 78, y: 114, delay: 5.1, dur: 6.3, r: 1.4 },
];

const FlowerBloom: React.FC = () => (
  <div className="flower-bloom" aria-hidden>
    <svg className="flower-svg" viewBox="0 0 200 200">
      <defs>
        <radialGradient id="fb-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(226, 62, 92, 0.34)" />
          <stop offset="60%" stopColor="rgba(226, 62, 92, 0.10)" />
          <stop offset="100%" stopColor="rgba(226, 62, 92, 0)" />
        </radialGradient>
        <linearGradient id="fb-petal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e85072" />
          <stop offset="55%" stopColor="#b02440" />
          <stop offset="100%" stopColor="#75131f" />
        </linearGradient>
        <linearGradient id="fb-stem" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a2c30" />
          <stop offset="100%" stopColor="#1f1416" />
        </linearGradient>
      </defs>

      <circle className="flower-glow" cx="100" cy="112" r="74" fill="url(#fb-glow)" />

      {/* Stem and leaf */}
      <path
        d="M100 112 C 97 140 103 168 100 200"
        fill="none"
        stroke="url(#fb-stem)"
        strokeWidth="3"
        strokeLinecap="round"
        className="flower-stem"
      />
      <path
        d="M100 152 C 88 150 79 143 75 134 C 88 139 96 144 100 152 Z"
        fill="#2b1c20"
        className="flower-leaf"
      />

      <g transform="translate(100 112)">
        {/* Petals */}
        {Array.from({ length: PETALS }).map((_, i) => (
          <g key={i} transform={`rotate(${(360 / PETALS) * i})`}>
            <path
              d={PETAL_PATH}
              fill="url(#fb-petal)"
              className="flower-petal"
              style={{ animationDelay: `${i * 0.16}s` }}
            />
          </g>
        ))}

        {/* Stamens */}
        {Array.from({ length: STAMENS }).map((_, i) => (
          <g key={`s${i}`} transform={`rotate(${(360 / STAMENS) * i + 30})`}>
            <g className="flower-stamen" style={{ animationDelay: `${i * 0.16}s` }}>
              <path d={STAMEN_PATH} fill="none" stroke="#f3c0cb" strokeWidth="1.4" strokeLinecap="round" />
              <circle cx="0" cy="-76" r="2.4" fill="#ffd7a1" className="flower-anther" />
            </g>
          </g>
        ))}

        <circle className="flower-center" cx="0" cy="0" r="6.5" fill="#5c0f1f" />
        <circle className="flower-center-dot" cx="0" cy="0" r="2.4" fill="#ffd7a1" />
      </g>

      {/* Floating pollen */}
      <g className="flower-pollen">
        {POLLEN.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={p.r}
            className="flower-pollen-dot"
            style={{ animationDelay: `${p.delay}s`, animationDuration: `${p.dur}s` }}
          />
        ))}
      </g>
    </svg>
  </div>
);

export default FlowerBloom;
