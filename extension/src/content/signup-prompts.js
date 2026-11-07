// Quell — sign-up and log-in prompts (0.7.4), part of the Pop-ups group.
//
// Closes the soft walls that interrupt reading with "Sign up", "Log in" or
// "Create an account" while the page itself is already there: a dialog or a
// dimmed layer over an article, a profile, a pin, a post. Registered with
// popups.js (same grant, same per-site pause, same master switch), with its
// own switch, hideSignupPrompts (on whenever Pop-ups is on).
//
// WHAT IT NEVER DOES
//   - No paywall is defeated. Nothing is fetched, no text is revealed that the
//     server did not already send; a page whose content is withheld stays as
//     the server serves it. Only the prompt, its dim layer and the scroll lock
//     are taken off, and a block that clips text already in the page is let
//     out (see unclamp()).
//   - A login the user asked for is left alone: a click on a sign-in / sign-up
//     control, or an address that is a login or account page, switches this off
//     for what appears next. The page's own header Sign in button is never
//     touched: nothing inside header / nav / banner is ever a candidate, and
//     only layers that are fixed over the page can be.
//   - Cosmetic only, like the rest of the layer. Nothing is sent anywhere.
//
// HOW IT FINDS ONE
//   Generic: a dialog (role=dialog, aria-modal, <dialog open>) or a fixed layer
//   that covers a fifth of the window, or a fixed bar along the bottom edge,
//   whose own text is about signing up or in, over a page that has content of
//   its own. Per site: the few prompts whose markup was read on the live site
//   (SITE below), still behind every guard above.

