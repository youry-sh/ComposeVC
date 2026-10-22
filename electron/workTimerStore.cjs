// Module-level singleton for the active run's work timer.
// The agent loop sets it when the work_timer tool starts a timer; IPC reads it
// so the renderer can show a live countdown even after a panel remount.
// A new root run clears it (work_timer is immutable per-run, never carried over).
// sessionId binds the timer to the chat run that owns it, so the UI can show it
// only in that chat instead of every composer.

let startedAt = null;
let deadlineAt = null;
let totalMinutes = null;
let sessionId = null;

function snapshot() {
  const now = Date.now();
  const isSet = Number.isFinite(startedAt) && Number.isFinite(deadlineAt);
  const remainingMs = isSet ? Math.max(0, deadlineAt - now) : 0;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return {
    set: isSet,
    active: isSet && remainingMs > 0,
    startedAt,
    deadlineAt,
    totalMinutes,
    sessionId,
    remainingSeconds,
    remainingMinutes: Math.ceil(remainingSeconds / 60),
    elapsedSeconds: isSet ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0,
  };
}

function set(timer, sid = null) {
  if (!timer) return snapshot();
  if (Number.isFinite(timer.startedAt)) startedAt = timer.startedAt;
  if (Number.isFinite(timer.deadlineAt)) deadlineAt = timer.deadlineAt;
  if (Number.isFinite(timer.totalMinutes)) totalMinutes = timer.totalMinutes;
  if (sid !== undefined) sessionId = sid;
  return snapshot();
}

function clear() {
  startedAt = null;
  deadlineAt = null;
  totalMinutes = null;
  sessionId = null;
}

module.exports = { snapshot, get: snapshot, set, clear };
