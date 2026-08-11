const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const SEARCH_URL = "https://www.shodan.io/search/facet";
const INTERNET_DB_URL = "https://internetdb.shodan.io";
// This is a request ceiling, not a promise that an unauthenticated Shodan facet
// response contains that many distinct hosts. We never fabricate missing results.
const MAX_LIMIT = 5000;

function normalizeQuery(query) {
  const raw = String(query || "")
    .trim()
    .replaceAll("http.body:", "http.html:")
    .replaceAll("service.port:", "port:")
    // The public facet endpoint does not honor http.server banners, but it does
    // index product CPEs — banner searches map to the closest supported field.
    .replaceAll("http.server:", "product:");
  // Match the source scanner's convenient free-text behavior: independent words
  // become Shodan HTML terms, while native Shodan filters/operators remain intact.
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return tokens.map((token) => {
    const lower = token.toLowerCase();
    if (["and", "or", "not", "&&", "||", "-"].includes(lower) || token.includes(":")) return token;
    const value = token.replace(/^"|"$/g, "");
    return value ? `http.html:"${value.replaceAll('"', "")}"` : "";
  }).filter(Boolean).join(" ");
}

function splitOr(query) {
  return query.split(/\s+OR\s+/i).map((part) => part.trim()).filter(Boolean);
}

// The original scanner runs several content markers independently because the
// public facet endpoint is unreliable with compound HTML expressions. Preserve
// that behavior: `"airwallex" "api_key"` yields the union of both marker sets.
function publicFacetQueries(query) {
  const htmlTerms = query.match(/http\.html:"[^"]*"/gi) || [];
  return htmlTerms.length > 1 ? htmlTerms : splitOr(query);
}

function quotedValues(query, field) {
  const values = [];
  const re = new RegExp(`${field}:"([^"]*)"`, "gi");
  let match;
  while ((match = re.exec(query))) values.push(match[1]);
  return values;
}

// Build the full facet query plan for a normalized query.
// 1) Base queries exactly like the source scanner.
// 2) org:"X" is NOT honored by the facet endpoint → emulate it with hostname,
//    certificate CN/O and html marker queries so an organization's infra can
//    still be surfaced (Airwallex → hostname/ssl.cert.subject.CN:).
// 3) Bare text markers only match http.html — expand every html marker value to
//    hostname: and ssl.cert.subject.CN: queries so hostnames/CNs are found too.
function planQueries(normalized) {
  const queries = [];
  const add = (q) => {
    const clean = String(q || "").trim();
    if (clean && !queries.includes(clean)) queries.push(clean);
  };
  for (const base of publicFacetQueries(normalized)) add(base);
  const markerValues = quotedValues(normalized, "http\\.html");
  for (const value of markerValues.slice(0, 12)) {
    add(`hostname:"${value}"`);
    add(`ssl.cert.subject.CN:"${value}"`);
  }
  for (const org of quotedValues(normalized, "org").slice(0, 6)) {
    add(`hostname:"${org}"`);
    add(`ssl.cert.subject.CN:"${org}"`);
    add(`ssl.cert.subject.O:"${org}"`);
    add(`http.html:"${org}"`);
  }
  return queries;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function runCurl(url, signal, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "-sS", "--compressed", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      url,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener?.("abort", abort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener?.("abort", abort);
      if (signal?.aborted) return reject(new Error("Stopped by user"));
      if (code !== 0) return reject(new Error(stderr.trim() || `curl exit ${code}`));
      resolve(stdout);
    });
  });
}

