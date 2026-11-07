// Quell usage counts (src/shared/analytics.js) — executed, no browser, no network.
// Runs the real file in a vm against a fake chrome + fake fetch.
//   node tests/analytics.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const src = (f) => readFileSync(path.join(EXT, 'src/shared', f), 'utf8');
let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ FAIL ${n}`); } };

// firefox: the url scheme makes browser.js say Firefox; `ffPerm` is what
// browser.permissions.contains({data_collection}) answers.
function boot({ analytics = 'unset', firefox = false, ffPerm = true, status = 204, throws = false } = {}) {
  const local = { analytics };
  const asked = [];
  const sent = [];
  const area = {
    get: async (d) => {
      const out = {};
      if (typeof d === 'string') { if (d in local) out[d] = local[d]; return out; }
      for (const [k, v] of Object.entries(d || {})) out[k] = k in local ? local[k] : v;
      return out;
    },
    set: async (o) => { Object.assign(local, JSON.parse(JSON.stringify(o))); },
    remove: async (k) => { for (const x of [].concat(k)) delete local[x]; },
  };
  const perms = { contains: async (q) => { asked.push(q); return ffPerm; } };
  const chrome = {
    storage: { local: area, sync: { get: async () => ({}), set: async () => {} } },
    runtime: { id: 'x', getURL: () => (firefox ? 'moz-extension://abc/' : 'chrome-extension://abc/'), getManifest: () => ({ version: '0.7.3' }) },
    permissions: perms,
  };
  const sb = {
    chrome, console, URLSearchParams, JSON, Date, Math, Promise, setTimeout,
    crypto: { randomUUID: () => '3b241101-e2bb-4255-8caf-4136c566a962' },
    fetch: async (u, o) => { sent.push({ u, o }); if (throws) throw new Error('offline'); return { ok: status < 300, status }; },
    navigator: { userAgent: 'Mozilla/5.0' },
  };
  if (firefox) sb.browser = { permissions: perms };
  vm.createContext(sb);
  for (const f of ['settings.js', 'config.js', 'browser.js', 'analytics.js']) vm.runInContext(src(f), sb, { filename: f });
  return { A: sb.QuellAnalytics, local, sent, asked, sb };
}
const yesterday = (n = 1) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// Move everything counted "today" to an earlier day so it is eligible to send.
const age = (h, n = 1) => { const q = h.local.quellAnalytics; if (!q) return; q.days = { [yesterday(n)]: Object.values(q.days)[0] }; };

console.log('Analytics — nothing without a yes:');
for (const a of ['unset', 'off']) {
  const h = boot({ analytics: a });
  await h.A.event('popup_open'); await h.A.hides('ai', 3); await h.A.error('boom', 'background.js'); await h.A.touch();
  ok(!('quellAnalytics' in h.local), `analytics=${a}: nothing is counted and no install id is made`);
  await h.A.maybeFlush(true);
  ok(h.sent.length === 0, `analytics=${a}: nothing is sent`);
}

console.log('Analytics — counting once the user said yes:');
{
  const h = boot({ analytics: 'on' });
  await h.A.event('popup_open'); await h.A.event('popup_open'); await h.A.event('peek');
  ok(!(await h.A.event('not_an_event')), 'an unknown event name is dropped');
  await h.A.hides('ai', 4); await h.A.hides('cookies', 1);
  ok(!(await h.A.hides('hosts', 1)), 'an unknown hide feature is dropped');
  const q = h.local.quellAnalytics; const b = Object.values(q.days)[0];
  ok(q.id === '3b241101-e2bb-4255-8caf-4136c566a962', 'a random install id is made on the first count');
  ok(b.events.popup_open === 2 && b.events.peek === 1 && b.hides.ai === 4 && b.hides.cookies === 1, 'events and per-feature hides are counted per UTC day');
  ok(b.switches && b.switches.enabled === true && b.switches.cookies === false, 'the current switch states are recorded');
  ok(h.sent.length === 0, 'counting alone sends nothing (today is never sent)');
}

console.log('Analytics — sending:');
{
  const h = boot({ analytics: 'on' });
  await h.A.event('undo'); await h.A.hides('popups', 2);
  await h.A.error('Failed to fetch https://evil.example.com/search?q=secret terms at https://x.org/a', 'chrome-extension://abc/src/background.js?x=1');
  await h.A.error('cannot read www.example.co.uk/path of undefined', 'background.js');
  age(h);
  await h.A.maybeFlush(true);
  ok(h.sent.length === 1, 'one POST');
  const { u, o } = h.sent[0];
  ok(u === 'https://purpledirective.com/api/quell/events', 'to the first-party endpoint');
  ok(o.method === 'POST' && o.credentials === 'omit' && o.headers['Content-Type'] === 'text/plain', 'simple CORS POST, no credentials');
  const body = JSON.parse(o.body);
  ok(Object.keys(body).sort().join() === 'browser,days,id,v,version' && body.v === 1 && body.version === '0.7.3' && body.browser === 'chrome', 'top-level shape');
  const d = body.days[0];
  ok(Object.keys(d).sort().join() === 'day,errors,events,hides,switches' && d.day === yesterday(), 'day shape');
  ok(Object.keys(d.switches).sort().join() === 'ai,cookies,engines,enabled,popups,reject'.split(',').sort().join(), 'six switches');
  ok(!/:\/\/|https?|evil|example|secret|x\.org|www\./i.test(o.body), `payload has no URL, host or query text (${o.body.slice(0, 200)})`);
  ok(d.errors.length === 2 && d.errors.every((e) => /^[\w.-]+$/.test(e.f)) && d.errors[0].f === 'background.js', 'errors carry message + file name only');
  ok(!('quellAnalytics' in h.local) || Object.keys(h.local.quellAnalytics.days).length === 0, 'sent days are removed from the queue');
  await h.A.event('peek'); age(h, 1); await h.A.maybeFlush();
  ok(h.sent.length === 1, 'not again within a day (throttled even when asked)');
}
{
  const h = boot({ analytics: 'on', throws: true });
  await h.A.event('undo'); age(h); await h.A.maybeFlush(true);
  ok(Object.keys(h.local.quellAnalytics.days).length === 1, 'a failed send keeps the days for the next attempt');
}
{
  const h = boot({ analytics: 'on', status: 400 });
  await h.A.event('undo'); age(h); await h.A.maybeFlush(true);
  ok(Object.keys(h.local.quellAnalytics.days).length === 0, 'a refusal (4xx) drops the days instead of retrying forever');
}

console.log('Analytics — turning it off:');
{
  const h = boot({ analytics: 'on' });
  await h.A.event('undo'); await h.A.hides('ai', 5); age(h);
  h.local.analytics = 'off';
  await h.A.maybeFlush(true);
  ok(h.sent.length === 0, 'off: the queued days are not sent');
  await h.A.stop();
  ok(!('quellAnalytics' in h.local), 'stop() clears queued counts and the install id');
  await h.A.event('undo');
  ok(!('quellAnalytics' in h.local), 'and nothing is counted afterwards');
}

console.log('Analytics — Firefox gate:');
{
  const h = boot({ analytics: 'on', firefox: true, ffPerm: false });
  await h.A.event('undo'); await h.A.hides('ai', 1); age(h);
  ok(!('quellAnalytics' in h.local), 'Firefox without the data-collection permission: nothing counted');
  await h.A.maybeFlush(true);
  ok(h.sent.length === 0, '... and nothing sent');
  ok(h.asked.some((q) => q.data_collection && q.data_collection[0] === 'technicalAndInteraction'), 'it asked permissions.contains({data_collection:[technicalAndInteraction]})');
}
{
  const h = boot({ analytics: 'on', firefox: true, ffPerm: true });
  await h.A.event('undo'); age(h); await h.A.maybeFlush(true);
  ok(h.sent.length === 1 && JSON.parse(h.sent[0].o.body).browser === 'firefox', 'Firefox with the permission: sent, browser=firefox');
}
{
  const h = boot({ analytics: 'on', firefox: true, ffPerm: true });
  await h.A.event('undo'); age(h); h.sb.browser.permissions.contains = async () => false;
  await h.A.maybeFlush(true);
  ok(h.sent.length === 0, 'Firefox permission withdrawn between counting and sending: nothing sent');
}

console.log('Analytics — scrubbing and uninstall URL:');
{
  const { A } = boot({ analytics: 'on' });
  ok(!/\/\/|google|\.com/.test(A.scrub('GET https://www.google.com/search?q=cats failed on www.google.com')), 'scrub removes URLs and bare hosts');
  ok(A.scrub('fetch to 192.168.1.5:8080/admin failed') === 'fetch to <ip> failed', 'scrub removes IPv4 literals with port and path');
  ok(A.scrub('localhost:3000/api refused, [::1]:8080/x down') === '<host> refused, <ip> down', 'scrub removes localhost and IPv6 literals');
  ok(A.scrub('x'.repeat(500)).length === 160, 'scrub caps length');
  ok(A.scrub('Unexpected token in popup.js') === 'Unexpected token in popup.js', 'file names survive');
  ok(A.sourceFile('https://evil.com/a/b.js?x=1') === 'b.js' && A.sourceFile('weird name') === 'unknown', 'sourceFile keeps a bare file name only');
}
{
  const off = boot({ analytics: 'unset' });
  const u = await off.A.uninstallUrl();
  ok(u === 'https://purpledirective.com/quell/goodbye?v=0.7.3&b=chrome', `uninstall URL without consent has no id (${u})`);
  const on = boot({ analytics: 'on' });
  const u2 = await on.A.uninstallUrl();
  ok(u2 === 'https://purpledirective.com/quell/goodbye?v=0.7.3&b=chrome&i=3b241101-e2bb-4255-8caf-4136c566a962', 'with analytics on the install id is added');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
