import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, Search, Trash2, X } from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";

/**
 * TODO workspace — one board: tasks (left) + habits (right).
 * Each habit shows its full 5-year square field right there; click any square
 * to fill it. No dates, no calendar — just squares. Done tasks strike through
 * and sink to the bottom. Everything persists as JSON in localStorage.
 */

const STORE_KEY = "composevc-todo";
/** 5 years of daily squares, shown all at once per habit. */
const HABIT_SQUARES = 5 * 365; // 1825

type Task = { id: string; text: string; done: boolean; createdAt: number; doneAt: number | null };
type Habit = { id: string; name: string; createdAt: number; filled: number[] };
type Store = { v: 2; tasks: Task[]; habits: Habit[] };

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const tasks = Array.isArray(parsed.tasks) ? (parsed.tasks as Task[]) : [];
      const habits = Array.isArray(parsed.habits)
        ? (parsed.habits as Array<Record<string, unknown>>).map((h) => ({
            id: String(h.id || uid()),
            name: String(h.name || "Привычка"),
            createdAt: typeof h.createdAt === "number" ? h.createdAt : Date.now(),
            // v1 stored date strings in `marks` — carry the count over as leading squares.
            filled: Array.isArray(h.filled)
              ? (h.filled as number[])
              : Array.isArray(h.marks)
                ? (h.marks as unknown[]).map((_, i) => i)
                : [],
          }))
        : [];
      return { v: 2, tasks, habits };
    }
  } catch {
    /* ignore */
  }
  return { v: 2, tasks: [], habits: [] };
}
function saveStore(store: Store) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

/** All 5-year squares for one habit, filled by index. */
const HabitField: React.FC<{
  habit: Habit;
  onToggle: (habitId: string, index: number) => void;
}> = ({ habit, onToggle }) => {
  const filled = useMemo(() => new Set(habit.filled), [habit.filled]);
  // Static-length array — rendered once; state changes only flip a class.
  const cells = useMemo(() => Array.from({ length: HABIT_SQUARES }, (_, i) => i), []);
  return (
    <div className="habit-field">
      {cells.map((i) => (
        <button
          key={i}
          type="button"
          className={`habit-sq${filled.has(i) ? " is-done" : ""}`}
          onClick={() => onToggle(habit.id, i)}
          aria-label={`Квадрат ${i + 1}`}
        />
      ))}
    </div>
  );
};

const TodoWorkspace: React.FC = () => {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [query, setQuery] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [habitDraft, setHabitDraft] = useState("");
  const firstSave = useRef(true);

  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveStore(store);
  }, [store]);

  const q = query.trim().toLowerCase();

  // Tasks: unfinished first (oldest → newest); finished sink to the bottom.
  const tasks = useMemo(() => {
    const filtered = q ? store.tasks.filter((t) => t.text.toLowerCase().includes(q)) : store.tasks;
    return [...filtered].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done && b.done) return (b.doneAt || 0) - (a.doneAt || 0);
      return a.createdAt - b.createdAt;
    });
  }, [store.tasks, q]);

  const habits = useMemo(
    () => (q ? store.habits.filter((h) => h.name.toLowerCase().includes(q)) : store.habits),
    [store.habits, q]
  );

  const addTask = useCallback(() => {
    const text = taskDraft.trim();
    if (!text) return;
    setStore((s) => ({
      ...s,
      tasks: [...s.tasks, { id: uid(), text, done: false, createdAt: Date.now(), doneAt: null }],
    }));
    setTaskDraft("");
  }, [taskDraft]);

  const toggleTask = useCallback((id: string) => {
    setStore((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.id === id ? { ...t, done: !t.done, doneAt: !t.done ? Date.now() : null } : t
      ),
    }));
  }, []);

  const removeTask = useCallback((id: string) => {
    setStore((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== id) }));
  }, []);

  const addHabit = useCallback(() => {
    const name = habitDraft.trim();
    if (!name) return;
    setStore((s) => ({
      ...s,
      habits: [...s.habits, { id: uid(), name, createdAt: Date.now(), filled: [] }],
    }));
    setHabitDraft("");
  }, [habitDraft]);

  const removeHabit = useCallback((id: string) => {
    setStore((s) => ({ ...s, habits: s.habits.filter((h) => h.id !== id) }));
  }, []);

  const toggleSquare = useCallback((habitId: string, index: number) => {
    setStore((s) => ({
      ...s,
      habits: s.habits.map((h) => {
        if (h.id !== habitId) return h;
        const set = new Set(h.filled);
        if (set.has(index)) set.delete(index);
        else set.add(index);
        return { ...h, filled: [...set].sort((a, b) => a - b) };
      }),
    }));
  }, []);

  const activeCount = store.tasks.filter((t) => !t.done).length;

  return (
    <div className="todo-shell">
      <header className="todo-head">
        <span className="todo-brand">TODO</span>
        <div className="todo-search">
          <Search className="todo-search-ico" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по задачам и привычкам…"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="todo-search-clear" onClick={() => setQuery("")} aria-label="Очистить">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </header>

      <div className="todo-board">
        {/* ── left: tasks ── */}
        <section className="todo-col">
          <div className="todo-col-head">
            <span className="todo-col-title">Задачи</span>
            <span className="todo-col-count">{activeCount} активных</span>
          </div>
          <div className="todo-add">
            <input
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTask()}
              placeholder="Новая задача…"
              spellCheck={false}
            />
            <button type="button" onClick={addTask} disabled={!taskDraft.trim()} aria-label="Добавить">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <ChatMonoScroll className="todo-list">
            {tasks.length === 0 && <p className="todo-empty">{q ? "Ничего не найдено" : "Задач пока нет"}</p>}
            {tasks.map((t) => (
              <div key={t.id} className={`todo-task${t.done ? " is-done" : ""}`}>
                <button
                  type="button"
                  className="todo-check"
                  onClick={() => toggleTask(t.id)}
                  aria-label={t.done ? "Снять" : "Выполнено"}
                >
                  {t.done && <Check className="w-3 h-3" />}
                </button>
                <span className="todo-task-text">{t.text}</span>
                <button type="button" className="todo-task-del" onClick={() => removeTask(t.id)} aria-label="Удалить">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </ChatMonoScroll>
        </section>

        {/* ── right: habits with full 5-year square fields ── */}
        <section className="todo-col">
          <div className="todo-col-head">
            <span className="todo-col-title">Привычки</span>
            <span className="todo-col-count">{store.habits.length}</span>
          </div>
          <div className="todo-add">
            <input
              value={habitDraft}
              onChange={(e) => setHabitDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addHabit()}
              placeholder="Новая привычка…"
              spellCheck={false}
            />
            <button type="button" onClick={addHabit} disabled={!habitDraft.trim()} aria-label="Добавить">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <ChatMonoScroll className="todo-list">
            {habits.length === 0 && <p className="todo-empty">{q ? "Ничего не найдено" : "Привычек пока нет"}</p>}
            {habits.map((h) => (
              <div key={h.id} className="habit-card">
                <div className="habit-card-top">
                  <span className="habit-name">{h.name}</span>
                  <span className="habit-count">
                    {h.filled.length} / {HABIT_SQUARES}
                  </span>
                  <button type="button" className="habit-del" onClick={() => removeHabit(h.id)} aria-label="Удалить">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <HabitField habit={h} onToggle={toggleSquare} />
              </div>
            ))}
          </ChatMonoScroll>
        </section>
      </div>
    </div>
  );
};

export default TodoWorkspace;
