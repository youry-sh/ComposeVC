import fs from "fs";
import path from "path";

const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === "profiles" || e.name === ".git") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|cjs|js|html|md)$/.test(e.name)) files.push(p);
  }
}
walk("src");
walk("electron");
if (fs.existsSync("index.html")) files.push("index.html");

// Longer first so Kitsune-sh-M wins before Kitsune-sh
const pairs = [
  ["Kitsune-sh-M", "ComposeVC-M"],
  ["Kitsune-sh", "ComposeVC"],
  ["Kitsune", "ComposeVC"],
  ["Lopster-HO", "ComposeVC-M"],
  ["Lopster-M", "ComposeVC-M"],
  ["Lopster Runtime", "ComposeVC Runtime"],
  ["Lopster IDE", "ComposeVC"],
  ["Lopster Copy", "ComposeVC Copy"],
  ["Lopster proxy", "ComposeVC proxy"],
  ["Lopster Proxy", "ComposeVC Proxy"],
  ["Lopster Git", "ComposeVC Git"],
  ["Lopster agents", "ComposeVC agents"],
  ["Lopster edges", "ComposeVC edges"],
  ["Lopster provider", "ComposeVC provider"],
  ["Lopster-biased", "ComposeVC-biased"],
  ["from Lopster", "from ComposeVC"],
  ["in Lopster", "in ComposeVC"],
  ["to Lopster", "to ComposeVC"],
  ["Lopster will", "ComposeVC will"],
  ["Lopster;", "ComposeVC;"],
  ["Lopster.", "ComposeVC."],
  ["Lopster ", "ComposeVC "],
  [" Lopster", " ComposeVC"],
  ["/ Lopster", "/ ComposeVC"],
  ["Lopster/", "ComposeVC/"],
  ["Lopster-", "ComposeVC-"],
];

let changed = 0;
for (const f of files) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;
  for (const [a, b] of pairs) s = s.split(a).join(b);
  if (s !== before) {
    fs.writeFileSync(f, s);
    changed++;
    console.log(f);
  }
}
console.log("files:", changed);
