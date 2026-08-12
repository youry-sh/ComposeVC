const fs = require("fs");
const path = require("path");
const folderTools = require("./ctl/folderTools.cjs");
const toolZip = require("./ctl/toolZip.cjs");

const CUSTOM_TOOLS_DIR = "custom-tools";
const MAX_DESCRIPTION_LEN = 400;
const MAX_NAME_LEN = 64;
const MAX_DEPTH = 6;
const FULL_INJECT_MAX = 45;
const CATALOG_TOP_K = 20;
const CATALOG_MIN_K = 8;
const SEARCH_DEFAULT_LIMIT = 25;
const SEARCH_MAX_LIMIT = 80;
const BODY_INDEX_CHARS = 800;
const RESERVED_NAMES = new Set([
  "read_file",
  "edit_file",
  "create_file",
  "list_dir",
  "grep",
  "bash",
  "compact_history",
  "web_search",
  "web_fetch",
  "ask_user",
  "ask_otp",
  "cf_mail",
  "spawn_subagent",
  "spawn_subagent_batch",
  "restore_backup",
  "custom_tool",
  "custom_tools",
  "http",
]);

function getCustomToolsDir(userDataPath) {
  return path.join(userDataPath, CUSTOM_TOOLS_DIR);
}

function normalizeToolName(raw) {
  const name = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_NAME_LEN);
  return name;
}

function normalizeInputSchema(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }
  const schema = { ...raw };
  if (!schema.type) schema.type = "object";
  if (!schema.properties || typeof schema.properties !== "object") {
    schema.properties = {};
  }
  return schema;
}

async function readCustomTools(userDataPath) {
  if (!userDataPath) return [];
  const folders = await folderTools.listFolderTools(userDataPath).catch(() => []);
  return folders.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""))
  );
}

function toolSummary(tool) {
  const kind = tool.kind || tool.body?.kind || "folder";
  return {
    id: tool.id,
    name: tool.name,
    title: tool.title,
    description: tool.description || "",
    enabled: tool.enabled !== false,
    tags: Array.isArray(tool.tags) ? tool.tags : [],
    dependencies: Array.isArray(tool.dependencies) ? tool.dependencies : [],
    kind,
    path: tool.path || tool.folder || tool.body?.toolDir || null,
    folder: tool.folder || tool.path || null,
    runtime: tool.runtime || tool.body?.runtime || null,
    entry: tool.entry || tool.body?.entry || null,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
}

function isToolEnabled(tool) {
  return tool != null && tool.enabled !== false;
}

async function findCustomTool(userDataPath, { id, name } = {}) {
  const tools = await readCustomTools(userDataPath);
  if (id) {
    const byId = tools.find((t) => t.id === String(id));
    if (byId) return byId;
  }
  if (name) {
    const n = normalizeToolName(name);
    const hit = tools.find((t) => t.name === n);
    if (hit) return hit;
  }
  return null;
}

function assertNameAvailable(tools, name, excludeId) {
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Tool name "${name}" is reserved for a built-in tool`);
  }
  const clash = tools.find((t) => t.name === name && t.id !== excludeId);
  if (clash) throw new Error(`Custom tool name already exists: ${name}`);
}

function dependencyNames(raw, ownName) {
  return [...new Set((Array.isArray(raw) ? raw : []).map(normalizeToolName).filter((name) => name && name !== ownName))];
}

function assertDependencyGraph(tools, toolName, rawDependencies, previousName = toolName) {
  const dependencies = dependencyNames(rawDependencies, toolName);
  const known = new Set(tools.map((tool) => tool.name));
  for (const name of dependencies) {
    if (!known.has(name) && name !== previousName) throw new Error(`Connected custom tool not found: ${name}`);
  }
  const graph = new Map(tools.map((tool) => [tool.name, dependencyNames(tool.dependencies, tool.name)]));
  if (previousName !== toolName) graph.delete(previousName);
  graph.set(toolName, dependencies);
  const visiting = new Set();
  const visited = new Set();
  const walk = (name, trail) => {
    if (visiting.has(name)) throw new Error(`Custom tool connection cycle blocked: ${[...trail, name].join(" -> ")}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const next of graph.get(name) || []) walk(next, [...trail, name]);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) walk(name, []);
  return dependencies;
}

function wantsFolderTool(input = {}) {
  return true;
}

async function addCustomTool(userDataPath, input = {}) {
  const tools = await readCustomTools(userDataPath);
  const name = normalizeToolName(input.name);
  if (!name) throw new Error("Tool name is required");
  assertNameAvailable(tools, name, null);
  const dependencies = assertDependencyGraph(tools, name, input.dependencies || []);

  const bodyIn =
    input.body != null && typeof input.body === "object"
      ? input.body
      : {};
  const tool = await folderTools.ensureToolScaffold(userDataPath, {
    name,
    title: input.title || input.label,
    description: input.description,
    runtime:
      input.runtime ||
      input.lang ||
      input.language ||
      bodyIn.runtime ||
      bodyIn.lang ||
      bodyIn.language ||
      "node",
    entry: input.entry || bodyIn.entry || bodyIn.main,
    code:
      input.code != null
        ? input.code
        : input.content != null
          ? input.content
          : bodyIn.code != null
            ? bodyIn.code
            : typeof input.source === "string" && !String(input.source).trim().startsWith("{")
              ? input.source
              : undefined,
    inputSchema: input.inputSchema || input.schema,
    enabled: input.enabled,
    tags: Array.isArray(input.tags) ? input.tags : ["folder"],
    dependencies,
    timeout_ms: input.timeout_ms || input.timeoutMs || bodyIn.timeout_ms,
    files: input.files || bodyIn.files,
  });
  if (Array.isArray(input.files) && input.files.length) {
    await folderTools.updateFolderManifest(userDataPath, name, { files: input.files });
    return folderTools.readFolderTool(userDataPath, name);
  }
  return tool;
}

