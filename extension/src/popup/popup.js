// Quell — popup controller (also served as a tab: popup.html?view=page).
// Reads and writes settings through src/shared/settings.js; the background
// worker and the content scripts react to the storage change themselves.

const S = globalThis.QuellSettings;
const CFG = globalThis.QUELL_CONFIG || {};
const $ = (id) => document.getElementById(id);

const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime;
const IS_FIREFOX = hasChrome && typeof chrome.runtime.getURL === 'function'
  && chrome.runtime.getURL('').startsWith('moz-extension:');
const params = new URLSearchParams(location.search);
const PAGE_VIEW = params.get('view') === 'page';
if (PAGE_VIEW) document.body.classList.add('page');
// Firefox closes a toolbar popup when its permission prompt opens, and the
// request never resolves (bugzilla 1432083). Grants are therefore asked for
// from this same page opened as a tab, where the prompt works.
const GRANT_IN_TAB = IS_FIREFOX && !PAGE_VIEW;

// Must stay identical to ENGINE_ORIGINS in background.js — the browser only
// grants what optional_host_permissions declares, and only registers what was
// granted. (Checked by tests/smoke.mjs.)
const ENGINE_ORIGINS = [
  '*://duckduckgo.com/*',
  '*://*.duckduckgo.com/*',
  '*://search.brave.com/*',
  '*://search.yahoo.com/*',
  '*://*.search.yahoo.com/*',
];
const ALL_SITES = ['<all_urls>'];
// Written to storage.session just before the popup gives all-sites access
// back, so the background can tell OUR removal from the user revoking access
// in the browser's extension settings. Same key as background.js.
const RELEASE_KEY = 'quellReleasingAllSites';
// Firefox 140+: the breakage report sends a domain (browsingActivity) and the
// Quell version (technicalAndInteraction). Both are OPTIONAL data-collection
// permissions in the Firefox manifest, asked for the first time a user sends.
const REPORT_DATA = ['browsingActivity', 'technicalAndInteraction'];

const ENGINE_MODES = ['ddgMode', 'braveMode', 'yahooMode'];
const SURFACE_IDS = { sOverview: 'hideOverview', sAiMode: 'hideAiMode', sPaa: 'hidePaa', sGemini: 'hideGemini' };
const POPUP_IDS = { pNews: 'hideNewsletters', pChat: 'hideChat', pApp: 'hideAppBanners', pSignup: 'hideSignupPrompts' };
const SURFACE_NAMES = {
  hideOverview: 'the AI Overview', hideAiMode: 'AI Mode',
  hidePaa: 'answers you open in “People also ask”', hideGemini: 'Gemini buttons and promos',
};
// The two that are more than one thing take "them" in the question's second line.
const SURFACE_PLURAL = { hidePaa: true, hideGemini: true };
// Hosts where "Keep AI on this site" means something.
const AI_HOST_RE = /(^|\.)google\.[a-z.]+$|(^|\.)bing\.com$|(^|\.)duckduckgo\.com$|^search\.brave\.com$|(^|\.)search\.yahoo\.com$/;

const store = {
  get: (d) => S.get(d),
  set: (p) => S.set(p),
};

let current = { ...S.DEFAULTS };
let host = null;     // active tab's hostname, when Quell can see it
let tabId = null;

