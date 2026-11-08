// Quell — ask the browser for a permission, and save what the click was for
// even when the page that asked does not live to hear the answer.
//
// Why: on Chrome the toolbar popup closes as soon as the permission prompt
// opens. The popup's `await chrome.permissions.request(...)` then never
// returns, so the switch it was meant to save never got saved: the user
// clicked Allow, opened Quell again, and was asked the same thing again.
//
// So the answer is written down BEFORE the prompt opens (as a pending grant:
// the permission asked for, and the settings to save once it is held), and
// whoever is alive when the browser grants it saves those settings: the page
// itself if it survived, else the background on permissions.onAdded, else
// the next popup or welcome page to open (settle()). Loaded after settings.js.

(() => {
  const g = globalThis;
  if (g.QuellGrant) return;
  const KEY = 'quellPendingGrant';
  // A prompt left open longer than this is not an answer to wait on.
  const MAX_AGE_MS = 10 * 60 * 1000;
  const local = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  // Never lets a failed clean-up turn a granted switch into a refused one.
  const drop = async (area) => { try { await area.remove(KEY); } catch (_) { /* ages out */ } };

  // Must be called straight from the click, before any other await: the
  // browser needs the gesture. The storage write is started, not awaited, so
  // request() is still the click's first await. Resolves true once granted
  // and the settings are saved; false if the user said no.
  async function ask(request, patch = {}) {
    const area = local();
    let mark = Promise.resolve();
    try { if (area) mark = Promise.resolve(area.set({ [KEY]: { request, patch, at: Date.now() } })).catch(() => {}); } catch (_) { /* no record: the live path still saves */ }
    const granted = !!(await chrome.permissions.request(request).catch(() => false));
    await mark;
    if (granted) await g.QuellSettings.set(patch);
    if (area) await drop(area);
    return granted;
  }

  // Save a pending grant the browser has since granted. Safe to call any time,
  // from any context, as often as wanted; saving the same patch twice is the same.
  async function settle() {
    const area = local();
    if (!area || typeof chrome === 'undefined' || !chrome.permissions) return false;
    const got = await area.get(KEY).catch(() => ({}));
    const p = got && got[KEY];
    if (!p) return false;
    if (!p.request || !(Date.now() - Number(p.at) < MAX_AGE_MS)) {
      await drop(area);
      return false;
    }
    const held = await chrome.permissions.contains(p.request).catch(() => false);
    if (!held) return false; // still deciding, or said no: it ages out
    await g.QuellSettings.set(p.patch || {});
    await drop(area);
    return true;
  }

  g.QuellGrant = { ask, settle, KEY, MAX_AGE_MS };
})();
