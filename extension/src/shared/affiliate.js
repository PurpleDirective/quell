// Quell — affiliate-swap warning (0.7.4), the Links group. WARNS ONLY.
//
// Some sites and extensions replace the affiliate code in a shopping link after
// you have arrived, so the person who sent you is not the one who gets paid.
// When the switch "Warn me if a site swaps an affiliate code" is on, Quell
// notices that on Amazon product and cart pages and says so, in a small notice
// in the page corner. It never changes an address, never blocks a request and
// never "fixes" a code. Nothing is sent anywhere: the codes are compared in
// this browser and kept for the life of the tab only.
//
// TWO INDEPENDENT SIGNALS, BOTH REQUIRED, so a normal visit never warns:
//   1. The tag= affiliate parameter on a product or cart page changed or
//      appeared compared with the previous Amazon product or cart page in the
//      same tab.
//   2. That page was reached by a navigation the user did not make: the
//      browser reports it as a client or server redirect (webNavigation
//      transitionQualifiers), and not as something typed, bookmarked, reloaded,
//      submitted from a form or gone back to.
// A click on a link (a normal "link" navigation with no redirect) and a visit
// that arrives from outside Amazon (no earlier Amazon page in the tab) never
// qualify.
//
// Needs the optional webNavigation permission, requested by the popup when the
// switch is turned on; without it this file does nothing. The page notice is
// put in with scripting.executeScript, under the all-sites access the Links
// switch already holds.