// ---------------------------------------------------------------- helpers --
// A plain-language line about access Quell just gave back (or could not keep).
function showInfo(msg) {
  const el = $('infoLine');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function showError(msg) {
  const el = $('saveError');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// Every write goes through here so a sync-quota refusal is shown, not lost.
async function save(patch) {
  try {
    await store.set(patch);
    showError('');
    Object.assign(current, patch);
    setTimeout(refreshTab, 500); // the page reacts to a change a moment later
    return true;
  } catch (e) {
    showError(e && e.name === 'ListFullError'
      ? 'That list of sites is full. Remove a site you no longer need first.'
      : 'Couldn’t save that change. Try again in a minute.');
    return false;
  }
}

// Resolves true when the user confirms. A native <dialog>: Esc and Cancel
// both mean "no", focus returns to the control afterwards.
function ask({ title, body, yes = 'Show it', no = 'Keep hidden' }) {
  const dlg = $('confirmDlg');
  $('confirmT').textContent = title;
  $('confirmB').textContent = body;
  $('confirmYes').textContent = yes;
  $('confirmNo').textContent = no;
  const back = document.activeElement;
  return new Promise((resolve) => {
    const done = (v) => {
      $('confirmYes').onclick = $('confirmNo').onclick = null;
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      back?.focus?.();
      resolve(v);
    };
    const onCancel = (e) => { e.preventDefault(); done(false); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    dlg.addEventListener('cancel', onCancel);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else done(true);
    $('confirmNo').focus();
  });
}

function openPageView(extra) {
  const url = chrome.runtime.getURL('src/popup/popup.html') + '?view=page&' + new URLSearchParams(extra);
  chrome.tabs.create({ url }).catch(() => {});
  if (!PAGE_VIEW) window.close();
}

async function currentTab() {
  if (!hasChrome || !chrome.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  return tab || null;
}
// The tab's hostname as Quell's own content script reports it. Used where the
// browser will not show the popup the tab's address: Google and Bing, which
// Quell reaches as content-script hosts (see content/common.js). Null on any
// page Quell has no script in.
async function hostFromPage(id) {
  if (id == null || !hasChrome || !chrome.tabs?.sendMessage) return null;
  try {
    const r = await chrome.tabs.sendMessage(id, { type: 'where' });
    // A hostname and nothing else: letters, digits, dots and hyphens, and the
    // same thing back when it is read as an address.
    const h = typeof r?.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(r.host) ? r.host.toLowerCase() : null;
    return h && hostOf('https://' + h) === h ? h : null;
  } catch (_) { return null; } // nothing of Quell's is listening in that tab
}
function hostOf(url) {
  try {
    const u = new URL(url || '');
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch (_) { return null; }
}

async function enginesOn(s) {
  if (!hasChrome || !chrome.permissions) return false;
  if (!s.enginesEnabled) return false;
  return chrome.permissions.contains({ origins: ENGINE_ORIGINS }).catch(() => false);
}

// ----------------------------------------------------------------- render --
async function refreshTab() {
  tab = await loadTab();
  renderHero(current); renderItems(current); renderRows(current);
}
const T = (name) => { try { globalThis.QuellFirstRun?.track(name); } catch (_) { /* ignore */ } };
const ICONS = {
  search: '<path d="M12 2.5l1.7 5.8 5.8 1.7-5.8 1.7L12 17.5l-1.7-5.8L4.5 10l5.8-1.7z" fill="currentColor"/>',
  chat: '<path d="M4 5.5h16v10H10l-4 3.5v-3.5H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  cookie: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="9.5" r="1.2" fill="currentColor"/><circle cx="14.5" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="14.5" r="1.2" fill="currentColor"/><circle cx="9.5" cy="15" r="1.2" fill="currentColor"/>',
  popup: '<rect x="3.5" y="5" width="17" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 10.5h8M8 14h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};
const iconFor = (it) => it.kind === 'cookie' ? ICONS.cookie : it.kind === 'popup' ? (it.label === 'Chat widget' ? ICONS.chat : ICONS.popup)
  : /gemini/i.test(it.label) ? ICONS.chat : ICONS.search;

let tab = { items: [], active: [], reachable: false, session: 0, links: null };
let itemsExpanded = false;
const expanded = { search: false, cookie: false, popup: false, aiweb: false, link: false };
const SHOWN_ITEMS = 3;

// What the tab says Quell hid on it (a kind and a short label per item: the
// page's text is never asked for here), plus the toolbar count for the tab.
async function loadTab() {
  const out = { items: [], active: [], reachable: false, session: 0, links: null, netBlocked: 0 };
  if (PAGE_VIEW || tabId == null || !hasChrome) return out;
  if (chrome.storage?.session) {
    const key = 'tab:' + tabId;
    out.session = (await chrome.storage.session.get({ [key]: 0 }).catch(() => ({ [key]: 0 })))[key] || 0;
  }
  if (host && chrome.tabs?.sendMessage) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'quell:hidden:list' });
      if (r && Array.isArray(r.items)) { out.items = r.items; out.active = r.active || []; out.reachable = true; }
    } catch (_) { /* nothing of Quell's in that tab */ }
    // Links: how many links the page script cleaned here (a count, nothing else).
    try {
      const l = await chrome.tabs.sendMessage(tabId, { type: 'quell:links:status' });
      if (l && Number.isInteger(l.cleaned)) out.links = l.cleaned;
    } catch (_) { /* the links script is not in that tab */ }
  }
  out.netBlocked = await netBlockedFor(tabId);
  return out;
}
// How many AI scripts the network rules stopped in this tab. The browser's own
// matched-rule record (declarativeNetRequest.getMatchedRules, which needs the
// declarativeNetRequestFeedback permission) is the only honest source: it
// holds the last few minutes, and the browser limits how often it can be read,
// so a failure just means no count is shown.
async function netBlockedFor(id) {
  try {
    const dnr = chrome.declarativeNetRequest;
    if (!dnr || typeof dnr.getMatchedRules !== 'function') return 0;
    const r = await dnr.getMatchedRules({ tabId: id });
    return (r.rulesMatchedInfo || []).filter((m) => /^ai_web_/.test(m.rule && m.rule.rulesetId)).length;
  } catch (_) { return 0; }
}

const AI_KEYS = ['aiAllowlist', 'cookieAllowlist', 'popupAllowlist', 'aiWebAllowlist'];
// The allowlists a pause on this host has to cover: the features that are on.
function pauseKeys(s) {
  const k = [];
  if (AI_HOST_RE.test(host || '') && s.aiEnabled) k.push('aiAllowlist');
  if (s.cookieEnabled) k.push('cookieAllowlist');
  if (s.popupsEnabled) k.push('popupAllowlist');
  if (s.aiWebOn) k.push('aiWebAllowlist');
  return k;
}
// "Paused" means Pause here was used on this site (it left a record) and every
// feature that is on still has the site in its allowlist. An allow the user
// made themselves through "Choose per feature" is not a pause.
const isPaused = (s) => !!(host && s.sitePauses && s.sitePauses[host]) && pausedHere(s);
const pausedHere = (s) => {
  const k = host ? pauseKeys(s) : [];
  return k.length > 0 && k.every((key) => (s[key] || []).includes(host));
};
const timeWord = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function firstRunOn(s) { return !s.firstRunDone; }

function renderHero(s) {
  const app = $('app');
  const paused = !!host && s.enabled && isPaused(s);
  const first = firstRunOn(s);
  const n = Math.max(tab.items.length, tab.session) + (tab.netBlocked || 0);
  const total = Number(s.totalBlocked || 0);
  const state = first ? 'first-run' : paused ? 'paused' : !s.enabled ? 'off' : !host ? 'no-run' : 'normal';
  app.dataset.state = state;
  document.body.classList.toggle('is-off', !s.enabled && !first);
  $('enabled').checked = !!s.enabled;
  const h = $('pageStatus'), sub = $('subLine'), copy = $('heroCopy');
  copy.hidden = true; sub.hidden = false;
  const since = `${total.toLocaleString()} hidden since you installed it`;
  if (first) {
    const both = !!(s.cookieEnabled && s.popupsEnabled);
    h.textContent = both ? 'One more thing.' : 'Quell is ready.';
    sub.hidden = true; copy.hidden = false;
    copy.textContent = both ? 'Quell is already quieting search, cookie banners and pop-ups. Help improve it with anonymous counts, or leave that off.'
      : 'It hides AI answers in search. Want it to quiet cookie banners and pop-ups too?';
  } else if (paused) {
    h.textContent = `Paused on ${host.replace(/^www\./, '')}`;
    const until = s.sitePauses?.[host]?.until;
    sub.textContent = until > 0 ? `Until ${timeWord(until)}` : 'Until you resume';
  } else if (!s.enabled) {
    h.textContent = 'Quell is off.';
    sub.textContent = 'Nothing is hidden anywhere. Click the moon to turn it on.';
  } else if (PAGE_VIEW) {
    h.textContent = 'Quell is on.';
    sub.textContent = since;
  } else if (!host) {
    h.textContent = 'Quell doesn’t run on this page.';
    sub.textContent = `Nothing to hide here. ${since}`;
  } else {
    h.textContent = n > 0 ? `Hid ${n} ${n === 1 ? 'thing' : 'things'} on this page.` : 'Nothing to hide on this page.';
    sub.textContent = `Quell is on · ${since}`;
  }
  $('featCard').hidden = first;
  $('mainCard').hidden = first;
}

function renderItems(s) {
  const card = $('itemsCard');
  const show = !firstRunOn(s) && s.enabled && !!host && tab.items.length > 0 && !isPaused(s);
  card.hidden = !show;
  if (!show) return;
  const list = $('itemList');
  const items = tab.items;
  const shown = itemsExpanded ? items : items.slice(0, SHOWN_ITEMS);
  list.textContent = '';
  for (const it of shown) {
    const li = document.createElement('li');
    li.className = 'item' + (it.kept ? ' undone' : '');
    li.dataset.id = it.id;
    li.innerHTML = '<div class="line"><span class="ii"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"></svg></span>'
      + '<span class="il"><b></b><small aria-live="polite"></small></span>'
      + '<span class="acts"><button type="button" class="ghost" data-peek>Peek</button><button type="button" class="ghost" data-undo>Undo</button></span></div>'
      + '<p class="ex" hidden></p>';
    li.querySelector('svg').innerHTML = iconFor(it);
    li.querySelector('b').textContent = it.label;
    li.querySelector('small').textContent = it.kept ? 'Restored on this page'
      : it.rejected ? it.detail : it.detail;
    const peek = li.querySelector('[data-peek]'), undo = li.querySelector('[data-undo]');
    peek.setAttribute('aria-label', `Peek at ${it.label}`);
    undo.setAttribute('aria-label', (it.kept ? 'Hide again: ' : 'Undo hiding: ') + it.label);
    peek.setAttribute('aria-pressed', 'false');
    if (it.kept) { undo.textContent = 'Hide again'; peek.disabled = true; }
    peek.addEventListener('click', () => onPeek(it, li, peek));
    undo.addEventListener('click', () => onUndo(it, !it.kept));
    list.append(li);
  }
  const more = $('itemsMore');
  more.hidden = items.length <= SHOWN_ITEMS;
  more.textContent = itemsExpanded ? 'Show fewer' : `Show ${items.length - SHOWN_ITEMS} more`;
  more.setAttribute('aria-expanded', String(itemsExpanded));
}

async function tellTab(msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); } catch (_) { return null; }
}
const peekTimers = new Map();
async function onPeek(it, li, btn) {
  const on = btn.getAttribute('aria-pressed') !== 'true';
  // Only one peek at a time, like the mockup: close any other first.
  const r = await tellTab({ type: 'quell:hidden:peek', id: it.id, on });
  if (!r || !r.ok) return;
  btn.setAttribute('aria-pressed', String(on));
  // The excerpt takes the place of the item's second line, cut to one line, so a
  // peek never makes the popup taller (it has no spare height at 560 px).
  const ex = li.querySelector('.ex');
  const sub = li.querySelector('small');
  if (sub.dataset.base === undefined) sub.dataset.base = sub.textContent;
  const close = () => {
    btn.setAttribute('aria-pressed', 'false');
    sub.textContent = sub.dataset.base; sub.classList.remove('peeking'); sub.removeAttribute('title');
    ex.hidden = true;
  };
  clearTimeout(peekTimers.get(it.id));
  if (!on) { close(); return; }
  T('peek');
  const text = r.excerpt || 'Showing on the page for a few seconds.';
  sub.textContent = text; sub.title = text; sub.classList.add('peeking');
  peekTimers.set(it.id, setTimeout(close, 6000));
}
async function onUndo(it, on) {
  const r = await tellTab({ type: 'quell:hidden:keep', id: it.id, on });
  if (!r || !r.ok) return;
  if (on) T('undo');
  tab = { ...tab, ...(await loadTab()) };
  renderHero(current); renderItems(current); renderRows(current);
}

