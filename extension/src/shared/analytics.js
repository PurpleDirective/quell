// Quell — consented, anonymous usage counts. Loaded in the background only
// (Chrome: importScripts; Firefox: background.scripts). Classic script, no
// imports, no dependencies.
//
// THE RULES THIS FILE ENFORCES
//   * Nothing is recorded or sent unless settings.analytics === 'on' — the
//     answer to the first-run checkbox. 'unset' (nobody has answered) and
//     'off' both mean nothing: no counting, no install id, no request.
//   * On Firefox it additionally needs the browser's own data-collection
//     permission (technicalAndInteraction). Without it: nothing.
//   * Switching to anything but 'on' empties the queue and forgets the install
//     id at once.
//   * Never a URL, domain, search term, page text or browsing history. What is
//     kept is counts under fixed names (below), the on/off state of Quell's own
//     switches, and error text with every URL-like piece stripped.
//   * One POST at most per ~day, to the first-party endpoint in config.js.
//
// WHAT IS SENT (the whole payload; server/report-worker/src/index.js refuses
// anything else):
//   { v:1, id:"<random uuid>", version:"0.7.3", browser:"chrome|firefox|opera",
//     days:[ { day:"YYYY-MM-DD" (UTC), switches:{enabled,ai,cookies,popups,engines,reject},
//              events:{popup_open:n,...}, hides:{ai:n,cookies:n,popups:n},
//              errors:[{m:"message",f:"file.js",n:count}] } ] }
//
// No alarm: a daily flush is attempted when the worker starts and when the
// first count of a new day arrives, so the extension needs no "alarms"
// permission. The worker wakes for every search page, so that is enough.

