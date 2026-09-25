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
    // Copilot suggestion chips, as one switch (owner decision 2026-09-24).
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
  };

  const LOCAL_DEFAULTS = {
    enginesEnabled: false,  // intent for DuckDuckGo/Brave/Yahoo (grant-bound)
    cookieEnabled: false,   // grant-bound: <all_urls>
    popupsEnabled: false,   // grant-bound: <all_urls>; OFF by default
    totalBlocked: 0,
  };

  // Keys that existed in 0.5.x and are gone. hideBingChips was the separate
  // chip switch; the chips now follow the Bing switch.
  const OBSOLETE_KEYS = ['hideBingChips'];

  // storage.sync allows 8,192 bytes per item. A paused-site list is the only
  // value that can grow toward it; refuse to write past this budget rather
  // than let the browser reject the whole write.
  const LIST_BYTE_BUDGET = 7000;
  const LIST_KEYS = ['aiAllowlist', 'cookieAllowlist', 'popupAllowlist'];

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

  g.QuellSettings = {
    SYNC_DEFAULTS, LOCAL_DEFAULTS, DEFAULTS, OBSOLETE_KEYS, LIST_BYTE_BUDGET,
    home, get, set, migrate, onChange, ListFullError,
  };
})();
