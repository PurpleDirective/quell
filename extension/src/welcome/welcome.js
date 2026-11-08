// Quell — first-run page. Opened once by the background on a fresh install.
// Its only behaviour: point the privacy link at the configured URL, say where
// settings live (Opera does not sync them), and offer
// the Google/Bing grant when a browser (Firefox, notably Android) installed
// Quell without it. A tab is a place where Firefox's permission prompt works.

(async () => {
  const CFG = globalThis.QUELL_CONFIG || {};
  if (CFG.PRIVACY_URL) document.getElementById('privacy').href = CFG.PRIVACY_URL;
  if (CFG.SPONSOR_URL) document.getElementById('sponsor').href = CFG.SPONSOR_URL;
  if (CFG.DONATE_URL) document.getElementById('donate').href = CFG.DONATE_URL;
  // Opera keeps extension settings on this device only; its sync skips them.
  if (globalThis.QuellBrowser && globalThis.QuellBrowser.opera) {
    document.getElementById('syncNote').textContent = 'Your settings are saved in this browser.';
  }
  document.getElementById('nvb').addEventListener('click', (e) => {
    const body = document.getElementById('neverBody');
    const open = body.hidden;
    body.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  // The one-time card: ask once for all-sites access, and the usage-counts line.
  const S = globalThis.QuellSettings;
  await globalThis.QuellGrant?.settle().catch(() => {});
  const card = document.getElementById('firstRun');
  const chips = async () => {
    const s = await S.get();
    for (const [id, on] of [['chipCookies', s.cookieEnabled], ['chipPopups', s.popupsEnabled], ['chipLinks', s.linksEnabled]]) {
      const el = document.getElementById(id);
      el.textContent = on ? 'On' : 'Off';
      el.classList.toggle('on', !!on);
    }
    return s;
  };
  const s0 = await chips().catch(() => null);
  if (s0 && !s0.firstRunDone && globalThis.QuellFirstRun) {
    globalThis.QuellFirstRun.mount(card, {
      onDone: async () => {
        await chips();
        card.querySelectorAll('[data-fr-ask], [data-fr-done]').forEach((el) => { el.hidden = true; });
        card.querySelector('[data-fr="note"]').textContent = 'Saved. You can change any of this from the toolbar icon.';
      },
    }).catch(() => {});
  } else if (s0) {
    card.hidden = true;
  }
  S.onChange(['cookieEnabled', 'popupsEnabled', 'linksEnabled'], () => { chips().catch(() => {}); });

  if (typeof chrome === 'undefined' || !chrome.permissions || !chrome.runtime?.getManifest) return;
  // Firefox only: on Chromium those hosts are required at install, and
  // permissions.contains() does not report content-script hosts at all.
  if (!chrome.runtime.getURL('').startsWith('moz-extension:')) return;

  const matches = [...new Set((chrome.runtime.getManifest().content_scripts || [])
    .flatMap((c) => c.matches || []))];
  // Host permissions ignore paths; ask about the origin, as the browser stores it.
  const origin = (m) => m.replace(/^(\*|https?):\/\/([^/]+)\/.*$/, '$1://$2/*');
  const exact = [matches.find((x) => x.includes('google.com')), matches.find((x) => x.includes('bing.com'))]
    .filter(Boolean);
  const note = document.getElementById('accessNotice');
  // Either form counts: browsers differ in whether a content-script match is
  // stored with its path or as a bare origin.
  const check = async () => {
    const ok = !exact.length
      || await chrome.permissions.contains({ origins: exact }).catch(() => true)
      || await chrome.permissions.contains({ origins: exact.map(origin) }).catch(() => true);
    note.hidden = ok;
  };
  document.getElementById('grantBase').addEventListener('click', async () => {
    await chrome.permissions.request({ origins: matches }).catch(() => false);
    await check();
  });
  await check();
})();
