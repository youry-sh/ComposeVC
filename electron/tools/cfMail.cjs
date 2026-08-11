/**
 * cf_mail — CF Worker temp-mail for the AI agent.
 *
 * Uses the same backend as Runtime companion (runtime-app):
 *   runtime-app/data/config.json  → API URL + admin token + domain
 *   runtime-app/data/cfworker_addresses.json → local mailbox list
 *
 * Actions:
 *   create / generate  — create a new mailbox address
 *   list               — list known addresses
 *   inbox / list_mails — list messages for one address (one shot)
 *   get / read         — fetch one message body by id
 *   wait / wait_mail   — POLL until a new message arrives (do not give up immediately)
 *   delete             — remove mailbox locally (+ remote best-effort)
 *
 * Wait defaults: poll every ~3s, total up to ~90s. Emails often arrive slowly —
 * use wait, not a single list call, after the site sent a code/link.
 * Every CF Worker HTTP call has a hard timeout so inbox/wait never hang forever.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG_REL = path.join("runtime-app", "data", "config.json");
const ADDRESSES_REL = path.join("runtime-app", "data", "cfworker_addresses.json");

const DEFAULT_POLL_MS = 3000;
const DEFAULT_TIMEOUT_SEC = 90;
const MIN_POLL_MS = 1000;
const MAX_POLL_MS = 15000;
const MIN_TIMEOUT_SEC = 5;
const MAX_TIMEOUT_SEC = 300;
const MAX_BODY_CHARS = 12000;
const WORKER_FETCH_TIMEOUT_MS = 8000;
const WAIT_MAX_CONSECUTIVE_ERRORS = 2;

/**
 * App install root (folder that contains electron/ + runtime-app/).
 * CF Worker is configured ONCE in Runtime companion — always read from here,
 * NOT from the currently open project folder (that often has no runtime-app/).
 */
function appRoot() {
  return path.join(__dirname, "..", "..");
}

/** @deprecated use appRoot — kept so callers with context still work */
function projectRoot(_context = {}) {
  return appRoot();
}

function configPath(root = appRoot()) {
  return path.join(root, CONFIG_REL);
}

function addressesPath(root = appRoot()) {
  return path.join(root, ADDRESSES_REL);
}

async function ensureDataDir(root = appRoot()) {
  await fs.promises.mkdir(path.join(root, "runtime-app", "data"), { recursive: true });
}

function defaultConfig() {
  return {
    cfworker_api_url: "",
    cfworker_admin_token: "",
    cfworker_domain: "",
    cfworker_fingerprint: "",
    enable_prefix: true,
  };
}

function normalizeConfig(data = {}) {
  return {
    ...defaultConfig(),
    ...data,
    cfworker_api_url: String(data?.cfworker_api_url || "").trim(),
    cfworker_admin_token: String(data?.cfworker_admin_token || "").trim(),
    cfworker_domain: String(data?.cfworker_domain || "").trim(),
    cfworker_fingerprint: String(data?.cfworker_fingerprint || "").trim(),
    enable_prefix: data?.enable_prefix !== false,
  };
}

