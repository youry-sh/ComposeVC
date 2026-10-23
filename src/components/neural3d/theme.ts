/**
 * Theme bridge for the WebGL scene.
 *
 * Reads the app's CSS design tokens (single source of truth) so the neural
 * background, fog and starfield stay in sync with theme switches. The white
 * cube and gold sphere are intentional content colours specified by the
 * product brief (anime-magic setpiece) and therefore stay fixed across the
 * two dark themes.
 */

export interface NeuralThemeColors {
  bg: string;
  surface: string;
  accent: string;
}

export function readThemeColors(): NeuralThemeColors {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    bg: get("--bg", "#070707"),
    surface: get("--surface", "#0b0b0b"),
    accent: get("--accent", "#e8e8e8"),
  };
}

/** Parse #rgb / #rrggbb into 0..1 rgb (throws is handled by callers via try). */
export function hexToRgb01(hex: string): [number, number, number] {
  let value = hex.trim().replace(/^#/, "");
  if (value.length === 3) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(value.slice(0, 6), 16);
  if (Number.isNaN(int)) return [1, 1, 1];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** Prefers-reduced-motion, read live (matches CSS media query semantics). */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
