import React, { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, FileText, Search, X } from "lucide-react";
import MarkdownContent from "./markdown/MarkdownContent";
import ChatMonoScroll from "./ChatMonoScroll";

/** Section metadata — no body — returned by docs:list. */
type DocsSectionMeta = {
  id: string;
  title: string;
  summary: string;
  order: number;
  createdAt: number;
  updatedAt: number;
};

type DocsSection = DocsSectionMeta & { content: string };

/**
 * IDE documentation workspace.
 *
 * Left: searchable list of sections (search by title). Right: the rendered
 * Markdown of the selected section. Content is served from a JSON store under
 * Electron userData (not localStorage) through narrow IPC endpoints.
 */
const DocsWorkspace: React.FC = () => {
  const [sections, setSections] = useState<DocsSectionMeta[]>([]);
  const [sectionCount, setSectionCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [summary, setSummary] = useState<string>("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const result = await window.lopster?.docsList?.();
      if (!result) throw new Error("Docs storage is unavailable");
      setSections(result.sections || []);
      setSectionCount(result.sectionCount || 0);
      if (!result.sections?.length) {
        setSelectedId(null);
        setContent("");
        setTitle("");
        setSummary("");
      }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  const openSection = useCallback(async (id: string) => {
    setError(null);
    try {
      const section = await window.lopster?.docsRead?.(id);
      if (!section) throw new Error(`Section not found: ${id}`);
      setSelectedId(id);
      setTitle(section.title);
      setSummary(section.summary);
      setContent(section.content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const result = await refreshList();
      if (cancelled) return;
      setLoading(false);
      const first = result?.sections?.[0];
      if (first) await openSection(first.id);
    })();
    const unsubscribe = window.lopster?.onDocsChanged?.(() => {
      void refreshList();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [refreshList, openSection]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return sections;
    return sections.filter(
      (section) =>
        section.title.toLowerCase().includes(query) ||
        section.summary.toLowerCase().includes(query)
    );
  }, [sections, search]);

  return (
    <section className="docs-workspace">
      <aside className="docs-sidebar">
        <header className="docs-sidebar-head">
          <div>
            <span className="docs-sidebar-kicker">DOCUMENTATION</span>
            <strong>{sectionCount}</strong>
          </div>
          <span className="docs-sidebar-meta">IDE manual</span>
        </header>

        <label className="docs-search">
          <Search className="h-3.5 w-3.5" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title…"
            spellCheck={false}
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="Clear search">
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </label>

        <ChatMonoScroll className="docs-section-scroll">
          <div className="docs-section-list">
            {loading && !sections.length ? (
              <div className="docs-list-empty">Loading documentation…</div>
            ) : !filtered.length ? (
              <div className="docs-list-empty">{search ? "No matching sections" : "No sections yet"}</div>
            ) : (
              filtered.map((section) => (
                <button
                  type="button"
                  key={section.id}
                  className={`docs-section-card${selectedId === section.id ? " is-active" : ""}`}
                  onClick={() => void openSection(section.id)}
                >
                  <span className="docs-section-title">{section.title}</span>
                  {section.summary ? (
                    <span className="docs-section-summary">{section.summary}</span>
                  ) : null}
                </button>
              ))
            )}
          </div>
        </ChatMonoScroll>
      </aside>

      <main className="docs-main">
        <header className="docs-toolbar">
          <div className="docs-toolbar-copy">
            <span className="docs-kicker">DOCS / IDE MANUAL</span>
            <div className="docs-document-id">
              <FileText className="h-3.5 w-3.5" />
              <span>{selectedId || "no section selected"}</span>
            </div>
          </div>
        </header>

        <ChatMonoScroll className="docs-content">
          <div className="docs-content-inner">
            {error ? (
              <div className="docs-state is-error">
                <X className="h-8 w-8" />
                <p>{error}</p>
              </div>
            ) : !selectedId ? (
              <div className="docs-state">
                <BookOpen className="h-10 w-10" aria-hidden />
                <h2>Documentation</h2>
                <p>Выберите раздел слева, чтобы прочитать его.</p>
              </div>
            ) : (
              <article className="docs-article">
                <h1 className="docs-article-title">{title}</h1>
                {summary ? <p className="docs-article-summary">{summary}</p> : null}
                <MarkdownContent content={content} />
              </article>
            )}
          </div>
        </ChatMonoScroll>
      </main>
    </section>
  );
};

export default DocsWorkspace;
