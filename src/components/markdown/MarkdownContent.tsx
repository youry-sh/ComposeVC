import React, { useMemo, useCallback, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  EMPTY_INCREMENTAL_MARKDOWN,
  updateIncrementalMarkdown,
  type IncrementalMarkdownState,
  type MdAlign,
  type MdBlock,
} from "./parseMarkdown";

function openExternalLink(url: string) {
  void window.lopster?.openExternal?.(url);
}

function renderInline(
  text: string,
  keyPrefix: string,
  onOpenNote?: (title: string) => void
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const regex =
    /(\[\[[^\[\]\n]+\]\]|~~[^~\n]+~~|!\[[^\]]*\]\([^)\s]+\)|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()[\]]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("[[")) {
      const inner = token.slice(2, -2);
      const [title, alias] = inner.split("|");
      const label = (alias || title || "").trim();
      const target = (title || "").trim();
      nodes.push(
        <span
          key={`${keyPrefix}-w${i}`}
          role="link"
          tabIndex={0}
          title={onOpenNote ? `Open note: ${target}` : target}
          className="md-wikilink"
          onClick={(e) => {
            e.stopPropagation();
            onOpenNote?.(target);
          }}
          onKeyDown={(e) => e.key === "Enter" && onOpenNote?.(target)}
        >
          {label || target}
        </span>
      );
    } else if (token.startsWith("~~")) {
      nodes.push(
        <del key={`${keyPrefix}-d${i}`} className="md-del">
          {token.slice(2, -2)}
        </del>
      );
    } else if (token.startsWith("![")) {
      const imgMatch = token.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
      if (imgMatch) {
        const src = imgMatch[2];
        nodes.push(
          <img
            key={`${keyPrefix}-img${i}`}
            className="md-img"
            src={src}
            alt={imgMatch[1] || ""}
            loading="lazy"
            onClick={() => /^https?:\/\//.test(src) && openExternalLink(src)}
            draggable={false}
          />
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={`${keyPrefix}-s${i}`} className="md-strong">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        nodes.push(
          <span
            key={`${keyPrefix}-l${i}`}
            role="link"
            tabIndex={0}
            onClick={() => openExternalLink(linkMatch[2])}
            onKeyDown={(e) => e.key === "Enter" && openExternalLink(linkMatch[2])}
            className="md-link"
          >
            {linkMatch[1]}
          </span>
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("http")) {
      nodes.push(
        <span
          key={`${keyPrefix}-u${i}`}
          role="link"
          tabIndex={0}
          onClick={() => openExternalLink(token)}
          onKeyDown={(e) => e.key === "Enter" && openExternalLink(token)}
          className="md-link"
        >
          {token}
        </span>
      );
    } else {
      nodes.push(
        <em key={`${keyPrefix}-e${i}`} className="md-em">
          {token.slice(1, -1)}
        </em>
      );
    }
    i += 1;
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const CodeBlock: React.FC<{ lang: string; code: string }> = React.memo(({ lang, code }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      /* ignore */
    }
  }, [code]);

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || "code"}</span>
        <button type="button" className="md-code-copy" onClick={onCopy} title="Copy">
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="md-pre scrollbar-thin">
        <code>{code}</code>
      </pre>
    </div>
  );
});

CodeBlock.displayName = "CodeBlock";

function alignClass(a: MdAlign): string {
  if (a === "center") return "md-align-center";
  if (a === "right") return "md-align-right";
  return "md-align-left";
}

