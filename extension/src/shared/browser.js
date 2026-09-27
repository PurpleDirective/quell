// Quell — which browser this extension page is running in. The Chrome package
// also installs on Opera, which names itself in the user agent ("OPR/") and in
// its client hints. Opera does not sync extension settings, and its add-ons
// site is not the Chrome Web Store, so pages that say either ask here first.
globalThis.QuellBrowser = (() => {
  const url = typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
    ? chrome.runtime.getURL('') : '';
  const firefox = url.startsWith('moz-extension:');
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const brands = (nav.userAgentData && nav.userAgentData.brands) || [];
  const opera = !firefox && (/\bOPR\//.test(nav.userAgent || '') || brands.some((b) => /\bOpera\b/i.test(b.brand)));
  return Object.freeze({ firefox, opera });
})();