async function updateCustomTool(userDataPath, toolId, patch = {}) {
  const tools = await readCustomTools(userDataPath);
  const current =
    tools.find((t) => t.id === String(toolId)) ||
    tools.find((t) => t.name === normalizeToolName(toolId));
  if (!current) throw new Error(`Custom tool not found: ${toolId}`);

  const nextName = patch.name != null ? normalizeToolName(patch.name) : current.name;
  assertNameAvailable(tools, nextName, current.id);
  const dependencies = assertDependencyGraph(
    tools,
    nextName,
    patch.dependencies != null ? patch.dependencies : current.dependencies || [],
    current.name
  );

  const updated = await folderTools.updateFolderManifest(userDataPath, current.name, {
    ...patch,
    name: patch.name,
    dependencies,
  });
  if (nextName !== current.name) {
    for (const tool of tools) {
      if (tool.id === current.id || !Array.isArray(tool.dependencies) || !tool.dependencies.includes(current.name)) continue;
      await folderTools.updateFolderManifest(userDataPath, tool.name, {
        dependencies: tool.dependencies.map((name) => name === current.name ? nextName : name),
      });
    }
  }
  return updated;
}

async function removeCustomTool(userDataPath, toolId) {
  const tools = await readCustomTools(userDataPath);
  const found =
    tools.find((t) => t.id === String(toolId)) ||
    tools.find((t) => t.name === normalizeToolName(toolId));
  if (!found) return { deleted: false };

  const result = await folderTools.removeFolderTool(userDataPath, found.name);
  if (result.deleted) {
    for (const tool of tools) {
      if (tool.id === found.id || !Array.isArray(tool.dependencies) || !tool.dependencies.includes(found.name)) continue;
      await folderTools.updateFolderManifest(userDataPath, tool.name, {
        dependencies: tool.dependencies.filter((name) => name !== found.name),
      });
    }
  }
  return { deleted: result.deleted, tool: found, path: result.path || found.path };
}

const STOPWORDS = new Set(
  [
    "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "while", "for", "to", "of",
    "in", "on", "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been", "being",
    "it", "its", "this", "that", "these", "those", "you", "your", "we", "our", "they", "them", "their",
    "not", "no", "yes", "do", "does", "did", "done", "can", "could", "should", "would", "will", "just",
    "only", "also", "into", "over", "under", "about", "than", "too", "very", "so", "such", "via", "per",
    "use", "using", "used", "how", "what", "which", "who", "whom", "where", "why", "any", "all", "each",
    "other", "more", "most", "some", "same", "own", "out", "up", "down", "off", "tool", "tools", "custom",
    "и", "в", "во", "на", "с", "со", "к", "ко", "о", "об", "про", "для", "по", "из", "у", "от", "до",
    "за", "при", "без", "над", "под", "между", "это", "эта", "эти", "тот", "та", "те", "как", "что",
    "чтобы", "или", "но", "а", "же", "ли", "бы", "не", "ни", "да", "нет", "есть", "быть", "был", "была",
    "были", "будет", "можно", "нужно", "надо", "уже", "ещё", "еще", "тоже", "только", "если", "когда",
    "где", "кто", "чем", "этот", "тут", "там", "так", "вот", "мне", "меня", "мой", "моя", "мои", "твой",
    "ваш", "наш", "их", "его", "её", "ее", "мы", "вы", "он", "она", "они", "я", "ты", "тул", "тулы",
    "тулл", "туллы", "кастом", "кастомный", "кастомные",
  ].map((w) => w.toLowerCase())
);

// Hybrid lexical retrieval is deliberately dependency-free: 1,000 tools are small
// enough to rank in-memory, while avoiding an embedding model keeps startup reliable.
const RU_STOPWORDS = "и в во на с со к ко о об про для по из у от до за при без над под между это эта эти тот та те как что чтобы или но а же ли бы не ни да нет есть быть был была были будет можно нужно надо уже ещё еще тоже только если когда где кто чем этот тут там так вот мне меня мой моя мои твой ваш наш их его её ее мы вы он она они я ты тул тулы кастом кастомный кастомные".split(" ");
for (const word of RU_STOPWORDS) STOPWORDS.add(word);
const CYRILLIC_MAP = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
const CONCEPTS = [
  ["search", "find", "lookup", "искать", "поиск", "найти"],
  ["download", "fetch", "save", "скачать", "загрузить", "сохранить"],
  ["email", "mail", "gmail", "почта", "письмо"],
  ["image", "photo", "picture", "изображение", "фото", "картинка"],
  ["video", "youtube", "ролик", "видео"], ["telegram", "tg", "телеграм"],
  ["parse", "extract", "scrape", "парсить", "извлечь", "собрать"],
  ["convert", "transform", "encode", "конвертировать", "преобразовать"],
  ["database", "sql", "db", "база", "данные"], ["file", "document", "файл", "документ"],
  ["audio", "sound", "voice", "аудио", "звук", "голос"], ["translate", "translation", "перевести", "перевод"],
];
const CONCEPT_BY_TERM = new Map();
for (const group of CONCEPTS) for (const term of group) CONCEPT_BY_TERM.set(term, group);

