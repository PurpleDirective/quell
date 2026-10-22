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
// Loaded first, the way Firefox's background.scripts and Chrome's importScripts do.
const SETTINGS = readFileSync(path.join(EXT, 'src/shared/settings.js'), 'utf8');

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
function makeChrome({ granted = false, storage = {}, tabs = [], sync = null } = {}) {
  const calls = [];
  const rec = (name, arg) => { calls.push([name, arg]); };
  const local = { ...storage };
  // A storage area shaped like chrome.storage.{local,sync}: get() with an
  // object (defaults), an array or a string; set(); remove().
  const area = (name, data) => ({
    get: async (d) => {
      const out = {};
      if (Array.isArray(d)) for (const k of d) { if (k in data) out[k] = data[k]; }
      else if (typeof d === 'string') { if (d in data) out[d] = data[d]; }
      else for (const [k, v] of Object.entries(d || {})) out[k] = k in data ? data[k] : v;
      return out;
    },
    set: async (o) => { Object.assign(data, o); rec(`storage.${name}.set`, { ...o }); },
    remove: async (ks) => { for (const k of [].concat(ks)) delete data[k]; rec(`storage.${name}.remove`, [].concat(ks)); },
  });
  const syncData = sync ? { ...sync } : null;
  const registered = new Map();
  const toSet = (g) => new Set(g === true ? ENGINE_ORIGINS : g === false ? [] : g);
  const state = { granted: toSet(granted), tabs, session: {}, grant: (g) => { state.granted = toSet(g); } };

  const chrome = {
    storage: {
      local: area('local', local),
      ...(syncData ? { sync: area('sync', syncData) } : {}),
      // Only the popup's release marker is stored for real; the per-tab
      // badge counts keep the old stateless behaviour (every read = default).
      session: {
        get: async (d) => {
          const out = { ...d };
          for (const k of Object.keys(d || {})) if (k in state.session) out[k] = state.session[k];
          return out;
        },
        set: async (o) => {
          for (const [k, v] of Object.entries(o)) if (k === 'quellReleasingAllSites') state.session[k] = v;
        },
        remove: async (ks) => { for (const k of [].concat(ks)) delete state.session[k]; rec('storage.session.remove', [].concat(ks)); },
      },
      onChanged: event(),
    },
    permissions: {
      contains: async ({ origins }) => {
        rec('permissions.contains', origins);
        if (!Array.isArray(origins) || origins.length === 0) return false;
        return origins.every((o) => state.granted.has(o) || state.granted.has('<all_urls>'));
      },
      // Chrome's remove(): the origins asked for are intersected SEMANTICALLY
      // with what is granted (kPatternsContainedByBoth), so removing
      // <all_urls> takes every granted host with it — engine hosts included.
      remove: async ({ origins }) => {
        rec('permissions.remove', origins);
        const all = (origins || []).includes('<all_urls>');
        for (const o of [...state.granted]) if (all || origins.includes(o)) state.granted.delete(o);
        return true;
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
      create: async (o) => { rec('tabs.create', o); return { id: 99 }; },
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
  return { chrome, calls, registered, local, sync: syncData, state };
}

// Load background.js fresh for each case: module-level state (the badge
// queue, the rules promise) must not leak between scenarios.
function boot(opts) {
  const h = makeChrome(opts);
  const sandbox = {
    chrome: h.chrome,
    fetch: async (u) => ({ json: async () => (opts?.fetchJson ? opts.fetchJson(u) : {}) }),
    URL, setTimeout, clearTimeout, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SETTINGS, sandbox, { filename: 'settings.js' });
  vm.runInContext(BG, sandbox, { filename: 'background.js' });
  h.ENGINE_ORIGINS = ENGINE_ORIGINS;
  h.ENGINE_MATCHES = ENGINE_MATCHES;
  h.sandbox = sandbox;
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
  ok(Array.isArray(s.js) && s.js.join(',') === 'src/shared/settings.js,src/content/common.js,src/content/engines.js',
    'registered script is settings.js, common.js THEN engines.js (order matters — each needs the one before)');
  ok(s.runAt === 'document_start' && s.allFrames === false,
    'runs at document_start, top frame only');

  const q = h.of('tabs.query');
  ok(q.length === 1 && JSON.stringify(q[0].url) === JSON.stringify(h.ENGINE_MATCHES),
    'open tabs are queried by ENGINE_MATCHES');
  const ex = h.of('scripting.executeScript');
  ok(ex.length === 2 && ex.map((e) => e.target.tabId).join(',') === '11,13',
    `already-open engine tabs are injected (tabIds ${ex.map((e) => e.target.tabId).join(',')}); the id-less tab is skipped`);
  ok(ex.every((e) => (e.files || []).join(',') === 'src/shared/settings.js,src/content/common.js,src/content/engines.js'),
    'open-tab injection carries settings.js + common.js + engines.js too');

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

// --- Giving all-sites access back (owner decision 2026-09-25) --------------
// Cookie banners and Pop-ups are the only users of <all_urls>. With both off,
// the access goes back to the browser; revoking it anywhere switches both off.
console.log('Background — all-sites access is given back when unused:');
{
  // Startup with both off: released.
  const h = boot({ granted: ['<all_urls>'], storage: {}, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.of('permissions.remove').some((o) => JSON.stringify(o) === '["<all_urls>"]'),
    'startup with Cookie banners and Pop-ups both off removes <all_urls>');
  ok(!h.state.granted.has('<all_urls>'), 'and the access is gone afterwards');
}
for (const [label, storage] of [
  ['Cookie banners on', { cookieEnabled: true }],
  ['Pop-ups on', { popupsEnabled: true }],
  ['the other engines on (their hosts would go with it)', { enginesEnabled: true }],
]) {
  const h = boot({ granted: ['<all_urls>'], storage, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.of('permissions.remove').length === 0 && h.state.granted.has('<all_urls>'),
    `startup with ${label} keeps <all_urls>`);
}
{
  // Nothing held: nothing to remove.
  const h = boot({ granted: false, storage: {}, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.of('permissions.remove').length === 0, 'startup without the access does not call remove()');
}
{
  // The user revokes all-sites access in chrome://extensions while both
  // features are on: both switch off, their scripts come down, the cookie
  // network rules go with them.
  const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true, popupsEnabled: true }, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.registered.has('quell-cookies') && h.registered.has('quell-popups'),
    'precondition: both layers registered with the grant');
  h.reset();
  h.state.grant([]);
  await h.chrome.permissions.onRemoved.fire({ origins: ['<all_urls>'] });
  await settle();
  const sets = h.of('storage.local.set');
  ok(sets.some((o) => o.cookieEnabled === false) && sets.some((o) => o.popupsEnabled === false),
    'revoking <all_urls> switches Cookie banners AND Pop-ups off (no switch left reading "on")');
  ok(!h.registered.has('quell-cookies') && !h.registered.has('quell-popups'),
    'and unregisters both scripts');
  ok(h.of('dnr.updateEnabledRulesets').some((o) => o.disableRulesetIds),
    'and disables the cookie network rules');
}
{
  // A removal event that leaves <all_urls> in place touches neither switch.
  const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true }, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  h.reset();
  await h.chrome.permissions.onRemoved.fire({ origins: ENGINE_ORIGINS });
  await settle();
  ok(!h.of('storage.local.set').some((o) => 'cookieEnabled' in o || 'popupsEnabled' in o),
    'a removal that leaves <all_urls> granted leaves Cookie banners and Pop-ups alone');
  ok(h.registered.has('quell-cookies'), 'and the cookie script stays registered');
}
{
  // The popup's OWN release, engines on: Chrome takes the engine hosts with
  // <all_urls>, the popup asks for them straight back. The marker keeps the
  // background from reading that as the user revoking the engines.
  const h = boot({ granted: ['<all_urls>', ...ENGINE_ORIGINS], storage: { enginesEnabled: true }, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  h.reset();
  h.state.session.quellReleasingAllSites = Date.now();
  await h.chrome.permissions.remove({ origins: ['<all_urls>'] });
  ok(h.state.granted.size === 0, 'fake models Chrome: remove(<all_urls>) takes the engine hosts too');
  await h.chrome.permissions.onRemoved.fire({ origins: ['<all_urls>', ...ENGINE_ORIGINS] });
  await settle();
  ok(!h.of('storage.local.set').some((o) => 'enginesEnabled' in o),
    'the popup\'s own release does NOT clear the engines intent');
  ok(!('quellReleasingAllSites' in h.state.session), 'the release marker is consumed (one-shot)');
  // The popup's re-request lands: onAdded re-registers from the kept intent.
  h.state.grant(ENGINE_ORIGINS);
  await h.chrome.permissions.onAdded.fire({ origins: ENGINE_ORIGINS });
  await settle();
  ok(h.registered.has('quell-engines'), 'and the engine script is registered again once the hosts come back');
}
{
  // A stale marker (older than the window) is not a licence: a revoke is a revoke.
  const h = boot({ granted: ['<all_urls>', ...ENGINE_ORIGINS], storage: { enginesEnabled: true }, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  h.reset();
  h.state.session.quellReleasingAllSites = Date.now() - 60000;
  h.state.grant([]);
  await h.chrome.permissions.onRemoved.fire({ origins: ['<all_urls>', ...ENGINE_ORIGINS] });
  await settle();
  ok(h.of('storage.local.set').some((o) => o.enginesEnabled === false),
    'a stale release marker is ignored — revoking still clears the engines intent');
}

// --- "Say reject all for me" lets through the platforms it presses ---------
// Live 2026-09-25: with reject on, the static network rules blocked
// cdn.cookielaw.org, so OneTrust never loaded and no choice was recorded.
console.log('Background — reject-all lets its own consent platforms load:');
{
  const REJ = (h) => h.of('dnr.updateDynamicRules').filter((o) => (o.removeRuleIds || []).includes(90000));
  const rule = (o) => (o.addRules || []).find((r) => r.id === 90000);
  const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true }, sync: { cookieReject: true }, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  const r = rule(REJ(h).at(-1) || {});
  ok(!!r && r.action.type === 'allow' && r.priority > 1,
    'startup with Cookie banners + reject on: one allow rule above the static blocks (priority > 1)');
  const doms = r?.condition?.requestDomains || [];
  // Every static block on a platform cookies.js can press must be covered.
  const STATIC = [...JSON.parse(readFileSync(path.join(EXT, 'rules/cookie-cmp.json'), 'utf8')),
    ...JSON.parse(readFileSync(path.join(EXT, 'rules/cookie-cmp-easylist.json'), 'utf8'))]
    .map((x) => (x.condition.urlFilter || '').replace(/^\|\|/, '').replace(/\^.*$/, ''))
    .filter((d) => /onetrust|cookielaw|cookiebot|didomi|privacy-center|osano/.test(d) && !/inkarnate/.test(d));
  const covered = (d) => doms.some((a) => d === a || d.endsWith('.' + a));
  const missing = STATIC.filter((d) => !covered(d));
  ok(STATIC.length >= 6 && missing.length === 0,
    `every static block on OneTrust/Cookiebot/Didomi/Osano is covered (${STATIC.length} blocks, missing: ${missing.join(',') || 'none'})`);
  ok(!doms.some((d) => /consensu|trustarc|usercentrics|quantcast/.test(d)),
    'platforms Quell cannot press reject on stay blocked');

  h.reset();
  h.sync.cookieReject = false;
  await h.chrome.storage.onChanged.fire({ cookieReject: { newValue: false } }, 'sync');
  await settle();
  const off = REJ(h).at(-1);
  ok(!!off && !rule(off), 'reject switched off: the allow rule is removed (static blocks apply again)');

  h.reset();
  h.sync.cookieReject = true;
  await h.chrome.storage.onChanged.fire({ cookieReject: { newValue: true } }, 'sync');
  await settle();
  ok(!!rule(REJ(h).at(-1) || {}), 'reject switched back on (synced from the popup): the allow rule returns');

  h.reset();
  h.local.cookieEnabled = false;
  await h.chrome.storage.onChanged.fire({ cookieEnabled: { newValue: false } }, 'local');
  await settle();
  ok(!rule(REJ(h).at(-1) || {}), 'Cookie banners off: no allow rule, even with reject still ticked');

  h.reset();
  h.local.cookieEnabled = true;
  h.sync.enabled = false;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'sync');
  await settle();
  ok(!rule(REJ(h).at(-1) || {}), 'Quell paused: no allow rule');
}
{
  const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true }, sync: {}, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  const calls = h.of('dnr.updateDynamicRules').filter((o) => (o.addRules || []).some((r) => r.id === 90000));
  ok(calls.length === 0, 'reject off (the default): the consent platforms stay blocked');
}
for (const [label, storage, sync] of [
  ['Cookie banners off', { cookieEnabled: false }, { cookieReject: true }],
  ['Quell paused', { cookieEnabled: true }, { cookieReject: true, enabled: false }],
]) {
  const h = boot({ granted: ['<all_urls>'], storage, sync, tabs: [] });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  const calls = h.of('dnr.updateDynamicRules').filter((o) => (o.addRules || []).some((r) => r.id === 90000));
  ok(calls.length === 0, `startup with reject ticked but ${label}: no allow rule`);
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
  ok(!h.state.granted.has('<all_urls>'),
    'feature off at startup: the unused all-sites access is given back');

  // Switch ON from the popup — which asks for the access again first.
  h.state.grant(['<all_urls>']);
  h.reset();
  h.local.cookieEnabled = true;
  await h.chrome.storage.onChanged.fire({ cookieEnabled: { newValue: true } }, 'local');
  await settle();
  const reg = h.registered.get('quell-cookies');
  ok(!!reg, 'feature on: cookies.js is registered');
  ok(!!reg && JSON.stringify(reg.matches) === JSON.stringify(['<all_urls>']) && reg.runAt === 'document_start' && reg.allFrames === false,
    'registered on <all_urls>, document_start, top frame only');
  ok(!!reg && (reg.js || []).join(',') === 'src/shared/settings.js,src/content/cookies.js' && reg.css?.[0] === 'rules/cookie-generic.css',
    'the registration carries settings.js + cookies.js and the generic stylesheet (layer 1)');
  ok(h.of('dnr.updateEnabledRulesets').some((o) => Array.isArray(o.enableRulesetIds) && o.enableRulesetIds.length === 2),
    'feature on: both cookie rulesets enabled');
  const css = h.of('scripting.insertCSS'), js = h.of('scripting.executeScript');
  ok(css.map((c) => c.target.tabId).join(',') === '21,23' && js.map((c) => c.target.tabId).join(',') === '21,23',
    `open web tabs get the stylesheet AND the script (css ${css.map((c) => c.target.tabId)}, js ${js.map((c) => c.target.tabId)}); id-less tab skipped`);
  ok(css.every((c) => c.files?.[0] === 'rules/cookie-generic.css') && js.every((c) => (c.files || []).join(',') === 'src/shared/settings.js,src/content/cookies.js'),
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

// --- 0.6.0: settings move to storage.sync, without losing anything ---------
console.log('Background — 0.5.x → 0.6.0 settings migration (storage.local → storage.sync):');
{
  const legacy = {
    enabled: false, googleMode: 'cleanweb', hidePaa: true, ddgMode: 'clean',
    cookieAllowlist: ['a.test'], cookieReject: true, hideBingChips: true,
    cookieEnabled: true, enginesEnabled: false, totalBlocked: 7,
  };
  const h = boot({ granted: false, storage: legacy, sync: {}, tabs: [] });
  // Before migration runs, readers already see the user's values (local wins
  // over defaults, sync is empty).
  const before = await vm.runInContext('QuellSettings.get()', h.sandbox);
  ok(before.enabled === false && before.googleMode === 'cleanweb' && before.hidePaa === true,
    'before migration a reader sees the 0.5.x values, not defaults');

  await h.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '0.5.0' });
  await settle();
  ok(h.sync.enabled === false && h.sync.googleMode === 'cleanweb' && h.sync.hidePaa === true
     && h.sync.ddgMode === 'clean' && h.sync.cookieReject === true
     && JSON.stringify(h.sync.cookieAllowlist) === '["a.test"]',
    'every user choice is copied to storage.sync');
  ok(!('enabled' in h.local) && !('googleMode' in h.local) && !('cookieAllowlist' in h.local),
    'and removed from storage.local afterwards (one source of truth)');
  ok(h.local.cookieEnabled === true && h.local.totalBlocked === 7 && 'enginesEnabled' in h.local,
    'grant-bound switches and the counter STAY in storage.local');
  ok(!('cookieEnabled' in h.sync) && !('totalBlocked' in h.sync),
    'grant-bound switches and the counter are never synced');
  ok(!('hideBingChips' in h.local) && !('hideBingChips' in h.sync),
    'the retired hideBingChips key is dropped');
  const after = await vm.runInContext('QuellSettings.get()', h.sandbox);
  ok(after.enabled === false && after.googleMode === 'cleanweb' && after.cookieEnabled === true && after.totalBlocked === 7,
    'after migration a reader sees exactly the same settings');
  ok(h.of('tabs.create').length === 0, 'an UPDATE does not open the welcome page');

  // Idempotent: a second run moves nothing and removes nothing.
  h.reset();
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(h.of('storage.sync.set').length === 0 && h.of('storage.local.remove').length === 0,
    'migration is a no-op the second time');
}
{
  // Another device already synced its choice: that one wins, and the stale
  // local copy is still cleared.
  const h = boot({ storage: { googleMode: 'cleanweb', hideGemini: false }, sync: { googleMode: 'off' }, tabs: [] });
  await h.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  ok(h.sync.googleMode === 'off', 'a value already in sync (another device) is NOT overwritten');
  ok(h.sync.hideGemini === false, 'keys sync lacked are still copied');
  ok(!('googleMode' in h.local), 'the shadowed local copy is removed');
}
{
  // Sync refuses the write (quota, policy): nothing is removed from local, so
  // nothing is lost — readers keep seeing the local values.
  const h = boot({ storage: { googleMode: 'cleanweb' }, sync: {}, tabs: [] });
  h.chrome.storage.sync.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  await h.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await settle();
  ok(h.local.googleMode === 'cleanweb', 'a failed sync write leaves the local settings in place');
  const r = await vm.runInContext('QuellSettings.get()', h.sandbox);
  ok(r.googleMode === 'cleanweb', 'and readers still see them');
}

console.log('Background — an update puts this version into the tabs already open:');
{
  // The previous version's content scripts stand down when the extension is
  // replaced (onGone in settings.js), so an update must put the new ones in
  // their place wherever Quell has site access — or every open tab would show
  // its banners and pop-ups again until it was reloaded.
  const WEB_TABS = [{ id: 31, url: 'https://example.com/' }, { id: 32, url: 'https://duckduckgo.com/?q=a' }];
  const on = { enginesEnabled: true, cookieEnabled: true, popupsEnabled: true };
  const files = (h) => h.of('scripting.executeScript').map((c) => `${c.target.tabId}:${(c.files || []).at(-1)}`).sort().join(' ');
  const all = '31:src/content/cookies.js 31:src/content/engines.js 31:src/content/popups.js '
    + '32:src/content/cookies.js 32:src/content/engines.js 32:src/content/popups.js';
  {
    const h = boot({ granted: ['<all_urls>'], storage: on, sync: {}, tabs: WEB_TABS });
    await h.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '0.7.0' });
    await settle();
    ok(files(h) === all, `update: engines, cookies and pop-ups scripts go into the open tabs (${files(h)})`);
    ok(h.of('scripting.insertCSS').map((c) => c.target.tabId).join(',') === '31,32', '...with the generic cookie stylesheet');
  }
  {
    const h = boot({ granted: ['<all_urls>'], storage: on, sync: { enabled: false }, tabs: WEB_TABS });
    await h.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '0.7.0' });
    await settle();
    ok(h.of('scripting.executeScript').length === 0 && h.of('scripting.insertCSS').length === 0,
      'update with Quell switched off: nothing is put into any tab');
  }
  {
    const h = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true }, sync: {}, tabs: WEB_TABS });
    await h.chrome.runtime.onInstalled.fire({ reason: 'update', previousVersion: '0.7.0' });
    await settle();
    ok(files(h) === '31:src/content/cookies.js 32:src/content/cookies.js', `update: only the features that are on (${files(h)})`);
  }
  for (const fire of [(h) => h.chrome.runtime.onStartup.fire(), (h) => h.chrome.runtime.onInstalled.fire({ reason: 'chrome_update' })]) {
    const h = boot({ granted: ['<all_urls>'], storage: on, sync: {}, tabs: WEB_TABS });
    await fire(h);
    await settle();
    ok(h.of('scripting.executeScript').length === 0, 'a browser start or browser update injects nothing: the tabs load the registered scripts themselves');
  }
}

