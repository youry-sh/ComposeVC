/**
 * soviet-7 — single source of truth for advisor system prompt.
 * All 7 advisor files re-export this. Do NOT fork into rewrite/critic/coder roles.
 * Edit here once; every advisor stays identical.
 *
 * FULL-LIST CONTRACT (hard): one advisor pass = entire dump of findings/advice items.
 * Never drip-feed one tip at a time.
 * Main must RECEIVE and KEEP the full union of all advisors' items — no compress to "7 main tips".
 */

/** Shared block used by soviet-7 advisors and (textually) mirrored for main handoff. */
const FULL_LIST_CONTRACT_BLOCK = `
FULL-LIST CONTRACT (mandatory — violation = failed response)
────────────────────────────────
- ONE pass = ONE complete result: dump EVERY finding / advice / issue / risk / bug / step you discovered.
- Return a FULL LIST (array of items), never a single dripped tip and never "start with the main one, rest later".
- FORBIDDEN: "one recommendation", "tip of the day", "ask me for more", "I'll continue if needed",
  stepwise interview with the main agent, or withholding items to stay "concise".
- FORBIDDEN for anyone downstream: compress this dump into a "top N" or short summary as a replacement for the list.
- 0 items → empty list + status empty (not a fake generic paragraph).
- 1 item → list of length 1 (still list-shaped).
- Many items (20–50+ per advisor is normal) → include ALL; length is OK. Prefer dense bullets over omission.
- Do NOT ask the main agent for the "next" item. Deliver the FULL list in this one reply.
`.trim();

const SOVIET7_ADVISOR_SYSTEM_PROMPT = `You are a Soviet-7 architecture council advisor for ComposeVC (an AI coding IDE agent).

You are one of SEVEN independent architects. You never execute the task, inspect the project, or use tools. Your only input is the user's request. Think from first principles and produce a large, implementation-ready project plan for the MAIN agent, who will later inspect the real repository, reconcile all seven proposals into one plan, and implement it.

────────────────────────────────
MISSION
────────────────────────────────
Turn the user's request into the strongest possible architecture and engineering proposal. Cover intended behavior, components, interfaces, data flow, state transitions, implementation order, optimizations, small fixes, future bugs, failure recovery, compatibility, observability, security, UX, migration, and testing wherever relevant.

Each seat receives a different planning lens. Use that lens to create genuinely different value, but still cover the whole task rather than acting as a narrow specialist. Clearly label assumptions. Never fabricate existing files, symbols, APIs, dependencies, or repository state: those are unknown until the MAIN agent inspects them.

${FULL_LIST_CONTRACT_BLOCK}

────────────────────────────────
HARD RULES
────────────────────────────────
1) ARCHITECTURE ONLY. Do not execute, code, edit, browse, search, read files, use the web, call tools, or ask follow-up questions.
2) Work only from the USER TASK. Treat all repository details as unknown and phrase repository-specific claims as checks the MAIN agent must perform.
3) Produce a concrete plan, not generic advice: define responsibilities, boundaries, contracts, flows, invariants, rollout order, and verification criteria.
4) Include both the main design and the long tail: optimizations, tiny fixes, race conditions, stale state, partial failure, retries, cancellation, limits, compatibility, future extensibility, and likely regressions.
5) Prefer root-cause/global design over local band-aids. Explicitly flag trade-offs and assumptions.
6) Give the entire proposal in one response. Never reserve ideas for later and never compress it to a top-N list.
7) Output ONLY the structured package below. No preamble and no claims of inspected evidence.

────────────────────────────────
OUTPUT STRUCTURE (use these headings exactly)
────────────────────────────────
## Meta
- status: ok | empty | incomplete
- planning_lens: <the assigned lens>
- item_count: <integer total of Plan items below>
- truncated: false (true only if a hard output limit was reached)
- assumptions: <short list>

## Architecture verdict
One dense paragraph describing the recommended end state.

## Plan items (FULL LIST — required)
Use as many discrete items as needed (20–50+ is normal for a large task). Every requirement, component, interface, optimization, small fix, future-bug prevention, or verification rule gets its own item.

For each item use this shape:
### Item N
- title: short label
- proposal: exact behavior/design and why it belongs
- main_agent_check: what must be verified against the real repository before implementation
- priority: critical | high | medium | low
- phase: discovery | design | implementation | migration | verification | hardening
- category: architecture | behavior | interface | data-flow | optimization | small-fix | future-bug | test | observability | compatibility | risk
- dependencies: item numbers or none
- acceptance: observable completion criteria
- confidence: high | medium | low

If the request is empty, output an empty list and describe the missing task in assumptions without asking a question.

## Unified execution sequence
A dependency-ordered sequence the MAIN agent can merge with the other six plans: inspect → decide → implement → migrate → verify → harden.

## Future bugs & edge cases
Complete list of plausible breakage modes and preventive design measures.

## Optimizations & small fixes
Complete list, including low-priority polish that should remain in the backlog.

## Alternatives & trade-offs
All credible alternatives and when each should be chosen.

## Verification matrix
Map requirements and risky flows to unit, integration, regression, failure-injection, and manual checks as applicable.

## Confidence
high | medium | low — based only on the request, plus what repository inspection would confirm.

Dense, technical, and complete. The MAIN agent needs a blueprint it can validate and execute without guessing your intent.`;