function normalizeSearchText(text) {
  return String(text || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function transliterate(text) {
  return normalizeSearchText(text).replace(/[а-яё]/g, (ch) => CYRILLIC_MAP[ch] ?? ch);
}
function stemToken(token) {
  if (/^[а-яё]{5,}$/u.test(token)) return token.replace(/(иями|ами|ями|ого|ему|ому|ыми|ими|ить|ать|ять|еть|уть|ов|ев|ий|ый|ая|яя|ое|ее|ые|ие|ам|ям|ах|ях|ом|ем|у|ю|а|я|ы|и|ь)$/u, "");
  if (/^[a-z]{5,}$/.test(token)) return token.replace(/(ingly|edly|ation|ments|ment|ness|ing|ers|ies|ied|ed|es|s)$/, "");
  return token;
}
function tokenize(text, { expand = false } = {}) {
  const parts = normalizeSearchText(text).replace(/[^\p{L}\p{N}/._-]+/gu, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const compound = part.replace(/^\/+/, "").replace(/^-+|-+$/g, "");
    for (const token of [compound, ...compound.split(/[-_]+/)]) {
      if (!token || token.length < 2 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
      out.push(token, stemToken(token));
      const latin = transliterate(token);
      if (latin !== token) out.push(latin);
      if (expand) for (const synonym of CONCEPT_BY_TERM.get(token) || []) out.push(synonym, stemToken(synonym));
    }
  }
  return [...new Set(out.filter(Boolean))];
}
function trigrams(text) {
  const value = `  ${transliterate(text).replace(/[^a-z0-9]+/g, " ")}  `;
  const result = new Set();
  for (let i = 0; i <= value.length - 3; i++) result.add(value.slice(i, i + 3));
  return result;
}
function diceSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const gram of a) if (b.has(gram)) common++;
  return (2 * common) / (a.size + b.size);
}
function toolSearchDocument(tool) {
  const schema = tool.inputSchema || {};
  const fields = {
    name: String(tool.name || ""), title: String(tool.title || ""),
    tags: (Array.isArray(tool.tags) ? tool.tags : []).join(" "), description: String(tool.description || ""),
    schema: JSON.stringify({ properties: schema.properties, required: schema.required }),
    body: JSON.stringify(tool.body || {}).slice(0, BODY_INDEX_CHARS),
  };
  const tokens = {};
  for (const [key, value] of Object.entries(fields)) tokens[key] = tokenize(value);
  return { fields, tokens, all: new Set(Object.values(tokens).flat()), grams: trigrams(Object.values(fields).join(" ")) };
}
function scoreCustomTool(tool, query, queryTerms, doc, stats) {
  const q = normalizeSearchText(query).trim();
  if (!q) return { score: 0, weak: true, coverage: 0 };
  const weights = { name: 9, title: 6, tags: 7, description: 3, schema: 2, body: 0.6 };
  let score = 0;
  for (const [field, tokens] of Object.entries(doc.tokens)) {
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const term of queryTerms) {
      const tf = counts.get(term) || 0;
      if (!tf) continue;
      const df = stats.df.get(term) || 0;
      const idf = Math.log(1 + (stats.count - df + 0.5) / (df + 0.5));
      score += weights[field] * idf * ((tf * 2.2) / (tf + 1.2));
    }
  }
  const name = normalizeSearchText(doc.fields.name).replace(/[_-]+/g, " ");
  const title = normalizeSearchText(doc.fields.title);
  if (name === q) score += 80; else if (name.includes(q)) score += 30;
  if (title === q) score += 45; else if (q.length >= 4 && title.includes(q)) score += 18;
  const fuzzy = diceSimilarity(stats.queryGrams, doc.grams);
  if (fuzzy >= 0.18) score += fuzzy * 18;
  const matched = stats.originalTerms.filter((term) => doc.all.has(term)).length;
  const coverage = stats.originalTerms.length ? matched / stats.originalTerms.length : 0;
  score *= 0.65 + 0.75 * coverage;
  if (stats.originalTerms.length > 1 && coverage === 1) score += 22;
  return { score, weak: score < 1, coverage, fuzzy };
}

