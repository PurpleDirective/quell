// Quell — background (Chrome/Edge: service worker; Firefox: event page).
// No network calls, no tracking. The only thing Quell ever sends anywhere is a
// breakage report the user clicks, and that is sent from the popup, not here.
// Settings: storage.sync (the user's choices, synced by the browser to their
// own account) + storage.local (grant-bound switches, counter) — see
// src/shared/settings.js.

// Chrome loads only this file as the service worker; Firefox's manifest lists
// settings.js first in background.scripts, so it is already defined there.
if (typeof QuellSettings === 'undefined' && typeof importScripts === 'function') {
  importScripts('/src/shared/settings.js');
}

// Only the keys this worker reads; everything else is the content scripts'.
const DEFAULTS = {
  enabled: true,
  // The user's INTENT to run on the optional engines, kept separately from the
  // permission. permissions.contains() is semantic containment, so an
  // <all_urls> grant — which the Cookie-banners feature asks for — satisfies a
  // query for the engine origins. Keying the feature off the grant alone
  // therefore switched DuckDuckGo, Brave and Yahoo on for anyone who had
  // enabled cookie blocking, without ever asking them, and left the popup's own
  // off switch unable to turn it back off. Both must be true: they asked, AND
  // Chrome granted.
  enginesEnabled: false,
  cookieEnabled: false,
  cookieAllowlist: [], // hostnames where the cookie layer is paused
  cookieReject: false,  // "Say reject all for me"
  popupsEnabled: false,
  totalBlocked: 0,
};
const readSettings = (d = DEFAULTS) => QuellSettings.get(d);

// Static rulesets: the hand-curated CMP set + the pipeline-generated
// EasyList Cookie set (pipeline/build_rules.py). Enabled/disabled together.
const COOKIE_RULESETS = ['cookie_cmp', 'cookie_cmp_easylist'];
const COOKIE_SCRIPT_ID = 'quell-cookies';
const ENGINE_SCRIPT_ID = 'quell-engines';
const POPUP_SCRIPT_ID = 'quell-popups';
const COOKIE_FILES = ['src/shared/settings.js', 'src/content/cookies.js'];
const ENGINE_FILES = ['src/shared/settings.js', 'src/content/common.js', 'src/content/engines.js'];
const POPUP_FILES = ['src/shared/settings.js', 'src/content/popups.js'];

// DuckDuckGo / Brave / Yahoo are OPTIONAL hosts, requested from the popup and
// registered here once granted. They are deliberately not in the manifest's
// content_scripts: host patterns declared there are REQUIRED permissions, and
// Chrome compares the required host set of an update against what the user
// already granted — as raw URL patterns, not as warning strings. Any host that
// is not covered by an existing grant is a privilege increase, and Chrome's
// response to a privilege increase is to DISABLE the extension for every
// existing user until each one re-approves it. Shipping these three engines as
// required hosts would therefore have switched Quell off for the entire
// installed base, and silently for anyone who never noticed the prompt.
//
// So: the required host set is frozen at Google + Bing, permanently. Every
// engine added from here on goes in optional_host_permissions, where adding
// entries costs nothing on update. The list is APPEND-ONLY — removing a host
// and re-adding it later interacts badly with the stored grant set.
const ENGINE_ORIGINS = [
  '*://duckduckgo.com/*',
  '*://*.duckduckgo.com/*',
  '*://search.brave.com/*',
  '*://search.yahoo.com/*',
  '*://*.search.yahoo.com/*',
];
// Narrower than the granted origins: the grant is what Chrome asked the user
// about, this is where we actually run.
const ENGINE_MATCHES = [
  '*://duckduckgo.com/*',
  '*://*.duckduckgo.com/*',
  '*://search.brave.com/search*',
  '*://search.yahoo.com/search*',
  '*://*.search.yahoo.com/search*',
];
// Dynamic dNR allow-rule ids for allowlisted sites live above the static range.
const ALLOW_RULE_BASE = 100000;

