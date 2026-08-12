import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";
import MarkdownContent from "./markdown/MarkdownContent";
import type { PostFull, PostMeta } from "../global";

/**
 * POST tab — Telegraph-style markdown posts.
 *   • Left: list with "+", title search, 40-per-page pagination.
 *   • Center: title + a clean writing surface (edit / preview), full markdown.
 * Bodies are .md, metadata is index.json — both under userData/posts. The agent
 * edits the same store through the `posts` tool; changes sync live here.
 */

const PAGE_SIZE = 40;
const SAVE_DEBOUNCE_MS = 600;

type GraphProps = {
  posts: PostMeta[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
};

const PostGraph: React.FC<GraphProps> = ({ posts, activeId, onOpen, onDelete }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const view = useRef({ x: 0, y: 0, scale: 1 });
  const layerRef = useRef<SVGGElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);
  const nodes = useMemo(() => posts.map((post, index) => {
    const ring = Math.floor(Math.sqrt(index));
    const angle = index * 2.399963 + (post.id.charCodeAt(0) || 0) * 0.03;
    const radius = index === 0 ? 0 : 38 + ring * 34;
    return { ...post, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }), [posts]);
  const edges = useMemo(() => nodes.slice(1).map((node, index) => ({
    from: nodes[Math.max(0, Math.floor(index / 2))],
    to: node,
  })), [nodes]);

  useEffect(() => {
    if (selectedId && !posts.some((post) => post.id === selectedId)) setSelectedId(null);
  }, [posts, selectedId]);

  const paintView = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const current = view.current;
      layerRef.current?.setAttribute(
        "transform",
        `translate(${current.x} ${current.y}) scale(${current.scale})`
      );
    });
  }, []);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <aside className="post-graph" aria-label="Граф постов">
      <div className="post-graph-head">
        <span>GRAPH</span>
        <span>{posts.length} nodes</span>
      </div>
      <svg
        className="post-graph-svg"
        viewBox="-210 -260 420 520"
        onWheel={(event) => {
          event.preventDefault();
          const factor = event.deltaY < 0 ? 1.12 : 0.89;
          view.current.scale = Math.max(.45, Math.min(2.8, view.current.scale * factor));
          paintView();
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, viewX: view.current.x, viewY: view.current.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          view.current.x = drag.current.viewX + (event.clientX - drag.current.x);
          view.current.y = drag.current.viewY + (event.clientY - drag.current.y);
          paintView();
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onDoubleClick={() => {
          view.current = { x: 0, y: 0, scale: 1 };
          paintView();
        }}
      >
        <g ref={layerRef} transform="translate(0 0) scale(1)">
          {edges.map((edge) => (
            <line key={`${edge.from.id}-${edge.to.id}`} className="post-graph-edge" x1={edge.from.x} y1={edge.from.y} x2={edge.to.x} y2={edge.to.y} />
          ))}
          {nodes.map((node) => {
            const active = node.id === activeId;
            const selected = node.id === selectedId;
            return (
              <g
                key={node.id}
                className={`post-graph-node${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => { setSelectedId(node.id); onOpen(node.id); }}
              >
                <circle r={active ? 5 : 3.5} />
                <text x="9" y="3.5">{node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="post-graph-foot">
        <span>wheel zoom · drag pan · double-click reset</span>
        <button
          type="button"
          disabled={!selectedId}
          onClick={() => selectedId && onDelete(selectedId)}
          title="Удалить выбранный пост"
        >
          <Trash2 className="w-3 h-3" /> delete
        </button>
      </div>
    </aside>
  );
};

const PostWorkspace: React.FC = () => {
  const [list, setList] = useState<PostMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PostFull | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saved, setSaved] = useState(true);
  const saveTimer = useRef<number | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshList = useCallback(
    async (nextPage = page, nextQuery = query) => {
      const res = await window.lopster?.postsList?.({
        query: nextQuery.trim(),
        page: nextPage,
        pageSize: PAGE_SIZE,
      });
      if (res?.ok) {
        setList(res.posts || []);
        setTotal(res.total || 0);
      }
    },
    [page, query]
  );

  // Debounced search — resets to the first page.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setPage(0);
      void refreshList(0, query);
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    void refreshList(page, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  // Live sync when the agent (or another window) changes posts.
  useEffect(() => {
    const unsub = window.lopster?.onPostsChanged?.((payload) => {
      void refreshList();
      if (payload?.type === "deleted" && payload.id === activeId) {
        setActiveId(null);
        setDraft(null);
      } else if (payload?.id && payload.id === activeId) {
        void openPost(payload.id, { silent: true });
      }
    });
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const openPost = useCallback(async (id: string, _opts?: { silent?: boolean }) => {
    const res = await window.lopster?.postsGet?.(id);
    if (res?.ok && res.post) {
      setActiveId(id);
      setDraft(res.post);
      // A selected or externally updated post is primarily a document, so show
      // rendered Markdown first. The explicit Pencil tab remains the edit path.
      setMode("preview");
      setSaved(true);
    }
  }, []);

  const createPost = useCallback(async () => {
    const res = await window.lopster?.postsCreate?.({ title: "Новый пост", content: "" });
    if (res?.ok && res.post) {
      await refreshList(0, "");
      setQuery("");
      setPage(0);
      setActiveId(res.post.id);
      setDraft(res.post);
      setMode("edit");
      setSaved(true);
    }
  }, [refreshList]);

  const deletePost = useCallback(
    async (id: string) => {
      await window.lopster?.postsDelete?.(id);
      if (id === activeId) {
        setActiveId(null);
        setDraft(null);
      }
      void refreshList();
    },
    [activeId, refreshList]
  );

  // Debounced autosave whenever the draft changes.
  const scheduleSave = useCallback((next: PostFull) => {
    setSaved(false);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      await window.lopster?.postsUpdate?.(next.id, { title: next.title, content: next.content });
      setSaved(true);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const onTitle = (title: string) => {
    if (!draft) return;
    const next = { ...draft, title };
    setDraft(next);
    scheduleSave(next);
  };
  const onContent = (content: string) => {
    if (!draft) return;
    const next = { ...draft, content };
    setDraft(next);
    scheduleSave(next);
  };

  // The outer ChatMonoScroll owns scrolling. Grow the textarea with its content
  // so Chromium never falls back to a second, native textarea scrollbar.
  useLayoutEffect(() => {
    if (mode !== "edit" || !bodyRef.current) return;
    const field = bodyRef.current;
    field.style.height = "0px";
    const pageHeight = field.parentElement?.clientHeight || 0;
    const availableHeight = Math.max(0, pageHeight - field.offsetTop - 28);
    field.style.height = `${Math.max(field.scrollHeight, availableHeight)}px`;
  }, [mode, draft?.content]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const searching = query.trim().length > 0;

  const listStamp = useMemo(
    () =>
      list.map((p) => {
        const d = new Date(p.updatedAt);
        return { ...p, when: d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) };
      }),
    [list]
  );

  return (
    <div className="post-shell">
      {/* ── left: list ── */}
      <aside className="post-side">
        <header className="post-side-head">
          <span className="post-brand">POST</span>
          <button type="button" className="post-new" onClick={() => void createPost()} title="Новый пост">
            <Plus className="w-4 h-4" />
          </button>
        </header>
        <div className="post-search">
          <Search className="post-search-ico" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по постам…"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="post-search-clear" onClick={() => setQuery("")} aria-label="Очистить">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <ChatMonoScroll className="post-list">
          {listStamp.length === 0 && (
            <p className="post-empty">{searching ? "Ничего не найдено" : "Постов пока нет"}</p>
          )}
          {listStamp.map((p) => (
            <div
              key={p.id}
              className={`post-item${p.id === activeId ? " is-active" : ""}`}
            >
              <button type="button" className="post-item-btn" onClick={() => void openPost(p.id)}>
                <span className="post-item-title">{p.title}</span>
                <span className="post-item-when">{p.when}</span>
              </button>
              <button
                type="button"
                className="post-item-del"
                onClick={() => void deletePost(p.id)}
                aria-label="Удалить"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </ChatMonoScroll>

        <footer className="post-pager">
          <button
            type="button"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Назад"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="post-pager-info">
            {searching ? `${total} найдено` : `${page + 1} / ${totalPages}`}
          </span>
          <button
            type="button"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Следующая страница"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </footer>
      </aside>

      {/* ── center: editor ── */}
      <main className="post-main">
        {draft ? (
          <>
            <div className="post-toolbar">
              <div className="post-mode">
                <button
                  type="button"
                  className={mode === "edit" ? "is-active" : ""}
                  onClick={() => setMode("edit")}
                >
                  <Pencil className="w-3.5 h-3.5" /> Редактор
                </button>
                <button
                  type="button"
                  className={mode === "preview" ? "is-active" : ""}
                  onClick={() => setMode("preview")}
                >
                  <Eye className="w-3.5 h-3.5" /> Просмотр
                </button>
              </div>
              <span className={`post-saved${saved ? " is-ok" : ""}`}>{saved ? "сохранено" : "сохранение…"}</span>
            </div>

            <ChatMonoScroll className="post-canvas">
              <article className="post-page">
                <input
                  className="post-title-input"
                  value={draft.title}
                  onChange={(e) => onTitle(e.target.value)}
                  placeholder="Заголовок"
                  spellCheck={false}
                />
                {mode === "edit" ? (
                  <textarea
                    ref={bodyRef}
                    className="post-body-input"
                    value={draft.content}
                    onChange={(e) => onContent(e.target.value)}
                    placeholder="Пишите пост в Markdown — заголовки, списки, таблицы, код…"
                    spellCheck={false}
                  />
                ) : (
                  <div className="post-preview md-ai">
                    {draft.content.trim() ? (
                      <MarkdownContent content={draft.content} />
                    ) : (
                      <p className="post-preview-empty">Пусто — напишите что-нибудь в редакторе.</p>
                    )}
                  </div>
                )}
              </article>
            </ChatMonoScroll>
          </>
        ) : (
          <div className="post-blank">
            <p>Выберите пост слева или нажмите «+», чтобы создать новый.</p>
          </div>
        )}
      </main>

      <PostGraph
        posts={list}
        activeId={activeId}
        onOpen={(id) => void openPost(id)}
        onDelete={(id) => void deletePost(id)}
      />
    </div>
  );
};

export default PostWorkspace;