const TableBlock: React.FC<{
  headers: string[];
  aligns: MdAlign[];
  rows: string[][];
  k: string;
  onOpenNote?: (title: string) => void;
}> = React.memo(({ headers, aligns, rows, k, onOpenNote }) => (
  <div className="md-table-wrap scrollbar-thin">
    <table className="md-table">
      <thead>
        <tr>
          {headers.map((h, hi) => (
            <th key={`${k}-h${hi}`} className={alignClass(aligns[hi] || "left")}>
              {renderInline(h, `${k}-h${hi}`, onOpenNote)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={`${k}-r${ri}`}>
            {row.map((cell, ci) => (
              <td key={`${k}-r${ri}c${ci}`} className={alignClass(aligns[ci] || "left")}>
                {renderInline(cell, `${k}-r${ri}c${ci}`, onOpenNote)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
));

TableBlock.displayName = "TableBlock";

function renderBlock(block: MdBlock, index: number, onOpenNote?: (title: string) => void): React.ReactNode {
  const key = `b${index}`;
  switch (block.type) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} code={block.code} />;
    case "heading": {
      const cls =
        block.level === 1
          ? "md-h1"
          : block.level === 2
            ? "md-h2"
            : block.level === 3
              ? "md-h3"
              : block.level === 4
                ? "md-h4"
                : block.level === 5
                  ? "md-h5"
                  : "md-h6";
      return (
        <div key={key} className={cls}>
          {renderInline(block.text, key, onOpenNote)}
        </div>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {block.text.split("\n").map((line, li, arr) => (
            <React.Fragment key={`${key}-p${li}`}>
              {renderInline(line, `${key}-p${li}`, onOpenNote)}
              {li < arr.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </p>
      );
    case "quote":
      return (
        <div key={key} className="md-quote">
          {block.text.split("\n").map((line, li, arr) => (
            <React.Fragment key={`${key}-q${li}`}>
              {renderInline(line, `${key}-q${li}`, onOpenNote)}
              {li < arr.length - 1 ? <br /> : null}
            </React.Fragment>
          ))}
        </div>
      );
    case "hr":
      return <hr key={key} className="md-hr" />;
    case "tasklist":
      return (
        <div key={key} className="md-list md-tasklist">
          {block.items.map((item, ii) => (
            <div
              key={`${key}-task${ii}`}
              className="md-task-row"
              style={{ paddingLeft: 2 + item.level * 14 }}
            >
              <span className={`md-task-box ${item.done ? "is-done" : ""}`} aria-hidden>
                {item.done ? "✓" : ""}
              </span>
              <span className={`md-task-body ${item.done ? "is-done" : ""}`}>
                {renderInline(item.text, `${key}-task${ii}`, onOpenNote)}
              </span>
            </div>
          ))}
        </div>
      );
    case "ul":
      return (
        <div key={key} className="md-list md-ul">
          {block.items.map((item, ii) => (
            <div
              key={`${key}-li${ii}`}
              className="md-li-row"
              style={{ paddingLeft: 2 + item.level * 14 }}
            >
              <span className="md-bullet" />
              <span className="md-li-body">{renderInline(item.text, `${key}-li${ii}`, onOpenNote)}</span>
            </div>
          ))}
        </div>
      );
    case "ol":
      return (
        <div key={key} className="md-list md-ol">
          {block.items.map((item, ii) => (
            <div
              key={`${key}-ol${ii}`}
              className="md-num-row"
              style={{ paddingLeft: 2 + item.level * 14 }}
            >
              <span className="md-num">{item.n}.</span>
              <span className="md-num-body">{renderInline(item.text, `${key}-ol${ii}`, onOpenNote)}</span>
            </div>
          ))}
        </div>
      );
    case "table":
      return (
        <TableBlock
          key={key}
          k={key}
          headers={block.headers}
          aligns={block.aligns}
          rows={block.rows}
          onOpenNote={onOpenNote}
        />
      );
    default:
      return null;
  }
}

const MarkdownBlockView: React.FC<{
  block: MdBlock;
  index: number;
  onOpenNote?: (title: string) => void;
}> = React.memo(({ block, index, onOpenNote }) => renderBlock(block, index, onOpenNote));

MarkdownBlockView.displayName = "MarkdownBlockView";

const MarkdownContent: React.FC<{ content: string; onOpenNote?: (title: string) => void }> = React.memo(
  ({ content, onOpenNote }) => {
    const parseStateRef = useRef<IncrementalMarkdownState>(EMPTY_INCREMENTAL_MARKDOWN);
    const blocks = useMemo(() => {
      const next = updateIncrementalMarkdown(parseStateRef.current, content || "");
      parseStateRef.current = next;
      return next.blocks;
    }, [content]);

    if (!content) return null;

    return (
      <div className="md-ai min-w-0">
        {blocks.map((block, index) => (
          <MarkdownBlockView
            key={`b${index}`}
            block={block}
            index={index}
            onOpenNote={onOpenNote}
          />
        ))}
      </div>
    );
  }
);

MarkdownContent.displayName = "MarkdownContent";

export default MarkdownContent;
