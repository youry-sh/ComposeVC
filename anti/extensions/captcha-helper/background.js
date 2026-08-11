// ANTI captcha helper — solve via local anti-ui + auto-apply without manual Reload click.
const API_BASES = ["http://127.0.0.1:8787", "http://localhost:8787"];
const softReloaded = new Set(); // tabId once per SW life — clear banner state

async function api(path, opts) {
  let lastErr;
  for (const base of API_BASES) {
    try {
      const r = await fetch(base + path, {
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
      const t = await r.text();
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        j = { raw: t };
      }
      if (!r.ok) throw new Error(j.error || j.message || t || r.statusText);
      return j;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("anti-ui unreachable");
}

function isHttpUrl(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function isChallengeUrl(url) {
  if (!isHttpUrl(url)) return false;
  try {
    const u = new URL(url);
    const host = String(u.hostname || "").toLowerCase();
    const href = String(url || "");
    if (/(?:^|\.)challenges\.cloudflare\.com$/i.test(host)) return true;
    if (/(?:^|\.)cloudflare\.com$/i.test(host) && /\/cdn-cgi\/challenge|turnstile|challenges\//i.test(href))
      return true;
    if (/(?:google\.com|recaptcha\.net)\/recaptcha\//i.test(href)) return true;
    if (/(?:^|\.)recaptcha\.net$/i.test(host)) return true;
    if (/(?:^|\.)gstatic\.com$/i.test(host) && /recaptcha/i.test(href)) return true;
    if (/(?:^|\.)hcaptcha\.com$/i.test(host)) return true;
    if (/(?:^|\.)newassets\.hcaptcha\.com$/i.test(host)) return true;
    if (/hcaptcha\.com\/captcha/i.test(href)) return true;
    if (/(?:^|\.)stripe\.com$/i.test(host)) return true;
    if (/(?:^|\.)stripe\.network$/i.test(host)) return true;
    if (/(?:^|\.)stripecdn\.com$/i.test(host)) return true;
    if (/(?:^|\.)paypal\.com$/i.test(host)) return true;
    if (/(?:^|\.)paypalobjects\.com$/i.test(host)) return true;
    if (/(?:^|\.)braintreegateway\.com$/i.test(host)) return true;
    if (/(?:^|\.)braintree-api\.com$/i.test(host)) return true;
    if (/(?:^|\.)adyen\.com$/i.test(host)) return true;
    if (/(?:^|\.)adyenpayments\.com$/i.test(host)) return true;
    if (/(?:^|\.)pay\.google\.com$/i.test(host)) return true;
    if (/(?:^|\.)payments\.google\.com$/i.test(host)) return true;
    if (/(?:^|\.)squareup\.com$/i.test(host)) return true;
    if (/(?:^|\.)squarecdn\.com$/i.test(host)) return true;
    if (/(?:^|\.)klarna\.com$/i.test(host)) return true;
    if (/(?:^|\.)klarnacdn\.net$/i.test(host)) return true;
    if (/(?:^|\.)checkout\.com$/i.test(host)) return true;
    if (/(?:^|\.)cardinalcommerce\.com$/i.test(host)) return true;
    if (/3ds|acs\.|secure\.checkout\.visa/i.test(host)) return true;
    return false;
  } catch (_) {
    return /challenges\.cloudflare|recaptcha\.net|google\.com\/recaptcha|hcaptcha\.com|stripe\.com|paypal\.com|braintree|adyen\.com|klarna\.com|checkout\.com|cardinalcommerce/i.test(
      String(url || "")
    );
  }
}

async function injectTab(tabId, frameId, frameUrl) {
  if (tabId == null || tabId < 0) return;
  if (frameUrl && isChallengeUrl(frameUrl)) return;
  // Never allFrames:true — that re-injects into CF/reCAPTCHA/hCaptcha challenge iframes
  // and can break widget render (defineProperty on turnstile, navigator, etc.).
  const target =
    frameId == null || frameId === 0
      ? { tabId, frameIds: [0] }
      : { tabId, frameIds: [frameId] };
  try {
    await chrome.scripting.executeScript({
      target,
      files: ["hook.js"],
      world: "MAIN",
      injectImmediately: true,
    });
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target,
      files: ["content.js"],
      world: "ISOLATED",
      injectImmediately: true,
    });
  } catch (_) {}
}

async function softReloadTab(tabId, url) {
  if (!tabId || softReloaded.has(tabId)) return;
  if (!isHttpUrl(url)) return;
  softReloaded.add(tabId);
  try {
    // One automatic reload applies extension to the page (same as pressing Reload on the banner).
    await chrome.tabs.reload(tabId, { bypassCache: false });
  } catch (_) {
    softReloaded.delete(tabId);
  }
}

async function applyToAllHttpTabs(opts) {
  const doReload = !!(opts && opts.reload);
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !isHttpUrl(tab.url)) continue;
      if (isChallengeUrl(tab.url)) continue;
      await injectTab(tab.id, 0, tab.url);
      if (doReload) await softReloadTab(tab.id, tab.url);
    }
  } catch (_) {}
}

// Fresh navigations — inject ASAP (top frame only; challenge iframes skipped).
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab || !isHttpUrl(tab.url)) return;
  if (isChallengeUrl(tab.url)) return;
  if (info.status === "loading" || info.status === "complete") {
    injectTab(tabId, 0, tab.url);
  }
});

if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (!isHttpUrl(details.url)) return;
    if (isChallengeUrl(details.url)) return;
    // Only top-level document; subframes that are same-origin widgets still get
    // content_scripts from manifest — challenge hosts early-exit in hook/content.
    if (details.frameId !== 0) return;
    injectTab(details.tabId, details.frameId, details.url);
  });
}

// On install/update: inject + soft-reload open pages so user never clicks Reload banner.
chrome.runtime.onInstalled.addListener((details) => {
  const reload = details.reason === "install" || details.reason === "update";
  applyToAllHttpTabs({ reload });
});

chrome.runtime.onStartup.addListener(() => {
  applyToAllHttpTabs({ reload: false });
});

// SW wake — inject only (no mass reload loop).
applyToAllHttpTabs({ reload: false });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "solve") return;
  (async () => {
    try {
      const st = await api("/api/captcha/settings");
      if (!st.ready || !st.enabled || st.auto_solve === false) {
        sendResponse({ ok: false, error: "captcha auto-solve off or not configured" });
        return;
      }
      const task = msg.task || {};
      // Prefer top-level page URL for provider tasks.
      if (_sender && _sender.tab && _sender.tab.url && isHttpUrl(_sender.tab.url)) {
        if (!task.website_url || /recaptcha|hcaptcha|challenges\.cloudflare/i.test(task.website_url)) {
          task.website_url = _sender.tab.url;
        }
      }
      const sol = await api("/api/captcha/solve", {
        method: "POST",
        body: JSON.stringify(task),
      });
      sendResponse({
        ok: true,
        token: sol.token,
        user_agent: sol.user_agent,
        provider: sol.provider,
        elapsed_ms: sol.elapsed_ms,
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});
