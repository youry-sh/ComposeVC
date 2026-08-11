import fs from "fs";
import path from "path";
import https from "https";

const dir = path.join("web-ide", "public", "roman");
fs.mkdirSync(dir, { recursive: true });

const files = {
  "bust.jpg":
    "https://images.unsplash.com/photo-1599420186946-7b6fb4e297f0?auto=format&fit=crop&w=900&q=80",
  "column.jpg":
    "https://images.unsplash.com/photo-1554907984-15263bfd63bd?auto=format&fit=crop&w=900&q=80",
  "statue.jpg":
    "https://images.unsplash.com/photo-1564399580075-5dfe19c205f3?auto=format&fit=crop&w=900&q=80",
  "arch.jpg":
    "https://images.unsplash.com/photo-1577083552431-6e5fd01988ec?auto=format&fit=crop&w=900&q=80",
};

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "ComposeVC/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

for (const [name, url] of Object.entries(files)) {
  try {
    const buf = await get(url);
    fs.writeFileSync(path.join(dir, name), buf);
    console.log("ok", name, buf.length);
  } catch (e) {
    console.error("fail", name, e.message);
  }
}