function extractIps(html) {
  const found = new Set();
  const encoded = /ip%3A%22(\d{1,3}(?:\.\d{1,3}){3})%22/g;
  const plain = /(?:^|[?&"'])ip:(\d{1,3}(?:\.\d{1,3}){3})(?:[&"']|$)/g;
  for (const re of [encoded, plain]) {
    let match;
    while ((match = re.exec(html))) found.add(match[1]);
  }
  return [...found];
}

async function fetchFacet(query, signal) {
  const url = `${SEARCH_URL}?query=${encodeURIComponent(query)}&facet=ip`;
  const html = await runCurl(url, signal);
  return extractIps(html);
}

async function lookupTitle(ip, ports, signal) {
  const candidates = (ports || []).filter((port) => [80, 443, 8080, 8443, 8000, 3000, 5000].includes(Number(port))).slice(0, 2);
  for (const port of candidates) {
    for (const protocol of port === 443 || port === 8443 ? ["https", "http"] : ["http", "https"]) {
      try {
        // A bounded request prevents one dead host from stalling a large 5K run.
        const timeout = AbortSignal.timeout(8000);
        const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const response = await fetch(`${protocol}://${ip}:${port}`, { signal: requestSignal, redirect: "follow", headers: { "User-Agent": "ComposeVC-TitleCheck/1.0" } });
        const html = (await response.text()).slice(0, 180000);
        const match = html.match(/<title[^>]*>\s*([\s\S]{1,300}?)\s*<\/title>/i);
        if (match) return match[1].replace(/\s+/g, " ").trim();
      } catch { /* unavailable service is simply left without a title */ }
    }
  }
  return "";
}

async function enrichHost(ip, signal) {
  try {
    const response = await fetch(`${INTERNET_DB_URL}/${encodeURIComponent(ip)}`, {
      signal,
      headers: { Accept: "application/json", "User-Agent": "ComposeVC-Shodan/1.0" },
    });
    if (!response.ok) return { ip, ports: [], hostnames: [], cpes: [], vulns: [], tags: [], source: "SHODAN" };
    const data = await response.json();
    return {
      ip,
      ports: Array.isArray(data.ports) ? data.ports : [],
      hostnames: Array.isArray(data.hostnames) ? data.hostnames : [],
      cpes: Array.isArray(data.cpes) ? data.cpes : [],
      vulns: Array.isArray(data.vulns) ? data.vulns : [],
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: "SHODAN + InternetDB",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ip, ports: [], hostnames: [], cpes: [], vulns: [], tags: [], source: "SHODAN" };
  }
}

async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

async function search(input = {}, context = {}) {
  const query = normalizeQuery(input.query ?? input.q);
  if (!query) throw new Error("query is required");
  const limit = Math.max(1, Math.min(MAX_LIMIT, Number(input.limit ?? input.target ?? 100) || 100));
  const warnings = [];
  const verifyTitles = input.verify_titles !== false && input.verifyTitles !== false;
  const parts = planQueries(query);
  const seen = new Set();
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    try {
      const ips = await fetchFacet(part, context.signal);
      for (const ip of ips) {
        if (seen.size >= limit) break;
        seen.add(ip);
      }
    } catch (error) {
      warnings.push(`${part.slice(0, 80)}: ${error.message || error}`);
    }
    if (seen.size >= limit) break;
    if (index < parts.length - 1) await sleep(700);
  }
  const hosts = await mapPool([...seen], Math.min(12, Math.max(1, Number(input.concurrency) || 8)), (ip) => enrichHost(ip, context.signal));
  if (verifyTitles) {
    await mapPool(hosts, Math.min(12, Math.max(1, Number(input.concurrency) || 8)), async (host) => {
      host.title = await lookupTitle(host.ip, host.ports, context.signal);
      return host;
    });
  }
  const result = { ok: true, query, limit, count: hosts.length, hosts, warnings, queries: parts, fetchedAt: new Date().toISOString(), verifiedTitles: verifyTitles, note: "Public Shodan facet discovery with InternetDB metadata; no Shodan API key is used. Titles are verified by default only on already-returned HTTP(S) services." };
  // Persist every completed search so the AI always knows where results live.
  const userDataPath = context.userDataPath || context.toolContext?.userDataPath || null;
  if (userDataPath) {
    try {
      const dir = path.join(userDataPath, "shodan-results");
      await fs.promises.mkdir(dir, { recursive: true });
      const slug = (input.query ?? input.q ?? "shodan").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "shodan";
      const filePath = path.join(dir, `${slug}-${Date.now()}.json`);
      await fs.promises.writeFile(filePath, JSON.stringify({ ...result, savedAt: new Date().toISOString() }, null, 2), "utf8");
      result.savedPath = filePath;
      result.savedDir = dir;
    } catch { /* persistence is best-effort; search results remain in the response */ }
  }
  return result;
}

module.exports = {
  name: "shodan",
  description: "Keyless Shodan search: public Shodan facet endpoint plus InternetDB enrichment—no API key. Accepts native Shodan filters (org:, port:, product:, hostname:, ssl:, net:), quoted markers, multiple markers and OR branches; http.server: maps to product:. org:\"X\" is emulated via hostname:/ssl.cert.subject.CN:/html marker queries, and bare markers are also searched against hostname:/cert CN fields. Requested limit 1–5000. Returns per-host ports, hostnames, CPEs, tags, vulnerabilities and verified titles (default on). Every completed search is saved to <userData>/shodan-results/<query>-<ts>.json and the result includes savedPath/savedDir so follow-up work always knows where the JSON lives.",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Shodan query: native filters (org:\"Airwallex\", port:3000, product:\"nginx\", hostname:\"awx.im\", ssl.cert.subject.CN:\"...\"), quoted markers (\"airwallex\" \"sk_\"), and OR branches. org: is emulated; bare text also matches hostnames and cert CNs." },
      q: { type: "string", description: "Alias of query" },
      limit: { type: "number", description: "Requested maximum unique IPs to return, 1–5000 (default 100)" },
      target: { type: "number", description: "Alias of limit" },
      concurrency: { type: "number", description: "InternetDB/title-check workers, 1–12 (default 8)" },
      verify_titles: { type: "boolean", description: "Verify titles for already-returned HTTP(S) services. Default true; set false to skip." },
      verifyTitles: { type: "boolean", description: "Alias of verify_titles" },
    },
    required: ["query"],
  },
  execute: search,
};
