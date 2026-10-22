import React, { useCallback, useEffect, useRef, useState } from "react";
import { normalizeUrl } from "../utils/webEngineUrl";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Copy,
  Crosshair,
  TerminalSquare,
  ExternalLink,
  Check,
  Trash2,
  Search,
  Bug,
} from "lucide-react";

/**
 * Web Engine — a full workspace tab for opening and testing a localhost (or any
 * http/s) site inside ComposeVC, with an address bar, a real Electron <webview>
 * preview, a built-in F12 (DevTools), an element inspector (hover highlight +
 * click-to-inspect) and a console with one-click copy.
 *
 * The URL is bound per-chat: `chatKey` (the session id, or the project folder as
 * a fallback) is the identity, so two chats never share one another's site.
 */

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
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
  openDevTools: () => void;
  closeDevTools: () => void;
  isDevToolsOpened: () => boolean;
};

type LogLevel = "verbose" | "info" | "warning" | "error";
type LogEntry = { id: string; level: LogLevel; text: string; source: string; ts: number };

type ElementInfo = { sel: string; tag: string; id: string; cls: string; html: string; text: string };

interface WebEngineWorkspaceProps {
  /** Stable per-chat key (session id or project-folder fallback). */
  chatKey: string;
  /** Secondary key used while a chat has no session id yet (`folder:<path>`). */
  fallbackChatKey: string;
  rootPath: string | null;
  projectName: string;
}

/** True inside the desktop shell — the web preview has no <webview> tag in plain `vite`. */
const isDesktop = typeof window !== "undefined" && Boolean((window as { lopster?: unknown }).lopster);

const MAX_LOGS = 500;

const LEVEL_LABEL: Record<LogLevel, string> = {
  verbose: "VERB",
  info: "INFO",
  warning: "WARN",
  error: "ERRO",
};

/**
 * Address bar input → a URL. The engine is for local projects first, so
 * localhost / 127.0.0.1 / any host-with-port defaults to http://; a bare host
 * without a port (a public site) defaults to https://. Anything else is rejected
 * at this boundary so the rest of the workspace only ever sees a valid URL.
 * (Logic lives in src/utils/webEngineUrl.ts so it is unit-testable.)
 */

