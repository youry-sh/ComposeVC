const LAB_IN_MODE_ID = "lab-in";
const LAB_IN_MAX_HANDOFF_CHARS = 140000;
const LAB_IN_HANDOFF_PART_CHARS = 30000;

const PROMPT_REFINER_SYSTEM_PROMPT = `You are LAB-IN Prompt Refiner, the first stage of an autonomous coding-agent pipeline.

Transform the user's latest request into one precise, execution-ready prompt for the main agent.

Rules:
- Preserve the user's actual intent, language, constraints, and requested scope. Never invent product requirements.
- Use the supplied conversation context to resolve references such as "this", "continue", or "do it".
- Convert vague wishes into explicit outcomes, acceptance criteria, non-goals, invariants, failure handling, and verification.
- Preserve requests to inspect the existing project before changing it.
- If the user explicitly asks to save/replenish/update memory, state that the main agent must use the knowledge tool and what information should be stored.
- Do not solve the task, write code, discuss your reasoning, or address the user.
- Return only the improved prompt in plain text. It will be combined with a separate knowledge package.`;

const SEARCH_AGENT_SYSTEM_PROMPT = `You are LAB-IN Search. Retrieve ranked knowledge and hand off what matters.

You may only read that knowledge root (grep, read_file, list_dir, knowledge search/read/links). Never write memory and never open the user's project.

The store holds two kinds of chunks: notes about a concrete task, and general knowledge or coding principles. A principle often does not repeat the task's words. Read both. Do not skip a principle, rule, or failure mode only because its title lacks the task noun. If it would change how this kind of work is done, read it and include it.

knowledge action=search returns hits already ranked. Rank 1 is the best match. Grep order and file order are not relevance. Each hit has rank, score, strength (strong, partial, or weak), and via (direct, broad, or link).

Do this:
1. Search with the concrete words of your lens (knowledge action=search). Use the ranked shortlist when it is present, then confirm it with that search if you still need a chunk it does not show.
2. Search once more for the coding principle or general knowledge this task depends on. Use the name of the craft rule, not another copy of the task sentence.
3. Read in rank order. Read every strong hit, then every partial hit, including principle hits that apply to this kind of work. Skip a weak hit while a strong or partial hit is still unread.
4. Open links of the hits you read and read the neighbor when it is the same rule, its exception, or its check. That is part of the same pass, not a new search.
5. If both searches are empty, or the strongest hit is weak, dig once: search again with a different concrete noun, then open links of the best remaining hit and read that neighbor when it bears on the task or on the principle.
6. Return a short package in rank order: rank, strength, chunk id, path, and the fact, rule, or principle. Keep a general principle when it changes the work. Note a contradiction only if you saw one.

You have a long tool budget so this sequence can finish. Spend it on these steps. Stop when the strong and partial hits and their linked neighbors are read. Do not spend leftover steps on another search, and do not tour the manifest or read the whole base. If the principle search and the dig are also empty, say nothing found and stop. Do not answer the user's task.`;

const SEARCH_SYNTHESIS_SYSTEM_PROMPT = `You are LAB-IN Search Lead. Merge the scout reports into one package ordered by rank and strength. Do not search again.

Put strong hits before partial hits, and partial hits before weak hits. Keep each unique fact with its chunk id, path, rank, and strength. Drop duplicate wording and drop a weak hit that adds nothing. Keep a contradiction only when two reports actually disagree. If the reports found nothing, say nothing found. Do not answer the user's task.`;

const SEARCH_HELPERS = [
  {
    id: "semantic",
    label: "Semantic scout",
    mission: "Lens: the task words and one close synonym. Follow the ranked search procedure for this lens. Read strong hits, then partial hits. If the list is empty or only weak, dig once, then stop.",
  },
  {
    id: "architecture",
    label: "Guides scout",
    mission: "Lens: a guide, setup step, or rule that changes how the task is done. Follow the ranked search procedure for this lens. Read strong hits, then partial hits. If the list is empty or only weak, dig once, then stop.",
  },
  {
    id: "adversarial",
    label: "Exceptions scout",
    mission: "Lens: a warning, exception, or old decision about this task. Follow the ranked search procedure for this lens. If the list is empty or only weak, dig once for a contradiction, then stop.",
  },
];

function buildRefinerPrompt({ originalTask, conversationContext, projectName }) {
  return [
    "## Latest user request",
    String(originalTask || "").trim(),
    "",
    "## Project",
    String(projectName || "(no project name)"),
    "",
    "## Recent conversation context",
    String(conversationContext || "(none)"),
    "",
    "Rewrite the latest request into the strongest faithful execution prompt now.",
  ].join("\n");
}

