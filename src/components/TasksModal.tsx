import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Clock, ListTodo, Plus, Search, Trash2, X } from "lucide-react";
import ChatMonoScroll, { type ChatMonoScrollHandle } from "./ChatMonoScroll";
import { TaskItem } from "../types";

type TaskFilter = "all" | "open" | "done";

const TASK_ID_PREFIX = "task";

function nextTaskId(): string {
  return `${TASK_ID_PREFIX}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Open tasks first (newest on top), completed below (most recently finished first). */
function sortTasks(tasks: TaskItem[]): TaskItem[] {
  return [...tasks].sort((a, b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) return (b.updatedAt || 0) - (a.updatedAt || 0);
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function formatRelative(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "только что";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч назад`;
  if (diff < 86_400_000 * 7) return `${Math.floor(diff / 86_400_000)} дн назад`;
  return new Date(timestamp).toLocaleDateString();
}

function formatStamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  return new Date(timestamp).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TasksModalProps {
  onClose: () => void;
}

const TasksModal: React.FC<TasksModalProps> = ({ onClose }) => {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const tasksRef = useRef<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const listScrollRef = useRef<ChatMonoScrollHandle>(null);
  const detailScrollRef = useRef<ChatMonoScrollHandle>(null);
  const createTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  const applyTasks = useCallback((next: TaskItem[]) => {
    const sorted = sortTasks(next);
    tasksRef.current = sorted;
    setTasks(sorted);
  }, []);

  const persist = useCallback(
    (next: TaskItem[]) => {
      applyTasks(next);
      // Serialize writes so two fast toggles cannot land out of order. Each queued
      // write sends the latest snapshot, which keeps the file idempotent.
      saveChainRef.current = saveChainRef.current
        .catch(() => undefined)
        .then(async () => {
          try {
            await window.lopster?.saveTasks?.(tasksRef.current);
            setError(null);
          } catch {
            setError("Не удалось сохранить задачи");
          }
        });
    },
    [applyTasks]
  );

  const flushDraft = useCallback(() => {
    if (creating) return;
    const current = tasksRef.current.find((task) => task.id === selectedId);
    const text = draft.trim();
    if (!current || !text || text === current.text) return;
    persist(
      tasksRef.current.map((task) =>
        task.id === current.id ? { ...task, text, updatedAt: Date.now() } : task
      )
    );
  }, [creating, draft, persist, selectedId]);

  const selectTask = useCallback(
    (id: string) => {
      flushDraft();
      setCreating(false);
      setSelectedId(id);
      setPendingDeleteId(null);
      const next = tasksRef.current.find((task) => task.id === id);
      setDraft(next?.text || "");
    },
    [flushDraft]
  );

  const startCreate = useCallback(() => {
    flushDraft();
    setCreating(true);
    setSelectedId(null);
    setPendingDeleteId(null);
    setDraft("");
    setError(null);
    setQuery("");
    setFilter("all");
  }, [flushDraft]);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setDraft("");
    setError(null);
    const first = tasksRef.current.find((task) => !task.completed) || tasksRef.current[0];
    if (first) {
      setSelectedId(first.id);
      setDraft(first.text);
    }
  }, []);

  const handleClose = useCallback(() => {
    flushDraft();
    onClose();
  }, [flushDraft, onClose]);

  const createTask = useCallback(() => {
    const text = draft.trim();
    if (!text) {
      setError("Введите текст задачи");
      return;
    }
    const now = Date.now();
    const task: TaskItem = {
      id: nextTaskId(),
      text,
      completed: false,
      createdAt: now,
      updatedAt: now,
    };
    persist([task, ...tasksRef.current]);
    setCreating(false);
    setSelectedId(task.id);
    setDraft(text);
    setError(null);
  }, [draft, persist]);

  const toggleTask = useCallback(
    (id: string) => {
      persist(
        tasksRef.current.map((task) =>
          task.id === id ? { ...task, completed: !task.completed, updatedAt: Date.now() } : task
        )
      );
    },
    [persist]
  );

  const removeTask = useCallback(
    (id: string) => {
      const remaining = tasksRef.current.filter((task) => task.id !== id);
      persist(remaining);
      setPendingDeleteId(null);
      if (selectedId === id) {
        const next = sortTasks(remaining)[0] || null;
        setSelectedId(next?.id ?? null);
        setDraft(next?.text ?? "");
      }
      if (creating) setCreating(false);
    },
    [creating, persist, selectedId]
  );

  const requestDelete = useCallback(
    (id: string) => {
      selectTask(id);
      setPendingDeleteId(id);
    },
    [selectTask]
  );

  const selected = useMemo(
    () => tasks.find((task) => task.id === selectedId) || null,
    [tasks, selectedId]
  );

  const counts = useMemo(() => {
    const done = tasks.filter((task) => task.completed).length;
    return { total: tasks.length, done, open: tasks.length - done };
  }, [tasks]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filter === "open" && task.completed) return false;
      if (filter === "done" && !task.completed) return false;
      if (!needle) return true;
      return task.text.toLowerCase().includes(needle);
    });
  }, [tasks, query, filter]);

  const openItems = useMemo(() => visible.filter((task) => !task.completed), [visible]);
  const doneItems = useMemo(() => visible.filter((task) => task.completed), [visible]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.lopster
      ?.readTasks?.()
      .then((list) => {
        if (cancelled) return;
        const normalized = sortTasks(Array.isArray(list) ? list : []);
        tasksRef.current = normalized;
        setTasks(normalized);
        const first = normalized.find((task) => !task.completed) || normalized[0] || null;
        setSelectedId(first?.id ?? null);
        setDraft(first?.text ?? "");
      })
      .catch(() => {
        if (!cancelled) setError("Не удалось загрузить задачи");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Autosave the open task's title after a short idle period.
  useEffect(() => {
    if (creating || !selected) return;
    const text = draft.trim();
    if (!text || text === selected.text) return;
    const timer = window.setTimeout(() => {
      persist(
        tasksRef.current.map((task) =>
          task.id === selected.id ? { ...task, text, updatedAt: Date.now() } : task
        )
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [creating, draft, selected, persist]);

  // The task text belongs to the pane scroll, not to a nested scroller: the
  // textarea always grows to its content, so wheel events over the text scroll
  // the ChatMonoScroll viewport (the only scroll owner in the detail pane).
  useEffect(() => {
    const el = creating ? createTextareaRef.current : editTextareaRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // Rewrapping after a window/modal resize changes the content height.
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [creating, draft, selectedId]);

  // Opening another task starts the detail pane at the top again.
  useEffect(() => {
    const viewport = detailScrollRef.current?.getViewport();
    if (viewport) viewport.scrollTop = 0;
  }, [creating, selectedId]);

  // New search/filter results start from the first row.
  useEffect(() => {
    const viewport = listScrollRef.current?.getViewport();
    if (viewport) viewport.scrollTop = 0;
  }, [filter, query]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (creating) {
        event.preventDefault();
        cancelCreate();
        return;
      }
      if (pendingDeleteId) {
        event.preventDefault();
        setPendingDeleteId(null);
        return;
      }
      handleClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [cancelCreate, creating, handleClose, pendingDeleteId]);

  const renderRow = (task: TaskItem) => {
    const active = task.id === selectedId && !creating;
    const awaitingDelete = task.id === pendingDeleteId;
    return (
      <div
        key={task.id}
        className={`tasks-row${active ? " is-active" : ""}${task.completed ? " is-done" : ""}`}
      >
        <button
          type="button"
          className="tasks-row-check"
          onClick={(event) => {
            event.stopPropagation();
            toggleTask(task.id);
          }}
          title={task.completed ? "Вернуть в работу" : "Отметить выполненной"}
          aria-label={task.completed ? "Вернуть в работу" : "Отметить выполненной"}
          aria-pressed={task.completed}
        >
          {task.completed ? <Check aria-hidden /> : null}
        </button>
        <button type="button" className="tasks-row-main" onClick={() => selectTask(task.id)}>
          <span className="tasks-row-text">{task.text}</span>
          <span className="tasks-row-meta">
            <Clock aria-hidden />
            {task.completed ? "выполнено · " : ""}
            {formatRelative(task.updatedAt)}
          </span>
        </button>
        <button
          type="button"
          className={`tasks-row-delete${awaitingDelete ? " is-armed" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            requestDelete(task.id);
          }}
          title={awaitingDelete ? "Подтвердите удаление" : "Удалить задачу"}
          aria-label={awaitingDelete ? "Подтвердите удаление" : "Удалить задачу"}
        >
          <Trash2 aria-hidden />
        </button>
      </div>
    );
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 theme-scrim animate-fade-in"
      role="presentation"
      onClick={handleClose}
    >
      <section
        className="tasks-modal bg-ink-0 border border-ink-200 rounded-xl overflow-hidden flex flex-col shadow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Задачи"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="tasks-modal-head theme-strip">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="tasks-modal-badge">
              <ListTodo className="w-4 h-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <div className="tasks-modal-title">Задачи</div>
              <div className="tasks-modal-sub">
                {counts.open} активных · {counts.done} выполнено · общий список
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button type="button" className="tasks-primary theme-primary" onClick={startCreate}>
              <Plus className="w-3.5 h-3.5" aria-hidden />
              Новая
            </button>
            <button type="button" className="tasks-icon-btn" onClick={handleClose} aria-label="Закрыть">
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>
        </header>

        <div className="tasks-modal-body">
          <aside className="tasks-rail">
            <div className="tasks-search">
              <Search className="tasks-search-icon" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск задач…"
                spellCheck={false}
                autoComplete="off"
                aria-label="Поиск задач"
                className="tasks-search-input"
              />
              {query ? (
                <button
                  type="button"
                  className="tasks-search-clear"
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                  aria-label="Очистить поиск"
                >
                  <X className="w-3 h-3" aria-hidden />
                </button>
              ) : null}
            </div>

            <div className="tasks-filters" role="group" aria-label="Фильтр задач">
              {(
                [
                  ["all", "Все", counts.total],
                  ["open", "Активные", counts.open],
                  ["done", "Выполнено", counts.done],
                ] as Array<[TaskFilter, string, number]>
              ).map(([key, label, count]) => (
                <button
                  key={key}
                  type="button"
                  className={`tasks-filter${filter === key ? " is-active" : ""}`}
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                >
                  {label}
                  <span>{count}</span>
                </button>
              ))}
            </div>

            <ChatMonoScroll ref={listScrollRef} className="tasks-list">
              {loading ? (
                <div className="tasks-empty">Загрузка…</div>
              ) : visible.length === 0 ? (
                <div className="tasks-empty">
                  <ListTodo aria-hidden />
                  <span>
                    {query.trim()
                      ? "Ничего не найдено"
                      : filter === "done"
                        ? "Выполненных задач нет"
                        : "Задач пока нет"}
                  </span>
                  {!query.trim() && filter !== "done" ? (
                    <button type="button" className="tasks-empty-add" onClick={startCreate}>
                      <Plus className="w-3 h-3" aria-hidden />
                      Создать задачу
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="tasks-list-inner">
                  {openItems.length > 0 ? (
                    <div className="tasks-group-label">
                      <span>Активные</span>
                      <span>{openItems.length}</span>
                    </div>
                  ) : null}
                  {openItems.map(renderRow)}
                  {doneItems.length > 0 ? (
                    <div className="tasks-group-label">
                      <span>Выполнено</span>
                      <span>{doneItems.length}</span>
                    </div>
                  ) : null}
                  {doneItems.map(renderRow)}
                </div>
              )}
            </ChatMonoScroll>

            <footer className="tasks-rail-foot">
              <span>{counts.total} всего</span>
              <span>глобальные задачи</span>
            </footer>
          </aside>

          <section className="tasks-detail">
            {creating ? (
              <ChatMonoScroll ref={detailScrollRef} className="tasks-detail-scroll">
                <div className="tasks-detail-inner">
                  <div className="tasks-detail-kicker">Новая задача</div>
                  <textarea
                    ref={createTextareaRef}
                    autoFocus
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(event) => {
                      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                        event.preventDefault();
                        createTask();
                      }
                    }}
                    rows={5}
                    placeholder="Что нужно сделать?"
                    className="tasks-editor tasks-editor-create"
                    aria-label="Текст новой задачи"
                  />
                  <div className="tasks-detail-actions">
                    <button type="button" className="tasks-ghost" onClick={cancelCreate}>
                      Отмена
                    </button>
                    <button
                      type="button"
                      className="tasks-primary theme-primary"
                      onClick={createTask}
                      disabled={!draft.trim()}
                    >
                      <Check className="w-3.5 h-3.5" aria-hidden />
                      Создать задачу
                    </button>
                  </div>
                  <div className="tasks-hint">Ctrl+Enter — создать · Esc — отмена</div>
                </div>
              </ChatMonoScroll>
            ) : selected ? (
              <ChatMonoScroll ref={detailScrollRef} className="tasks-detail-scroll">
                <div className="tasks-detail-inner">
                  <div className="tasks-detail-head">
                    <button
                      type="button"
                      className={`tasks-detail-check${selected.completed ? " is-done" : ""}`}
                      onClick={() => toggleTask(selected.id)}
                      title={selected.completed ? "Вернуть в работу" : "Отметить выполненной"}
                      aria-label={selected.completed ? "Вернуть в работу" : "Отметить выполненной"}
                      aria-pressed={selected.completed}
                    >
                      {selected.completed ? <Check className="w-4 h-4" aria-hidden /> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="tasks-detail-kicker">
                        {selected.completed ? "Выполнена" : "В работе"}
                      </div>
                      <div className="tasks-detail-id" title={selected.id}>
                        task://{selected.id.slice(0, 18)}
                      </div>
                    </div>
                  </div>

                  <textarea
                    ref={editTextareaRef}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                        event.preventDefault();
                        const text = draft.trim();
                        if (text && text !== selected.text) {
                          persist(
                            tasksRef.current.map((task) =>
                              task.id === selected.id
                                ? { ...task, text, updatedAt: Date.now() }
                                : task
                            )
                          );
                        }
                      }
                    }}
                    rows={8}
                    className="tasks-editor"
                    aria-label="Текст задачи"
                  />

                  <div className="tasks-meta">
                    <span>создана {formatStamp(selected.createdAt)}</span>
                    <span className="tasks-meta-dot" aria-hidden />
                    <span>изменена {formatStamp(selected.updatedAt)}</span>
                  </div>

                  <div className="tasks-detail-actions">
                    <button
                      type="button"
                      className="tasks-ghost"
                      onClick={() => toggleTask(selected.id)}
                    >
                      {selected.completed ? "Вернуть в работу" : "Отметить выполненной"}
                    </button>
                    {pendingDeleteId === selected.id ? (
                      <div className="tasks-confirm">
                        <span>Удалить задачу?</span>
                        <button
                          type="button"
                          className="tasks-danger"
                          onClick={() => removeTask(selected.id)}
                        >
                          Удалить
                        </button>
                        <button
                          type="button"
                          className="tasks-ghost"
                          onClick={() => setPendingDeleteId(null)}
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="tasks-ghost tasks-ghost-danger"
                        onClick={() => setPendingDeleteId(selected.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden />
                        Удалить
                      </button>
                    )}
                  </div>

                  <div className="tasks-hint">
                    Изменения сохраняются автоматически · Ctrl+Enter — сохранить сразу · Esc —
                    закрыть
                  </div>
                </div>
              </ChatMonoScroll>
            ) : (
              <ChatMonoScroll className="tasks-detail-scroll">
                <div className="tasks-detail-empty">
                  <ListTodo aria-hidden />
                  <div className="tasks-detail-empty-title">Задача не выбрана</div>
                  <div className="tasks-detail-empty-sub">
                    Выберите задачу слева или создайте новую.
                  </div>
                  <button type="button" className="tasks-primary theme-primary" onClick={startCreate}>
                    <Plus className="w-3.5 h-3.5" aria-hidden />
                    Новая задача
                  </button>
                </div>
              </ChatMonoScroll>
            )}
          </section>
        </div>

        {error ? (
          <div className="tasks-error" role="alert">
            {error}
          </div>
        ) : null}
      </section>
    </div>,
    document.body
  );
};

export default TasksModal;
