import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  const openPost = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    const res = await window.lopster?.postsGet?.(id);
    if (res?.ok && res.post) {
      setActiveId(id);
      setDraft(res.post);
      if (!opts?.silent) setMode("edit");
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
    </div>
  );
};

export default PostWorkspace;