// One short line under each feature.
function rowStatus(kind, s, paused) {
  const on = kind === 'search' ? s.aiEnabled : kind === 'cookie' ? s.cookieEnabled : s.popupsEnabled;
  if (!s.enabled) return 'Quell is off';
  if (!on) return 'Off';
  if (paused) return 'Paused here';
  const mine = tab.items.filter((i) => i.kind === kind && !i.kept);
  const nowhere = { search: 'On for search pages', cookie: 'On for other pages', popup: 'On for other pages' }[kind];
  if (!host || !tab.reachable || !tab.active.includes(kind)) return nowhere;
  if (!mine.length) return 'Watching. Nothing to hide here';
  if (kind === 'cookie') {
    const rej = mine.some((i) => i.rejected);
    return `${rej ? 'Rejected' : 'Hid'} ${mine.length} ${mine.length === 1 ? 'banner' : 'banners'}`;
  }
  return `Hid ${mine.length} here`;
}
// AI on websites: page-level hides come from the tab's own list; network
// blocks are counted per tab (declarativeNetRequest.getMatchedRules, see netBlockedFor).
function aiWebStatus(s, paused) {
  if (!s.enabled) return 'Quell is off';
  if (!s.aiWebOn) return 'Off';
  if (paused) return 'Paused here';
  const hid = tab.items.filter((i) => i.kind === 'ai-web' && !i.kept).length;
  const blocked = tab.netBlocked || 0;
  if (hid || blocked) {
    return [hid ? `Hid ${hid} here` : '', blocked ? `Blocked ${blocked} AI ${blocked === 1 ? 'script' : 'scripts'}` : ''].filter(Boolean).join(' · ');
  }
  if (!s.aiWebAccess && (s.aiWebButtons || s.aiWebChat)) return 'Buttons need all-sites access';
  return !host || !tab.reachable ? 'On for other pages' : 'Watching. Nothing to hide here';
}
// The Links row and the sign-up prompt line (0.7.4), kept apart from rowStatus.
function renderLinkRows(s, paused) {
  const prompts = tab.items.filter((i) => i.kind === 'popup' && i.label === 'Sign-up prompt' && !i.kept).length;
  $('pSignupD').textContent = prompts ? `Closed ${prompts} sign-up ${prompts === 1 ? 'prompt' : 'prompts'}` : '';
  let line = 'Asks your browser for all-sites access';
  if (!s.enabled) line = 'Quell is off';
  else if (s.linksEnabled) {
    if (!host || tab.links === null) line = 'On for other pages';
    else line = tab.links ? `Cleaned ${tab.links} ${tab.links === 1 ? 'link' : 'links'} here` : 'Watching. Nothing to clean here';
  }
  $('linksD').textContent = line;
}
function renderRows(s) {
  const paused = !!host && s.enabled && isPaused(s);
  $('gSearchD').textContent = rowStatus('search', s, paused && AI_HOST_RE.test(host) );
  $('cookiesD').textContent = rowStatus('cookie', s, paused);
  $('popupsD').textContent = rowStatus('popup', s, paused);
  $('aiWebD').textContent = aiWebStatus(s, paused);
  renderLinkRows(s, paused);
}

