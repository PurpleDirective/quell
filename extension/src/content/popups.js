// Quell — pop-ups layer (0.6.0). OFF by default.
//
// Hides three kinds of nag the user did not ask for:
//   newsletter — sign-up modals and "join our list" boxes
//   chat       — floating chat-widget launchers and panels
//   app        — "open in app" / smart-app install banners
// Rules come from EasyList's annoyance sub-lists via pipeline/build_rules.py
// (rules/popups.json, CC BY-SA 3.0 — see /NOTICE), plus a small curated set of
// chat-vendor launchers and sign-up vendors below. Registered by the background ONLY after the user
// switches Pop-ups on and grants all-sites access, like the cookie layer.
//
// THE RULE THIS FILE EXISTS TO KEEP: never hide page content. Cosmetic only —
// no request is ever blocked — and two guards stand between a selector and the
// page:
//   1. Build time: the pipeline drops any selector whose target is structural
//      (html, body, main, article, #content, .wrapper, …).
//   2. Run time (here), three rules:
//      a. Nothing that is, or holds, the page's own content — main, article,
//         [role=main], an <h1>, or an article's worth of text — and nothing
//         that holds a password field, a sign-in / cart / checkout form, or a
//         dialog about signing in or a cart is ever hidden. A match like that
//         is marked data-quell-keep, which every hide rule excludes.
//      b. GENERIC rules (and the chat seed) hide at once via the stylesheet;
//         rule (a) then puts back anything that was not a nag.
//      c. SITE rules never hide on sight. A per-site rule is often just the
//         site's modal shell (`.modal`, `.ui-dialog`), which also holds its
//         login and cart dialogs (0.6.0 review: artnet, ardene, aritzia, bath
//         and body works, answear). So a site-rule match is hidden only once
//         it looks like what this layer is for — an e-mail field or sign-up /
//         subscribe wording, a known chat widget, or an app-install banner —
//         and passes (a).
// A wrong selector therefore costs, at worst, a nag that stays visible.

