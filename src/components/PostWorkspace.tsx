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
const SAVE_DEBOUNCE_MS = 1500;
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

/**
 * Folder-aware post graph (right column): the root sits in the centre, each
 * folder is a hub around it, and every post orbits its folder (unfiled posts
 * orbit the centre). Wheel = zoom, drag = pan, double-click = reset. Clicking
 * a post opens it.
 */
type GraphNode = {
  id: string;
  x: number;
  y: number;
  title: string;
  kind: "post" | "folder" | "root";
  postId?: string;
};
type GraphEdge = { x1: number; y1: number; x2: number; y2: number; kind: string };

const PostGraph: React.FC<{
  posts: PostMeta[];
  folders: PostFolder[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}> = ({ posts, folders, activeId, onOpen, onDelete }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; viewX: number; viewY: number } | null>(null);

  const { nodes, edges, extent } = useMemo(() => {
    const nodeList: GraphNode[] = [];
    const edgeList: GraphEdge[] = [];
    nodeList.push({ id: "__root", x: 0, y: 0, title: "", kind: "root" });

    // Phyllotaxis (sunflower) placement — evenly spread, never overlapping:
    // point i sits at radius ∝ √i on the golden angle, ~SPACING apart.
    const GOLDEN = 2.399963229;
    const SPACING = 24;
    const INNER = 18;
    const point = (cx: number, cy: number, i: number, phase: number) => {
      const r = INNER + SPACING * Math.sqrt(i + 0.5);
      const t = i * GOLDEN + phase;
      return { x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r };
    };
    // Outer radius of a cluster of n points (0 when empty).
    const clusterR = (n: number) => (n <= 0 ? 0 : INNER + SPACING * Math.sqrt(n));

    const unfiled = posts.filter((p) => !p.folderId);
    const shown = folders
      .map((f) => ({ f, inside: posts.filter((p) => p.folderId === f.id) }))
      .filter((d) => d.inside.length > 0)
      .map((d) => ({ ...d, r: clusterR(d.inside.length) }));

    // Root cluster (unfiled) sits in the middle.
    unfiled.forEach((p, i) => {
      const { x, y } = point(0, 0, i, 0);
      nodeList.push({ id: p.id, x, y, title: p.title, kind: "post", postId: p.id });
      edgeList.push({ x1: 0, y1: 0, x2: x, y2: y, kind: "root" });
    });

    // Folder clusters ring the centre. The ring is wide enough that no folder
    // cloud overlaps the root cloud OR its neighbours on the ring.
    const K = shown.length;
    if (K > 0) {
      const rootR = clusterR(unfiled.length);
      const maxR = shown.reduce((m, d) => Math.max(m, d.r), 0);
      let ring = rootR + maxR + 54;
      if (K > 1) {
        const neighbourSep = maxR * 2 + 34;
        ring = Math.max(ring, neighbourSep / (2 * Math.sin(Math.PI / K)));
      }
      shown.forEach((d, fi) => {
        const a = (fi / K) * Math.PI * 2 - Math.PI / 2;
        const fx = Math.cos(a) * ring;
        const fy = Math.sin(a) * ring;
        nodeList.push({ id: "F:" + d.f.id, x: fx, y: fy, title: d.f.name, kind: "folder" });
        edgeList.push({ x1: 0, y1: 0, x2: fx, y2: fy, kind: "folder" });
        d.inside.forEach((p, i) => {
          const { x, y } = point(fx, fy, i, a);
          nodeList.push({ id: p.id, x, y, title: p.title, kind: "post", postId: p.id });
          edgeList.push({ x1: fx, y1: fy, x2: x, y2: y, kind: "post" });
        });
      });
    }

    // Fit the viewBox to everything (+ room for labels on the right).
    let ext = 90;
    for (const n of nodeList) {
      ext = Math.max(ext, Math.abs(n.x) + 46, Math.abs(n.y) + 22);
    }
    return { nodes: nodeList, edges: edgeList, extent: ext };
  }, [posts, folders]);

  useEffect(() => {
    if (selectedId && !posts.some((p) => p.id === selectedId)) setSelectedId(null);
  }, [posts, selectedId]);

  return (
    <aside className="post-graph" aria-label="Граф постов">
      <div className="post-graph-head">
        <span>GRAPH</span>
        <span>
          {posts.length} · {folders.length}📁
        </span>
      </div>
      <svg
        className="post-graph-svg"
        viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={(event) => {
          const factor = event.deltaY < 0 ? 1.12 : 0.89;
          setView((c) => ({ ...c, scale: Math.max(0.4, Math.min(3, c.scale * factor)) }));
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, viewX: view.x, viewY: view.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setView((c) => ({
            ...c,
            x: drag.current!.viewX + (event.clientX - drag.current!.x),
            y: drag.current!.viewY + (event.clientY - drag.current!.y),
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() => setView({ x: 0, y: 0, scale: 1 })}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {edges.map((e, i) => (
            <line key={i} className={`post-graph-edge is-${e.kind}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} />
          ))}
          {nodes.map((node) => {
            if (node.kind === "root") return <circle key={node.id} className="post-graph-root" cx={0} cy={0} r={4} />;
            const active = node.postId != null && node.postId === activeId;
            const selected = node.id === selectedId;
            const isFolder = node.kind === "folder";
            return (
              <g
                key={node.id}
                className={`post-graph-node${isFolder ? " is-folder" : ""}${active ? " is-active" : ""}${selected ? " is-selected" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => {
                  if (node.postId) {
                    setSelectedId(node.id);
                    onOpen(node.postId);
                  }
                }}
              >
                <circle r={isFolder ? 6 : active ? 5 : 3.5} />
                <text x={isFolder ? 11 : 9} y="3.5">
                  {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="post-graph-foot">
        <span>колесо zoom · тащить · 2× сброс</span>
        <button
          type="button"
          disabled={!selectedId}
          onClick={() => {
            const node = nodes.find((n) => n.id === selectedId);
            if (node?.postId) onDelete(node.postId);
          }}
          title="Удалить выбранный пост"
        >
          <Trash2 className="w-3 h-3" /> delete
        </button>
      </div>
    </aside>
  );
};

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
  // Ids we just wrote ourselves — the main process echoes posts:changed back to
  // this window too, and reloading on our own save would wipe what is being typed.
  const selfSaved = useRef<Set<string>>(new Set());

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

      {/* ── right: folder-aware graph ── */}
      <PostGraph
        posts={posts}
        folders={folders}
        activeId={activeId}
        onOpen={(id) => void openPost(id)}
        onDelete={(id) => void deletePost(id)}
      />
    </div>
  );
};

export default PostWorkspace;
