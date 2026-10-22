import React, { useCallback, useEffect, useState } from "react";
import { Terminal, X } from "lucide-react";

type BackgroundTask = {
  id: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string | null;
  startedAt: number;
  logFile: string | null;
};

function truncate(value: string, max = 30): string {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

const BackgroundTasks: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);

  const refresh = useCallback(() => {
    window.lopster
      ?.getBackgroundTasks?.(sessionId ?? null)
      .then((res) => {
        if (res && Array.isArray(res.tasks)) setTasks(res.tasks);
      })
      .catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const unsubscribe = window.lopster?.onBackgroundTasksChanged?.(() => refresh());
    return () => unsubscribe?.();
  }, [refresh]);

  const stop = async (id: string) => {
    try {
      await window.lopster?.killBackgroundTask?.(id);
    } catch {
      /* ignore */
    }
    refresh();
  };

  if (tasks.length === 0) return null;

  return (
    <div className="bg-tasks">
      {tasks.map((task) => (
        <div className="bg-task" key={task.id} title={task.command}>
          <Terminal className="bg-task-ico" />
          <span className="bg-task-label">{truncate(task.command)}</span>
          <button
            type="button"
            className="bg-task-close"
            onClick={() => stop(task.id)}
            aria-label="Stop background task"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ))}
    </div>
  );
};

export default BackgroundTasks;
