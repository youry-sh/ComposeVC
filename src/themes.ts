/**
 * App theme system — full UI chrome (surfaces, text, borders, buttons,
 * toggles, modals, status, thinking indicator, terminal).
 *
 * Tokens live on <html data-theme="…"> as CSS custom properties.
 * Tailwind `ink-*` / `status-*` / `accent` map to those variables.
 */

export type ThemeId = "mono" | "winter";

export type ThemeMeta = {
  id: ThemeId;
  name: string;
  description: string;
  type: "dark" | "light";
  /** Preview swatches in settings */
  swatches: [string, string, string, string];
};

export const THEME_STORAGE_KEY = "lopster-theme";
export const THEME_CHANGE_EVENT = "lopster-theme-change";

export const THEMES: ThemeMeta[] = [
  {
    id: "mono",
    name: "Mono",
    description: "Pure black enterprise chrome — neutral greys, no accent colour.",
    type: "dark",
    swatches: ["#070707", "#141414", "#3a3a3a", "#e8e8e8"],
  },
  {
    id: "winter",
    name: "Зима",
    description: "Морозная арктическая ночь — лёд, снег и голубой иней.",
    type: "dark",
    swatches: ["#060b12", "#0e1620", "#8fd3ff", "#e6eef5"],
  },
];

export const DEFAULT_THEME: ThemeId = "mono";

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value);
}

export function getStoredTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    // Migrate any removed or unknown theme (crimson/cobalt/violet) → default
    if (isThemeId(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
  const theme = isThemeId(id) ? id : DEFAULT_THEME;
  const meta = THEMES.find((t) => t.id === theme);
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.style.colorScheme = meta?.type === "light" ? "light" : "dark";
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme } }));
}

export function initTheme(): ThemeId {
  const theme = getStoredTheme();
  applyTheme(theme);
  return theme;
}
