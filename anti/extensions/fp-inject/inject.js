// ANTI FP inject — MAIN world, document_start.
// 1) Audio: seed-stable noise on AudioBuffer channel data (CreepJS OfflineAudioContext path)
// 2) Speech: fake en-US/en-GB Microsoft-like voices when OS only has ru-RU
// 3) Hardware coherence: deviceMemory / hardwareConcurrency / screen (host leak fix)
// 4) Light chrome/headless hygiene
//
// Note: wrapping getChannelData is detectable by CreepJS lieProps; isolation > silent same-hash.
// Real C++ AudioBuffer noise is still the long-term fix (patches/003 + getChannelData).
(function () {
  'use strict';
  if (window.__ANTI_FP_INJECTED__) return;

  try {
    var href0 = String(location.href || '');
    var host0 = '';
    try { host0 = String(location.hostname || '').toLowerCase(); } catch (e0) {}
    var isChallengeFrame =
      /(?:google\.com|recaptcha\.net)\/recaptcha\//i.test(href0) ||
      /(?:^|\.)recaptcha\.net$/i.test(host0) ||
      (/(?:^|\.)gstatic\.com$/i.test(host0) && /recaptcha/i.test(href0)) ||
      /(?:^|\.)hcaptcha\.com$/i.test(host0) ||
      /(?:^|\.)newassets\.hcaptcha\.com$/i.test(host0) ||
      /hcaptcha\.com\/captcha/i.test(href0);
    // NOTE: challenges.cloudflare.com (Turnstile) deliberately NOT skipped.
    // Turnstile checks browser fingerprints INSIDE the iframe.
    // Without fp-inject patches there, headless detection leaks → "troubleshoot".
    var isPaymentFrame =
      /(?:^|\.)stripe\.com$/i.test(host0) ||
      /(?:^|\.)stripe\.network$/i.test(host0) ||
      /(?:^|\.)stripecdn\.com$/i.test(host0) ||
      /(?:^|\.)js\.stripe\.com$/i.test(host0) ||
      /(?:^|\.)m\.stripe\.com$/i.test(host0) ||
      /(?:^|\.)hooks\.stripe\.com$/i.test(host0) ||
      /(?:^|\.)paypal\.com$/i.test(host0) ||
      /(?:^|\.)paypalobjects\.com$/i.test(host0) ||
      /(?:^|\.)braintreegateway\.com$/i.test(host0) ||
      /(?:^|\.)braintree-api\.com$/i.test(host0) ||
      /(?:^|\.)adyen\.com$/i.test(host0) ||
      /(?:^|\.)adyenpayments\.com$/i.test(host0) ||
      /(?:^|\.)pay\.google\.com$/i.test(host0) ||
      /(?:^|\.)payments\.google\.com$/i.test(host0) ||
      /(?:^|\.)squareup\.com$/i.test(host0) ||
      /(?:^|\.)squarecdn\.com$/i.test(host0) ||
      /(?:^|\.)klarna\.com$/i.test(host0) ||
      /(?:^|\.)klarnacdn\.net$/i.test(host0) ||
      /(?:^|\.)checkout\.com$/i.test(host0) ||
      /(?:^|\.)cardinalcommerce\.com$/i.test(host0) ||
      /3ds|acs\.|secure\.checkout\.visa/i.test(host0);
    if (isChallengeFrame || isPaymentFrame) {
      window.__ANTI_FP_INJECTED__ = true;
      return;
    }
  } catch (eSkip) {}

  window.__ANTI_FP_INJECTED__ = true;

  var cfg = window.__ANTI_FP__ || {};
  var seed = (cfg.seed >>> 0) || 1;
  var lang = (cfg.lang || navigator.language || 'en-US').toString();
  var speechExpect = (cfg.speechExpect || lang || 'en-US').toString();
  // Coherent hardware (never host 16/32 GB — Pixelscan flags cores=8 + mem=32)
  var wantCores = parseInt(cfg.hardwareConcurrency, 10) || 0;
  var wantMem = parseInt(cfg.deviceMemory, 10) || 0;
  if (wantMem > 8) wantMem = 8;
  if (wantMem && wantMem !== 4 && wantMem !== 8) wantMem = 8;
  var wantSW = parseInt(cfg.screenWidth, 10) || 0;
  var wantSH = parseInt(cfg.screenHeight, 10) || 0;
  var wantScale = Number(cfg.deviceScaleFactor) || 0;

  // --- seeded PRNG (xorshift32) ---
  function makeRng(s) {
    var x = (s ^ 0x9e3779b9) >>> 0;
    if (!x) x = 1;
    return function () {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17; x >>>= 0;
      x ^= x << 5; x >>>= 0;
      return (x >>> 0) / 4294967296;
    };
  }

  // --- Audio buffer noise ---
  // OFF by default: wrapping getChannelData is a CreepJS lieProps / stealth signal.
  // Prefer C++ patch 003 in the engine. Enable only with cfg.audioNoise === true
  // or window.__ANTI_FP__.audioNoise = true (or ANTI_AUDIO_NOISE=1 written into config).
  var enableAudioNoise = cfg.audioNoise === true || cfg.audioNoise === 1 || cfg.audioNoise === '1';

  function noiseBuffer(arr) {
    if (!arr || !arr.length) return arr;
    var allZero = true;
    var i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] !== 0) { allZero = false; break; }
    }
    if (allZero) return arr;

    var rng = makeRng(seed ^ (arr.length * 2654435761));
    var amp = 1e-8 + (seed % 97) * 1e-11; // quieter than before
    for (i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v === 0 || !isFinite(v)) continue;
      if (Math.abs(v) < 1e-12) continue;
      var n = (rng() - 0.5) * 2 * amp;
      arr[i] = v + n * (1 + Math.abs(v));
    }
    return arr;
  }

  function patchAudioBuffer() {
    if (!enableAudioNoise) return; // default OFF — less "masking / stealth"
    if (typeof AudioBuffer === 'undefined') return;
    var proto = AudioBuffer.prototype;
    var origGet = proto.getChannelData;
    var origCopy = proto.copyFromChannel;

    if (typeof origGet === 'function') {
      proto.getChannelData = function (channel) {
        var data = origGet.call(this, channel);
        if (!data || data.__antiNoised) return data;
        try {
          noiseBuffer(data);
          try { Object.defineProperty(data, '__antiNoised', { value: true, enumerable: false }); } catch (e) { data.__antiNoised = true; }
        } catch (e2) {}
        return data;
      };
    }

    if (typeof origCopy === 'function') {
      proto.copyFromChannel = function (destination, channelNumber, startInChannel) {
        try {
          var src = this.getChannelData(channelNumber);
          var start = startInChannel || 0;
          if (destination && src) {
            var n = Math.min(destination.length, src.length - start);
            for (var i = 0; i < n; i++) destination[i] = src[start + i];
            return;
          }
        } catch (e) {}
        return origCopy.apply(this, arguments);
      };
    }
  }

  // --- Speech: real en voices OR synthetic list ---
  function patchSpeech() {
    if (!window.speechSynthesis) return;
    var prefix = (speechExpect || 'en-US').toLowerCase().split('-')[0];

    function syntheticVoices() {
      // Minimal Windows-like en voices for CreepJS (not empty / not ru-RU)
      var L = speechExpect.indexOf('en-GB') === 0 ? 'en-GB' : 'en-US';
      var names = L === 'en-GB'
        ? [
            { name: 'Microsoft Hazel - English (United Kingdom)', lang: 'en-GB', def: true },
            { name: 'Microsoft George - English (United Kingdom)', lang: 'en-GB', def: false },
            { name: 'Google UK English Female', lang: 'en-GB', def: false }
          ]
        : [
            { name: 'Microsoft Zira - English (United States)', lang: 'en-US', def: true },
            { name: 'Microsoft David - English (United States)', lang: 'en-US', def: false },
            { name: 'Google US English', lang: 'en-US', def: false }
          ];
      // Prefer real SpeechSynthesisVoice if constructible — usually not.
      // Return plain objects with expected getters (CreepJS reads .lang .name .default .localService .voiceURI)
      return names.map(function (n, idx) {
        return {
          name: n.name,
          lang: n.lang,
          default: !!n.def,
          localService: true,
          voiceURI: n.name,
          // some code paths use toString
          toJSON: function () { return this.name; }
        };
      });
    }

    function score(v) {
      var l = (v.lang || '').toLowerCase();
      if (l === (speechExpect || '').toLowerCase()) return 100;
      if (l.indexOf(prefix + '-') === 0 || l === prefix) return 80;
      if (l.indexOf('en') === 0) return 60;
      return 0;
    }

    function filterOrFake(list) {
      list = list || [];
      var preferred = [];
      var en = [];
      for (var i = 0; i < list.length; i++) {
        var s = score(list[i]);
        if (s >= 80) preferred.push(list[i]);
        else if (s >= 60) en.push(list[i]);
      }
      if (preferred.length) return preferred;
      if (en.length) return en;
      return syntheticVoices();
    }

    var orig = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
    window.speechSynthesis.getVoices = function () {
      try {
        return filterOrFake(orig());
      } catch (e) {
        return syntheticVoices();
      }
    };
  }

  // --- Hardware coherence (deviceMemory / cores / screen) ---
  // Engine patch 005 should force deviceMemory=8, but some builds leak host RAM (32GB).
  // Pixelscan flags cores=8 + deviceMemory=32 as inconsistent. Force persona pack.
  function defineRO(obj, key, value) {
    try {
      Object.defineProperty(obj, key, {
        get: function () { return value; },
        configurable: true,
        enumerable: true
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function patchHardware() {
    // deviceMemory — Chrome exposes 0.25|0.5|1|2|4|8 only
    if (wantMem === 4 || wantMem === 8) {
      try {
        var cur = navigator.deviceMemory;
        // Override if missing, wrong, or host leak (>8)
        if (cur !== wantMem || cur > 8 || cur == null) {
          defineRO(Navigator.prototype, 'deviceMemory', wantMem) ||
            defineRO(navigator, 'deviceMemory', wantMem);
        }
      } catch (e) {
        try { defineRO(navigator, 'deviceMemory', wantMem); } catch (e2) {}
      }
    }
    // hardwareConcurrency — reinforce seed/persona if engine/host diverge
    if (wantCores >= 2 && wantCores <= 32) {
      try {
        var hc = navigator.hardwareConcurrency;
        if (hc !== wantCores) {
          defineRO(Navigator.prototype, 'hardwareConcurrency', wantCores) ||
            defineRO(navigator, 'hardwareConcurrency', wantCores);
        }
      } catch (e3) {}
    }
    // screen — CSS pixels must match persona; DPR is separate.
    // NEVER set width=2400 when dpr=1.25 (that is physical). CSS stays 1920.
    if (wantSW > 0 && wantSH > 0) {
      // Guard: if someone stored physical px by mistake (CSS*dpr), shrink back
      var cssW = wantSW;
      var cssH = wantSH;
      var dpr = wantScale > 0 ? wantScale : 1;
      if (dpr > 1.01) {
        // if looks like physical (e.g. 2400 with dpr 1.25), convert to CSS
        var maybeCssW = Math.round(wantSW / dpr);
        var maybeCssH = Math.round(wantSH / dpr);
        if (wantSW >= 2000 && maybeCssW >= 1280 && maybeCssW <= 2560 &&
            Math.abs(wantSW - maybeCssW * dpr) < 2) {
          cssW = maybeCssW;
          cssH = maybeCssH;
        }
      }
      try {
        var s = window.screen;
        if (s) {
          if (s.width !== cssW) defineRO(s, 'width', cssW);
          if (s.height !== cssH) defineRO(s, 'height', cssH);
          // Windows taskbar ≈ 40 CSS px
          var availDelta = 40;
          if (cfg.availDelta) availDelta = parseInt(cfg.availDelta, 10) || 40;
          var availH = Math.max(cssH - availDelta, cssH - 48);
          var availW = cssW;
          if (s.availWidth !== availW) defineRO(s, 'availWidth', availW);
          if (s.availHeight !== availH) defineRO(s, 'availHeight', availH);
          // colorDepth / pixelDepth common 24
          try {
            if (s.colorDepth && s.colorDepth !== 24) defineRO(s, 'colorDepth', 24);
            if (s.pixelDepth && s.pixelDepth !== 24) defineRO(s, 'pixelDepth', 24);
          } catch (e6) {}
        }
      } catch (e4) {}
      if (dpr > 0) {
        try {
          if (window.devicePixelRatio !== dpr) {
            defineRO(window, 'devicePixelRatio', dpr);
          }
        } catch (e5) {}
      }
    }
  }

  // --- Light navigator hygiene (does not fix Features 148) ---
  function patchNavigatorLite() {
    try {
      // ALWAYS force webdriver=false, not only when it was true.
      // Headless patch may have missed this in certain Chrome versions.
      Object.defineProperty(navigator, 'webdriver', {
        get: function () { return false; },
        configurable: true,
      });
    } catch (e) {}
    try {
      // Proper chrome.runtime emulation — Cloudflare Turnstile and other
      // antibot scripts check for chrome.runtime (not just chrome object).
      // An empty window.chrome = {} is a strong headless signal.
      if (!window.chrome || typeof window.chrome !== 'object' || !window.chrome.runtime) {
        var chromeObj = window.chrome || {};
        if (!chromeObj.runtime) {
          // Minimal runtime stub that passes typeof checks
          chromeObj.runtime = {
            id: 'a' + Math.random().toString(36).slice(2, 10),
            connect: function () { return { onDisconnect: { addListener: function () {} }, onMessage: { addListener: function () {} }, postMessage: function () {} }; },
            sendMessage: function () {},
            onMessage: { addListener: function () {}, removeListener: function () {} },
            onConnect: { addListener: function () {}, removeListener: function () {} },
            getManifest: function () { return { version: '1.0' }; },
          };
        }
        if (!chromeObj.loadTimes) {
          chromeObj.loadTimes = function () {
            return {
              requestTime: 0,
              startLoadTime: 0,
              commitLoadTime: 0,
              finishDocumentLoadTime: 0,
              finishLoadTime: 0,
              firstPaintTime: 0,
              firstPaintAfterLoadTime: 0,
              navigationType: 'other',
              wasFetchedViaSpdy: false,
              wasNpnNegotiated: false,
              npnNegotiatedProtocol: 'unknown',
              wasAlternateProtocolAvailable: false,
              connectionInfo: 'http/1.1',
            };
          };
        }
        if (!chromeObj.csi) {
          chromeObj.csi = function () {
            return {
              onloadT: 0,
              startE: 0,
              pageT: 0,
              tran: 0,
            };
          };
        }
        chromeObj.app = chromeObj.app || { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } };
        chromeObj.webstore = chromeObj.webstore || { install: function () {}, onInstallStageChanged: {}, onDownloadProgress: {} };
        window.chrome = chromeObj;
      }
    } catch (e2) {}
    // navigator.plugins — headless Chrome has 0, real has 5+.
    // Cloudflare Turnstile checks plugins length.
    try {
      if (navigator.plugins && navigator.plugins.length < 3) {
        var pluginProto = Object.getPrototypeOf(navigator.plugins);
        if (pluginProto && typeof pluginProto.refresh === 'function') {
          // Create minimal but convincing plugin entries
          var fakePlugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Chrome PDF Viewer' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: 'Native Client Executable' },
          ];
          // Proxy navigator.plugins to return fake entries without breaking the original
          var origItem = navigator.plugins.item;
          var origNamedItem = navigator.plugins.namedItem;
          Object.defineProperty(navigator.plugins, 'length', { value: fakePlugins.length, configurable: false, writable: false });
          navigator.plugins.item = function (i) { return fakePlugins[i] || origItem.call(navigator.plugins, i); };
          navigator.plugins.namedItem = function (n) { return fakePlugins.find(function (p) { return p.name === n; }) || null; };
        }
      }
    } catch (e3) {}
    // navigator.languages — sometimes missing or wrong in headless
    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        var lang = (navigator.language || 'en-US');
        Object.defineProperty(navigator, 'languages', {
          get: function () { return [lang, lang.slice(0, 2)]; },
          configurable: true,
        });
      }
    } catch (e4) {}
  }

  // --- Language coherence (navigator.language / languages / acceptLanguage) ---
  // On Linux stock Chromium, --lang does NOT change navigator.language (UI
  // locale only), so spoof it from cfg. Also covers engines where the locale
  // flag is ignored. Accept-Language HTTP header still comes from --accept-lang.
  function patchLanguage() {
    var wantLang = (cfg.lang || '').toString().trim();
    if (!wantLang) return;
    wantLang = wantLang.replace(/_/g, '-');
    var wantAccept = (cfg.acceptLang || wantLang).toString();
    var langs = [wantLang];
    var base = wantLang.split('-')[0];
    if (base && base !== wantLang && langs.indexOf(base) === -1) langs.push(base);
    // keep existing entries (dedup, cap 5)
    try {
      var cur = navigator.languages || [];
      for (var i = 0; i < cur.length && langs.length < 5; i++) {
        if (langs.indexOf(cur[i]) === -1) langs.push(cur[i]);
      }
    } catch (e) {}
    try {
      if ((navigator.language || '') !== wantLang) {
        defineRO(Navigator.prototype, 'language', wantLang) || defineRO(navigator, 'language', wantLang);
      }
    } catch (e) {}
    try {
      var curLangs = navigator.languages || [];
      var same = curLangs.length === langs.length && curLangs.every(function (l, i) { return l === langs[i]; });
      if (!same) {
        Object.defineProperty(Navigator.prototype, 'languages', {
          get: function () { return langs.slice(); },
          configurable: true,
        });
      }
    } catch (e) {}
    // acceptLanguage — some fingerprinters read it
    try {
      Object.defineProperty(Navigator.prototype, 'acceptLanguage', {
        get: function () { return wantAccept; },
        configurable: true,
      });
    } catch (e) {}
  }

  try { patchHardware(); } catch (e) {}
  try { patchAudioBuffer(); } catch (e) {}
  try { patchSpeech(); } catch (e) {}
  try { patchLanguage(); } catch (e) {}
  try { patchNavigatorLite(); } catch (e) {}
})();