function rankCustomTools(tools, query, { limit = CATALOG_TOP_K } = {}) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  const q = String(query || "").trim();
  const originalTerms = tokenize(q);
  const terms = tokenize(q, { expand: true });
  const cap = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Number(limit) || CATALOG_TOP_K));
  const docs = list.map((tool) => ({ tool, doc: toolSearchDocument(tool) }));
  const df = new Map();
  for (const { doc } of docs) for (const term of doc.all) df.set(term, (df.get(term) || 0) + 1);
  const stats = { count: Math.max(1, list.length), df, originalTerms, queryGrams: trigrams(q) };
  const scored = docs
    .map(({ tool, doc }) => {
      const details = scoreCustomTool(tool, q, terms, doc, stats);
      return { tool, ...details };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        String(a.tool.name || "").localeCompare(String(b.tool.name || ""))
    );
  if (q && scored.some((x) => x.score > 0)) {
    return scored.filter((x) => x.score > 0).slice(0, cap);
  }
  return scored.slice(0, cap).map((x) => ({ ...x, weak: true }));
}

function selectCustomToolsForInject(tools, query, { limit } = {}) {
  const enabled = Array.isArray(tools) ? tools.filter(isToolEnabled) : [];
  if (!enabled.length) {
    return { selected: [], mode: "empty", totalEnabled: 0, omitted: 0, hasScores: false };
  }
  if (enabled.length <= FULL_INJECT_MAX) {
    const selected = enabled
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    return {
      selected,
      mode: "full",
      totalEnabled: enabled.length,
      omitted: 0,
      hasScores: false,
    };
  }
  const topK = Math.min(
    FULL_INJECT_MAX,
    Math.max(CATALOG_MIN_K, Number(limit) || FULL_INJECT_MAX)
  );
  const ranked = rankCustomTools(enabled, query, { limit: topK });
  const selected = [];
  const seen = new Set();
  for (const row of ranked) {
    if (!row?.tool?.name || seen.has(row.tool.name)) continue;
    selected.push(row.tool);
    seen.add(row.tool.name);
    if (selected.length >= topK) break;
  }
  if (selected.length < topK) {
    const fillers = enabled
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const tool of fillers) {
      if (selected.length >= topK) break;
      if (!tool?.name || seen.has(tool.name)) continue;
      selected.push(tool);
      seen.add(tool.name);
    }
  }
  return {
    selected,
    mode: "search",
    totalEnabled: enabled.length,
    omitted: Math.max(0, enabled.length - selected.length),
    hasScores: ranked.some((r) => r.score > 0 && !r.weak),
    ranked,
  };
}

function formatCatalogLine(tool, extra = "") {
  const tags =
    Array.isArray(tool.tags) && tool.tags.length ? ` [${tool.tags.join(", ")}]` : "";
  const kind = tool.body?.kind ? ` kind=${tool.body.kind}` : "";
  const tail = extra ? ` ${extra}` : "";
  return `- ${tool.name} — ${tool.description || tool.title || ""}${tags}${kind}${tail} [id=${tool.id}]`;
}

function buildCustomToolCatalogSection(tools, opts = {}) {
  const all = Array.isArray(tools) ? tools : [];
  const enabled = all.filter(isToolEnabled);
  const disabledCount = all.length - enabled.length;
  const query = typeof opts.query === "string" ? opts.query : "";
  const pick = selectCustomToolsForInject(enabled, query, { limit: opts.limit });

  if (!enabled.length) {
    if (all.length === 0) {
      return (
        "Custom tools catalog: (none yet). Do not treat an empty catalog as permission to ignore custom tools. " +
        "For every non-trivial or reusable multi-step workflow, proactively create a generic folder tool with " +
        "custom_tool action=add (name, code, runtime, inputSchema, description, tags), smoke-test it, and use it now. " +
        "Enabled tools become first-class callable tools and persistent procedural memory for future tasks."
      );
    }
    return (
      "Custom tools catalog: (all custom tools disabled). Re-enable in Chat → Custom tools. " +
      "custom_tool action=run / enable still works by id/name."
    );
  }

  const toolHelp =
    "Custom tool usage — ACTIVE PREFLIGHT REQUIRED; FOLDER TOOLS ONLY (no CTL language):\n" +
    "- Before every non-trivial task, inspect this catalog and search when it may be incomplete. Do not wait for the user to request tool reuse.\n" +
    "- If a listed tool fits all OR PART of the task, call it BY NAME first-class (or custom_tool action=run) instead of recreating its logic.\n" +
    "- Library large / catalog incomplete / ambiguous match → custom_tool action=search with concise task keywords; never infer absence from visible top-K.\n" +
    "- Before roughly 3+ related manual calls, apply the creation test: if their deterministic logic is reusable, create a generic tool now—even on first occurrence.\n" +
    "- CREATE: custom_tool action=add name=… code=… runtime=node|python|powershell inputSchema=… description=… tags=… " +
    "→ scaffolds a folder under <userData>/custom-tools/<name>/ (NOT the open project); edit with custom_tool write_file.\n" +
    "- MODULAR: split non-trivial logic into helper files (lib/, helpers/) — one file per responsibility. " +
    "ONE ENTRY RUNS IT ALL through relative imports. Smoke with realistic args, fix failures, then use the new tool in the current task.\n" +
    "- Before finalizing, run a reuse check and capture any reusable manual multi-step routine that was missed.\n" +
    "- ENTRY CONTRACT: stdin = JSON {args, ctx}; stdout = JSON result (print JSON, exit 0). " +
    "Non-zero exit / stderr → tool FAILED. Do not put tools in the project tree or electron/tools.";

  const disabledNote =
    disabledCount > 0
      ? `\n(${disabledCount} custom tool${disabledCount === 1 ? "" : "s"} disabled — omitted from auto-catalog.)`
      : "";

  if (pick.mode === "full") {
    const lines = pick.selected.map((t) => formatCatalogLine(t));
    return (
      `Custom tools catalog (${pick.totalEnabled} enabled; full list — each is also a first-class tool schema):\n` +
      lines.join("\n") +
      disabledNote +
      "\n" +
      toolHelp
    );
  }

  const ranked = Array.isArray(pick.ranked) ? pick.ranked : [];
  const lines = pick.selected.map((t) => {
    const hit = ranked.find((r) => r.tool?.id === t.id || r.tool?.name === t.name);
    const extra =
      hit && hit.score > 0 && !hit.weak ? `(relevance ${Math.round(hit.score)})` : "";
    return formatCatalogLine(t, extra);
  });
  const modeNote = pick.hasScores
    ? `search-first top ${pick.selected.length} of ${pick.totalEnabled} enabled for this message`
    : `no strong keyword hit — showing ${pick.selected.length} of ${pick.totalEnabled}; you MUST custom_tool search before reinventing workflows`;
  return (
    `Custom tools catalog (${modeNote}). ` +
    `ALL ${pick.totalEnabled} enabled custom tools remain available via custom_tool search / list / run — ` +
    `only the prompt+schema inject is capped at ${FULL_INJECT_MAX}.\n` +
    (query.trim()
      ? `Query used for ranking: ${JSON.stringify(query.trim().slice(0, 240))}\n`
      : "") +
    lines.join("\n") +
    (pick.omitted > 0
      ? `\n… +${pick.omitted} more enabled custom tools not injected as schemas. ` +
        `Find them: custom_tool action=search query=… then call by name if injected, else custom_tool action=run name=… args={…}. ` +
        `Never assume a custom tool is missing without searching.`
      : "") +
    disabledNote +
    "\n" +
    toolHelp
  );
}

