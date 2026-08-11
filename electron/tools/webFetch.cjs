const cheerio = require("cheerio");

// Same lazily-cached ESM import as webSearch.cjs — see that file for why.
let impersPromise = null;
function loadImpers() {
  if (!impersPromise) impersPromise = import("impers");
  return impersPromise;
}

const DEFAULT_MAX_CHARS = 6000;
const MAX_MAX_CHARS = 20000;
const REQUEST_TIMEOUT_SECONDS = 15;

// Tags that are never part of the readable content — nav/header/footer/ads/scripts/etc.
const JUNK_SELECTOR =
  "script, style, noscript, svg, form, iframe, nav, header, footer, aside, " +
  "[role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']";

function extractCleanText($) {
  $(JUNK_SELECTOR).remove();

  // Prefer the actual content container when the page marks one, since that skips
  // sidebars/menus that aren't caught by the generic junk selector above.
  const main = $("main, article, [role='main']").first();
  const root = main.length ? main : $("body");

  return root
    .text()
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*(\n[ \t]*)+/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

module.exports = {
  name: "web_fetch",
  description:
    "Fetch a web page by URL and return its clean, readable text content — navigation, headers, footers, " +
    "scripts and other page chrome are stripped out, leaving just the article/main content. Use this after " +
    "'web_search' to actually read a promising result, or whenever you already have a specific URL to check " +
    "(e.g. documentation, an issue tracker link).",
  isReadOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL to fetch, e.g. 'https://example.com/docs/page'" },
      max_chars: { type: "number", description: `Max characters of text to return (default ${DEFAULT_MAX_CHARS}, capped at ${MAX_MAX_CHARS})` },
    },
    required: ["url"],
  },
  async execute(input) {
    const url = (input?.url || "").trim();
    if (!url) {
      throw new Error("'url' is required");
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }

    const maxChars = Math.min(Math.max(Number(input.max_chars) || DEFAULT_MAX_CHARS, 500), MAX_MAX_CHARS);

    const impers = await loadImpers();
    let response;
    try {
      response = await impers.get(url, { impersonate: "chrome", timeout: REQUEST_TIMEOUT_SECONDS });
    } catch (error) {
      throw new Error(`Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}: ${url}`);
    }

    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType && !contentType.includes("html") && !contentType.includes("text")) {
      throw new Error(`Unsupported content type for text extraction: ${contentType}`);
    }

    const $ = cheerio.load(response.text);
    const title = $("title").first().text().trim();
    const fullText = extractCleanText($);
    const truncated = fullText.length > maxChars;
    const text = truncated ? `${fullText.slice(0, maxChars)}\n... (truncated)` : fullText;

    return { url, title, text, truncated, length: fullText.length };
  },
};
