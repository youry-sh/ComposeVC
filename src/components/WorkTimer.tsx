import React, { useEffect, useState } from "react";
import { Timer } from "lucide-react";

type WorkTimerSnapshot = {
  set?: boolean;
  active?: boolean;
  startedAt?: number | null;
  deadlineAt?: number | null;
  totalMinutes?: number | null;
  sessionId?: string | null;
  remainingSeconds?: number;
  remainingMinutes?: number;
  elapsedSeconds?: number;
};

function formatRemaining(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

const WorkTimer: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
  const [deadlineAt, setDeadlineAt] = useState<number | null>(null);
  const [totalMinutes, setTotalMinutes] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // One shared 1s ticker while a timer is active.
  useEffect(() => {
    if (deadlineAt == null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadlineAt]);

  // Unmount the pill (and stop the ticker) the moment the deadline passes.
  useEffect(() => {
    if (deadlineAt == null) return;
    if (deadlineAt <= Date.now()) {
      setDeadlineAt(null);
      setTotalMinutes(null);
    }
  }, [deadlineAt, now]);

  // Initial snapshot (covers a panel remount after the timer was already set)
  // plus live "work_timer" progress events emitted when the tool starts one.
  useEffect(() => {
    let active = true;
    const apply = (snap: WorkTimerSnapshot | null | undefined) => {
      if (!active || !snap) return;
      if (typeof snap.deadlineAt === "number" && snap.deadlineAt > 0) {
        setDeadlineAt(snap.deadlineAt);
        setTotalMinutes(typeof snap.totalMinutes === "number" ? snap.totalMinutes : null);
      } else if (snap.active === false) {
        setDeadlineAt(null);
        setTotalMinutes(null);
      }
    };

    window.lopster?.getWorkTimer?.().then(apply).catch(() => {});

    const unsubscribe = window.lopster?.onAgentProgress?.((progress) => {
      if (progress?.type !== "work_timer") return;
      apply(progress as unknown as WorkTimerSnapshot);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  if (deadlineAt == null) return null;

  const remainingSeconds = Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  if (remainingSeconds <= 0) return null;

  const totalSeconds = totalMinutes ? totalMinutes * 60 : 0;
  const elapsed = totalSeconds > 0 ? Math.max(0, totalSeconds - remainingSeconds) : 0;
  const progress = totalSeconds > 0 ? Math.min(1, elapsed / totalSeconds) : 0;

  return (
    <div className="work-timer" role="timer" aria-label={`${formatRemaining(remainingSeconds)} remaining`}>
      <Timer className="work-timer-ico" />
      <span className="work-timer-text">{formatRemaining(remainingSeconds)}</span>
      <span className="work-timer-bar" aria-hidden="true">
        <span className="work-timer-bar-fill" style={{ width: `${progress * 100}%` }} />
      </span>
    </div>
  );
};

export default WorkTimer;
