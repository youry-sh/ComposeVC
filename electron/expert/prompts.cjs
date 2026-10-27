/**
 * Prompts for the Expert workspace.
 *
 * Two jobs:
 *  1. Study rounds — a tool-using agent reads the real project and returns a
 *     dossier slice that is merged and persisted per project folder.
 *  2. Compose — turns the dossier + the user's task into ONE implementation
 *     prompt that another coding agent can execute, without role-play filler.
 */

const ROUNDS = [
  {
    id: "architecture",
    title: "Architecture & entrypoints",
    goal:
      "Map how the project is assembled: entrypoints, process boundaries, module layout, build/run scripts, " +
      "and the 8–15 modules that carry the product.",
  },
  {
    id: "core",
    title: "Core logic & data flow",
    goal:
      "Trace the main user-visible flows end to end: which function starts them, which state they mutate, " +
      "which modules they call, where results land. Name real symbols.",
  },
  {
    id: "contracts",
    title: "Contracts: IPC / HTTP / events / UI",
    goal:
      "Enumerate the integration surfaces: IPC channels (main ↔ preload ↔ renderer), HTTP routes, custom events, " +
      "UI entrypoints and the components that consume them. These are what a new feature must plug into.",
  },
  {
    id: "state",
    title: "State, persistence, conventions & gaps",
    goal:
      "Document stores/schemas/migrations, persistence paths, error handling conventions, tests and build config. " +
      "Note real gaps (missing states, duplicated pipelines) that a future task must respect.",
  },
];

const STUDY_SYSTEM = `You are the Project Cartographer inside ComposeVC. You study a real repository with tools and report verified facts.

Rules:
- Evidence only: every claim must come from a file you read or a grep you ran. If you did not verify it, omit it.
- Be exhaustive inside the assigned focus area, not vague. Prefer exact paths and symbol names over prose.
- Read-only: never edit, create or delete files. Use read_file, grep, list_dir.
- Work in the user's focus list first; then follow imports/callers that are clearly relevant.
- Output MUST end with a single JSON object (no markdown fences, no commentary after it) shaped like:
{"summary":"","architecture":"","modules":[{"path":"rel/path","role":"what it does","symbols":["name"]}],"flows":[{"name":"","steps":["1. ...","2. ..."],"files":["rel/path"]}],"contracts":[{"kind":"ipc|http|event|store|state","id":"channel or key","producer":"rel/path#symbol","consumer":"rel/path#symbol","files":["rel/path"]}],"conventions":["..."],"reuse":[{"need":"what a future task needs","existing":"what already exists","where":"rel/path#symbol"}],"gaps":["..."],"glossary":[{"term":"","meaning":""}]}
- Arrays may be empty. Never invent a path that is not in the index or the focus list.`;

const COMPOSE_SYSTEM_BASE = `You are the Expert Prompt Composer. You know this repository from a verified dossier and you write ONE implementation prompt for a coding agent that will work in the same repository.

Hard output rules:
- Output ONLY the prompt text. No preface, no "here is the prompt", no code fences around the whole answer, no role-play preamble ("You are a senior..."), no closing offers.
- Same language as the user's task.
- Ground every reference in the dossier: real file paths, real symbol names, real IPC channels / routes / store keys. If the dossier does not prove a name, phrase it as an inspection step instead of inventing one.
- Do not add features the user did not ask for. Small glue work (a preload bridge, a store writer, an event emit, a UI state) is allowed only when it is required to connect the task to existing code.
- Reuse existing modules and name where they live. Prefer extending current pipelines over new abstractions.
- No fluff, no motivational text, no explanations of your own process, no mention of this composer or the study phase.

Output shape (markdown headings, no fences):
## Task
1–3 imperative sentences: what must exist after the change.
## Existing context
Short bullets — "path — what it already does" and the exact contract names that will be touched.
## Changes
Numbered, file-scoped steps. For every step: file to touch, symbol to add/extend, and how it connects to the existing pipeline (store → IPC → preload → types → UI → event). Include data/validation/error behaviour when relevant.
## Constraints
Project conventions to respect, compatibility and what must NOT be changed.
## Done when
3–7 concrete, checkable acceptance criteria (behaviour + persistence + failure states).`;

const SMALL_TALK = /^(привет|прив|хай|здравствуй(те)?|добрый (день|вечер)|hello|hi|hey|yo|test|тест|проверка|ping)[\s!.,?)]*$/i;

