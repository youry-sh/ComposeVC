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
