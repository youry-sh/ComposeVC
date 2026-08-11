import fs from "fs";
import path from "path";

const dir = "src/components";
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
  let s = fs.readFileSync(path.join(dir, f), "utf8");
  const b = s;
  s = s.replaceAll("theme-input border/40", "theme-panel");
  s = s.replaceAll("theme-input border/20", "theme-panel");
  s = s.replaceAll("rounded-xl theme-input border", "rounded-xl theme-panel");
  s = s.replaceAll("rounded-lg theme-input border", "rounded-lg theme-panel");
  s = s.replaceAll("theme-input border overflow", "theme-panel overflow");
  s = s.replaceAll(
    "theme-input border px-3 py-2 text-[12px] text-ink-800",
    "theme-panel px-3 py-2 text-[12px] text-ink-800"
  );
  s = s.replaceAll("theme-input border px-1.5", "theme-panel px-1.5");
  s = s.replaceAll("theme-input border py-1 shadow-menu", "theme-panel py-1 shadow-menu");
  s = s.replaceAll(
    "theme-input border px-3 py-2.5 shadow-menu",
    "theme-panel px-3 py-2.5 shadow-menu"
  );
  s = s.replaceAll(
    "theme-input border px-3 py-2.5 transition",
    "theme-panel px-3 py-2.5 transition"
  );
  s = s.replaceAll("theme-input border px-2 text-left", "theme-input px-2 text-left");
  s = s.replaceAll("theme-input border pl-8", "theme-input pl-8");
  s = s.replaceAll("theme-input border px-2.5", "theme-input px-2.5");
  s = s.replace(/theme-primary([^"']*)hover:bg-white/g, "theme-primary$1");
  s = s.replace(/theme-primary([^"']*)hover:bg-ink-800/g, "theme-primary$1");
  s = s.replace(/theme-primary([^"']*)active:bg-ink-800/g, "theme-primary$1");
  if (s !== b) {
    fs.writeFileSync(path.join(dir, f), s);
    console.log("fixed", f);
  }
}