(() => {
  const g = globalThis;
  if (g.QuellAnalytics) return;

  const KEY = 'quellAnalytics';          // storage.local: { id, lastFlushAt, days }
  const EVENTS = ['popup_open', 'peek', 'undo', 'pause', 'report_open', 'firstrun_turn_on', 'firstrun_skip'];
  const FEATURES = ['ai', 'cookies', 'popups'];
  const SWITCHES = ['enabled', 'ai', 'cookies', 'popups', 'engines', 'reject'];
  const KEEP_DAYS = 7;                   // unsent days older than this are dropped
  const MAX_ERRORS_PER_DAY = 10;
  const MAX_MSG = 160;
  const FLUSH_EVERY_MS = 20 * 3600 * 1000;
  const COUNT_CAP = 100000;

  const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
  const api = () => (typeof chrome !== 'undefined' && chrome.storage) ? chrome.storage : null;

  const family = () => {
    const b = g.QuellBrowser || {};
    return b.firefox ? 'firefox' : b.opera ? 'opera' : 'chrome';
  };
  const isFirefox = () => family() === 'firefox';

  // Strip anything address-like from error text: scheme URLs, then bare
  // host names (anything that looks like name.tld, except file names).
  const FILE_EXT = /^(js|mjs|json|css|html|map|wasm)$/i;
  function scrub(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>]*/gi, '<url>');
    s = s.replace(/\b(?:[a-z0-9-]+\.)+([a-z]{2,63})\b(?:[/:?#][^\s)'"<>]*)?/gi,
      (m, tld) => (FILE_EXT.test(tld) ? m : '<host>'));
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > MAX_MSG ? s.slice(0, MAX_MSG) : s;
  }
  function sourceFile(raw) {
    const s = String(raw || '').split(/[?#]/)[0];
    const base = s.slice(s.lastIndexOf('/') + 1);
    return /^[\w.-]{1,64}$/.test(base) ? base : 'unknown';
  }

  // The gate. Everything goes through this, at the moment of use.
  async function allowed() {
    const s = api();
    if (!s) return false;
    let a = 'unset';
    try { a = (await s.local.get({ analytics: 'unset' })).analytics; } catch (_) { return false; }
    if (a !== 'on') return false;
    if (isFirefox()) {
      const b = g.browser || g.chrome;
      try {
        return !!(await b.permissions.contains({ data_collection: ['technicalAndInteraction'] }));
      } catch (_) { return false; }
    }
    return true;
  }

  // All writes go through one chain: read-modify-write must not interleave,
  // and an "off" must land after every count already in flight.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  const load = async () => {
    const got = await api().local.get({ [KEY]: null });
    const v = got[KEY];
    return v && typeof v === 'object' ? v : { id: null, lastFlushAt: 0, days: {} };
  };
  const save = (q) => api().local.set({ [KEY]: q });

  async function switchState() {
    const S = g.QuellSettings;
    if (!S) return null;
    const s = await S.get();
    return {
      enabled: !!s.enabled, ai: !!s.aiEnabled, cookies: !!s.cookieEnabled,
      popups: !!s.popupsEnabled, engines: !!s.enginesEnabled, reject: !!s.cookieReject,
    };
  }

  function bucket(q, d, switches) {
    const b = q.days[d] || (q.days[d] = { switches: null, events: {}, hides: {}, errors: [] });
    if (switches) b.switches = switches;
    return b;
  }

  // Run `mutate(bucketForToday, queue)` if, and only if, the user said yes.
  function record(mutate) {
    return serial(async () => {
      if (!(await allowed())) return false;
      const q = await load();
      if (!q.id) q.id = crypto.randomUUID();
      const b = bucket(q, day(), await switchState());
      mutate(b, q);
      for (const d of Object.keys(q.days).sort().slice(0, -KEEP_DAYS)) delete q.days[d];
      await save(q);
      return true;
    }).then((r) => { if (r) maybeFlush(); return r; }).catch(() => false);
  }

  const bump = (obj, k, n) => { obj[k] = Math.min(COUNT_CAP, (obj[k] || 0) + n); };

  function event(name) {
    if (!EVENTS.includes(name)) return Promise.resolve(false);
    return record((b) => bump(b.events, name, 1));
  }
  function hides(feature, n) {
    if (!FEATURES.includes(feature) || !Number.isInteger(n) || n <= 0) return Promise.resolve(false);
    return record((b) => bump(b.hides, feature, Math.min(n, 500)));
  }
  function error(message, file) {
    const m = scrub(message);
    if (!m) return Promise.resolve(false);
    const f = sourceFile(file);
    return record((b) => {
      const hit = b.errors.find((e) => e.m === m && e.f === f);
      if (hit) hit.n = Math.min(1000, hit.n + 1);
      else if (b.errors.length < MAX_ERRORS_PER_DAY) b.errors.push({ m, f, n: 1 });
    });
  }
  // A day with nothing to count still counts as "Quell was installed and on".
  const touch = () => record(() => {});

  // Build the payload from every completed (past, UTC) day, or null.
  function payloadOf(q) {
    const today = day();
    const days = Object.keys(q.days).filter((d) => d < today).sort().map((d) => {
      const b = q.days[d];
      const sw = {};
      for (const k of SWITCHES) sw[k] = !!(b.switches && b.switches[k]);
      return { day: d, switches: sw, events: b.events, hides: b.hides, errors: b.errors };
    });
    if (!days.length || !q.id) return null;
    return {
      v: 1, id: q.id, version: chrome.runtime.getManifest().version, browser: family(), days,
    };
  }

  let flushing = false;
  let nextCheck = 0; // in-memory: don't even read storage more than every 10 min
  // At most one attempt per ~day. On success the sent days are deleted; on
  // failure they stay (up to KEEP_DAYS) for the next day's attempt.
  function maybeFlush(force = false) {
    if (!force && (flushing || Date.now() < nextCheck)) return Promise.resolve(false);
    flushing = true;
    nextCheck = Date.now() + 10 * 60 * 1000;
    return serial(async () => {
      if (!(await allowed())) return false;
      const q = await load();
      if (!force && Date.now() - (q.lastFlushAt || 0) < FLUSH_EVERY_MS) return false;
      const body = payloadOf(q);
      if (!body) return false;
      q.lastFlushAt = Date.now();
      await save(q);
      const endpoint = g.QUELL_CONFIG && g.QUELL_CONFIG.EVENTS_ENDPOINT;
      if (!endpoint) return false;
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          // text/plain keeps it a CORS "simple request": no host permission, no preflight.
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(body),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch (_) { return false; }
      // 4xx other than 429 means the server will never take these days: drop
      // them rather than retry forever. 5xx / 429 / network: keep.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        const fresh = await load();
        for (const d of body.days) delete fresh.days[d.day];
        await save(fresh);
      }
      return res.ok;
    }).catch(() => false).finally(() => { flushing = false; });
  }

  // Anything but 'on' ends it now: queued counts and the install id go.
  function stop() {
    return serial(async () => { await api().local.remove(KEY); }).catch(() => {});
  }

  // The uninstall page link. The install id rides along only while analytics
  // is on (so a reply can be matched to counts); otherwise just version+browser.
  async function uninstallUrl() {
    const base = (g.QUELL_CONFIG && g.QUELL_CONFIG.UNINSTALL_URL) || '';
    if (!base) return '';
    const p = new URLSearchParams({ v: chrome.runtime.getManifest().version, b: family() });
    if (await allowed()) {
      const q = await serial(async () => {
        const cur = await load();
        if (!cur.id) { cur.id = crypto.randomUUID(); await save(cur); }
        return cur;
      });
      p.set('i', q.id);
    }
    return `${base}?${p}`;
  }

  g.QuellAnalytics = {
    EVENTS, FEATURES, SWITCHES, scrub, sourceFile, allowed,
    event, hides, error, touch, maybeFlush, stop, uninstallUrl, payloadOf, load,
  };
})();
