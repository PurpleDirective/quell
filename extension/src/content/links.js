// Quell — tracking-link cleaning (0.7.4), the "Links" group.
//
// Two jobs on the links of the page in front of you:
//   1. Take known TRACKING query parameters (utm_*, fbclid, gclid, ...) off a
//      link, so the address you copy, share or open is the plain one.
//   2. On Google and Bing result pages, point a result link straight at its
//      site instead of through the search engine's own redirect
//      (google.com/url?q=..., bing.com/ck/a?...&u=...).
// The same parameters are also taken off an address you navigate to by a
// declarativeNetRequest ruleset (rules/links-clean.json, built by
// pipeline/build_rules.py); this script covers what a rule cannot — decoding
// an escaped Google address, and Bing's encoded one — and tells the popup how
// many links it cleaned on this page.
//
// NEVER touched: affiliate parameters (tag, ascsubtag, aff_id, affiliate, ref,
// linkCode, ...) and anything that changes what the page shows (q, page, id,
// v, t, ...). The list below is closed: only names on it are ever removed,
// and tests/smoke.mjs checks it against the pipeline's list and against a
// protected list. Nothing is sent anywhere; the link is rewritten in place
// and the page's own address bar is never changed.

(async () => {
  if (window.__quellLinks) return; // double-injection guard
  window.__quellLinks = true;

  const DEFAULTS = { enabled: true, linksEnabled: true };
  const readSettings = () => globalThis.QuellSettings.get(DEFAULTS);

  // Must equal LINK_TRACKING_PARAMS in pipeline/build_rules.py (smoke test).
  const TRACKING = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
    'utm_name', 'utm_brand', 'utm_social', 'utm_social-type', 'utm_cid', 'utm_reader',
    'utm_viz_id', 'utm_pubreferrer', 'utm_swu',
    'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid',
    'twclid', 'ttclid', 'li_fat_id', 'igshid', 'igsh',
    'mc_eid', 'mc_cid', '_hsenc', '_hsmi', 'mkt_tok', 'vero_id', 'vero_conv',
    'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'ref_src', '_openstat',
    'wickedid', 'soc_src', 'soc_trk', 'sr_share', 'epik', 'pk_campaign', 'pk_kwd',
    'ml_subscriber', 'ml_subscriber_hash', 'trk', 'trkEmail',
  ]);
  const YOUTUBE_ONLY = new Set(['si']);
  const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be)$/;

  const web = (u) => u.protocol === 'http:' || u.protocol === 'https:';

  // The Google or Bing result link inside a search engine's redirect, or null.
  function unwrap(u) {
    const h = u.hostname;
    if (/^www\.google\.[a-z.]+$/.test(h) && u.pathname === '/url') {
      const t = u.searchParams.get('q') || u.searchParams.get('url');
      try { const x = new URL(t); return web(x) ? x : null; } catch (_) { return null; }
    }
    if (/^(www\.)?bing\.com$/.test(h) && u.pathname === '/ck/a') {
      const v = u.searchParams.get('u');
      if (!v || !/^a1/.test(v)) return null;
      try {
        // base64url of the address, after the two-character "a1" tag.
        let b = v.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b.length % 4) b += '=';
        const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
        const x = new URL(new TextDecoder().decode(bytes));
        return web(x) ? x : null;
      } catch (_) { return null; }
    }
    return null;
  }

  // The cleaned address for `href`, or null when there is nothing to clean.
  function cleaned(href, base) {
    let u;
    try { u = new URL(href, base || location.href); } catch (_) { return null; }
    if (!web(u)) return null;
    let changed = false;
    const inner = unwrap(u);
    if (inner) { u = inner; changed = true; }
    if (u.search) {
      const yt = YOUTUBE_HOST.test(u.hostname);
      const keep = [];
      let drop = false;
      for (const [k, v] of u.searchParams) {
        if (TRACKING.has(k) || (yt && YOUTUBE_ONLY.has(k))) drop = true; else keep.push([k, v]);
      }
      if (drop) {
        // Rebuild from the raw pieces so the kept parameters stay byte-for-byte as they were.
        const raw = u.search.slice(1).split('&').filter((p) => {
          const rawKey = (p.split('=')[0] || '').replace(/\+/g, ' ');
          let k = rawKey;
          try { k = decodeURIComponent(rawKey); } catch (_) { /* malformed %-sequence: use the raw key */ }
          return !(TRACKING.has(k) || (yt && YOUTUBE_ONLY.has(k)));
        });
        u.search = raw.length ? '?' + raw.join('&') : '';
        changed = true;
      }
    }
    return changed ? u.href : null;
  }

  let active = false;
  const done = new WeakSet();
  let count = 0;
  let observer = null, scheduled = false;

  function clean(a) {
    if (done.has(a) || !a.hasAttribute('href')) return;
    const raw = a.getAttribute('href');
    if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) return;
    if (!/[?]/.test(raw)) return;
    const next = cleaned(raw, a.baseURI);
    if (next === null) return;
    a.setAttribute('href', next);
    done.add(a);
    count++;
  }

  function sweep() {
    let looked = 0;
    for (const a of document.querySelectorAll('a[href*="?"]')) {
      if (++looked > 5000) break;
      clean(a);
    }
  }
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; if (active) sweep(); }, 600);
  };

  // A link the page rewrites at the moment of the click (Google does, to send
  // the click through its own redirect) is cleaned again right before it is
  // followed. Capture phase: ahead of the page's own handlers for the click;
  // the mouse-down case waits one tick so it runs after the page's rewrite.
  const onPress = (e) => {
    if (!active || !e.target || !e.target.closest) return;
    const a = e.target.closest('a[href]');
    if (!a) return;
    done.delete(a);
    clean(a);
  };
  const onDown = (e) => { setTimeout(() => onPress(e), 0); };

  function start() {
    if (active) return;
    active = true;
    document.addEventListener('click', onPress, true);
    document.addEventListener('auxclick', onPress, true);
    document.addEventListener('contextmenu', onPress, true);
    document.addEventListener('mousedown', onDown, true);
    const attach = () => {
      if (!active || observer || !document.documentElement) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      sweep();
    };
    if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
  function stop() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    for (const [t, f] of [['click', onPress], ['auxclick', onPress], ['contextmenu', onPress]]) document.removeEventListener(t, f, true);
    document.removeEventListener('mousedown', onDown, true);
  }
  const applyState = (s) => { if (s.enabled && s.linksEnabled) start(); else stop(); };

  // The popup asks how many links were cleaned here. A page cannot send this.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || sender.id !== chrome.runtime.id || sender.tab) return;
      if (msg.type === 'quell:links:status') sendResponse({ active, cleaned: count });
    });
  } catch (_) { /* test context */ }

  try {
    globalThis.QuellSettings.onChange(['enabled', 'linksEnabled'], () => readSettings().then(applyState).catch(() => {}));
    globalThis.QuellSettings.onGone(stop);
  } catch (_) { /* test context */ }

  // Test hook: the pure function, so the suite can check it without a page.
  try { window.__quellLinksClean = cleaned; } catch (_) { /* sandbox */ }

  let s = DEFAULTS;
  try { s = await readSettings(); } catch (_) { /* test context */ }
  applyState(s);
})();