/** Clipboard write via main-process clipboard, with a DOM fallback for `vite`. */
async function copyText(text: string): Promise<boolean> {
  if (window.lopster?.webEngineCopyText) {
    try {
      const res = await window.lopster.webEngineCopyText(text);
      return res?.ok === true;
    } catch {
      /* fall through to DOM clipboard */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ── Inspector scripts run inside the guest page. Cross-origin DOM is otherwise
   unreachable from the embedder, so the only honest channel is executeJavaScript
   + console-message markers. Shadow-root internals stay out of reach — expected. */

const INSPECTOR_INSTALL = `(function () {
  if (window.__cvcInspectorInstalled) return;
  window.__cvcInspectorInstalled = true;
  var ACCENT = "#4f8cff";
  function describe(el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = el.tagName.toLowerCase();
    var id = el.id ? "#" + el.id : "";
    var cls = "";
    if (el.classList && el.classList.length) cls = "." + Array.prototype.slice.call(el.classList, 0, 2).join(".");
    var html = el.outerHTML || "";
    if (html.length > 500) html = html.slice(0, 500) + "…";
    var text = (el.textContent || "").trim().replace(/\\s+/g, " ");
    if (text.length > 200) text = text.slice(0, 200) + "…";
    return { sel: tag + id + cls, tag: tag, id: el.id || "", cls: cls.slice(1), html: html, text: text };
  }
  window.__cvcLast = null;
  document.addEventListener("mouseover", function (e) {
    if (!window.__cvcInspector) return;
    var el = e.target;
    if (el === window.__cvcLast) return;
    if (window.__cvcLast && window.__cvcLast.__cvcPrev !== undefined) {
      window.__cvcLast.style.outline = window.__cvcLast.__cvcPrev;
      window.__cvcLast.__cvcPrev = undefined;
    }
    window.__cvcLast = el;
    if (el && el.nodeType === 1) {
      el.__cvcPrev = el.style.outline;
      el.style.outline = "2px solid " + ACCENT;
      el.style.outlineOffset = "-1px";
      var info = describe(el);
      if (info) console.log("__CVC_IH__" + JSON.stringify(info));
    }
  }, true);
  document.addEventListener("click", function (e) {
    if (!window.__cvcInspector) return;
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    e.preventDefault(); e.stopPropagation();
    var info = describe(el);
    if (info) console.log("__CVC_IC__" + JSON.stringify(info));
  }, true);
})(); void 0;`;

const INSPECTOR_ON = `(function () { window.__cvcInspector = true; })(); void 0;`;
const INSPECTOR_OFF = `(function () {
  window.__cvcInspector = false;
  if (window.__cvcLast) {
    if (window.__cvcLast.__cvcPrev !== undefined) window.__cvcLast.style.outline = window.__cvcLast.__cvcPrev;
    window.__cvcLast = null;
  }
})(); void 0;`;

function chromeUserAgent(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return ua.replace(/\s?(Electron|ComposeVC)\/[^\s]+/gi, "").replace(/\s{2,}/g, " ").trim();
}

/** Short, plain-language reason for the common Chromium load error codes. */
function describeLoadError(code?: number, desc?: string): string {
  switch (code) {
    case -102:
      return "соединение отклонено — сервер не запущен или порт неверный";
    case -105:
      return "не удалось разрешить адрес";
    case -106:
      return "нет подключения к интернету";
    case -109:
      return "адрес недоступен";
    case -118:
      return "таймаут соединения";
    default:
      return desc || `ошибка загрузки (${code ?? "?"})`;
  }
}

const WebEngineWorkspace: React.FC<WebEngineWorkspaceProps> = ({
  chatKey,
  fallbackChatKey,
  rootPath,
  projectName,
}) => {
  const viewRef = useRef<WebviewElement | null>(null);
  const [draft, setDraft] = useState("");
  /** The page actually loaded; null until the first URL is opened. */
  const [url, setUrl] = useState<string | null>(null);
  /** `src` of the guest — set only when it is (re)mounted. */
  const [mountUrl, setMountUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [inspectorOn, setInspectorOn] = useState(false);
  const [selectedEl, setSelectedEl] = useState<ElementInfo | null>(null);
  const [hoverEl, setHoverEl] = useState<ElementInfo | null>(null);
  const [selectedLogIds, setSelectedLogIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);

  const seqRef = useRef(0);
  const inspectorOnRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const cancelledRef = useRef(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1600);
  }, []);

  const appendLog = useCallback((level: LogLevel, text: string, source: string) => {
    seqRef.current += 1;
    const id = `log-${seqRef.current}`;
    setLogs((prev) => {
      const next = prev.length >= MAX_LOGS ? prev.slice(prev.length - (MAX_LOGS - 1)) : prev;
      return [...next, { id, level, text, source, ts: Date.now() }];
    });
  }, []);

  const runInGuest = useCallback((code: string) => {
    const view = viewRef.current;
    if (view && typeof view.executeJavaScript === "function") {
      void view.executeJavaScript(code).catch(() => undefined);
    }
  }, []);

  // Load the bound URL (saved binding → localhost probe) whenever the chat changes.
  useEffect(() => {
    let cancelled = false;
    cancelledRef.current = false;
    setError(null);
    setLogs([]);
    setSelectedLogIds(new Set());
    setSelectedEl(null);
    setHoverEl(null);
    setUrl(null);
    setDraft("");
    setMountUrl(null);
    setTitle("");
    setLoading(false);
    setProbing(false);
    setDevtoolsOpen(false);
    inspectorOnRef.current = false;
    setInspectorOn(false);

    const persist = (u: string) => {
      void window.lopster?.webEngineSetBinding(chatKey, u).catch(() => undefined);
      if (fallbackChatKey && fallbackChatKey !== chatKey) {
        void window.lopster?.webEngineSetBinding(fallbackChatKey, u).catch(() => undefined);
      }
    };

    (async () => {
      let targetUrl: string | null = null;
      let source: "primary" | "fallback" | "probe" = "primary";
      try {
        const binding = await window.lopster?.webEngineGetBinding(chatKey);
        if (!cancelled && binding && typeof binding.url === "string") targetUrl = binding.url;
      } catch {
        /* binding read is best-effort */
      }
      // A draft chat binds under `folder:`; once it has a session id the key is
      // `session:`. Try the folder key as a fallback so the URL is not lost.
      if (!cancelled && !targetUrl && fallbackChatKey && fallbackChatKey !== chatKey) {
        try {
          const binding = await window.lopster?.webEngineGetBinding(fallbackChatKey);
          if (!cancelled && binding && typeof binding.url === "string") {
            targetUrl = binding.url;
            source = "fallback";
          }
        } catch {
          /* binding read is best-effort */
        }
      }
      if (!cancelled && !targetUrl) {
        setProbing(true);
        try {
          const res = await window.lopster?.webEngineProbeLocalhost(rootPath);
          if (!cancelled && res?.ok && typeof res.url === "string") {
            targetUrl = res.url;
            source = "probe";
          }
        } catch {
          /* probe is best-effort */
        }
        if (!cancelled) setProbing(false);
      }
      if (cancelled) return;
      if (targetUrl) {
        setDraft(targetUrl);
        setUrl(targetUrl);
        setMountUrl(targetUrl);
        // Remember the auto-found / migrated URL so the chat reopens the same site.
        if (source !== "primary") persist(targetUrl);
      } else {
        setMountUrl(null);
        setUrl(null);
        setDraft("");
      }
    })();

    return () => {
      cancelled = true;
      cancelledRef.current = true;
    };
  }, [chatKey, fallbackChatKey, rootPath]);

  const go = useCallback(
    (raw: string) => {
      const next = normalizeUrl(raw);
      if (!next) {
        showToast("Введите корректный http(s) адрес");
        return;
      }
      setError(null);
      setDraft(next);
      setUrl(next);
      setSelectedEl(null);
      setHoverEl(null);
      void window.lopster?.webEngineSetBinding(chatKey, next).catch(() => undefined);
      if (fallbackChatKey && fallbackChatKey !== chatKey) {
        void window.lopster?.webEngineSetBinding(fallbackChatKey, next).catch(() => undefined);
      }
      const view = viewRef.current;
      if (view && typeof view.loadURL === "function") {
        void view.loadURL(next).catch(() => undefined);
      } else {
        setMountUrl(next);
      }
    },
    [chatKey, fallbackChatKey, showToast]
  );

  const copyUrl = useCallback(async () => {
    const current = url || draft;
    if (!current) {
      showToast("Сначала откройте сайт");
      return;
    }
    const ok = await copyText(current);
    showToast(ok ? "Скопировано" : "Не удалось скопировать");
  }, [url, draft, showToast]);

  const copyLogs = useCallback(async () => {
    if (!logs.length) {
      showToast("Консоль пуста");
      return;
    }
    const selected = logs.filter((l) => selectedLogIds.has(l.id));
    const toCopy = selected.length ? selected : logs;
    const text = toCopy
      .map((l) => `[${l.level.toUpperCase()}]${l.source ? ` ${l.source}` : ""} ${l.text}`)
      .join("\n");
    const ok = await copyText(text);
    showToast(ok ? "Логи скопированы" : "Не удалось скопировать");
  }, [logs, selectedLogIds, showToast]);

  const toggleLog = useCallback((id: string) => {
    setSelectedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearLogs = useCallback(() => {
    setLogs([]);
    setSelectedLogIds(new Set());
  }, []);

  const toggleInspector = useCallback(() => {
    const next = !inspectorOnRef.current;
    inspectorOnRef.current = next;
    setInspectorOn(next);
    if (next) {
      runInGuest(INSPECTOR_INSTALL);
      runInGuest(INSPECTOR_ON);
    } else {
      setSelectedEl(null);
      setHoverEl(null);
      runInGuest(INSPECTOR_OFF);
    }
  }, [runInGuest]);

  const toggleDevTools = useCallback(() => {
    const view = viewRef.current;
    if (!view || typeof view.openDevTools !== "function") return;
    try {
      if (devtoolsOpen) view.closeDevTools();
      else view.openDevTools();
      setDevtoolsOpen((prev) => !prev);
    } catch {
      /* devtools not available */
    }
  }, [devtoolsOpen]);

  const openExternal = useCallback(() => {
    const current = url || draft;
    if (!current) return;
    void window.lopster?.openExternal?.(current);
  }, [url, draft]);

  // Wire the guest's lifecycle to the toolbar + console + inspector.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !mountUrl) return;
    const onStart = () => {
      setLoading(true);
      setError(null);
    };
    const onStop = () => setLoading(false);
    const onNavigate = (event: Event) => {
      const next = (event as Event & { url?: string }).url;
      if (typeof next === "string" && next && !next.startsWith("devtools://")) {
        setDraft(next);
        setUrl(next);
      }
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
        validatedURL?: string;
      };
      // -3 is ABORTED — a redirect or a cancelled load, not a real failure.
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      setLoading(false);
      const reason = describeLoadError(detail.errorCode, detail.errorDescription);
      const failedUrl = detail.validatedURL || url || "";
      setError(failedUrl ? `Не удалось открыть ${failedUrl} — ${reason}` : `Не удалось открыть страницу — ${reason}`);
      appendLog("error", `Failed to load ${failedUrl}: ${detail.errorDescription || String(detail.errorCode ?? "?")}`, "navigation");
    };
    const onConsole = (event: Event) => {
      const detail = event as Event & {
        level?: number;
        message?: string;
        line?: number;
        sourceId?: string;
      };
      const message = typeof detail.message === "string" ? detail.message : "";
      if (!message) return;
      if (message.startsWith("__CVC_IH__")) {
        try {
          setHoverEl(JSON.parse(message.slice("__CVC_IH__".length)) as ElementInfo);
        } catch {
          /* ignore malformed marker */
        }
        return;
      }
      if (message.startsWith("__CVC_IC__")) {
        try {
          const info = JSON.parse(message.slice("__CVC_IC__".length)) as ElementInfo;
          if (info.sel && info.sel !== "inspector-ready") {
            setSelectedEl(info);
            setHoverEl(null);
          }
        } catch {
          /* ignore malformed marker */
        }
        return;
      }
      const levelMap: Record<string, LogLevel> = {
        "0": "verbose", "1": "info", "2": "warning", "3": "error",
        verbose: "verbose", info: "info", warning: "warning", error: "error",
      };
      const level = levelMap[String(detail.level ?? 1)] ?? "info";
      appendLog(level, message, typeof detail.sourceId === "string" ? detail.sourceId : "");
    };
    const onFinish = () => {
      setLoading(false);
      if (inspectorOnRef.current) {
        runInGuest(INSPECTOR_INSTALL);
        runInGuest(INSPECTOR_ON);
      }
    };
    const onDomReady = () => {
      if (inspectorOnRef.current) {
        runInGuest(INSPECTOR_INSTALL);
        runInGuest(INSPECTOR_ON);
      }
    };

    view.addEventListener("did-start-loading", onStart);
    view.addEventListener("did-stop-loading", onStop);
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("page-title-updated", onTitle);
    view.addEventListener("did-fail-load", onFail);
    view.addEventListener("console-message", onConsole);
    view.addEventListener("did-finish-load", onFinish);
    view.addEventListener("dom-ready", onDomReady);
    return () => {
      view.removeEventListener("did-start-loading", onStart);
      view.removeEventListener("did-stop-loading", onStop);
      view.removeEventListener("did-navigate", onNavigate);
      view.removeEventListener("did-navigate-in-page", onNavigate);
      view.removeEventListener("page-title-updated", onTitle);
      view.removeEventListener("did-fail-load", onFail);
      view.removeEventListener("console-message", onConsole);
      view.removeEventListener("did-finish-load", onFinish);
      view.removeEventListener("dom-ready", onDomReady);
    };
  }, [mountUrl, url, appendLog, runInGuest]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    go(draft);
  };

  const selectedInfo = selectedEl || hoverEl;

  return (
    <div className="webengine-root">
      <div className="webengine-bar">
        <button type="button" className="webengine-btn" title="Назад" aria-label="Назад"
          onClick={() => viewRef.current?.goBack?.()} disabled={!url}>
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="webengine-btn" title="Вперёд" aria-label="Вперёд"
          onClick={() => viewRef.current?.goForward?.()} disabled={!url}>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="webengine-btn" title={loading ? "Стоп" : "Перезагрузить"} aria-label="Перезагрузить"
          onClick={() => (loading ? viewRef.current?.stop?.() : viewRef.current?.reload?.())} disabled={!url}>
          <RotateCw className={`w-3.5 h-3.5 ${loading ? "webengine-spin" : ""}`} />
        </button>

        <form className="webengine-form" onSubmit={submit}>
          <input
            className="webengine-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={probing ? "Ищу localhost…" : "http://localhost:3000"}
            spellCheck={false}
            aria-label="Адрес"
            title={title || undefined}
          />
          <button type="button" className="webengine-btn" title="Скопировать URL" aria-label="Скопировать URL" onClick={copyUrl}>
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button type="submit" className="webengine-btn webengine-btn-go" title="Открыть" aria-label="Открыть">
            <Search className="w-3.5 h-3.5" />
          </button>
        </form>

        <span className="webengine-bar-sep" />

        <button
          type="button"
          className={`webengine-btn ${inspectorOn ? "is-active" : ""}`}
          title="Инспектор элементов (наведение + клик)"
          aria-label="Инспектор"
          aria-pressed={inspectorOn}
          onClick={toggleInspector}
          disabled={!isDesktop || !url}
        >
          <Crosshair className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className={`webengine-btn webengine-btn-hideable ${devtoolsOpen ? "is-active" : ""}`}
          title="F12 — DevTools"
          aria-label="DevTools"
          onClick={toggleDevTools}
          disabled={!isDesktop || !url}
        >
          <Bug className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className={`webengine-btn ${consoleOpen ? "is-active" : ""}`}
          title="Консоль"
          aria-label="Консоль"
          aria-pressed={consoleOpen}
          onClick={() => setConsoleOpen((prev) => !prev)}
          disabled={!isDesktop}
        >
          <TerminalSquare className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="webengine-btn webengine-btn-hideable" title="Открыть во внешнем браузере" aria-label="Открыть снаружи"
          onClick={openExternal} disabled={!url}>
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="webengine-main">
        <div className="webengine-stage">
          {mountUrl ? (
            isDesktop ? (
              <webview
                ref={viewRef}
                className="webengine-view"
                src={mountUrl}
                partition="persist:composevc-webengine"
                useragent={chromeUserAgent()}
              />
            ) : (
              <iframe
                className="webengine-view"
                src={mountUrl}
                title="Web Engine"
                allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
                allowFullScreen
              />
            )
          ) : (
            <div className="webengine-empty">
              <p className="webengine-empty-title">
                {projectName && rootPath ? projectName : "Web Engine"}
              </p>
              <p>
                {probing
                  ? "Проверяю dev-сервер проекта…"
                  : "Введите адрес localhost или сайта выше, либо нажмите «Найти localhost»."}
              </p>
              <button
                type="button"
                className="webengine-probe-btn"
                onClick={() => {
                  setProbing(true);
                  void window.lopster
                    ?.webEngineProbeLocalhost(rootPath)
                    .then((res) => {
                      if (cancelledRef.current) return;
                      setProbing(false);
                      if (res?.ok && typeof res.url === "string") go(res.url);
                      else showToast("Localhost не найден — введите URL");
                    })
                    .catch(() => {
                      setProbing(false);
                      showToast("Localhost не найден — введите URL");
                    });
                }}
                disabled={probing}
              >
                <Search className="w-3.5 h-3.5" />
                {probing ? "Поиск…" : "Найти localhost"}
              </button>
              {!isDesktop && (
                <p className="webengine-note">Инспектор и консоль доступны в десктопном приложении.</p>
              )}
            </div>
          )}
          {error && (
            <div className="webengine-error">
              <span>{error}</span>
              <span className="webengine-error-hint">Недоступен — измените URL выше</span>
            </div>
          )}
        </div>

        <aside className="webengine-side">
          <section className="webengine-inspector">
            <header className="webengine-side-head">
              <span>Инспектор</span>
              {inspectorOn && <span className="webengine-live-dot" title="Активен" />}
            </header>
            {selectedInfo ? (
              <div className="webengine-inspector-body">
                <div className="webengine-el-row">
                  <code className="webengine-el-sel">{selectedInfo.sel || "—"}</code>
                  <button type="button" className="webengine-btn" title="Скопировать селектор" aria-label="Скопировать селектор"
                    onClick={() => void copyText(selectedInfo.sel).then((ok) => showToast(ok ? "Скопировано" : "Не удалось скопировать"))}>
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
                {selectedInfo.id && (
                  <div className="webengine-el-line"><span>id</span><code>{selectedInfo.id}</code></div>
                )}
                {selectedInfo.cls && (
                  <div className="webengine-el-line"><span>class</span><code>{selectedInfo.cls}</code></div>
                )}
                {selectedInfo.html && (
                  <div className="webengine-el-line webengine-el-block">
                    <span>html</span>
                    <pre>{selectedInfo.html}</pre>
                  </div>
                )}
                {selectedInfo.text && (
                  <div className="webengine-el-line webengine-el-block">
                    <span>text</span>
                    <pre>{selectedInfo.text}</pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="webengine-inspector-empty">
                {inspectorOn
                  ? "Наведите курсор на элемент, клик — выбрать."
                  : "Включите инспектор (⦿) и наведите курсор."}
              </div>
            )}
          </section>

          <section className={`webengine-console ${consoleOpen ? "is-open" : ""}`}>
            <header className="webengine-side-head">
              <span>Консоль</span>
              <span className="webengine-side-acts">
                <button type="button" className="webengine-btn" title="Скопировать логи" aria-label="Скопировать логи" onClick={copyLogs}>
                  <Copy className="w-3 h-3" />
                </button>
                <button type="button" className="webengine-btn" title="Очистить" aria-label="Очистить" onClick={clearLogs}>
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            </header>
            <div className="webengine-console-list" role="log">
              {logs.length === 0 ? (
                <div className="webengine-console-empty">Логи появятся здесь</div>
              ) : (
                logs.map((log) => (
                  <button
                    key={log.id}
                    type="button"
                    className={`webengine-log ${selectedLogIds.has(log.id) ? "is-selected" : ""}`}
                    onClick={() => toggleLog(log.id)}
                    title="Выделить для копирования"
                  >
                    <span className={`webengine-log-level is-${log.level}`}>{LEVEL_LABEL[log.level]}</span>
                    <span className="webengine-log-text">{log.text}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      {toast && <div className="webengine-toast"><Check className="w-3.5 h-3.5" />{toast}</div>}
    </div>
  );
};

export default WebEngineWorkspace;
