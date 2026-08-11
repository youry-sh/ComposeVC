/**
 * Tracks in-flight chat agent runs by sessionId so Stop only affects one chat
 * when multiple MultiIDE sessions run in parallel.
 *
 * Hard caps keep Soviet-7 + multi-chat from stampeding main process / renderer.
 */

const controllers = new Map(); // sessionId -> AbortController

const MAX_PARALLEL_CHAT_SESSIONS = Infinity;
const MAX_GLOBAL_AGENT_LOOPS = Infinity;

let globalAgentLoops = 0;

function register(sessionId, controller) {
  if (!sessionId || !controller) return;
  controllers.set(String(sessionId), controller);
}

function canStartSession() {
  return controllers.size < MAX_PARALLEL_CHAT_SESSIONS;
}

function tryReserveSessionSlot(sessionId) {
  if (!sessionId) return { ok: false, reason: "missing_session" };
  const id = String(sessionId);
  if (controllers.has(id)) {
    return { ok: false, reason: "already_running", running: controllers.size };
  }
  if (controllers.size >= MAX_PARALLEL_CHAT_SESSIONS) {
    return {
      ok: false,
      reason: "max_parallel",
      running: controllers.size,
      limit: MAX_PARALLEL_CHAT_SESSIONS,
    };
  }
  return { ok: true, running: controllers.size, limit: MAX_PARALLEL_CHAT_SESSIONS };
}

/** Atomic check+register — avoids two chats racing past tryReserveSessionSlot. */
function tryRegister(sessionId, controller) {
  if (!sessionId || !controller) return { ok: false, reason: "missing_session" };
  const id = String(sessionId);
  if (controllers.has(id)) {
    return { ok: false, reason: "already_running", running: controllers.size };
  }
  if (controllers.size >= MAX_PARALLEL_CHAT_SESSIONS) {
    return {
      ok: false,
      reason: "max_parallel",
      running: controllers.size,
      limit: MAX_PARALLEL_CHAT_SESSIONS,
    };
  }
  controllers.set(id, controller);
  return { ok: true, running: controllers.size, limit: MAX_PARALLEL_CHAT_SESSIONS };
}

function acquireAgentLoopSlot() {
  globalAgentLoops += 1;
  return Promise.resolve();
}

function releaseAgentLoopSlot() {
  globalAgentLoops = Math.max(0, globalAgentLoops - 1);
}

function agentLoopStats() {
  return {
    active: globalAgentLoops,
    waiting: 0,
    limit: MAX_GLOBAL_AGENT_LOOPS,
    chatSessions: controllers.size,
    maxChatSessions: MAX_PARALLEL_CHAT_SESSIONS,
  };
}

function unregister(sessionId, controller) {
  if (!sessionId) return;
  const id = String(sessionId);
  if (!controller || controllers.get(id) === controller) {
    controllers.delete(id);
  }
}

function abort(sessionId) {
  if (!sessionId) return false;
  const id = String(sessionId);
  const controller = controllers.get(id);
  if (!controller) return false;
  try {
    controller.abort();
  } catch {
    /* ignore */
  }
  controllers.delete(id);
  return true;
}

function abortAll() {
  let any = false;
  for (const controller of controllers.values()) {
    try {
      controller.abort();
      any = true;
    } catch {
      /* ignore */
    }
  }
  controllers.clear();
  return any;
}

function count() {
  return controllers.size;
}

/** True if some OTHER session still has an active agent loop. */
function hasOtherRunning(excludeSessionId) {
  const ex = excludeSessionId != null ? String(excludeSessionId) : null;
  for (const id of controllers.keys()) {
    if (id !== ex) return true;
  }
  return false;
}

function listIds() {
  return [...controllers.keys()];
}

/**
 * Whether a full tool runtime hard-kill is safe.
 * If other chats still run, only AbortSignal should stop this session's tools —
  * disposeAll would interrupt every shared tool instance for every chat. */
function shouldHardKillRuntime(excludeSessionId) {
  return !hasOtherRunning(excludeSessionId);
}

module.exports = {
  register,
  unregister,
  abort,
  abortAll,
  count,
  hasOtherRunning,
  listIds,
  shouldHardKillRuntime,
  canStartSession,
  tryReserveSessionSlot,
  tryRegister,
  acquireAgentLoopSlot,
  releaseAgentLoopSlot,
  agentLoopStats,
  MAX_PARALLEL_CHAT_SESSIONS,
  MAX_GLOBAL_AGENT_LOOPS,
};
