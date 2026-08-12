const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function target(userDataPath) { return path.join(userDataPath, "storage", "history.json"); }
function read(userDataPath) {
  try { const data = JSON.parse(fs.readFileSync(target(userDataPath), "utf8")); return Array.isArray(data?.items) ? data.items : []; }
  catch { return []; }
}
async function write(userDataPath, items) {
  const file = target(userDataPath); await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`; await fs.promises.writeFile(tmp, JSON.stringify({ v: 1, items: items.slice(0, 500) }, null, 2), "utf8"); await fs.promises.rename(tmp, file);
}
async function add(userDataPath, input) {
  const items = read(userDataPath); const item = { id: `st-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`, ...input, createdAt: Date.now(), updatedAt: Date.now() };
  items.unshift(item); await write(userDataPath, items); return item;
}
async function update(userDataPath, id, patch) {
  const items = read(userDataPath); const index = items.findIndex((item) => item.id === id); if (index < 0) return null;
  items[index] = { ...items[index], ...patch, updatedAt: Date.now() }; await write(userDataPath, items); return items[index];
}
async function remove(userDataPath, id) { const items = read(userDataPath); const next = items.filter((item) => item.id !== id); await write(userDataPath, next); return next.length !== items.length; }
module.exports = { read, add, update, remove };
