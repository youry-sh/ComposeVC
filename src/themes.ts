/**
 * App theme system — full UI chrome (surfaces, text, borders, buttons,
 * toggles, modals, status, thinking indicator, terminal).
 *
 * Tokens live on <html data-theme="…"> as CSS custom properties.
 * Tailwind `ink-*` / `status-*` / `accent` map to those variables.
 */

export type ThemeId = "mono" | "winter" | "graphite";

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
    description: "Холодный графит — нейтральные серые тона, тихий стальной акцент, без синевы и бликов.",
    type: "dark",
    swatches: ["#090a0b", "#14181b", "#8fabb9", "#cdd6db"],
  },
  {
    id: "graphite",
    name: "Чёрный",
    description: "Тёплая чёрная база с оранжевым подтоном и акцентом #f0442e — оранжевые хайрлайны в шапке, разделителях панелей и вокруг поля ввода.",
    type: "dark",
    swatches: ["#070504", "#2a211d", "#f0442e", "#eae0d9"],
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
    // Unknown or removed theme ids fall back to the default theme.
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
