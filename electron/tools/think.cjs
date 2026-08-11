const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const clean = (value, limit) => String(value || "").trim().slice(0, limit);

module.exports = {
  name: "think",
  description:
    "Open a private temporary Thinking-max scratch cycle before deciding or acting. Use it autonomously for ambiguous, high-risk, multi-step, or contradictory tasks, and whenever the user asks you to think deeply. Supply competing hypotheses, objections, the user's perspective, risks, and a synthesis. You may call it repeatedly; every call is a fresh process. Do not use it for trivial requests. The scratch file is automatically created in the OS temp directory, never the project, and removed when the cycle ends.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      focus: { type: "string", description: "Decision or uncertainty being examined." },
      hypotheses: { type: "array", items: { type: "string" }, description: "Competing plausible explanations or approaches." },
      challenges: { type: "array", items: { type: "string" }, description: "Counterarguments, contradictions, missing evidence, and failure cases." },
      user_perspective: { type: "string", description: "The user's intended outcome and likely experience." },
      synthesis: { type: "string", description: "Best current conclusion and next validation or action." },
    },
    required: ["focus", "hypotheses", "challenges", "synthesis"],
  },
  async execute(input, context = {}) {
    const startedAt = Date.now();
    const id = crypto.randomUUID();
    const file = path.join(os.tmpdir(), `composevc-think-${process.pid}-${id}.json`);
    const scratch = {
      id,
      startedAt,
      focus: clean(input?.focus, 1000),
      hypotheses: (Array.isArray(input?.hypotheses) ? input.hypotheses : []).slice(0, 12).map((v) => clean(v, 1200)),
      challenges: (Array.isArray(input?.challenges) ? input.challenges : []).slice(0, 12).map((v) => clean(v, 1200)),
      userPerspective: clean(input?.user_perspective, 2000),
      synthesis: clean(input?.synthesis, 3000),
    };
    if (!scratch.focus || !scratch.synthesis) throw new Error("think requires a focus and synthesis");
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