(() => {
  const g = globalThis;
  if (g.QuellAffiliate) return;

  const AMAZON_HOST = /(^|\.)amazon\.(com|co\.uk|de|fr|it|es|ca|com\.au|co\.jp|in|nl|se|pl|sg|ae|sa|com\.br|com\.mx|com\.tr|eg|com\.be)$/;
  // Product and cart pages: /dp/<asin>, /gp/product/<asin>, /gp/aw/d/<asin>, the cart.
  const PAGE_PATH = /(\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/gp\/cart|\/cart(\/|$)|\/gp\/buy)/;
  // Navigations the user made.
  const USER_TYPES = ['typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated', 'form_submit', 'reload'];
  const USER_QUALIFIERS = ['from_address_bar', 'forward_back'];
  const REDIRECT_QUALIFIERS = ['client_redirect', 'server_redirect'];
  const SESSION_PREFIX = 'aff:';
  const PENDING_PREFIX = 'affpending:';

  function parse(url) {
    try {
      const u = new URL(url);
      if (!AMAZON_HOST.test(u.hostname)) return null;
      return { page: PAGE_PATH.test(u.pathname), tag: u.searchParams.get('tag') || '' };
    } catch (_) { return null; }
  }

  // The decision, as a pure function. `prev` is what the tab last showed on
  // Amazon ({page, tag}) or null; `nav` is {url, type, qualifiers}.
  // Returns { warn, tag, why }.
  function decide(prev, nav) {
    const now = parse(nav.url);
    if (!now || !now.page) return { warn: false, tag: null, why: 'not an Amazon product or cart page' };
    if (!prev || !prev.page) return { warn: false, tag: now.tag, why: 'no earlier Amazon page in this tab' };
    // Signal 1: the code changed or appeared.
    const changed = !!now.tag && now.tag !== prev.tag;
    if (!changed) return { warn: false, tag: now.tag, why: 'the tag did not change' };
    // Signal 2: not the user's own navigation.
    const q = nav.qualifiers || [];
    if (USER_TYPES.includes(nav.type) || q.some((x) => USER_QUALIFIERS.includes(x))) {
      return { warn: false, tag: now.tag, why: 'the user navigated' };
    }
    if (!q.some((x) => REDIRECT_QUALIFIERS.includes(x))) {
      return { warn: false, tag: now.tag, why: 'an ordinary link, no redirect' };
    }
    return { warn: true, tag: now.tag, why: 'tag changed by a redirect' };
  }

  // Runs IN the page (scripting.executeScript func): must be self-contained.
  // A small, dismissible notice in the corner, in a shadow root so the site's
  // styles cannot touch it and it cannot touch the site's.
  function showNotice() {
    if (document.getElementById('quell-affiliate-notice')) return;
    const host = document.createElement('div');
    host.id = 'quell-affiliate-notice';
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'font:13px/1.4 system-ui,sans-serif;color:#1c1530;background:#fff;border:1px solid #d9d2ee;border-radius:12px;'
      + 'box-shadow:0 4px 18px rgba(30,20,60,.18);padding:12px 14px;max-width:300px;display:flex;gap:10px;align-items:flex-start';
    const text = document.createElement('div');
    const p = document.createElement('div');
    p.textContent = 'This page just changed its affiliate code. Quell did not change anything.';
    const a = document.createElement('a');
    a.textContent = 'Learn more';
    a.href = 'https://purpledirective.com/quell';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'color:#5b21b6;font-weight:600;display:inline-block;margin-top:4px';
    text.append(p, a);
    const x = document.createElement('button');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.textContent = '×';
    x.style.cssText = 'all:unset;cursor:pointer;font-size:18px;line-height:1;color:#6b6585;padding:0 2px';
    x.addEventListener('click', () => host.remove());
    box.append(text, x);
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(host);
  }

  let attached = false;
  const sess = () => (g.chrome && chrome.storage && chrome.storage.session) || null;
  const getSess = async (k) => { const s = sess(); if (!s) return null; return (await s.get(k).catch(() => ({})))[k] || null; };
  const setSess = (k, v) => { const s = sess(); return s ? s.set({ [k]: v }).catch(() => {}) : Promise.resolve(); };
  const dropSess = (k) => { const s = sess(); return s ? s.remove(k).catch(() => {}) : Promise.resolve(); };

  async function enabled() {
    try {
      const s = await g.QuellSettings.get({ enabled: true, linksEnabled: false, linksWarnAffiliate: false });
      return !!(s.enabled && s.linksEnabled && s.linksWarnAffiliate);
    } catch (_) { return false; }
  }

  // Events arrive faster than storage answers (a small page can finish loading
  // before the commit has been judged), so they are handled one after another.
  let chain = Promise.resolve();
  const serial = (fn) => (d) => { chain = chain.then(() => fn(d)).catch(() => {}); return chain; };

  async function onNavigated(d) {
    if (d.frameId !== 0 || !d.url) return;
    const now = parse(d.url);
    const key = SESSION_PREFIX + d.tabId;
    if (!(await enabled())) { if (!now) await dropSess(key); return; }
    if (!now) { await dropSess(key); return; }
    const prev = await getSess(key);
    const verdict = decide(prev, { url: d.url, type: d.transitionType, qualifiers: d.transitionQualifiers });
    if (now.page) await setSess(key, { page: true, tag: now.tag });
    if (verdict.warn) await setSess(PENDING_PREFIX + d.tabId, 1);
  }

  async function onDone(d) {
    if (d.frameId !== 0) return;
    const key = PENDING_PREFIX + d.tabId;
    if (!(await getSess(key))) return;
    await dropSess(key);
    if (!(await enabled())) return;
    try { await chrome.scripting.executeScript({ target: { tabId: d.tabId }, func: showNotice }); } catch (_) { /* no access to the tab */ }
  }

  // Attach once, and only where the optional permission exists. The events are
  // limited to Amazon hosts, so the worker is not woken for any other page.
  function attach() {
    if (attached) return true;
    const wn = g.chrome && chrome.webNavigation;
    if (!wn || !wn.onCommitted) return false;
    const filter = { url: [{ hostContains: 'amazon.' }] };
    const nav = serial(onNavigated), done = serial(onDone);
    wn.onCommitted.addListener(nav, filter);
    if (wn.onHistoryStateUpdated) wn.onHistoryStateUpdated.addListener(nav, filter);
    if (wn.onCompleted) wn.onCompleted.addListener(done, filter);
    // The earlier Amazon page only counts while the tab stays on Amazon: a trip
    // through another site (a blog's affiliate link that redirects to a product)
    // is a new visit, not a swap. Address changes reach this listener only where
    // Quell has all-sites access, which this feature needs anyway.
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (!info.url) return;
        let host = '';
        try { host = new URL(info.url).hostname; } catch (_) { return; }
        if (!AMAZON_HOST.test(host)) dropSess(SESSION_PREFIX + tabId);
      });
    }
    if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((tabId) => { dropSess(SESSION_PREFIX + tabId); dropSess(PENDING_PREFIX + tabId); });
    attached = true;
    return true;
  }

  async function sync(on) {
    if (on) attach();
    if (!on) {
      // Nothing is kept once the switch is off.
      const s = sess();
      if (s) { const all = await s.get(null).catch(() => ({})); const ks = Object.keys(all).filter((k) => k.startsWith(SESSION_PREFIX) || k.startsWith(PENDING_PREFIX)); if (ks.length) await s.remove(ks).catch(() => {}); }
    }
  }

  attach();

  g.QuellAffiliate = { decide, parse, showNotice, sync, attach, AMAZON_HOST, PAGE_PATH };
})();
