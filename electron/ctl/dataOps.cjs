function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function getPath(obj, pathExpr) {
  if (obj == null) return undefined;
  if (pathExpr == null || pathExpr === "") return obj;
  const parts = String(pathExpr)
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, pathExpr, value) {
  const parts = String(pathExpr || "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (!parts.length) return value;
  const root = isPlainObject(obj) || Array.isArray(obj) ? obj : {};
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") {
      cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return root;
}

function deepClone(v) {
  if (v == null || typeof v !== "object") return v;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return v;
  }
}

function parseJsonValue(raw, fallback) {
  if (raw == null) return fallback !== undefined ? fallback : null;
  if (typeof raw === "object") return raw;
  const s = String(raw).trim();
  if (!s) return fallback !== undefined ? fallback : null;
  try {
    return JSON.parse(s);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`json parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stringifyJson(raw, pretty) {
  try {
    return pretty ? JSON.stringify(raw, null, 2) : JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function toArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function pickKeys(obj, keys) {
  const src = isPlainObject(obj) ? obj : {};
  const list = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? keys.split(/[,\s]+/).filter(Boolean)
      : [];
  const out = {};
  for (const k of list) {
    if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  }
  return out;
}

function omitKeys(obj, keys) {
  const src = isPlainObject(obj) ? { ...obj } : {};
  const list = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? keys.split(/[,\s]+/).filter(Boolean)
      : [];
  for (const k of list) delete src[k];
  return src;
}

function mergeObjects(a, b, deep) {
  if (!deep) {
    return {
      ...(isPlainObject(a) ? a : {}),
      ...(isPlainObject(b) ? b : {}),
    };
  }
  const out = deepClone(isPlainObject(a) ? a : {});
  const right = isPlainObject(b) ? b : {};
  for (const [k, v] of Object.entries(right)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = mergeObjects(out[k], v, true);
    } else {
      out[k] = deepClone(v);
    }
  }
  return out;
}

function flattenList(list, depth) {
  const max = depth == null ? 1 : Number(depth);
  const arr = toArray(list);
  if (!Number.isFinite(max) || max <= 0) return arr.slice();
  return arr.flat(max);
}

function uniqueList(list) {
  const seen = new Set();
  const out = [];
  for (const item of toArray(list)) {
    const key = typeof item === "object" && item != null ? JSON.stringify(item) : String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function sortList(list, { by, desc } = {}) {
  const arr = toArray(list).slice();
  const rev = desc === true;
  arr.sort((a, b) => {
    const av = by ? getPath(a, by) : a;
    const bv = by ? getPath(b, by) : b;
    if (av == null && bv == null) return 0;
    if (av == null) return rev ? 1 : -1;
    if (bv == null) return rev ? -1 : 1;
    if (typeof av === "number" && typeof bv === "number") {
      return rev ? bv - av : av - bv;
    }
    const as = String(av);
    const bs = String(bv);
    if (as < bs) return rev ? 1 : -1;
    if (as > bs) return rev ? -1 : 1;
    return 0;
  });
  return arr;
}

function pluckList(list, pathExpr) {
  return toArray(list).map((item) => getPath(item, pathExpr));
}

function groupBy(list, pathExpr) {
  const out = {};
  for (const item of toArray(list)) {
    const key = String(getPath(item, pathExpr) ?? "");
    if (!out[key]) out[key] = [];
    out[key].push(item);
  }
  return out;
}

function matchRegex(text, pattern, flags) {
  const src = text == null ? "" : String(text);
  const re = new RegExp(String(pattern || ""), flags != null ? String(flags) : undefined);
  const m = src.match(re);
  if (!m) return { matched: false, match: null, groups: null, index: -1 };
  return {
    matched: true,
    match: m[0],
    groups: m.slice(1),
    index: m.index == null ? -1 : m.index,
    named: m.groups || null,
  };
}

function replaceText(text, pattern, replacement, flags) {
  const src = text == null ? "" : String(text);
  const re = new RegExp(String(pattern || ""), flags != null ? String(flags) : "g");
  return src.replace(re, replacement == null ? "" : String(replacement));
}

function sliceValue(v, start, end) {
  if (typeof v === "string") {
    return end == null ? v.slice(Number(start) || 0) : v.slice(Number(start) || 0, Number(end));
  }
  const arr = toArray(v);
  return end == null ? arr.slice(Number(start) || 0) : arr.slice(Number(start) || 0, Number(end));
}

function coallesce(...vals) {
  for (const v of vals) {
    if (v != null && v !== "") return v;
  }
  return null;
}

function runDataOp(kind, op, resolveValue, scope) {
  const k = String(kind || "")
    .trim()
    .toLowerCase();

  if (k === "json" || k === "parse_json" || k === "json_parse") {
    const raw = resolveValue(op.value != null ? op.value : op.from != null ? op.from : op.text, scope);
    const fallback = op.fallback !== undefined ? resolveValue(op.fallback, scope) : undefined;
    return parseJsonValue(raw, fallback);
  }

  if (k === "stringify" || k === "json_stringify" || k === "to_json") {
    const raw = resolveValue(op.value != null ? op.value : op.from, scope);
    return stringifyJson(raw, op.pretty === true);
  }

  if (k === "pick") {
    const obj = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.object, scope);
    const keys = resolveValue(op.keys != null ? op.keys : op.fields, scope);
    return pickKeys(obj, keys);
  }

  if (k === "omit") {
    const obj = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.object, scope);
    const keys = resolveValue(op.keys != null ? op.keys : op.fields, scope);
    return omitKeys(obj, keys);
  }

  if (k === "get" || k === "path" || k === "at") {
    const obj = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.object, scope);
    const pathExpr = resolveValue(op.path != null ? op.path : op.key, scope);
    return getPath(obj, pathExpr);
  }

  if (k === "set_path" || k === "put") {
    const obj = resolveValue(op.from != null ? op.from : op.object != null ? op.object : {}, scope);
    const pathExpr = resolveValue(op.path != null ? op.path : op.key, scope);
    const value = resolveValue(op.value, scope);
    return setPath(deepClone(obj), pathExpr, value);
  }

  if (k === "merge" || k === "assign") {
    const a = resolveValue(op.a != null ? op.a : op.left != null ? op.left : op.from, scope);
    const b = resolveValue(op.b != null ? op.b : op.right != null ? op.right : op.with, scope);
    const extra = Array.isArray(op.values)
      ? op.values.map((x) => resolveValue(x, scope))
      : [];
    let out = mergeObjects(a, b, op.deep === true);
    for (const item of extra) out = mergeObjects(out, item, op.deep === true);
    return out;
  }

  if (k === "object" || k === "dict") {
    const raw = op.value != null ? op.value : op.fields != null ? op.fields : op;
    if (isPlainObject(raw) && (op.value != null || op.fields != null)) {
      return resolveValue(raw, scope);
    }
    const skip = new Set([
      "op",
      "type",
      "do",
      "as",
      "id",
      "when",
      "if",
      "name",
      "var",
      "tool",
      "call",
      "input",
      "args",
    ]);
    const out = {};
    for (const [key, val] of Object.entries(op || {})) {
      if (skip.has(key)) continue;
      out[key] = resolveValue(val, scope);
    }
    return out;
  }

  if (k === "array" || k === "list") {
    const raw = op.value != null ? op.value : op.items != null ? op.items : op.list;
    return toArray(resolveValue(raw, scope));
  }

  if (k === "concat" || k === "append") {
    const parts = [];
    if (op.value != null) parts.push(...toArray(resolveValue(op.value, scope)));
    if (op.a != null) parts.push(...toArray(resolveValue(op.a, scope)));
    if (op.b != null) parts.push(...toArray(resolveValue(op.b, scope)));
    if (Array.isArray(op.items)) {
      for (const item of op.items) parts.push(...toArray(resolveValue(item, scope)));
    }
    if (op.with != null) parts.push(...toArray(resolveValue(op.with, scope)));
    return parts;
  }

  if (k === "flatten") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    return flattenList(list, op.depth != null ? resolveValue(op.depth, scope) : 1);
  }

  if (k === "unique" || k === "uniq") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    return uniqueList(list);
  }

  if (k === "sort") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    return sortList(list, {
      by: op.by != null ? resolveValue(op.by, scope) : undefined,
      desc: op.desc === true || op.reverse === true,
    });
  }

  if (k === "pluck" || k === "map_get") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    const pathExpr = resolveValue(op.path != null ? op.path : op.key, scope);
    return pluckList(list, pathExpr);
  }

  if (k === "group" || k === "group_by") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    const pathExpr = resolveValue(op.by != null ? op.by : op.path != null ? op.path : op.key, scope);
    return groupBy(list, pathExpr);
  }

  if (k === "keys") {
    const obj = resolveValue(op.from != null ? op.from : op.value, scope);
    return isPlainObject(obj) ? Object.keys(obj) : Array.isArray(obj) ? obj.map((_, i) => String(i)) : [];
  }

  if (k === "values") {
    const obj = resolveValue(op.from != null ? op.from : op.value, scope);
    return isPlainObject(obj) ? Object.values(obj) : toArray(obj);
  }

  if (k === "entries") {
    const obj = resolveValue(op.from != null ? op.from : op.value, scope);
    return isPlainObject(obj) ? Object.entries(obj).map(([key, value]) => ({ key, value })) : [];
  }

  if (k === "length" || k === "len" || k === "count") {
    const v = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    if (v == null) return 0;
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    if (isPlainObject(v)) return Object.keys(v).length;
    return 1;
  }

  if (k === "slice") {
    const v = resolveValue(op.from != null ? op.from : op.value, scope);
    const start = resolveValue(op.start != null ? op.start : op.fromIndex != null ? op.fromIndex : 0, scope);
    const end = op.end != null ? resolveValue(op.end, scope) : op.to != null ? resolveValue(op.to, scope) : undefined;
    return sliceValue(v, start, end);
  }

  if (k === "join") {
    const list = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.list, scope);
    const sep = op.sep != null ? String(resolveValue(op.sep, scope)) : op.separator != null ? String(resolveValue(op.separator, scope)) : ",";
    return toArray(list)
      .map((x) => (x == null ? "" : String(x)))
      .join(sep);
  }

  if (k === "split") {
    const text = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.text, scope);
    const sep = op.sep != null ? String(resolveValue(op.sep, scope)) : op.separator != null ? String(resolveValue(op.separator, scope)) : ",";
    return String(text ?? "").split(sep);
  }

  if (k === "lower") {
    return String(resolveValue(op.from != null ? op.from : op.value, scope) ?? "").toLowerCase();
  }

  if (k === "upper") {
    return String(resolveValue(op.from != null ? op.from : op.value, scope) ?? "").toUpperCase();
  }

  if (k === "trim") {
    return String(resolveValue(op.from != null ? op.from : op.value, scope) ?? "").trim();
  }

  if (k === "match" || k === "regex") {
    const text = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.text, scope);
    const pattern = resolveValue(op.pattern != null ? op.pattern : op.regex, scope);
    const flags = op.flags != null ? resolveValue(op.flags, scope) : undefined;
    return matchRegex(text, pattern, flags);
  }

  if (k === "replace") {
    const text = resolveValue(op.from != null ? op.from : op.value != null ? op.value : op.text, scope);
    const pattern = resolveValue(op.pattern != null ? op.pattern : op.regex != null ? op.regex : op.search, scope);
    const replacement = resolveValue(op.with != null ? op.with : op.replacement != null ? op.replacement : op.to, scope);
    const flags = op.flags != null ? resolveValue(op.flags, scope) : "g";
    return replaceText(text, pattern, replacement, flags);
  }

  if (k === "coalesce" || k === "first") {
    const vals = [];
    if (Array.isArray(op.values)) {
      for (const item of op.values) vals.push(resolveValue(item, scope));
    }
    if (op.a !== undefined) vals.push(resolveValue(op.a, scope));
    if (op.b !== undefined) vals.push(resolveValue(op.b, scope));
    if (op.c !== undefined) vals.push(resolveValue(op.c, scope));
    if (op.value !== undefined) vals.push(resolveValue(op.value, scope));
    if (op.from !== undefined) vals.push(resolveValue(op.from, scope));
    return coallesce(...vals);
  }

  if (k === "number" || k === "num" || k === "int") {
    const v = resolveValue(op.from != null ? op.from : op.value, scope);
    const n = Number(v);
    if (!Number.isFinite(n)) {
      if (op.fallback !== undefined) return resolveValue(op.fallback, scope);
      return null;
    }
    return k === "int" ? Math.trunc(n) : n;
  }

  if (k === "bool" || k === "boolean") {
    const v = resolveValue(op.from != null ? op.from : op.value, scope);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (v == null) return false;
    const s = String(v).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off", ""].includes(s)) return false;
    return Boolean(v);
  }

  if (k === "clone" || k === "copy") {
    return deepClone(resolveValue(op.from != null ? op.from : op.value, scope));
  }

  if (k === "now" || k === "timestamp") {
    return Date.now();
  }

  if (k === "iso_now" || k === "datetime") {
    return new Date().toISOString();
  }

  if (k === "env") {
    const key = resolveValue(op.key != null ? op.key : op.name, scope);
    if (key === "rootPath") return scope?.env?.rootPath ?? null;
    if (key === "projectName") return scope?.env?.projectName ?? null;
    if (key === "userDataPath") return scope?.env?.userDataPath ?? null;
    return getPath(scope?.env, key);
  }

  return undefined;
}

const DATA_OP_NAMES = new Set([
  "json",
  "parse_json",
  "json_parse",
  "stringify",
  "json_stringify",
  "to_json",
  "pick",
  "omit",
  "get",
  "path",
  "at",
  "set_path",
  "put",
  "merge",
  "assign",
  "object",
  "dict",
  "array",
  "list",
  "concat",
  "append",
  "flatten",
  "unique",
  "uniq",
  "sort",
  "pluck",
  "map_get",
  "group",
  "group_by",
  "keys",
  "values",
  "entries",
  "length",
  "len",
  "count",
  "slice",
  "join",
  "split",
  "lower",
  "upper",
  "trim",
  "match",
  "regex",
  "replace",
  "coalesce",
  "first",
  "number",
  "num",
  "int",
  "bool",
  "boolean",
  "clone",
  "copy",
  "now",
  "timestamp",
  "iso_now",
  "datetime",
  "env",
]);

function isDataOpName(name) {
  return DATA_OP_NAMES.has(String(name || "").trim().toLowerCase());
}

module.exports = {
  isPlainObject,
  getPath,
  setPath,
  deepClone,
  parseJsonValue,
  stringifyJson,
  toArray,
  pickKeys,
  omitKeys,
  mergeObjects,
  runDataOp,
  isDataOpName,
  DATA_OP_NAMES,
};