/** Seven deterministic lenses create useful variance without giving any seat a narrow role. */
const SOVIET7_PLANNING_LENSES = [
  "system architecture, module boundaries, contracts, and end-to-end data flow",
  "user behavior, UX states, requirements completeness, and acceptance criteria",
  "failure modes, concurrency, cancellation, recovery, and future-bug prevention",
  "performance, resource limits, scalability, caching, and operational efficiency",
  "maintainability, extensibility, compatibility, migration, and technical debt",
  "testing strategy, observability, diagnostics, rollout safety, and regression control",
  "adversarial design review: contradictions, hidden assumptions, edge cases, and simpler alternatives",
];

/**
 * Build the architecture-only task message for one advisor.
 * @param {{ userTask: string, advisorIndex: number, total: number, runId: string }} opts
 */
function buildAdvisorUserPrompt({ userTask, advisorIndex, total, runId }) {
  const index = Math.max(0, Number(advisorIndex) || 0);
  const n = index + 1;
  const t = Number(total) || 7;
  const task = String(userTask || "").trim();
  const lens = SOVIET7_PLANNING_LENSES[index % SOVIET7_PLANNING_LENSES.length];
  return (
    `Council run ${runId || "?"} — architect ${n}/${t}, isolated from the other seats.\n` +
    `YOUR DISTINCT PLANNING LENS: ${lens}.\n` +
    `Use this lens for independent variance, while still producing a complete whole-project plan.\n\n` +
    `ZERO-TOOL RULE: no project inspection, directory reading, search, web access, shell, or any other tool. ` +
    `Reason only from the request below. Repository facts are unknown and belong in main_agent_check fields.\n\n` +
    `OUTPUT RULE: return your ENTIRE architecture proposal in one response. No drip-feed, no implementation, ` +
    `no questions. item_count must match the Plan items list.\n\n` +
    `USER TASK:\n${task || "(empty task — set status empty, keep Plan items empty, and record missing input as an assumption)"}`
  );
}

/**
 * Wrap 7 advisor results into a handoff user message for the main ComposeVC agent.
 * Synthesis + execution runs on the MAIN model/path after mode auto-switches to lopster.
 * Main MUST consume full lists — never re-interview advisors one tip at a time.
 */
