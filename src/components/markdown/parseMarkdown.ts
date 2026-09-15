export type MdAlign = "left" | "center" | "right";

export type MdBlock =
  | { type: "code"; lang: string; code: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "ul"; items: { level: number; text: string }[] }
  | { type: "ol"; items: { level: number; n: number; text: string }[] }
  | { type: "tasklist"; items: { level: number; done: boolean; text: string }[] }
  | { type: "table"; headers: string[]; aligns: MdAlign[]; rows: string[][] };

const FENCE_RE = /```([\w+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|.+\|\s*$|^\s*[^|\n]+\|[^|\n]+/;

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function parseAligns(sepLine: string, colCount: number): MdAlign[] {
  const cells = splitTableRow(sepLine);
  const out: MdAlign[] = [];
  for (let i = 0; i < colCount; i++) {
    const cell = (cells[i] || "").replace(/\s+/g, "");
    if (cell.startsWith(":") && cell.endsWith(":")) {
      out.push("center");
    } else if (cell.endsWith(":") && !cell.startsWith(":")) {
      out.push("right");
    } else {
      out.push("left");
    }
  }
  return out;
}

function isTableHeaderPair(header: string, sep: string): boolean {
  if (!header || !sep) return false;
  if (!TABLE_SEP_RE.test(sep)) return false;
  if (!header.includes("|") && !sep.includes("|")) return false;
  const h = splitTableRow(header);
  const s = splitTableRow(sep);
  return h.length > 0 && s.length > 0 && Math.abs(h.length - s.length) <= 1;
}

function padRow(cells: string[], n: number): string[] {
  if (cells.length === n) return cells;
  if (cells.length > n) return cells.slice(0, n);
  return [...cells, ...Array(n - cells.length).fill("")];
}

function pushParagraph(blocks: MdBlock[], buf: string[]) {
  if (!buf.length) return;
  const text = buf.join("\n").trim();
  buf.length = 0;
  if (text) blocks.push({ type: "paragraph", text });
}

function flushList(
  blocks: MdBlock[],
  kind: "ul" | "ol" | "tasklist" | null,
  items: { level: number; n?: number; done?: boolean; text: string }[]
): null {
  if (!kind || !items.length) {
    items.length = 0;
    return null;
  }
  if (kind === "ul") {
    blocks.push({
      type: "ul",
      items: items.map((it) => ({ level: it.level, text: it.text })),
    });
  } else if (kind === "ol") {
    blocks.push({
      type: "ol",
      items: items.map((it) => ({
        level: it.level,
        n: it.n || 1,
        text: it.text,
      })),
    });
  } else {
    blocks.push({
      type: "tasklist",
      items: items.map((it) => ({ level: it.level, done: Boolean(it.done), text: it.text })),
    });
  }
  items.length = 0;
  return null;
}

function parseTextBlocks(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  const para: string[] = [];
  const listItems: { level: number; n?: number; done?: boolean; text: string }[] = [];
  let listKind: "ul" | "ol" | "tasklist" | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      listKind = flushList(blocks, listKind, listItems);
      pushParagraph(blocks, para);
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      listKind = flushList(blocks, listKind, listItems);
      pushParagraph(blocks, para);
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      listKind = flushList(blocks, listKind, listItems);
      pushParagraph(blocks, para);
      blocks.push({
        type: "heading",
        level: Math.min(heading[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        text: heading[2].trim(),
      });
      i += 1;
      continue;
    }

    if (i + 1 < lines.length && isTableHeaderPair(line, lines[i + 1])) {
      listKind = flushList(blocks, listKind, listItems);
      pushParagraph(blocks, para);
      const headers = splitTableRow(line);
      const aligns = parseAligns(lines[i + 1], headers.length);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i];
        if (!rowLine.trim()) break;
        if (!TABLE_ROW_RE.test(rowLine) && !rowLine.includes("|")) break;
        if (TABLE_SEP_RE.test(rowLine) && !/[A-Za-zА-Яа-я0-9]/.test(rowLine)) {
          i += 1;
          continue;
        }
        rows.push(padRow(splitTableRow(rowLine), headers.length));
        i += 1;
      }
      blocks.push({ type: "table", headers, aligns, rows });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      listKind = flushList(blocks, listKind, listItems);
      pushParagraph(blocks, para);
      const qLines = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const m = lines[i].match(/^>\s?(.*)$/);
        if (!m) break;
        qLines.push(m[1]);
        i += 1;
      }
      blocks.push({ type: "quote", text: qLines.join("\n").trim() });
      continue;
    }

    const task = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.+)$/);
    if (task) {
      pushParagraph(blocks, para);
      if (listKind && listKind !== "tasklist") {
        flushList(blocks, listKind, listItems);
      }
      listKind = "tasklist";
      listItems.push({
        level: Math.min(Math.floor(task[1].replace(/\t/g, "  ").length / 2), 4),
        done: task[2].toLowerCase() === "x",
        text: task[3],
      });
      i += 1;
      continue;
    }

    const ul = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (ul) {
      pushParagraph(blocks, para);
      if (listKind && listKind !== "ul") {
        flushList(blocks, listKind, listItems);
      }
      listKind = "ul";
      listItems.push({
        level: Math.min(Math.floor(ul[1].replace(/\t/g, "  ").length / 2), 4),
        text: ul[3],
      });
      i += 1;
      continue;
    }

    const ol = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ol) {
      pushParagraph(blocks, para);
      if (listKind && listKind !== "ol") {
        flushList(blocks, listKind, listItems);
      }
      listKind = "ol";
      listItems.push({
        level: Math.min(Math.floor(ol[1].replace(/\t/g, "  ").length / 2), 4),
        n: Number(ol[2]) || 1,
        text: ol[3],
      });
      i += 1;
      continue;
    }

    listKind = flushList(blocks, listKind, listItems);
    para.push(line);
    i += 1;
  }

  flushList(blocks, listKind, listItems);
  pushParagraph(blocks, para);
  return blocks;
}

export function parseMarkdown(content: string): MdBlock[] {
  if (!content) return [];
  const parts: MdBlock[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(content)) !== null) {
    if (m.index > last) {
      parts.push(...parseTextBlocks(content.slice(last, m.index)));
    }
    parts.push({
      type: "code",
      lang: (m[1] || "").trim(),
      code: m[2].replace(/\n$/, ""),
    });
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    parts.push(...parseTextBlocks(content.slice(last)));
  }
  return parts;
}

export type IncrementalMarkdownState = {
  content: string;
  /** Prefix ending at a blank line outside a code fence. */
  stableEnd: number;
  /** Parsed once and retained by reference across future stream updates. */
  stableBlocks: MdBlock[];
  blocks: MdBlock[];
};

export const EMPTY_INCREMENTAL_MARKDOWN: IncrementalMarkdownState = Object.freeze({
  content: "",
  stableEnd: 0,
  stableBlocks: [],
  blocks: [],
});

/**
 * Find the newest block boundary that cannot be changed by appending more text.
 * Blank lines outside fenced code terminate every block shape supported by this
 * parser (paragraph, list, quote, table, heading). Scanning starts at the prior
 * stable boundary, so old response text is never revisited.
 */
function findStableMarkdownEnd(content: string, start: number): number {
  let cursor = Math.max(0, Math.min(start, content.length));
  let stableEnd = cursor;
  let insideFence = false;

  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    if (newline === -1) break;
    let line = content.slice(cursor, newline);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) insideFence = !insideFence;
    if (!insideFence && trimmed.length === 0) stableEnd = newline + 1;
    cursor = newline + 1;
  }

  return stableEnd;
}

/** Render an unfinished fenced block as code instead of reparsing it as prose. */
function parseStreamingTail(content: string): MdBlock[] {
  if (!content) return [];
  const fence = /^```([\w+-]*)[^\r\n]*\r?\n?/gm;
  let match: RegExpExecArray | null;
  let open: { index: number; bodyStart: number; lang: string } | null = null;
  while ((match = fence.exec(content)) !== null) {
    if (open) open = null;
    else open = { index: match.index, bodyStart: fence.lastIndex, lang: match[1] || "" };
  }
  if (!open) return parseMarkdown(content);

  const before = content.slice(0, open.index);
  const blocks = before ? parseMarkdown(before) : [];
  blocks.push({
    type: "code",
    lang: open.lang,
    code: content.slice(open.bodyStart),
  });
  return blocks;
}

/**
 * Append-aware Markdown conversion for live SSE text. Only the mutable tail is
 * parsed again; completed blocks and their object identities are retained.
 */
export function updateIncrementalMarkdown(
  previous: IncrementalMarkdownState | null | undefined,
  nextContent: string
): IncrementalMarkdownState {
  const content = nextContent || "";
  const prior = previous || EMPTY_INCREMENTAL_MARKDOWN;
  if (content === prior.content) return prior;

  const isAppend = content.startsWith(prior.content);
  const baseEnd = isAppend ? prior.stableEnd : 0;
  let stableBlocks = isAppend ? prior.stableBlocks : [];
  const stableEnd = findStableMarkdownEnd(content, baseEnd);

  if (stableEnd > baseEnd) {
    const promoted = parseMarkdown(content.slice(baseEnd, stableEnd));
    stableBlocks = stableBlocks.length ? [...stableBlocks, ...promoted] : promoted;
  }

  const tailBlocks = parseStreamingTail(content.slice(stableEnd));
  return {
    content,
    stableEnd,
    stableBlocks,
    blocks: tailBlocks.length ? [...stableBlocks, ...tailBlocks] : stableBlocks,
  };
}
