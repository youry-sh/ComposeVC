/**
 * Files dragged from the OS (or picked with the paperclip) attach to the chat
 * they were dropped on. Images keep using the existing vision path; text-like
 * files are inlined into the user turn inside an <attached-file> block so every
 * provider/model sees them without any extra backend plumbing.
 *
 * The block is also what lets the UI show compact chips instead of raw XML:
 * message bubbles render `splitAttachedFiles(content).displayText` plus chips.
 */

export interface ChatFileAttachment {
  id: string;
  name: string;
  /** Original byte size (for the chip label). */
  size: number;
  mimeType?: string;
  /** Text that goes to the model. */
  text: string;
  /** True when the file was cut at the per-file / total cap. */
  truncated?: boolean;
}

export interface ParsedAttachedFile {
  name: string;
  size: number;
  mimeType?: string;
  truncated: boolean;
}

export const CHAT_FILE_MAX_FILES = 8;
export const CHAT_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** Per-file inline cap — roughly 20k tokens. */
export const CHAT_FILE_MAX_TEXT_CHARS = 80_000;
/** Whole turn cap for inlined file text. */
export const CHAT_FILE_MAX_TOTAL_CHARS = 200_000;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
]);

const TEXT_EXTENSIONS = new Set([
  // plain text / docs
  "txt",
  "text",
  "md",
  "markdown",
  "mdx",
  "rst",
  "log",
  "csv",
  "tsv",
  "diff",
  "patch",
  // structured data / config
  "json",
  "jsonc",
  "json5",
  "xml",
  "svg",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "env",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "npmrc",
  "babelrc",
  "prettierrc",
  "dockerignore",
  "htaccess",
  // markup / styles
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  // code
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "php",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "swift",
  "m",
  "mm",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "fs",
  "fsx",
  "vb",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "psm1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "vue",
  "svelte",
  "astro",
  "lua",
  "pl",
  "pm",
  "r",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "groovy",
  "gradle",
]);

const TEXT_FILENAMES = new Set([
  "dockerfile",
  "makefile",
  "gemfile",
  "procfile",
  "license",
  "licence",
  "notice",
  "readme",
  "changelog",
  "authors",
  "requirements",
  "cmakelists.txt",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".prettierrc",
  ".babelrc",
  ".dockerignore",
  ".htaccess",
]);

const TEXT_MIME_HINTS = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
  "application/graphql",
];

export function getFileExtension(name: string): string {
  const base = String(name || "").split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function baseFileName(name: string): string {
  return (String(name || "").split(/[\\/]/).pop() || "").toLowerCase();
}

export function isImageFile(file: { name?: string; type?: string }): boolean {
  const mime = String(file?.type || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXTENSIONS.has(getFileExtension(file?.name || ""));
}

/** Text-like files the composer accepts and inlines into the turn. */
export function isSupportedChatFile(file: { name?: string; type?: string }): boolean {
  const name = file?.name || "";
  const mime = String(file?.type || "").toLowerCase();
  if (isImageFile({ name, type: mime })) return false;
  const ext = getFileExtension(name);
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  if (TEXT_FILENAMES.has(baseFileName(name))) return true;
  return TEXT_MIME_HINTS.some((hint) => mime.startsWith(hint));
}

/** `accept` attribute for the hidden file input. */
export const CHAT_FILE_ACCEPT = [
  "image/*",
  ...Array.from(TEXT_EXTENSIONS)
    .filter((ext) => !["env", "gitignore", "gitattributes", "editorconfig", "npmrc", "babelrc", "prettierrc", "dockerignore", "htaccess"].includes(ext))
    .map((ext) => `.${ext}`),
  ".env",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".prettierrc",
].join(",");

export type ChatFileKind = "code" | "data" | "sheet" | "text" | "doc";

export function chatFileKind(name: string): ChatFileKind {
  const ext = getFileExtension(name);
  if (["json", "jsonc", "json5", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf"].includes(ext)) {
    return "data";
  }
  if (["csv", "tsv"].includes(ext)) return "sheet";
  if (
    [
      "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "php", "go", "rs", "java", "kt", "kts",
      "scala", "swift", "m", "mm", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "fsx",
      "vb", "sh", "bash", "zsh", "fish", "ps1", "psm1", "bat", "cmd", "sql", "graphql", "gql",
      "vue", "svelte", "astro", "lua", "pl", "pm", "r", "dart", "ex", "exs", "erl", "hs", "clj",
      "cljs", "groovy", "gradle", "html", "htm", "xhtml", "css", "scss", "sass", "less", "diff",
      "patch", "svg",
    ].includes(ext)
  ) {
    return "code";
  }
  if (["md", "markdown", "mdx", "rst", "txt", "text", "log"].includes(ext)) return "text";
  return "doc";
}

export function formatFileSize(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) {
    const kb = value / 1024;
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  }
  const mb = value / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function countReplacement(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) count += 1;
  }
  return count;
}

/**
 * Decode a dropped file. UTF-8 first (with BOM detection), then the Windows
 * ANSI fallback — Russian .txt files from Notepad are often cp1251.
 */
export function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const decode = (encoding: string): string => {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      return "";
    }
  };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return decode("utf-16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return decode("utf-16be");
  const utf8 = decode("utf-8");
  if (!utf8) return decode("windows-1251");
  const bad = countReplacement(utf8);
  if (bad === 0) return utf8;
  const cp1251 = decode("windows-1251");
  if (cp1251 && countReplacement(cp1251) < bad) return cp1251;
  return utf8;
}

function escapeAttr(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeAttr(value: string): string {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Serialize composer attachments into the block appended to the user turn. */
export function buildAttachedFilesBlock(files: ChatFileAttachment[]): string {
  if (!files?.length) return "";
  return files
    .map((file) => {
      const attrs = [
        `name="${escapeAttr(file.name)}"`,
        `bytes="${Number(file.size) || 0}"`,
        `type="${escapeAttr(file.mimeType || "text/plain")}"`,
      ];
      if (file.truncated) attrs.push('truncated="true"');
      const body = file.text.split("</attached-file>").join("<\\/attached-file>");
      return `<attached-file ${attrs.join(" ")}>\n${body}\n</attached-file>`;
    })
    .join("\n\n");
}

const ATTACHED_FILE_RE = /<attached-file\b([^>]*)>[\s\S]*?<\/attached-file>/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  raw.replace(/([a-zA-Z][\w-]*)="([^"]*)"/g, (_match, key: string, value: string) => {
    out[key.toLowerCase()] = unescapeAttr(value);
    return "";
  });
  return out;
}

export function splitAttachedFiles(content: string): {
  /** Content without attachment blocks — what the bubble shows. */
  displayText: string;
  files: ParsedAttachedFile[];
  /** Raw blocks, so a queued edit can put them back unchanged. */
  attachmentsBlock: string;
} {
  const source = content || "";
  // Fast path: most user turns have no attachments — leave them byte-identical.
  if (!source.includes("<attached-file")) {
    return { displayText: source, files: [], attachmentsBlock: "" };
  }
  const files: ParsedAttachedFile[] = [];
  const blocks: string[] = [];
  const displayText = source
    .replace(ATTACHED_FILE_RE, (match, rawAttrs: string) => {
      const attrs = parseAttrs(rawAttrs);
      files.push({
        name: attrs.name || "file",
        size: Number(attrs.bytes) || 0,
        mimeType: attrs.type || undefined,
        truncated: attrs.truncated === "true",
      });
      blocks.push(match);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { displayText, files, attachmentsBlock: blocks.join("\n\n") };
}
