import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Flame, Plus, Search, Trash2, X } from "lucide-react";

/**
 * TODO workspace.
 *   • Board   — tasks (left) + habits (right). Done tasks strike through and sink.
 *   • Track   — a 5-year square grid per habit; click any day to mark it.
 * Everything persists as JSON in localStorage. Search filters both lists.
 */

const STORE_KEY = "composevc-todo";
const HABIT_YEARS = 5;

type Task = { id: string; text: string; done: boolean; createdAt: number; doneAt: number | null };
type Habit = { id: string; name: string; createdAt: number; startYear: number; marks: string[] };
type Store = { v: 1; tasks: Task[]; habits: Habit[] };

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayISO(): string {
  return iso(new Date());
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
/** Monday (0) on or before the given date. */
function mondayOnOrBefore(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - wd);
  return x;
}

function loadStore(): Store {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Store>;
      return {
        v: 1,
        tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as Task[]) : [],
        habits: Array.isArray(parsed.habits) ? (parsed.habits as Habit[]) : [],
      };
    }
  } catch {
    /* ignore */
  }
  return { v: 1, tasks: [], habits: [] };
}
function saveStore(store: Store) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    /* ignore */
  }
}

/** Consecutive marked days ending today (or yesterday). */
function currentStreak(marks: Set<string>): number {
  let n = 0;
  let cur = new Date();
  if (!marks.has(iso(cur))) {
    // allow the streak to still count if today isn't marked yet but yesterday is
    cur = addDays(cur, -1);
    if (!marks.has(iso(cur))) return 0;
  }
  while (marks.has(iso(cur))) {
    n += 1;
    cur = addDays(cur, -1);
  }
  return n;
}

// ── habit 5-year grid ──────────────────────────────────────────────────────
type GridCell = { date: Date; inRange: boolean; future: boolean; key: string };
type GridWeek = { cells: GridCell[]; monthLabel: string | null };

function buildGrid(startYear: number): GridWeek[] {
  const start = new Date(startYear, 0, 1);
  const end = new Date(startYear + HABIT_YEARS, 0, 1); // exclusive
  const today = todayISO();
  let cursor = mondayOnOrBefore(start);
  const weeks: GridWeek[] = [];
  let prevMonth = -1;
  while (cursor < end) {
    const cells: GridCell[] = [];
    let monthLabel: string | null = null;
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(cursor);
      const inRange = date >= start && date < end;
      const key = iso(date);
      cells.push({ date, inRange, future: key > today, key });
      cursor = addDays(cursor, 1);
    }
    // Month label when the first in-range cell of the week starts a new month.
    const firstReal = cells.find((c) => c.inRange);
    if (firstReal) {
      const m = firstReal.date.getMonth();
      if (m !== prevMonth) {
        prevMonth = m;
        const mon = firstReal.date.toLocaleDateString("ru-RU", { month: "short" });
        monthLabel = m === 0 ? `${mon} ${firstReal.date.getFullYear()}` : mon;
      }
    }
    weeks.push({ cells, monthLabel });
  }
  return weeks;
}

const WEEKDAYS = ["Пн", "", "Ср", "", "Пт", "", "Вс"];

