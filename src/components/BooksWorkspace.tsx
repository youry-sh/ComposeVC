import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, Download, Library, Loader2, Quote, Search, Trash2, X } from "lucide-react";
import ChatMonoScroll, { type ChatMonoScrollHandle } from "./ChatMonoScroll";
import type { BookFull, BookMeta, BookQuote } from "../global";

function coverStyle(book: BookMeta): React.CSSProperties {
  const hue = [...book.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  return { "--book-hue": hue } as React.CSSProperties;
}

const BooksWorkspace: React.FC = () => {
  const [books, setBooks] = useState<BookMeta[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [opened, setOpened] = useState<BookFull | null>(null);
  const [chapter, setChapter] = useState(0);
  const [selection, setSelection] = useState("");
  const scrollRef = useRef<ChatMonoScrollHandle>(null);
  const positionTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const res = await window.lopster?.booksList?.({ query });
    if (res?.ok) setBooks(res.books || []);
    setLoading(false);
  }, [query]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 180); return () => window.clearTimeout(timer); }, [refresh]);
  useEffect(() => window.lopster?.onBooksChanged?.(() => void refresh()), [refresh]);
  useEffect(() => {
    if (!opened) return;
    const viewport = scrollRef.current?.getViewport();
    if (!viewport) return;
    const key = String(chapter);
    requestAnimationFrame(() => { viewport.scrollTop = opened.positions?.[key] || 0; });
    const remember = () => {
      if (positionTimer.current) window.clearTimeout(positionTimer.current);
      positionTimer.current = window.setTimeout(() => {
        const positions = { ...(opened.positions || {}), [key]: Math.max(0, Math.round(viewport.scrollTop)) };
        void window.lopster?.booksUpdate?.(opened.id, { positions });
      }, 350);
    };
    viewport.addEventListener("scroll", remember, { passive: true });
    return () => { viewport.removeEventListener("scroll", remember); if (positionTimer.current) window.clearTimeout(positionTimer.current); };
  }, [opened?.id, chapter]);

  const openBook = async (id: string) => {
    const res = await window.lopster?.booksGet?.(id);
    if (!res?.book) return;
    const next = res.book;
    const index = Math.max(0, Math.min(next.chapters.length - 1, next.lastChapter || 0));
    setOpened(next); setChapter(index); setSelection("");
  };
  const setPage = (next: number) => {
    if (!opened) return;
    const index = Math.max(0, Math.min(opened.chapters.length - 1, next));
    setChapter(index); setSelection("");
    scrollRef.current?.getViewport()?.scrollTo({ top: 0 });
    const progress = opened.chapters.length ? (index + 1) / opened.chapters.length : 0;
    setOpened({ ...opened, lastChapter: index, progress });
    void window.lopster?.booksUpdate?.(opened.id, { lastChapter: index, progress });
  };
  useEffect(() => {
    if (!opened) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" && chapter > 0) {
        event.preventDefault();
        setPage(chapter - 1);
      } else if (event.key === "ArrowRight" && chapter + 1 < opened.chapters.length) {
        event.preventDefault();
        setPage(chapter + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [opened, chapter]);
  const importBooks = async () => {
    setImporting(true);
    try { const res = await window.lopster?.booksImport?.(); if (res?.ok && res.books?.[0]) await openBook(res.books[0].id); }
    finally { setImporting(false); void refresh(); }
  };
  const remove = async (id: string) => {
    await window.lopster?.booksDelete?.(id);
    if (opened?.id === id) setOpened(null);
    void refresh();
  };
  const toggleRead = async () => {
    if (!opened) return; const read = !opened.read;
    setOpened({ ...opened, read }); await window.lopster?.booksUpdate?.(opened.id, { read }); void refresh();
  };
  const captureSelection = () => {
    const text = window.getSelection()?.toString().replace(/\s+/g, " ").trim() || "";
    setSelection(text.slice(0, 2000));
  };
  const saveQuote = async () => {
    if (!opened || !selection) return;
    const quote: BookQuote = { id: `q-${Date.now().toString(36)}`, text: selection, chapter, createdAt: Date.now() };
    const quotes = [...(opened.quotes || []), quote]; setOpened({ ...opened, quotes }); setSelection("");
    await window.lopster?.booksUpdate?.(opened.id, { quotes });
  };
  const deleteQuote = async (quoteId: string) => {
    if (!opened) return; const quotes = opened.quotes.filter((q) => q.id !== quoteId);
    setOpened({ ...opened, quotes }); await window.lopster?.booksUpdate?.(opened.id, { quotes });
  };

  const visible = useMemo(() => books, [books]);
  if (opened) {
    const current = opened.chapters[chapter];
    return (
      <div className="books-reader">
        <header className="books-reader-head">
          <button type="button" onClick={() => { setOpened(null); void refresh(); }}><ArrowLeft /> LIBRARY</button>
          <div><strong>{opened.title}</strong><span>{opened.author || "Неизвестный автор"}</span></div>
          <button type="button" className={opened.read ? "is-read" : ""} onClick={() => void toggleRead()}><Check /> {opened.read ? "ПРОЧИТАНО" : "ОТМЕТИТЬ"}</button>
        </header>
        <div className="books-reader-body">
          <nav className="books-chapters">
            <div className="books-side-label">СОДЕРЖАНИЕ</div>
            <ChatMonoScroll className="books-chapter-scroll">
              {opened.chapters.map((item, index) => <button key={item.id} className={index === chapter ? "is-active" : ""} onClick={() => setPage(index)}><span>{String(index + 1).padStart(2, "0")}</span>{item.title}</button>)}
            </ChatMonoScroll>
          </nav>
          <main className="books-reading-column">
            <ChatMonoScroll ref={scrollRef} className="books-page-scroll">
              <article className="books-page" onMouseUp={captureSelection}>
                <div className="books-page-kicker">{chapter + 1} / {opened.chapters.length}</div>
                <h1>{current?.title}</h1>
                <div className="books-page-content" dangerouslySetInnerHTML={{ __html: current?.html || "" }} />
              </article>
            </ChatMonoScroll>
            <footer className="books-page-nav">
              <button disabled={chapter === 0} onClick={() => setPage(chapter - 1)}><ChevronLeft /> НАЗАД</button>
              <div><i style={{ width: `${Math.round(opened.progress * 100)}%` }} /><span>← → · {Math.round(opened.progress * 100)}%</span></div>
              <button disabled={chapter + 1 >= opened.chapters.length} onClick={() => setPage(chapter + 1)}>ДАЛЬШЕ <ChevronRight /></button>
            </footer>
          </main>
          <aside className="books-quotes">
            <div className="books-side-label">ЦИТАТЫ <span>{opened.quotes.length}</span></div>
            {selection && <button className="books-save-quote" onClick={() => void saveQuote()}><Quote /> СОХРАНИТЬ ВЫДЕЛЕНИЕ</button>}
            <ChatMonoScroll className="books-quotes-scroll">
              {!opened.quotes.length && <p>Выделите текст книги мышью и сохраните его как цитату.</p>}
              {opened.quotes.map((item) => <blockquote key={item.id}><Quote /><p>{item.text}</p><footer><span>Глава {item.chapter + 1}</span><button onClick={() => void deleteQuote(item.id)}><X /></button></footer></blockquote>)}
            </ChatMonoScroll>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="books-shell">
      <header className="books-head">
        <div><Library /><span><strong>BOOKS</strong><small>личная библиотека</small></span></div>
        <label><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по книгам, авторам, описанию…" /></label>
        <button onClick={() => void importBooks()} disabled={importing}>{importing ? <Loader2 className="animate-spin" /> : <Download />} ИМПОРТ</button>
      </header>
      <ChatMonoScroll className="books-library-scroll">
        {loading ? <div className="books-empty"><Loader2 className="animate-spin" /> Загрузка библиотеки…</div> : !visible.length ? <div className="books-empty"><BookOpen /><strong>Библиотека пуста</strong><span>Импортируйте FB2, FB3, EPUB, PDF или TXT — книга будет преобразована и сохранена один раз.</span><button onClick={() => void importBooks()}>ИМПОРТИРОВАТЬ КНИГУ</button></div> : <div className="books-grid">
          {visible.map((book) => <article className="book-card" key={book.id} style={coverStyle(book)}>
            <button className="book-cover" onClick={() => void openBook(book.id)}>{book.cover ? <img src={book.cover} alt="" /> : <span><BookOpen /><b>{book.title}</b><small>{book.author}</small></span>}{book.read && <i><Check /></i>}</button>
            <div className="book-meta"><strong title={book.title}>{book.title}</strong><span>{book.author || "Неизвестный автор"}</span><p>{book.description || "Описание отсутствует"}</p><div className="book-progress"><i style={{ width: `${Math.round(book.progress * 100)}%` }} /></div></div>
            <footer><button onClick={() => void openBook(book.id)}>ОТКРЫТЬ</button><span>{book.format}</span><button title="Удалить" onClick={() => void remove(book.id)}><Trash2 /></button></footer>
          </article>)}
        </div>}
      </ChatMonoScroll>
    </div>
  );
};

export default BooksWorkspace;
