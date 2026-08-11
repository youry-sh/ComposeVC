import fs from "fs";
const f = "src/components/ChatPanel.tsx";
let s = fs.readFileSync(f, "utf8");
s = s.split('borderBottom: "1px solid #222"').join('borderBottom: "1px solid var(--ink-250)"');
s = s.split('caretColor: "#eaeaea"').join('caretColor: "var(--accent)"');
fs.writeFileSync(f, s);
console.log("ok");