function formatRankedShortlist(results) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) {
    return [
      "## Ranked shortlist",
      "No ranked hit for the original request. Dig: run knowledge search with different concrete words from the task, then open links of the best remaining hit.",
    ].join("\n");
  }
  const lines = rows.map((hit) =>
    `${hit.rank}. ${hit.strength} · ${hit.via} · score ${hit.score} · ${hit.id} · ${hit.title}`
  );
  const thin = results.strongest === "weak" || results.broadened === true;
  return [
    "## Ranked shortlist",
    "Already ranked. Rank 1 is the best match, not the first file. Read strong rows, then partial rows. Skip a weak row while a stronger unread row remains.",
    `Strongest: ${results.strongest || rows[0].strength}. Broadened: ${results.broadened ? "yes" : "no"}.`,
    ...lines,
    thin
      ? "The top of this list is thin. Dig once with different concrete words and open links before you stop."
      : "If a row you need is missing, search once more with a different concrete noun, then stop.",
  ].join("\n");
}

function buildSearchPrompt({ originalTask, refinedPrompt, conversationContext, knowledgeRoot, chunkCount, rankedBlock }) {
  return [
    "You are the Search Lead.",
    "## LAB-IN research assignment",
    `Knowledge root: ${knowledgeRoot}`,
    `Known chunk count before research: ${chunkCount}`,
    "",
    String(rankedBlock || formatRankedShortlist([])),
    "",
    "## Original user request",
    String(originalTask || "").trim(),
    "",
    "## Improved execution prompt",
    String(refinedPrompt || originalTask || "").trim(),
    "",
    "## Recent conversation context",
    String(conversationContext || "(none)"),
    "",
    "Use the ranked shortlist and knowledge search. Read every strong hit, then every partial hit, including a coding principle that does not repeat the task words. Then read the linked neighbor when it is the same rule, its exception, or its check. If the list is empty or only weak, dig once with different concrete words. Stop when that set is read. Other scouts cover the other lenses. Then return the ranked package.",
  ].join("\n");
}

function buildHelperSearchPrompt({ helper, originalTask, refinedPrompt, conversationContext, knowledgeRoot, chunkCount, rankedBlock }) {
  return [
    "## LAB-IN specialist research assignment",
    `Specialist: ${helper?.label || "Search helper"}`,
    `Knowledge root: ${knowledgeRoot}`,
    `Known chunk count before research: ${chunkCount}`,
    "",
    String(rankedBlock || formatRankedShortlist([])),
    "",
    "## Your independent search lens",
    String(helper?.mission || "Follow the ranked search procedure from an independent lens."),
    "",
    "## Original user request",
    String(originalTask || "").trim(),
    "",
    "## Improved execution prompt",
    String(refinedPrompt || originalTask || "").trim(),
    "",
    "## Recent conversation context",
    String(conversationContext || "(none)"),
    "",
    "Search this lens with knowledge search. Rank 1 is the best match. Read strong hits, then partial hits. If the list is empty or only weak, dig once, then stop.",
  ].join("\n");
}

function buildSynthesisPrompt({ originalTask, refinedPrompt, knowledgeRoot, counts, required, reports }) {
  const sections = Array.isArray(reports)
    ? reports.map((report, index) => [
        `## Research report ${index + 1}: ${report?.label || report?.id || "researcher"}`,
        `Status: ${report?.ok === false ? "FAILED/SOFT-FALLBACK" : "completed"}`,
        String(report?.text || report?.error || "(empty report)"),
      ].join("\n"))
    : [];
  return [
    "## LAB-IN Search Team synthesis",
    `Knowledge root: ${knowledgeRoot}`,
    `Measured aggregate tool coverage: search ${counts?.search || 0}/${required?.search || 0}, read ${counts?.read || 0}/${required?.read || 0}, links ${counts?.links || 0}/${required?.links || 0}.`,
    "",
    "## Original user request",
    String(originalTask || "").trim(),
    "",
    "## Improved execution prompt",
    String(refinedPrompt || originalTask || "").trim(),
    "",
    "Below are the Search Lead's own report and three independent specialist reports. Merge them into one package ordered by strength: strong hits before partial hits, partial hits before weak hits. Keep unique facts, rules, exceptions, prerequisites, and verification steps with chunk id and path. Drop duplicates and weak hits that add nothing. Do not search again.",
    "",
    ...sections,
  ].join("\n");
}

function buildAuditPrompt({ counts, required, previousReport }) {
  const deficits = [];
  if (counts.search < required.search) deficits.push(`search/grep ${counts.search}/${required.search}`);
  if (counts.read < required.read) deficits.push(`full reads ${counts.read}/${required.read}`);
  if (counts.links < required.links) deficits.push(`relation checks ${counts.links}/${required.links}`);
  return [
    "## LAB-IN host audit: research is not complete yet",
    deficits.length ? `Measured deficits: ${deficits.join(", ")}.` : "Run a final adversarial coverage audit.",
    "Use tools before producing the replacement report. Search with new lenses, open missed chunks, traverse relations, and check contradictions/gaps.",
    "Your next final response must replace and improve the previous package, not merely comment on it.",
    "",
    "## Previous package to audit",
    String(previousReport || "(empty)").slice(0, 60000),
  ].join("\n");
}

