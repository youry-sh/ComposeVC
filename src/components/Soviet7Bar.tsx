import React from "react";

/**
 * Compact status for Soviet-7 above the composer.
 *
 * Two phases:
 *   council  — 7 advisor seats fill up as each one finishes (●●●○○○○  3/7)
 *   synth    — advisors done, main is assembling the plan (spinner)
 *
 * Pure CSS animation; the per-advisor detail stays in the folded tool strip.
 */
type Props = {
  seats: string[];
  total: number;
  done: number;
  error: number;
  phase: "council" | "synth";
};

function seatClass(status: string): string {
  const v = status.toLowerCase();
  if (v === "done") return "is-done";
  if (v === "error" || v === "stopped") return "is-error";
  if (v === "running") return "is-running";
  return "is-pending";
}

const Soviet7Bar: React.FC<Props> = ({ seats, total, done, error, phase }) => {
  return (
    <div className="council-bar" role="status" aria-live="polite">
      {phase === "council" ? (
        <span className="council-seats" aria-hidden>
          {seats.map((s, i) => (
            <span key={i} className={`council-seat ${seatClass(s)}`} />
          ))}
        </span>
      ) : (
        <span className="council-synth-spin" aria-hidden />
      )}
      <span className="council-text">
        {phase === "council" ? "Совет-7 · советники думают" : "Совет-7 · синтез плана"}
      </span>
      {phase === "council" && (
        <span className="council-count" title={error ? `${error} с ошибкой` : undefined}>
          {done}/{total}
        </span>
      )}
    </div>
  );
};

export default Soviet7Bar;