// Apply the Cookie-banners feature: network rulesets (no host access needed)
// plus the cosmetic layer (needs <all_urls>, granted optionally) — a generated
// generic-selector stylesheet Chrome injects natively, and the content script
// for counting, scroll-unlock, and per-domain selectors.
// `on` must already combine the master switch AND the feature toggle.
async function applyCookieBlocking(on) {
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      on
        ? { enableRulesetIds: COOKIE_RULESETS }
        : { disableRulesetIds: COOKIE_RULESETS }
    );
  } catch (_) { /* rulesets already in desired state */ }

  const hasHosts = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [COOKIE_SCRIPT_ID] }).catch(() => []);

  if (on && hasHosts && existing.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: COOKIE_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: COOKIE_FILES,
      css: ['rules/cookie-generic.css'],
      runAt: 'document_start',
      allFrames: false,
    }]).catch(() => {});
  } else if ((!on || !hasHosts) && existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [COOKIE_SCRIPT_ID] }).catch(() => {});
  }
}

// Keep the engine content script registered exactly while the user has asked
// for it AND Chrome has granted the hosts. Revoking access in
// chrome://extensions still turns it off for real, because the grant is
// re-checked here rather than remembered.
async function applyEngineScripts() {
  const { enginesEnabled } = await chrome.storage.local
    .get({ enginesEnabled: false }).catch(() => ({ enginesEnabled: false }));
  const hasHosts = await chrome.permissions
    .contains({ origins: ENGINE_ORIGINS }).catch(() => false);
  const granted = enginesEnabled && hasHosts;
  const existing = await chrome.scripting
    .getRegisteredContentScripts({ ids: [ENGINE_SCRIPT_ID] }).catch(() => []);

  if (granted && existing.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: ENGINE_SCRIPT_ID,
      matches: ENGINE_MATCHES,
      js: ENGINE_FILES,
      runAt: 'document_start',
      allFrames: false,
    }]).catch(() => {});
  } else if (!granted && existing.length > 0) {
    await chrome.scripting
      .unregisterContentScripts({ ids: [ENGINE_SCRIPT_ID] }).catch(() => {});
  }
}

// A registered content script only injects on NAVIGATION, so a tab already
// sitting on a search page saw nothing until it was reloaded — the same
// "I turned it on and nothing happened" the cookie layer had.
async function syncEngineLayerInOpenTabs() {
  const { enginesEnabled } = await chrome.storage.local
    .get({ enginesEnabled: false }).catch(() => ({ enginesEnabled: false }));
  const hasHosts = await chrome.permissions
    .contains({ origins: ENGINE_ORIGINS }).catch(() => false);
  if (!enginesEnabled || !hasHosts) return;
  const tabs = await chrome.tabs.query({ url: ENGINE_MATCHES }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ENGINE_FILES,
    }).catch(() => {});
  }
}

// Grants and revocations can happen from chrome://extensions as well as from
// the popup, so react to the permission event itself, not just to our own UI.
chrome.permissions.onAdded.addListener(async () => {
  await applyEngineScripts();
  await syncEngineLayerInOpenTabs();
});
// The popup marks a removal it makes itself (giving all-sites access back
// when Cookie banners and Pop-ups are both off) so it is not mistaken for the
// user revoking the engines: Chrome's remove(<all_urls>) takes the engine
// hosts with it, and the popup asks for them straight back on the same click.
// One-shot and short-lived: consumed by the first removal event that sees it.
const RELEASE_KEY = 'quellReleasingAllSites';
const RELEASE_WINDOW_MS = 30000;
async function consumeOwnRelease() {
  const got = await chrome.storage.session.get({ [RELEASE_KEY]: 0 }).catch(() => ({}));
  const t = Number(got[RELEASE_KEY]) || 0;
  if (!t) return false;
  await chrome.storage.session.remove(RELEASE_KEY).catch(() => {});
  return Date.now() - t < RELEASE_WINDOW_MS;
}