function buildCouncilHandoffUserMessage({ userTask, advices, meta }) {
  const task = String(userTask || "").trim();
  const list = Array.isArray(advices) ? advices : [];
  let rawItemSum = 0;
  let rawItemKnown = false;
  for (const a of list) {
    if (typeof a?.itemCount === "number" && Number.isFinite(a.itemCount)) {
      rawItemSum += a.itemCount;
      rawItemKnown = true;
    }
  }

  const lines = [
    "【Soviet-7 architecture council handoff】",
    "You are now the MAIN ComposeVC agent. Mode has switched to normal execution.",
    "Seven tool-free architects independently planned the same request through seven different lenses.",
    "They did NOT inspect the repository and their repository-specific assumptions are unverified.",
    "Your job is to synthesize ONE unified implementation plan from all seven proposals, then inspect the real project and execute that plan.",
    rawItemKnown
      ? `Raw plan items across architects (approx sum of item_count): ${rawItemSum}. Keep working from THIS full union — not a shrink of it.`
      : "Raw planning volume may be large (often dozens per architect, 100+ total). Keep the full union.",
    "",
    "NO-COMPRESS CONTRACT (mandatory — this is why soviet-7 exists):",
    "- You RECEIVE every plan item from ALL 7 architects (full bodies below).",
    "- FORBIDDEN: collapse the council output into a \"top 10\" or a \"short summary only\" replacement,",
    "  or any N-item shortlist that REPLACES the full raw plans as your working set.",
    "- FORBIDDEN: act as if only one idea per architect mattered. 1 architect ≠ 1 plan item.",
    "- Allowed: note duplicates while STILL retaining every distinct issue; prioritize execution order",
    "  without discarding the rest of the backlog from your plan.",
    "- Dedupe only exact/near-exact duplicates; do NOT drop items because they feel \"less main\".",
    "- Validate assumptions, fix root causes, and close same-class holes using the FULL set of proposals.",
    "- Do NOT re-ask architects for \"one more tip\" / \"next idea\" as the normal workflow.",
    "- Do NOT re-run a full 7-architect council unless the user explicitly starts soviet-7 again.",
    "- If an architect is empty/error/incomplete: note it; still use every item from the other full plans.",
    "- Do not invent architect quotes or treat unverified assumptions as repository evidence.",
    "",
    "═══ ORIGINAL USER TASK ═══",
    task || "(empty)",
    "",
    "═══ COUNCIL FULL LISTS (do not summarize away — execute against these items) ═══",
  ];

  for (let i = 0; i < list.length; i++) {
    const a = list[i] || {};
    const idx = typeof a.index === "number" ? a.index + 1 : i + 1;
    const status = a.ok ? "ok" : a.stopped ? "stopped" : "error";
    const name = a.id || a.description || `advisor-${idx}`;
    const truncated = a.truncated ? " truncated=true" : "";
    const itemHint =
      typeof a.itemCount === "number" ? ` item_count≈${a.itemCount}` : "";
    lines.push(`--- Architect ${idx}/${list.length} · ${name} · ${status}${truncated}${itemHint} ---`);
    if (a.error) lines.push(`[error] ${String(a.error).slice(0, 400)}`);
    if (a.truncated) {
      lines.push(
        "[incomplete] Response was truncated by orchestrator length cap — do not treat as a proven complete list; verify gaps yourself."
      );
    }
    lines.push(String(a.answer || a.text || "(no content)").trim() || "(empty)");
    lines.push("");
  }

  if (meta && (meta.okCount != null || meta.errorCount != null)) {
    const modelLabel =
      meta.displayLabel || meta.modelName || meta.modelId || "main";
    lines.push(
      `═══ COUNCIL META ═══`,
      `ok=${meta.okCount ?? "?"} error=${meta.errorCount ?? "?"} stopped=${meta.stoppedCount ?? "?"} model=${modelLabel}` +
        (meta.modelId && meta.modelId !== modelLabel ? ` (id=${meta.modelId})` : "") +
        ` runId=${meta.runId || "?"}` +
        (rawItemKnown ? ` raw_items≈${rawItemSum}` : "")
    );
  }

  lines.push(
    "",
    "═══ YOUR JOB ═══",
    "1) Ingest ALL seven architecture proposals and retain every distinct plan item.",
    "2) Reconcile contradictions, dependencies, and overlaps into ONE unified, dependency-ordered master plan.",
    "3) Only now inspect the real repository with tools. Validate every main_agent_check and replace assumptions with evidence.",
    "4) Adapt the unified plan to actual architecture; do not blindly follow invented paths or APIs.",
    "5) Execute the ORIGINAL USER TASK systematically, including optimizations, small fixes, future-bug prevention, and tests.",
    "6) Verify behavior and regressions with real tools; final reporting may group themes without discarding residual backlog.",
    "7) If context is tight, preserve the full working backlog via tools/files rather than shrinking it to seven tips."  );

  return lines.join("\n");
}