async function loadConfig(root) {
  try {
    const raw = await fs.promises.readFile(configPath(root), "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function requireConfig(root = appRoot()) {
  const cfg = await loadConfig(root);
  if (!cfg || !cfg.cfworker_api_url || !cfg.cfworker_admin_token) {
    const err = new Error(
      "CF Worker mail credentials missing in app runtime-app/data/config.json " +
        `(looked at ${configPath(root)}). Open Runtime companion → Mail settings once, save, retry.`
    );
    err.code = "not_configured";
    throw err;
  }
  return cfg;
}

async function loadAddresses(root) {
  await ensureDataDir(root);
  try {
    const raw = await fs.promises.readFile(addressesPath(root), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    if (data.length && typeof data[0] === "string") {
      return data.map((email) => ({ email: String(email).toLowerCase(), source: "auto" }));
    }
    return data
      .map((item) => ({
        email: String(item?.email || item?.address || "")
          .trim()
          .toLowerCase(),
        source: item?.source === "manual" ? "manual" : "auto",
        category: String(item?.category || item?.group || "").trim() || "Без категории",
        created_at: item?.created_at || null,
        token: item?.token || null,
      }))
      .filter((a) => a.email);
  } catch {
    return [];
  }
}

async function saveAddresses(root, list) {
  await ensureDataDir(root);
  const seen = new Set();
  const deduped = [];
  for (const item of list || []) {
    const email = String(item?.email || "")
      .trim()
      .toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    deduped.push({
      email,
      source: item?.source === "manual" ? "manual" : "auto",
      category: String(item?.category || "").trim() || "Без категории",
      created_at: item?.created_at || null,
      token: item?.token || null,
    });
  }
  await fs.promises.writeFile(addressesPath(root), JSON.stringify(deduped, null, 2), "utf8");
  return deduped;
}

async function upsertAddress(root, email, source = "manual", extra = {}) {
  const list = await loadAddresses(root);
  const key = String(email || "")
    .trim()
    .toLowerCase();
  if (!key) return list;
  const idx = list.findIndex((a) => a.email === key);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      source: source === "manual" ? "manual" : list[idx].source || "auto",
      ...extra,
      category:
        extra.category != null
          ? String(extra.category).trim() || "Без категории"
          : list[idx].category || "Без категории",
    };
  } else {
    const { category: catExtra, ...restExtra } = extra || {};
    list.unshift({
      email: key,
      source: source === "manual" ? "manual" : "auto",
      created_at: new Date().toISOString(),
      ...restExtra,
      category: String(catExtra || extra.category || "").trim() || "Без категории",
    });
  }
  return saveAddresses(root, list);
}

function workerHeaders(cfg) {
  const headers = {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-admin-auth": cfg.cfworker_admin_token || "",
  };
  if (cfg.cfworker_fingerprint) headers["x-fingerprint"] = cfg.cfworker_fingerprint;
  return headers;
}

function combineSignals(signals = []) {
  const list = (Array.isArray(signals) ? signals : [signals]).filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any(list);
  }
  const ctrl = new AbortController();
  const onAbort = () => {
    try {
      ctrl.abort();
    } catch {
      /* */
    }
  };
  for (const s of list) {
    if (s.aborted) {
      onAbort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return ctrl.signal;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  const msg = String(err.message || err || "");
  return /aborted|AbortError|The operation was aborted/i.test(msg);
}

async function workerRequest(cfg, apiPath, { method = "GET", body, signal, timeoutMs } = {}) {
  const base = String(cfg.cfworker_api_url || "").replace(/\/+$/, "");
  if (!base || !cfg.cfworker_admin_token) {
    const err = new Error("CF Worker не настроен: укажите API URL и Admin Token");
    err.status = 400;
    throw err;
  }
  const url = `${base}${apiPath.startsWith("/") ? apiPath : `/${apiPath}`}`;
  const fetchTimeout = clampInt(timeoutMs, 2000, 60000, WORKER_FETCH_TIMEOUT_MS);
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    try {
      timeoutCtrl.abort();
    } catch {
      /* */
    }
  }, fetchTimeout);
  const combined = combineSignals([signal, timeoutCtrl.signal]);
  try {
    const res = await fetch(url, {
      method,
      headers: workerHeaders(cfg),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: combined,
    });
    const text = await res.text();
    if (res.status >= 400) {
      const err = new Error(`CF Worker API error (${res.status}): ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    if (!text.trim()) return method === "POST" ? {} : [];
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    if (isAbortError(err)) {
      if (signal?.aborted) {
        const e = new Error("Stopped by user");
        e.name = "AbortError";
        e.code = "aborted";
        throw e;
      }
      const e = new Error(
        `CF Worker request timed out after ${fetchTimeout}ms (${method} ${apiPath})`
      );
      e.name = "TimeoutError";
      e.code = "timeout";
      e.status = 408;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMailsPage(cfg, address, { limit = 50, offset = 0, signal, timeoutMs } = {}) {
  const p = `/admin/mails?limit=${limit}&offset=${offset}&address=${encodeURIComponent(address)}`;
  const data = await workerRequest(cfg, p, { signal, timeoutMs });
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    if (Array.isArray(data.results)) return data.results;
    if (data.id != null) return [data];
  }
  return [];
}

async function fetchAllMails(cfg, address, { max = 200, signal, timeoutMs } = {}) {
  const all = [];
  let offset = 0;
  const pageSize = 50;
  while (all.length < max) {
    if (signal?.aborted) {
      const e = new Error("Stopped by user");
      e.name = "AbortError";
      e.code = "aborted";
      throw e;
    }
    const mails = await fetchMailsPage(cfg, address, {
      limit: pageSize,
      offset,
      signal,
      timeoutMs,
    });
    if (!mails.length) break;
    all.push(...mails);
    if (mails.length < pageSize) break;
    offset += pageSize;
  }
  return all.slice(0, max);
}

async function fetchMailDetail(cfg, mailId, { signal, timeoutMs } = {}) {
  return workerRequest(cfg, `/admin/mails/${encodeURIComponent(mailId)}`, {
    signal,
    timeoutMs,
  });
}

function sleep(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  if (signal?.aborted) {
    const e = new Error("Stopped by user");
    e.name = "AbortError";
    e.code = "aborted";
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      const e = new Error("Stopped by user");
      e.name = "AbortError";
      e.code = "aborted";
      reject(e);
    };
    timer = setTimeout(() => {
      if (signal) {
        try {
          signal.removeEventListener("abort", onAbort);
        } catch {
          /* */
        }
      }
      resolve();
    }, wait);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function decodeQuotedPrintable(input) {
  return String(input || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function splitHeadersBody(part) {
  const s = String(part || "");
  const crlf = s.indexOf("\r\n\r\n");
  if (crlf !== -1) return { headers: s.slice(0, crlf), body: s.slice(crlf + 4) };
  const lf = s.indexOf("\n\n");
  if (lf !== -1) return { headers: s.slice(0, lf), body: s.slice(lf + 2) };
  return { headers: "", body: s };
}

function headerValue(headers, name) {
  const re = new RegExp(`^${name}\\s*:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`, "im");
  const m = String(headers || "").match(re);
  return m ? m[1].replace(/\r?\n[ \t]/g, " ").trim() : "";
}

function decodePayload(body, headers) {
  const cte = headerValue(headers, "Content-Transfer-Encoding").toLowerCase();
  let out = String(body || "");
  if (cte.includes("quoted-printable") || /=[0-9A-Fa-f]{2}/.test(out.slice(0, 4000))) {
    out = decodeQuotedPrintable(out);
  } else if (cte.includes("base64")) {
    try {
      out = Buffer.from(out.replace(/\s+/g, ""), "base64").toString("utf8");
    } catch {
      /* keep */
    }
  }
  return out;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Parse MIME raw → { text, html }. */
function parseRawMime(raw) {
  const source = String(raw || "");
  if (!source || source === "OK" || source.length < 8) return { text: "", html: "" };

  let text = "";
  let html = "";

  const collectPart = (part) => {
    const { headers, body } = splitHeadersBody(part);
    const ct = headerValue(headers, "Content-Type").toLowerCase();
    if (!ct && !body) return;
    const decoded = decodePayload(body, headers);
    if (ct.includes("text/html") || (!ct && /<!doctype html|<html[\s>]/i.test(decoded))) {
      if (!html || decoded.length > html.length) html = decoded;
    } else if (ct.includes("text/plain")) {
      if (!text || decoded.length > text.length) text = decoded;
    }
  };

  const boundaryRe = /boundary="?([^"\r\n;]+)"?/gi;
  const boundaries = [];
  let bm;
  while ((bm = boundaryRe.exec(source))) {
    const b = bm[1].trim();
    if (b && !boundaries.includes(b)) boundaries.push(b);
  }

  if (boundaries.length) {
    for (const boundary of boundaries) {
      const parts = source.split(`--${boundary}`);
      for (const part of parts) {
        if (!part || part.startsWith("--")) continue;
        collectPart(part);
      }
    }
  }

  if (!html && !text) {
    const re = /Content-Type:\s*text\/(html|plain)[^\r\n]*/gi;
    let m;
    const hits = [];
    while ((m = re.exec(source))) {
      hits.push({ kind: m[1].toLowerCase(), index: m.index });
    }
    if (hits.length) {
      for (let i = 0; i < hits.length; i++) {
        const start = hits[i].index;
        const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
        collectPart(source.slice(start, end));
      }
    } else {
      const last = source.lastIndexOf("\r\n\r\n");
      const alt = source.lastIndexOf("\n\n");
      const cut = Math.max(last, alt);
      if (cut !== -1) {
        const body = source.slice(cut + (last === cut ? 4 : 2));
        if (/<[a-z][\s\S]*>/i.test(body)) html = body;
        else text = body;
      }
    }
  }

  return { text: text.trim(), html: html.trim() };
}

function extractCodes(text, subject = "") {
  const s = `${subject || ""}\n${text || ""}`;
  const codes = [];
  const push = (c) => {
    let v = String(c || "").trim();
    // strip trailing punctuation
    v = v.replace(/[.,;:!?]+$/g, "");
    if (!v || codes.includes(v)) return;
    // skip pure years
    if (/^\d{4}$/.test(v) && Number(v) >= 1900 && Number(v) <= 2100) return;
    if (/^(19|20)\d{2}$/.test(v)) return;
    // must look like a code: digits and/or mixed alnum, not plain English words
    const isDigit = /^\d{4,8}$/.test(v);
    const isHyphen = /^[A-Za-z0-9]{2,5}-[A-Za-z0-9]{2,6}$/.test(v);
    const isMixed = /[A-Za-z]/.test(v) && /\d/.test(v) && v.length >= 4 && v.length <= 12;
    const isShortToken = /^[A-Z0-9]{5,8}$/.test(v) && /[0-9]/.test(v);
    if (!(isDigit || isHyphen || isMixed || isShortToken)) return;
    codes.push(v);
  };

  // 1) Hyphenated short codes first (xAI: JRR-D4E)
  let m;
  const hyphen = /\b([A-Z0-9]{2,5}-[A-Z0-9]{2,6})\b/gi;
  while ((m = hyphen.exec(s))) push(m[1].toUpperCase());

  // 2) Subject head / subject hyphen (xAI: "JRR-D4E xAI confirmation code")
  const subj = String(subject || "").trim();
  if (subj) {
    const head = subj.match(/^([A-Z0-9]{3,8}(?:-[A-Z0-9]{2,6})?)\b/i);
    if (head) push(head[1].toUpperCase());
  }

  // 3) "code is XXX" / "code: XXX" — capture next token only if code-like
  const labeled =
    /(?:confirmation|verification|security|login|otp|auth(?:entication)?|one[-\s]?time)?\s*codes?\s*(?:is|:|=)?\s*([A-Z0-9][A-Z0-9\-]{2,14})/gi;
  while ((m = labeled.exec(s))) push(m[1]);

  // 4) Standalone 4–8 digit OTP
  const digits = /\b(\d{4,8})\b/g;
  while ((m = digits.exec(s))) push(m[1]);

  // 5) Isolated line that is only a short code (common email layout)
  for (const line of s.split(/\n+/)) {
    const t = line.trim();
    if (/^[A-Z0-9]{4,8}(?:-[A-Z0-9]{2,6})?$/i.test(t)) push(t.toUpperCase());
  }

  return codes.slice(0, 8);
}

function extractLinks(text) {
  const s = String(text || "");
  const links = [];
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let m;
  while ((m = re.exec(s))) {
    let u = m[0].replace(/[.,;:]+$/, "");
    if (!links.includes(u)) links.push(u);
  }
  return links.slice(0, 12);
}

function mailMeta(m) {
  return {
    id: m?.id ?? m?.mail_id ?? null,
    from: m?.from || m?.sender || "",
    to: m?.to || m?.address || "",
    subject: m?.subject || "",
    created_at: m?.created_at || m?.date || m?.createdAt || null,
  };
}

function isUsefulPayload(obj) {
  if (!obj || typeof obj !== "object") return false;
  const raw = obj.raw != null ? String(obj.raw) : "";
  const text = obj.text != null ? String(obj.text) : "";
  const html = obj.html != null ? String(obj.html) : "";
  if (raw && raw !== "OK" && raw.length > 20) return true;
  if (text && text !== "OK" && text.length > 0) return true;
  if (html && html.length > 0) return true;
  return false;
}

function mergeMail(base, extra) {
  const out = { ...(base || {}) };
  if (!extra || typeof extra !== "object") return out;
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (typeof v === "string" && (!v.trim() || v.trim() === "OK")) continue;
    if (k === "raw" && out.raw && String(out.raw).length > String(v).length) continue;
    out[k] = v;
  }
  return out;
}

function cleanMailText(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function summarizeMail(mail, { maxChars = MAX_BODY_CHARS } = {}) {
  const meta = mailMeta(mail);
  let text = String(mail?.text || "").trim();
  let html = String(mail?.html || "").trim();
  const raw = String(mail?.raw || "");

  if ((!text || text === "OK") && raw && raw !== "OK") {
    const parsed = parseRawMime(raw);
    if (parsed.text) text = parsed.text;
    if (parsed.html) html = parsed.html;
  }
  if (!text && html) text = htmlToText(html);
  // Prefer plain text; if garbage-short, fall back to html→text
  if (html && (!text || text.length < 40 || /^[\d\s\r\n]+$/.test(text.slice(0, 80)))) {
    const fromHtml = htmlToText(html);
    if (fromHtml && fromHtml.length > text.length) text = fromHtml;
  }

  const body = cleanMailText(text || htmlToText(html) || (raw && raw !== "OK" ? raw : ""));
  const clipped =
    body.length > maxChars
      ? body.slice(0, maxChars) + `\n…[truncated ${body.length - maxChars} chars]`
      : body;

  const codes = extractCodes(clipped, meta.subject);
  // Prefer hyphenated / labeled codes over bare years-like digits
  const prefer =
    codes.find((c) => /[A-Za-z]/.test(c) && c.includes("-")) ||
    codes.find((c) => /[A-Za-z]/.test(c)) ||
    codes.find((c) => /^\d{4,8}$/.test(c)) ||
    codes[0] ||
    null;
  const links = extractLinks(`${clipped}\n${html || ""}`);

  return {
    ...meta,
    text: clipped,
    has_html: Boolean(html),
    codes,
    links,
    // convenience for OTP flows
    otp_guess: prefer,
  };
}

async function enrichMail(cfg, listed, { signal } = {}) {
  if (!listed) return null;
  let mail = listed;
  if (!isUsefulPayload(listed) && listed.id != null) {
    try {
      const detail = await fetchMailDetail(cfg, listed.id, { signal });
      if (isUsefulPayload(detail)) mail = mergeMail(listed, detail);
      else if (detail && typeof detail === "object") mail = mergeMail(listed, detail);
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
  }
  return summarizeMail(mail);
}

function mailMatchesFilter(summary, { subject_includes, from_includes, body_includes, after_id } = {}) {
  if (after_id != null && after_id !== "" && String(summary.id) === String(after_id)) return false;
  if (subject_includes) {
    const needle = String(subject_includes).toLowerCase();
    if (!String(summary.subject || "").toLowerCase().includes(needle)) return false;
  }
  if (from_includes) {
    const needle = String(from_includes).toLowerCase();
    if (!String(summary.from || "").toLowerCase().includes(needle)) return false;
  }
  if (body_includes) {
    const needle = String(body_includes).toLowerCase();
    const hay = `${summary.subject || ""}\n${summary.text || ""}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortMailsNewestFirst(mails) {
  return [...mails].sort((a, b) => {
    const ta = Date.parse(a.created_at || a.date || a.createdAt || 0) || 0;
    const tb = Date.parse(b.created_at || b.date || b.createdAt || 0) || 0;
    if (tb !== ta) return tb - ta;
    // fallback: higher id first if numeric
    const ia = Number(a.id);
    const ib = Number(b.id);
    if (Number.isFinite(ia) && Number.isFinite(ib)) return ib - ia;
    return String(b.id || "").localeCompare(String(a.id || ""));
  });
}

/**
 * Random local-part: letters+digits only (looks natural, no task prefixes).
 * Agents must NOT pass name=groksasN… — omit name so this runs, or pass random alnum.
 * Length 10–14 chars, starts with a letter.
 */
function randomName() {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
  const len = 10 + (crypto.randomBytes(1)[0] % 5); // 10..14
  const bytes = crypto.randomBytes(len);
  let out = letters[bytes[0] % letters.length];
  for (let i = 1; i < len; i++) {
    out += alnum[bytes[i] % alnum.length];
  }
  // sprinkle a digit so pure-word locals are rare
  if (!/\d/.test(out)) {
    const pos = 1 + (bytes[1] % (len - 1));
    const dig = String(bytes[2] % 10);
    out = out.slice(0, pos) + dig + out.slice(pos + 1);
  }
  return out;
}

/**
 * Sanitize optional name hint.
 * Task-y labels (groksas4, unit1, acc-3, groksas4.3npa) → "" so create uses randomName().
 * Only keep clean human-ish locals (no automation prefix).
 */
function sanitizeLocalPartHint(raw) {
  const original = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]/g, "") // only letters and digits — no dots, no +-_
    .replace(/\./g, "");
  if (!original) return "";
  // Reject whole automation-style names (never pass through as local-part)
  if (
    /^(grok|xai|sas|acc|unit|profile|mail|test|tmp|auto)/i.test(original) ||
    /groksas|xai[_-]?sas|unit\d|acc\d/i.test(original)
  ) {
    return "";
  }
  let s = original;
  if (s.length < 4) return "";
  if (s.length > 32) s = s.slice(0, 32);
  if (!/^[a-z]/.test(s)) s = "a" + s;
  return s;
}

function resolveAction(input = {}) {
  const raw = String(input.action || input.op || input.mode || "create")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const map = {
    create: "create",
    generate: "create",
    new: "create",
    new_address: "create",
    gen: "create",
    list: "list",
    addresses: "list",
    list_addresses: "list",
    boxes: "list",
    inbox: "inbox",
    list_mails: "inbox",
    mails: "inbox",
    messages: "inbox",
    list_messages: "inbox",
    get: "get",
    read: "get",
    open: "get",
    mail: "get",
    get_mail: "get",
    wait: "wait",
    wait_mail: "wait",
    wait_for: "wait",
    wait_for_mail: "wait",
    poll: "wait",
    receive: "wait",
    delete: "delete",
    remove: "delete",
    status: "status",
    config: "status",
  };
  return map[raw] || raw;
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

module.exports = {
  // helpers exported for unit tests / tooling
  randomName,
  sanitizeLocalPartHint,
  name: "cf_mail",
  description:
    "Real temp-mail via CF Worker (Runtime companion API — ALREADY configured in the app). " +
    "Just call the API: create mailbox + wait/poll for letters and OTP codes. Do NOT ask the user to configure anything.\n\n" +
    "USE WHEN: signup needs a real inbox, email OTP/link/code must be read automatically " +
    "(do NOT use fake generate_email, do NOT invent codes, do NOT ask the human to open mail).\n\n" +
    "Flow: create (omit name — random letters+digits local-part, no dots) → fill form with returned email → after site sends mail → wait (poll).\n" +
    "Do NOT pass name=groksasN / unitN / profile labels — tool strips those and uses pure random alnum (no dots).\n" +
    "Actions:\n" +
    "- create|generate — new address (omit name for random alnum, no dots; optional category)\n" +
    "- list — known addresses\n" +
    "- inbox|list_mails — one-shot list for email=…\n" +
    "- get|read — full message (text, codes, links)\n" +
    "- wait|wait_mail|receive — POLL until mail is available (default ~3s / ~90s). " +
    "Returns EXISTING inbox mail immediately if already arrived (OTP often lands before wait). " +
    "Pass only_new=true or known_ids/after_id to skip already-seen messages. " +
    "Mails can be slow — ALWAYS wait after send, never give up after one empty inbox. " +
    "HTTP calls hard-timeout (~8s); API timeouts/errors fail-fast instead of hanging.\n" +
    "Result includes otp_guess + codes[] + links[] (digit + hyphenated codes like JRR-D4E).\n" +
    "- delete — remove mailbox\n" +
    "- status — optional health check (not required before create)",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "create",
          "generate",
          "list",
          "inbox",
          "list_mails",
          "get",
          "read",
          "wait",
          "wait_mail",
          "receive",
          "delete",
          "status",
        ],
        description:
          "create/generate = new mailbox. list = addresses. inbox = one-shot messages. " +
          "get/read = one message. wait/receive = poll until mail (preferred for OTP). delete. status.",
      },
      email: {
        type: "string",
        description: "Mailbox address for inbox / wait / get / delete.",
      },
      address: { type: "string", description: "Alias of email." },
      name: {
        type: "string",
        description:
          "Optional local-part. Prefer OMIT — tool generates random letters+digits, no dots (e.g. k7m2xq9p4ab). " +
          "Do NOT pass groksasN / unitN / profile names — those are stripped and replaced with random. " +
          "Dots are forbidden — local-part uses only a-z0-9.",
      },
      domain: {
        type: "string",
        description: "Override domain on create (default from config).",
      },
      category: {
        type: "string",
        description: "Optional category label stored in local JSON.",
      },
      mail_id: {
        type: "string",
        description: "Message id for get/read.",
      },
      id: { type: "string", description: "Alias of mail_id." },
      timeout_sec: {
        type: "number",
        description: `Wait timeout seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).`,
      },
      poll_ms: {
        type: "number",
        description: `Poll interval ms for wait (default ${DEFAULT_POLL_MS}).`,
      },
      subject_includes: {
        type: "string",
        description: "Filter: subject must include this (case-insensitive).",
      },
      from_includes: {
        type: "string",
        description: "Filter: from must include this.",
      },
      body_includes: {
        type: "string",
        description: "Filter: subject+body must include this.",
      },
      after_id: {
        type: "string",
        description: "Ignore this mail id (wait for a newer message).",
      },
      known_ids: {
        type: "array",
        items: { type: "string" },
        description: "Ignore these mail ids when waiting for a new one.",
      },
      only_new: {
        type: "boolean",
        description:
          "If true, snapshot current inbox on first poll and only return mails that arrive after. " +
          "Default false: return existing mail immediately (typical OTP — mail often already there).",
      },
      limit: {
        type: "number",
        description: "Max messages to return for inbox (default 20).",
      },
      enable_prefix: {
        type: "boolean",
        description:
          "Pass enablePrefix to worker on create (default false for agent — cleaner random locals).",
      },
    },
    required: [],
  },

  async execute(input = {}, context = {}) {
    // Always app install root (runtime-app next to electron/) — ignore open project path.
    const root = appRoot();
    const signal = input.signal || context?.signal;
    if (signal?.aborted) {
      throw Object.assign(new Error("Stopped by user"), { name: "AbortError", code: "aborted" });
    }
    const action = resolveAction(input);
    const email = String(input.email || input.address || input.mailbox || "")
      .trim()
      .toLowerCase();

    if (action === "status") {
      const cfg = await loadConfig(root);
      const ready = Boolean(cfg?.cfworker_api_url && cfg?.cfworker_admin_token);
      const list = await loadAddresses(root);
      return {
        ok: true,
        configured: ready,
        domain: cfg?.cfworker_domain || "",
        api_url: cfg?.cfworker_api_url || "",
        addresses_count: list.length,
        config_path: configPath(root),
        note: ready
          ? "CF Worker already configured in Runtime — just create + wait for mails/OTP."
          : "Runtime Mail credentials missing (app runtime-app/data/config.json).",
      };
    }

    if (action === "list") {
      const list = await loadAddresses(root);
      return {
        ok: true,
        addresses: list,
        count: list.length,
      };
    }

    if (action === "create") {
      const cfg = await requireConfig(root);
      // Prefer pure random letters+digits. Ignore task-y name hints (groksas4, unit1…).
      const hinted = sanitizeLocalPartHint(input.name || input.local || input.local_part || "");
      const name = hinted || randomName();
      const domain = String(input.domain || cfg.cfworker_domain || "").trim();
      const category = String(input.category || "").trim() || "Uncategorized";
      // Default OFF for agent creates: worker prefix often looks synthetic; opt-in via enable_prefix
      const enablePrefix =
        input.enable_prefix != null
          ? Boolean(input.enable_prefix)
          : input.enablePrefix != null
            ? Boolean(input.enablePrefix)
            : false;
      const payload = { enablePrefix, name };
      if (domain) payload.domain = domain;
      const data = await workerRequest(cfg, "/admin/new_address", {
        method: "POST",
        body: payload,
        signal,
      });
      let newEmail = "";
      let token = null;
      if (data && typeof data === "object") {
        newEmail = String(data.email || data.address || "")
          .trim()
          .toLowerCase();
        token = data.token || data.jwt || null;
      }
      if (!newEmail) {
        return {
          ok: false,
          error: "Worker returned no email",
          data,
        };
      }
      await upsertAddress(root, newEmail, "manual", {
        created_at: new Date().toISOString(),
        token,
        category,
      });
      return {
        ok: true,
        email: newEmail,
        category,
        token: token || undefined,
        note: "Use this email in the form. After the site sends mail, call cf_mail action=wait email=… (poll — do not single-shot).",
      };
    }

    if (action === "delete") {
      if (!email) throw new Error("email is required for delete");
      const list = await loadAddresses(root);
      await saveAddresses(
        root,
        list.filter((a) => a.email !== email)
      );
      let remoteOk = false;
      let remoteError = null;
      try {
        const cfg = await requireConfig(root);
        try {
          await workerRequest(cfg, "/admin/delete_address", {
            method: "POST",
            body: { address: email },
            signal,
          });
          remoteOk = true;
        } catch (e1) {
          if (isAbortError(e1)) throw e1;
          try {
            await workerRequest(cfg, `/admin/address/${encodeURIComponent(email)}`, {
              method: "DELETE",
              signal,
            });
            remoteOk = true;
          } catch (e2) {
            if (isAbortError(e2)) throw e2;
            remoteError = String(e1?.message || e1);
          }
        }
      } catch (e) {
        if (isAbortError(e)) throw e;
        remoteError = String(e?.message || e);
      }
      return { ok: true, email, remoteOk, remoteError };
    }

    if (action === "inbox") {
      if (!email) throw new Error("email is required for inbox");
      const cfg = await requireConfig(root);
      const limit = clampInt(input.limit, 1, 100, 20);
      const mails = sortMailsNewestFirst(
        await fetchAllMails(cfg, email, { max: Math.max(limit, 50), signal })
      );
      const filter = {
        subject_includes: input.subject_includes || input.subject,
        from_includes: input.from_includes || input.from,
        body_includes: input.body_includes || input.contains,
      };
      const summaries = [];
      for (const m of mails) {
        const s = summarizeMail(m, { maxChars: 800 });
        if (!mailMatchesFilter(s, filter)) continue;
        summaries.push({
          id: s.id,
          from: s.from,
          to: s.to,
          subject: s.subject,
          created_at: s.created_at,
          preview: (s.text || "").slice(0, 240),
          otp_guess: s.otp_guess,
        });
        if (summaries.length >= limit) break;
      }
      return {
        ok: true,
        email,
        count: summaries.length,
        mails: summaries,
        note:
          summaries.length === 0
            ? "Empty inbox right now. If you just triggered a send, use action=wait (poll) — do not give up after one empty list."
            : "Use get mail_id=… for full body, or wait if expecting a newer message.",
      };
    }

    if (action === "get") {
      const cfg = await requireConfig(root);
      const mailId = String(input.mail_id || input.id || input.message_id || "").trim();
      if (mailId) {
        let listed = null;
        if (email) {
          const mails = await fetchAllMails(cfg, email, { max: 100, signal });
          listed = mails.find((m) => String(m.id) === String(mailId)) || null;
        }
        let detail = null;
        try {
          detail = await fetchMailDetail(cfg, mailId, { signal });
        } catch (err) {
          if (isAbortError(err)) throw err;
        }
        const merged = mergeMail(listed || { id: mailId }, detail || {});
        const summary = await enrichMail(cfg, merged, { signal });
        return { ok: true, mail: summary };
      }
      if (!email) throw new Error("mail_id or email is required for get");
      const mails = sortMailsNewestFirst(await fetchAllMails(cfg, email, { max: 30, signal }));
      if (!mails.length) {
        return {
          ok: false,
          empty: true,
          email,
          error: "No messages yet. Use action=wait to poll.",
        };
      }
      const summary = await enrichMail(cfg, mails[0], { signal });
      return { ok: true, mail: summary, note: "Latest message (no mail_id given)." };
    }

    if (action === "wait") {
      if (!email) throw new Error("email is required for wait");
      const cfg = await requireConfig(root);
      const timeoutSec = clampInt(
        input.timeout_sec ?? input.timeoutSec,
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC,
        DEFAULT_TIMEOUT_SEC
      );
      const pollMs = clampInt(input.poll_ms ?? input.pollMs, MIN_POLL_MS, MAX_POLL_MS, DEFAULT_POLL_MS);
      const deadline = Date.now() + timeoutSec * 1000;
      const known = new Set(
        (Array.isArray(input.known_ids) ? input.known_ids : [])
          .map((x) => String(x))
          .filter(Boolean)
      );
      if (input.after_id != null && input.after_id !== "") known.add(String(input.after_id));
      const onlyNew =
        input.only_new === true ||
        input.onlyNew === true ||
        String(input.mode || "").toLowerCase() === "only_new";

      const filter = {
        subject_includes: input.subject_includes || input.subject,
        from_includes: input.from_includes || input.from,
        body_includes: input.body_includes || input.contains,
      };

      let seededOnlyNew = !onlyNew || known.size > 0;
      let attempts = 0;
      let lastCount = 0;
      let consecutiveErrors = 0;
      let lastError = null;
      const startedAt = Date.now();

      const stoppedResult = () => ({
        ok: false,
        received: false,
        stopped: true,
        email,
        waited_ms: Date.now() - startedAt,
        attempts,
        error: "Stopped by user",
      });

      const apiFailResult = () => ({
        ok: false,
        received: false,
        api_error: true,
        email,
        waited_ms: Date.now() - startedAt,
        attempts,
        consecutive_errors: consecutiveErrors,
        error:
          `CF Worker API failed ${consecutiveErrors} time(s): ${lastError}. ` +
          "Fail-fast (not hanging). Check Runtime Mail config / network, then retry.",
      });

      const requestTimeoutMs = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return 1;
        return Math.max(1000, Math.min(WORKER_FETCH_TIMEOUT_MS, remaining));
      };

      while (Date.now() < deadline) {
        if (signal?.aborted) return stoppedResult();
        attempts += 1;
        let mails;
        try {
          mails = sortMailsNewestFirst(
            await fetchAllMails(cfg, email, {
              max: 80,
              signal,
              timeoutMs: requestTimeoutMs(),
            })
          );
          consecutiveErrors = 0;
          lastError = null;
        } catch (err) {
          if (isAbortError(err)) return stoppedResult();
          consecutiveErrors += 1;
          lastError = String(err?.message || err);
          const hardFail =
            err?.code === "timeout" ||
            consecutiveErrors >= WAIT_MAX_CONSECUTIVE_ERRORS ||
            deadline - Date.now() < 1000;
          if (hardFail) return apiFailResult();
          const remainingAfterErr = deadline - Date.now();
          if (remainingAfterErr <= 0) break;
          try {
            await sleep(Math.min(pollMs, remainingAfterErr), signal);
          } catch (sleepErr) {
            if (isAbortError(sleepErr)) return stoppedResult();
            throw sleepErr;
          }
          continue;
        }
        lastCount = mails.length;

        if (onlyNew && !seededOnlyNew) {
          for (const m of mails) {
            if (m?.id != null) known.add(String(m.id));
          }
          seededOnlyNew = true;
        } else {
          for (const m of mails) {
            const id = m?.id != null ? String(m.id) : "";
            if (id && known.has(id)) continue;
            const summary = await enrichMail(cfg, m, { signal });
            if (!mailMatchesFilter(summary, filter)) {
              if (onlyNew && id) known.add(id);
              continue;
            }
            return {
              ok: true,
              received: true,
              email,
              waited_ms: Date.now() - startedAt,
              attempts,
              mail: summary,
              note: summary.otp_guess
                ? `Likely OTP/code: ${summary.otp_guess} — use it in the form (do not ask the human).`
                : "Mail received — check text/links for verification.",
            };
          }
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          await sleep(Math.min(pollMs, remaining), signal);
        } catch (sleepErr) {
          if (isAbortError(sleepErr)) return stoppedResult();
          throw sleepErr;
        }
      }

      if (!lastError && Date.now() < deadline + 50) {
        try {
          const mails = sortMailsNewestFirst(
            await fetchAllMails(cfg, email, {
              max: 40,
              signal,
              timeoutMs: Math.min(3000, Math.max(1000, deadline - Date.now() + 500)),
            })
          );
          lastCount = mails.length;
          for (const m of mails) {
            const id = m?.id != null ? String(m.id) : "";
            if (id && known.has(id)) continue;
            const summary = await enrichMail(cfg, m, { signal });
            if (!mailMatchesFilter(summary, filter)) continue;
            return {
              ok: true,
              received: true,
              email,
              waited_ms: Date.now() - startedAt,
              attempts: attempts + 1,
              mail: summary,
              note: summary.otp_guess
                ? `Likely OTP/code: ${summary.otp_guess} — use it in the form (do not ask the human).`
                : "Mail received — check text/links for verification.",
            };
          }
        } catch (err) {
          if (isAbortError(err)) return stoppedResult();
          if (!lastError) lastError = String(err?.message || err);
        }
      }

      if (lastError && lastCount === 0) return apiFailResult();

      return {
        ok: false,
        received: false,
        empty: lastCount === 0,
        email,
        waited_ms: Date.now() - startedAt,
        attempts,
        inbox_count: lastCount,
        last_error: lastError || undefined,
        error:
          lastCount > 0
            ? `Inbox has ${lastCount} message(s) but none matched filters / known_ids within ${timeoutSec}s. ` +
              "Call inbox or get without filters, or pass different after_id/known_ids."
            : `No mail within ${timeoutSec}s (polled every ~${pollMs}ms). ` +
              "Site may still be sending — retry wait with longer timeout_sec.",
        tip: "Do not invent OTP. Prefer wait (not single inbox). If mail already arrived, wait returns it unless only_new/known_ids exclude it.",
      };
    }

    throw new Error(
      `Unknown cf_mail action: ${action}. Use create|list|inbox|get|wait|delete|status.`
    );
  },
};