(async () => {
  if (window.__quellPrompts) return; // double-injection guard
  window.__quellPrompts = true;

  const DEFAULTS = { enabled: true, popupsEnabled: true, popupAllowlist: [], hideSignupPrompts: true };
  const readSettings = () => globalThis.QuellSettings.get(DEFAULTS);

  // Per-site prompts, read on the live pages 2026-11-06 (logged out, headless
  // Chromium). `sel` is the prompt's own root; the guards still apply.
  const SITE = [
    // LinkedIn public pages: the "Sign in to see who you already know" modal.
    // Sets overflow-hidden on <body>.
    { host: /(^|\.)linkedin\.com$/, sel: ['#base-contextual-sign-in-modal'] },
    // Pinterest, logged out: the "You are signed out" card at the bottom right.
    // (The full-screen "Welcome to Pinterest" login dialog is found generically.)
    { host: /(^|\.)pinterest\.[a-z.]+$/, sel: ['[data-test-id="bottom-right-upsell"]'] },
    // The Washington Post: the dismissible soft-wall notice ("Collapse
    // notification"), id softwall-<hash>.
    { host: /(^|\.)washingtonpost\.com$/, sel: ['div[id^="softwall-"]'] },
  ];
  const siteSel = SITE.filter((s) => s.host.test(location.hostname)).flatMap((s) => s.sel);

  const MARK = 'data-quell-prompt';       // set on a prompt (or its dim layer) Quell hid
  const KEEP = 'data-quell-prompt-keep';  // set on a layer that is the user's own
  const NAV_SEL = 'header, nav, [role="banner"], [role="navigation"]';
  const DIALOG_SEL = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]';
  const CONTENT_SEL = 'main, article, [role="main"]';
  const PROMPT_RE = /\b(sign[\s-]?up|sign[\s-]?in|log[\s-]?in|log into|create (?:a |an |your )?(?:free )?account|continue with (?:google|apple|facebook|email|phone)|join (?:now|free|for free|today)|register (?:now|for free)|already have an account)\b/i;
  // A page that IS a login or account page, by address.
  const LOGIN_PATH_RE = /(^|[/_.-])(log-?in|sign-?in|sign-?up|signup|register|registration|auth|oauth|sso|account|accounts|checkout|session|password)([/_.?-]|$)/i;
  // A click on a control like these is the user asking for a login.
  const ASKED_RE = /\b(log ?in|sign ?in|sign ?up|register|join|create (?:an? )?account|my account|account)\b/i;
  const ASK_WINDOW_MS = 20000;
  const SCAN_EVERY_MS = 1200;
  const SCAN_CAP = 8000; // elements looked at per scan

  let active = false;
  let observer = null, lockObserver = null;
  let scheduled = false, lastScan = 0;
  let lastAsk = 0;
  let hiddenCount = 0;
  let unlockStyle = null;
  const kept = new WeakSet();
  let notFixed = new WeakSet();   // elements already seen not to be position:fixed
  let listening = false;

  const textOf = (el, max) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let out = '';
    for (let n = w.nextNode(); n && out.length < max; n = w.nextNode()) {
      const t = n.nodeValue.trim();
      if (t) out += (out ? ' ' : '') + t;
    }
    return out.slice(0, max);
  };
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? r : null;
  };

  // The user asking for a sign-in is read from a TRUSTED click (or Enter) on a
  // control whose own words say so.
  const onAsk = (e) => {
    if (!e.isTrusted) return;
    const t = e.target && e.target.closest ? e.target.closest('a, button, [role="button"], [role="link"], summary, input[type="submit"]') : null;
    if (!t) return;
    const label = (t.textContent || '') + ' ' + (t.getAttribute('aria-label') || '') + ' ' + (t.getAttribute('title') || '') + ' ' + (t.getAttribute('href') || '');
    if (ASKED_RE.test(label.slice(0, 300))) lastAsk = Date.now();
  };
  const onKey = (e) => { if (e.key === 'Enter') onAsk(e); };
  const askedRecently = () => Date.now() - lastAsk < ASK_WINDOW_MS;

  // The address says the user is on a login or account page.
  const onLoginPage = () => LOGIN_PATH_RE.test(location.pathname) || /[?&](login|signin|auth)=/i.test(location.search);

  // The page behind the prompt has content of its own, or this is a login page
  // the user went to and the prompt is the page.
  const pageHasContentOutside = (layer) => {
    const body = document.body;
    if (!body) return false;
    const outside = Math.max(0, (body.innerText || '').length - (layer.innerText || '').length);
    if (outside >= 250) return true;
    let links = 0;
    for (const a of body.querySelectorAll('a[href], img')) { if (!layer.contains(a) && ++links >= 15) return true; }
    return false;
  };
  // A visible password field outside the candidate: the page is a login page.
  const loginFormOutside = (layer) => {
    for (const i of document.querySelectorAll('input[type="password" i]')) {
      if (!layer.contains(i) && !i.closest('[' + MARK + ']') && shown(i)) return true;
    }
    return false;
  };

  const layerRoot = (el) => {
    let r = el;
    while (r.parentElement && r.parentElement !== document.body && r.parentElement !== document.documentElement
      && getComputedStyle(r.parentElement).position === 'fixed') r = r.parentElement;
    return r;
  };

  // A dialog is a prompt candidate at any size above a card; an untagged fixed
  // layer needs to cover a fifth of the window.
  const looksLikePrompt = (layer, rect, isDialog) => {
    const vw = innerWidth, vh = innerHeight;
    const area = rect.width * rect.height;
    const bigLayer = area >= 0.2 * vw * vh || (isDialog && rect.width >= 200 && rect.height >= 100);
    const bottomBar = rect.width >= 0.8 * vw && rect.height >= 40 && rect.height <= 0.4 * vh && rect.bottom >= vh - 2;
    if (!bigLayer && !bottomBar) return false;
    const text = textOf(layer, 900);
    if (!PROMPT_RE.test(text)) return false;
    if (layer.matches(CONTENT_SEL) || layer.querySelector(CONTENT_SEL) || textOf(layer, 3100).length > 3000) return false;
    return true;
  };

  const siteSurfaceOpen = () => {
    for (const d of document.querySelectorAll(DIALOG_SEL)) {
      if (!d.closest('[' + MARK + ']') && shown(d) && !d.closest(NAV_SEL)) return true;
    }
    return false;
  };

  function hide(layer) {
    layer.setAttribute(MARK, '1');
    hiddenCount++;
  }

  // The dim or blur layer a prompt leaves behind is an EMPTY fixed layer: no
  // text, no controls. Only taken once a prompt was hidden, and never while
  // another dialog of the site is open.
  function hideScrims() {
    if (!hiddenCount || siteSurfaceOpen()) return 0;
    let n = 0;
    const vw = innerWidth, vh = innerHeight;
    let looked = 0;
    for (const el of document.body.querySelectorAll('div, section, span')) {
      if (++looked > SCAN_CAP) break;
      if (el.hasAttribute(MARK) || el.closest('[' + MARK + ']') || el.closest(NAV_SEL)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 0.85 * vw || r.height < 0.85 * vh) continue;
      if ((el.innerText || '').trim() || el.querySelector('input, button, a, img, video, canvas, iframe')) continue;
      const bg = (cs.backgroundColor.match(/[\d.]+/g) || []);
      const alpha = bg.length === 4 ? +bg[3] : (cs.backgroundColor === 'transparent' ? 0 : 1);
      if (alpha > 0.02 || cs.backdropFilter !== 'none') { el.setAttribute(MARK, '1'); n++; }
    }
    return n;
  }

  // Scroll lock and blur: released while a prompt of ours is hidden and no
  // dialog of the site's own is open. Quell's own stylesheet, switched with
  // sheet.disabled, as popups.js does it.
  function unlock() {
    if (!hiddenCount) { if (unlockStyle) unlockStyle.sheet.disabled = true; return; }
    if (!unlockStyle) {
      unlockStyle = document.createElement('style');
      unlockStyle.id = 'quell-prompt-unlock';
      unlockStyle.textContent = 'html,body{overflow:auto!important;position:static!important;height:auto!important;max-height:none!important}'
        + `[data-quell-unblur]{filter:none!important;-webkit-filter:none!important;backdrop-filter:none!important}`
        + `[data-quell-unclamp]{max-height:none!important;height:auto!important;overflow:visible!important}`;
      (document.head || document.documentElement).appendChild(unlockStyle);
    }
    const sheet = unlockStyle.sheet;
    if (!sheet) return;
    const open = siteSurfaceOpen();
    // Read the site's own lock as it is now, with our override off.
    sheet.disabled = true;
    const locked = [document.documentElement, document.body].some((el) => {
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.overflowY === 'hidden' || cs.position === 'fixed';
    });
    sheet.disabled = !(locked && !open);
    if (!open) { unblur(); unclamp(); }
  }

  // Blur the page was given behind the prompt: html, body and their direct
  // children, only where the filter is a blur or a brightness drop.
  function unblur() {
    const els = [document.documentElement, document.body, ...(document.body ? document.body.children : [])];
    for (const el of els) {
      if (!el || el.hasAttribute('data-quell-unblur') || el.hasAttribute(MARK)) continue;
      const cs = getComputedStyle(el);
      if (/blur\(|brightness\(/.test(cs.filter || '')) el.setAttribute('data-quell-unblur', '1');
    }
  }

  // Text the server sent that the page clips behind the prompt: a block inside
  // the article that has a max-height with overflow hidden, holds a full read
  // of text, and is clipped well short of it. Nothing is fetched or invented:
  // if the text is not in the page, scrollHeight is not larger and nothing
  // matches.
  function unclamp() {
    for (const host of document.querySelectorAll(CONTENT_SEL)) {
      let looked = 0;
      for (const el of host.querySelectorAll('div, section')) {
        if (++looked > 400) break;
        if (el.hasAttribute('data-quell-unclamp') || el.closest('[' + MARK + ']')) continue;
        if (el.scrollHeight < el.clientHeight * 1.5 || el.clientHeight < 100) continue;
        const cs = getComputedStyle(el);
        if (cs.overflowY !== 'hidden' || cs.maxHeight === 'none') continue;
        if ((el.innerText || '').length < 800) continue;
        el.setAttribute('data-quell-unclamp', '1');
      }
    }
  }

  function scan() {
    lastScan = Date.now();
    if (!document.body || !active) return;
    if (onLoginPage()) { unlock(); return; }
    let n = 0;
    const vw = innerWidth, vh = innerHeight;
    const cands = new Set();
    for (const el of document.querySelectorAll(DIALOG_SEL)) cands.add(el);
    for (const el of siteSel.length ? document.querySelectorAll(siteSel.join(',')) : []) cands.add(el);
    let looked = 0;
    for (const el of document.body.querySelectorAll('div, section, aside, form')) {
      if (++looked > SCAN_CAP) break;
      if (cands.has(el) || notFixed.has(el)) continue;
      // Only elements not yet judged cost a style read, so a feed that keeps
      // adding nodes does not make every scan a full-document one.
      if (getComputedStyle(el).position === 'fixed') cands.add(el); else notFixed.add(el);
    }
    const bySite = siteSel.length ? new Set(document.querySelectorAll(siteSel.join(','))) : new Set();
    for (const c of cands) {
      if (!c.isConnected || c.hasAttribute(MARK) || c.closest('[' + MARK + ']')) continue;
      if (c.closest(NAV_SEL)) continue;                   // the page's own header / nav
      const layer = layerRoot(c);
      if (layer.hasAttribute(MARK) || kept.has(layer) || layer.hasAttribute(KEEP)) continue;
      if (layer.closest(NAV_SEL) || layer === document.body || layer === document.documentElement) continue;
      // A wrapper whose only child is the fixed card has no box of its own.
      let rect = shown(layer);
      if (!rect) { for (const d of layer.querySelectorAll('*')) { if ((rect = shown(d))) break; } }
      if (!rect) continue;
      // A login the user asked for stays, for good: the layer is theirs.
      if (askedRecently()) { kept.add(layer); layer.setAttribute(KEEP, '1'); continue; }
      if (loginFormOutside(layer)) continue;
      const bySiteRule = bySite.has(c);
      if (!bySiteRule && !looksLikePrompt(layer, rect, c.matches(DIALOG_SEL) || !!layer.querySelector(DIALOG_SEL))) continue;
      if (bySiteRule && (layer.matches(CONTENT_SEL) || layer.querySelector(CONTENT_SEL))) continue;
      if (!pageHasContentOutside(layer)) continue;
      hide(layer);
      n++;
    }
    n += hideScrims();
    unlock();
    if (n > 0) {
      try { chrome.runtime.sendMessage({ type: 'blocked', count: n, feature: 'popups' }); } catch (_) { /* sw asleep */ }
    }
  }

  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; if (active) scan(); }, Math.max(0, SCAN_EVERY_MS - (Date.now() - lastScan)));
  };

  let styleTries = 0;
  const addStyle = () => {
    if (document.getElementById('quell-prompts')) return;
    const root = document.head || document.documentElement;
    if (!root) { if (++styleTries <= 50 && active) setTimeout(addStyle, 0); return; }
    const st = document.createElement('style');
    st.id = 'quell-prompts';
    st.textContent = `[${MARK}="1"]{display:none!important}`;
    root.appendChild(st);
  };

  function start() {
    if (active) return;
    active = true;
    addStyle();
    document.addEventListener('click', onAsk, true);
    document.addEventListener('keydown', onKey, true);
    const attach = () => {
      if (!active || observer || !document.documentElement) return;
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      lockObserver = new MutationObserver(schedule);
      for (const el of [document.documentElement, document.body]) {
        if (el) lockObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
      }
      scan();
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  function stop() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    if (lockObserver) { lockObserver.disconnect(); lockObserver = null; }
    document.removeEventListener('click', onAsk, true);
    document.removeEventListener('keydown', onKey, true);
    notFixed = new WeakSet();
    for (const el of document.querySelectorAll(`[${MARK}]`)) el.removeAttribute(MARK);
    for (const a of ['data-quell-unblur', 'data-quell-unclamp']) {
      for (const el of document.querySelectorAll(`[${a}]`)) el.removeAttribute(a);
    }
    document.getElementById('quell-prompts')?.remove();
    if (unlockStyle) { unlockStyle.remove(); unlockStyle = null; }
    hiddenCount = 0;
  }

  const applyState = (s) => {
    const paused = (s.popupAllowlist || []).includes(location.hostname);
    if (s.enabled && s.popupsEnabled && s.hideSignupPrompts && !paused) start();
    else stop();
  };

  // Listed by the popup, Peek and Undo (see QuellSettings.hidden).
  try {
    globalThis.QuellSettings.hidden.register('popup', () => {
      if (!active) return [];
      return [...document.querySelectorAll(`[${MARK}="1"]`)]
        .filter((el) => (el.innerText || el.textContent || '').trim() || el.querySelector('[role="dialog"], button, a'))
        .map((el) => ({ el, label: 'Sign-up prompt', detail: 'Hidden' }));
    }, () => active);
    globalThis.QuellSettings.hidden.listen();
  } catch (_) { /* test context */ }

  try {
    globalThis.QuellSettings.onChange(['enabled', 'popupsEnabled', 'popupAllowlist', 'hideSignupPrompts'],
      () => readSettings().then(applyState).catch(() => {}));
    globalThis.QuellSettings.onGone(stop);
  } catch (_) { /* test context */ }

  let s = DEFAULTS;
  try { s = await readSettings(); } catch (_) { /* test context */ }
  applyState(s);
})();