async function renderAccess() {
  // Quell's Google/Bing access is required on Chrome and Edge, but Firefox can
  // hold it back (Android always asks). Checked against the manifest's own
  // patterns so there is nothing to keep in sync.
  //
  // Firefox only. On Chromium the content-script hosts are required at install
  // and permissions.contains() does not report them (they are "scriptable",
  // not "explicit" hosts), so asking there would always read as missing.
  const note = $('accessNotice');
  if (!IS_FIREFOX || !chrome.permissions || !chrome.runtime.getManifest) { note.hidden = true; return; }
  const m = chrome.runtime.getManifest();
  const all = (m.content_scripts || []).flatMap((c) => c.matches || []);
  // Host permissions ignore paths; ask about the origin, as the browser stores it.
  const origin = (m) => m && m.replace(/^(\*|https?):\/\/([^/]+)\/.*$/, '$1://$2/*');
  const exact = [all.find((x) => x.includes('google.com')), all.find((x) => x.includes('bing.com'))]
    .filter(Boolean);
  if (!exact.length) { note.hidden = true; return; }
  // Either form counts: browsers differ in whether a content-script match
  // is stored with its path or as a bare origin.
  const ok = await chrome.permissions.contains({ origins: exact }).catch(() => true)
    || await chrome.permissions.contains({ origins: exact.map(origin) }).catch(() => true);
  note.hidden = ok;
}

function setExpander(btn, body, open, usable) {
  btn.disabled = !usable;
  btn.setAttribute('aria-expanded', String(!!(open && usable)));
  body.hidden = !(open && usable);
}

function renderSearch(s, engines) {
  $('aiEnabled').checked = !!s.aiEnabled;
  setExpander($('searchExpand'), $('searchBody'), expanded.search, !!s.aiEnabled);
  for (const r of document.querySelectorAll('input[name="gmode"]')) r.checked = r.value === s.googleMode;
  $('gmodeHint').textContent = s.googleMode === 'cleanweb'
    ? 'Google’s plain list of links, no AI at all. The most reliable option.'
    : s.googleMode === 'off' ? 'Quell leaves Google as Google serves it.' : '';
  $('surfaces').hidden = !(s.enabled && s.aiEnabled && s.googleMode === 'hide');
  for (const [id, key] of Object.entries(SURFACE_IDS)) $(id).checked = !!s[key];
  $('sPaaD').textContent = s.hidePaa ? 'Hidden too' : 'Kept. You asked for these';
  $('bing').checked = !!s.bingEnabled;
  $('engines').checked = engines;
  $('engineModes').hidden = !(s.enabled && s.aiEnabled && engines);
  for (const k of ENGINE_MODES) $(k).value = s[k];
}

function renderCookies(s) {
  $('cookies').checked = !!s.cookieEnabled;
  setExpander($('cookieExpand'), $('cookieBody'), expanded.cookie, !!s.cookieEnabled);
  $('cookieReject').checked = !!s.cookieReject;
  // The reject row only means anything while the cookie layer is on.
  $('rejectRow').hidden = !(s.enabled && s.cookieEnabled);
}