function isSmallTalk(task) {
  const text = String(task || "").trim();
  if (!text) return true;
  if (text.length <= 40 && SMALL_TALK.test(text)) return true;
  return false;
}

function pickFocus(roundId, scan, readFiles) {
  const files = Array.isArray(scan?.files) ? scan.files : [];
  const read = new Set((readFiles || []).map((item) => String(item).toLowerCase()));
  const notRead = (file) => !read.has(String(file.p).toLowerCase());
  const byScore = [...files].sort((a, b) => (b.score || 0) - (a.score || 0));
  const byUsed = [...files].sort(
    (a, b) => (b.usedBy?.length || 0) - (a.usedBy?.length || 0) || (b.lines || 0) - (a.lines || 0)
  );
  const matches = (regex) => files.filter((file) => regex.test(file.p));
  let picked = [];
  if (roundId.startsWith("coverage")) {
    picked = [...byScore.filter(notRead), ...byScore];
  } else if (roundId === "architecture") {
    const entries = new Set(scan?.entrypoints || []);
    picked = [...files.filter((file) => entries.has(file.p)), ...byUsed];
  } else if (roundId === "core") {
    picked = [...byUsed, ...byScore];
  } else if (roundId === "contracts") {
    const contractFiles = matches(/(ipc|preload|router|route|api|server|store|provider|adapter|agent|bridge)/i);
    picked = [...contractFiles.sort((a, b) => (b.score || 0) - (a.score || 0)), ...byScore];
  } else {
    const stateFiles = matches(/(store|db|schema|migrat|persist|model|repo|test|spec|config|builder|package)/i);
    picked = [...stateFiles.sort((a, b) => (b.score || 0) - (a.score || 0)), ...byScore];
  }
  const dedup = new Map();
  for (const file of picked) {
    if (dedup.has(file.p)) continue;
    if (file.ext === ".md" && dedup.size > 6) continue;
    dedup.set(file.p, file);
    if (dedup.size >= 26) break;
  }
  const focus = [...dedup.values()];
  const unread = focus.filter(notRead).length;
  return { focus, unread, totalFiles: files.length, readCount: read.size };
}

function renderFocus(focus) {
  return focus
    .map((file) => {
      const symbols = (file.symbols || []).slice(0, 12).map((symbol) => symbol.n).join(", ");
      const imports = (file.imports || []).slice(0, 8).join(", ");
      return `- ${file.p} (${file.lines}l${symbols ? `; symbols: ${symbols}` : ""}${imports ? `; imports: ${imports}` : ""})`;
    })
    .join("\n");
}

function buildStudyUserPrompt({ round, roundIndex, roundCount, digest, scan, focus, previousDossier }) {
  const parts = [];
  parts.push(`PROJECT: ${scan?.projectName || "?"}`);
  parts.push(`STUDY ROUND ${roundIndex + 1}/${roundCount} — ${round.title}`);
  parts.push(`GOAL: ${round.goal}`);
  parts.push("");
  parts.push("VERIFIED SCAN DIGEST (every path below exists on disk):");
  parts.push(digest);
  parts.push("");
  parts.push("FOCUS FILES FOR THIS ROUND (read them; follow their imports when it clarifies the flow):");
  parts.push(renderFocus(focus.focus));
  if (previousDossier && (previousDossier.summary || previousDossier.architecture)) {
    parts.push("");
    parts.push("WHAT PREVIOUS ROUNDS ALREADY ESTABLISHED (do not repeat; add new facts):");
    parts.push(String(previousDossier.summary || "").slice(0, 1800));
    parts.push(String(previousDossier.architecture || "").slice(0, 2400));
  }
  parts.push("");
  parts.push(
    "Use read_file/grep/list_dir to verify. Then return the JSON object described in your instructions. " +
      "Populate only the sections this round covers; leave the rest as empty arrays/strings."
  );
  return parts.join("\n");
}

