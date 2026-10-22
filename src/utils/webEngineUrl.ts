/**
 * Address bar input → a URL for the Web Engine.
 *
 * The engine is for local projects first, so localhost / 127.0.0.1 / any
 * host-with-port defaults to http://; a bare host without a port (a public site)
 * defaults to https://. Anything else is rejected at this boundary so the rest
 * of the workspace only ever sees a valid URL.
 */
export function normalizeUrl(raw: string): string | null {
  const input = String(raw || "").trim();
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^\/\//.test(input)) {
    const rest = input.slice(2);
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i.test(rest);
    return `${local ? "http" : "https"}:${input}`;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i.test(input)) return `http://${input}`;
  // host with a port → dev server; host without a port → public site.
  if (!/\s/.test(input) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(input)) {
    return /:\d+/.test(input) ? `http://${input}` : `https://${input}`;
  }
  return null;
}