async function searchCustomTools(userDataPath, query, { limit = SEARCH_DEFAULT_LIMIT, includeDisabled = false } = {}) {
  const all = await readCustomTools(userDataPath);
  const list = includeDisabled ? all : all.filter(isToolEnabled);
  const q = String(query || "").trim().toLowerCase();
  const cap = Math.min(SEARCH_MAX_LIMIT, Math.max(1, Number(limit) || SEARCH_DEFAULT_LIMIT));
  if (!q) {
    return {
      query: q,
      count: list.length,
      total: all.length,
      injectMode: list.filter(isToolEnabled).length <= FULL_INJECT_MAX ? "full" : "search",
      fullInjectMax: FULL_INJECT_MAX,
      results: list.slice(0, cap).map(toolSummary),
    };
  }
  const ranked = rankCustomTools(list, q, { limit: cap }).filter((x) => x.score > 0);
  return {
    query: q,
    count: ranked.length,
    total: all.length,
    injectMode: list.filter(isToolEnabled).length <= FULL_INJECT_MAX ? "full" : "search",
    fullInjectMax: FULL_INJECT_MAX,
    results: ranked.map(({ tool, score, coverage, fuzzy }) => ({
      ...toolSummary(tool),
      score: Math.round(score * 100) / 100,
      coverage: Math.round((coverage || 0) * 100) / 100,
      fuzzy: Math.round((fuzzy || 0) * 100) / 100,
    })),
  };
}

