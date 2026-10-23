import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  FileText,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";

type Prompt = {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Prompts workspace — lives inside the Шторы (blinds) drawer.
 *
 * Left: searchable list of saved prompts (search by title AND text). Right:
 * the selected prompt's editor (title + full text) with save / new / copy /
 * delete. Everything is persisted as a single JSON file under Electron
 * userData through narrow IPC endpoints.
 */
const PromptsWorkspace: React.FC = () => {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  /** Corrupt JSON / storage failure → read-only error state, edits blocked. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<number | null>(null);

  const clearFlash = useCallback(() => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setSavedFlash(false);
      setCopiedFlash(false);
    }, 1800);
  }, []);

  const loadPrompts = useCallback(async () => {
    try {
      const result = await window.lopster?.promptsList?.();
      if (!result || !Array.isArray(result.prompts)) {
        throw new Error("Хранилище промтов недоступно.");
      }
      setPrompts(result.prompts);
      setLoadError(null);
      return result.prompts;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  const openPrompt = useCallback((prompt: Prompt) => {
    setSelectedId(prompt.id);
    setTitle(prompt.title);
    setText(prompt.text);
    setDirty(false);
    setSaveError(null);
    setLoadError(null);
  }, []);

  const resetEditor = useCallback(() => {
    setSelectedId(null);
    setTitle("");
    setText("");
    setDirty(false);
    setSaveError(null);
  }, []);

  /** Confirm before discarding unsaved changes when switching prompts. */
  const guardDiscard = useCallback((): boolean => {
    if (!dirty) return true;
    return window.confirm(
      "Есть несохранённые изменения. Переключиться и потерять их?"
    );
  }, [dirty]);

  const handleSelect = useCallback(
    (prompt: Prompt) => {
      if (selectedId === prompt.id) return;
      if (!guardDiscard()) return;
      openPrompt(prompt);
    },
    [guardDiscard, openPrompt, selectedId]
  );

  const handleNew = useCallback(() => {
    if (!guardDiscard()) return;
    resetEditor();
    window.setTimeout(() => titleRef.current?.focus(), 0);
  }, [guardDiscard, resetEditor]);

  const handleSave = useCallback(async () => {
    const cleanTitle = title.trim();
    const cleanText = text.replace(/\r\n?/g, "\n");
    if (!cleanTitle) {
      setSaveError("Заголовок промта не может быть пустым.");
      return;
    }
    if (!cleanText.trim()) {
      setSaveError("Текст промта не может быть пустым.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (selectedId) {
        const updated = await window.lopster?.promptsUpdate?.(selectedId, {
          title: cleanTitle,
          text: cleanText,
        });
        if (!updated) throw new Error("Промт не найден.");
        setPrompts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      } else {
        const created = await window.lopster?.promptsCreate?.({
          title: cleanTitle,
          text: cleanText,
        });
        if (!created) throw new Error("Не удалось создать промт.");
        setPrompts((prev) => [created, ...prev]);
        setSelectedId(created.id);
        setTitle(created.title);
        setText(created.text);
      }
      setDirty(false);
      setSavedFlash(true);
      clearFlash();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [title, text, selectedId, clearFlash]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    if (!window.confirm("Удалить этот промт? Действие нельзя отменить.")) return;
    try {
      const result = await window.lopster?.promptsDelete?.(selectedId);
      if (!result?.deleted) throw new Error("Промт не найден.");
      setPrompts((prev) => prev.filter((p) => p.id !== selectedId));
      resetEditor();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selectedId, resetEditor]);

  const handleCopy = useCallback(async () => {
    if (!selectedId) return;
    const result = await window.lopster?.promptsCopy?.(selectedId);
    if (result?.ok) {
      setCopiedFlash(true);
      clearFlash();
    } else {
      setSaveError(result?.error || "Не удалось скопировать промт.");
    }
  }, [selectedId, clearFlash]);

  // Initial load + live refresh from other windows (or the copy modal's writes).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const list = await loadPrompts();
      if (cancelled) return;
      setLoading(false);
      if (list && list.length) {
        setSelectedId(list[0].id);
        setTitle(list[0].title);
        setText(list[0].text);
      }
    })();
    const unsubscribe = window.lopster?.onPromptsChanged?.(() => {
      void loadPrompts();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [loadPrompts]);

  // Track dirty state while typing.
  const onTitleChange = (value: string) => {
    setTitle(value);
    setDirty(true);
    setSavedFlash(false);
    setCopiedFlash(false);
  };
  const onTextChange = (value: string) => {
    setText(value);
    setDirty(true);
    setSavedFlash(false);
    setCopiedFlash(false);
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter(
      (prompt) =>
        prompt.title.toLowerCase().includes(query) ||
        prompt.text.toLowerCase().includes(query)
    );
  }, [prompts, search]);

  const selected = prompts.find((p) => p.id === selectedId) || null;

  return (
    <section className="prompts-workspace">
      <aside className="prompts-sidebar">
        <header className="prompts-sidebar-head">
          <div>
            <span className="prompts-sidebar-kicker">PROMPTS</span>
            <strong>{prompts.length}</strong>
          </div>
          <button
            type="button"
            className="prompts-new-btn"
            onClick={handleNew}
            title="Новый промт"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Новый</span>
          </button>
        </header>

        <label className="prompts-search">
          <Search className="h-3.5 w-3.5" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Поиск по заголовку и тексту…"
            spellCheck={false}
          />
          {search ? (
            <button type="button" onClick={() => setSearch("")} aria-label="Очистить поиск">
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </label>

        <ChatMonoScroll className="prompts-section-scroll">
          <div className="prompts-section-list">
            {loading && !prompts.length ? (
              <div className="prompts-list-empty">Загрузка промтов…</div>
            ) : !filtered.length ? (
              <div className="prompts-list-empty">
                {search ? "Ничего не найдено" : "Промтов пока нет"}
              </div>
            ) : (
              filtered.map((prompt) => (
                <button
                  type="button"
                  key={prompt.id}
                  className={`prompts-card${selectedId === prompt.id ? " is-active" : ""}`}
                  onClick={() => handleSelect(prompt)}
                >
                  <span className="prompts-card-title">{prompt.title}</span>
                  <span className="prompts-card-preview">{prompt.text}</span>
                </button>
              ))
            )}
          </div>
        </ChatMonoScroll>
      </aside>

      <main className="prompts-main">
        <header className="prompts-toolbar">
          <div className="prompts-toolbar-copy">
            <span className="prompts-kicker">PROMPTS / EDITOR</span>
            <div className="prompts-document-id">
              <FileText className="h-3.5 w-3.5" />
              <span>{selected ? selected.title : "новый промт"}</span>
              {dirty ? <em>● изменён</em> : null}
            </div>
          </div>
          <div className="prompts-toolbar-actions">
            <button
              type="button"
              className="prompts-action-btn"
              onClick={handleCopy}
              disabled={!selectedId}
              title="Скопировать текст промта"
            >
              {copiedFlash ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedFlash ? "Скопировано" : "Копировать"}</span>
            </button>
            <button
              type="button"
              className="prompts-action-btn is-danger"
              onClick={handleDelete}
              disabled={!selectedId}
              title="Удалить промт"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Удалить</span>
            </button>
          </div>
        </header>

        <div className="prompts-editor">
          {loadError ? (
            <div className="prompts-state is-error">
              <X className="h-8 w-8" />
              <p>{loadError}</p>
              <span>Файл не изменён. Исправьте или удалите повреждённый JSON и перезапустите приложение.</span>
            </div>
          ) : (
            <div className="prompts-editor-form">
              <label className="prompts-title-field">
                <span>Заголовок</span>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => onTitleChange(event.target.value)}
                  placeholder="Например: системный промт для ревью кода"
                  spellCheck={false}
                />
              </label>
              <label className="prompts-text-field">
                <span>Текст промта</span>
                <textarea
                  value={text}
                  onChange={(event) => onTextChange(event.target.value)}
                  placeholder="Введите текст промта…"
                  spellCheck={false}
                />
              </label>
            </div>
          )}
        </div>

        <footer className="prompts-footer">
          <div className="prompts-footer-status">
            {saveError ? (
              <span className="prompts-save-error">{saveError}</span>
            ) : savedFlash ? (
              <span className="prompts-saved"><Check className="h-3.5 w-3.5" /> Сохранено</span>
            ) : (
              <span className="prompts-chars">{text.length} символов</span>
            )}
          </div>
          <button
            type="button"
            className="prompts-save-btn"
            onClick={handleSave}
            disabled={saving || loadError != null}
          >
            <Save className="h-3.5 w-3.5" />
            <span>{saving ? "Сохранение…" : "Сохранить"}</span>
          </button>
        </footer>
      </main>
    </section>
  );
};

export default PromptsWorkspace;
