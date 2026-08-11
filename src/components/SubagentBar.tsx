import React from "react";

/**
 * Compact "sub-agents running" status shown right above the composer, instead
 * of streaming every sub-agent's live rows into the chat (which is heavy and
 * scrolls the conversation away). The full detail still lives in the folded
 * tool strip; this is the at-a-glance signal, like Claude Code.
 *
 * Pure CSS spinner — no timers, no per-frame React work.
 */
type Props = {
  running: number;
  done: number;
  total: number;
};

const SubagentBar: React.FC<Props> = ({ running, done, total }) => {
  if (running <= 0) return null;
  return (
    <div className="subagent-bar" role="status" aria-live="polite">
      <span className="subagent-bar-spin" aria-hidden />
      <span className="subagent-bar-text">
        {running === 1 ? "Субагент работает" : "Субагенты работают"}
      </span>
      {total > 0 && (
        <span className="subagent-bar-count" title={`${done} из ${total} завершено`}>
          {done}/{total}
        </span>
      )}
    </div>
  );
};

export default SubagentBar;
