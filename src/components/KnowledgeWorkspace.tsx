import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Database,
  Download,
  Eye,
  FileText,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Spline,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { KnowledgeChunk, KnowledgeChunkSummary, KnowledgeListResponse } from "../types";
import MarkdownContent from "./markdown/MarkdownContent";

// Lazy-mount the WebGL neural view: three.js and the scene only load when the
// user opens the pane, keeping the main bundle small.
const KnowledgeNeural = React.lazy(() => import("./KnowledgeNeural"));

type ViewMode = "preview" | "edit";

interface ChunkDraft {
  title: string;
  content: string;
  tagsText: string;
  linksText: string;
  source: string;
}

const EMPTY_DRAFT: ChunkDraft = {
  title: "",
  content: "",
  tagsText: "",
  linksText: "",
  source: "knowledge-workspace",
};

function draftFromChunk(chunk: KnowledgeChunk): ChunkDraft {
  return {
    title: chunk.title || "",
    content: chunk.content || "",
    tagsText: (chunk.tags || []).join(", "),
    linksText: (chunk.links || []).join(", "),
    source: chunk.source || "knowledge-workspace",
  };
}

function snapshot(draft: ChunkDraft) {
  return JSON.stringify(draft);
}

function parseList(value: string) {
  return [...new Set(
    String(value || "")
      .split(/[,;\n]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

function formatDate(value: number) {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

function formatSize(chars: number) {
  const value = Math.max(0, Number(chars) || 0);
  if (value < 1000) return `${value} chars`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k chars`;
}

interface KnowledgeWorkspaceProps {
  rootPath?: string | null;
}

const KnowledgeWorkspace: React.FC<KnowledgeWorkspaceProps> = ({ rootPath = null }) => {
  const [catalog, setCatalog] = useState<KnowledgeListResponse | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunkSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChunkDraft>(EMPTY_DRAFT);
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot(EMPTY_DRAFT));
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingChunk, setLoadingChunk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  const [pane, setPane] = useState<"library" | "neural">("library");
  const [archiveBusy, setArchiveBusy] = useState<"export" | "import" | null>(null);
  const [noticeDetail, setNoticeDetail] = useState("");

  const isDirty = snapshot(draft) !== savedSnapshot;

  const showNotice = (text: string, detail = "") => {
    setNotice(text);
    setNoticeDetail(detail);
  };

  const fetchCatalog = useCallback(async () => {
    const result = await window.lopster?.knowledgeList?.();
    if (!result) throw new Error("Knowledge storage is unavailable");
    setCatalog(result);
    setChunks(result.chunks || []);
    return result;
  }, []);

  const applyChunk = useCallback((chunk: KnowledgeChunk) => {
    const next = draftFromChunk(chunk);
    setSelectedId(chunk.id);
    setDraft(next);
    setSavedSnapshot(snapshot(next));
    setCreating(false);
    setDeleteConfirm(false);
    setPendingOpenId(null);
    setError(null);
  }, []);

  const readChunk = useCallback(async (id: string) => {
    setLoadingChunk(true);
    setError(null);
    try {
      const chunk = await window.lopster?.knowledgeRead?.(id);
      if (!chunk) throw new Error(`Chunk not found: ${id}`);
      applyChunk(chunk);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingChunk(false);
    }
  }, [applyChunk]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingList(true);
      try {
        const result = await fetchCatalog();
        if (!cancelled && result.chunks?.[0]) await readChunk(result.chunks[0].id);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    };
    void load();
    const unsubscribe = window.lopster?.onKnowledgeChanged?.(() => {
      void fetchCatalog().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [fetchCatalog, readChunk]);

  const filteredChunks = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return chunks;
    return chunks.filter((chunk) =>
      chunk.id.toLowerCase().includes(query) ||
      chunk.title.toLowerCase().includes(query) ||
      chunk.source.toLowerCase().includes(query) ||
      chunk.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  }, [chunks, search]);

  const requestOpen = (id: string) => {
    if (id === selectedId && !creating) return;
    if (isDirty) {
      setPendingOpenId(id);
      return;
    }
    void readChunk(id);
  };

  const startCreate = () => {
    if (isDirty) {
      setPendingOpenId("__new__");
      return;
    }
    setSelectedId(null);
    setCreating(true);
    setDraft(EMPTY_DRAFT);
    setSavedSnapshot(snapshot(EMPTY_DRAFT));
    setViewMode("edit");
    setDeleteConfirm(false);
    setError(null);
    setNotice(null);
    setNoticeDetail("");
  };

  const discardAndContinue = () => {
    const target = pendingOpenId;
    setPendingOpenId(null);
    if (target === "__new__") {
      setSelectedId(null);
      setCreating(true);
      setDraft(EMPTY_DRAFT);
      setSavedSnapshot(snapshot(EMPTY_DRAFT));
      setViewMode("edit");
      return;
    }
    if (target) void readChunk(target);
  };

  const saveChunk = useCallback(async () => {
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title) {
      setError("Chunk title is required");
      return;
    }
    if (!content) {
      setError("Markdown content cannot be empty");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const payload = {
      title,
      content,
      tags: parseList(draft.tagsText),
      links: parseList(draft.linksText),
      source: draft.source.trim() || "knowledge-workspace",
    };
    try {
      if (creating || !selectedId) {
        const result = await window.lopster?.knowledgeCreate?.(payload);
        const created = result?.created || [];
        if (!created.length) {
          const duplicate = result?.duplicates?.[0];
          if (duplicate?.id) {
            setNotice("An identical chunk already exists. Opened the existing chunk.");
            setNoticeDetail("");
            await fetchCatalog();
            await readChunk(duplicate.id);
            return;
          }
          throw new Error("No chunk was created");
        }
        await fetchCatalog();
        await readChunk(created[0].id);
        setNotice(created.length > 1 ? `Saved as ${created.length} chunks` : "Chunk created");
        setNoticeDetail("");
      } else {
        await window.lopster?.knowledgeUpdate?.(selectedId, payload);
        const next: ChunkDraft = {
          title: payload.title,
          content: payload.content,
          tagsText: payload.tags.join(", "),
          linksText: payload.links.join(", "),
          source: payload.source,
        };
        setDraft(next);
        setSavedSnapshot(snapshot(next));
        await fetchCatalog();
        setNotice("Chunk saved");
        setNoticeDetail("");
      }
      setDeleteConfirm(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [creating, draft, fetchCatalog, readChunk, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (isDirty && !saving) void saveChunk();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDirty, saveChunk, saving]);

  const deleteChunk = async () => {
    if (!selectedId || creating) return;
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.lopster?.knowledgeDelete?.(selectedId);
      const result = await fetchCatalog();
      setNotice("Chunk deleted; its Markdown file was moved to the knowledge trash folder");
      setNoticeDetail("");
      setDeleteConfirm(false);
      if (result.chunks[0]) {
        await readChunk(result.chunks[0].id);
      } else {
        setSelectedId(null);
        setCreating(false);
        setDraft(EMPTY_DRAFT);
        setSavedSnapshot(snapshot(EMPTY_DRAFT));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const refresh = async () => {
    setLoadingList(true);
    try {
      await fetchCatalog();
      if (selectedId && !isDirty) await readChunk(selectedId);
      setNotice("Knowledge catalog refreshed");
      setNoticeDetail("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingList(false);
    }
  };

  const exportArchive = async () => {
    if (archiveBusy) return;
    setArchiveBusy("export");
    setError(null);
    setNotice(null);
    setNoticeDetail("");
    try {
      const result = await window.lopster?.knowledgeExport?.(rootPath);
      if (!result) throw new Error("Knowledge export is unavailable");
      const labels = result.copies.map((copy) =>
        copy.label === "desktop" ? "Desktop" : copy.label === "project" ? "project folder" : copy.label
      );
      const detail = [
        ...result.copies.map((copy) => `${copy.label}: ${copy.path}`),
        ...result.failures.map((item) => `${item.label} failed: ${item.error}`),
      ].join("\n");
      showNotice(
        `${result.archiveName} · ${result.chunkCount} chunks → ${labels.join(" + ")}`,
        detail
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setArchiveBusy(null);
    }
  };

  const importArchive = async () => {
    if (archiveBusy) return;
    setArchiveBusy("import");
    setError(null);
    setNotice(null);
    setNoticeDetail("");
    try {
      const result = await window.lopster?.knowledgeImport?.();
      if (!result) throw new Error("Knowledge import is unavailable");
      if ("canceled" in result) return;
      const catalogResult = await fetchCatalog();
      if (!isDirty) {
        const targetId = result.importedIds?.[0] || catalogResult.chunks[0]?.id;
        if (targetId) await readChunk(targetId);
      }
      const summary = [
        `${result.imported} imported`,
        result.duplicates ? `${result.duplicates} duplicates` : "",
        result.skipped ? `${result.skipped} skipped` : "",
        result.remappedLinks ? `${result.remappedLinks} links remapped` : "",
      ].filter(Boolean).join(" · ");
      showNotice(
        `${result.archiveName}: ${summary} · ${result.totalChunks} chunks total`,
        `${result.archivePath}\n${result.root}`
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setArchiveBusy(null);
    }
  };

  const previewMarkdown = `${draft.title ? `# ${draft.title}\n\n` : ""}${draft.content}`;

  if (pane === "neural") {
    return (
      <section className="knowledge-workspace is-neural">
        <React.Suspense
          fallback={
            <div className="knowledge-neural">
              <div className="knowledge-neural-status">
                <span>Загрузка…</span>
              </div>
            </div>
          }
        >
          <KnowledgeNeural
            chunks={chunks}
            onBack={() => setPane("library")}
            onOpen={(id) => {
              setPane("library");
              void readChunk(id);
            }}
          />
        </React.Suspense>
      </section>
    );
  }

  return (
    <section className="knowledge-workspace">
      <main className="knowledge-main">
        <header className="knowledge-toolbar">
          <div className="knowledge-toolbar-copy">
            <span className="knowledge-kicker">LAB-IN / SHARED MEMORY</span>
            <div className="knowledge-document-id">
              <FileText className="h-3.5 w-3.5" />
              <span>{creating ? "new chunk" : selectedId || "no chunk selected"}</span>
              {isDirty ? <i>modified</i> : null}
            </div>
          </div>
          <div className="knowledge-toolbar-actions">
            <div className="knowledge-view-toggle" aria-label="Knowledge section">
              <button type="button" className="is-active">
                <FileText className="h-3.5 w-3.5" /> Library
              </button>
              <button type="button" onClick={() => setPane("neural")}>
                <Spline className="h-3.5 w-3.5" /> Neural
              </button>
            </div>
            <button
              type="button"
              className="knowledge-action-btn"
              onClick={() => void exportArchive()}
              disabled={!chunks.length || Boolean(archiveBusy)}
              title="Export the whole knowledge base as a ZIP to the Desktop and the project folder"
            >
              {archiveBusy === "export" ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {archiveBusy === "export" ? "Exporting…" : "Export ZIP"}
            </button>
            <button
              type="button"
              className="knowledge-action-btn"
              onClick={() => void importArchive()}
              disabled={Boolean(archiveBusy)}
              title="Import a knowledge ZIP: chunks are normalised, duplicates skipped and links remapped into the base"
            >
              {archiveBusy === "import" ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {archiveBusy === "import" ? "Importing…" : "Import ZIP"}
            </button>
            <div className="knowledge-view-toggle" aria-label="Markdown view mode">
              <button
                type="button"
                className={viewMode === "preview" ? "is-active" : ""}
                onClick={() => setViewMode("preview")}
                disabled={!selectedId && !creating}
              >
                <Eye className="h-3.5 w-3.5" /> Preview
              </button>
              <button
                type="button"
                className={viewMode === "edit" ? "is-active" : ""}
                onClick={() => setViewMode("edit")}
                disabled={!selectedId && !creating}
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            </div>
            <button
              type="button"
              className="knowledge-action-btn"
              onClick={() => void saveChunk()}
              disabled={saving || !isDirty}
              title="Save chunk (Ctrl+S)"
            >
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </button>
            <button
              type="button"
              className={`knowledge-action-btn is-danger ${deleteConfirm ? "is-confirm" : ""}`}
              onClick={() => void deleteChunk()}
              disabled={!selectedId || creating || saving}
              title={deleteConfirm ? "Click again to confirm deletion" : "Delete chunk"}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteConfirm ? "Confirm" : "Delete"}
            </button>
            {deleteConfirm ? (
              <button type="button" className="knowledge-icon-btn" onClick={() => setDeleteConfirm(false)} title="Cancel delete">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </header>

        {pendingOpenId ? (
          <div className="knowledge-unsaved">
            <span>You have unsaved changes in this chunk.</span>
            <button type="button" onClick={discardAndContinue}>Discard and continue</button>
            <button type="button" onClick={() => setPendingOpenId(null)}>Keep editing</button>
          </div>
        ) : null}
        {error ? <div className="knowledge-message is-error">{error}</div> : null}
        {notice ? (
          <div className="knowledge-message" title={noticeDetail || notice}>
            <Check className="h-3.5 w-3.5" />
            {notice}
          </div>
        ) : null}

        <div className="knowledge-document-scroll">
          {loadingChunk ? (
            <div className="knowledge-empty"><RefreshCw className="h-5 w-5 animate-spin" /><span>Opening chunk…</span></div>
          ) : !selectedId && !creating ? (
            <div className="knowledge-empty">
              <Database className="h-9 w-9" />
              <strong>{chunks.length ? "Select a knowledge chunk" : "Shared memory is empty"}</strong>
              <span>{chunks.length ? "Choose a chunk from the panel on the right." : "Ask the AI to replenish memory, or create the first chunk manually."}</span>
              {!chunks.length ? <button type="button" onClick={startCreate}><Plus className="h-3.5 w-3.5" />Create first chunk</button> : null}
            </div>
          ) : viewMode === "edit" ? (
            <div className="knowledge-editor">
              <label>
                <span>Title</span>
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Clear knowledge title"
                  autoFocus={creating}
                />
              </label>
              <div className="knowledge-meta-grid">
                <label>
                  <span><Tags className="h-3 w-3" /> Tags</span>
                  <input
                    value={draft.tagsText}
                    onChange={(event) => setDraft((current) => ({ ...current, tagsText: event.target.value }))}
                    placeholder="architecture, guide, quality"
                  />
                </label>
                <label>
                  <span><Link2 className="h-3 w-3" /> Linked chunk IDs</span>
                  <input
                    value={draft.linksText}
                    onChange={(event) => setDraft((current) => ({ ...current, linksText: event.target.value }))}
                    placeholder="kb-…, kb-…"
                  />
                </label>
                <label>
                  <span>Source</span>
                  <input
                    value={draft.source}
                    onChange={(event) => setDraft((current) => ({ ...current, source: event.target.value }))}
                    placeholder="user-request"
                  />
                </label>
              </div>
              <label className="knowledge-markdown-field">
                <span>Markdown</span>
                <textarea
                  value={draft.content}
                  onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
                  spellCheck={false}
                  placeholder="# Knowledge\n\nWrite the chunk in Markdown…"
                />
              </label>
            </div>
          ) : (
            <article className="knowledge-preview prose-editor">
              <MarkdownContent content={previewMarkdown} />
              <footer className="knowledge-preview-meta">
                <div><span>Knowledge ID</span><code>{selectedId}</code></div>
                <div><span>Source</span><code>{draft.source || "—"}</code></div>
                <div><span>Tags</span><p>{parseList(draft.tagsText).join(" · ") || "—"}</p></div>
                <div><span>Links</span><p>{parseList(draft.linksText).join(" · ") || "—"}</p></div>
              </footer>
            </article>
          )}
        </div>
      </main>

      <aside className="knowledge-sidebar">
        <header>
          <div>
            <span>KNOWLEDGE CHUNKS</span>
            <strong>{catalog?.chunkCount || 0}</strong>
          </div>
          <div className="knowledge-sidebar-actions">
            <button type="button" onClick={startCreate} title="New chunk"><Plus className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => void refresh()} title="Refresh" disabled={loadingList}>
              <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? "animate-spin" : ""}`} />
            </button>
          </div>
        </header>
        <div className="knowledge-stats">
          <span>{formatSize(catalog?.totalChars || 0)}</span>
          <span>global</span>
          <span>userData</span>
        </div>
        <label className="knowledge-search">
          <Search className="h-3.5 w-3.5" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search chunks…" />
          {search ? <button type="button" onClick={() => setSearch("")}><X className="h-3 w-3" /></button> : null}
        </label>
        <div className="knowledge-chunk-list">
          {loadingList && !chunks.length ? (
            <div className="knowledge-list-empty">Loading shared memory…</div>
          ) : !filteredChunks.length ? (
            <div className="knowledge-list-empty">{search ? "No matching chunks" : "No chunks yet"}</div>
          ) : filteredChunks.map((chunk) => (
            <button
              type="button"
              key={chunk.id}
              className={`knowledge-chunk-card ${selectedId === chunk.id && !creating ? "is-active" : ""}`}
              onClick={() => requestOpen(chunk.id)}
            >
              <span className="knowledge-chunk-title">{chunk.title}</span>
              <span className="knowledge-chunk-id">{chunk.id}</span>
              {chunk.tags.length ? (
                <span className="knowledge-chunk-tags">
                  {chunk.tags.slice(0, 3).map((tag) => <i key={tag}>{tag}</i>)}
                  {chunk.tags.length > 3 ? <i>+{chunk.tags.length - 3}</i> : null}
                </span>
              ) : null}
              <span className="knowledge-chunk-foot">
                <span>{formatSize(chunk.charCount)}</span>
                <span>{formatDate(chunk.updatedAt)}</span>
              </span>
            </button>
          ))}
        </div>
        <footer title={catalog?.root || ""}>
          <Database className="h-3 w-3" />
          <span>{catalog?.root || "userData/lab-in/knowledge"}</span>
        </footer>
      </aside>
    </section>
  );
};

export default KnowledgeWorkspace;
