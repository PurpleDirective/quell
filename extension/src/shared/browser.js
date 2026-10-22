// Quell — which browser this extension page is running in. The Chrome package
// also installs on Opera and Edge, which name themselves in the user agent
// ("OPR/", "Edg/") and in their client hints. Opera does not sync extension
// settings, and neither browser's add-ons site is the Chrome Web Store, so
// pages that say either ask here first.
globalThis.QuellBrowser = (() => {
  const url = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
    ? chrome.runtime.getURL('') : '';
  const firefox = url.startsWith('moz-extension:');
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const brands = (nav.userAgentData && nav.userAgentData.brands) || [];
  const opera = !firefox && (/\bOPR\//.test(nav.userAgent || '') || brands.some((b) => /\bOpera\b/i.test(b.brand)));
  const edge = !firefox && !opera && (/\bEdg(e|A|iOS)?\//.test(nav.userAgent || '') || brands.some((b) => /\bMicrosoft Edge\b/i.test(b.brand)));
  return Object.freeze({ firefox, opera, edge });
})();