chrome.permissions.onRemoved.addListener(async () => {
  const ours = await consumeOwnRelease();
  // Revoking access in chrome://extensions is the user switching the feature
  // off. Clear the stored intent too — otherwise it lingers, and the next
  // <all_urls> grant (turning Cookie banners on) would satisfy the containment
  // check and silently re-register engines they had revoked.
  const has = await chrome.permissions
    .contains({ origins: ENGINE_ORIGINS }).catch(() => false);
  if (!has && !ours) await chrome.storage.local.set({ enginesEnabled: false }).catch(() => {});
  await applyEngineScripts();

  // Same rule for all-sites access: without it, Cookie banners and Pop-ups
  // cannot run, so a switch still reading "on" would be lying. Switch them
  // off (the popup then asks again when they are switched back on) and take
  // their scripts down. The cookie layer's network rules need no host access,
  // but they are the same feature and go with it.
  const all = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!all) {
    const s = await readSettings();
    const patch = {};
    if (s.cookieEnabled) patch.cookieEnabled = false;
    if (s.popupsEnabled) patch.popupsEnabled = false;
    if (Object.keys(patch).length) await chrome.storage.local.set(patch).catch(() => {});
    const on = s.enabled;
    await applyCookieBlocking(on && s.cookieEnabled && !('cookieEnabled' in patch));
    await applyPopupLayer(on && s.popupsEnabled && !('popupsEnabled' in patch));
  }
});

// Give all-sites access back when nothing uses it — on startup and update, so
// a user who switched both features off in an earlier version gets it back
// too. The popup does the same on the click that switches the last one off;
// this is the path for state that is already off. Skipped while DuckDuckGo,
// Brave and Yahoo are on: in Chrome the removal would take their hosts too,
// and only the popup, on a click, can ask for those back.
async function releaseAllSitesIfUnused() {
  const s = await readSettings();
  if (s.cookieEnabled || s.popupsEnabled || s.enginesEnabled) return;
  const held = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!held) return;
  // Re-read: a popup click can grant access for a feature switched on in the
  // moment since the first read (browser start). Never take it back from that.
  const now = await readSettings();
  if (now.cookieEnabled || now.popupsEnabled || now.enginesEnabled) return;
  await chrome.permissions.remove({ origins: ['<all_urls>'] }).catch(() => false);
}

// Chrome only injects registered content scripts on NAVIGATION, so switching
// the cookie feature on did nothing to tabs the user already had open — it
// read as "I turned it on and the banner is still there". We can inject into
// open tabs here because enabling the feature is exactly when the user grants
// <all_urls>; without that grant this is a no-op.
// CSS added via insertCSS (unlike the registered content-script CSS) can be
// pulled back out again, so tabs healed this way also revert cleanly on off.
async function syncCookieLayerInOpenTabs(on) {
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!granted) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id) continue;
    const target = { tabId: tab.id };
    if (on) {
      chrome.scripting.insertCSS({ target, files: ['rules/cookie-generic.css'] }).catch(() => {});
      chrome.scripting.executeScript({ target, files: COOKIE_FILES }).catch(() => {});
    } else {
      // Only removes CSS this path inserted; a no-op elsewhere.
      chrome.scripting.removeCSS({ target, files: ['rules/cookie-generic.css'] }).catch(() => {});
    }
  }
}

// Pop-ups layer (0.6.0, OFF by default): cosmetic only, no network rules. Same
// gate as the cookie layer — the user's switch AND the <all_urls> grant —
// because it runs on the sites the user visits.
async function applyPopupLayer(on) {
  const hasHosts = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [POPUP_SCRIPT_ID] }).catch(() => []);
  if (on && hasHosts && existing.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: POPUP_SCRIPT_ID,
      matches: ['<all_urls>'],
      js: POPUP_FILES,
      runAt: 'document_start',
      allFrames: false,
    }]).catch(() => {});
  } else if ((!on || !hasHosts) && existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [POPUP_SCRIPT_ID] }).catch(() => {});
  }
}

// Switching the layer on heals tabs already open (registered scripts only
// inject on navigation). Switching it off needs nothing here: popups.js tears
// itself down from the settings change, since it injects its own <style>.
async function syncPopupLayerInOpenTabs() {
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  if (!granted) return;
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: POPUP_FILES }).catch(() => {});
  }
}

