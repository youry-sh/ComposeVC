const cheerio = require("cheerio");
const { spawn } = require("child_process");
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");

// `impers` (Node binding for curl-impersonate, same lineage as Python's curl_cffi) is
// ESM-only, so it must be loaded via dynamic import from this CommonJS file. The import
// is cached — the underlying native curl-impersonate library is downloaded/loaded once
// per process, not once per search.
let impersPromise = null;
function loadImpers() {
  if (!impersPromise) impersPromise = import("impers");
  return impersPromise;
}

// Agent-Reach web search backend: Exa semantic search served through the free public
// Exa MCP endpoint (https://mcp.exa.ai/mcp) via mcporter (no API key needed).
// mcporter is a Node CLI — we spawn its dist/cli.js directly with `node` to avoid
// shell quoting issues on Windows and keep argument passing exact.
let mcporterCliPromise = null;
function resolveMcporterCli() {
  if (mcporterCliPromise) return mcporterCliPromise;
  mcporterCliPromise = (async () => {
    const candidates = [];
    const npmRoot = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "mcporter", "dist", "cli.js")
      : null;
    if (npmRoot) candidates.push(npmRoot);
    candidates.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules", "mcporter", "dist", "cli.js"));
    candidates.push("/usr/local/lib/node_modules/mcporter/dist/cli.js");
    candidates.push("/usr/lib/node_modules/mcporter/dist/cli.js");
    for (const candidate of candidates) {
      try {
        await import("fs").then((fs) => fs.promises.access(candidate));
        return candidate;
      } catch {
        // try next candidate
      }
    }
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile("npm", ["root", "-g"], { timeout: 10000, windowsHide: true }, (err, so) =>
          err ? reject(err) : resolve({ stdout: so })
        );
      });
      const root = stdout.trim();
      if (root) {
        const candidate = path.join(root, "mcporter", "dist", "cli.js");
        await import("fs").then((fs) => fs.promises.access(candidate));
        return candidate;
      }
    } catch {
      // npm lookup failed — Exa backend simply unavailable
    }
    return null;
  })();
  return mcporterCliPromise;
}

// Exa MCP returns a single text block shaped like:
//   Title: ...\nURL: ...\nPublished: ...\nAuthor: ...\nHighlights:\n...\n\nTitle: ...
// Split on "Title: " boundaries and normalize to the same { title, url, snippet } shape.
function parseExaText(text) {
  const results = [];
  let current = null;
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("Title: ")) {
      if (current && current.url) results.push(current);
      current = { title: line.slice(7).trim(), url: null, published: null, author: null, highlights: [] };
    } else if (current) {
      if (line.startsWith("URL: ")) current.url = line.slice(5).trim();
      else if (line.startsWith("Published: ")) current.published = line.slice(11).trim();
      else if (line.startsWith("Author: ")) current.author = line.slice(8).trim();
      else if (line.startsWith("Highlights:")) current.inHighlights = true;
      else if (current.inHighlights && line.trim()) current.highlights.push(line.trim());
    }
  }
  if (current && current.url) results.push(current);
  return results.map((r) => ({
    title: r.title,
    url: r.url,
    snippet:
      r.highlights.slice(0, 6).join(" ").slice(0, 500) ||
      (r.published ? `Published: ${r.published}` : ""),
  }));
}

async function searchExa(query, maxResults) {
  const cli = await resolveMcporterCli();
  if (!cli) return [];
  const result = await new Promise((resolve, reject) => {
    const cp = spawn(
      process.execPath,
      [cli, "call", "exa.web_search_exa", `query=${query}`, `numResults=${maxResults}`, "--output", "json"],
      { timeout: 60000, windowsHide: true }
    );
    let out = "";
    cp.stdout.on("data", (d) => (out += d));
    cp.stderr.on("data", (d) => (out += d));
    cp.on("error", reject);
    cp.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`mcporter exit ${code}`))));
  });
  const start = result.indexOf("{");
  if (start < 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(result.slice(start));
  } catch {
    return [];
  }
  const text = parsed.content && parsed.content[0] && parsed.content[0].text ? parsed.content[0].text : "";
  return parseExaText(text);
}

const DEFAULT_MAX_RESULTS = 8;
const MAX_MAX_RESULTS = 15;
const REQUEST_TIMEOUT_SECONDS = 15;

function decodeDuckDuckGoUrl(href) {
  if (!href) return null;
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

function absoluteUrl(href, base) {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(impers, query, maxResults) {
  const response = await impers.get("https://html.duckduckgo.com/html/", {
    impersonate: "chrome",
    params: { q: query },
    timeout: REQUEST_TIMEOUT_SECONDS,
  });
  if (!response.ok) return [];

  const $ = cheerio.load(response.text);
  const results = [];

  $(".result").each((_, el) => {
    if (results.length >= maxResults) return;
    const link = $(el).find(".result__a").first();
    const title = link.text().trim();
    const url = decodeDuckDuckGoUrl(link.attr("href"));
    const snippet = $(el).find(".result__snippet").text().trim();
    if (title && url) results.push({ title, url, snippet });
  });

  return results;
}

async function searchBing(impers, query, maxResults) {
  const response = await impers.get("https://www.bing.com/search", {
    impersonate: "chrome",
    params: { q: query },
    timeout: REQUEST_TIMEOUT_SECONDS,
  });
  if (!response.ok) return [];

  const $ = cheerio.load(response.text);
  const results = [];

  $("li.b_algo").each((_, el) => {
    if (results.length >= maxResults) return;
    const link = $(el).find("h2 a").first();
    const title = link.text().trim();
    const url = absoluteUrl(link.attr("href"), "https://www.bing.com");
    const snippet = $(el).find(".b_caption p").first().text().trim();
    if (title && url) results.push({ title, url, snippet });
  });

  return results;
}

module.exports = {
  name: "web_search",
  description:
    "Search the web and return a clean list of results (title, url, snippet). Engines tried in order: " +
    "DuckDuckGo, Bing, then Exa semantic search via Agent-Reach (mcporter MCP, free, no API key) when the " +
    "classic engines return nothing. Formulate your own concise search query based on what you need to find " +
    "out — don't just paste the user's whole message. Use this when you need current information, " +
    "documentation, or facts not available in the codebase. Follow up with 'web_fetch' on a promising result " +
    "URL to read the full page content.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (write your own — keep it short and specific)" },
      max_results: { type: "number", description: `Max results to return (default ${DEFAULT_MAX_RESULTS}, capped at ${MAX_MAX_RESULTS})` },
    },
    required: ["query"],
  },
  async execute(input) {
    const query = (input?.query || "").trim();
    if (!query) {
      throw new Error("'query' is required");
    }
    const maxResults = Math.min(Math.max(Number(input.max_results) || DEFAULT_MAX_RESULTS, 1), MAX_MAX_RESULTS);

    const impers = await loadImpers();

    let results = [];
    let engine = "duckduckgo";
    try {
      results = await searchDuckDuckGo(impers, query, maxResults);
    } catch {
      results = [];
    }

    if (results.length === 0) {
      engine = "bing";
      try {
        results = await searchBing(impers, query, maxResults);
      } catch (error) {
        throw new Error(`Web search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (results.length === 0) {
      engine = "exa-agent-reach";
      try {
        results = await searchExa(query, maxResults);
      } catch {
        results = [];
      }
    }

    return { query, engine, resultCount: results.length, results };
  },
  searchExa,
};
