// Isolated world — detect captcha on top page, solve via background, inject token.
(function () {
  if (window.__ANTI_CAPTCHA_CONTENT__) return;

  // reCAPTCHA/hCaptcha/Turnstile challenge iframes must not run helper logic.
  // Solving runs only in the top frame (or same-origin page that owns the widget).
  let isChallengeFrame = false;
  let isPaymentFrame = false;
  try {
    const href = String(location.href || "");
    let host = "";
    try {
      host = String(location.hostname || "").toLowerCase();
    } catch (_) {}
    isChallengeFrame =
      /(?:^|\.)challenges\.cloudflare\.com$/i.test(host) ||
      (/(?:^|\.)cloudflare\.com$/i.test(host) &&
        /\/cdn-cgi\/challenge|turnstile|challenges\//i.test(href)) ||
      /(?:google\.com|recaptcha\.net)\/recaptcha\//i.test(href) ||
      /(?:^|\.)recaptcha\.net$/i.test(host) ||
      (/(?:^|\.)gstatic\.com$/i.test(host) && /recaptcha/i.test(href)) ||
      /(?:^|\.)hcaptcha\.com$/i.test(host) ||
      /(?:^|\.)newassets\.hcaptcha\.com$/i.test(host) ||
      /hcaptcha\.com\/captcha/i.test(href);
    isPaymentFrame =
      /(?:^|\.)stripe\.com$/i.test(host) ||
      /(?:^|\.)stripe\.network$/i.test(host) ||
      /(?:^|\.)stripecdn\.com$/i.test(host) ||
      /(?:^|\.)js\.stripe\.com$/i.test(host) ||
      /(?:^|\.)m\.stripe\.com$/i.test(host) ||
      /(?:^|\.)hooks\.stripe\.com$/i.test(host) ||
      /(?:^|\.)paypal\.com$/i.test(host) ||
      /(?:^|\.)paypalobjects\.com$/i.test(host) ||
      /(?:^|\.)braintreegateway\.com$/i.test(host) ||
      /(?:^|\.)braintree-api\.com$/i.test(host) ||
      /(?:^|\.)adyen\.com$/i.test(host) ||
      /(?:^|\.)adyenpayments\.com$/i.test(host) ||
      /(?:^|\.)pay\.google\.com$/i.test(host) ||
      /(?:^|\.)payments\.google\.com$/i.test(host) ||
      /(?:^|\.)squareup\.com$/i.test(host) ||
      /(?:^|\.)squarecdn\.com$/i.test(host) ||
      /(?:^|\.)klarna\.com$/i.test(host) ||
      /(?:^|\.)klarnacdn\.net$/i.test(host) ||
      /(?:^|\.)checkout\.com$/i.test(host) ||
      /(?:^|\.)cardinalcommerce\.com$/i.test(host) ||
      /3ds|acs\.|secure\.checkout\.visa/i.test(host);
  } catch (_) {}

  if (isChallengeFrame || isPaymentFrame) {
    window.__ANTI_CAPTCHA_CONTENT__ = true;
    return;
  }

  window.__ANTI_CAPTCHA_CONTENT__ = true;

  const solvedKeys = new Set();
  let busy = false;
  let lastErrAt = 0;

  function sitekeyFromDOM() {
    const selectors = [
      ".g-recaptcha[data-sitekey]",
      ".cf-turnstile[data-sitekey]",
      ".h-captcha[data-sitekey]",
      "[data-sitekey]",
      "iframe[src*='recaptcha']",
      "iframe[src*='turnstile']",
      "iframe[src*='hcaptcha']",
      "script[src*='recaptcha'][src*='render=']",
    ];
    for (const sel of selectors) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        const sk = el.getAttribute && el.getAttribute("data-sitekey");
        if (sk && sk.length > 10) return sk;
        if (el.tagName === "IFRAME" && el.src) {
          try {
            const u = new URL(el.src);
            const k = u.searchParams.get("sitekey") || u.searchParams.get("k");
            if (k && k.length > 10) return k;
          } catch (_) {}
        }
        if (el.tagName === "SCRIPT" && el.src) {
          try {
            const u = new URL(el.src);
            const render = u.searchParams.get("render");
            if (render && render !== "explicit" && render.length > 10) return render;
          } catch (_) {}
        }
      }
    }
    // google recaptcha demo hardcode fallback (public demo sitekey)
    if (/google\.com\/recaptcha\/api2\/demo/i.test(location.href)) {
      return "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-";
    }
    return "";
  }

  function detectKind() {
    if (
      document.querySelector(
        ".cf-turnstile, [data-sitekey][class*='turnstile'], iframe[src*='challenges.cloudflare.com']"
      )
    ) {
      return "turnstile";
    }
    if (document.querySelector(".h-captcha, iframe[src*='hcaptcha.com']")) return "hcaptcha";
    if (
      document.querySelector(
        ".g-recaptcha, iframe[src*='recaptcha/api2'], iframe[src*='recaptcha/enterprise'], iframe[src*='recaptcha/api2/anchor']"
      ) ||
      /google\.com\/recaptcha\/api2\/demo/i.test(location.href)
    ) {
      return "recaptcha_v2";
    }
    if (
      document.querySelector("script[src*='recaptcha'][src*='render=']") ||
      document.querySelector("script[src*='recaptcha/api.js']") ||
      window.__ANTI_RECAPTCHA_V3__
    ) {
      return "recaptcha_v3";
    }
    return null;
  }

  function buildTask(extra) {
    const kind = (extra && extra.kind) || detectKind();
    if (!kind) return null;
    const website_key =
      (extra && extra.website_key) ||
      sitekeyFromDOM() ||
      (window.__ANTI_RECAPTCHA_V3__ &&
        (window.__ANTI_RECAPTCHA_V3__.website_key || window.__ANTI_RECAPTCHA_V3__.sitekey)) ||
      "";
    if (!website_key) return null;
    return {
      kind,
      website_url: (extra && extra.website_url) || location.href.split("#")[0],
      website_key,
      action: (extra && extra.action) || "",
      cdata: (extra && extra.cdata) || "",
      pagedata: (extra && extra.pagedata) || "",
      page_action:
        (extra && (extra.page_action || extra.action)) ||
        (window.__ANTI_RECAPTCHA_V3__ && window.__ANTI_RECAPTCHA_V3__.action) ||
        "",
    };
  }

  // Agent policy: do NOT auto-call captcha farm/solver.
  // Lopster agent passes captcha with own CDP mouse clicks (captcha_click / click_at).
  // Extension only injects tokens if something external posts inject, or if
  // window.__ANTI_CAPTCHA_ALLOW_FARM__ === true (manual / allow_farm path).
  async function solveAndInject(task) {
    if (isChallengeFrame) return;
    // Default OFF — agent clicks captcha itself
    if (window.__ANTI_CAPTCHA_ALLOW_FARM__ !== true) {
      return;
    }
    if (window !== window.top) {
      try {
        if (window.top && window.top.location && window.top.location.origin !== location.origin) {
          return;
        }
      } catch (_) {
        return;
      }
    }
    if (!task || !task.website_key) return;
    const key =
      task.kind +
      "|" +
      task.website_key +
      "|" +
      (task.action || "") +
      "|" +
      (task.page_action || "");
    if (solvedKeys.has(key) || busy) return;
    if (Date.now() - lastErrAt < 4000) return;
    busy = true;
    console.info("[anti-captcha] farm solve (ALLOW_FARM)", task.kind, task.website_key.slice(0, 12) + "…");
    try {
      const res = await chrome.runtime.sendMessage({ type: "solve", task });
      if (!res || !res.ok || !res.token) {
        lastErrAt = Date.now();
        console.warn("[anti-captcha]", res && res.error ? res.error : "solve failed");
        return;
      }
      solvedKeys.add(key);
      window.postMessage(
        {
          source: "anti-captcha-content",
          type: "inject",
          kind: task.kind,
          token: res.token,
        },
        "*"
      );
      console.info(
        "[anti-captcha] solved",
        task.kind,
        (res.elapsed_ms || 0) + "ms",
        res.provider || ""
      );
    } catch (e) {
      lastErrAt = Date.now();
      console.warn("[anti-captcha]", e);
    } finally {
      busy = false;
    }
  }

  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.source !== "anti-captcha-hook") return;
    // Store params for agent/tools; do NOT auto-farm
    if (ev.data.type === "turnstile-params" && ev.data.payload) {
      window.__ANTI_TS_PENDING__ = ev.data.payload;
      solveAndInject(ev.data.payload);
    }
    if (ev.data.type === "recaptcha-params" && ev.data.payload) {
      window.__ANTI_RECAPTCHA_PENDING__ = ev.data.payload;
      solveAndInject(ev.data.payload);
    }
    if (ev.data.type === "recaptcha-v3-params" && ev.data.payload) {
      window.__ANTI_RECAPTCHA_V3__ = ev.data.payload;
      solveAndInject(
        Object.assign({ kind: "recaptcha_v3", website_url: location.href }, ev.data.payload)
      );
    }
  });

  function scan() {
    // Detect only — agent clicks. Farm only if __ANTI_CAPTCHA_ALLOW_FARM__
    if (isChallengeFrame) return;
    if (window.__ANTI_CAPTCHA_ALLOW_FARM__ !== true) return;
    const kind = detectKind();
    if (!kind) return;
    const task = buildTask({ kind });
    if (task) solveAndInject(task);
  }

  // No aggressive auto-scan farm loop (was every 1s). Optional farm only if flag set.
  if (window.__ANTI_CAPTCHA_ALLOW_FARM__ === true) {
    let n = 0;
    const t = setInterval(() => {
      scan();
      if (++n > 45) clearInterval(t);
    }, 1000);
    if (document.readyState === "complete") setTimeout(scan, 300);
    else window.addEventListener("load", () => setTimeout(scan, 300));
  }
  console.info(
    "[anti-captcha] click-only mode (agent solves with mouse). Farm disabled unless __ANTI_CAPTCHA_ALLOW_FARM__=true"
  );
})();
