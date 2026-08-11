import { parseArgs } from "node:util";

const PROFILES = {
  quick: ["get-ip", "status", "headers", "dns"],
  standard: [
    "get-ip",
    "status",
    "headers",
    "dns",
    "ssl",
    "whois",
    "tech-stack",
    "redirects",
    "http-security",
    "hsts",
  ],
  security: [
    "get-ip",
    "status",
    "headers",
    "dns",
    "dnssec",
    "ssl",
    "tls-connection",
    "http-security",
    "hsts",
    "cookies",
    "threats",
    "ports",
    "firewall",
    "security-txt",
    "mail-config",
    "whois",
  ],
  full: [
    "get-ip",
    "status",
    "headers",
    "dns",
    "dns-server",
    "dnssec",
    "ssl",
    "tls-connection",
    "whois",
    "tech-stack",
    "redirects",
    "http-security",
    "hsts",
    "cookies",
    "threats",
    "ports",
    "firewall",
    "security-txt",
    "mail-config",
    "location",
    "rank",
    "robots-txt",
    "sitemap",
    "social-tags",
    "txt-records",
    "block-lists",
    "quality",
    "carbon",
    "linked-pages",
  ],
};

const DEFAULT_BASE = "https://web-check.as93.net/api";
const FETCH_TIMEOUT_MS = 45000;

function normalizeBase(raw) {
  const s = String(raw || DEFAULT_BASE).trim().replace(/\/+$/, "");
  return s || DEFAULT_BASE;
}

function parseChecks(raw) {
  if (raw == null || raw === "") return null;
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || "").trim()).filter(Boolean);
  }
  const text = String(raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x || "").trim()).filter(Boolean);
    }
  } catch {
  }
  return text
    .split(/[,|\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickChecks(profile, checksRaw) {
  const explicit = parseChecks(checksRaw);
  if (explicit && explicit.length) {
    return { profile: "custom", checks: explicit };
  }
  const key = String(profile || "standard")
    .trim()
    .toLowerCase();
  if (PROFILES[key]) return { profile: key, checks: PROFILES[key] };
  return { profile: "standard", checks: PROFILES.standard };
}

async function fetchCheck(base, check, target) {
  const endpoint = `${base}/${check}?url=${encodeURIComponent(target)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(endpoint, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json,text/plain,*/*",
        "User-Agent": "Mozilla/5.0 (compatible; WebCheck/1.0; Lopster)",
      },
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {
    }
    return {
      check,
      endpoint,
      ok: res.ok,
      status: res.status,
      data,
    };
  } catch (err) {
    return {
      check,
      endpoint,
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function cleanStr(v) {
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || s === "undefined" || s === "null") return "";
  if (s.startsWith("--")) return "";
  return s;
}

function loadPayload(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object") return raw;
  const text = String(raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      url: { type: "string", short: "u" },
      profile: { type: "string", short: "p" },
      checks: { type: "string", short: "c" },
      base: { type: "string", short: "b" },
      base_url: { type: "string" },
      payload: { type: "string" },
      json: { type: "string", short: "j" },
    },
    allowPositionals: true,
    strict: false,
  });

  const payload = loadPayload(values.payload || values.json) || {};
  const target = cleanStr(
    payload.url || values.url || positionals[0] || process.env.WEB_CHECK_URL
  );
  if (!target) {
    console.error(JSON.stringify({ ok: false, error: "url is required" }));
    process.exit(1);
  }

  const profileIn =
    cleanStr(payload.profile || values.profile || positionals[1]) || "standard";
  let checksIn = null;
  if (payload.checks != null && payload.checks !== "") {
    checksIn = payload.checks;
  } else if (cleanStr(values.checks)) {
    checksIn = values.checks;
  } else if (cleanStr(positionals[2])) {
    checksIn = positionals[2];
  }
  const base = normalizeBase(
    cleanStr(payload.base_url || payload.base || values.base_url || values.base) ||
      DEFAULT_BASE
  );
  const { profile, checks } = pickChecks(profileIn, checksIn);

  const results = [];
  for (const check of checks) {
    results.push(await fetchCheck(base, check, target));
  }

  const out = {
    ok: true,
    source: "web-check",
    target,
    base,
    profile,
    checks,
    results,
    report_ui: `https://web-check.xyz/check/${encodeURIComponent(target)}`,
  };
  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
