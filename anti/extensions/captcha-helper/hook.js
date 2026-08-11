// MAIN world — intercept captcha APIs early + inject tokens into page callbacks.
(function () {
  if (window.__ANTI_CAPTCHA_HOOK__) return;

  try {
    var href = String(location.href || "");
    var host = "";
    try {
      host = String(location.hostname || "").toLowerCase();
    } catch (_) {}
    var isChallengeFrame =
      /(?:^|\.)challenges\.cloudflare\.com$/i.test(host) ||
      (/(?:^|\.)cloudflare\.com$/i.test(host) && /\/cdn-cgi\/challenge|turnstile|challenges\//i.test(href)) ||
      /(?:google\.com|recaptcha\.net)\/recaptcha\//i.test(href) ||
      /(?:^|\.)recaptcha\.net$/i.test(host) ||
      (/(?:^|\.)gstatic\.com$/i.test(host) && /recaptcha/i.test(href)) ||
      /(?:^|\.)hcaptcha\.com$/i.test(host) ||
      /(?:^|\.)newassets\.hcaptcha\.com$/i.test(host) ||
      /hcaptcha\.com\/captcha/i.test(href);
    var isPaymentFrame =
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
    if (isChallengeFrame || isPaymentFrame) {
      window.__ANTI_CAPTCHA_HOOK__ = true;
      return;
    }
  } catch (_) {}

  window.__ANTI_CAPTCHA_HOOK__ = true;

  window.__ANTI_TS__ = window.__ANTI_TS__ || { pending: null, callback: null, sitekey: null };
  window.__ANTI_RECAPTCHA__ = window.__ANTI_RECAPTCHA__ || { callbacks: [], sitekey: null };
  window.__ANTI_RECAPTCHA_V3__ = window.__ANTI_RECAPTCHA_V3__ || null;

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: "anti-captcha-hook" }, msg), "*");
    } catch (_) {}
  }

  function sitekeyFromScript() {
    try {
      const scripts = document.querySelectorAll("script[src*='recaptcha']");
      for (const s of scripts) {
        try {
          const u = new URL(s.src, location.href);
          const render = u.searchParams.get("render");
          if (render && render !== "explicit" && render.length > 10) return render;
        } catch (_) {}
      }
    } catch (_) {}
    return "";
  }

  // ── Turnstile ─────────────────────────────────────────────────────────
  // IMPORTANT: DO NOT wrap window.turnstile.render / getResponse / isExpired.
  // Cloudflare Turnstile detects modified turnstile API objects and shows
  // "troubleshoot" — even when browsing manually.
  // CDP antiBrowser.injectCaptchaToken handles all token injection:
  // form fields, getResponse patch, React fiber walk, and callback firing.
  // The __ANTI_TS_INJECT__ helper below is optional (CDP falls back to manual).
  // No setInterval polling — the20ms poll for3 min is detected as bot behavior.

  // Global inject used by CDP antiBrowser.injectCaptchaToken
  window.__ANTI_TS_INJECT__ = function (token) {
    if (!token || String(token).length < 20) return { ok: false, reason: "short-token" };
    const t = String(token);
    window.__ANTI_TS__ = window.__ANTI_TS__ || {};
    window.__ANTI_TS__.token = t;
    window.__ANTI_TS__.solved = true;
    window.__ANTI_LAST_CAPTCHA_TOKEN__ = t;

    function fiberKey(el) {
      if (!el) return null;
      const keys = Object.keys(el);
      for (let i = 0; i < keys.length; i++) {
        if (/^__reactFiber\$|^__reactInternalInstance\$|^__reactProps\$/.test(keys[i])) return keys[i];
      }
      return null;
    }

    function walkFiberCallbacks(rootEl, depthLimit) {
      const found = [];
      const seen = new Set();
      const limit = depthLimit || 12;
      function pushFn(fn, path) {
        if (typeof fn !== "function" || seen.has(fn)) return;
        seen.add(fn);
        found.push({ fn: fn, path: path || "" });
      }
      function walk(node, depth) {
        if (!node || depth > limit) return;
        try {
          const props = node.memoizedProps || node.pendingProps || null;
          if (props && typeof props === "object") {
            [
              "callback",
              "onSuccess",
              "onVerify",
              "onToken",
              "success",
              "onComplete",
              "onSolved",
              "onChange",
            ].forEach(function (k) {
              if (typeof props[k] === "function") pushFn(props[k], "props." + k);
            });
            if (props.children && typeof props.children === "object") {
              /* skip */
            }
          }
          if (typeof node.memoizedState !== "undefined") {
            let st = node.memoizedState;
            let guard = 0;
            while (st && guard++ < 20) {
              if (typeof st.memoizedState === "function") pushFn(st.memoizedState, "hook");
              if (st.queue && typeof st.queue.dispatch === "function") {
                /* keep */
              }
              st = st.next;
            }
          }
          if (node.child) walk(node.child, depth + 1);
          if (node.sibling) walk(node.sibling, depth + 1);
        } catch (_) {}
      }
      try {
        const hosts = [];
        if (rootEl) hosts.push(rootEl);
        document
          .querySelectorAll(
            ".cf-turnstile, [data-sitekey], iframe[src*='turnstile'], iframe[src*='challenges.cloudflare']"
          )
          .forEach(function (el) {
            hosts.push(el);
            if (el.parentElement) hosts.push(el.parentElement);
            if (el.parentElement && el.parentElement.parentElement) {
              hosts.push(el.parentElement.parentElement);
            }
          });
        hosts.forEach(function (el) {
          try {
            const k = fiberKey(el);
            if (!k) return;
            const fiber = el[k];
            if (fiber) walk(fiber, 0);
            if (k.indexOf("Props") >= 0 && el[k] && typeof el[k] === "object") {
              const p = el[k];
              ["callback", "onSuccess", "onVerify", "onToken", "onChange"].forEach(function (name) {
                if (typeof p[name] === "function") pushFn(p[name], "domProps." + name);
              });
            }
          } catch (_) {}
        });
      } catch (_) {}
      return found;
    }

    function fireAllCallbacks() {
      let n = 0;
      try {
        if (typeof window.__ANTI_TS__.callback === "function") {
          try {
            window.__ANTI_TS__.callback(t);
            n++;
          } catch (_) {}
        }
        (window.__ANTI_TS__.callbacks || []).forEach(function (cb) {
          try {
            if (typeof cb === "function") {
              cb(t);
              n++;
            }
          } catch (_) {}
        });
      } catch (_) {}
      try {
        document
          .querySelectorAll(".cf-turnstile[data-callback], [data-sitekey][data-callback], iframe[src*='turnstile']")
          .forEach(function (el) {
            const name =
              el.getAttribute("data-callback") ||
              (el.parentElement && el.parentElement.getAttribute("data-callback"));
            if (name && typeof window[name] === "function") {
              try {
                window[name](t);
                n++;
              } catch (_) {}
            }
          });
      } catch (_) {}
      try {
        const hosts = document.querySelectorAll(
          ".cf-turnstile, [data-sitekey], iframe[src*='turnstile'], iframe[src*='challenges.cloudflare']"
        );
        hosts.forEach(function (el) {
          const key = fiberKey(el);
          if (!key || !el[key]) return;
          const fiber = el[key];
          const props = fiber.memoizedProps || fiber.pendingProps || fiber;
          if (!props || typeof props !== "object") return;
          ["callback", "onSuccess", "onVerify", "onToken"].forEach(function (name) {
            if (typeof props[name] !== "function") return;
            try {
              props[name](t);
              n++;
            } catch (_) {}
          });
        });
      } catch (_) {}
      return n;
    }

    let cbCount = fireAllCallbacks();
    try {
      if (window.turnstile) applyGetResponsePatch(window.turnstile);
    } catch (_) {}
    try {
      if (window.turnstile && typeof window.turnstile === "object") {
        const wid = window.__ANTI_TS__.lastWidgetId;
        const forceGet = function () {
          return forceGetResponse() || t;
        };
        try {
          Object.defineProperty(window.turnstile, "getResponse", {
            value: forceGet,
            writable: true,
            configurable: true,
          });
          Object.defineProperty(window.turnstile, "isExpired", {
            value: function () {
              return false;
            },
            writable: true,
            configurable: true,
          });
        } catch (_) {
          window.turnstile.getResponse = forceGet;
          window.turnstile.isExpired = function () {
            return false;
          };
        }
        if (wid != null && typeof window.turnstile.getResponse === "function") {
          try {
            window.turnstile.getResponse(wid);
          } catch (_) {}
        }
      }
    } catch (_) {}

    let fields = 0;
    try {
      function lockFieldValue(el, value) {
        if (!el) return false;
        const v = String(value || "");
        try {
          const tracker = el._valueTracker;
          if (tracker && typeof tracker.setValue === "function") {
            tracker.setValue("");
          }
        } catch (_) {}
        try {
          const proto =
            el.tagName === "TEXTAREA"
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, v);
          else el.value = v;
        } catch (_) {
          try {
            el.value = v;
          } catch (_) {}
        }
        try {
          el.setAttribute("value", v);
        } catch (_) {}
        try {
          el.setAttribute("data-anti-captcha-token", "1");
        } catch (_) {}
        // Prevent CF/React from wiping the response before submit (Grok password step).
        try {
          if (!el.__anti_value_locked) {
            Object.defineProperty(el, "value", {
              configurable: true,
              enumerable: true,
              get: function () {
                return this.__anti_locked_token || v;
              },
              set: function (nv) {
                const s = String(nv == null ? "" : nv);
                if (s && s.length >= 20) this.__anti_locked_token = s;
                else if (!this.__anti_locked_token) this.__anti_locked_token = v;
              },
            });
            el.__anti_value_locked = true;
          }
          el.__anti_locked_token = v;
        } catch (_) {}
        try {
          el.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: v, inputType: "insertFromPaste" })
          );
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (_) {
          try {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (_) {}
        }
        try {
          return !!(el.value && String(el.value).length > 20);
        } catch (_) {
          return v.length > 20;
        }
      }
      function setNative(el, value) {
        return lockFieldValue(el, value);
      }
      document
        .querySelectorAll(
          'input[name="cf-turnstile-response"],textarea[name="cf-turnstile-response"],input[name="cf_turnstile_response"],input[id*="cf-chl"],textarea[id*="cf-chl"],input[name*="turnstile"],textarea[name*="turnstile"],input[data-anti-captcha-token],textarea[data-anti-captcha-token]'
        )
        .forEach(function (el) {
          if (setNative(el, t)) fields++;
        });
      if (!fields) {
        try {
          const form = document.querySelector("form") || document.body;
          const hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "cf-turnstile-response";
          hidden.setAttribute("data-anti-captcha-token", "1");
          hidden.value = t;
          form.appendChild(hidden);
          fields = setNative(hidden, t) ? 1 : 1;
        } catch (_) {}
      }
    } catch (_) {}

    function unlockButtons() {
      let unlocked = 0;
      try {
        document.querySelectorAll('button, input[type="submit"], [role="button"]').forEach(function (btn) {
          const label = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
          if (
            btn.type === "submit" ||
            /create|sign\s*up|continue|register|submit|next|join|start|account|verify|login|log\s*in|complete/i.test(
              label
            )
          ) {
            try {
              btn.disabled = false;
              btn.removeAttribute("disabled");
              btn.setAttribute("aria-disabled", "false");
              if (btn.classList) {
                btn.classList.remove("disabled", "opacity-50", "pointer-events-none", "cursor-not-allowed");
              }
              try {
                const pk = fiberKey(btn);
                if (pk && btn[pk]) {
                  const fiber = btn[pk];
                  const props = fiber.memoizedProps || fiber.pendingProps;
                  if (props) {
                    try {
                      props.disabled = false;
                      props["aria-disabled"] = false;
                    } catch (_) {}
                  }
                }
              } catch (_) {}
              unlocked++;
            } catch (_) {}
          }
        });
      } catch (_) {}
      return unlocked;
    }

    let unlocked = unlockButtons();
    try {
      window.postMessage({ source: "anti-captcha-hook", type: "inject", kind: "turnstile", token: t }, "*");
      window.postMessage({ event: "challenge-passed", token: t }, "*");
      window.dispatchEvent(new CustomEvent("turnstile-callback", { detail: { token: t } }));
      window.dispatchEvent(new CustomEvent("cf-turnstile-response", { detail: t }));
    } catch (_) {}
    try {
      setTimeout(function () {
        cbCount = Math.max(cbCount, fireAllCallbacks());
        unlocked = Math.max(unlocked, unlockButtons());
        try {
          if (window.turnstile) applyGetResponsePatch(window.turnstile);
        } catch (_) {}
      }, 40);
      setTimeout(function () {
        cbCount = Math.max(cbCount, fireAllCallbacks());
        unlocked = Math.max(unlocked, unlockButtons());
      }, 180);
      setTimeout(function () {
        cbCount = Math.max(cbCount, fireAllCallbacks());
        unlocked = Math.max(unlocked, unlockButtons());
      }, 450);
      setTimeout(function () {
        fireAllCallbacks();
        unlockButtons();
      }, 900);
    } catch (_) {}
    return {
      ok: true,
      cbCount: cbCount,
      fields: fields,
      unlocked: unlocked,
      getResponse: forceGetResponse() ? String(forceGetResponse()).length : t.length,
      tokenLen: t.length,
    };
  };

  // ── reCAPTCHA v2 render / v3 execute ──────────────────────────────────
  function captureRecaptchaParams(opts, sitekeyHint) {
    const o = opts || {};
    const sitekey = o.sitekey || sitekeyHint || sitekeyFromScript() || "";
    if (!sitekey) return;
    if (typeof o.callback === "function") {
      window.__ANTI_RECAPTCHA__.callbacks.push(o.callback);
    }
    window.__ANTI_RECAPTCHA__.sitekey = sitekey;
    // data-callback name on .g-recaptcha
    try {
      document.querySelectorAll(".g-recaptcha[data-callback]").forEach((el) => {
        const name = el.getAttribute("data-callback");
        if (name && typeof window[name] === "function") {
          window.__ANTI_RECAPTCHA__.callbacks.push(window[name].bind(window));
        }
      });
    } catch (_) {}
    post({
      type: "recaptcha-params",
      payload: {
        kind: "recaptcha_v2",
        website_key: sitekey,
        website_url: location.href,
      },
    });
  }

  function hookGrecaptcha(g) {
    if (!g || g.__anti_hooked) return false;

    if (typeof g.render === "function") {
      const origRender = g.render.bind(g);
      g.render = function (container, parameters) {
        try {
          const params = parameters || {};
          captureRecaptchaParams(params, typeof container === "string" ? "" : "");
          // Keep widget id → callback map (floating panels / multi-widget)
          if (typeof params.callback === "function") {
            window.__ANTI_RECAPTCHA__.callbacks = window.__ANTI_RECAPTCHA__.callbacks || [];
            window.__ANTI_RECAPTCHA__.callbacks.push(params.callback);
            window.__ANTI_RECAPTCHA__.callback = params.callback;
          }
        } catch (_) {}
        const widgetId = origRender(container, parameters);
        try {
          window.__ANTI_RECAPTCHA__.lastWidgetId = widgetId;
          window.__ANTI_RECAPTCHA__.widgets = window.__ANTI_RECAPTCHA__.widgets || [];
          window.__ANTI_RECAPTCHA__.widgets.push({
            id: widgetId,
            sitekey: (parameters && parameters.sitekey) || window.__ANTI_RECAPTCHA__.sitekey,
          });
          // If token already present (agent inject race), fire callback ASAP
          if (window.__ANTI_RECAPTCHA__.token && parameters && typeof parameters.callback === "function") {
            setTimeout(function () {
              try {
                parameters.callback(window.__ANTI_RECAPTCHA__.token);
              } catch (_) {}
            }, 0);
          }
        } catch (_) {}
        return widgetId;
      };
    }

    if (typeof g.execute === "function") {
      const origExec = g.execute.bind(g);
      g.execute = function (sitekeyOrWidget, opts) {
        try {
          let sitekey = "";
          let action = "";
          if (typeof sitekeyOrWidget === "string" && sitekeyOrWidget.length > 10) {
            sitekey = sitekeyOrWidget;
          } else {
            sitekey = sitekeyFromScript() || window.__ANTI_RECAPTCHA__.sitekey || "";
          }
          if (opts && typeof opts === "object") action = opts.action || "";
          if (sitekey && action) {
            const payload = {
              kind: "recaptcha_v3",
              website_key: sitekey,
              website_url: location.href,
              page_action: action,
              action: action,
            };
            window.__ANTI_RECAPTCHA_V3__ = payload;
            post({ type: "recaptcha-v3-params", payload });
          } else if (sitekey) {
            captureRecaptchaParams(opts, sitekey);
          }
        } catch (_) {}
        return origExec(sitekeyOrWidget, opts);
      };
    }

    // Force getResponse to return injected token (React / miverify validators)
    try {
      const origGet =
        typeof g.getResponse === "function" ? g.getResponse.bind(g) : null;
      g.getResponse = function (widgetId) {
        if (window.__ANTI_RECAPTCHA__ && window.__ANTI_RECAPTCHA__.token) {
          return window.__ANTI_RECAPTCHA__.token;
        }
        return origGet ? origGet(widgetId) : "";
      };
    } catch (_) {}

    if (typeof g.ready === "function") {
      const origReady = g.ready.bind(g);
      g.ready = function (cb) {
        try {
          // Auto render widgets often already in DOM.
          const el = document.querySelector(".g-recaptcha[data-sitekey]");
          if (el) {
            captureRecaptchaParams({
              sitekey: el.getAttribute("data-sitekey"),
              callback: el.getAttribute("data-callback")
                ? window[el.getAttribute("data-callback")]
                : null,
            });
          }
          const sk = sitekeyFromScript();
          if (sk) {
            const payload = {
              kind: "recaptcha_v3",
              website_key: sk,
              website_url: location.href,
              page_action: "",
              action: "",
            };
            window.__ANTI_RECAPTCHA_V3__ = payload;
            post({ type: "recaptcha-v3-params", payload });
          }
        } catch (_) {}
        return origReady(cb);
      };
    }

    g.__anti_hooked = true;
    return true;
  }

  // CapSolver/2captcha style: walk ___grecaptcha_cfg.clients for nested callbacks
  function findRecaptchaCallbacksDeep() {
    const found = [];
    const seen = new Set();
    function add(fn, path) {
      if (typeof fn !== "function") return;
      if (seen.has(fn)) return;
      seen.add(fn);
      found.push({ fn: fn, path: path || "" });
    }
    function walk(obj, path, depth) {
      if (!obj || depth > 6) return;
      if (typeof obj === "function") {
        // Heuristic: callback-like names / short arity
        if (/callback|promise|then|resolve/i.test(path) || obj.length <= 2) {
          add(obj, path);
        }
        return;
      }
      if (typeof obj !== "object") return;
      try {
        const keys = Object.keys(obj);
        for (let i = 0; i < keys.length && i < 40; i++) {
          const k = keys[i];
          try {
            walk(obj[k], path ? path + "." + k : k, depth + 1);
          } catch (_) {}
        }
      } catch (_) {}
    }
    try {
      const cfg = window.___grecaptcha_cfg;
      if (cfg && cfg.clients) walk(cfg.clients, "clients", 0);
    } catch (_) {}
    try {
      // enterprise
      const g = window.grecaptcha && (window.grecaptcha.enterprise || window.grecaptcha);
      if (g && g.enterprise) {
        /* already covered via clients */
      }
    } catch (_) {}
    return found;
  }

  /**
   * MAIN-world reCAPTCHA inject — required for floating miverify / overlay panels.
   * Research: after solver token you MUST call page callback + set g-recaptcha-response;
   * field alone is often ignored (CapSolver "how to find callback", 2captcha callback guide).
   */
  window.__ANTI_RECAPTCHA_INJECT__ = function (token) {
    if (!token || String(token).length < 20) return { ok: false, reason: "short-token" };
    const t = String(token);
    window.__ANTI_RECAPTCHA__ = window.__ANTI_RECAPTCHA__ || { callbacks: [], sitekey: null };
    window.__ANTI_RECAPTCHA__.token = t;
    window.__ANTI_RECAPTCHA__.solved = true;

    function setNative(el, value) {
      if (!el) return false;
      try {
        const proto =
          el.tagName === "TEXTAREA"
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
      } catch (_) {
        try {
          el.value = value;
        } catch (_) {}
      }
      try {
        el.innerHTML = value;
      } catch (_) {}
      try {
        el.setAttribute("value", value);
      } catch (_) {}
      try {
        el.style.display = "block";
      } catch (_) {}
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (_) {}
      return !!(el.value && el.value.length > 20);
    }

    let fields = 0;
    try {
      document
        .querySelectorAll(
          'textarea[name="g-recaptcha-response"], input[name="g-recaptcha-response"], ' +
            'textarea#g-recaptcha-response, [name="g-recaptcha-response"], ' +
            'textarea[id*="g-recaptcha"], iframe[data-hcaptcha-response]'
        )
        .forEach(function (el) {
          if (setNative(el, t)) fields++;
        });
      // create field if missing (some overlays only have iframe)
      if (!fields) {
        const ta = document.createElement("textarea");
        ta.name = "g-recaptcha-response";
        ta.id = "g-recaptcha-response";
        ta.style.display = "none";
        (document.querySelector("form") || document.body).appendChild(ta);
        if (setNative(ta, t)) fields++;
      }
    } catch (_) {}

    let cbCount = 0;
    // 1) hooked callbacks
    try {
      if (typeof window.__ANTI_RECAPTCHA__.callback === "function") {
        try {
          window.__ANTI_RECAPTCHA__.callback(t);
          cbCount++;
        } catch (_) {}
      }
      (window.__ANTI_RECAPTCHA__.callbacks || []).forEach(function (cb) {
        try {
          if (typeof cb === "function") {
            cb(t);
            cbCount++;
          }
        } catch (_) {}
      });
    } catch (_) {}
    // 2) data-callback attributes (incl. hidden hosts in overlays)
    try {
      document
        .querySelectorAll(
          ".g-recaptcha[data-callback], [data-sitekey][data-callback], iframe[data-callback]"
        )
        .forEach(function (el) {
          const name = el.getAttribute("data-callback");
          if (name && typeof window[name] === "function") {
            try {
              window[name](t);
              cbCount++;
            } catch (_) {}
          }
        });
    } catch (_) {}
    // 3) deep walk ___grecaptcha_cfg (floating / multi-client)
    try {
      findRecaptchaCallbacksDeep().forEach(function (item) {
        try {
          item.fn(t);
          cbCount++;
        } catch (_) {}
      });
    } catch (_) {}

    // getResponse patch
    try {
      const g = window.grecaptcha;
      if (g) {
        g.getResponse = function () {
          return t;
        };
        if (g.enterprise) {
          g.enterprise.getResponse = function () {
            return t;
          };
        }
      }
    } catch (_) {}

    // Unlock Next/Continue/Verify — NOT postal "code" fields (agent confusion)
    let unlocked = 0;
    try {
      document.querySelectorAll('button, input[type="submit"], a[role="button"]').forEach(function (btn) {
        const label = (btn.innerText || btn.value || btn.getAttribute("aria-label") || "").toLowerCase();
        // Prefer captcha/form CTAs; avoid "change address" / pure navigation
        if (
          btn.type === "submit" ||
          /^(next|continue|verify|submit|confirm|try again|done|finish)$/i.test(label.trim()) ||
          /\b(next|continue|verify|submit|try again|i.m not a robot)\b/i.test(label)
        ) {
          if (/cancel|back|close|skip|google|github|apple|facebook/i.test(label)) return;
          try {
            btn.disabled = false;
            btn.removeAttribute("disabled");
            btn.setAttribute("aria-disabled", "false");
            unlocked++;
          } catch (_) {}
        }
      });
    } catch (_) {}

    try {
      window.postMessage(
        { source: "anti-captcha-hook", type: "inject", kind: "recaptcha_v2", token: t },
        "*"
      );
    } catch (_) {}

    return {
      ok: true,
      fields: fields,
      cbCount: cbCount,
      unlocked: unlocked,
      getResponse: t.length,
      note: "reCAPTCHA inject: field+callback+___grecaptcha_cfg. NOT a postal/SMS code field.",
    };
  };

  const grI = setInterval(() => {
    let ok = false;
    if (window.grecaptcha && hookGrecaptcha(window.grecaptcha)) {
      ok = true;
      if (window.grecaptcha.enterprise) hookGrecaptcha(window.grecaptcha.enterprise);
    }
    // keep polling longer — floating miverify may load grecaptcha late
    if (ok && window.__ANTI_RECAPTCHA__ && window.__ANTI_RECAPTCHA__.sitekey) {
      /* still keep interval for late enterprise */
    }
  }, 20);
  setTimeout(() => clearInterval(grI), 180000);

  // Explicit DOM scan for classic v2 checkbox (google demo).
  const domI = setInterval(() => {
    const el = document.querySelector(".g-recaptcha[data-sitekey]");
    if (!el) return;
    captureRecaptchaParams({
      sitekey: el.getAttribute("data-sitekey"),
      callback: el.getAttribute("data-callback")
        ? window[el.getAttribute("data-callback")]
        : null,
    });
    clearInterval(domI);
  }, 200);
  setTimeout(() => clearInterval(domI), 20000);

  window.__ANTI_INJECT_TOKEN__ = function (kind, token) {
    try {
      if (!token) return false;

      function setFields(names) {
        names.forEach((n) => {
          document.querySelectorAll('[name="' + n + '"], #' + n).forEach((el) => {
            el.value = token;
            el.innerHTML = token;
            el.style.display = "block";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        });
      }

      if (kind === "turnstile" || !kind) {
        setFields(["cf-turnstile-response", "g-recaptcha-response"]);
        if (window.__ANTI_TS__ && typeof window.__ANTI_TS__.callback === "function") {
          try {
            window.__ANTI_TS__.callback(token);
          } catch (_) {}
        }
        return true;
      }

      if (kind === "recaptcha_v2" || kind === "recaptcha_v3") {
        let field = document.querySelector(
          'textarea[name="g-recaptcha-response"], #g-recaptcha-response, [name="g-recaptcha-response"]'
        );
        if (!field) {
          field = document.createElement("textarea");
          field.name = "g-recaptcha-response";
          field.id = "g-recaptcha-response";
          field.style.display = "none";
          (document.body || document.documentElement).appendChild(field);
        }
        field.value = token;
        field.innerHTML = token;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));

        // Fire all captured callbacks (data-callback / grecaptcha.render callback).
        const cbs = (window.__ANTI_RECAPTCHA__ && window.__ANTI_RECAPTCHA__.callbacks) || [];
        cbs.forEach((cb) => {
          try {
            if (typeof cb === "function") cb(token);
          } catch (_) {}
        });
        // Named global callbacks common on demos
        ["onSuccess", "onSubmit", "recaptchaCallback", "captchaCallback"].forEach((name) => {
          try {
            if (typeof window[name] === "function") window[name](token);
          } catch (_) {}
        });
        // data-callback attributes
        try {
          document.querySelectorAll("[data-callback]").forEach((el) => {
            const name = el.getAttribute("data-callback");
            if (name && typeof window[name] === "function") {
              try {
                window[name](token);
              } catch (_) {}
            }
          });
        } catch (_) {}

        try {
          if (window.grecaptcha) {
            window.grecaptcha.getResponse = function () {
              return token;
            };
            if (window.grecaptcha.enterprise) {
              window.grecaptcha.enterprise.getResponse = function () {
                return token;
              };
            }
          }
        } catch (_) {}

        // Google demo has a form — enable submit if present.
        try {
          document.querySelectorAll("form").forEach((f) => {
            const btn = f.querySelector('button[type="submit"], input[type="submit"]');
            if (btn) btn.disabled = false;
          });
        } catch (_) {}
        return true;
      }

      if (kind === "hcaptcha") {
        setFields(["h-captcha-response", "g-recaptcha-response"]);
        return true;
      }
      return false;
    } catch (e) {
      post({ type: "inject-error", error: String(e) });
      return false;
    }
  };

  window.addEventListener("message", (ev) => {
    if (!ev.data || ev.data.source !== "anti-captcha-content") return;
    if (ev.data.type === "inject") {
      const ok = window.__ANTI_INJECT_TOKEN__(ev.data.kind, ev.data.token);
      post({ type: "inject-result", ok: !!ok });
    }
  });
})();
