// Quell — ask the browser for a permission, and save what the click was for
// even when the page that asked does not live to hear the answer.
//
// Why: on Chrome the toolbar popup closes as soon as the permission prompt
// opens. The popup's `await chrome.permissions.request(...)` then never
// returns, so the switch it was meant to save never got saved: the user
// clicked Allow, opened Quell again, and was asked the same thing again.
//
// So the answer is written down BEFORE the prompt opens (a pending grant: the
// permission asked for, the settings to save once it is held, and the usage
// event the click stands for). Any page that sees the grant saves the
// settings (saving the same patch twice is the same). Only the background
// CLOSES the record: it saves, counts the event once and removes the record,
// one record at a time (permissions.onAdded, startup, or a page telling it
// the grant came back). A page never counts a click that went through ask(),
// so the click is counted once whether or not the page survived the prompt.
// Loaded after settings.js.

(() => {
  const g = globalThis;
  if (g.QuellGrant) return;
  const KEY = 'quellPendingGrant';
  // A prompt left open longer than this is not an answer to wait on.
  const MAX_AGE_MS = 10 * 60 * 1000;
  const local = () => (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) || null;
  // Never lets a failed clean-up turn a granted switch into a refused one.
  const drop = async (area) => { try { await area.remove(KEY); } catch (_) { /* ages out */ } };
  const tellBackground = () => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'quell:grantSettle' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* nobody listening: onAdded or the next start closes it */ }
  };

  // Must be called straight from the click, before any other await: the
  // browser needs the gesture. The storage write is started, not awaited, so
  // request() is still the click's first await. Resolves true once granted
  // and the settings are saved; false if the user said no. `track` names the
  // usage event the background counts when it closes the record.
  async function ask(request, patch = {}, { track = '' } = {}) {
    const area = local();
    let mark = Promise.resolve();
    try { if (area) mark = Promise.resolve(area.set({ [KEY]: { request, patch, track, at: Date.now() } })).catch(() => {}); } catch (_) { /* no record: the live path still saves */ }
    const granted = !!(await chrome.permissions.request(request).catch(() => false));
    await mark;
    if (!granted) {
      if (area) await drop(area);
      return false;
    }
    await g.QuellSettings.set(patch);
    tellBackground();
    return true;
  }

  // Save a pending grant the browser has since granted. Pages call it bare
  // (save only, then tell the background); the background calls it with
  // { close: true } (save, remove, and hand back the record so it can count
  // the event). Resolves to the record when the grant is held, else false.
  async function settle({ close = false } = {}) {
    const area = local();
    if (!area || typeof chrome === 'undefined' || !chrome.permissions) return false;
    const got = await area.get(KEY).catch(() => ({}));
    const p = got && got[KEY];
    if (!p) return false;
    if (!p.request || !(Date.now() - Number(p.at) < MAX_AGE_MS)) {
      if (close) await drop(area);
      return false;
    }
    const held = await chrome.permissions.contains(p.request).catch(() => false);
    if (!held) return false; // still deciding, or said no: it ages out
    await g.QuellSettings.set(p.patch || {});
    if (close) await drop(area);
    else tellBackground();
    return p;
  }

  g.QuellGrant = { ask, settle, KEY, MAX_AGE_MS };
})();
