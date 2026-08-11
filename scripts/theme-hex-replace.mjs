import fs from "fs";

const path = "src/index.css";
let css = fs.readFileSync(path, "utf8");

const startInk = css.indexOf(':root,\n  [data-theme="ink"]');
const startInkAlt = css.indexOf(':root,\r\n  [data-theme="ink"]');
const start = startInk >= 0 ? startInk : startInkAlt;
// Protect remaining theme token blocks (ink + signal-black); do not rewrite hex inside them.
const signalMark = css.indexOf('[data-theme="signal-black"]');
if (start < 0 || signalMark < 0) {
  console.error("markers", { start, signalMark, hasCRLF: css.includes("\r\n") });
  process.exit(1);
}

// End of protected range = closing brace of the last theme block (signal-black).
let depth = 0;
let end = -1;
let started = false;
for (let i = signalMark; i < css.length; i++) {
  const ch = css[i];
  if (ch === "{") {
    depth++;
    started = true;
  } else if (ch === "}") {
    depth--;
    if (started && depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) {
  console.error("could not find end of signal-black block");
  process.exit(1);
}

const protectedBlock = css.slice(start, end);
const head = css.slice(0, start);
const tail = css.slice(end);

const pairs = [
  ["#eaeaea", "var(--ink-950)"],
  ["#d6d6d6", "var(--ink-900)"],
  ["#d0d0d0", "var(--ink-900)"],
  ["#cccccc", "var(--ink-900)"],
  ["#c4a0a0", "var(--danger)"],
  ["#c88888", "var(--code-link)"],
  ["#d8a0a0", "var(--code-link-hover)"],
  ["#b8b8b8", "var(--ink-800)"],
  ["#b0b0b0", "var(--ink-800)"],
  ["#a8a8a8", "var(--ink-800)"],
  ["#aaaaaa", "var(--ink-800)"],
  ["#a89868", "var(--warn)"],
  ["#8a9a8a", "var(--ok)"],
  ["#888888", "var(--ink-700)"],
  ["#666666", "var(--ink-600)"],
  ["#444444", "var(--ink-500)"],
  ["#3a3a3a", "var(--ink-300)"],
  ["#333333", "var(--ink-400)"],
  ["#2a3a2a", "var(--ok-border)"],
  ["#2a2a1a", "var(--warn-border)"],
  ["#2a2a2a", "var(--ink-300)"],
  ["#2a1818", "var(--danger-border)"],
  ["#262626", "var(--ink-250)"],
  ["#242424", "var(--ink-250)"],
  ["#222222", "var(--ink-250)"],
  ["#1a1a1a", "var(--ink-200)"],
  ["#161616", "var(--ink-150)"],
  ["#14140c", "var(--warn-bg)"],
  ["#141414", "var(--ink-150)"],
  ["#121812", "var(--ok-bg)"],
  ["#120c0c", "var(--danger-bg)"],
  ["#111111", "var(--ink-100)"],
  ["#0e0e0e", "var(--ink-50)"],
  ["#0c0c0c", "var(--ink-50)"],
  ["#0a0a0a", "var(--ink-50)"],
  ["#000000", "var(--ink-0)"],
  ["#557dff", "var(--thinking-dot)"],
  ["#9a9a9a", "var(--ink-700)"],
  ["#8a8a8a", "var(--ink-700)"],
  ["#eee", "var(--ink-950)"],
  ["#ddd", "var(--ink-900)"],
  ["#ccc", "var(--ink-900)"],
  ["#aaa", "var(--ink-800)"],
  ["#999", "var(--text-soft)"],
  ["#888", "var(--ink-700)"],
  ["#777", "var(--ink-600)"],
  ["#666", "var(--ink-600)"],
  ["#555", "var(--ink-500)"],
  ["#444", "var(--ink-500)"],
  ["#333", "var(--ink-400)"],
  ["#222", "var(--ink-250)"],
  ["#111", "var(--ink-100)"],
  ["#000", "var(--ink-0)"],
];

let body = head + "/*__THEME__*/" + tail;
for (const [hex, rep] of pairs) {
  body = body.replace(new RegExp(hex, "gi"), rep);
}
body = body.replace("/*__THEME__*/", protectedBlock);

fs.writeFileSync(path, body);

const left = (head + tail).match(/#[0-9a-fA-F]{3,8}/g) || [];
// recount after on full without protected - approximate remaining in body only
const after = body.slice(0, start) + body.slice(body.indexOf(protectedBlock) + protectedBlock.length);
const rem = after.match(/#[0-9a-fA-F]{3,8}/g) || [];
const counts = {};
for (const h of rem) {
  const k = h.toLowerCase();
  counts[k] = (counts[k] || 0) + 1;
}
console.log("ok, remaining hex in non-token CSS:", Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25));
