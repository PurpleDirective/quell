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
const POPUP_IDS = { pNews: 'hideNewsletters', pChat: 'hideChat', pApp: 'hideAppBanners' };
const SURFACE_NAMES = {
  hideOverview: 'the AI Overview', hideAiMode: 'AI Mode',
  hidePaa: 'answers you open in “People also ask”', hideGemini: 'Gemini buttons and promos',
};
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
function renderHeader(s) {
  $('enabled').checked = !!s.enabled;
  $('stateLine').textContent = s.enabled ? 'Quiet the web.' : 'Paused everywhere.';
  document.body.classList.toggle('is-off', !s.enabled);
}

async function renderStatus(s) {
  const el = $('pageStatus');
  if (PAGE_VIEW) { el.textContent = ''; return; } // a settings tab has no page of its own
  if (!s.enabled) { el.textContent = 'Quell is off. Nothing is hidden anywhere.'; return; }
  if (!host) { el.textContent = 'Quell doesn’t run on this page.'; return; }
  let n = 0;
  if (tabId != null && hasChrome && chrome.storage?.session) {
    const key = 'tab:' + tabId;
    n = (await chrome.storage.session.get({ [key]: 0 }).catch(() => ({ [key]: 0 })))[key] || 0;
  }
  el.textContent = '';
  if (n > 0) {
    el.append('On this page Quell hid ');
    const b = document.createElement('strong');
    b.textContent = String(n);
    el.append(b, n === 1 ? ' thing.' : ' things.');
  } else {
    el.textContent = 'Nothing to hide on this page.';
  }
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

function renderSearch(s, engines) {
  $('aiEnabled').checked = !!s.aiEnabled;
  $('searchBody').hidden = !s.aiEnabled;
  for (const r of document.querySelectorAll('input[name="gmode"]')) r.checked = r.value === s.googleMode;
  $('gmodeHint').textContent = s.googleMode === 'cleanweb'
    ? 'Google’s plain list of links, no AI at all. The most reliable option.'
    : s.googleMode === 'off' ? 'Quell leaves Google as Google serves it.' : '';
  $('surfaces').hidden = !(s.enabled && s.aiEnabled && s.googleMode === 'hide');
  for (const [id, key] of Object.entries(SURFACE_IDS)) $(id).checked = !!s[key];
  $('sPaaD').textContent = s.hidePaa ? 'Hidden too' : 'Kept — you asked for these';
  $('bing').checked = !!s.bingEnabled;
  $('engines').checked = engines;
  $('engineModes').hidden = !(s.enabled && s.aiEnabled && engines);
  for (const k of ENGINE_MODES) $(k).value = s[k];
}

function renderCookies(s) {
  $('cookies').checked = !!s.cookieEnabled;
  $('cookieBody').hidden = !s.cookieEnabled;
  $('cookieReject').checked = !!s.cookieReject;
  // Kept for the smoke suite's long-standing id: the reject row only means
  // anything while the cookie layer is on.
  $('rejectRow').hidden = !(s.enabled && s.cookieEnabled);
}

function renderPopups(s) {
  $('popups').checked = !!s.popupsEnabled;
  $('popupBody').hidden = !s.popupsEnabled;
  for (const [id, key] of Object.entries(POPUP_IDS)) $(id).checked = !!s[key];
}

function renderSite(s) {
  const card = $('siteCard');
  if (!host) { card.hidden = true; return; }
  card.hidden = false;
  $('siteHost').textContent = host;
  $('siteAiRow').hidden = !(AI_HOST_RE.test(host) && s.aiEnabled);
  $('siteAi').checked = (s.aiAllowlist || []).includes(host);
  $('siteRow').hidden = !s.cookieEnabled;
  $('siteAllow').checked = (s.cookieAllowlist || []).includes(host);
  $('sitePopRow').hidden = !s.popupsEnabled;
  $('sitePop').checked = (s.popupAllowlist || []).includes(host);
  // Offer the report only for a host the endpoint will accept (the same rule,
  // src/shared/report-host.js) — an IP address, localhost or a .local name
  // would only earn the user a "failed" message.
  $('reportBtn').hidden = !reportable(host);
}

function reportable(h) {
  const rule = globalThis.QuellReportHost;
  return !!(h && rule && rule.valid(h));
}

function renderLinks() {
  const rate = $('rate');
  const B = globalThis.QuellBrowser || {};
  const url = IS_FIREFOX ? CFG.RATE_URL_FIREFOX : B.opera ? CFG.RATE_URL_OPERA : CFG.RATE_URL_CHROME;
  if (url) rate.href = url; else rate.hidden = true;
  $('sponsor').href = CFG.SPONSOR_URL || 'https://github.com/sponsors/PurpleDirective';
  $('feedback').href = CFG.FEEDBACK_MAILTO || 'mailto:support@purpledirective.com';
  $('privacy').href = CFG.PRIVACY_URL || 'https://purpledirective.com/quell/privacy/';
}

async function render() {
  current = await store.get(S.DEFAULTS);
  const s = current;
  const engines = await enginesOn(s);
  renderHeader(s);
  renderSearch(s, engines);
  renderCookies(s);
  renderPopups(s);
  renderSite(s);
  $('total').textContent = Number(s.totalBlocked || 0).toLocaleString();
  await renderStatus(s);
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
    : confirmThen({ title: `Show ${SURFACE_NAMES[key]} again?`, body: 'Google will show it as usual. You can hide it again any time.' }, { [key]: false }));
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
// the access back to the browser instead of sitting on it (owner decision
// 2026-09-25). Switching either one on again asks for it again, from that
// click. The master switch is a pause, not a "stop using it": it keeps access.
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
  if (current.cookieEnabled || current.popupsEnabled) return; // still in use
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

// --------------------------------------------------------- breakage report --
// Exactly two fields leave the browser, shown to the user verbatim first.
function reportPayload(h) {
  const version = (hasChrome && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : '0.0.0';
  return { host: h, version };
}

function openReport(h) {
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

$('reportBtn').addEventListener('click', () => { if (reportable(host)) openReport(host); });
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
  if (PAGE_VIEW) {
    // A tab has no "current site" of its own; a report handed over from the
    // Firefox popup carries its hostname in the URL (local only).
    host = hostOf('https://' + (params.get('report') || '')) || null;
  } else {
    const tab = await currentTab();
    tabId = tab?.id ?? null;
    host = hostOf(tab?.url);
  }
  await render();
  await renderAccess();
  const grant = params.get('grant');
  const focusId = { engines: 'engines', cookies: 'cookies', popups: 'popups', base: 'grantBase' }[grant];
  if (PAGE_VIEW && focusId) {
    $(focusId).focus();
    $(focusId).closest('.grp, .notice')?.classList.add('flash');
  }
  if (PAGE_VIEW && params.get('report') && reportable(host)) openReport(host);
})();