function splitKnowledgePackage(value, maxChars = LAB_IN_HANDOFF_PART_CHARS) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const limit = Math.max(4000, Math.floor(Number(maxChars) || LAB_IN_HANDOFF_PART_CHARS));
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    const minimum = Math.floor(limit * 0.55);
    const candidates = [
      window.lastIndexOf("\n## "),
      window.lastIndexOf("\n### "),
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    ];
    const cut = candidates.find((index) => index >= minimum) || limit;
    const part = rest.slice(0, cut).trim();
    if (part) parts.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function buildSegmentedExecutionPrompt({ originalTask, refinedPrompt, knowledgeMeta, partCount }) {
  return [
    "[LAB-IN EXECUTE AFTER KNOWLEDGE PARTS]",
    `All ${partCount} numbered knowledge parts were delivered above and acknowledged in this same context. Execute the task now using their complete combined content.`,
    "Do not answer with another acknowledgement. Do not redo LAB-IN research. Inspect the real project, preserve user changes, implement fully, and verify proportionally to risk.",
    "",
    "## Original user request (authoritative intent)",
    String(originalTask || "").trim(),
    "",
    "## Improved execution prompt",
    String(refinedPrompt || originalTask || "").trim(),
    "",
    `## Shared knowledge receipt`,
    `${partCount} parts from ${knowledgeMeta?.chunkCount || 0} chunks were supplied before this execution command. Treat every part as one ordered knowledge package; preserve prompts/templates, methodologies, prerequisites, warnings, links, contradictions, and verification steps.`,
    "",
    "## Execution priority",
    "Original user intent > current workspace evidence > applicable stored knowledge > assumptions. Resolve contradictions explicitly and continue autonomously until the task is genuinely complete.",
  ].join("\n");
}

function buildHandoffSequence({ originalTask, refinedPrompt, knowledgePackage, knowledgeMeta, maxPartChars }) {
  const parts = splitKnowledgePackage(knowledgePackage, maxPartChars);
  if (parts.length <= 1) {
    return {
      segmented: false,
      partCount: parts.length || 1,
      parts,
      messages: [{
        role: "user",
        content: buildHandoff({ originalTask, refinedPrompt, knowledgePackage, knowledgeMeta }),
      }],
    };
  }

  const messages = [];
  for (let index = 0; index < parts.length; index += 1) {
    const number = index + 1;
    messages.push({
      role: "user",
      content: [
        `[LAB-IN KNOWLEDGE PART ${number}/${parts.length}]`,
        "Ingestion stage only. Retain this complete segment together with every other numbered part. Do not execute the task from an incomplete subset.",
        "",
        parts[index],
      ].join("\n"),
    });
    messages.push({
      role: "assistant",
      content: `[LAB-IN PART ACK ${number}/${parts.length}] Received knowledge part ${number}/${parts.length}; execution has not started.`,
    });
  }
  messages.push({
    role: "user",
    content: buildSegmentedExecutionPrompt({ originalTask, refinedPrompt, knowledgeMeta, partCount: parts.length }),
  });
  return { segmented: true, partCount: parts.length, parts, messages };
}

function buildHandoff({ originalTask, refinedPrompt, knowledgePackage, knowledgeMeta }) {
  return [
    "[LAB-IN EXECUTION PACKAGE]",
    "You are the main ComposeVC agent. Execute the task now using the improved prompt and the researched knowledge package below.",
    "Treat stored knowledge as guidance with provenance, not as proof that the current workspace matches it. Inspect the real project, preserve user changes, implement fully, and verify proportionally to risk.",
    "Do not redo LAB-IN research and do not explain the pipeline unless it materially affects the result.",
    "",
    "## Original user request (authoritative intent)",
    String(originalTask || "").trim(),
    "",
    "## Improved execution prompt",
    String(refinedPrompt || originalTask || "").trim(),
    "",
    `## Shared knowledge package (${knowledgeMeta?.chunkCount || 0} chunks in base)`,
    String(knowledgePackage || "The shared knowledge base is empty; no stored guidance was available."),
    "",
    "## Execution priority",
    "Original user intent > current workspace evidence > applicable stored knowledge > assumptions. Resolve contradictions explicitly and continue autonomously until the task is genuinely complete.",
  ].join("\n");
}

module.exports = {
  LAB_IN_MODE_ID,
  LAB_IN_MAX_HANDOFF_CHARS,
  LAB_IN_HANDOFF_PART_CHARS,
  PROMPT_REFINER_SYSTEM_PROMPT,
  SEARCH_AGENT_SYSTEM_PROMPT,
  SEARCH_SYNTHESIS_SYSTEM_PROMPT,
  SEARCH_HELPERS,
  formatRankedShortlist,
  buildRefinerPrompt,
  buildSearchPrompt,
  buildHelperSearchPrompt,
  buildSynthesisPrompt,
  buildAuditPrompt,
  splitKnowledgePackage,
  buildHandoffSequence,
  buildHandoff,
};
