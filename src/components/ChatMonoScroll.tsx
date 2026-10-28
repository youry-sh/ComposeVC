import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

type ChatMonoScrollProps = {
  className?: string;
  children: React.ReactNode;
  /** Render the floating «jump to bottom» button once the user scrolls away from the end. */
  showScrollToBottom?: boolean;
  /** Tooltip / accessible label for that button. */
  scrollToBottomLabel?: string;
  /** Called when the «viewport is pinned to the end» state flips. */
  onAtBottomChange?: (atBottom: boolean) => void;
};

export type ChatMonoScrollHandle = {
  scrollToBottom: (opts?: { smooth?: boolean }) => void;
  jumpToBottom: () => void;
  getViewport: () => HTMLDivElement | null;
};

type ThumbState = {
  visible: boolean;
  top: number;
  height: number;
};

const MIN_THUMB = 28;
const RAIL_INSET = 4;
/** Same threshold ChatPanel uses to decide whether the transcript is pinned to the end. */
const BOTTOM_GAP = 96;

const ChatMonoScroll = forwardRef<ChatMonoScrollHandle, ChatMonoScrollProps>(
  (
    {
      className = "",
      children,
      showScrollToBottom = false,
      scrollToBottomLabel = "Scroll to bottom",
      onAtBottomChange,
    },
    ref
  ) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<ThumbState>({ visible: false, top: 0, height: 0 });
  const [atBottom, setAtBottom] = useState(true);
  const [active, setActive] = useState(false);
  const dragRef = useRef<{ startY: number; startScroll: number } | null>(null);

  const syncThumb = useCallback(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const overflow = scrollHeight - clientHeight;
    if (overflow <= 2 || clientHeight <= 0) {
      setThumb((prev) => (prev.visible ? { visible: false, top: 0, height: 0 } : prev));
      setAtBottom(true);
      return;
    }
    const track = Math.max(0, clientHeight - RAIL_INSET * 2);
    const ratio = clientHeight / scrollHeight;
    const height = Math.max(MIN_THUMB, Math.round(track * ratio));
    const maxTop = Math.max(0, track - height);
    const top = RAIL_INSET + Math.round((scrollTop / overflow) * maxTop);
    setThumb({ visible: true, top, height });
    setAtBottom(scrollHeight - scrollTop - clientHeight < BOTTOM_GAP);
  }, []);

  const scrollToBottom = useCallback((opts?: { smooth?: boolean }) => {
    const el = viewportRef.current;
    if (!el) return;
    const apply = () => {
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      if (opts?.smooth) {
        el.scrollTo({ top: max, behavior: "smooth" });
        window.setTimeout(() => {
          el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
          syncThumb();
        }, 120);
      } else {
        el.scrollTop = max + 64;
        el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      }
      syncThumb();
    };
    apply();
    requestAnimationFrame(() => {
      apply();
    });
  }, [syncThumb]);

  const jumpToBottom = useCallback(() => {
    scrollToBottom({ smooth: true });
  }, [scrollToBottom]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
      jumpToBottom,
      getViewport: () => viewportRef.current,
    }),
    [scrollToBottom, jumpToBottom]
  );

  useEffect(() => {
    onAtBottomChange?.(atBottom);
  }, [atBottom, onAtBottomChange]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    syncThumb();
    const onScroll = () => syncThumb();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncThumb()) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            requestAnimationFrame(syncThumb);
          })
        : null;
    mo?.observe(el, { childList: true, subtree: true });
    window.addEventListener("resize", syncThumb);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("resize", syncThumb);
    };
  }, [syncThumb]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      const el = viewportRef.current;
      if (!drag || !el) return;
      const { scrollHeight, clientHeight } = el;
      const overflow = scrollHeight - clientHeight;
      if (overflow <= 0) return;
      const track = Math.max(1, clientHeight - RAIL_INSET * 2 - thumb.height);
      const delta = event.clientY - drag.startY;
      const next = drag.startScroll + (delta / track) * overflow;
      el.scrollTop = Math.max(0, Math.min(overflow, next));
    };
    const onUp = () => {
      dragRef.current = null;
      setActive(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [thumb.height]);

  const onThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const el = viewportRef.current;
    if (!el) return;
    dragRef.current = { startY: event.clientY, startScroll: el.scrollTop };
    setActive(true);
  };

  const onRailPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).dataset.thumb === "1") return;
    const el = viewportRef.current;
    if (!el || !thumb.visible) return;
    const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
    const y = event.clientY - rect.top - RAIL_INSET - thumb.height / 2;
    const track = Math.max(1, el.clientHeight - RAIL_INSET * 2 - thumb.height);
    const overflow = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.max(0, Math.min(overflow, (y / track) * overflow));
  };

  return (
    <div className={`chat-mono-scroll ${active ? "is-active" : ""} ${className}`.trim()}>
      <div ref={viewportRef} className="chat-mono-scroll-viewport">
        {children}
      </div>
      {showScrollToBottom && !atBottom && (
        <button
          type="button"
          className="chat-mono-scroll-jump"
          title={scrollToBottomLabel}
          aria-label={scrollToBottomLabel}
          onClick={jumpToBottom}
          onPointerDown={(event) => event.preventDefault()}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="square"
            aria-hidden
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      )}
      {thumb.visible && (
        <div
          className="chat-mono-scroll-rail"
          onPointerDown={onRailPointerDown}
          aria-hidden
        >
          <div
            data-thumb="1"
            className="chat-mono-scroll-thumb"
            style={{ top: thumb.top, height: thumb.height }}
            onPointerDown={onThumbPointerDown}
          />
        </div>
      )}
    </div>
  );
});

ChatMonoScroll.displayName = "ChatMonoScroll";

export default ChatMonoScroll;