(async () => {
  if (window.__quellPopups) return; // double-injection guard
  window.__quellPopups = true;

  const DEFAULTS = {
    enabled: true, popupsEnabled: true, popupAllowlist: [],
    hideNewsletters: true, hideChat: true, hideAppBanners: true,
  };
  const readSettings = () => globalThis.QuellSettings.get(DEFAULTS);

  // Chat launchers by vendor id/class — stable names these vendors document or
  // have shipped for years. Launchers and panels only; never the page.
  const CHAT_SEED = [
    '#intercom-container', '.intercom-lightweight-app', '.intercom-launcher',
    '#hubspot-messages-iframe-container',
    '#drift-frame-controller', '#drift-frame-chat', '#drift-widget-container',
    '#chat-widget-container',            // LiveChat
    '#tidio-chat',
    '.crisp-client',
    '#olark-wrapper',
    '#fc_frame',                         // Freshchat
    '#gorgias-chat-container',
    '#beacon-container', '.BeaconFabButtonFrame', // Help Scout
    '.fb_dialog', '.fb-customerchat',    // Facebook customer chat
  ];

  // Sign-up modals by vendor id, for vendors EasyList's newsletter list does
  // not cover. Attentive (e-mail/SMS sign-up) renders its whole creative —
  // modal and minimised teaser — as one cross-origin iframe; measured live
  // 2026-09-25 on gap.com (full-screen "Get 15% off" over the page, scroll
  // locked) and everlane.com. The iframe is the vendor's own document, so
  // hiding it cannot take page content with it.
  const NEWSLETTER_SEED = [
    'iframe#attentive_creative',
  ];

  const KEEP = ':not([data-quell-keep])';
  const SITE_MARK = 'data-quell-pop';   // set only on verified site-rule matches
  // What counts as "the page". An element that is, or contains, one of these
  // is content, whatever a filter list says about it.
  const CONTENT_SEL = 'main, article, [role="main"], h1';
  const CONTENT_TEXT_LIMIT = 3000; // characters — a modal is short, an article is not

  // Things a user may be in the middle of: signing in, paying, their cart.
  const SENSITIVE_INPUT = 'input[type="password" i], input[autocomplete~="current-password" i], '
    + 'input[autocomplete~="new-password" i], input[autocomplete~="cc-number" i], input[autocomplete~="username" i]';
  const SENSITIVE_FORM_RE = /log-?in|sign-?in|signin|auth|password|account|cart|basket|checkout|payment|billing/i;
  const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog';
  const SENSITIVE_TEXT_RE = /\b(sign[\s-]?in|log[\s-]?in|password|checkout|check out|your (cart|bag|basket)|shopping (cart|bag|basket)|added to (your )?(cart|bag|basket)|order summary)\b/i;

  // What this layer is FOR, used to confirm a site-rule match.
  const EMAIL_INPUT = 'input[type="email" i], input[name*="email" i], input[id*="email" i], '
    + 'input[autocomplete~="email" i], input[placeholder*="email" i], input[placeholder*="e-mail" i]';
  const SIGNUP_RE = /newsletter|subscri|sign[\s-]?up|mailing list|e-?mail (list|updates|offers)|join (our|the) (list|club|community)/i;
  const CHAT_RE = /intercom|drift|zendesk|zopim|tawk|crisp|hubspot-messages|livechat|tidio|olark|freshchat|fc_frame|gorgias|helpscout|beacon|chat[-_ ]?(widget|launcher|bubble|button)/i;
  const APP_RE = /open in (the )?app|get the app|download (the|our) app|use the app|install (the|our) app|smart-?banner|app store|google play/i;
  const APP_LINK = 'a[href*="apps.apple.com"], a[href*="itunes.apple.com"], a[href*="play.google.com"]';

  let active = false;
  let selectors = [];   // generic + seed: hidden by stylesheet at once
  let siteSelectors = []; // this host's rules: hidden only once verified
  let observer = null;
  let lockObserver = null; // <html>/<body> style+class only (late scroll locks)
  let scheduled = false;
  let lastSweep = 0;
  let overlaySeen = false;
  let unlockStyle = null; // Quell's own <style>; toggled via .sheet.disabled (no DOM mutation)

  let styleRetries = 0;
  const addStyle = (id, css) => {
    if (document.getElementById(id)) return;
    const root = document.head || document.documentElement;
    // Nothing to attach to yet (executeScript into an open tab, or a very
    // early injection): retry, bounded, and never after a teardown.
    if (!root) {
      if (++styleRetries > 50 || !active) return;
      setTimeout(() => { if (active) addStyle(id, css); }, 0);
      return;
    }
    const st = document.createElement('style');
    st.id = id;
    st.textContent = css;
    root.appendChild(st);
  };
  const dropStyle = (id) => document.getElementById(id)?.remove();

  const buildCSS = (sels) => {
    const out = [];
    // Chunked like the cookie sheet: one selector the browser rejects only
    // voids its own chunk, not the whole layer.
    for (let i = 0; i < sels.length; i += 150) {
      out.push(sels.slice(i, i + 150).map((s) => s + KEEP).join(',') + '{display:none!important;}');
    }
    return out.join('\n');
  };

  const isContent = (el) => {
    if (el === document.documentElement || el === document.body) return true;
    if (el.matches(CONTENT_SEL) || el.querySelector(CONTENT_SEL)) return true;
    return (el.textContent || '').length > CONTENT_TEXT_LIMIT;
  };

  // Text of an element with its text nodes SPACE-separated. textContent
  // glues adjacent elements together ("<h2>Added to your cart</h2><p>1 ×"
  // reads "cart1 ×"), which silently defeats every \b-bounded pattern below —
  // found by mutation-testing the cart guard. Bounded: at most `max` chars.
  const textOf = (el, max) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let n = w.nextNode(); n && out.length < max; n = w.nextNode()) {
      const t = n.nodeValue.trim();
      if (t) out += (out ? ' ' : '') + t;
    }
    return out.slice(0, max);
  };

  const attrText = (el) => [el.id, el.getAttribute('class'), el.getAttribute('name'),
    el.getAttribute('action'), el.getAttribute('aria-label'), el.getAttribute('title'),
    el.getAttribute('src')].filter(Boolean).join(' ');

  // Rule (a), second half: never hide a sign-in, cart or checkout surface.
  const isSensitive = (el) => {
    if (el.matches(SENSITIVE_INPUT) || el.querySelector(SENSITIVE_INPUT)) return true;
    const forms = [el.closest('form'), ...el.querySelectorAll('form')].filter(Boolean);
    if (forms.some((f) => SENSITIVE_FORM_RE.test(attrText(f)))) return true;
    const dialogs = [el.closest(DIALOG_SEL), ...(el.matches(DIALOG_SEL) ? [el] : []), ...el.querySelectorAll(DIALOG_SEL)]
      .filter(Boolean);
    for (const d of dialogs) {
      const label = attrText(d) + ' ' + textOf(d, 2000);
      if (SENSITIVE_TEXT_RE.test(label)) return true;
    }
    return false;
  };

  // Rule (c): does a site-rule match look like a sign-up, chat or app nag?
  const looksLikeNag = (el) => {
    if (el.matches(EMAIL_INPUT) || el.querySelector(EMAIL_INPUT)) return true;
    const own = attrText(el);
    const text = textOf(el, 1500);
    if (SIGNUP_RE.test(own) || SIGNUP_RE.test(text)) return true;
    const frames = [...el.querySelectorAll('iframe')].map(attrText).join(' ');
    if (CHAT_RE.test(own) || CHAT_RE.test(frames)) return true;
    if (APP_RE.test(own) || APP_RE.test(text) || el.querySelector(APP_LINK)) return true;
    return false;
  };

  // Is a surface the SITE put up on screen right now — a dialog, a drawer, a
  // lightbox — that Quell did not hide? A checkout or login drawer does not
  // always carry role=dialog, so any visible fixed panel covering a quarter of
  // the viewport counts too (a sticky header is far smaller).
  const SITE_DIALOG = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const QUELL_OWNED = '[data-quell-hidden], [' + SITE_MARK + '], [data-quell-popup-seen="1"]';
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };
  const siteSurfaceOpen = () => {
    for (const d of document.querySelectorAll(SITE_DIALOG)) {
      if (!d.closest(QUELL_OWNED) && shown(d)) return true;
    }
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (el.closest(QUELL_OWNED)) continue;
      if (getComputedStyle(el).position !== 'fixed') continue;
      const r = shown(el);
      if (r && r.width * r.height >= 0.25 * vw * vh) return true;
    }
    return false;
  };

  // Scroll-lock release, gated on having hidden a BLOCKING overlay on this
  // page (a newsletter/sign-up modal — never a chat bubble, which never locks
  // scroll). The override is Quell's own stylesheet, switched with
  // sheet.disabled: that is not a DOM change, so neither observer re-fires on
  // it, and switching it off lets every pass read the SITE's lock as it is
  // now. A lock the site sets later — a checkout, login or cart drawer the
  // user opened — stays the site's: while any site surface is on screen,
  // Quell does not unlock.
  const unlock = () => {
    if (!overlaySeen) { if (unlockStyle) unlockStyle.sheet.disabled = true; return; }
    if (!unlockStyle) {
      unlockStyle = document.createElement('style');
      unlockStyle.id = 'quell-unlock';
      unlockStyle.textContent = 'html,body{overflow:auto!important}';
      (document.head || document.documentElement).appendChild(unlockStyle);
    }
    const sheet = unlockStyle.sheet;
    if (!sheet) return;
    sheet.disabled = true;
    const locked = [document.documentElement, document.body].some((el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.overflow === 'hidden' || cs.overflowY === 'hidden';
    });
    sheet.disabled = !(locked && !siteSurfaceOpen());
  };
  const relock = () => {
    if (unlockStyle) { unlockStyle.remove(); unlockStyle = null; }
  };

  const queryAll = (sels) => {
    const found = new Set();
    for (let i = 0; i < sels.length; i += 150) {
      try {
        for (const el of document.querySelectorAll(sels.slice(i, i + 150).join(','))) found.add(el);
      } catch (_) {
        // One invalid selector voids the chunk for querySelectorAll too; fall
        // back to one at a time so the guard still sees every match.
        for (const s of sels.slice(i, i + 150)) {
          try { for (const el of document.querySelectorAll(s)) found.add(el); } catch (_) { /* skip */ }
        }
      }
    }
    return found;
  };

  const count = (el) => {
    if (el.dataset.quellPopupSeen === '1') return 0;
    el.dataset.quellPopupSeen = '1';
    const pos = getComputedStyle(el).position;
    // A chat launcher is fixed too, but it never locks the page; only a
    // blocking overlay may justify releasing a scroll lock.
    const chat = CHAT_RE.test(attrText(el)) ||
      [...el.querySelectorAll('iframe')].some((f) => CHAT_RE.test(attrText(f)));
    if ((pos === 'fixed' || pos === 'sticky') && !chat) overlaySeen = true;
    return 1;
  };

  const sweep = () => {
    lastSweep = Date.now();
    if (!document.body || (!selectors.length && !siteSelectors.length)) return;
    let n = 0;
    // Generic rules: already hidden by the stylesheet — put back anything that
    // is content or a sign-in / cart surface.
    for (const el of queryAll(selectors)) {
      if (el.hasAttribute('data-quell-keep')) continue;
      if (isContent(el) || isSensitive(el)) { el.setAttribute('data-quell-keep', '1'); continue; }
      n += count(el);
    }
    // Site rules: hide only what is verifiably a nag.
    for (const el of queryAll(siteSelectors)) {
      if (el.hasAttribute('data-quell-keep') || el.hasAttribute(SITE_MARK)) continue;
      if (isContent(el) || isSensitive(el)) { el.setAttribute('data-quell-keep', '1'); continue; }
      if (!looksLikeNag(el)) continue; // not (yet) a nag — re-checked next sweep
      el.setAttribute(SITE_MARK, '1');
      n += count(el);
    }
    unlock();
    if (n > 0) {
      try { chrome.runtime.sendMessage({ type: 'blocked', count: n }); } catch (_) { /* sw asleep */ }
    }
  };

  // Querying ~1,400 selectors per mutation burst would tax busy pages, so the
  // sweep is throttled; the stylesheet itself hides instantly regardless.
  const SWEEP_EVERY_MS = 400;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const wait = Math.max(0, SWEEP_EVERY_MS - (Date.now() - lastSweep));
    setTimeout(() => { scheduled = false; if (active) sweep(); }, wait);
  };

  async function apply(s) {
    let rules = { generic: [], site: [] };
    try {
      rules = await chrome.runtime.sendMessage({
        type: 'popupRules',
        cats: [s.hideNewsletters && 'newsletter', s.hideChat && 'chat', s.hideAppBanners && 'app'].filter(Boolean),
      }) || rules;
    } catch (_) { /* background asleep — seed only */ }
    const next = [
      ...(s.hideNewsletters ? NEWSLETTER_SEED : []),
      ...(s.hideChat ? CHAT_SEED : []),
      ...(rules.generic || []),
    ];
    // Replace, don't stack: a live category toggle must be able to shrink it,
    // and site-rule verdicts are re-taken against the new category set.
    dropStyle('quell-popups');
    clearSiteMarks();
    selectors = next;
    siteSelectors = rules.site || [];
    active = next.length > 0 || siteSelectors.length > 0;
    if (!active) { teardown(); return; }
    addStyle('quell-popups', buildCSS(next) + `\n[${SITE_MARK}]${KEEP}{display:none!important;}`);
    const attach = () => {
      if (!active) return;
      if (!observer && document.documentElement) {
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        // A vendor usually locks the page AFTER inserting its overlay, by
        // setting a style or class on <html>/<body> — an attribute change a
        // childList observer never sees, which left the page unscrollable
        // behind an overlay Quell had already hidden (Attentive, live
        // 2026-09-25). Watched on those two elements only, never the subtree,
        // and by a SECOND observer: observing <html> again on the first one
        // would replace its childList/subtree options.
        lockObserver = new MutationObserver(schedule);
        for (const el of [document.documentElement, document.body]) {
          if (el) lockObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      sweep();
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  function clearSiteMarks() {
    for (const el of document.querySelectorAll(`[${SITE_MARK}]`)) el.removeAttribute(SITE_MARK);
  }

  function teardown() {
    active = false;
    selectors = [];
    siteSelectors = [];
    clearSiteMarks();
    if (observer) { observer.disconnect(); observer = null; }
    if (lockObserver) { lockObserver.disconnect(); lockObserver = null; }
    dropStyle('quell-popups');
    relock();
    overlaySeen = false;
  }

  const applyState = (s) => {
    const paused = (s.popupAllowlist || []).includes(location.hostname);
    const anyCat = s.hideNewsletters || s.hideChat || s.hideAppBanners;
    if (s.enabled && s.popupsEnabled && anyCat && !paused) return apply(s);
    teardown();
  };

  try {
    globalThis.QuellSettings.onChange(
      ['enabled', 'popupsEnabled', 'popupAllowlist', 'hideNewsletters', 'hideChat', 'hideAppBanners'],
      () => readSettings().then(applyState).catch(() => {}));
    // Cut off from the extension: stop hiding (see onGone in settings.js).
    globalThis.QuellSettings.onGone(teardown);
  } catch (_) { /* test context */ }

  let s = DEFAULTS;
  try { s = await readSettings(); } catch (_) { /* test context */ }
  applyState(s);
})();