console.log('Background — switching Quell back on reaches the search tabs already open:');
{
  // An update that lands while Quell is off puts nothing into any tab, and the
  // old copies have stood down. Switching back on has to put engines.js into
  // the open DuckDuckGo, Brave and Yahoo tabs, as it does cookies and pop-ups.
  const TABS = [{ id: 51, url: 'https://duckduckgo.com/?q=a' }];
  const engines = (h) => h.of('scripting.executeScript').filter((c) => (c.files || []).at(-1) === 'src/content/engines.js').map((c) => c.target.tabId).join(',');
  const h = boot({ granted: ['<all_urls>'], storage: { enginesEnabled: true }, sync: { enabled: false }, tabs: TABS });
  h.sync.enabled = true;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: true } }, 'sync');
  await settle();
  ok(engines(h) === '51', `Quell back on: engines.js goes into the open search tab (${engines(h)})`);
  const off = boot({ granted: ['<all_urls>'], storage: { enginesEnabled: true }, sync: {}, tabs: TABS });
  off.sync.enabled = false;
  await off.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'sync');
  await settle();
  ok(engines(off) === '', 'Quell off: nothing is put into any tab');
  const none = boot({ granted: ['<all_urls>'], storage: { enginesEnabled: false }, sync: { enabled: false }, tabs: TABS });
  none.sync.enabled = true;
  await none.chrome.storage.onChanged.fire({ enabled: { newValue: true } }, 'sync');
  await settle();
  ok(engines(none) === '', 'Quell back on with DuckDuckGo, Brave and Yahoo not switched on: nothing goes in');
}

