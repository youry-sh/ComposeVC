// ANTI speech locale filter — MAIN world, document_start.
// Goal: CreepJS must not see only ru-RU OS voices when persona is en-US.
// Prefer en-* voices; if OS has none, synthesize a minimal en-US-like list
// from whatever exists (lang rewrite is best-effort; real fix is C++ patch 019).
(function () {
  'use strict';
  try {
    var host0 = '';
    try { host0 = String(location.hostname || '').toLowerCase(); } catch (e0) {}
    if (
      /(?:^|\.)challenges\.cloudflare\.com$/i.test(host0) ||
      /(?:^|\.)hcaptcha\.com$/i.test(host0) ||
      /(?:^|\.)recaptcha\.net$/i.test(host0) ||
      /(?:^|\.)stripe\.com$/i.test(host0) ||
      /(?:^|\.)stripe\.network$/i.test(host0) ||
      /(?:^|\.)stripecdn\.com$/i.test(host0) ||
      /(?:^|\.)paypal\.com$/i.test(host0) ||
      /(?:^|\.)braintreegateway\.com$/i.test(host0) ||
      /(?:^|\.)adyen\.com$/i.test(host0) ||
      /(?:^|\.)klarna\.com$/i.test(host0) ||
      /(?:^|\.)checkout\.com$/i.test(host0) ||
      /(?:^|\.)cardinalcommerce\.com$/i.test(host0)
    ) {
      return;
    }
  } catch (eSkip) {}
  if (!window.speechSynthesis || !window.SpeechSynthesisVoice) return;

  var PREFER = (document.documentElement.getAttribute('lang') ||
    (navigator.language || 'en-US')).toLowerCase();
  // Prefer prefix from --lang via navigator (already spoofed by chrome flags)
  var preferPrefix = (navigator.language || 'en-US').split('-')[0].toLowerCase();

  function score(v) {
    var lang = (v.lang || '').toLowerCase();
    if (lang === PREFER || lang === (navigator.language || '').toLowerCase()) return 100;
    if (lang.indexOf(preferPrefix + '-') === 0 || lang === preferPrefix) return 80;
    if (lang.indexOf('en') === 0) return 60;
    return 0;
  }

  function filterVoices(list) {
    if (!list || !list.length) return list;
    var preferred = [];
    var en = [];
    for (var i = 0; i < list.length; i++) {
      var s = score(list[i]);
      if (s >= 80) preferred.push(list[i]);
      else if (s >= 60) en.push(list[i]);
    }
    if (preferred.length) return preferred;
    if (en.length) return en;
    // No en voices on OS (e.g. only Microsoft Irina ru-RU): return empty
    // rather than leaking ru-RU as "default locale". Empty is better than wrong lang.
    // CreepJS will show remote unsupported / empty local — less severe than ru vs en-US.
    return [];
  }

  var orig = window.speechSynthesis.getVoices.bind(window.speechSynthesis);
  window.speechSynthesis.getVoices = function () {
    return filterVoices(orig());
  };

  // Some sites cache voices on voiceschanged
  window.speechSynthesis.addEventListener('voiceschanged', function () {
    // no-op: getters already filtered
  });
})();
