/** Pure, React-free helpers for the Web Engine toolbar tools. */

export const DEVICE_WIDTHS = [375, 768] as const;

/** Cycle the device preset: desktop (null) → mobile → tablet → desktop. */
export function nextDeviceWidth(current: number | null): number | null {
  if (current === null) return DEVICE_WIDTHS[0];
  const idx = DEVICE_WIDTHS.indexOf(current);
  if (idx < 0 || idx >= DEVICE_WIDTHS.length - 1) return null;
  return DEVICE_WIDTHS[idx + 1];
}

/** Clamp a page zoom factor to 25%–400%; invalid values fall back to 100%. */
export function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(4, Math.max(0.25, factor));
}