const HabitGrid: React.FC<{
  habit: Habit;
  onToggleDay: (habitId: string, day: string) => void;
}> = ({ habit, onToggleDay }) => {
  const marks = useMemo(() => new Set(habit.marks), [habit.marks]);
  const weeks = useMemo(() => buildGrid(habit.startYear), [habit.startYear]);
  return (
    <div className="track-grid-scroll">
      <div className="track-grid">
        <div className="track-months">
          <span className="track-wd-spacer" />
          {weeks.map((w, i) => (
            <span key={i} className="track-month">
              {w.monthLabel || ""}
            </span>
          ))}
        </div>
        <div className="track-body">
          <div className="track-weekdays">
            {WEEKDAYS.map((d, i) => (
              <span key={i} className="track-wd">
                {d}
              </span>
            ))}
          </div>
          <div className="track-weeks">
            {weeks.map((w, wi) => (
              <div key={wi} className="track-week">
                {w.cells.map((c) => {
                  if (!c.inRange) return <span key={c.key} className="track-cell is-void" />;
                  const done = marks.has(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`track-cell${done ? " is-done" : ""}${c.future ? " is-future" : ""}`}
                      title={`${c.date.toLocaleDateString("ru-RU")}${done ? " · отмечено" : ""}`}
                      onClick={() => !c.future && onToggleDay(habit.id, c.key)}
                      disabled={c.future}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ── main ────────────────────────────────────────────────────────────────────
const TodoWorkspace: React.FC = () => {
  const [store, setStore] = useState<Store>(() => loadStore());
  const [tab, setTab] = useState<"board" | "track">("board");
  const [query, setQuery] = useState("");
  const [taskDraft, setTaskDraft] = useState("");
  const [habitDraft, setHabitDraft] = useState("");
  const [trackHabitId, setTrackHabitId] = useState<string | null>(null);
  const firstSave = useRef(true);

  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    saveStore(store);
  }, [store]);

  const q = query.trim().toLowerCase();

  // Tasks: unfinished first (oldest → newest), finished sink to the bottom.
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
    const now = new Date();
    const habit: Habit = { id: uid(), name, createdAt: Date.now(), startYear: now.getFullYear(), marks: [] };
    setStore((s) => ({ ...s, habits: [...s.habits, habit] }));
    setHabitDraft("");
    setTrackHabitId((cur) => cur || habit.id);
  }, [habitDraft]);

  const removeHabit = useCallback((id: string) => {
    setStore((s) => ({ ...s, habits: s.habits.filter((h) => h.id !== id) }));
    setTrackHabitId((cur) => (cur === id ? null : cur));
  }, []);

  const toggleDay = useCallback((habitId: string, day: string) => {
    setStore((s) => ({
      ...s,
      habits: s.habits.map((h) => {
        if (h.id !== habitId) return h;
        const set = new Set(h.marks);
        if (set.has(day)) set.delete(day);
        else set.add(day);
        return { ...h, marks: [...set].sort() };
      }),
    }));
  }, []);

  const activeTrackHabit =
    habits.find((h) => h.id === trackHabitId) || habits[0] || null;

  const activeCount = store.tasks.filter((t) => !t.done).length;

  return (
    <div className="todo-shell">
      {/* ── header: sub-tabs + search ── */}
      <header className="todo-head">
        <div className="todo-tabs">
          <button
            type="button"
            className={`todo-tab${tab === "board" ? " is-active" : ""}`}
            onClick={() => setTab("board")}
          >
            Доска
          </button>
          <button
            type="button"
            className={`todo-tab${tab === "track" ? " is-active" : ""}`}
            onClick={() => setTab("track")}
          >
            TRACK
          </button>
        </div>
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

      {tab === "board" ? (
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
            <div className="todo-list">
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
                  <button
                    type="button"
                    className="todo-task-del"
                    onClick={() => removeTask(t.id)}
                    aria-label="Удалить"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* ── right: habits ── */}
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
            <div className="todo-list">
              {habits.length === 0 && <p className="todo-empty">{q ? "Ничего не найдено" : "Привычек пока нет"}</p>}
              {habits.map((h) => {
                const marks = new Set(h.marks);
                const today = todayISO();
                const doneToday = marks.has(today);
                const streak = currentStreak(marks);
                // last 21 days mini-strip
                const strip: Array<{ key: string; done: boolean }> = [];
                for (let i = 20; i >= 0; i -= 1) {
                  const k = iso(addDays(new Date(), -i));
                  strip.push({ key: k, done: marks.has(k) });
                }
                return (
                  <div key={h.id} className="habit-card">
                    <div className="habit-card-top">
                      <button
                        type="button"
                        className={`habit-today${doneToday ? " is-done" : ""}`}
                        onClick={() => toggleDay(h.id, today)}
                        title={doneToday ? "Снять отметку за сегодня" : "Отметить сегодня"}
                      >
                        {doneToday && <Check className="w-3 h-3" />}
                      </button>
                      <button
                        type="button"
                        className="habit-name"
                        onClick={() => {
                          setTrackHabitId(h.id);
                          setTab("track");
                        }}
                        title="Открыть в TRACK"
                      >
                        {h.name}
                      </button>
                      {streak > 0 && (
                        <span className="habit-streak" title="Текущая серия">
                          <Flame className="w-3 h-3" />
                          {streak}
                        </span>
                      )}
                      <button
                        type="button"
                        className="habit-del"
                        onClick={() => removeHabit(h.id)}
                        aria-label="Удалить"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="habit-strip">
                      {strip.map((c) => (
                        <span key={c.key} className={`habit-strip-cell${c.done ? " is-done" : ""}`} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : (
        <div className="todo-track">
          <aside className="track-side">
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
            <div className="track-list">
              {habits.length === 0 && <p className="todo-empty">{q ? "Ничего не найдено" : "Привычек пока нет"}</p>}
              {habits.map((h) => {
                const streak = currentStreak(new Set(h.marks));
                return (
                  <button
                    key={h.id}
                    type="button"
                    className={`track-side-item${activeTrackHabit?.id === h.id ? " is-active" : ""}`}
                    onClick={() => setTrackHabitId(h.id)}
                  >
                    <span className="track-side-name">{h.name}</span>
                    <span className="track-side-meta">
                      {h.marks.length}
                      {streak > 0 && (
                        <>
                          {" · "}
                          <Flame className="w-2.5 h-2.5" />
                          {streak}
                        </>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="track-main">
            {activeTrackHabit ? (
              <>
                <div className="track-main-head">
                  <span className="track-main-name">{activeTrackHabit.name}</span>
                  <span className="track-main-sub">
                    {activeTrackHabit.marks.length} отметок · {HABIT_YEARS} лет · с {activeTrackHabit.startYear}
                  </span>
                  <button
                    type="button"
                    className="track-main-del"
                    onClick={() => removeHabit(activeTrackHabit.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" /> удалить
                  </button>
                </div>
                <HabitGrid habit={activeTrackHabit} onToggleDay={toggleDay} />
              </>
            ) : (
              <div className="track-empty">
                <p>Создайте привычку слева, чтобы отмечать квадратики на 5 лет.</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
};

export default TodoWorkspace;
