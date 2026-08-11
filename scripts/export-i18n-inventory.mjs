import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "src", "i18n.ts"), "utf8");

function extract(lang) {
  const idx = src.indexOf(`${lang}: {`);
  if (idx < 0) return "";
  let i = src.indexOf("{", idx);
  let depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return "";
}

function parse(body) {
  const out = {};
  const re = /([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*((?:"(?:\\.|[^"])*"))/g;
  let m;
  while ((m = re.exec(body))) {
    try {
      out[m[1]] = JSON.parse(m[2]);
    } catch {
      /* skip */
    }
  }
  return out;
}

const en = parse(extract("en"));
const ru = parse(extract("ru"));
const uk = parse(extract("uk"));
const keys = Object.keys(en);
const rows = keys.map((k) => ({
  key: k,
  en: en[k] || "",
  ru: ru[k] || "",
  uk: uk[k] || "",
  status: "in_i18n",
}));

const hardcoded = [
  { file: "ActivityBar.tsx", en: "MultiIDE — 4 parallel chat workspaces", status: "hardcoded" },
  { file: "ActivityBar.tsx", en: "Proxy", status: "hardcoded" },
  { file: "TitleBar.tsx", en: "ComposeVC · 4 parallel workspaces", status: "hardcoded" },
  { file: "StatusBar.tsx", en: "MultiIDE", status: "hardcoded" },
  { file: "App.tsx", en: "No folder", status: "hardcoded" },
  { file: "SettingsModal.tsx", en: "AI runtime / I-config / Captcha / Shortcuts", status: "hardcoded" },
  { file: "MultiChatSlot.tsx", en: "Select workspace folder / Select folder… / AI request failed", status: "hardcoded" },
  { file: "ChatPanel.tsx", en: "ещё / свернуть / юнитов", status: "hardcoded_ru" },

  { file: "ProxyWorkspace.tsx", en: "entire panel EN ~3459 LOC", status: "hardcoded" },
  { file: "AntiProfilesPanel.tsx", en: "entire panel EN", status: "hardcoded" },
  { file: "ContextRing.tsx", en: "tooltips / just now / compile", status: "hardcoded" },
];

const inventory = {
  generatedAt: new Date().toISOString(),
  existingKeyCount: keys.length,
  existing: rows,
  hardcodedCandidates: hardcoded,
  notes: [
    "App.tsx hardcodes appLanguage=en until state+localStorage",
    "Settings has languages keys but no UI",
    "Do not translate tool ids, brands, model names, paths",
    "UK orthography: Latin i lookalikes in instructions",
  ],
};

fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "i18n-string-inventory.json"), JSON.stringify(inventory, null, 2), "utf8");

let md = `# i18n string inventory\n\nGenerated: ${inventory.generatedAt}\n\n`;
md += `## Existing keys (${keys.length}) — en / ru / uk\n\n| key | en | ru | uk |\n|---|---|---|---|\n`;
for (const r of rows) {
  const esc = (s) => String(s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  md += `| ${r.key} | ${esc(r.en)} | ${esc(r.ru)} | ${esc(r.uk)} |\n`;
}
md += `\n## Hardcoded candidates\n\n`;
for (const h of hardcoded) md += `- \`${h.file}\`: ${h.en} (${h.status})\n`;
fs.writeFileSync(path.join(root, "docs", "i18n-string-inventory.md"), md, "utf8");
console.log("ok", keys.length, "keys");
