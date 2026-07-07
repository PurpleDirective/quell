// Quell — background service worker.
// No network calls, no tracking, no remote state. Everything is local.

const DEFAULTS = {
  enabled: true,
  googleMode: 'hide',
  bingEnabled: true,
  cookieEnabled: false,
  cookieAllowlist: [], // hostnames where the cookie layer is paused
  totalBlocked: 0,
};

// Static rulesets: the hand-curated CMP set + the pipeline-generated
// EasyList Cookie set (pipeline/build_rules.py). Enabled/disabled together.
const COOKIE_RULESETS = ['cookie_cmp', 'cookie_cmp_easylist'];
const COOKIE_SCRIPT_ID = 'quell-cookies';
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
      js: ['src/content/cookies.js'],
      css: ['rules/cookie-generic.css'],
      runAt: 'document_start',
      allFrames: false,
    }]).catch(() => {});
  } else if ((!on || !hasHosts) && existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [COOKIE_SCRIPT_ID] }).catch(() => {});
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

// Seed defaults + reconcile feature state on install/startup.
async function init() {
  const current = await chrome.storage.local.get(DEFAULTS); // merges defaults in
  await chrome.storage.local.set(current);
  chrome.action.setBadgeBackgroundColor({ color: '#5B21B6' });
  await applyCookieBlocking(current.enabled && current.cookieEnabled);
  await syncAllowRules(current.cookieAllowlist);
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

// The popup writes settings straight to storage; react here so the master
// switch and the feature toggle BOTH gate the network + cosmetic layers.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (changes.enabled || changes.cookieEnabled || changes.cookieAllowlist) {
    const s = await chrome.storage.local.get(DEFAULTS);
    await applyCookieBlocking(s.enabled && s.cookieEnabled);
    if (changes.cookieAllowlist) await syncAllowRules(s.cookieAllowlist);
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