// The network layer must also respect the per-site pause: one dNR "allow" rule
// per allowlisted host exempts requests that site initiates from the static
// block rules (higher priority wins).
async function syncAllowRules(allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
  const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= ALLOW_RULE_BASE);
  const addRules = (allowlist || []).slice(0, 500).map((host, i) => ({
    id: ALLOW_RULE_BASE + i,
    priority: 2,
    action: { type: 'allow' },
    condition: {
      initiatorDomains: [host],
      resourceTypes: ['script', 'xmlhttprequest', 'sub_frame', 'stylesheet', 'image'],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }).catch(() => {});
}

// "Say reject all for me" needs the consent platform to LOAD: its own
// Reject-all button is what records the refusal. The network layer blocks
// those same platforms' scripts, which is right for hide-only users (the
// banner never downloads) but left the reject switch with nothing to press on
// every OneTrust, Cookiebot, Didomi and Osano site that loads the platform
// from its CDN — live 2026-09-25, ikea.com and gap.com: cdn.cookielaw.org
// blocked, no banner, no choice recorded. With reject on, exactly the
// platforms whose Reject-all cookies.js knows how to press are let through by
// one dynamic allow rule above the static blocks; every other consent
// platform stays blocked. One fixed id, removed and re-added in one call, so
// repeated syncs cannot stack or race into a duplicate.
const REJECT_RULE_ID = 90000;
const REJECT_CMP_DOMAINS = [
  'cookielaw.org', 'onetrust.com',          // OneTrust (CDN + geolocation)
  'cookiebot.com', 'cookiebot.eu',          // Cookiebot
  'privacy-center.org', 'didomi.io',        // Didomi (sdk.privacy-center.org)
  'osano.com',                              // Osano (cmp.osano.com)
];
async function syncRejectRules(on) {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REJECT_RULE_ID],
    addRules: on ? [{
      id: REJECT_RULE_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: { requestDomains: REJECT_CMP_DOMAINS },
    }] : [],
  }).catch(() => {});
}

// Reconcile feature state on install/startup. Defaults are deliberately NOT
// written into storage here: every reader merges DEFAULTS at read time via
// get(DEFAULTS), so seeding added nothing — and its read-then-write raced
// (and clobbered) any settings write landing in the same window, e.g. a
// popup toggle right after service-worker start.
async function init() {
  // 0.5.x kept every setting in storage.local; 0.6.0 moves the user's choices
  // to storage.sync. Idempotent, and a no-op once done.
  await QuellSettings.migrate().catch(() => {});
  const current = await readSettings();
  chrome.action.setBadgeBackgroundColor({ color: '#5B21B6' });
  await applyCookieBlocking(current.enabled && current.cookieEnabled);
  await applyEngineScripts();
  await applyPopupLayer(current.enabled && current.popupsEnabled);
  await syncAllowRules(current.cookieAllowlist);
  await syncRejectRules(current.enabled && current.cookieEnabled && current.cookieReject);
  await releaseAllSitesIfUnused();
}

// The welcome page opens ONCE, on a fresh install — never on an update, which
// would be an unasked-for tab for every existing user on every release.
const WELCOME_PAGE = 'src/welcome/welcome.html';
chrome.runtime.onInstalled.addListener(async (details) => {
  await init();
  if (details && details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) }).catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(init);

// The popup writes settings straight to storage; react here so the master
// switch and the feature toggle BOTH gate the network + cosmetic layers.
//
// A per-device switch (enginesEnabled, cookieEnabled, popupsEnabled) counts
// only when it changes in storage.local, where it lives: a stray copy in
// sync must never switch a grant-bound feature on for another device. The
// user's synced choices count from either area (local is where 0.5.x kept
// them, and where they stay if a browser has no sync area).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' && area !== 'sync') return;
  const changed = (k) => k in changes && (QuellSettings.home(k) === 'sync' || area === 'local');
  if (changed('enginesEnabled')) {
    await applyEngineScripts();
    await syncEngineLayerInOpenTabs();
  }
  if (changed('enabled') || changed('cookieEnabled') || changed('cookieAllowlist')) {
    const s = await readSettings();
    const on = s.enabled && s.cookieEnabled;
    await applyCookieBlocking(on);
    if (changed('enabled') || changed('cookieEnabled')) await syncCookieLayerInOpenTabs(on);
    if (changed('cookieAllowlist')) await syncAllowRules(s.cookieAllowlist);
  }
  if (changed('enabled') || changed('cookieEnabled') || changed('cookieReject')) {
    const s = await readSettings();
    await syncRejectRules(s.enabled && s.cookieEnabled && s.cookieReject);
  }
  if (changed('enabled') || changed('popupsEnabled')) {
    const s = await readSettings();
    const on = s.enabled && s.popupsEnabled;
    await applyPopupLayer(on);
    if (on) await syncPopupLayerInOpenTabs();
  }
});