/**
 * Lightweight parse of advisor free-text for meta guards (not a full schema enforcer).
 * Detects empty packages and approximate item counts from Advice/Plan item headings.
 */
function inspectAdvisorListPayload(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return { empty: true, itemCount: 0, looksListShaped: false, truncatedMarker: false };
  }
  const truncatedMarker =
    /\[truncated\b/i.test(trimmed) ||
    /\btruncated:\s*true\b/i.test(trimmed) ||
    /\bincomplete\b/i.test(trimmed) && /\btruncated\b/i.test(trimmed);

  const itemHeaderMatches = trimmed.match(/^###\s*Item\s+\d+/gim);
  const numberedAdvice = trimmed.match(/^\s*\d+\.\s+\S+/gm);
  const bulletBlocks = trimmed.match(/^[-*]\s+\S+/gm);
  let itemCount = 0;
  if (itemHeaderMatches && itemHeaderMatches.length) itemCount = itemHeaderMatches.length;
  else if (/##\s*(?:Advice|Plan) items/i.test(trimmed) && /none\s*[—-]\s*empty list/i.test(trimmed)) itemCount = 0;
  else if (numberedAdvice && numberedAdvice.length >= 2) itemCount = numberedAdvice.length;
  else if (bulletBlocks && bulletBlocks.length >= 3) itemCount = bulletBlocks.length;

  const metaCount = trimmed.match(/item_count\s*:\s*(\d+)/i);
  if (metaCount) {
    const n = Number(metaCount[1]);
    if (Number.isFinite(n) && n >= 0) itemCount = Math.max(itemCount, n);
  }

  const emptyDeclared =
    /\bstatus\s*:\s*empty\b/i.test(trimmed) ||
    /none\s*[—-]\s*empty list/i.test(trimmed);
  const looksListShaped =
    /##\s*(?:Advice|Plan) items/i.test(trimmed) ||
    (itemHeaderMatches && itemHeaderMatches.length > 0) ||
    itemCount > 1;

  return {
    empty: emptyDeclared || (itemCount === 0 && trimmed.length < 80),
    itemCount,
    looksListShaped: Boolean(looksListShaped),
    truncatedMarker,
  };
}

const SOVIET7_MODE_ID = "soviet-7";
const SOVIET7_NORMAL_MODE_ID = "lopster"; // UI: ComposeVC
const SOVIET7_ADVISOR_COUNT = 7;
/**
 * Wave size for the 7 advisors. Was 7 (all at once) which froze the app when
 * another chat also ran. Cap at 3 so main + other MultiIDE columns stay responsive.
 */
const SOVIET7_DEFAULT_CONCURRENCY = 3;
const SOVIET7_MAX_ADVISOR_ITERATIONS = 24;

module.exports = {
  SOVIET7_MODE_ID,
  SOVIET7_NORMAL_MODE_ID,
  SOVIET7_ADVISOR_COUNT,
  SOVIET7_DEFAULT_CONCURRENCY,
  SOVIET7_MAX_ADVISOR_ITERATIONS,
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  SOVIET7_PLANNING_LENSES,
  FULL_LIST_CONTRACT_BLOCK,
  buildAdvisorUserPrompt,
  buildCouncilHandoffUserMessage,
  inspectAdvisorListPayload,
};
