// Quell — background service-worker tests, executed rather than grepped.
//
// Chrome's optional-permission prompt is browser UI that Playwright cannot
// accept, so the smoke suite could only ever read the grant/revoke path as
// SOURCE TEXT: "does the file mention registerContentScripts", "is there an
// onAdded listener". Eleven mutations survived that — you can delete the body
// of syncEngineLayerInOpenTabs, or make onRemoved forget to clear the intent,
// and every regex still matches.
//
// This file runs the real background.js inside a vm context against a fake
// `chrome` that records every call, then fires the events Chrome would fire.
// No browser, no network. Run:  node tests/background.mjs
//
// The fake is deliberately minimal and STRICT: any chrome.* API background.js
// touches that is not modelled here throws, so a new dependency shows up as a
// failure rather than a silent undefined.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
// QUELL_BG lets the mutation battery point this harness at a mutated copy.
const BG = readFileSync(process.env.QUELL_BG || path.join(EXT, 'src/background.js'), 'utf8');

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}`); }
};

// An event with a `fire` the test can call. Listeners run in registration
// order and `fire` resolves once every async listener has settled — the
// assertions below read the recorded calls only after that.
const event = () => {
  const ls = [];
  return {
    addListener: (f) => ls.push(f),
    fire: async (...a) => { for (const f of ls) await f(...a); },
    count: () => ls.length,
  };
};

// Wait for promise chains background.js does not await (executeScript is
// fire-and-forget there). One macrotask is enough for the fake's microtasks.
const settle = () => new Promise((r) => setTimeout(r, 0));

// The lists background.js actually uses, read from the source — not restated
// here, so the test cannot drift from it.
const arrOf = (name) => {
  const m = BG.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};
const ENGINE_ORIGINS = arrOf('ENGINE_ORIGINS');
const ENGINE_MATCHES = arrOf('ENGINE_MATCHES');

// `granted` is the set of origin patterns Chrome has granted: an array, or
// `true` as shorthand for exactly the engine origins. permissions.contains()
// honours its argument the way Chrome does — every requested origin must be
// covered, and an `<all_urls>` grant covers everything (semantic containment,
// which is the whole reason the intent flag exists). Round 4 found the
// earlier fake ignored the argument, so a background that queried the wrong
// origins could not be told apart from one that queried the right ones.
function makeChrome({ granted = false, storage = {}, tabs = [] } = {}) {
  const calls = [];
  const rec = (name, arg) => { calls.push([name, arg]); };
  const local = { ...storage };
  const registered = new Map();
  const toSet = (g) => new Set(g === true ? ENGINE_ORIGINS : g === false ? [] : g);
  const state = { granted: toSet(granted), tabs, grant: (g) => { state.granted = toSet(g); } };

  const chrome = {
    storage: {
      local: {
        get: async (d) => {
          const out = {};
          if (Array.isArray(d)) for (const k of d) { if (k in local) out[k] = local[k]; }
          else if (typeof d === 'string') { if (d in local) out[d] = local[d]; }
          else for (const [k, v] of Object.entries(d || {})) out[k] = k in local ? local[k] : v;
          return out;
        },
        set: async (o) => { Object.assign(local, o); rec('storage.local.set', { ...o }); },
      },
      session: {
        get: async (d) => d,
        set: async () => {},
        remove: async () => {},
      },
      onChanged: event(),
    },
    permissions: {
      contains: async ({ origins }) => {
        rec('permissions.contains', origins);
        if (!Array.isArray(origins) || origins.length === 0) return false;
        return origins.every((o) => state.granted.has(o) || state.granted.has('<all_urls>'));
      },
      onAdded: event(),
      onRemoved: event(),
    },
    scripting: {
      registerContentScripts: async (arr) => {
        for (const s of arr) {
          if (registered.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
          registered.set(s.id, s);
        }
        rec('scripting.registerContentScripts', arr.map((s) => ({ ...s })));
      },
      unregisterContentScripts: async ({ ids }) => {
        for (const id of ids) registered.delete(id);
        rec('scripting.unregisterContentScripts', [...ids]);
      },
      getRegisteredContentScripts: async (f) =>
        [...registered.values()].filter((s) => !f?.ids || f.ids.includes(s.id)),
      executeScript: async (o) => { rec('scripting.executeScript', o); },
      insertCSS: async (o) => { rec('scripting.insertCSS', o); },
      removeCSS: async (o) => { rec('scripting.removeCSS', o); },
    },
    tabs: {
      query: async (q) => { rec('tabs.query', q); return state.tabs; },
      onUpdated: event(),
      onRemoved: event(),
    },
    declarativeNetRequest: {
      updateEnabledRulesets: async (o) => { rec('dnr.updateEnabledRulesets', o); },
      getDynamicRules: async () => [],
      updateDynamicRules: async (o) => { rec('dnr.updateDynamicRules', o); },
    },
    action: {
      setBadgeBackgroundColor: () => {},
      setBadgeText: () => {},
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getURL: (p) => 'chrome-extension://test/' + p,
    },
  };
  return { chrome, calls, registered, local, state };
}

// Load background.js fresh for each case: module-level state (the badge
// queue, the rules promise) must not leak between scenarios.
function boot(opts) {
  const h = makeChrome(opts);
  const sandbox = {
    chrome: h.chrome,
    fetch: async () => ({ json: async () => ({}) }),
    URL, setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(BG, sandbox, { filename: 'background.js' });
  h.ENGINE_ORIGINS = ENGINE_ORIGINS;
  h.ENGINE_MATCHES = ENGINE_MATCHES;
  h.of = (name) => h.calls.filter(([n]) => n === name).map(([, a]) => a);
  h.reset = () => { h.calls.length = 0; };
  return h;
}

const ENGINE_TABS = [
  { id: 11, url: 'https://duckduckgo.com/?q=a' },
  { id: undefined, url: 'https://search.brave.com/search?q=b' }, // no id: skipped
  { id: 13, url: 'https://search.yahoo.com/search?p=c' },
];

// --- Grant: intent + grant → register, and heal the tabs already open -----
console.log('Background — grant path (permissions.onAdded):');
{
  const h = boot({ granted: true, storage: { enginesEnabled: true }, tabs: ENGINE_TABS });
  ok(h.chrome.permissions.onAdded.count() === 1, 'background listens for permissions.onAdded');
  await h.chrome.permissions.onAdded.fire({ origins: h.ENGINE_ORIGINS });
  await settle();

  const reg = h.of('scripting.registerContentScripts');
  ok(reg.length === 1 && reg[0].length === 1 && reg[0][0].id === 'quell-engines',
    `grant registers the engine script exactly once (${reg.length} calls)`);
  const s = reg[0]?.[0] || {};
  ok(JSON.stringify(s.matches) === JSON.stringify(h.ENGINE_MATCHES),
    'registered against ENGINE_MATCHES (the narrower list), not the granted origins');
  ok(Array.isArray(s.js) && s.js[0] === 'src/content/common.js' && s.js[1] === 'src/content/engines.js',
    'registered script is common.js THEN engines.js (order matters — engines.js needs window.Quell)');
  ok(s.runAt === 'document_start' && s.allFrames === false,
    'runs at document_start, top frame only');

  const q = h.of('tabs.query');
  ok(q.length === 1 && JSON.stringify(q[0].url) === JSON.stringify(h.ENGINE_MATCHES),
    'open tabs are queried by ENGINE_MATCHES');
  const ex = h.of('scripting.executeScript');
  ok(ex.length === 2 && ex.map((e) => e.target.tabId).join(',') === '11,13',
    `already-open engine tabs are injected (tabIds ${ex.map((e) => e.target.tabId).join(',')}); the id-less tab is skipped`);
  ok(ex.every((e) => e.files?.[0] === 'src/content/common.js' && e.files?.[1] === 'src/content/engines.js'),
    'open-tab injection carries common.js + engines.js too');

  // Idempotent: a second grant event must not register twice.
  h.reset();
  await h.chrome.permissions.onAdded.fire({ origins: h.ENGINE_ORIGINS });
  await settle();
  ok(h.of('scripting.registerContentScripts').length === 0,
    'a second grant event does not double-register');
}

// --- The gate is intent AND grant, in both directions ---------------------
console.log('Background — the gate holds without both halves:');
{
  // Intent without grant (e.g. storage set by hand, or a grant that failed).
  const h = boot({ granted: false, storage: { enginesEnabled: true }, tabs: ENGINE_TABS });
  await h.chrome.permissions.onAdded.fire({ origins: ['<all_urls>'] });
  await h.chrome.storage.onChanged.fire({ enginesEnabled: { newValue: true } }, 'local');
  await settle();
  ok(h.of('scripting.registerContentScripts').length === 0, 'intent without the grant registers nothing');
  ok(h.of('scripting.executeScript').length === 0, 'intent without the grant injects into no open tab');
  ok(h.of('tabs.query').length === 0, 'intent without the grant does not even enumerate tabs');
}
{
  // Grant without intent — the <all_urls> case: a cookie-feature grant
  // satisfies a containment check for the engine origins.
  const h = boot({ granted: true, storage: { enginesEnabled: false }, tabs: ENGINE_TABS });
  await h.chrome.permissions.onAdded.fire({ origins: ['<all_urls>'] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.of('scripting.registerContentScripts').length === 0,
    'an <all_urls> grant with no stored intent registers nothing');
  ok(h.of('scripting.executeScript').length === 0,
    'and injects into no open tab');
}

// --- storage.onChanged: the popup's switch, both directions ---------------
console.log('Background — storage.onChanged(enginesEnabled):');
{
  const h = boot({ granted: true, storage: { enginesEnabled: false }, tabs: ENGINE_TABS });
  ok(h.chrome.storage.onChanged.count() === 1, 'background listens for storage.onChanged');

  // Other areas are not ours.
  h.local.enginesEnabled = true;
  await h.chrome.storage.onChanged.fire({ enginesEnabled: { newValue: true } }, 'sync');
  await settle();
  ok(h.of('scripting.registerContentScripts').length === 0, 'a change in storage.sync is ignored');

  await h.chrome.storage.onChanged.fire({ enginesEnabled: { newValue: true } }, 'local');
  await settle();
  ok(h.of('scripting.registerContentScripts').length === 1, 'intent ON (with grant) registers');
  ok(h.of('scripting.executeScript').length === 2, 'intent ON heals the open engine tabs');

  // An unrelated key must not touch the engine layer at all.
  h.reset();
  await h.chrome.storage.onChanged.fire({ totalBlocked: { newValue: 5 } }, 'local');
  await settle();
  ok(h.of('scripting.executeScript').length === 0 && h.of('scripting.unregisterContentScripts').length === 0,
    'an unrelated key change leaves the engine layer alone');

  // OFF: unregister, and do NOT inject.
  h.reset();
  h.local.enginesEnabled = false;
  await h.chrome.storage.onChanged.fire({ enginesEnabled: { newValue: false } }, 'local');
  await settle();
  const un = h.of('scripting.unregisterContentScripts');
  ok(un.length === 1 && un[0].includes('quell-engines'), 'intent OFF unregisters the engine script');
  ok(h.of('scripting.executeScript').length === 0, 'intent OFF injects nothing');
  ok(h.registered.size === 0, 'nothing stays registered after OFF');

  // OFF again: nothing to unregister, must not throw or call.
  h.reset();
  await h.chrome.storage.onChanged.fire({ enginesEnabled: { newValue: false } }, 'local');
  await settle();
  ok(h.of('scripting.unregisterContentScripts').length === 0, 'OFF when already off is a no-op');
}

// --- Revocation from chrome://extensions ----------------------------------
console.log('Background — revoke path (permissions.onRemoved):');
{
  const h = boot({ granted: true, storage: { enginesEnabled: true }, tabs: [] });
  await h.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  ok(h.registered.has('quell-engines'), 'precondition: registered after install with intent + grant');

  h.reset();
  h.state.grant(false); // the user revoked the engine hosts
  await h.chrome.permissions.onRemoved.fire({ origins: h.ENGINE_ORIGINS });
  await settle();
  const sets = h.of('storage.local.set').filter((o) => 'enginesEnabled' in o);
  ok(sets.length === 1 && sets[0].enginesEnabled === false,
    'revoking the hosts clears the stored intent (so a later <all_urls> grant cannot resurrect it)');
  ok(h.of('scripting.unregisterContentScripts').some((ids) => ids.includes('quell-engines')),
    'revoking the hosts unregisters the engine script');
  ok(h.registered.size === 0, 'nothing stays registered after revoke');
}
{
  // A removal event for some OTHER origin, while the engine hosts are still
  // granted, must not switch the feature off.
  const h = boot({ granted: true, storage: { enginesEnabled: true }, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  h.reset();
  await h.chrome.permissions.onRemoved.fire({ origins: ['<all_urls>'] });
  await settle();
  ok(!h.of('storage.local.set').some((o) => 'enginesEnabled' in o),
    'removing an unrelated origin leaves the intent alone');
  ok(h.registered.has('quell-engines'), 'and keeps the engine script registered');
}

// --- init(): startup reconciles from stored state ---------------------------
console.log('Background — init() on startup:');
{
  const h = boot({ granted: true, storage: { enginesEnabled: true }, tabs: ENGINE_TABS });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.registered.has('quell-engines'), 'startup with intent + grant registers the engine script');
  // Startup is not a toggle: Chrome injects registered scripts on navigation,
  // and every tab is navigating at browser start.
  ok(h.of('scripting.executeScript').length === 0, 'startup does not inject into tabs (navigation does that)');
}
{
  const h = boot({ granted: false, storage: { enginesEnabled: true }, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(!h.registered.has('quell-engines'), 'startup with intent but no grant registers nothing');
}


// --- The origins actually queried matter --------------------------------
console.log('Background — asks Chrome about the ENGINE origins, not something broader:');
{
  // Only the engine origins are granted (no <all_urls>). A background that
  // queried <all_urls> — or any origin outside the granted set — would see
  // "not granted" here and register nothing.
  const h = boot({ granted: ENGINE_ORIGINS, storage: { enginesEnabled: true }, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.registered.has('quell-engines'),
    'with exactly the engine origins granted, the engine script registers');
  // (init() also checks <all_urls> for the cookie layer — that is its own path.)
  ok(h.of('permissions.contains').some((o) => JSON.stringify(o) === JSON.stringify(ENGINE_ORIGINS)),
    'the engine grant check asks about ENGINE_ORIGINS verbatim');
}
{
  // <all_urls> alone (the cookie feature's grant) semantically contains the
  // engine origins — Chrome answers true — and the intent flag is what keeps
  // the engines off. Then revoking <all_urls> must not clear an intent whose
  // own origins are still granted.
  const h = boot({ granted: ['<all_urls>', ...ENGINE_ORIGINS], storage: { enginesEnabled: true }, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.registered.has('quell-engines'), 'precondition: registered with both grants');
  h.reset();
  h.state.grant(ENGINE_ORIGINS); // cookies revoked <all_urls>; engine hosts remain
  await h.chrome.permissions.onRemoved.fire({ origins: ['<all_urls>'] });
  await settle();
  ok(!h.of('storage.local.set').some((o) => 'enginesEnabled' in o),
    'revoking <all_urls> while the engine hosts stay granted leaves the intent alone');
  ok(h.registered.has('quell-engines'), 'and the engine script stays registered');
}

// --- The cookie cosmetic layer: the shipped feature's own registration ----
// Round 4: applyCookieBlocking could stop registering cookies.js and every
// suite stayed green. It is the same shape as the engine path — intent
// (enabled && cookieEnabled) AND the <all_urls> grant — plus the dNR rulesets
// and the open-tab heal.
console.log('Background — cookie layer registration:');
{
  const WEB_TABS = [
    { id: 21, url: 'https://example.com/' },
    { id: undefined, url: 'https://example.org/' },
    { id: 23, url: 'http://news.test/a' },
  ];
  const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: false }, tabs: WEB_TABS });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(!h.registered.has('quell-cookies'), 'feature off at startup: cookies.js is not registered');
  ok(h.of('dnr.updateEnabledRulesets').some((o) => Array.isArray(o.disableRulesetIds) && o.disableRulesetIds.length === 2),
    'feature off at startup: both cookie rulesets disabled');

  // Switch ON from the popup.
  h.reset();
  h.local.cookieEnabled = true;
  await h.chrome.storage.onChanged.fire({ cookieEnabled: { newValue: true } }, 'local');
  await settle();
  const reg = h.registered.get('quell-cookies');
  ok(!!reg, 'feature on: cookies.js is registered');
  ok(!!reg && JSON.stringify(reg.matches) === JSON.stringify(['<all_urls>']) && reg.runAt === 'document_start' && reg.allFrames === false,
    'registered on <all_urls>, document_start, top frame only');
  ok(!!reg && reg.js?.[0] === 'src/content/cookies.js' && reg.css?.[0] === 'rules/cookie-generic.css',
    'the registration carries BOTH cookies.js and the generic stylesheet (layer 1)');
  ok(h.of('dnr.updateEnabledRulesets').some((o) => Array.isArray(o.enableRulesetIds) && o.enableRulesetIds.length === 2),
    'feature on: both cookie rulesets enabled');
  const css = h.of('scripting.insertCSS'), js = h.of('scripting.executeScript');
  ok(css.map((c) => c.target.tabId).join(',') === '21,23' && js.map((c) => c.target.tabId).join(',') === '21,23',
    `open web tabs get the stylesheet AND the script (css ${css.map((c) => c.target.tabId)}, js ${js.map((c) => c.target.tabId)}); id-less tab skipped`);
  ok(css.every((c) => c.files?.[0] === 'rules/cookie-generic.css') && js.every((c) => c.files?.[0] === 'src/content/cookies.js'),
    'open-tab heal uses the same files as the registration');

  // Master switch OFF must take the cookie layer down, feature flag untouched.
  h.reset();
  h.local.enabled = false;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'local');
  await settle();
  ok(!h.registered.has('quell-cookies'), 'master switch off unregisters cookies.js');
  ok(h.of('scripting.removeCSS').map((c) => c.target.tabId).join(',') === '21,23',
    'master switch off pulls the healed stylesheet back out of open tabs');
  ok(h.of('scripting.insertCSS').length === 0 && h.of('scripting.executeScript').length === 0,
    'and injects nothing');
  ok(h.of('dnr.updateEnabledRulesets').some((o) => o.disableRulesetIds),
    'and disables the rulesets');

  // Master switch back ON re-registers (feature flag was still true).
  h.reset();
  h.local.enabled = true;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: true } }, 'local');
  await settle();
  ok(h.registered.has('quell-cookies'), 'master switch back on re-registers cookies.js');

  // Allowlist changes touch the dNR allow rules only.
  h.reset();
  h.local.cookieAllowlist = ['example.com', 'news.test'];
  await h.chrome.storage.onChanged.fire({ cookieAllowlist: { newValue: h.local.cookieAllowlist } }, 'local');
  await settle();
  const dyn = h.of('dnr.updateDynamicRules');
  ok(dyn.length === 1 && dyn[0].addRules.length === 2
     && dyn[0].addRules.every((r) => r.action.type === 'allow' && r.priority === 2 && r.id >= 100000)
     && dyn[0].addRules.map((r) => r.condition.initiatorDomains[0]).join(',') === 'example.com,news.test',
    'allowlist → one allow rule per host, ids above the static range');
  ok(h.of('scripting.insertCSS').length === 0 && h.of('scripting.executeScript').length === 0,
    'an allowlist change does not re-inject into tabs');
}
{
  // Intent without the grant: nothing registers, nothing is injected.
  const h = boot({ granted: false, storage: { cookieEnabled: true }, tabs: [{ id: 1, url: 'https://a.test/' }] });
  await h.chrome.runtime.onStartup.fire();
  await h.chrome.storage.onChanged.fire({ cookieEnabled: { newValue: true } }, 'local');
  await settle();
  ok(!h.registered.has('quell-cookies'), 'cookie feature on without <all_urls>: not registered');
  ok(h.of('scripting.executeScript').length === 0 && h.of('scripting.insertCSS').length === 0,
    'cookie feature on without <all_urls>: nothing injected');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
