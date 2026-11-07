// Quell — one settings module for every context: background, popup, welcome
// page and the content scripts. Loaded as a classic script (no imports) so the
// same file works in a Chrome service worker (importScripts), a Firefox event
// page (background.scripts), an extension page (<script>) and a content script
// (listed before the script that uses it).
//
// WHERE SETTINGS LIVE (0.6.0)
//   storage.sync  — the user's choices. The browser syncs them to the user's
//                   OWN browser account (Chrome / Edge / Firefox sync), so a
//                   second computer picks them up. Nothing is sent to Purple
//                   Directive.
//   storage.local — three switches that need a site-access grant the browser
//                   asks for on EACH device (other engines, cookie banners,
//                   pop-ups), plus the blocked-items counter, which changes too
//                   often for sync's write quota (120 writes a minute).
//
// A grant-bound switch is deliberately NOT synced: syncing "cookie banners on"
// to a device where the browser never granted all-sites access would show a
// switch that is on and a feature that does nothing — the badge-lying class of
// bug this project keeps having to fix.
//
// Reads merge DEFAULTS < storage.local < storage.sync. Until migrate() has run
// (on install/update/startup), a 0.5.x user's settings are still in local and
// are therefore still what every reader sees; afterwards sync holds them.

(() => {
  const g = globalThis;
  if (g.QuellSettings) return; // double-injection guard

  const SYNC_DEFAULTS = {
    enabled: true,          // Quell master switch
    // --- Search (AI) group ---
    aiEnabled: true,        // group master for every search-engine surface
    googleMode: 'hide',     // 'hide' | 'cleanweb' | 'off'
    hideOverview: true,
    hideAiMode: true,
    // A People-also-ask answer is AI the user clicked open. Keep it by default.
    hidePaa: false,
    hideGemini: true,
    // Bing: the Copilot panel, every /copilotsearch entry point AND the
    // Copilot suggestion chips, as one switch (one meaning, one control).
    bingEnabled: true,
    ddgMode: 'hide',        // 'clean' | 'hide' | 'off'
    braveMode: 'hide',
    yahooMode: 'hide',
    aiAllowlist: [],        // hostnames where the user keeps AI ("Keep AI on this site")
    // --- Cookies group ---
    cookieReject: false,
    cookieAllowlist: [],    // hostnames where the cookie layer is paused
    // --- Pop-ups group ---
    hideNewsletters: true,
    hideChat: true,
    hideAppBanners: true,
    popupAllowlist: [],     // hostnames where the pop-ups layer is paused
    // --- AI on websites (0.7.4) ---
    aiWebOn: true,          // group master
    aiWebButtons: true,     // cosmetic: "Ask AI" buttons and panels on known sites
    aiWebChat: true,        // AI chat assistants (network + cosmetic, vendors whose product is the agent)
    aiWebSupport: false,    // support chats that use AI (opt-in: can remove a site's support chat)
    aiWebReplay: false,     // AI session recording (opt-in)
    aiWebAllowlist: [],     // hostnames where this group is paused
    hideSignupPrompts: true, // 0.7.4: sign-up / log-in prompts (a row under Pop-ups)
  };

  const LOCAL_DEFAULTS = {
    enginesEnabled: false,  // intent for DuckDuckGo/Brave/Yahoo (grant-bound)
    cookieEnabled: false,   // grant-bound: <all_urls>
    popupsEnabled: false,   // grant-bound: <all_urls>; OFF by default
    linksEnabled: false,    // grant-bound: <all_urls>; 0.7.4 "Remove tracking from links" (the background turns it on once, when the grant exists)
    linksWarnAffiliate: false, // grant-bound: <all_urls> + the optional webNavigation permission; OFF by default
    totalBlocked: 0,
    // The page-level part of "AI on websites" runs on every site, so it needs the
    // all-sites grant like Cookie banners do; this is the user's ask for it.
    aiWebAccess: false,
    // Anonymous usage counts: 'unset' (never answered: nothing is sent) | 'on' | 'off'.
    // Per device, like the Firefox data-collection permission it mirrors.
    analytics: 'unset',
    // The one-time first-run card (popup and welcome page) has been answered.
    firstRunDone: false,
    // The newest "What's new" card this user has answered or closed (a version
    // string; '' = none). Fresh installs record the current version at first run.
    whatsNewSeen: '',
    // Timed per-site pauses: { host: { until: <ms>, added: [allowlist keys the
    // pause itself added] } }. The allowlists stay the one thing every content
    // script and the background read; this only remembers when to take the
    // pause's own entries back out (sweepPauses).
    sitePauses: {},
  };

  // Keys that existed in 0.5.x and are gone. hideBingChips was the separate
  // chip switch; the chips now follow the Bing switch.
  const OBSOLETE_KEYS = ['hideBingChips'];

  // storage.sync allows 8,192 bytes per item. A paused-site list is the only
  // value that can grow toward it; refuse to write past this budget rather
  // than let the browser reject the whole write.
  const LIST_BYTE_BUDGET = 7000;
  const LIST_KEYS = ['aiAllowlist', 'cookieAllowlist', 'popupAllowlist', 'aiWebAllowlist'];

  const DEFAULTS = { ...SYNC_DEFAULTS, ...LOCAL_DEFAULTS };
  const home = (k) => (k in LOCAL_DEFAULTS ? 'local' : 'sync');

  const api = () => (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage : null;
  // Test stubs and very old contexts may expose only storage.local; then
  // everything lives there, which is exactly 0.5.x behaviour.
  const syncArea = () => { const s = api(); return (s && s.sync) || null; };

  function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (k in obj) out[k] = obj[k];
    return out;
  }

  // Merged read. `defaults` narrows the keys (and supplies fallbacks), the way
  // storage.get(defaults) does.
  async function get(defaults = DEFAULTS) {
    const s = api();
    if (!s) return { ...defaults };
    const local = await s.local.get(defaults);
    const sync = syncArea();
    if (!sync) return local;
    const syncKeys = Object.keys(defaults).filter((k) => home(k) === 'sync');
    if (!syncKeys.length) return local;
    let synced = {};
    // Array form: only keys that are actually present come back, so an unset
    // sync key never shadows a 0.5.x value still waiting in local.
    try { synced = await sync.get(syncKeys); } catch (_) { /* sync unavailable */ }
    return { ...local, ...synced };
  }

  class ListFullError extends Error {
    constructor(key) { super(`${key} is full`); this.name = 'ListFullError'; this.key = key; }
  }

  // Split a patch by home area and write each half. Sync failures surface to
  // the caller (the popup shows them); they are not silently redirected to
  // local, because a local copy would be shadowed by the stale synced value.
  async function set(patch) {
    const s = api();
    if (!s) return;
    for (const k of LIST_KEYS) {
      if (k in patch && JSON.stringify(patch[k] || []).length > LIST_BYTE_BUDGET) {
        throw new ListFullError(k);
      }
    }
    const localPart = {}, syncPart = {};
    for (const [k, v] of Object.entries(patch)) (home(k) === 'local' ? localPart : syncPart)[k] = v;
    const sync = syncArea();
    const jobs = [];
    if (Object.keys(localPart).length) jobs.push(s.local.set(localPart));
    if (Object.keys(syncPart).length) jobs.push((sync || s.local).set(syncPart));
    await Promise.all(jobs);
  }

  // One-time move of 0.5.x settings from local to sync, safe to run on every
  // install/update/startup. Copies a key only if sync does not have it yet (a
  // second device that already synced wins), then removes the local copy so
  // there is one source of truth. If the sync write fails, nothing is removed:
  // readers keep seeing the local values, and the next run tries again.
  async function migrate() {
    const s = api();
    const sync = syncArea();
    if (!s || !sync) return { moved: [], dropped: [] };
    const syncKeys = Object.keys(SYNC_DEFAULTS);
    const legacy = await s.local.get([...syncKeys, ...OBSOLETE_KEYS]);
    const dropped = OBSOLETE_KEYS.filter((k) => k in legacy);
    const present = syncKeys.filter((k) => k in legacy);
    let moved = [];
    if (present.length) {
      const already = await sync.get(present);
      const toCopy = pick(legacy, present.filter((k) => !(k in already)));
      if (Object.keys(toCopy).length) {
        try { await sync.set(toCopy); } catch (_) { return { moved: [], dropped: [], error: true }; }
      }
      moved = Object.keys(toCopy);
    }
    const remove = [...present, ...dropped];
    if (remove.length) await s.local.remove(remove);
    if (dropped.length) { try { await sync.remove(dropped); } catch (_) { /* nothing synced */ } }
    return { moved, dropped };
  }

  // Re-run cb(mergedSettings) whenever any of `keys` changes in either area.
  function onChange(keys, cb) {
    const s = api();
    if (!s || !s.onChanged) return;
    s.onChanged.addListener((changes, area) => {
      if (area !== 'local' && area !== 'sync') return;
      if (!keys.some((k) => k in changes)) return;
      get().then(cb).catch(() => {});
    });
  }

  // A CONTENT SCRIPT THAT HAS LOST ITS EXTENSION
  // Chrome leaves a content script running in every open tab when its
  // extension is updated, reloaded, switched off in the browser's extension
  // settings or removed. That copy has no storage and no messages any more, so
  // no switch can reach it: what it hid stays hidden and its observer goes on
  // hiding until the tab is reloaded. Measured 2026-10-01: a Google tab left
  // open across an update kept its AI Overview hidden with Quell switched off,
  // and went on hiding after Quell was disabled outright. A copy that cannot
  // be told to stop has to stop itself, so every content script hands its own
  // teardown to onGone().
  //
  // chrome.runtime.id is what goes away, and nothing announces it, so it is
  // looked at on a slow timer and whenever the tab comes back into view. A new
  // copy of Quell arriving in the same page (the background puts one into open
  // tabs it has access to) says so with a DOM event before it does anything
  // else, so the old copy has put the page back before the new one starts.
  // Only a copy that really is cut off acts on that event: a page sending it
  // to a working Quell achieves nothing.
  const GONE_CHECK_MS = 2000;
  const TAKEOVER_EVENT = 'quell-takeover';
  // google.js and engines.js; bing.js and cookies.js; popups.js.
  const COUNTED_MARKS = ['data-quell-counted', 'data-quell-seen', 'data-quell-popup-seen'];
  const alive = () => { try { return !!chrome.runtime.id; } catch (_) { return false; } };
  const goneCbs = [];
  let goneTimer = null;
  function checkGone() {
    if (alive()) return;
    clearInterval(goneTimer);
    document.removeEventListener('visibilitychange', checkGone);
    document.removeEventListener(TAKEOVER_EVENT, checkGone);
    for (const cb of goneCbs.splice(0)) { try { cb(); } catch (_) { /* the rest still run */ } }
    // The page is back as the site serves it, and this copy's per-tab count
    // went with its extension (session storage is emptied by an update). Take
    // its "already counted" marks off too, so the copy that takes over counts
    // what it hides: left on, the new copy hid the same things and reported
    // none, and the badge stayed empty over a page that was hiding. The
    // lifetime total counts those few things a second time.
    try {
      for (const el of document.querySelectorAll(COUNTED_MARKS.map((a) => `[${a}]`).join(','))) {
        for (const a of COUNTED_MARKS) el.removeAttribute(a);
      }
    } catch (_) { /* no document left */ }
  }
  // Run cb() once, when this script's extension is gone. A no-op outside a
  // page (the background) and where there never was an extension (tests that
  // inject a content script into a plain page).
  function onGone(cb) {
    if (typeof document === 'undefined' || !alive()) return;
    goneCbs.push(cb);
    if (goneTimer !== null) return;
    goneTimer = setInterval(checkGone, GONE_CHECK_MS);
    document.addEventListener('visibilitychange', checkGone);
    document.addEventListener(TAKEOVER_EVENT, checkGone);
  }
  if (typeof document !== 'undefined' && alive()) {
    try { document.dispatchEvent(new Event(TAKEOVER_EVENT)); } catch (_) { /* no document to tell */ }
  }

  // TIMED PAUSES
  // "Pause here" for an hour / today puts the site into the allowlists of the
  // features it applies to (so every content script and the declarativeNetRequest
  // allow rules behave exactly as they do for a permanent per-site allow) and
  // records when to take those entries back out. Entries the user had put there
  // themselves before the pause are never removed by it. Run by the background
  // (startup, each navigation) and by the popup when it opens.
  async function sweepPauses(now = Date.now()) {
    const keys = ['aiAllowlist', 'cookieAllowlist', 'popupAllowlist', 'aiWebAllowlist'];
    const cur = await get({ sitePauses: {}, aiAllowlist: [], cookieAllowlist: [], popupAllowlist: [], aiWebAllowlist: [] });
    const pauses = cur.sitePauses && typeof cur.sitePauses === 'object' ? cur.sitePauses : {};
    const patch = {};
    const left = {};
    let changed = false;
    for (const [host, rec] of Object.entries(pauses)) {
      if (!rec || !(rec.until > 0) || rec.until > now) { left[host] = rec; continue; }
      changed = true;
      for (const k of (rec.added || [])) {
        if (!keys.includes(k)) continue;
        patch[k] = (patch[k] || cur[k] || []).filter((h) => h !== host);
      }
    }
    if (!changed) return false;
    patch.sitePauses = left;
    await set(patch);
    return true;
  }

  // HIDDEN-ITEM REGISTRY + the popup's questions (content scripts only)
  // Each content script that hides something registers a finder here. The
  // popup can then ask the tab what was hidden on it (a kind and a short label
  // per item), reveal one for a few seconds (Peek) or keep one shown for this
  // page load (Undo). Everything stays inside the browser: the answer goes to
  // Quell's own popup and nowhere else, and only elements a finder returned,
  // which are by construction things Quell hid, can be revealed. A page cannot
  // send these messages.
  const hiddenSources = [];
  const revealed = new WeakMap(); // el -> { prev, prio, hadKeep, mode, timer }
  const PEEK_MS = 6000;
  const KEEP_ATTR = 'data-quell-keep';

  function registerHidden(kind, find, active) {
    hiddenSources.push({ kind, find, active: active || (() => true) });
  }
  function collectHidden() {
    const groups = new Map();
    for (const src of hiddenSources) {
      let found = [];
      try { found = src.find() || []; } catch (_) { /* a finder must never break the popup */ }
      for (const f of found) {
        if (!f || !f.el || !f.el.isConnected) continue;
        const id = src.kind + ':' + f.label;
        let grp = groups.get(id);
        if (!grp) groups.set(id, grp = { id, kind: src.kind, label: f.label, detail: f.detail || '', rejected: false, els: [] });
        if (f.rejected) grp.rejected = true;
        if (!grp.els.includes(f.el)) grp.els.push(f.el);
      }
    }
    return groups;
  }
  function revealEl(el, mode) {
    let st = revealed.get(el);
    if (!st) {
      st = { prev: el.style.getPropertyValue('display'), prio: el.style.getPropertyPriority('display'),
        hadKeep: el.hasAttribute(KEEP_ATTR), mode: null, timer: 0 };
      revealed.set(el, st);
    }
    clearTimeout(st.timer);
    st.mode = mode;
    if (mode === 'keep') el.setAttribute(KEEP_ATTR, '1');
    // Inline beats Quell's own stylesheet, and `revert` hands the element back
    // to the page's default display rather than guessing a value.
    el.style.setProperty('display', 'revert', 'important');
    if (mode === 'peek') st.timer = setTimeout(() => restoreEl(el), PEEK_MS);
    // A wrapper Quell collapsed (or another block Quell hid) around this one
    // comes back with it, or the thing could not be seen (it may hold more than one hidden thing; it goes back to
    // hidden when the last of them does).
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (a.dataset && (a.dataset.quellCollapsed === '1' || a.dataset.quellHidden === '1') && !revealed.has(a)) revealEl(a, mode);
    }
  }
  function restoreEl(el) {
    const st = revealed.get(el);
    if (!st) return;
    clearTimeout(st.timer);
    if (st.prev) el.style.setProperty('display', st.prev, st.prio); else el.style.removeProperty('display');
    if (!st.hadKeep) el.removeAttribute(KEEP_ATTR);
    revealed.delete(el);
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (a.dataset && (a.dataset.quellCollapsed === '1' || a.dataset.quellHidden === '1') && revealed.has(a)
        && ![...a.querySelectorAll('*')].some((x) => revealed.has(x))) restoreEl(a);
    }
  }
  const modeOf = (grp) => grp.els.some((e) => revealed.get(e)?.mode === 'keep') ? 'keep'
    : grp.els.some((e) => revealed.get(e)?.mode === 'peek') ? 'peek' : null;
  function excerptOf(grp) {
    for (const el of grp.els) {
      const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.length > 140 ? t.slice(0, 139) + '…' : t;
    }
    return '';
  }
  function listHidden() {
    const items = [];
    for (const grp of collectHidden().values()) {
      const m = modeOf(grp);
      items.push({ id: grp.id, kind: grp.kind, label: grp.label, detail: grp.detail,
        rejected: grp.rejected, kept: m === 'keep', peeking: m === 'peek' });
    }
    const active = [...new Set(hiddenSources.filter((s) => { try { return s.active(); } catch (_) { return false; } }).map((s) => s.kind))];
    return { items, active };
  }
  function actOnHidden(msg) {
    if (typeof msg.id !== 'string') return { ok: false };
    const grp = collectHidden().get(msg.id);
    if (!grp) return { ok: false };
    if (msg.type === 'quell:hidden:peek') {
      if (msg.on === false) { if (modeOf(grp) === 'peek') grp.els.forEach(restoreEl); return { ok: true }; }
      if (modeOf(grp) === 'keep') return { ok: true, excerpt: '' };
      grp.els.forEach((e) => revealEl(e, 'peek'));
      try { grp.els[0].scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch (_) { /* detached */ }
      return { ok: true, excerpt: excerptOf(grp) };
    }
    if (msg.on === false) { grp.els.forEach(restoreEl); return { ok: true }; }
    grp.els.forEach((e) => revealEl(e, 'keep'));
    return { ok: true };
  }

  let listening = false;
  // The ONE listener of this world. Answers Quell's own popup (never a tab, a
  // page or another extension): which host this is, what is hidden, and
  // Peek/Undo on one hidden thing. The host answer is the hostname and nothing
  // else; Chrome does not show the popup a tab's address on content-script-only
  // access (Google and Bing), so the popup has to ask.
  function listen() {
    if (listening || typeof document === 'undefined') return;
    listening = true;
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || sender.id !== chrome.runtime.id || sender.tab) return;
        if (msg.type === 'where') { sendResponse({ host: location.hostname }); return; }
        if (msg.type === 'quell:hidden:list') { sendResponse(listHidden()); return; }
        if (msg.type === 'quell:hidden:peek' || msg.type === 'quell:hidden:keep') sendResponse(actOnHidden(msg));
      });
    } catch (_) { /* not an extension context (tests inject files into a plain page) */ }
  }

  // EMPTIED WRAPPERS (content scripts)
  // Hiding something can leave the box that wrapped it as an empty cell or
  // strip. emptyAncestor() returns the HIGHEST ancestor of `el` that now holds
  // nothing a person could see: no text, image, control or frame that is not
  // itself hidden. It stops at `stop`, never passes a landmark (nav, main,
  // article, header, footer, a search box), anything matching `safe`, or any
  // ancestor that still holds other content. Text counts as content whether or
  // not the browser has laid it out yet, so a page still rendering is never
  // collapsed by mistake (Microsoft Learn's article header was, in 0.7.4).
  const LANDMARKS = 'input:not([type="hidden"]), textarea, select, [role="search"], nav, main, article, header, footer, h1, h2, [role="banner"], [role="navigation"], [role="contentinfo"]';
  const MEDIA = 'img, picture, video, canvas, iframe, object, embed, button, a[href], svg';
  function hasVisibleContent(root, ignore) {
    let budget = 2000;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (ignore && ignore(n)) return NodeFilter.FILTER_REJECT;
          const cs = getComputedStyle(n);
          if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (--budget < 0) return true; // too big to judge: leave it alone
      if (n.nodeType === 3) { if (n.nodeValue.trim()) return true; } else if (n.matches(MEDIA)) return true;
    }
    return false;
  }
  // A landmark or control that is itself still showing (not one inside what was
  // just hidden) inside `root`.
  function holdsLandmark(root, safe, ignore) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (ignore && ignore(n)) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(n);
        return cs.display === 'none' || cs.visibility === 'hidden' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.matches(safe)) return true;
    return false;
  }
  function emptyAncestor(el, { stop = null, safe = '', ignore = null } = {}) {
    const SAFE = [LANDMARKS, safe].filter(Boolean).join(',');
    let top = null;
    for (let cur = el.parentElement; cur && cur !== stop && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.matches(SAFE) || holdsLandmark(cur, SAFE, ignore) || hasVisibleContent(cur, ignore)) break;
      top = cur;
    }
    return top;
  }
  function collapseEl(w, label, owner) {
    if (!w || w.dataset.quellCollapsed === '1' || guard.state.tripped || guard.protects(w)) return;
    w.dataset.quellCollapsed = '1';
    w.dataset.quellOwner = owner || '';
    if (label) w.dataset.quellLabel = label;
    w.style.setProperty('display', 'none', 'important');
  }
  // A page that was still rendering when a wrapper was collapsed may fill it
  // afterwards (Microsoft Learn's header, 0.7.4). Each sweep calls this first:
  // a collapsed wrapper that now holds visible content of its own is let back.
  function recheckCollapsed(owner, ignore) {
    for (const w of document.querySelectorAll('[data-quell-collapsed="1"]')) {
      if (owner && w.dataset.quellOwner !== owner) continue;
      if (!hasVisibleContent(w, (n) => n.dataset && (n.dataset.quellCollapsed === '1' || (ignore && ignore(n))))) continue;
      w.style.removeProperty('display');
      delete w.dataset.quellCollapsed;
      delete w.dataset.quellOwner;
      delete w.dataset.quellLabel;
    }
  }
  function uncollapseAll(owner) {
    for (const w of document.querySelectorAll('[data-quell-collapsed="1"]')) {
      if (owner && w.dataset.quellOwner !== owner) continue;
      w.style.removeProperty('display');
      delete w.dataset.quellCollapsed;
      delete w.dataset.quellOwner;
      delete w.dataset.quellLabel;
    }
  }

  // PAGE SAFETY NET (content scripts)
  // Quell hides things; it must never blank a page. Every hiding layer calls
  // measure() at the start of a sweep and check() at its end. The sweep is
  // synchronous, so the text held just before and just after it differs only
  // by what Quell itself did: if a sweep that hid something left under half of
  // the text it started with, the page was blanked (Zara, 0.7.4 retest), so
  // every layer takes its hides back and the page is marked data-quell-safety.
  // A page's own content swap (a single-page app showing a spinner, then
  // re-rendering) is never compared with anything, so it cannot trip this.
  // The net re-arms on a URL change, or after 10 s (at most twice per
  // address, so a real blanking cannot flicker forever): layers listen for
  // the quell:rearm event and start again. protects() names what may never
  // be hidden or collapsed: the document, main, the app root, or an element
  // that holds most of the page's text.
  const guard = (() => {
    let base = 0, acted = false, tripUrl = '', trips = 0, timer = null, trippedAt = 0;
    const undos = [];
    const state = { tripped: false, before: 0, after: 0 };
    // One measure for the sweep check and the stylesheet probe: in-flow text (flowText below).
    const textLen = () => flowText();
    const ROOTS = 'html, body, main, [role="main"], #root, #app, #__next, #__nuxt, #app-root';
    // Text of the page itself, for judging a stylesheet: what a visible
    // overlay holds (a fixed or sticky layer, a dialog, a consent tool) is not
    // counted, so a sheet that hides only a banner can never look like a
    // blanked page, however much of a sparse page's text the banner holds.
    // An overlay is a CMP or dialog (by its markup), or a fixed / sticky layer
    // that is a consent tool by name, or one that is not the page itself: it
    // neither is nor holds the page's landmarks and does not fill the window.
    // A fixed <main>, a sticky <article>, a full-window app shell, or a page
    // that merely has "cookie" or "consent" in a class (a policy page) are the
    // page, never an overlay.
    const LANDMARK = 'main, article, [role="main"], #root, #app, #__next, #__nuxt, #app-root';
    const CMP = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog, #onetrust-consent-sdk, #onetrust-banner-sdk, '
      + '#CybotCookiebotDialog, #didomi-host, .didomi-popup-container, [id^="sp_message_container"], #usercentrics-root, #cmpwrapper, '
      + '#qc-cmp2-container, .cc-window';
    const NAMED = '[id*="cookie" i], [id*="consent" i], [class*="cookie-banner" i], [class*="consent" i]';
    const layer = (el, cs) => {
      if (el.matches(CMP)) return true;
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
      // Landmarks first: a consent-named shell that holds the page is the page.
      if (el.matches(LANDMARK) || el.querySelector(LANDMARK)) return false;
      if (el.matches(NAMED)) return true;
      // 90%, not 98%: an app pane under a fixed top bar still fills the window.
      const r = el.getBoundingClientRect();
      return !(r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9);
    };
    const flowText = () => {
      let n = 0, seen = 0;
      const walk = (el) => {
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType === 3) { n += c.nodeValue.replace(/\s+/g, ' ').trim().length; continue; }
          if (c.nodeType !== 1 || ++seen > 8000) continue;
          if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(c.tagName)) continue;
          const cs = getComputedStyle(c);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (layer(c, cs)) continue;
          walk(c);
        }
      };
      walk(document.body);
      return n;
    };
    const isOverlay = (el) => {
      for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (layer(a, cs)) return true;
      }
      return false;
    };
    const trip = (was, now) => {
      state.tripped = true; state.before = was; state.after = now;
      trips++; tripUrl = location.href; trippedAt = Date.now();
      for (const fn of undos) { try { fn(); } catch (_) { /* the rest still run */ } }
      try { document.documentElement.setAttribute('data-quell-safety', '1'); } catch (_) { /* no root */ }
      watch();
      return true;
    };
    const rearm = () => {
      if (timer) { clearInterval(timer); timer = null; }
      state.tripped = false; base = 0; acted = false;
      try { document.documentElement.removeAttribute('data-quell-safety'); } catch (_) { /* no root */ }
      try { document.dispatchEvent(new Event('quell:rearm')); } catch (_) { /* no document */ }
    };
    const watch = () => {
      if (timer) return;
      timer = setInterval(() => {
        if (!state.tripped) { clearInterval(timer); timer = null; return; }
        if (location.href !== tripUrl) { trips = 0; rearm(); return; }
        if (Date.now() - trippedAt >= 10000 && trips < 2) rearm();
      }, 1000);
    };
    return {
      state,
      register(fn) { undos.push(fn); },
      acted() { acted = true; },
      measure() {
        if (state.tripped || typeof document === 'undefined' || !document.body) return;
        acted = false;
        base = textLen();
      },
      check() {
        if (state.tripped || !acted || base < 800 || !document.body) return false;
        acted = false;
        const now = textLen();
        if (now >= base * 0.5) return false;
        return trip(base, now);
      },
      // A stylesheet hides before any sweep can measure, so it is judged by
      // switching Quell's own stylesheets off and on again around two reads of
      // the page's text: the same "just before, just after" comparison.
      probe(ids) {
        if (state.tripped || typeof document === 'undefined' || !document.body) return false;
        const sheets = ids.map((i) => document.getElementById(i)).filter((e) => e && e.sheet);
        if (!sheets.length) return false;
        for (const s of sheets) s.sheet.disabled = true;
        const before = textLen();
        for (const s of sheets) s.sheet.disabled = false;
        const after = textLen();
        if (before < 800 || after >= before * 0.5) return false;
        return trip(before, after);
      },
      protects(el) {
        if (!el || !el.matches) return false;
        try {
          if (el.matches(ROOTS) || el.querySelector('main, [role="main"], #root, #app, #__next, #__nuxt')) return true;
          // textContent, not innerText: the element may already be hidden by a
          // stylesheet, which empties its innerText but not what it holds.
          // An overlay (a banner, a dialog, a consent tool) is not "the page":
          // however much of a sparse page's text it holds, it may be hidden.
          if (isOverlay(el)) return false;
          const total = ((document.body && document.body.textContent) || '').replace(/\s+/g, ' ').length;
          return total >= 600 && ((el.textContent || '').replace(/\s+/g, ' ').length > total * 0.5);
        } catch (_) { return false; }
      },
    };
  })();

  g.QuellSettings = {
    SYNC_DEFAULTS, LOCAL_DEFAULTS, DEFAULTS, OBSOLETE_KEYS, LIST_BYTE_BUDGET,
    home, get, set, migrate, onChange, onGone, ListFullError, sweepPauses,
    hidden: { register: registerHidden, list: listHidden, listen },
    guard,
    emptied: { emptyAncestor, collapse: collapseEl, uncollapseAll, recheckCollapsed, hasVisibleContent },
  };
})();