function renderAiWeb(s) {
  $('aiWeb').checked = !!s.aiWebOn;
  setExpander($('aiWebExpand'), $('aiWebBody'), expanded.aiweb, !!s.aiWebOn);
  for (const k of ['aiWebButtons', 'aiWebChat', 'aiWebSupport', 'aiWebReplay']) $(k).checked = !!s[k];
  $('aiWebAccessRow').hidden = !!s.aiWebAccess;
}

function renderPopups(s) {
  $('popups').checked = !!s.popupsEnabled;
  setExpander($('popupExpand'), $('popupBody'), expanded.popup, !!s.popupsEnabled);
  for (const [id, key] of Object.entries(POPUP_IDS)) $(id).checked = !!s[key];
}

function renderLinkGroup(s) {
  $('links').checked = !!s.linksEnabled;
  setExpander($('linkExpand'), $('linkBody'), expanded.link, !!s.linksEnabled);
  $('linkWarn').checked = !!s.linksWarnAffiliate;
}

function renderSite(s) {
  const card = $('siteCard');
  if (!host || firstRunOn(s)) { card.hidden = true; return; }
  card.hidden = false;
  $('siteHost').textContent = host;
  const keys = pauseKeys(s);
  const paused = isPaused(s);
  // Pause here: only where there is something to pause, and not while Quell is off.
  $('pauseRow').hidden = !(s.enabled && keys.length > 0 && !paused);
  $('resumeRow').hidden = !paused;
  $('siteMore').hidden = keys.length === 0;
  $('siteAiRow').hidden = !(AI_HOST_RE.test(host) && s.aiEnabled);
  $('siteAi').checked = (s.aiAllowlist || []).includes(host);
  $('siteRow').hidden = !s.cookieEnabled;
  $('siteAllow').checked = (s.cookieAllowlist || []).includes(host);
  $('sitePopRow').hidden = !s.popupsEnabled;
  $('sitePop').checked = (s.popupAllowlist || []).includes(host);
  if (keys.length === 0) $('siteDetail').hidden = true;
  // Offer the report only for a host the endpoint will accept (the same rule,
  // src/shared/report-host.js) — an IP address, localhost or a .local name
  // would only earn the user a "failed" message.
  $('reportBtn').hidden = !reportable(host);
  $('siteMenuBtn').hidden = $('reportBtn').hidden && $('siteMore').hidden;
}

function reportable(h) {
  const rule = globalThis.QuellReportHost;
  return !!(h && rule && rule.valid(h));
}

function renderLinks() {
  const rate = $('rate');
  const B = globalThis.QuellBrowser || {};
  const url = IS_FIREFOX ? CFG.RATE_URL_FIREFOX : B.opera ? CFG.RATE_URL_OPERA : B.edge ? CFG.RATE_URL_EDGE : CFG.RATE_URL_CHROME;
  if (url) rate.href = url; else rate.hidden = true;
  $('sponsor').href = CFG.SPONSOR_URL || 'https://github.com/sponsors/TyrianMurex';
  $('donate').href = CFG.DONATE_URL || 'https://donate.stripe.com/8x29AT6aX4FP3ay9sp3gk0G';
  $('feedback').href = CFG.FEEDBACK_URL || 'https://purpledirective.com/contact?topic=quell';
  $('privacy').href = CFG.PRIVACY_URL || 'https://purpledirective.com/quell/privacy/';
}

async function renderAnalytics(s) {
  const FR = globalThis.QuellFirstRun;
  $('analyticsSwitch').checked = FR ? (FR.dataApi && await FR.dataApi() ? await FR.analyticsOn(s) : s.analytics === 'on') : s.analytics === 'on';
}

let frMounted = false;
async function render() {
  current = await store.get(S.DEFAULTS);
  const s = current;
  const engines = await enginesOn(s);
  tab = await loadTab();
  renderSearch(s, engines);
  renderCookies(s);
  renderPopups(s);
  renderAiWeb(s);
  renderLinkGroup(s);
  renderSite(s);
  renderHero(s);
  renderItems(s);
  renderRows(s);
  await renderAnalytics(s);
  const first = firstRunOn(s);
  $('firstRun').hidden = !first;
  if (first && !frMounted && globalThis.QuellFirstRun) {
    frMounted = true;
    globalThis.QuellFirstRun.mount($('firstRun'), {
      grantInTab: GRANT_IN_TAB, openTab: openPageView,
      onDone: () => render(),
      onChange: () => { $('app').classList.toggle('sent-open', !$('frSent').hidden); },
    }).catch(() => { frMounted = false; });
  }
}

// ------------------------------------------------------------- behaviours --
// A switch that turns AI back ON asks first. The checkbox is put back until
// the user confirms, so a dismissed dialog changes nothing.
function onToggle(id, handler) {
  $(id).addEventListener('change', async (e) => {
    const el = e.target;
    const want = el.checked;
    // Show the stored state until the change is actually saved, so a switch
    // never sits in the new position behind an open question.
    el.checked = !want;
    await handler(want, el);
    await render();
  });
}

async function confirmThen(question, patch) {
  if (!(await ask(question))) return false;
  return save(patch);
}

onToggle('enabled', (on) => on
  ? save({ enabled: true })
  : confirmThen({
      title: 'Turn Quell off?',
      body: 'AI answers, cookie banners and pop-ups will all show again, on every site, until you turn it back on.',
      yes: 'Turn off', no: 'Keep Quell on',
    }, { enabled: false }));

onToggle('aiEnabled', (on) => on
  ? save({ aiEnabled: true })
  : confirmThen({
      title: 'Show AI in search again?',
      body: 'Google, Bing and any other engine you switched on will show their AI answers the way they normally do.',
    }, { aiEnabled: false }));

