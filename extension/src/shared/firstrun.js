// Quell — the one-time first-run card (popup and welcome page) and the
// anonymous-usage-counts choice. Loaded after settings.js.
//
// The card explains Cookie banners and Pop-ups and asks once for all-sites
// access (the same optional permission the switches ask for), with Skip, and
// carries the analytics consent line. Nothing here sends anything: the answer
// is stored as QuellSettings 'analytics': 'on' | 'off' (default 'unset', and
// nothing is sent while unset). UI events go to the background as
// { type: 'quell:track', name } and are ignored when nobody is listening.
//
// Firefox shows its own data-collection prompt. Where the browser has that
// API, the checkbox asks for it when ticked and reads its state from
// permissions.contains; elsewhere (and on older Firefox) it uses the setting.

(() => {
  const g = globalThis;
  if (g.QuellFirstRun) return;
  const S = g.QuellSettings;
  const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime;
  const IS_FIREFOX = hasChrome && typeof chrome.runtime.getURL === 'function'
    && chrome.runtime.getURL('').startsWith('moz-extension:');
  const DATA = ['technicalAndInteraction'];
  const ALL_SITES = ['<all_urls>'];

  // Fire-and-forget. A background that is not listening (or asleep) is fine.
  function track(name) {
    try {
      const p = chrome.runtime.sendMessage({ type: 'quell:track', name });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* no runtime, or nobody listening */ }
  }

  let supported = null;
  async function dataApi() {
    if (supported !== null) return supported;
    supported = false;
    if (IS_FIREFOX && chrome.permissions) {
      try { await chrome.permissions.contains({ data_collection: DATA }); supported = true; } catch (_) { /* API not there */ }
    }
    return supported;
  }

  // Is the box ticked? Firefox with the API: the browser's own answer.
  // Otherwise the stored choice, where "not answered yet" shows ticked.
  async function analyticsOn(s) {
    if (await dataApi()) return chrome.permissions.contains({ data_collection: DATA }).catch(() => false);
    return s.analytics !== 'off';
  }

  // Must be the first await of a user gesture on Firefox (the prompt needs it).
  // Resolves to the state that is now true.
  async function setAnalytics(on) {
    if (await dataApi()) {
      if (on) {
        const ok = await chrome.permissions.request({ data_collection: DATA }).catch(() => false);
        await S.set({ analytics: ok ? 'on' : 'off' });
        return !!ok;
      }
      await chrome.permissions.remove({ data_collection: DATA }).catch(() => false);
      await S.set({ analytics: 'off' });
      return false;
    }
    await S.set({ analytics: on ? 'on' : 'off' });
    return on;
  }

  // Wire one card. `card` holds the [data-fr] hooks used by popup and welcome.
  //   grantInTab:  Firefox toolbar popup: prompts cannot work there, so the
  //                action opens the tab view instead (openTab)
  async function mount(card, { grantInTab = false, openTab = () => {}, onDone = () => {}, onChange = () => {} } = {}) {
    const q = (n) => card.querySelector(`[data-fr="${n}"]`);
    const ask = card.querySelector('[data-fr-ask]');
    const done = card.querySelector('[data-fr-done]');
    const note = q('note');
    const box = q('analytics');
    const sentBtn = q('sentBtn');

    const s = await S.get();
    const both = !!(s.cookieEnabled && s.popupsEnabled);
    // Already running both (an upgrade): only the analytics line is left to ask.
    ask.hidden = both;
    done.hidden = !both;
    card.querySelectorAll('[data-fr-ask-only]').forEach((el) => { el.hidden = both; });
    box.checked = await analyticsOn(s);

    sentBtn.addEventListener('click', () => {
      const body = document.getElementById(sentBtn.getAttribute('aria-controls'));
      const open = body.hidden;
      body.hidden = !open;
      sentBtn.setAttribute('aria-expanded', String(open));
      onChange();
    });

    box.addEventListener('change', async () => {
      const want = box.checked;
      if (grantInTab && await dataApi()) { box.checked = !want; openTab({ grant: 'analytics' }); return; }
      box.checked = await setAnalytics(want);
    });

    // The analytics answer that goes with a button press.
    const analyticsPatch = async () => {
      if (await dataApi()) return { analytics: (await analyticsOn(await S.get())) ? 'on' : 'off' };
      return { analytics: box.checked ? 'on' : 'off' };
    };
    const finish = async (patch) => {
      await S.set({ ...patch, ...(await analyticsPatch()), firstRunDone: true });
      onDone();
    };

    q('turn').addEventListener('click', async () => {
      if (grantInTab) { openTab({ grant: 'firstrun' }); return; }
      // The permission request is the click's first call: browsers need the gesture.
      const granted = hasChrome && chrome.permissions
        ? await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false) : false;
      if (!granted) {
        note.textContent = 'Not turned on: your browser didn’t allow it. You can try again or skip.';
        return;
      }
      track('firstrun_turn_on');
      await finish({ cookieEnabled: true, popupsEnabled: true });
    });
    q('skip').addEventListener('click', async () => { track('firstrun_skip'); await finish({}); });
    q('done').addEventListener('click', async () => { track('firstrun_skip'); await finish({}); });
    return { both };
  }

  g.QuellFirstRun = { mount, track, analyticsOn, setAnalytics, dataApi };
})();