console.log('Background — the badge follows the master switch:');
{
  const h = boot({ granted: false, storage: {}, sync: {}, tabs: [{ id: 41 }, { id: 42 }, { id: undefined }] });
  const set = [];
  h.chrome.action.setBadgeText = (o) => { set.push(`${o.tabId}=${o.text}`); };
  h.chrome.storage.session.get = async () => ({ 'tab:41': 3, quellReleasingAllSites: 0 });
  h.sync.enabled = false;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'sync');
  await settle();
  ok(set.join(' ') === '41= 42=', `Quell off: the badge is cleared on every open tab (${set.join(' ')})`);
  set.length = 0;
  h.sync.enabled = true;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: true } }, 'sync');
  await settle();
  ok(set.join(' ') === '41=3 42=', `Quell back on: each tab gets its own count back (${set.join(' ')})`);
  set.length = 0;
  await h.chrome.storage.onChanged.fire({ googleMode: { newValue: 'off' } }, 'sync');
  await settle();
  ok(set.length === 0, 'any other setting leaves the badges alone');
}

console.log('Background — welcome page opens once, on install only:');
{
  const h = boot({ sync: {}, tabs: [] });
  await h.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  const c = h.of('tabs.create');
  ok(c.length === 1 && c[0].url === 'chrome-extension://test/src/welcome/welcome.html',
    `a fresh install opens the welcome page once (${JSON.stringify(c)})`);
  h.reset();
  await h.chrome.runtime.onStartup.fire();
  await h.chrome.runtime.onInstalled.fire({ reason: 'chrome_update' });
  await settle();
  ok(h.of('tabs.create').length === 0, 'browser start and browser update do not open it again');
}