for (const r of document.querySelectorAll('input[name="gmode"]')) {
  r.addEventListener('change', async () => {
    const prev = current.googleMode;
    const ok = r.value === 'off'
      ? await confirmThen({ title: 'Leave Google’s AI alone?', body: 'AI Overviews and AI Mode will show on Google again.' }, { googleMode: 'off' })
      : await save({ googleMode: r.value });
    if (!ok) for (const x of document.querySelectorAll('input[name="gmode"]')) x.checked = x.value === prev;
    await render();
  });
}

for (const [id, key] of Object.entries(SURFACE_IDS)) {
  onToggle(id, (hide) => hide
    ? save({ [key]: true })
    : confirmThen({ title: `Show ${SURFACE_NAMES[key]} again?`, body: SURFACE_PLURAL[key] ? 'Google will show them as usual. You can hide them again any time.' : 'Google will show it as usual. You can hide it again any time.' }, { [key]: false }));
}

onToggle('bing', (hide) => hide
  ? save({ bingEnabled: true })
  : confirmThen({ title: 'Show Bing Copilot again?', body: 'Bing’s Copilot panel, buttons and suggestions will come back.' }, { bingEnabled: false }));

for (const key of ENGINE_MODES) {
  $(key).addEventListener('change', async (e) => {
    const prev = current[key];
    const v = e.target.value;
    const ok = v === 'off'
      ? await confirmThen({ title: 'Leave this engine’s AI alone?', body: 'Its AI answers will show again.' }, { [key]: v })
      : await save({ [key]: v });
    if (!ok) e.target.value = prev;
    await render();
  });
}

// Other search engines — Quell ships with Google + Bing access only, so these
// three hosts are requested here, on the user's click (permissions.request
// needs a gesture, and must be the FIRST await). Turning it back off REVOKES
// the access rather than just forgetting it.
$('engines').addEventListener('change', async (e) => {
  if (!hasChrome || !chrome.permissions) return; // preview context — no-op
  if (e.target.checked) {
    if (GRANT_IN_TAB) { e.target.checked = false; openPageView({ grant: 'engines' }); return; }
    const granted = await chrome.permissions.request({ origins: ENGINE_ORIGINS }).catch(() => false);
    if (!granted) { e.target.checked = false; await render(); return; }
    await save({ enginesEnabled: true });
  } else {
    // Clear the intent FIRST: remove() cannot revoke an <all_urls> grant the
    // cookie feature owns, so the stored flag is what actually turns this
    // off. Without it the switch sprang straight back on.
    await save({ enginesEnabled: false });
    await chrome.permissions.remove({ origins: ENGINE_ORIGINS }).catch(() => {});
  }
  await render();
});

// All-sites access is held only while something uses it. When the last
// feature that needs it (Cookie banners, Pop-ups) is switched off, Quell gives
// the access back to the browser instead of sitting on it (least privilege:
// hold only what is in use). Switching either one on again asks for it again,
// from that click. The master switch is a pause, not a "stop using it": it keeps access.
//
// DuckDuckGo, Brave and Yahoo can lose their access with it. Chrome's
// permissions.remove(<all_urls>) takes every granted host that <all_urls>
// contains (a semantic intersection), engine hosts included; Firefox never
// stored the engine hosts at all if they were asked for while <all_urls> was
// already granted. Chrome keeps them in its granted set (a removal the
// extension makes is "soft"), so asking again on this same click brings them
// back without a prompt. Where that cannot work (Firefox, whose prompt needs
// the click itself), the engines switch goes off and the user is told why.
async function releaseAllSitesIfUnused() {
  if (!hasChrome || !chrome.permissions) return;
  if (current.cookieEnabled || current.popupsEnabled || current.linksEnabled || current.aiWebAccess) return; // still in use
  const held = await chrome.permissions.contains({ origins: ALL_SITES }).catch(() => false);
  if (!held) return;
  const keepEngines = await enginesOn(current);
  const session = chrome.storage?.session;
  if (keepEngines && session) await session.set({ [RELEASE_KEY]: Date.now() }).catch(() => {});
  const removed = await chrome.permissions.remove({ origins: ALL_SITES }).catch(() => false);
  if (!removed) {
    if (keepEngines && session) await session.remove(RELEASE_KEY).catch(() => {});
    return;
  }
  if (!keepEngines || await chrome.permissions.contains({ origins: ENGINE_ORIGINS }).catch(() => false)) {
    showInfo('Quell gave back its access to all sites. It only runs on search pages now.');
    return;
  }
  const back = !GRANT_IN_TAB
    && await chrome.permissions.request({ origins: ENGINE_ORIGINS }).catch(() => false);
  if (back) {
    showInfo('Quell gave back its access to all sites. It keeps access to Google, Bing, DuckDuckGo, Brave and Yahoo.');
    return;
  }
  await save({ enginesEnabled: false });
  showInfo('Quell gave back its access to all sites. DuckDuckGo, Brave and Yahoo were using it — switch them on again to allow just those three.');
}

// Cookie banners and Pop-ups both need all-sites access to run on the pages
// the user visits; requested on the click, and the feature is switched on only
// once it is granted.
function grantedFeature(id, key, grantName) {
  $(id).addEventListener('change', async (e) => {
    if (!hasChrome || !chrome.permissions) return;
    showInfo('');
    if (e.target.checked) {
      if (GRANT_IN_TAB) { e.target.checked = false; openPageView({ grant: grantName }); return; }
      const granted = await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false);
      if (!granted) { e.target.checked = false; await render(); return; }
      await save({ [key]: true });
    } else if (await save({ [key]: false })) {
      await releaseAllSitesIfUnused();
    }
    await render();
  });
}
grantedFeature('cookies', 'cookieEnabled', 'cookies');
grantedFeature('popups', 'popupsEnabled', 'popups');
grantedFeature('links', 'linksEnabled', 'links');