// Domain-specific hide selectors (pipeline-generated). The content script asks
// for its own host's slice — we never ship the whole map to pages, and the
// file is not web-accessible (sites can't fingerprint Quell by probing it).
let domainRulesPromise = null;
function getDomainRules() {
  domainRulesPromise ??= fetch(chrome.runtime.getURL('rules/cookie-domains.json'))
    .then((r) => r.json())
    .catch(() => ({}));
  return domainRulesPromise;
}

async function selectorsForHost(host) {
  if (!host) return [];
  const map = await getDomainRules();
  const out = [];
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (map[suffix]) out.push(...map[suffix]);
  }
  return out;
}

// Pop-up rules (pipeline-generated, ~280 KB). Loaded once per worker life and
// served per page: the generic selectors of the categories the user has on,
// plus this host's own slice. Not web-accessible, like the cookie map.
let popupRulesPromise = null;
function getPopupRules() {
  popupRulesPromise ??= fetch(chrome.runtime.getURL('rules/popups.json'))
    .then((r) => r.json())
    .catch(() => ({}));
  return popupRulesPromise;
}
const POPUP_CATS = ['newsletter', 'chat', 'app'];
async function popupRulesFor(host, cats) {
  const rules = await getPopupRules();
  const generic = [], site = [];
  const parts = (host || '').split('.');
  for (const cat of (cats || []).filter((c) => POPUP_CATS.includes(c))) {
    const r = rules[cat];
    if (!r) continue;
    generic.push(...(r.generic || []));
    for (let i = 0; i < parts.length - 1; i++) {
      const suffix = parts.slice(i).join('.');
      if (r.domains && r.domains[suffix]) site.push(...r.domains[suffix]);
    }
  }
  return { generic, site };
}

// Per-tab counts drive the toolbar badge. They live in storage.session so they
// survive service-worker suspends, and reset on navigation / tab close.
// Increments are serialized through one promise chain — concurrent 'blocked'
// messages would otherwise race the read-modify-write and lose counts.
let queue = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'blocked' && sender.tab && Number.isInteger(msg.count) && msg.count > 0) {
    const count = Math.min(msg.count, 500);
    const tabId = sender.tab.id;
    queue = queue.then(async () => {
      const key = 'tab:' + tabId;
      const cur = (await chrome.storage.session.get({ [key]: 0 }))[key] + count;
      await chrome.storage.session.set({ [key]: cur });
      chrome.action.setBadgeText({ tabId, text: String(cur) });
      const { totalBlocked } = await chrome.storage.local.get({ totalBlocked: 0 });
      await chrome.storage.local.set({ totalBlocked: totalBlocked + count });
    }).catch(() => {});
    return;
  }

  // Content script asks for its host's domain-specific hide selectors.
  // Host comes from sender.url (trustworthy), never from the message body.
  if (msg?.type === 'cookieSiteRules' && sender.url) {
    let host = '';
    try { host = new URL(sender.url).hostname; } catch (_) { /* opaque origin */ }
    selectorsForHost(host).then((selectors) => sendResponse({ selectors }));
    return true; // async response
  }

  if (msg?.type === 'popupRules' && sender.url) {
    let host = '';
    try { host = new URL(sender.url).hostname; } catch (_) { /* opaque origin */ }
    popupRulesFor(host, msg.cats).then((r) => sendResponse(r));
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.storage.session.remove('tab:' + tabId);
    chrome.action.setBadgeText({ tabId, text: '' });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('tab:' + tabId);
});
