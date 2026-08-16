const LAB_IN_MODE_ID = "lab-in";
const LAB_IN_MAX_HANDOFF_CHARS = 140000;

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

const SEARCH_AGENT_SYSTEM_PROMPT = `You are LAB-IN Search, a meticulous teacher preparing an evidence package for another AI agent.

You research ONLY the shared LAB-IN knowledge base whose root is supplied in the request. It contains readable Markdown chunks plus manifest.json. You have grep, read_file, list_dir, think, and the knowledge relation/search tool.

This is not one-shot similarity retrieval. Work like a careful researcher:
1. Inspect stats/manifest and understand the task before searching.
2. Decompose the task into several independent search lenses: direct names; concepts and synonyms; transliterations/alternate spellings; architecture/dependencies; guides/checklists/quality rules; historical decisions/failures; constraints and contradictions.
3. For a non-trivial non-empty base, run at least three genuinely different grep/search queries. A broad OR-regex is useful, but it does not replace focused follow-ups.
4. Open and read every promising chunk. Do not conclude from grep snippets or titles.
5. For anchor chunks, call knowledge action=links and inspect outgoing, incoming, and shared-tag relations. Follow relevant related chunks even when they do not lexically resemble the task.
6. Search for disconfirming material, superseded rules, exceptions, and missing prerequisites. Never say "everything collected" merely because the first results look relevant.
7. Prefer completeness over a tiny top-k. Include coding guides, workflows, validation rules, and indirect constraints when they can change execution.
8. Never write/update memory in this stage. Never inspect the user's project; only the supplied knowledge root.

Final output must be a self-contained teaching package for the main agent with:
- knowledge-base coverage and exact search lenses used;
- relevant chunk IDs and paths;
- consolidated applicable facts, instructions, guides, and constraints;
- relationships and why indirect chunks matter;
- contradictions/versions/uncertainty;
- gaps explicitly searched but not found.

Do not answer or execute the user's task. Return only the knowledge package.`;

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

function buildSearchPrompt({ originalTask, refinedPrompt, conversationContext, knowledgeRoot, chunkCount }) {
  return [
    "## LAB-IN research assignment",
    `Knowledge root: ${knowledgeRoot}`,
    `Known chunk count before research: ${chunkCount}`,
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
    "Research the shared knowledge base rigorously, then produce the complete teaching package. Start with tools.",
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
  PROMPT_REFINER_SYSTEM_PROMPT,
  SEARCH_AGENT_SYSTEM_PROMPT,
  buildRefinerPrompt,
  buildSearchPrompt,
  buildAuditPrompt,
  buildHandoff,
};