// "Warn me if a site swaps an affiliate code" needs the optional webNavigation
// permission, asked for on this click and given back when it is switched off.
$('linkWarn').addEventListener('change', async (e) => {
  if (!hasChrome || !chrome.permissions) return;
  showInfo('');
  if (e.target.checked) {
    if (GRANT_IN_TAB) { e.target.checked = false; openPageView({ grant: 'links' }); return; }
    const granted = await chrome.permissions.request({ permissions: ['webNavigation'] }).catch(() => false);
    if (!granted) { e.target.checked = false; await render(); return; }
    await save({ linksWarnAffiliate: true });
  } else {
    await save({ linksWarnAffiliate: false });
    await chrome.permissions.remove({ permissions: ['webNavigation'] }).catch(() => {});
  }
  await render();
});

$('cookieReject').addEventListener('change', async (e) => { await save({ cookieReject: e.target.checked }); await render(); });
for (const [id, key] of Object.entries(POPUP_IDS)) {
  $(id).addEventListener('change', async (e) => { await save({ [key]: e.target.checked }); await render(); });
}

// Per-site pauses — one card, three lists. Checked = Quell steps back here.
function siteList(id, key, confirmOn) {
  onToggle(id, async (on) => {
    if (!host) return false;
    if (on && confirmOn && !(await ask(confirmOn()))) return false;
    const list = current[key] || [];
    const next = on ? [...new Set([...list, host])] : list.filter((h) => h !== host);
    return save({ [key]: next });
  });
}
siteList('siteAi', 'aiAllowlist', () => ({
  title: `Keep AI on ${host}?`,
  body: 'Quell will leave this site’s AI answers alone. Everything else Quell does keeps working.',
  yes: 'Keep AI here', no: 'Cancel',
}));
siteList('siteAllow', 'cookieAllowlist');
siteList('sitePop', 'popupAllowlist');

$('grantBase').addEventListener('click', async () => {
  if (GRANT_IN_TAB) { openPageView({ grant: 'base' }); return; }
  const m = chrome.runtime.getManifest();
  const origins = [...new Set((m.content_scripts || []).flatMap((c) => c.matches || []))];
  await chrome.permissions.request({ origins }).catch(() => false);
  await renderAccess();
});

// AI on websites: the group master and the four switches are plain settings
// (the network rules need no access); hiding buttons and panels on pages needs
// the all-sites grant, asked for here on the click and released with the
// others when nothing uses it.
for (const [id, key] of [['aiWeb', 'aiWebOn'], ['aiWebButtons', 'aiWebButtons'], ['aiWebChat', 'aiWebChat'],
  ['aiWebSupport', 'aiWebSupport'], ['aiWebReplay', 'aiWebReplay']]) {
  $(id).addEventListener('change', async (e) => { await save({ [key]: e.target.checked }); await render(); });
}
$('aiWebGrant').addEventListener('click', async () => {
  if (!hasChrome || !chrome.permissions) return;
  if (GRANT_IN_TAB) { openPageView({ grant: 'aiweb' }); return; }
  const granted = await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false);
  if (granted) await save({ aiWebAccess: true });
  await render();
});

// ---------------------------------------------------- pause, settings, more --
// Pause here: the features that are on step back on this site, for an hour,
// until midnight, or until resumed. It is the per-site allowlists the
// content scripts and the background already read (so behaviour is exactly
// that of the per-feature allows below), plus a note of when to take back out
// what the pause itself added (settings.js sweepPauses).
$('pauseBtn').addEventListener('click', async () => {
  if (!host) return;
  const dur = $('pauseDur').value || 'hour';
  const now = new Date();
  const until = dur === 'hour' ? Date.now() + 3600e3
    : dur === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() : 0;
  const patch = {};
  const added = [];
  for (const key of pauseKeys(current)) {
    const list = current[key] || [];
    if (!list.includes(host)) { patch[key] = [...list, host]; added.push(key); }
  }
  const pauses = { ...(current.sitePauses || {}) };
  pauses[host] = { until, added }; // until 0 = until resumed; the record says what to take back
  patch.sitePauses = pauses;
  if (await save(patch)) T('pause');
  await render();
});
$('resumeBtn').addEventListener('click', async () => {
  if (!host) return;
  const patch = {};
  // Only what the pause itself added: an allow the user made earlier stays.
  for (const key of (current.sitePauses?.[host]?.added || [])) {
    if (AI_KEYS.includes(key) && (current[key] || []).includes(host)) patch[key] = current[key].filter((h) => h !== host);
  }
  const pauses = { ...(current.sitePauses || {}) };
  delete pauses[host];
  patch.sitePauses = pauses;
  await save(patch);
  await render();
});

