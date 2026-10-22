import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import {
  buildReport,
  fetchSourceSnippet,
  fiberTagLabel,
  formatReportText,
  InspectorReport,
} from "../utils/domInspector";

interface Props {
  active: boolean;
  onExit: () => void;
}

const ROOT_ATTR = "data-cvc-inspector";

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Write text to the clipboard, preferring the main-process clipboard. */
async function copyText(text: string): Promise<boolean> {
  if (window.lopster?.webEngineCopyText) {
    try {
      const res = await window.lopster.webEngineCopyText(text);
      if (res?.ok === true) return true;
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

const ElementInspector: React.FC<Props> = ({ active, onExit }) => {
  const [hovered, setHovered] = useState<InspectorReport | null>(null);
  const [pinned, setPinned] = useState<InspectorReport | null>(null);
  const [rect, setRect] = useState<BoxRect | null>(null);
  const [copied, setCopied] = useState(false);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [snippetLoading, setSnippetLoading] = useState(false);

  const rafRef = useRef<number | null>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const hoveredRef = useRef<InspectorReport | null>(null);
  const pinnedRef = useRef<InspectorReport | null>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  const displayed = pinned ?? hovered;
  const displayedKey = displayed
    ? `${displayed.dom.tag}${displayed.dom.selector}:${displayed.component?.source?.fileName || ""}:${
        displayed.component?.source?.lineNumber || 0
      }`
    : "";

  /* ── hover → pick element ── */
  useEffect(() => {
    if (!active) return;

    document.body.classList.add("cvc-inspecting");

    const isInspectorNode = (node: Node | null): boolean => {
      let cur = node as HTMLElement | null;
      while (cur) {
        if (cur.hasAttribute && cur.hasAttribute(ROOT_ATTR)) return true;
        cur = cur.parentElement;
      }
      return false;
    };

    const toHtmlElement = (node: Element | null): HTMLElement | null => {
      let cur = node;
      while (cur && !(cur instanceof HTMLElement)) cur = cur.parentElement;
      return cur as HTMLElement | null;
    };

    const resolve = (x: number, y: number): InspectorReport | null => {
      const el = toHtmlElement(document.elementFromPoint(x, y));
      if (!el || isInspectorNode(el)) return null;
      try {
        return buildReport(el);
      } catch {
        return null;
      }
    };

    const schedule = (x: number, y: number) => {
      lastPoint.current = { x, y };
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const pt = lastPoint.current;
        if (!pt || pinnedRef.current) return;
        const report = resolve(pt.x, pt.y);
        if (report) {
          hoveredRef.current = report;
          setHovered(report);
          setRect({
            x: report.dom.rect.x,
            y: report.dom.rect.y,
            w: report.dom.rect.width,
            h: report.dom.rect.height,
          });
        }
      });
    };

    const onMouseMove = (e: MouseEvent) => schedule(e.clientX, e.clientY);

    const onPointerDown = (e: PointerEvent) => {
      if (isInspectorNode(e.target as Node)) return; // allow panel buttons
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const report = hoveredRef.current ?? resolve(e.clientX, e.clientY);
      if (report) {
        pinnedRef.current = report;
        setPinned(report);
        setRect({
          x: report.dom.rect.x,
          y: report.dom.rect.y,
          w: report.dom.rect.width,
          h: report.dom.rect.height,
        });
        void copyText(formatReportText(report)).then((ok) => {
          if (ok) {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }
        });
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExitRef.current();
    };

    const onMouseLeave = () => {
      if (pinnedRef.current) return;
      hoveredRef.current = null;
      setHovered(null);
      setRect(null);
    };

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mouseleave", onMouseLeave);

    return () => {
      document.body.classList.remove("cvc-inspecting");
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [active]);

  /* reset state when toggled off */
  useEffect(() => {
    if (!active) {
      setHovered(null);
      setPinned(null);
      setRect(null);
      setSnippet(null);
      setSnippetLoading(false);
      hoveredRef.current = null;
      pinnedRef.current = null;
    }
  }, [active]);

  /* ── fetch source snippet for the shown element ── */
  useEffect(() => {
    let cancelled = false;
    const source = displayed?.component?.source;
    if (!source) {
      setSnippet(null);
      setSnippetLoading(false);
      return;
    }
    setSnippetLoading(true);
    setSnippet(null);
    void fetchSourceSnippet(source).then((text) => {
      if (!cancelled) {
        setSnippet(text);
        setSnippetLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayedKey]);

  const component = displayed?.component ?? null;
  const dom = displayed?.dom ?? null;

  const tagLabel = useMemo(() => {
    if (!dom || !component) return dom?.tag || "";
    return `${dom.tag} · ${component.name}`;
  }, [dom, component]);

  if (!active) return null;

  return (
    <>
      {/* highlight box */}
      {rect && (
        <div
          data-cvc-inspector="true"
          className="cvc-inspector-highlight"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}

      {/* floating tag near the hovered element */}
      {rect && tagLabel && (
        <div
          data-cvc-inspector="true"
          className="cvc-inspector-tag"
          style={{
            left: Math.max(4, rect.x),
            top: Math.max(4, rect.y - 24),
          }}
        >
          <span className="cvc-inspector-tag-name">{tagLabel}</span>
          <span className="cvc-inspector-tag-size">
            {Math.round(rect.w)}×{Math.round(rect.h)}
          </span>
        </div>
      )}

      {/* info panel */}
      <div data-cvc-inspector="true" className="cvc-inspector-panel">
        <div className="cvc-inspector-head">
          <span className="cvc-inspector-title">INSPECTOR</span>
          <span className="cvc-inspector-mode">{pinned ? "pinned" : "hover"}</span>
          <button
            type="button"
            className="cvc-inspector-btn"
            title="Copy to clipboard"
            onClick={() =>
              displayed &&
              void copyText(formatReportText(displayed)).then((ok) => {
                if (ok) {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1600);
                }
              })
            }
          >
            <Copy className="w-3.5 h-3.5" />
            {copied ? "COPIED" : "COPY"}
          </button>
          <button
            type="button"
            className="cvc-inspector-btn"
            title="Exit inspector (Esc)"
            onClick={onExit}
          >
            <X className="w-3.5 h-3.5" />
            CLOSE
          </button>
        </div>

        {!displayed ? (
          <div className="cvc-inspector-empty">
            Наведи курсор на элемент интерфейса — инспектор покажет его DOM, React-компонент,
            пропсы, состояние и связи. Клик — закрепить и скопировать всё в буфер.
          </div>
        ) : (
          <div className="cvc-inspector-body">
            {dom && (
              <section className="cvc-inspector-sec">
                <h4 className="cvc-inspector-sec-title">DOM</h4>
                <dl className="cvc-inspector-dl">
                  <dt>tag</dt>
                  <dd>
                    {dom.tag}
                    {dom.id ? " #" + dom.id : ""}
                  </dd>
                  {dom.className && (
                    <>
                      <dt>class</dt>
                      <dd className="cvc-inspector-mono">.{dom.className.split(/\s+/).join(" .")}</dd>
                    </>
                  )}
                  <dt>selector</dt>
                  <dd className="cvc-inspector-mono">{dom.selector}</dd>
                  <dt>size</dt>
                  <dd>
                    {Math.round(dom.rect.width)} × {Math.round(dom.rect.height)}px
                  </dd>
                  {dom.text && (
                    <>
                      <dt>text</dt>
                      <dd className="cvc-inspector-mono">{dom.text}</dd>
                    </>
                  )}
                </dl>
                {dom.attributes.length > 0 && (
                  <div className="cvc-inspector-kv">
                    {dom.attributes.slice(0, 10).map((a) => (
                      <div key={a.name} className="cvc-inspector-kv-row">
                        <span className="cvc-inspector-kv-key">{a.name}</span>
                        <span className="cvc-inspector-kv-val">"{a.value}"</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {component && (
              <section className="cvc-inspector-sec">
                <h4 className="cvc-inspector-sec-title">
                  COMPONENT{" "}
                  <span className="cvc-inspector-dim">
                    {component.name} · {fiberTagLabel(component.tag)}
                  </span>
                </h4>
                {component.source && (
                  <div className="cvc-inspector-mono cvc-inspector-source-loc">
                    {component.source.fileName}:{component.source.lineNumber}
                  </div>
                )}
                {component.props.length > 0 && (
                  <div className="cvc-inspector-kv">
                    <div className="cvc-inspector-kv-label">props</div>
                    {component.props.slice(0, 20).map((p) => (
                      <div key={p.key} className="cvc-inspector-kv-row">
                        <span className="cvc-inspector-kv-key">{p.key}</span>
                        <span className="cvc-inspector-kv-val">{p.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {component.hooks.length > 0 && (
                  <div className="cvc-inspector-kv">
                    <div className="cvc-inspector-kv-label">hooks / state</div>
                    {component.hooks.slice(0, 20).map((h) => (
                      <div key={h.index} className="cvc-inspector-kv-row">
                        <span className="cvc-inspector-kv-key">
                          #{h.index} {h.name}
                        </span>
                        <span className="cvc-inspector-kv-val">{h.state}</span>
                      </div>
                    ))}
                  </div>
                )}
                {component.ancestors.length > 0 && (
                  <div className="cvc-inspector-chain">
                    <div className="cvc-inspector-kv-label">ancestors ↑</div>
                    <span className="cvc-inspector-chain-list">
                      {component.ancestors
                        .slice(0, 14)
                        .map((a) => a.name)
                        .join(" › ")}
                    </span>
                  </div>
                )}
                {component.children.length > 0 && (
                  <div className="cvc-inspector-chain">
                    <div className="cvc-inspector-kv-label">children ↓</div>
                    <span className="cvc-inspector-chain-list">
                      {component.children
                        .slice(0, 14)
                        .map((c) => c.name)
                        .join(" · ")}
                    </span>
                  </div>
                )}
              </section>
            )}

            {(snippet || snippetLoading || component?.rawSource) && (
              <section className="cvc-inspector-sec">
                <h4 className="cvc-inspector-sec-title">SOURCE</h4>
                {snippetLoading && <div className="cvc-inspector-dim">loading…</div>}
                {snippet ? (
                  <pre className="cvc-inspector-code">{snippet}</pre>
                ) : (
                  component?.rawSource && (
                    <pre className="cvc-inspector-code">
                      {component.rawSource.slice(0, 6000)}
                    </pre>
                  )
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
};

export default ElementInspector;
