// Quell — popup controller. Reads/writes settings in chrome.storage.local;
// the background worker reacts to storage changes (rulesets, script registration).

const DEFAULTS = {
  enabled: true,
  googleMode: 'hide',
  // Per-surface AI switches — see the note on Quell.DEFAULTS in
  // content/common.js for why hidePaa starts false.
  hideOverview: true,
  hideAiMode: true,
  hidePaa: false,
  hideGemini: true,
  bingEnabled: true,
  // See the note on DEFAULTS in background.js: the engines need BOTH the user's
  // intent and Chrome's grant, because an <all_urls> grant made for the cookie
  // feature also satisfies a containment check for the engine origins.
  enginesEnabled: false,
  // Bing's suggestion chips — see the note on Quell.DEFAULTS in
  // content/common.js for why this starts false.
  hideBingChips: false,
  // See the note on Quell.DEFAULTS in content/common.js for why 'clean' is
  // no longer a default: it redirects, and that is a choice, not a default.
  ddgMode: 'hide',
  braveMode: 'hide',
  yahooMode: 'hide',
  cookieEnabled: false,
  cookieReject: false,
  cookieAllowlist: [],
  totalBlocked: 0,
};

// popup control id -> settings key, for the per-surface switches.
// Per-engine mode selects. Each engine's control id IS its settings key.
const ENGINE_MODES = ['ddgMode', 'braveMode', 'yahooMode'];

// Must stay identical to ENGINE_ORIGINS in background.js — Chrome only grants
// what optional_host_permissions declares, and only registers what was granted.
const ENGINE_ORIGINS = [
  '*://duckduckgo.com/*',
  '*://*.duckduckgo.com/*',
  '*://search.brave.com/*',
  '*://search.yahoo.com/*',
  '*://*.search.yahoo.com/*',
];

// On only when the user asked AND Chrome granted. Re-checking the grant every
// time means revoking access in chrome://extensions still shows as off, while
// the stored intent stops an unrelated <all_urls> grant from switching these
// engines on for someone who never asked for them.
async function enginesOn(s) {
  if (!hasChrome || !chrome.permissions) return false;
  if (!s.enginesEnabled) return false;
  return chrome.permissions.contains({ origins: ENGINE_ORIGINS }).catch(() => false);
}

const SURFACE_IDS = {
  sOverview: 'hideOverview',
  sAiMode: 'hideAiMode',
  sPaa: 'hidePaa',
  sGemini: 'hideGemini',
};
const $ = (id) => document.getElementById(id);

const hasChrome = typeof chrome !== 'undefined' && chrome.runtime;

// Use chrome.storage when running as a real extension; fall back to defaults
// when the popup is opened outside an extension context (e.g. a preview).
const store = (hasChrome && chrome.storage?.local)
  ? chrome.storage.local
  : { get: async (d) => d, set: async () => {} };

