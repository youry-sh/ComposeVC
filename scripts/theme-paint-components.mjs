/**
 * Mass-wire common control class patterns to theme-* helpers
 * so primary / secondary buttons & inputs pick up theme colors.
 */
import fs from "fs";
import path from "path";

const dir = "src/components";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tsx"));

const replacements = [
  // Primary solid buttons (various class orders)
  [/bg-ink-950 text-ink-0/g, "theme-primary"],
  [/bg-ink-950 text-black/g, "theme-primary"],
  [/text-ink-0 bg-ink-950/g, "theme-primary"],
  [/text-black bg-ink-950/g, "theme-primary"],
  [/bg-ink-950 text-\[11px\] font-medium text-black/g, "theme-primary text-[11px] font-medium"],
  // Common secondary chrome
  [
    /border border-ink-200 bg-ink-100 text-ink-900 hover:bg-ink-150 hover:text-ink-950/g,
    "theme-secondary",
  ],
  [
    /border border-ink-200 bg-ink-100 text-ink-900/g,
    "theme-secondary",
  ],
  [
    /border border-ink-300 bg-ink-100 text-ink-800/g,
    "theme-secondary",
  ],
  [
    /border border-ink-200 bg-ink-50 px-2\.5 py-1\.5 text-\[11px\] font-medium text-ink-800/g,
    "theme-secondary px-2.5 py-1.5 text-[11px] font-medium",
  ],
  // Inputs
  [
    /border border-ink-200 bg-ink-50 ([^"']*?)text-ink-950 placeholder-ink-500/g,
    "theme-input $1placeholder:text-ink-500",
  ],
  [
    /border border-ink-200 bg-ink-50 ([^"']*?)text-ink-950 placeholder:text-ink-500/g,
    "theme-input $1placeholder:text-ink-500",
  ],
  [
    /border border-ink-200 bg-ink-50 ([^"']*?)text-ink-950 placeholder-ink-500/g,
    "theme-input $1placeholder:text-ink-500",
  ],
];

let total = 0;
for (const file of files) {
  const full = path.join(dir, file);
  let s = fs.readFileSync(full, "utf8");
  const before = s;
  for (const [re, to] of replacements) {
    s = s.replace(re, to);
  }
  // Clean leftover hover:bg-ink-900 after primary conversion
  s = s.replace(/theme-primary(\s+)hover:bg-ink-900/g, "theme-primary$1");
  s = s.replace(/theme-primary(\s+)hover:bg-white/g, "theme-primary$1");
  s = s.replace(/theme-primary(\s+)active:bg-ink-800/g, "theme-primary$1");
  s = s.replace(/theme-primary(\s+)hover:bg-ink-800/g, "theme-primary$1");
  if (s !== before) {
    fs.writeFileSync(full, s);
    total++;
    console.log("updated", file);
  }
}
console.log("files changed:", total);
