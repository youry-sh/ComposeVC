/**
 * Single application theme.
 *
 * The app ships one chrome ("Mono"): neutral black/grey tokens only, no
 * switcher and no palette list. Tokens live on <html data-theme="mono"> as CSS
 * custom properties; Tailwind `ink-*` / `status-*` / `accent` map to them.
 */

export type ThemeId = "mono";

export const THEME_STORAGE_KEY = "lopster-theme";
export const THEME_CHANGE_EVENT = "lopster-theme-change";

export const DEFAULT_THEME: ThemeId = "mono";

/** Pin the single theme and purge any palette selected by an older build. */
export function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", DEFAULT_THEME);
  document.documentElement.style.colorScheme = "dark";
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { theme: DEFAULT_THEME } }));
}

export function initTheme(): ThemeId {
  applyTheme();
  return DEFAULT_THEME;
}