function schemaToToolSchema(tool) {
  return {
    name: tool.name,
    description:
      (tool.description || tool.title || tool.name) +
      (tool.tags?.length ? ` [custom: ${tool.tags.join(", ")}]` : " [custom tool]"),
    inputSchema: tool.inputSchema || { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: false,
    isCustom: true,
    customId: tool.id,
  };
}

async function getEnabledCustomToolSchemas(userDataPath, { query = "", limit } = {}) {
  const tools = await readCustomTools(userDataPath);
  const pick = selectCustomToolsForInject(tools, query, { limit });
  return pick.selected.map(schemaToToolSchema);
}

async function executeCustomTool(tool, input, context = {}) {
  const depth = Number(context.__customToolDepth) || 0;
  if (depth > MAX_DEPTH) {
    throw new Error(`Custom tool recursion limit exceeded (max depth ${MAX_DEPTH})`);
  }
  if (!tool) throw new Error("Invalid custom tool");
  if (tool.enabled === false) throw new Error(`Custom tool is disabled: ${tool.name}`);

  let folderTool = tool;
  if (context.userDataPath && tool.name) {
    try {
      const fresh = await folderTools.readFolderTool(context.userDataPath, tool.name);
      if (fresh) folderTool = fresh;
    } catch {
      /* use provided tool def */
    }
  }
  return folderTools.executeFolderTool(folderTool, input, {
    ...context,
    userDataPath: context.userDataPath || null,
  });
}

async function executeCustomToolByName(userDataPath, name, input, context = {}) {
  const tool = await findCustomTool(userDataPath, { name });
  if (!tool) throw new Error(`Unknown custom tool: ${name}`);
  return executeCustomTool(tool, input, { ...context, userDataPath });
}

async function executeCustomToolById(userDataPath, id, input, context = {}) {
  const tool = await findCustomTool(userDataPath, { id });
  if (!tool) throw new Error(`Unknown custom tool id: ${id}`);
  return executeCustomTool(tool, input, { ...context, userDataPath });
}

const PACK_FORMAT = "lopster-custom-tools";
const PACK_VERSION = 1;

async function toShareEntry(tool) {
  if (!tool) return null;
  let code;
  const entryAbs = tool.entryPath || (tool.path ? path.join(tool.path, tool.entry || "main.js") : null);
  if (entryAbs) {
    try {
      code = await fs.promises.readFile(entryAbs, "utf8");
    } catch {
      code = undefined;
    }
  }
  return {
    name: tool.name,
    title: tool.title || tool.name,
    description: tool.description || "",
    body: tool.body,
    code,
    inputSchema: tool.inputSchema || {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    enabled: tool.enabled !== false,
    tags: Array.isArray(tool.tags) ? tool.tags : [],
    dependencies: Array.isArray(tool.dependencies) ? tool.dependencies : [],
  };
}

async function buildExportPack(tools, { ids, names, includeDisabled = true } = {}) {
  const list = Array.isArray(tools) ? tools.filter(Boolean) : [];
  let selected = list;
  if (Array.isArray(ids) && ids.length) {
    const idSet = new Set(ids.map((x) => String(x)));
    selected = selected.filter((t) => idSet.has(String(t.id)));
  }
  if (Array.isArray(names) && names.length) {
    const nameSet = new Set(names.map((x) => normalizeToolName(x)).filter(Boolean));
    selected = selected.filter((t) => nameSet.has(t.name));
  }
  if (!includeDisabled) selected = selected.filter(isToolEnabled);
  const entries = (await Promise.all(selected.map(toShareEntry))).filter(Boolean);
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: Date.now(),
    count: entries.length,
    tools: entries,
  };
}

async function exportCustomTools(userDataPath, options = {}) {
  const tools = await readCustomTools(userDataPath);
  const outPath = options.path || options.filePath || options.zip || null;
  const wantZip =
    options.zip === true ||
    options.format === "zip" ||
    (typeof outPath === "string" && toolZip.looksLikeZipPath(outPath));

  let selected = tools;
  if (Array.isArray(options.ids) && options.ids.length) {
    const idSet = new Set(options.ids.map((x) => String(x)));
    selected = selected.filter((t) => idSet.has(String(t.id)));
  }
  if (Array.isArray(options.names) && options.names.length) {
    const nameSet = new Set(options.names.map((x) => normalizeToolName(x)).filter(Boolean));
    selected = selected.filter((t) => nameSet.has(t.name));
  } else if (options.name || options.tool) {
    const n = normalizeToolName(options.name || options.tool);
    if (n) selected = selected.filter((t) => t.name === n);
  }
  if (options.includeDisabled === false) selected = selected.filter(isToolEnabled);

  if (wantZip) {
    if (!outPath) {
      throw new Error(
        "Zip export requires path ending in .zip (e.g. path=C:\\\\temp\\\\my_tool.zip)"
      );
    }
    if (!selected.length) throw new Error("No tools matched export filter");
    const zipResult = await toolZip.exportToolsToZip(userDataPath, selected, String(outPath), {
      includeWork: options.includeWork === true,
    });
    return {
      ...zipResult,
      format: "zip",
      pack: null,
      text: null,
      saved: true,
      names: zipResult.names,
    };
  }

  const pack = await buildExportPack(selected, {
    includeDisabled: options.includeDisabled !== false,
  });
  const text = JSON.stringify(pack, null, 2);
  const result = {
    pack,
    text,
    count: pack.count,
    names: pack.tools.map((t) => t.name),
    format: "json",
  };
  if (outPath) {
    await fs.promises.mkdir(path.dirname(String(outPath)), { recursive: true });
    await fs.promises.writeFile(String(outPath), text, "utf8");
    result.saved = true;
    result.path = String(outPath);
  }
  return result;
}

function parseImportSource(raw) {
  if (raw == null) throw new Error("Import payload is empty");
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw).trim();
  if (!text) throw new Error("Import payload is empty");
  try {
    return JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid import JSON: ${msg}`);
  }
}

function extractImportEntries(source) {
  const parsed = parseImportSource(source);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (Array.isArray(parsed.tools)) return parsed.tools;
  if (Array.isArray(parsed.items)) return parsed.items;
  if (parsed.tool && typeof parsed.tool === "object") return [parsed.tool];
  if (parsed.name || parsed.body || parsed.source) return [parsed];
  throw new Error("Import JSON must be a pack { tools: [...] }, an array, or a single tool object");
}

function filterImportEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let selected = list.map((entry, index) => ({ entry, index }));

  if (Array.isArray(options.indices) && options.indices.length) {
    const indexSet = new Set(
      options.indices
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 0)
    );
    selected = selected.filter((item) => indexSet.has(item.index));
  }

  if (Array.isArray(options.ids) && options.ids.length) {
    const idSet = new Set(options.ids.map((x) => String(x)));
    selected = selected.filter((item) => {
      const id = item.entry && item.entry.id != null ? String(item.entry.id) : "";
      return id && idSet.has(id);
    });
  }

  const namesRaw = Array.isArray(options.names)
    ? options.names
    : options.name || options.tool
      ? [options.name || options.tool]
      : [];
  if (namesRaw.length) {
    const nameSet = new Set(namesRaw.map((x) => normalizeToolName(x)).filter(Boolean));
    selected = selected.filter((item) => {
      const name = normalizeToolName(item.entry && item.entry.name);
      return name && nameSet.has(name);
    });
  }

  if (options.onlyOne === true && selected.length > 1) {
    selected = selected.slice(0, 1);
  }

  return selected.map((item) => item.entry);
}

function entryKindOf(raw) {
  const body = raw && typeof raw === "object" && raw.body && typeof raw.body === "object" ? raw.body : {};
  const k = String(body.kind || body.type || raw.kind || "").trim().toLowerCase();
  if (!k) return "folder";
  if (k === "folder" || k === "code" || k === "dir" || k === "fs") return "folder";
  return k;
}

function summarizeImportEntry(raw, index = 0) {
  if (!raw || typeof raw !== "object") {
    return {
      index,
      name: "",
      title: "",
      description: "",
      kind: "unknown",
      enabled: true,
      tags: [],
      valid: false,
      error: "Entry is not an object",
    };
  }
  const name = normalizeToolName(raw.name) || "";
  const kind = entryKindOf(raw);
  let valid = Boolean(name);
  let error = name ? null : "Tool name is required";
  if (valid && kind !== "folder") {
    valid = false;
    error = "CTL (pipeline/script/call) tools are no longer supported — export as folder tool (code) instead";
  } else if (valid) {
    const hasCode =
      raw.code != null ||
      raw.content != null ||
      Array.isArray(raw.files) ||
      (typeof raw.source === "string" && !String(raw.source).trim().startsWith("{"));
    if (!hasCode) {
      valid = false;
      error = "No code in entry — folder tool requires entry code (code= or files=[...])";
    }
  }
  return {
    index,
    id: raw.id != null ? String(raw.id) : undefined,
    name,
    title: String(raw.title || raw.label || name || "").trim() || name,
    description: String(raw.description || "").trim(),
    kind,
    enabled: raw.enabled === false ? false : true,
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20)
      : [],
    valid,
    error,
  };
}

function previewCustomToolsImport(source, options = {}) {
  const entries = extractImportEntries(source);
  const filtered = filterImportEntries(entries, options);
  const tools = filtered.map((entry, i) => {
    const originalIndex = entries.indexOf(entry);
    return summarizeImportEntry(entry, originalIndex >= 0 ? originalIndex : i);
  });
  return {
    ok: true,
    count: tools.length,
    totalInPack: entries.length,
    tools,
  };
}

function uniqueImportName(baseName, existingNames, usedInBatch) {
  let name = normalizeToolName(baseName) || "imported_tool";
  if (!RESERVED_NAMES.has(name) && !existingNames.has(name) && !usedInBatch.has(name)) {
    return name;
  }
  let i = 2;
  while (i < 1000) {
    const candidate = normalizeToolName(`${name}_${i}`) || `imported_tool_${i}`;
    if (!RESERVED_NAMES.has(candidate) && !existingNames.has(candidate) && !usedInBatch.has(candidate)) {
      return candidate;
    }
    i += 1;
  }
  return normalizeToolName(`${name}_${Date.now().toString(16)}`) || `imported_${Date.now().toString(16)}`;
}

async function importCustomTools(userDataPath, source, options = {}) {
  const modeRaw = String(options.mode || options.onConflict || "skip")
    .trim()
    .toLowerCase();
  const mode =
    modeRaw === "overwrite" || modeRaw === "replace" || modeRaw === "update"
      ? "overwrite"
      : modeRaw === "rename" || modeRaw === "copy"
        ? "rename"
        : "skip";

  const zipPath =
    options.zipPath ||
    options.zip ||
    (typeof options.path === "string" && toolZip.looksLikeZipPath(options.path)
      ? options.path
      : typeof options.filePath === "string" && toolZip.looksLikeZipPath(options.filePath)
        ? options.filePath
        : typeof source === "string" && toolZip.looksLikeZipPath(source) && !String(source).trim().startsWith("{")
          ? source
          : null);

  if (zipPath) {
    const zipResult = await toolZip.importToolsFromZip(userDataPath, zipPath, {
      mode,
      names: options.names,
      name: options.name || options.tool,
      tool: options.tool,
    });
    return {
      ...zipResult,
      tools: await readCustomTools(userDataPath),
    };
  }

  const allEntries = extractImportEntries(source);
  const entries = filterImportEntries(allEntries, options);
  if (!entries.length) {
    return {
      ok: true,
      mode,
      imported: [],
      updated: [],
      skipped: [],
      renamed: [],
      errors: allEntries.length
        ? [{ index: -1, error: "No tools matched import filter (names/ids/indices)" }]
        : [],
      count: 0,
      totalInPack: allEntries.length,
      tools: await readCustomTools(userDataPath),
    };
  }

  const tools = await readCustomTools(userDataPath);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const existingNames = new Set(tools.map((t) => t.name));
  const usedInBatch = new Set();

  const imported = [];
  const updated = [];
  const skipped = [];
  const renamed = [];
  const errors = [];

  for (let i = 0; i < entries.length; i += 1) {
    const raw = entries[i];
    try {
      if (!raw || typeof raw !== "object") {
        errors.push({ index: i, error: "Entry is not an object" });
        continue;
      }
      let name = normalizeToolName(raw.name);
      if (!name) {
        errors.push({ index: i, error: "Tool name is required" });
        continue;
      }
      if (RESERVED_NAMES.has(name)) {
        if (mode === "rename") {
          const next = uniqueImportName(name, existingNames, usedInBatch);
          renamed.push({ from: name, to: next });
          name = next;
        } else {
          skipped.push({ name, reason: "reserved" });
          continue;
        }
      }

      const bodyIn = raw.body && typeof raw.body === "object" ? raw.body : {};
      const kind = String(bodyIn.kind || bodyIn.type || raw.kind || "").trim().toLowerCase();
      if (kind && kind !== "folder" && kind !== "code" && kind !== "dir" && kind !== "fs") {
        errors.push({
          index: i,
          name,
          error: "CTL (pipeline/script/call) tools are no longer supported — export as folder tool (code) instead",
        });
        continue;
      }

      const code =
        raw.code != null
          ? raw.code
          : raw.content != null
            ? raw.content
            : bodyIn.code != null
              ? bodyIn.code
              : typeof raw.source === "string" && !String(raw.source).trim().startsWith("{")
                ? raw.source
                : undefined;
      const files = Array.isArray(raw.files)
        ? raw.files
        : Array.isArray(bodyIn.files)
          ? bodyIn.files
          : [];
      const runtime = raw.runtime || raw.lang || raw.language || bodyIn.runtime || bodyIn.lang || bodyIn.language;
      const entry = raw.entry || bodyIn.entry || bodyIn.main;
      if (code == null && !files.length && !entry) {
        errors.push({
          index: i,
          name,
          error: "No code in entry — folder tool requires entry code (code= or files=[...])",
        });
        continue;
      }

      const title = String(raw.title || raw.label || name).trim() || name;
      const description = String(raw.description || "").trim();
      const inputSchema = normalizeInputSchema(raw.inputSchema || raw.schema);
      const enabled = raw.enabled === false ? false : true;
      const tags = Array.isArray(raw.tags)
        ? raw.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 20)
        : [];
      const dependencies = Array.isArray(raw.dependencies)
        ? raw.dependencies.map(normalizeToolName).filter(Boolean)
        : [];

      const existing = byName.get(name);
      if (existing) {
        if (mode === "skip") {
          skipped.push({ name, reason: "exists", id: existing.id });
          continue;
        }
        if (mode === "rename") {
          const next = uniqueImportName(name, existingNames, usedInBatch);
          renamed.push({ from: name, to: next });
          name = next;
        } else if (mode === "overwrite") {
          await folderTools.updateFolderManifest(userDataPath, existing.name, {
            name,
            title,
            description,
            code,
            runtime,
            entry,
            inputSchema,
            enabled,
            tags,
            dependencies,
            files,
          });
          const updatedTool = await folderTools.readFolderTool(userDataPath, name);
          if (updatedTool) byName.set(name, updatedTool);
          updated.push(toolSummary(updatedTool));
          usedInBatch.add(name);
          continue;
        }
      }

      const tool = await folderTools.ensureToolScaffold(userDataPath, {
        name,
        title,
        description,
        runtime: runtime || "node",
        entry,
        code,
        inputSchema,
        enabled,
        tags,
        dependencies,
        files,
      });
      if (files.length) {
        await folderTools.updateFolderManifest(userDataPath, name, { files });
      }
      byName.set(name, tool);
      existingNames.add(name);
      usedInBatch.add(name);
      imported.push(toolSummary(tool));
    } catch (err) {
      errors.push({
        index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    imported,
    updated,
    skipped,
    renamed,
    errors,
    count: imported.length + updated.length,
    totalInPack: allEntries.length,
    tools: await readCustomTools(userDataPath),
  };
}

module.exports = {
  RESERVED_NAMES,
  PACK_FORMAT,
  PACK_VERSION,
  FULL_INJECT_MAX,
  CATALOG_TOP_K,
  CATALOG_MIN_K,
  CUSTOM_TOOLS_DIR,
  getCustomToolsDir,
  readCustomTools,
  addCustomTool,
  updateCustomTool,
  removeCustomTool,
  findCustomTool,
  searchCustomTools,
  rankCustomTools,
  selectCustomToolsForInject,
  buildCustomToolCatalogSection,
  toolSummary,
  isToolEnabled,
  normalizeToolName,
  getEnabledCustomToolSchemas,
  schemaToToolSchema,
  executeCustomTool,
  executeCustomToolByName,
  executeCustomToolById,
  exportCustomTools,
  importCustomTools,
  previewCustomToolsImport,
  filterImportEntries,
  extractImportEntries,
  buildExportPack,
  toShareEntry,
  wantsFolderTool,
  folderTools,
  toolZip,
};