// Hostname of the active tab — readable only while we hold host access
// (i.e. the Cookie-banners feature is on), which is exactly when we need it.
async function currentHost() {
  if (!hasChrome || !chrome.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  try {
    const u = new URL(tab?.url || '');
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch (_) { return null; }
}

// The per-site pause row is shown only when the cookie feature is on AND the
// active tab is a normal website.
// The reject switch only means anything while the cookie layer is on.
function renderRejectRow(s) {
  const row = $('rejectRow');
  if (!row) return;
  row.hidden = !(s.enabled && s.cookieEnabled);
  if ($('cookieReject')) $('cookieReject').checked = !!s.cookieReject;
}

async function renderSiteRow(s) {
  const row = $('siteRow');
  if (!row) return;
  const host = s.cookieEnabled ? await currentHost() : null;
  if (!host) { row.hidden = true; return; }
  row.hidden = false;
  $('siteHost').textContent = host;
  $('siteAllow').checked = (s.cookieAllowlist || []).includes(host);
  $('siteAllow').dataset.host = host;
}

// The AI-features section badge must reflect reality: it was a static
// "Active" that kept lying with the master switch off (or every AI feature
// individually off).
function renderAiState(s) {
  const badge = $('aiState');
  if (!badge) return;
  // "Hide" with every per-surface switch off blocks nothing, so it must not
  // read as Active — the badge lying was the bug this function was added for.
  const googleHiding = s.googleMode === 'cleanweb'
    || (s.googleMode === 'hide'
        && (s.hideOverview || s.hideAiMode || s.hidePaa || s.hideGemini));
  const active = s.enabled && (googleHiding || s.bingEnabled);
  badge.textContent = active ? 'Active' : 'Off';
  badge.classList.toggle('on', active);
}

// The per-surface group only applies inside "Hide AI Overviews" — showing it
// under Clean Web or Off would offer switches that do nothing.
function renderSurfaces(s) {
  const box = $('surfaces');
  if (!box) return;
  box.hidden = !(s.enabled && s.googleMode === 'hide');
  for (const [id, key] of Object.entries(SURFACE_IDS)) {
    if ($(id)) $(id).checked = !!s[key];
  }
}

// The Bing chip sub-switch only applies while Bing itself is on — showing it
// with Bing off would offer a switch that does nothing, same reasoning as
// renderSurfaces() for Google's per-surface group.
function renderBingSurfaces(s) {
  const box = $('bingSurfaces');
  if (!box) return;
  box.hidden = !(s.enabled && s.bingEnabled);
  if ($('bChips')) $('bChips').checked = !!s.hideBingChips;
}

// Show the per-engine dropdowns only while their hosts are actually granted.
async function renderEngines(s) {
  const box = $('engineModes');
  const sw = $('engines');
  const on = await enginesOn(s);
  if (sw) sw.checked = on;
  if (box) box.hidden = !(s.enabled && on);
}

async function refreshAiState() {
  const s = await store.get(DEFAULTS);
  renderAiState(s);
  renderSurfaces(s);
  renderBingSurfaces(s);
  await renderEngines(s);
}

async function load() {
  const s = await store.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  $('stateLabel').textContent = s.enabled ? 'on' : 'off';
  for (const r of document.querySelectorAll('input[name="gmode"]')) {
    r.checked = r.value === s.googleMode;
  }
  $('bing').checked = s.bingEnabled;
  if ($('cookies')) $('cookies').checked = s.cookieEnabled;
  $('total').textContent = Number(s.totalBlocked).toLocaleString();
  for (const key of ENGINE_MODES) {
    const el = $(key);
    if (el) el.value = s[key];
  }
  renderAiState(s);
  renderSurfaces(s);
  renderBingSurfaces(s);
  renderRejectRow(s);
  await renderEngines(s);
  await renderSiteRow(s);
}

$('enabled').addEventListener('change', (e) => {
  store.set({ enabled: e.target.checked }).then(refreshAiState);
  $('stateLabel').textContent = e.target.checked ? 'on' : 'off';
});

for (const r of document.querySelectorAll('input[name="gmode"]')) {
  r.addEventListener('change', () => store.set({ googleMode: r.value }).then(refreshAiState));
}

$('bing').addEventListener('change', (e) => {
  store.set({ bingEnabled: e.target.checked }).then(refreshAiState);
});

if ($('bChips')) {
  $('bChips').addEventListener('change', (e) => {
    store.set({ hideBingChips: e.target.checked }).then(refreshAiState);
  });
}

for (const key of ENGINE_MODES) {
  const el = $(key);
  if (el) el.addEventListener('change', (e) => {
    store.set({ [key]: e.target.value }).then(refreshAiState);
  });
}

for (const [id, key] of Object.entries(SURFACE_IDS)) {
  const el = $(id);
  if (el) el.addEventListener('change', (e) => {
    store.set({ [key]: e.target.checked }).then(refreshAiState);
  });
}

// Other search engines — Quell ships with Google + Bing access only, so these
// three hosts are requested here, on the user's click (permissions.request
// needs a gesture). Background registers the content script off the resulting
// permission event. Turning it back off REVOKES the access rather than just
// forgetting it: leaving a host grant in place for a feature the user switched
// off is exactly the kind of quiet over-reach this extension exists to avoid.
const engines = $('engines');
if (engines) {
  engines.addEventListener('change', async (e) => {
    if (!hasChrome || !chrome.permissions) return; // preview context — no-op
    if (e.target.checked) {
      const granted = await chrome.permissions
        .request({ origins: ENGINE_ORIGINS })
        .catch(() => false);
      if (!granted) { e.target.checked = false; return; }
      await store.set({ enginesEnabled: true });
    } else {
      // Clear the intent FIRST: remove() cannot revoke an <all_urls> grant the
      // cookie feature owns, so the stored flag is what actually turns this
      // off. Without it the switch sprang straight back on.
      await store.set({ enginesEnabled: false });
      await chrome.permissions.remove({ origins: ENGINE_ORIGINS }).catch(() => {});
    }
    await renderEngines(await store.get(DEFAULTS));
  });
}

// Cookie banners — needs all-sites access for the cosmetic layer, so we request
// it on the user's click (a gesture) and only enable on grant. The background
// picks the change up via storage.onChanged.
const cookies = $('cookies');
if (cookies) {
  cookies.addEventListener('change', async (e) => {
    if (!hasChrome) return; // preview context — no-op
    if (e.target.checked) {
      const granted = await chrome.permissions
        .request({ origins: ['<all_urls>'] })
        .catch(() => false);
      if (!granted) { e.target.checked = false; return; }
      await store.set({ cookieEnabled: true });
    } else {
      await store.set({ cookieEnabled: false });
    }
    const next = await store.get(DEFAULTS);
    renderRejectRow(next);
    await renderSiteRow(next);
  });
}

// Per-site pause — the breakage escape hatch for the beta cookie feature.
const siteAllow = $('siteAllow');
if (siteAllow) {
  siteAllow.addEventListener('change', async (e) => {
    const host = e.target.dataset.host;
    if (!host) return;
    const { cookieAllowlist } = await store.get({ cookieAllowlist: [] });
    const next = e.target.checked
      ? [...new Set([...cookieAllowlist, host])]
      : cookieAllowlist.filter((h) => h !== host);
    await store.set({ cookieAllowlist: next });
  });
}

load();

const rejectToggle = $('cookieReject');
if (rejectToggle) {
  rejectToggle.addEventListener('change', (e) => {
    store.set({ cookieReject: e.target.checked });
  });
}
