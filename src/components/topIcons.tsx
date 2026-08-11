import React from "react";

/**
 * Unique IDE-style glyphs for the top bar (16×16, stroke-based).
 * Hand-drawn to match a technical/editor aesthetic — not stock lucide.
 */

type IconProps = { className?: string };

const base = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** MultiIDE — 2×2 editor panes, one focused */
export const IcoMulti: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
    <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" fillOpacity="0.35" strokeOpacity="0.6" />
    <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
    <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
  </svg>
);

/** Proxy — routed nodes with a link */
export const IcoProxy: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <circle cx="3.5" cy="12.5" r="2" />
    <circle cx="12.5" cy="3.5" r="2" />
    <path d="M5.2 10.8 L8 8 M8 8 L10.8 5.2" />
    <circle cx="8" cy="8" r="1.1" />
  </svg>
);

/** Runner — play inside a terminal window */
export const IcoRunner: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    <path d="M5.6 6 L8.6 8 L5.6 10 Z" fill="currentColor" stroke="none" />
    <path d="M10.4 6.6 h2.4 M10.4 9.4 h2.4" />
  </svg>
);

/** Custom Tools — terminal prompt `>_` */
export const IcoTools: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
    <path d="M4.6 6.4 L6.4 8 L4.6 9.6" />
    <path d="M8.4 9.6 h3" />
  </svg>
);

/** Settings — sliders */
export const IcoSettings: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <path d="M2.5 4.5 h3.2 M10.3 4.5 h3.2 M2.5 11.5 h3.2 M10.3 11.5 h3.2" />
    <circle cx="8.7" cy="4.5" r="1.6" />
    <circle cx="5.7" cy="11.5" r="1.6" />
  </svg>
);

/** Providers — CPU chip */
export const IcoProviders: React.FC<IconProps> = ({ className }) => (
  <svg {...base} className={className}>
    <rect x="5" y="5" width="6" height="6" rx="1" />
    <path d="M8 3.4 V2 M8 14 v-1.4 M3.4 8 H2 M14 8 h-1.4" />
    <rect x="6.9" y="6.9" width="2.2" height="2.2" />
  </svg>
);
