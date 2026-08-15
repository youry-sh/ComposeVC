import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Media dock at the bottom of the right column.
 *
 * Paste a link — a film page, a YouTube video, anything on http(s) — and the
 * site opens right here in an Electron <webview>. When the site's own player
 * goes fullscreen the dock lifts out of the column and covers the whole window,
 * so the video is never squeezed into a 260px strip.
 *
 * Folding the dock only HIDES it: the guest page stays alive, so sound keeps
 * playing while the panel is collapsed.
 */

const URL_KEY = "composevc-aside-browser-url";
const HEIGHT_KEY = "composevc-aside-browser-height";
const OPEN_KEY = "composevc-aside-browser-open";

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 780;
const DEFAULT_HEIGHT = 240;

/** Electron's <webview> — only the members this dock actually drives. */
type WebviewElement = HTMLElement & {
  src: string;
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  stop: () => void;
  executeJavaScript: (code: string) => Promise<unknown>;
};

/** True inside the desktop shell — the web preview has no <webview> tag. */
const isDesktop = typeof window !== "undefined" && Boolean((window as { lopster?: unknown }).lopster);

/**
 * Plain Chrome UA. The stock Electron string carries `Electron/…` and the app
 * name, which some video hosts read as "unsupported browser".
 */
function chromeUserAgent(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return ua.replace(/\s?(Electron|ComposeVC)\/[^\s]+/gi, "").replace(/\s{2,}/g, " ").trim();
}

