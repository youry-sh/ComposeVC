import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";
import MarkdownContent from "./markdown/MarkdownContent";
import type { PostFolder, PostFull, PostMeta } from "../global";

/**
 * POST tab — Telegraph-style markdown posts, organised in folders.
 *   • Left: folders (collapsible, drop targets) + unfiled posts, search, paging.
 *   • Drag a post onto a folder to move it; the agent can do the same via the
 *     `posts` tool (create/move folders and posts). Search spans title + body
 *     across every folder.
 *   • Center: title + a clean writing surface (edit / preview), full markdown.
 */

const PAGE_SIZE = 40;
const SAVE_DEBOUNCE_MS = 600;
const OPEN_KEY = "composevc-post-folders-open";

function loadOpenFolders(): Set<string> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    /* ignore */
  }
  return new Set();
}

const PostWorkspace: React.FC = () => {
  const [folders, setFolders] = useState<PostFolder[]>([]);
  const [posts, setPosts] = useState<PostMeta[]>([]);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PostFull | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [saved, setSaved] = useState(true);
  const [open, setOpen] = useState<Set<string>>(() => loadOpenFolders());
  const [page, setPage] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | "root" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const saveTimer = useRef<number | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const refreshList = useCallback(async (nextQuery?: string) => {
    const res = await window.lopster?.postsList?.({ query: (nextQuery ?? query).trim() });
    if (res?.ok) {
      setFolders(res.folders || []);
      setPosts(res.posts || []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const openPost = useCallback(async (id: string) => {
    const res = await window.lopster?.postsGet?.(id);
    if (res?.ok && res.post) {
      setActiveId(id);
      setDraft(res.post);
      setMode("preview");
      setSaved(true);
    }
  }, []);

  // Debounced search — refetch; matches span title + body server-side.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setPage(0);
      void refreshList(query);
    }, 250);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live sync when the agent (or another window) changes posts/folders.
  useEffect(() => {
    const unsub = window.lopster?.onPostsChanged?.((payload) => {
      void refreshList();
      if (payload?.type === "deleted" && payload.id === activeId) {
        setActiveId(null);
        setDraft(null);
      } else if (payload?.id && payload.id === activeId && payload.type === "updated") {
        void openPost(payload.id);
      }
    });
    return () => unsub?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
    } catch {
      /* ignore */
    }
  }, [open]);

  const createPost = useCallback(
    async (folderId: string | null = null) => {
      const res = await window.lopster?.postsCreate?.({ title: "Новый пост", content: "", folderId });
      if (res?.ok && res.post) {
        await refreshList("");
        setQuery("");
        setActiveId(res.post.id);
        setDraft(res.post);
        setMode("edit");
        setSaved(true);
        if (folderId) setOpen((s) => new Set(s).add(folderId));
      }
    },
    [refreshList]
  );

  const createFolder = useCallback(async () => {
    const res = await window.lopster?.postsFolderCreate?.({ name: "Новая папка" });
    if (res?.ok && res.folder) {
      await refreshList();
      setOpen((s) => new Set(s).add(res.folder!.id));
      setRenaming(res.folder.id);
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

  const deleteFolder = useCallback(
    async (id: string) => {
      await window.lopster?.postsFolderDelete?.(id);
      void refreshList();
    },
    [refreshList]
  );

  const renameFolder = useCallback(
    async (id: string, name: string) => {
      setRenaming(null);
      const trimmed = name.trim();
      if (trimmed) await window.lopster?.postsFolderRename?.(id, trimmed);
      void refreshList();
    },
    [refreshList]
  );

  const movePost = useCallback(
    async (id: string, folderId: string | null) => {
      await window.lopster?.postsMove?.(id, folderId);
      void refreshList();
    },
    [refreshList]
  );

  // ── autosave ──
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

  // Grow the textarea with its content so there is no second native scrollbar.
  useLayoutEffect(() => {
    if (mode !== "edit" || !bodyRef.current) return;
    const field = bodyRef.current;
    field.style.height = "0px";
    const pageHeight = field.parentElement?.clientHeight || 0;
    const availableHeight = Math.max(0, pageHeight - field.offsetTop - 28);
    field.style.height = `${Math.max(field.scrollHeight, availableHeight)}px`;
  }, [mode, draft?.content]);

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);

  const searching = query.trim().length > 0;

  const stamp = (p: PostMeta) =>
    new Date(p.updatedAt).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });

  const byFolder = useMemo(() => {
    const map = new Map<string | null, PostMeta[]>();
    for (const p of posts) {
      const arr = map.get(p.folderId) || [];
      arr.push(p);
      map.set(p.folderId, arr);
    }
    return map;
  }, [posts]);

  const rootPosts = byFolder.get(null) || [];
  // Pagination applies to the flat region: search results, or the unfiled root.
  const flat = searching ? posts : rootPosts;
  const totalPages = Math.max(1, Math.ceil(flat.length / PAGE_SIZE));
  const pageSlice = flat.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const toggleFolder = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── drag helpers ──
  const onDragStart = (e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragEnd = () => {
    setDragId(null);
    setDropTarget(null);
  };
  const allowDrop = (e: React.DragEvent, target: string | "root") => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget !== target) setDropTarget(target);
  };
  const doDrop = (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    const id = dragId || e.dataTransfer.getData("text/plain");
    if (id) void movePost(id, folderId);
    onDragEnd();
  };

  const PostRow: React.FC<{ p: PostMeta }> = ({ p }) => (
    <div
      className={`post-item${p.id === activeId ? " is-active" : ""}${dragId === p.id ? " is-dragging" : ""}`}
      draggable
      onDragStart={(e) => onDragStart(e, p.id)}
      onDragEnd={onDragEnd}
    >
      <button type="button" className="post-item-btn" onClick={() => void openPost(p.id)}>
        <span className="post-item-title">{p.title}</span>
        <span className="post-item-when">{stamp(p)}</span>
      </button>
      <button type="button" className="post-item-del" onClick={() => void deletePost(p.id)} aria-label="Удалить">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <div className="post-shell">
      {/* ── left: folders + list ── */}
      <aside className="post-side">
        <header className="post-side-head">
          <span className="post-brand">POST</span>
          <div className="post-head-actions">
            <button type="button" className="post-ghost" onClick={() => void createFolder()} title="Новая папка">
              <FolderPlus className="w-4 h-4" />
            </button>
            <button type="button" className="post-new" onClick={() => void createPost(null)} title="Новый пост">
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="post-search">
          <Search className="post-search-ico" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по постам и папкам…"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="post-search-clear" onClick={() => setQuery("")} aria-label="Очистить">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>

        <ChatMonoScroll className="post-list">
          {posts.length === 0 && folders.length === 0 && (
            <p className="post-empty">{searching ? "Ничего не найдено" : "Пусто — создайте пост или папку"}</p>
          )}

          {/* Folders: hidden during search (results are flat below). */}
          {!searching &&
            folders.map((f) => {
              const inside = byFolder.get(f.id) || [];
              const isOpen = open.has(f.id);
              return (
                <div key={f.id} className="post-folder">
                  <div
                    className={`post-folder-row${dropTarget === f.id ? " is-drop" : ""}`}
                    onDragOver={(e) => allowDrop(e, f.id)}
                    onDragLeave={() => dropTarget === f.id && setDropTarget(null)}
                    onDrop={(e) => doDrop(e, f.id)}
                  >
                    <button type="button" className="post-folder-toggle" onClick={() => toggleFolder(f.id)}>
                      {isOpen ? <FolderOpen className="w-4 h-4" /> : <Folder className="w-4 h-4" />}
                      {renaming === f.id ? (
                        <input
                          className="post-folder-rename"
                          defaultValue={f.name}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => void renameFolder(f.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                            if (e.key === "Escape") setRenaming(null);
                          }}
                        />
                      ) : (
                        <span
                          className="post-folder-name"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setRenaming(f.id);
                          }}
                        >
                          {f.name}
                        </span>
                      )}
                      <span className="post-folder-count">{inside.length}</span>
                    </button>
                    <button
                      type="button"
                      className="post-folder-add"
                      onClick={() => void createPost(f.id)}
                      title="Пост в эту папку"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      className="post-folder-del"
                      onClick={() => void deleteFolder(f.id)}
                      title="Удалить папку (посты вернутся в корень)"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="post-folder-body">
                      {inside.length === 0 && <p className="post-folder-empty">Перетащите посты сюда</p>}
                      {inside.map((p) => (
                        <PostRow key={p.id} p={p} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

          {/* Root / search results (paginated). */}
          {(searching || rootPosts.length > 0) && (
            <div
              className={`post-root${dropTarget === "root" ? " is-drop" : ""}`}
              onDragOver={(e) => allowDrop(e, "root")}
              onDragLeave={() => dropTarget === "root" && setDropTarget(null)}
              onDrop={(e) => doDrop(e, null)}
            >
              {!searching && (
                <div className="post-root-head">Без папки <span className="post-folder-count">{rootPosts.length}</span></div>
              )}
              {pageSlice.map((p) => (
                <PostRow key={p.id} p={p} />
              ))}
            </div>
          )}
        </ChatMonoScroll>

        <footer className="post-pager">
          <button type="button" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Назад">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="post-pager-info">
            {searching ? `${flat.length} найдено · ${page + 1}/${totalPages}` : `${page + 1} / ${totalPages}`}
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
                <button type="button" className={mode === "edit" ? "is-active" : ""} onClick={() => setMode("edit")}>
                  <Pencil className="w-3.5 h-3.5" /> Редактор
                </button>
                <button type="button" className={mode === "preview" ? "is-active" : ""} onClick={() => setMode("preview")}>
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
    </div>
  );
};

export default PostWorkspace;
