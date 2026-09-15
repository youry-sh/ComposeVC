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

const SEARCH_AGENT_SYSTEM_PROMPT = `You are LAB-IN Search, a meticulous teacher preparing an evidence package for another AI agent.

You research ONLY the shared LAB-IN knowledge base whose root is supplied in the request. It contains readable Markdown chunks plus manifest.json. You have grep, read_file, list_dir, think, and the knowledge relation/search tool.

Treat the base as heterogeneous working memory, not a fact database. A useful chunk may contain a methodology, step-by-step guide, integration or wiring procedure, setup instructions, checklist, reusable prompt, prompt template, example, policy, quality standard, historical decision, failure lesson, or a rule for how something must be added/connected/configured. These operational materials are often more important than a direct lexical answer.

This is not one-shot similarity retrieval. Work like a careful researcher:
1. Inspect stats/manifest and understand the task before searching.
2. Decompose the task into several independent search lenses: direct names; concepts and synonyms; transliterations/alternate spellings; architecture/dependencies; guides/checklists/quality rules; historical decisions/failures; constraints and contradictions.
   Always add an operational-material lens: search for task-relevant guides, methodologies, procedures, prompts, templates, examples, setup/connection instructions, "how to add" rules, and validation sequences even when the task does not explicitly ask for a guide.
3. For a non-trivial non-empty base, run at least three genuinely different grep/search queries. A broad OR-regex is useful, but it does not replace focused follow-ups.
4. Open and read every promising chunk. Do not conclude from grep snippets or titles.
5. For anchor chunks, call knowledge action=links and inspect outgoing, incoming, and shared-tag relations. Follow relevant related chunks even when they do not lexically resemble the task.
6. Search for disconfirming material, superseded rules, exceptions, and missing prerequisites. Never say "everything collected" merely because the first results look relevant.
7. Prefer completeness over a tiny top-k. Include coding guides, workflows, validation rules, and indirect constraints when they can change execution.
8. Never write/update memory in this stage. Never inspect the user's project; only the supplied knowledge root.

When a relevant chunk is a prompt/template, preserve its intent, structure, variables/placeholders, mandatory clauses, and usage conditions. When it is a guide or methodology, preserve ordering, prerequisites, warnings, verification steps, and exceptions. Do not flatten actionable material into a vague one-line summary. Clearly label reusable prompts/templates separately from factual guidance.

Final output must be a self-contained teaching package for the main agent with:
- knowledge-base coverage and exact search lenses used;
- relevant chunk IDs and paths;
- consolidated applicable facts, instructions, guides, and constraints;
- reusable prompts/templates, methodologies, procedures, connection/setup steps, and checklists;
- relationships and why indirect chunks matter;
- contradictions/versions/uncertainty;
- gaps explicitly searched but not found.

Do not answer or execute the user's task. Return only the knowledge package.`;

const SEARCH_SYNTHESIS_SYSTEM_PROMPT = `You are LAB-IN Search Lead, the senior researcher responsible for the final knowledge package.

You receive four independent research reports: your own lead investigation and three reports from specialist search helpers. Merge them into one complete, evidence-grounded teaching package for the main AI agent.

Rules:
- Preserve every relevant unique fact, instruction, guide, constraint, relationship, exception, and warning found by any researcher. Deduplicate wording, never evidence.
- Compare reports instead of voting. Explicitly retain contradictions, version conflicts, uncertainty, and missing prerequisites.
- Keep chunk IDs and paths attached to the claims they support. Do not invent provenance.
- Preserve the usable structure and placeholders of relevant prompts/templates, and the exact ordering, prerequisites, warnings, and verification stages of guides/methodologies. Never summarize away the part the main agent needs to execute them correctly.
- Use the available read-only knowledge tools when reports conflict, a claim lacks evidence, or an important gap remains. You are the final authority and may perform follow-up searches yourself.
- Never write/update memory and never inspect the user's project. Work only inside the supplied shared knowledge root.
- Do not execute or answer the user's task.

Return one self-contained final package containing coverage/lenses, applicable knowledge, indirect relationships, contradictions/versions, and gaps searched but not found. This package replaces all four source reports, so do not discard a unique finding merely to make it shorter.`;

const SEARCH_HELPERS = [
  {
    id: "semantic",
    label: "Semantic scout",
    mission: "Search direct task terms, entities, synonyms, transliterations, alternate spellings, adjacent concepts, and wording that may express the same intent. Open the full chunks and trace relevant relations.",
  },
  {
    id: "architecture",
    label: "Architecture and guides scout",
    mission: "Search architecture, dependencies, workflows, implementation guides, methodologies, reusable prompts/templates, examples, connection/setup procedures, rules for how to add or configure things, checklists, validation sequences, quality gates, and indirect prerequisites that could change how the task must be executed. Preserve actionable structure and traverse linked and shared-tag chunks.",
  },
  {
    id: "adversarial",
    label: "Contradictions and history scout",
    mission: "Search historical decisions, failures, regressions, exceptions, superseded rules, conflicting guidance, negative evidence, and missing prerequisites. Actively try to disprove an easy first interpretation.",
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
    "You are the Search Lead. Three specialist helpers are researching independently in parallel, but you must conduct your own complete investigation rather than waiting for or trusting them. Your report will later be merged with theirs. Start with tools.",
  ].join("\n");
}

function buildHelperSearchPrompt({ helper, originalTask, refinedPrompt, conversationContext, knowledgeRoot, chunkCount }) {
  return [
    "## LAB-IN specialist research assignment",
    `Specialist: ${helper?.label || "Search helper"}`,
    `Knowledge root: ${knowledgeRoot}`,
    `Known chunk count before research: ${chunkCount}`,
    "",
    "## Your independent search lens",
    String(helper?.mission || "Search the assigned knowledge base from an independent angle."),
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
    "Use tools immediately. Return your ENTIRE evidence list with chunk IDs and paths, including indirect findings, guides, methodologies, reusable prompts/templates, connection/setup instructions, checklists, contradictions, uncertainty, and searched-but-missing guidance. Preserve prompt placeholders and procedural step order. Do not compress the report into a top-N shortlist. The Search Lead will merge your report with three other investigations.",
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
    "Below are the Search Lead's own report and three independent specialist reports. Reconcile them into one exhaustive package. Preserve unique evidence, reusable prompts/templates, complete methodologies, procedural ordering, prerequisites, connection/setup steps, checklists, and validation rules; remove only duplication, and use tools for any unresolved conflict or important gap.",
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
  buildRefinerPrompt,
  buildSearchPrompt,
  buildHelperSearchPrompt,
  buildSynthesisPrompt,
  buildAuditPrompt,
  splitKnowledgePackage,
  buildHandoffSequence,
  buildHandoff,
};