/** Address bar input → a URL. Anything that is not a host becomes a search. */
export function normalizeUrl(raw: string): string | null {
  const input = String(raw || "").trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^\/\//.test(input)) return `https:${input}`;
  // A bare host ("youtu.be/abc", "kinozal.tv") — no spaces and a real dot.
  if (!/\s/.test(input) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(input)) {
    return `https://${input}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function readHeight(): number {
  try {
    const saved = Number(window.localStorage.getItem(HEIGHT_KEY));
    if (!Number.isFinite(saved) || saved <= 0) return DEFAULT_HEIGHT;
    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, saved));
  } catch {
    return DEFAULT_HEIGHT;
  }
}

const AsideBrowser: React.FC = () => {
  const viewRef = useRef<WebviewElement | null>(null);
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [height, setHeight] = useState<number>(readHeight);
  const heightRef = useRef(height);
  heightRef.current = height;
  /** Address bar text — free to differ from `url` while being typed. */
  const [draft, setDraft] = useState("");
  /** The page actually loaded; null until the first link is opened. */
  const [url, setUrl] = useState<string | null>(null);
  /**
   * `src` of the guest — set only when it is (re)mounted. Later links go
   * through loadURL, so the element keeps its session instead of reloading
   * twice (once from the attribute, once from the call).
   */
  const [mountUrl, setMountUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Covers the whole window — either the site's player or the ⤢ button. */
  const [expanded, setExpanded] = useState(false);
  /** While dragging the grip the guest must not swallow the mouse events. */
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(URL_KEY);
      if (saved) setDraft(saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [open]);

  const go = useCallback((raw: string) => {
    const next = normalizeUrl(raw);
    if (!next) return;
    setError(null);
    setDraft(next);
    setUrl(next);
    setOpen(true);
    try {
      window.localStorage.setItem(URL_KEY, next);
    } catch {
      /* ignore */
    }
    // The guest is already mounted — navigate it instead of remounting.
    const view = viewRef.current;
    if (view && typeof view.loadURL === "function") {
      void view.loadURL(next).catch(() => undefined);
      return;
    }
    setMountUrl(next);
  }, []);

  // Wire the guest's lifecycle to the toolbar. Re-runs once the view mounts.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !url) return;
    const onStart = () => {
      setLoading(true);
      setError(null);
    };
    const onStop = () => setLoading(false);
    const onNavigate = (event: Event) => {
      const next = (event as Event & { url?: string }).url;
      if (typeof next === "string" && next) setDraft(next);
    };
    const onTitle = (event: Event) => {
      const next = (event as Event & { title?: string }).title;
      if (typeof next === "string") setTitle(next);
    };
    const onFail = (event: Event) => {
      const detail = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        isMainFrame?: boolean;
      };
      // -3 is ABORTED — a redirect or a cancelled load, not a real failure.
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      setLoading(false);
      setError(detail.errorDescription || `Load failed (${detail.errorCode ?? "?"})`);
    };
    const onEnterFull = () => setExpanded(true);
    const onLeaveFull = () => setExpanded(false);

    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitle);
    view.addEventListener("did-fail-load", onFail);
    view.addEventListener("enter-html-full-screen", onEnterFull);
    view.addEventListener("leave-html-full-screen", onLeaveFull);
    return () => {
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitle);
      view.removeEventListener("did-fail-load", onFail);
      view.removeEventListener("enter-html-full-screen", onEnterFull);
      view.removeEventListener("leave-html-full-screen", onLeaveFull);
    };
  }, [url]);

  const collapseFullscreen = useCallback(() => {
    setExpanded(false);
    try {
      void viewRef.current
        ?.executeJavaScript?.("document.exitFullscreen && document.exitFullscreen()")
        ?.catch(() => undefined);
    } catch {
      /* ignore */
    }
  }, []);

  // Esc leaves the covering layer — including the one the site's player opened.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapseFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, collapseFullscreen]);

  // Drag the top edge to resize the dock; the column above shrinks with it.
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = heightRef.current;
    const onMove = (move: MouseEvent) => {
      // The dock grows upward: dragging up (negative delta) makes it taller.
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight - (move.clientY - startY)));
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing-ns");
      setResizing(false);
      try {
        window.localStorage.setItem(HEIGHT_KEY, String(heightRef.current));
      } catch {
        /* ignore */
      }
    };
    document.body.classList.add("is-resizing-ns");
    setResizing(true);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    go(draft);
  };

  return (
    <section
      className={`aside-web${open ? " is-open" : ""}${expanded ? " is-expanded" : ""}${
        resizing ? " is-resizing" : ""
      }`}
      style={open && !expanded ? { height } : undefined}
      aria-label="Web"
    >
      {open && !expanded && (
        <div
          className="aside-web-grip"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="horizontal"
        />
      )}

      <header className="aside-web-head">
        <button
          type="button"
          className="aside-web-toggle"
          onClick={() => setOpen((prev) => !prev)}
          title={open ? "Collapse" : "Expand"}
        >
          <span className="aside-web-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span className="aside-title">Web</span>
        </button>
        <span className="aside-web-name" title={title || url || ""}>
          {title || (url ? hostOf(url) : "")}
        </span>
        {url && (
          <div className="aside-web-acts">
            <button
              type="button"
              className="aside-web-btn"
              onClick={() => (expanded ? collapseFullscreen() : setExpanded(true))}
              title={expanded ? "Back to the panel (Esc)" : "Fill the window"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
            <button
              type="button"
              className="aside-web-btn"
              onClick={() => void window.lopster?.openExternal?.(url)}
              title="Open in the system browser"
            >
              ↗
            </button>
            <button
              type="button"
              className="aside-web-btn"
              onClick={() => {
                setUrl(null);
                setTitle("");
                setError(null);
                setLoading(false);
                setExpanded(false);
              }}
              title="Close the page"
            >
              ✕
            </button>
          </div>
        )}
      </header>

      <form className="aside-web-bar" onSubmit={submit}>
        <button
          type="button"
          className="aside-web-btn"
          onClick={() => {
            const view = viewRef.current;
            if (view?.canGoBack?.()) view.goBack();
          }}
          title="Back"
          disabled={!url}
        >
          ‹
        </button>
        <button
          type="button"
          className="aside-web-btn"
          onClick={() => {
            const view = viewRef.current;
            if (view?.canGoForward?.()) view.goForward();
          }}
          title="Forward"
          disabled={!url}
        >
          ›
        </button>
        <button
          type="button"
          className="aside-web-btn"
          onClick={() => {
            const view = viewRef.current;
            if (loading) view?.stop?.();
            else view?.reload?.();
          }}
          title={loading ? "Stop" : "Reload"}
          disabled={!url}
        >
          {loading ? "×" : "⟳"}
        </button>
        <input
          className="aside-web-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Link or search — film, YouTube…"
          spellCheck={false}
          aria-label="Address"
        />
        <button type="submit" className="aside-web-go" title="Open">
          →
        </button>
      </form>

      <div className="aside-web-stage">
        {url ? (
          isDesktop ? (
            <webview
              ref={viewRef}
              className="aside-web-view"
              src={url}
              partition="persist:composevc-web"
              useragent={chromeUserAgent()}
            />
          ) : (
            <iframe
              className="aside-web-view"
              src={url}
              title="Web"
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          )
        ) : (
          <div className="aside-web-empty">
            <p>Paste a link — the site opens right here.</p>
            <div className="aside-web-chips">
              <button type="button" onClick={() => go("https://www.youtube.com")}>
                YouTube
              </button>
              <button type="button" onClick={() => go("https://rezka.ag")}>
                Rezka
              </button>
              <button type="button" onClick={() => go("https://www.twitch.tv")}>
                Twitch
              </button>
            </div>
          </div>
        )}
        {error && <div className="aside-web-error">{error}</div>}
      </div>
    </section>
  );
};

export default AsideBrowser;
