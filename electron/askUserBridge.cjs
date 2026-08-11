/**
 * Bridges agent ask_user tool calls to the renderer.
 * Main process waits here until the UI answers via agent:answerUser.
 */

const pending = new Map(); // toolCallId -> { resolve, reject, cleanup }

function waitForUserAnswer({ toolCallId, signal, timeoutMs = 0 }) {
  const id = toolCallId || `ask-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped by user"));
      return;
    }

    let timer = null;
    const cleanup = () => {
      pending.delete(id);
      if (timer) clearTimeout(timer);
      try {
        signal?.removeEventListener?.("abort", onAbort);
      } catch {
        // ignore
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new Error("Stopped by user"));
    };

    signal?.addEventListener?.("abort", onAbort);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("ask_user timed out waiting for an answer"));
      }, timeoutMs);
    }

    pending.set(id, {
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
  });
}

function resolveUserAnswer(toolCallId, payload) {
  const entry = pending.get(toolCallId);
  if (!entry) return { ok: false, error: "No pending question for this id" };
  entry.resolve({
    answer: payload?.answer != null ? String(payload.answer) : "",
    selected: Array.isArray(payload?.selected) ? payload.selected.map(String) : [],
  });
  return { ok: true };
}

function rejectAllPending(reason = "Stopped by user") {
  for (const [, entry] of pending) {
    try {
      entry.reject(new Error(reason));
    } catch {
      // ignore
    }
  }
  pending.clear();
}

function createAskUserHandler({ signal }) {
  return async function askUser({ toolCallId, question, options, multiSelect, allowFreeText }) {
    const id = toolCallId || `ask-${Date.now()}`;
    // UI already saw tool_start with input; we only wait for the human.
    void question;
    void options;
    void multiSelect;
    void allowFreeText;
    return waitForUserAnswer({ toolCallId: id, signal });
  };
}

module.exports = {
  waitForUserAnswer,
  resolveUserAnswer,
  rejectAllPending,
  createAskUserHandler,
};