console.log('Background — storage areas: a per-device switch counts only in local:');
{
  const h = boot({ granted: true, storage: { enginesEnabled: false }, sync: { enginesEnabled: true }, tabs: ENGINE_TABS });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(!h.registered.has('quell-engines'), 'a stray enginesEnabled in storage.sync does not switch engines on');
  const h2 = boot({ granted: ['<all_urls>'], storage: { cookieEnabled: true }, sync: {}, tabs: [] });
  await h2.chrome.runtime.onStartup.fire();
  await settle();
  ok(h2.registered.has('quell-cookies'), 'precondition: cookie layer registered');
  h2.sync.enabled = false;
  await h2.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'sync');
  await settle();
  ok(!h2.registered.has('quell-cookies'), 'the master switch changing in storage.sync (the popup, or another device) takes the cookie layer down');
}

console.log('Background — pop-ups layer (0.6.0, off by default):');
{
  const WEB_TABS = [{ id: 31, url: 'https://news.test/' }, { id: 32, url: 'http://blog.test/a' }];
  const h = boot({ granted: ['<all_urls>'], storage: {}, sync: {}, tabs: WEB_TABS });
  await h.chrome.runtime.onStartup.fire();
  await settle();
  ok(!h.registered.has('quell-popups'), 'off by default: popups.js is not registered even with <all_urls>');

  h.state.grant(['<all_urls>']); // startup gave it back; the popup's switch asks again
  h.reset();
  h.local.popupsEnabled = true;
  await h.chrome.storage.onChanged.fire({ popupsEnabled: { newValue: true } }, 'local');
  await settle();
  const reg = h.registered.get('quell-popups');
  ok(!!reg && (reg.js || []).join(',') === 'src/shared/settings.js,src/content/popups.js'
     && JSON.stringify(reg.matches) === '["<all_urls>"]' && reg.allFrames === false && !reg.css,
    'switched on: settings.js + popups.js registered on <all_urls>, top frame, no native stylesheet');
  ok(h.of('scripting.executeScript').map((e) => e.target.tabId).join(',') === '31,32',
    'switched on: open tabs are healed');
  ok(h.of('dnr.updateEnabledRulesets').length === 0 && h.of('dnr.updateDynamicRules').length === 0,
    'the pop-ups layer never touches network rules (cosmetic only)');

  h.reset();
  h.sync.enabled = false;
  await h.chrome.storage.onChanged.fire({ enabled: { newValue: false } }, 'sync');
  await settle();
  ok(!h.registered.has('quell-popups'), 'master switch off unregisters popups.js');
}
{
  const h = boot({ granted: false, storage: { popupsEnabled: true }, sync: {}, tabs: [{ id: 1, url: 'https://a.test/' }] });
  await h.chrome.runtime.onStartup.fire();
  await h.chrome.storage.onChanged.fire({ popupsEnabled: { newValue: true } }, 'local');
  await settle();
  ok(!h.registered.has('quell-popups') && h.of('scripting.executeScript').length === 0,
    'pop-ups on without <all_urls>: nothing registered, nothing injected');
}
{
  const RULES = {
    newsletter: { generic: ['.nl-modal'], domains: { 'news.test': ['#nl-box'], 'other.test': ['#x'] } },
    chat: { generic: ['.chat-bubble'], domains: {} },
    app: { generic: ['.smartbanner'], domains: { 'test': ['#tld-wide'] } },
  };
  const h = boot({ sync: {}, tabs: [], fetchJson: (u) => (String(u).endsWith('rules/popups.json') ? RULES : {}) });
  const ask = (cats, url) => new Promise((res) => {
    const ret = h.chrome.runtime.onMessage.fire({ type: 'popupRules', cats }, { url }, res);
    void ret;
  });
  const r = await ask(['newsletter', 'app'], 'https://www.news.test/page');
  ok(JSON.stringify(r.generic) === '[".nl-modal",".smartbanner"]',
    `only the categories switched on are served (${JSON.stringify(r.generic)})`);
  ok(JSON.stringify(r.site) === '["#nl-box"]',
    `the host slice matches www.news.test → news.test, never another host's rules, never a bare TLD (${JSON.stringify(r.site)})`);
  const r2 = await ask(['bogus'], 'https://news.test/');
  ok(r2.generic.length === 0 && r2.site.length === 0, 'an unknown category name serves nothing');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
