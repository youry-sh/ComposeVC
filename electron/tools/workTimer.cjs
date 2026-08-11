const MIN_MINUTES = 1;
const MAX_MINUTES = 1_440;

function snapshot(timer) {
  const now = Date.now();
  const isSet = Number.isFinite(timer.startedAt) && Number.isFinite(timer.deadlineAt);
  const remainingMs = isSet ? Math.max(0, timer.deadlineAt - now) : 0;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return {
    set: isSet,
    active: isSet && remainingMs > 0,
    startedAt: timer.startedAt,
    deadlineAt: timer.deadlineAt,
    totalMinutes: timer.totalMinutes,
    remainingSeconds,
    remainingMinutes: Math.ceil(remainingSeconds / 60),
    elapsedSeconds: isSet ? Math.max(0, Math.floor((now - timer.startedAt) / 1000)) : 0,
  };
}

module.exports = {
  name: "work_timer",
  description:
    "Set and inspect a minimum work-time guard for the current agent run. Use action='set' only when the user explicitly asks the agent to keep working for a stated number of minutes. Once set, the timer cannot be changed, extended, or cancelled. Use action='status' to read the authoritative remaining time. While active, do not give a final answer: keep investigating, implementing, testing, and performing evidence-based risk review. Build and validate hypotheses; trace dependencies and future execution paths; find contradictions, overlaps, regressions, edge cases, error-handling gaps, and test blind spots; then resolve or document concrete residual risks. The runtime independently prevents an early final answer while this timer is active.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "status"],
        description: "'set' starts the one immutable timer for this run; 'status' reads its remaining time.",
      },
      minutes: {
        type: "number",
        description: "Required only for action='set'. Whole number of minutes, from 1 to 1440.",
      },
    },
    required: ["action"],
  },
  async execute(input, context) {
    const timer = context?.workTimer;
    if (!timer) throw new Error("Work timer is unavailable in this context");

    const action = String(input?.action || "").toLowerCase();
    if (action === "status") {
      return { ...snapshot(timer), immutable: true };
    }
    if (action !== "set") throw new Error("action must be 'set' or 'status'");
    if (timer.startedAt) {
      throw new Error("A work timer is already set for this run and cannot be changed or cancelled");
    }

    const minutes = Number(input?.minutes);
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      throw new Error(`minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}`);
    }

    timer.startedAt = Date.now();
    timer.deadlineAt = timer.startedAt + minutes * 60_000;
    timer.totalMinutes = minutes;
    return { ...snapshot(timer), immutable: true, set: true };
  },
};