function toggler(btn, onFlip) {
  btn.addEventListener('click', () => { onFlip(btn.getAttribute('aria-expanded') !== 'true'); });
}
toggler($('searchExpand'), (o) => { expanded.search = o; render(); });
toggler($('cookieExpand'), (o) => { expanded.cookie = o; render(); });
toggler($('popupExpand'), (o) => { expanded.popup = o; render(); });
toggler($('aiWebExpand'), (o) => { expanded.aiweb = o; render(); });
toggler($('linkExpand'), (o) => { expanded.link = o; render(); });
toggler($('siteMore'), (o) => { $('siteMore').setAttribute('aria-expanded', String(o)); $('siteDetail').hidden = !o; closeMenu(); });
function closeMenu() { $('siteMenu').hidden = true; $('siteMenuBtn').setAttribute('aria-expanded', 'false'); }
$('siteMenuBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('siteMenu').hidden;
  $('siteMenu').hidden = !open;
  $('siteMenuBtn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest?.('.menuwrap')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('siteMenu').hidden) { closeMenu(); $('siteMenuBtn').focus(); } });
$('itemsMore').addEventListener('click', () => { itemsExpanded = !itemsExpanded; renderItems(current); });
$('gearBtn').addEventListener('click', () => {
  const open = $('gearBtn').getAttribute('aria-expanded') !== 'true';
  $('gearBtn').setAttribute('aria-expanded', String(open));
  $('settings').hidden = !open;
  $('main').hidden = open;
});
$('sentBtn2').addEventListener('click', () => {
  const open = $('sent2').hidden;
  $('sent2').hidden = !open;
  $('sentBtn2').setAttribute('aria-expanded', String(open));
});
// Anonymous usage counts. Firefox asks for its own data-collection permission
// from the click (see shared/firstrun.js); from the toolbar popup that prompt
// cannot work, so the tab view takes over there.
$('analyticsSwitch').addEventListener('change', async (e) => {
  const FR = globalThis.QuellFirstRun;
  const want = e.target.checked;
  if (!FR) return;
  if (GRANT_IN_TAB && await FR.dataApi()) { e.target.checked = !want; openPageView({ grant: 'analytics' }); return; }
  e.target.checked = await FR.setAnalytics(want);
  await render();
});

// --------------------------------------------------------- breakage report --
// Exactly two fields leave the browser, shown to the user verbatim first.
function reportPayload(h) {
  const version = (hasChrome && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '0.0.0';
  return { host: h, version };
}

function openReport(h) {
  T('report_open');
  const dlg = $('reportDlg');
  dlg.dataset.host = h;
  $('reportPayload').textContent = JSON.stringify(reportPayload(h), null, 2);
  $('reportStatus').textContent = '';
  $('reportSend').disabled = false;
  $('reportSend').hidden = false;
  $('reportCancel').textContent = 'Cancel';
  if (typeof dlg.showModal === 'function') dlg.showModal();
}

async function sendReport(h) {
  const res = await fetch(CFG.REPORT_ENDPOINT, {
    method: 'POST',
    // text/plain keeps this a CORS "simple request": no preflight, and no
    // host permission needed to reach the endpoint.
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(reportPayload(h)),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
}

// What each refusal means, in words — "try again later" is only true for some.
function reportError(status) {
  if (status === 400) return 'Quell can’t report this address — it doesn’t look like a public website.';
  if (status === 429) return 'Too many reports from here just now. Please try again in a minute.';
  if (status === 403) return 'This copy of Quell can’t send reports (only store versions can).';
  return 'Couldn’t send it just now. Please try again later.';
}

$('reportBtn').addEventListener('click', () => { closeMenu(); if (reportable(host)) openReport(host); });
$('reportCancel').addEventListener('click', () => $('reportDlg').close());
$('reportSend').addEventListener('click', async () => {
  const h = $('reportDlg').dataset.host;
  if (!h) return;
  if (IS_FIREFOX) {
    // Firefox's own consent for optional data collection. From the toolbar
    // popup the prompt cannot work (see GRANT_IN_TAB), so continue in a tab.
    const has = await chrome.permissions.contains({ data_collection: REPORT_DATA }).catch(() => false);
    if (!has) {
      if (GRANT_IN_TAB) { openPageView({ report: h }); return; }
      const ok = await chrome.permissions.request({ data_collection: REPORT_DATA }).catch(() => false);
      if (!ok) { $('reportStatus').textContent = 'Not sent — Firefox permission was declined.'; return; }
    }
  }
  $('reportSend').disabled = true;
  $('reportStatus').textContent = 'Sending…';
  try {
    await sendReport(h);
    $('reportStatus').textContent = 'Sent. Thank you — reports go into the weekly rule update.';
    $('reportSend').hidden = true;
    $('reportCancel').textContent = 'Close';
  } catch (e) {
    $('reportStatus').textContent = reportError(e && e.status);
    // A 400 or 403 will not change on a retry; only offer Send again when it might work.
    if (e && (e.status === 400 || e.status === 403)) { $('reportSend').hidden = true; $('reportCancel').textContent = 'Close'; }
    else $('reportSend').disabled = false;
  }
});

// ------------------------------------------------------------------- boot --
(async () => {
  renderLinks();
  await S.sweepPauses().catch(() => {});
  T('popup_open');
  if (PAGE_VIEW) {
    // A tab has no "current site" of its own; a report handed over from the
    // Firefox popup carries its hostname in the URL (local only).
    host = hostOf('https://' + (params.get('report') || '')) || null;
  } else {
    const tab = await currentTab();
    tabId = tab?.id ?? null;
    host = hostOf(tab?.url) || await hostFromPage(tabId);
  }
  await render();
  await renderAccess();
  const grant = params.get('grant');
  const focusId = { engines: 'engines', cookies: 'cookies', popups: 'popups', links: 'links', base: 'grantBase', analytics: 'analyticsSwitch', firstrun: 'firstRun', aiweb: 'aiWebGrant' }[grant];
  if (PAGE_VIEW && grant === 'engines') { expanded.search = true; await render(); }
  if (PAGE_VIEW && grant === 'aiweb') { expanded.aiweb = true; await render(); }
  if (PAGE_VIEW && grant === 'analytics') { $('gearBtn').click(); }
  if (PAGE_VIEW && focusId) {
    $(focusId).focus?.();
    $(focusId).closest('.frow, .notice, .frc, .orow')?.classList.add('flash');
  }
  if (PAGE_VIEW && params.get('report') && reportable(host)) openReport(host);
})();
