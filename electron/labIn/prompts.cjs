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

const SEARCH_AGENT_SYSTEM_PROMPT = `You are LAB-IN Search. Sweep the shared knowledge base and hand off what matters. Be fast.

You may only read that knowledge root (grep, read_file, list_dir, knowledge search). Never write memory and never open the user's project.

Do this and stop:
1. One or two targeted searches for the task words and one nearby synonym or guide term.
2. Open only the chunks that clearly match. Skip the rest.
3. Return a short package: chunk id, path, and the fact, rule, or step the main agent needs. Note a contradiction only if you actually saw one.

Do not tour the manifest, do not chase every link, do not run a third search to be thorough. If nothing matches, say nothing found and stop. Do not answer the user's task.`;

const SEARCH_SYNTHESIS_SYSTEM_PROMPT = `You are LAB-IN Search Lead. Merge the scout reports into one short package for the main agent. Do not search again.

Keep each unique fact with its chunk id and path. Drop duplicate wording. Keep a contradiction only when two reports actually disagree. Do not add new research and do not answer the user's task.`;

const SEARCH_HELPERS = [
  {
    id: "semantic",
    label: "Semantic scout",
    mission: "One search for the task words and a close synonym. Read only the hits that match. Return those chunks and stop.",
  },
  {
    id: "architecture",
    label: "Guides scout",
    mission: "One search for a guide, setup step, or rule that changes how the task is done. Read the best hit. Return it and stop.",
  },
  {
    id: "adversarial",
    label: "Exceptions scout",
    mission: "One search for a warning, exception, or old decision about this task. If you find one, quote it. Otherwise say none and stop.",
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
    "Search once or twice, read the matching chunks, and return them. Other scouts cover the other angles. Do not keep searching.",
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
    "Search once, read only the hits that match your lens, and return chunk id, path, and the useful lines. Then stop.",
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
