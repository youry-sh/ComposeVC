import fs from "fs";
import path from "path";

const files = [];
function walk(d) {
  if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", "dist", "profiles", ".git"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|cjs|js|html|md)$/i.test(e.name)) files.push(p);
  }
}
walk("src");
walk("electron");
if (fs.existsSync("index.html")) files.push("index.html");

let n = 0;
for (const f of files) {
  let s = fs.readFileSync(f, "utf8");
  const before = s;
  s = s.split("ComposeIDE-M").join("ComposeVC-M");
  s = s.split("ComposeIDE").join("ComposeVC");
  if (s !== before) {
    fs.writeFileSync(f, s);
    n++;
    console.log(f);
  }
}
console.log("files:", n);