function buildComposeUserPrompt({ task, digest, dossierText, conversation, projectName, studyMeta }) {
  const parts = [];
  parts.push(`REPOSITORY: ${projectName || "?"}`);
  if (studyMeta?.files) {
    parts.push(
      `STUDY: ${studyMeta.files} files / ${studyMeta.lines || 0} lines scanned · ${studyMeta.rounds || 0} study rounds · ${studyMeta.modules || 0} modules mapped`
    );
  }
  parts.push("");
  parts.push("USER TASK (verbatim):");
  parts.push('"""');
  parts.push(String(task || "").trim());
  parts.push('"""');
  if (conversation && conversation.trim()) {
    parts.push("");
    parts.push("CONVERSATION SO FAR (this is an iterative refinement — produce the FULL updated prompt, not a diff):");
    parts.push(conversation.trim().slice(0, 12000));
  }
  parts.push("");
  parts.push("PROJECT DOSSIER (verified facts):");
  parts.push(dossierText.slice(0, 22000));
  parts.push("");
  parts.push("VERIFIED SCAN DIGEST:");
  parts.push(digest.slice(0, 22000));
  parts.push("");
  parts.push("Write the implementation prompt now. Output only the prompt.");
  return parts.join("\n");
}

function renderDossier(dossier, scan) {
  if (!dossier) return "No dossier yet — use the verified scan digest only.";
  const lines = [];
  const pushList = (label, list, render) => {
    if (!Array.isArray(list) || !list.length) return;
    lines.push(`${label}:`);
    for (const item of list.slice(0, 60)) lines.push(`- ${render(item)}`);
  };
  if (dossier.summary) lines.push(`SUMMARY: ${dossier.summary}`);
  if (dossier.architecture) lines.push(`ARCHITECTURE: ${dossier.architecture}`);
  pushList("MODULES", dossier.modules, (m) => `${m.path} — ${m.role}${m.symbols?.length ? ` [${m.symbols.slice(0, 8).join(", ")}]` : ""}`);
  pushList("FLOWS", dossier.flows, (f) => `${f.name}: ${(f.steps || []).join(" → ")}${f.files?.length ? ` (${f.files.slice(0, 6).join(", ")})` : ""}`);
  pushList(
    "CONTRACTS",
    dossier.contracts,
    (c) => `${c.kind || "?"} ${c.id || ""} — ${c.producer || "?"} → ${c.consumer || "?"}`
  );
  pushList("REUSE MAP", dossier.reuse, (r) => `${r.need} → already exists: ${r.existing} @ ${r.where}`);
  pushList("CONVENTIONS", dossier.conventions, (item) => String(item));
  pushList("GAPS", dossier.gaps, (item) => String(item));
  pushList("GLOSSARY", dossier.glossary, (g) => `${g.term}: ${g.meaning}`);
  if (scan?.entrypoints?.length) lines.push(`ENTRYPOINTS: ${scan.entrypoints.slice(0, 15).join(", ")}`);
  const text = lines.join("\n");
  return text.length > 26000 ? `${text.slice(0, 26000)}\n…[dossier truncated]` : text;
}

function stripFences(text) {
  let out = String(text || "").trim();
  if (out.startsWith("```")) {
    const firstBreak = out.indexOf("\n");
    if (firstBreak !== -1) out = out.slice(firstBreak + 1);
    if (out.trimEnd().endsWith("```")) out = out.trimEnd().slice(0, -3);
  }
  return out.trim();
}

function cleanComposedPrompt(text) {
  let out = stripFences(text);
  const lines = out.split("\n");
  while (lines.length) {
    const first = lines[0].trim();
    if (!first) {
      lines.shift();
      continue;
    }
    const isLabel =
      first.length <= 120 &&
      /^(here('| i)s|here you go|below is|вот|ниже)[^]*?(prompt|промт|запрос)|^(prompt|промт|запрос|final prompt)\s*[:\-]/i.test(
        first
      );
    if (!isLabel) break;
    lines.shift();
  }
  out = lines.join("\n").trim();
  out = out.replace(/\n{3,}/g, "\n\n");
  // Drop a trailing "let me know / if you want" courtesy paragraph.
  const trailing = /(^|\n)(let me know[^]*|if you('| a)re[^]*want[^]*|если (нужно|хотите|что-то)[^]*)$/i;
  const match = out.match(trailing);
  if (match && match[0].length < 400) out = out.slice(0, out.length - match[0].length).trim();
  return out.trim();
}

function parseDossierJson(text) {
  const raw = stripFences(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  ROUNDS,
  STUDY_SYSTEM,
  COMPOSE_SYSTEM_BASE,
  isSmallTalk,
  pickFocus,
  buildStudyUserPrompt,
  buildComposeUserPrompt,
  renderDossier,
  cleanComposedPrompt,
  parseDossierJson,
};
