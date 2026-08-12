const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const clean = (value, limit) => String(value || "").trim().slice(0, limit);

/** Entries shorter than this are filler, not analysis. */
const MIN_ITEM_CHARS = 15;
/** Synthesis shorter than this is a label, not a conclusion (Thinking-max only). */
const MIN_SYNTHESIS_CHARS = 60;

/** Collapse to a comparison key so reworded duplicates of one idea count once. */
const dedupeKey = (value) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Clean, drop filler, and drop near-duplicates; report how many were discarded. */
function buildList(value, cap, limit) {
  const raw = (Array.isArray(value) ? value : [])
    .slice(0, cap)
    .map((entry) => clean(entry, limit))
    .filter(Boolean);
  const seen = new Set();
  const kept = [];
  for (const entry of raw) {
    if (entry.length < MIN_ITEM_CHARS) continue;
    const key = dedupeKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return { kept, dropped: raw.length - kept.length };
}

const droppedNote = (dropped) =>
  dropped > 0
    ? ` (${dropped} ${dropped === 1 ? "entry was" : "entries were"} discarded as duplicates of another entry or too short to be analysis)`
    : "";

module.exports = {
  name: "think",
  description:
    "Open a private temporary Thinking-max scratch cycle before deciding or acting. Use it autonomously for ambiguous, high-risk, multi-step, or contradictory tasks, and whenever the user asks you to think deeply. Supply competing hypotheses, objections, the user's perspective, risks, and a synthesis. Hypotheses must genuinely compete — each one predicts a different observation; several rewordings of one idea are rejected as a single hypothesis. You may call it repeatedly; every call is a fresh process. Do not use it for trivial requests. The scratch file is automatically created in the OS temp directory, never the project, and removed when the cycle ends.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      focus: { type: "string", description: "Decision or uncertainty being examined." },
      hypotheses: {
        type: "array",
        items: { type: "string" },
        description:
          "Competing plausible explanations or approaches. At least 3 while Thinking-max is on, at least 2 otherwise. Each must predict something the others do not.",
      },
      challenges: {
        type: "array",
        items: { type: "string" },
        description:
          "Counterarguments, contradictions, missing evidence, and failure cases. At least 2 while Thinking-max is on, at least 1 otherwise.",
      },
      user_perspective: { type: "string", description: "The user's intended outcome and likely experience." },
      synthesis: { type: "string", description: "Best current conclusion and next validation or action." },
    },
    required: ["focus", "hypotheses", "challenges", "synthesis"],
  },
  async execute(input, context = {}) {
    const startedAt = Date.now();
    const id = crypto.randomUUID();
    const file = path.join(os.tmpdir(), `composevc-think-${process.pid}-${id}.json`);
    const strict = context.thinkingMax === true;
    const minHypotheses = strict ? 3 : 2;
    const minChallenges = strict ? 2 : 1;

    const hypotheses = buildList(input?.hypotheses, 12, 1200);
    const challenges = buildList(input?.challenges, 12, 1200);
    const scratch = {
      id,
      startedAt,
      focus: clean(input?.focus, 1000),
      hypotheses: hypotheses.kept,
      challenges: challenges.kept,
      userPerspective: clean(input?.user_perspective, 2000),
      synthesis: clean(input?.synthesis, 3000),
    };

    if (!scratch.focus || !scratch.synthesis) throw new Error("think requires a focus and synthesis");
    if (scratch.hypotheses.length < minHypotheses) {
      throw new Error(
        `think requires at least ${minHypotheses} distinct, substantive hypotheses; ${scratch.hypotheses.length} usable ` +
          `${scratch.hypotheses.length === 1 ? "was" : "were"} supplied${droppedNote(hypotheses.dropped)}. ` +
          "Competing means each hypothesis predicts a DIFFERENT observation — several rewordings of one idea count as one. " +
          "Include the boring explanation (stale build, cache, wrong file, wrong branch, not restarted) and one that contradicts your first instinct. " +
          "Call think again with the missing hypotheses."
      );
    }
    if (scratch.challenges.length < minChallenges) {
      throw new Error(
        `think requires at least ${minChallenges} distinct, substantive ${minChallenges === 1 ? "challenge" : "challenges"}; ` +
          `${scratch.challenges.length} usable ${scratch.challenges.length === 1 ? "was" : "were"} supplied${droppedNote(challenges.dropped)}. ` +
          "A challenge is a specific counterexample, contradiction, unverified load-bearing assumption, or failure mode of the LEADING hypothesis — " +
          "not a generic reminder to be careful. Call think again with real objections."
      );
    }
    if (strict && scratch.synthesis.length < MIN_SYNTHESIS_CHARS) {
      throw new Error(
        `think requires a synthesis of at least ${MIN_SYNTHESIS_CHARS} characters while Thinking-max is on (got ${scratch.synthesis.length}). ` +
          "State the current conclusion, the causal mechanism that makes it true, and the next validation step. Call think again."
      );
    }

    try {
      await fs.promises.writeFile(file, JSON.stringify(scratch, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (context.signal?.aborted) throw new Error("Stopped by user");
      return {
        processId: id,
        status: "completed",
        focus: scratch.focus,
        synthesis: scratch.synthesis,
        hypothesesConsidered: scratch.hypotheses.length,
        challengesConsidered: scratch.challenges.length,
        elapsedMs: Date.now() - startedAt,
        temporary: true,
        instruction: "Use this synthesis as working evidence. Validate it with tools; call think again if a new contradiction appears.",
      };
    } finally {
      await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  },
};
