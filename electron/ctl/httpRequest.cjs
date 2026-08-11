const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 180000;
const MAX_BODY_CHARS = 500000;
const MAX_TEXT_CHARS = 200000;

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function buildUrl(url, query) {
  const base = String(url || "").trim();
  if (!base) throw new Error("http requires url");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`Invalid URL: ${base}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  if (query == null) return parsed.toString();
  if (typeof query === "string" && query.trim()) {
    const q = query.trim().replace(/^\?/, "");
    parsed.search = parsed.search ? `${parsed.search}&${q}` : `?${q}`;
    return parsed.toString();
  }
  if (isPlainObject(query)) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        for (const item of v) parsed.searchParams.append(k, String(item));
      } else {
        parsed.searchParams.set(k, String(v));
      }
    }
  }
  return parsed.toString();
}

function normalizeHeaders(raw) {
  const out = {};
  if (!raw) return out;
  if (isPlainObject(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      out[String(k)] = String(v);
    }
    return out;
  }
  return out;
}

function encodeBody(input, headers) {
  if (input == null) return { body: undefined, headers };
  if (Buffer.isBuffer(input)) return { body: input, headers };
  if (typeof input === "string") return { body: input, headers };
  if (isPlainObject(input) || Array.isArray(input)) {
    const next = { ...headers };
    if (!Object.keys(next).some((k) => k.toLowerCase() === "content-type")) {
      next["Content-Type"] = "application/json; charset=utf-8";
    }
    return { body: JSON.stringify(input), headers: next };
  }
  return { body: String(input), headers };
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function tryParseJson(text) {
  if (text == null) return undefined;
  const s = String(text).trim();
  if (!s) return undefined;
  if (!(s.startsWith("{") || s.startsWith("["))) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function truncateText(text, max) {
  const s = text == null ? "" : String(text);
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

async function httpRequest(raw = {}) {
  const method = String(raw.method || raw.verb || "GET")
    .trim()
    .toUpperCase() || "GET";
  const url = buildUrl(raw.url || raw.uri || raw.endpoint, raw.query != null ? raw.query : raw.params);
  let headers = normalizeHeaders(raw.headers || raw.header);

  let bodySource = raw.body;
  if (bodySource == null && raw.json != null) bodySource = raw.json;
  if (bodySource == null && raw.data != null) bodySource = raw.data;
  if (bodySource == null && raw.form != null && isPlainObject(raw.form)) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(raw.form)) {
      if (v == null) continue;
      form.set(k, String(v));
    }
    bodySource = form.toString();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    }
  }

  const encoded = encodeBody(bodySource, headers);
  headers = encoded.headers;
  const body = encoded.body;

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, Number(raw.timeout_ms ?? raw.timeoutMs ?? raw.timeout) || DEFAULT_TIMEOUT_MS)
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      signal: controller.signal,
      redirect: raw.redirect === "manual" ? "manual" : "follow",
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (/aborted|AbortError/i.test(msg)) {
      throw new Error(`HTTP timeout after ${timeoutMs}ms: ${method} ${url}`);
    }
    throw new Error(`HTTP request failed: ${method} ${url} — ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const headerObj = headersToObject(response.headers);
  const contentType = headerObj["content-type"] || headerObj["Content-Type"] || "";
  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS);
  }
  const clipped = truncateText(text, Number(raw.max_chars) || MAX_TEXT_CHARS);
  const wantJson =
    raw.parse === "json" ||
    raw.json === true ||
    /application\/json|text\/json|\+json/i.test(contentType) ||
    raw.as === "json";
  let json;
  if (wantJson || raw.parse !== "text") {
    json = tryParseJson(clipped.text);
  }

  const ok =
    raw.ok_status != null
      ? Number(response.status) === Number(raw.ok_status)
      : response.status >= 200 && response.status < 300;

  const result = {
    ok,
    status: response.status,
    statusText: response.statusText || "",
    url: response.url || url,
    requestUrl: url,
    method,
    headers: headerObj,
    contentType,
    text: clipped.text,
    truncated: clipped.truncated,
    length: text.length,
    json: json !== undefined ? json : null,
  };

  if (raw.throw_http === true && !ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText || ""}: ${method} ${url}`.trim());
  }
  return result;
}

module.exports = {
  httpRequest,
  buildUrl,
  tryParseJson,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
