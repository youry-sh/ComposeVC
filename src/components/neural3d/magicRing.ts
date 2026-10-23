/**
 * Anime "magic circle" spell-ring texture: gold Japanese glyphs arranged in a
 * ring plus concentric ornament lines, drawn once onto a canvas and reused as
 * a billboarded ring around the orbiting gold sphere.
 */

import * as THREE from "three";

/** Meaningful kanji read in a ring — knowledge / memory / spirit themed. */
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

const SIZE = 1024;
const GOLD = "#ffd88a";
const GOLD_DEEP = "#f2b34d";

export function buildMagicCircleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable for spell ring");

  const c = SIZE / 2;
  ctx.clearRect(0, 0, SIZE, SIZE);

  // The ring geometry maps inner..outer world radii onto texture radius
  // 0..SIZE/2, so draw the band in the middle of that range.
  const outerPx = SIZE / 2 - 10;
  const innerPx = outerPx * 0.44;
  const midPx = (innerPx + outerPx) / 2;

  const glow = (blur: number, color: string) => {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  };

  // Concentric ornament rings.
  glow(8, GOLD_DEEP);
  for (const [r, width, alpha] of [
    [innerPx - 26, 2, 0.5],
    [innerPx, 3, 0.85],
    [midPx + 8, 1.5, 0.4],
    [outerPx, 4, 0.9],
  ] as Array<[number, number, number]>) {
    ctx.strokeStyle = `rgba(255, 216, 138, ${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Radial tick marks for a "sealed circle" feel.
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255, 216, 138, 0.55)";
  const ticks = 60;
  for (let i = 0; i < ticks; i += 1) {
    const a = (Math.PI * 2 * i) / ticks;
    const r0 = innerPx - 12;
    const r1 = i % 5 === 0 ? innerPx - 26 : innerPx - 18;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
    ctx.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
    ctx.stroke();
  }

  // Gold glyphs around the ring, kept upright for readability.
  glow(16, GOLD);
  ctx.fillStyle = "rgba(255, 224, 160, 0.98)";
  ctx.font = "bold 52px 'Noto Sans JP', 'Yu Gothic', 'Meiryo', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const n = GLYPHS.length;
  for (let i = 0; i < n; i += 1) {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    ctx.fillText(GLYPHS[i], c + Math.cos(a) * midPx, c + Math.sin(a) * midPx);
  }

  // Soft central bloom so the sphere reads as the spell's focus.
  glow(60, GOLD);
  const grad = ctx.createRadialGradient(c, c, 0, c, c, innerPx * 0.6);
  grad.addColorStop(0, "rgba(255, 220, 150, 0.16)");
  grad.addColorStop(1, "rgba(255, 220, 150, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(c, c, innerPx * 0.6, 0, Math.PI * 2);
  ctx.fill();
  glow(0, GOLD);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
