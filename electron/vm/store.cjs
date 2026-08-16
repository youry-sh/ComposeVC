const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { layout, readJson, writeJson, ensureDir } = require("./paths.cjs");

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

function newId() {
  return `vm-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function readAll(userDataPath) {
  const data = readJson(layout.registry(userDataPath), null);
  const list = Array.isArray(data?.machines) ? data.machines : [];
  return list.filter((vm) => vm && vm.id);
}

function writeAll(userDataPath, machines) {
  writeJson(layout.registry(userDataPath), { v: 1, updatedAt: Date.now(), machines });
  return machines;
}

/** Lookup by exact id, exact name, then case-insensitive name. */
function find(userDataPath, key) {
  const needle = String(key || "").trim();
  if (!needle) return null;
  const all = readAll(userDataPath);
  return (
    all.find((vm) => vm.id === needle) ||
    all.find((vm) => vm.name === needle) ||
    all.find((vm) => String(vm.name || "").toLowerCase() === needle.toLowerCase()) ||
    null
  );
}

function require_(userDataPath, key) {
  const vm = find(userDataPath, key);
  if (!vm) {
    const known = readAll(userDataPath).map((item) => item.name || item.id);
    throw new Error(
      `VM not found: ${key || "(missing id/name)"}.` +
        (known.length ? ` Known machines: ${known.join(", ")}` : " No machines exist yet — use action=create.")
    );
  }
  return vm;
}

function validateName(rawName, userDataPath, { allowId = null } = {}) {
  const name = String(rawName || "").trim();
  if (!name) throw new Error("VM name is required");
  if (!VALID_NAME.test(name)) {
    throw new Error("VM name must be 1-63 chars of letters, digits, dot, dash or underscore, starting alphanumeric");
  }
  const clash = find(userDataPath, name);
  if (clash && clash.id !== allowId) throw new Error(`A VM named "${name}" already exists (${clash.id})`);
  return name;
}

function insert(userDataPath, record) {
  const all = readAll(userDataPath);
  all.push(record);
  writeAll(userDataPath, all);
  return record;
}

function update(userDataPath, id, patch) {
  const all = readAll(userDataPath);
  const index = all.findIndex((vm) => vm.id === id);
  if (index < 0) return null;
  all[index] = { ...all[index], ...(patch || {}), updatedAt: Date.now() };
  writeAll(userDataPath, all);
  return all[index];
}

function remove(userDataPath, id) {
  const all = readAll(userDataPath);
  const next = all.filter((vm) => vm.id !== id);
  writeAll(userDataPath, next);
  return next.length !== all.length;
}

function machineDir(userDataPath, id) {
  return ensureDir(layout.machine(userDataPath, id));
}

/** Remove a machine directory; never touch anything outside <base>/machines. */
function destroyDir(userDataPath, id) {
  const dir = layout.machine(userDataPath, id);
  const root = layout.machines(userDataPath);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return false;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  newId,
  readAll,
  writeAll,
  find,
  requireVm: require_,
  validateName,
  insert,
  update,
  remove,
  machineDir,
  destroyDir,
};
