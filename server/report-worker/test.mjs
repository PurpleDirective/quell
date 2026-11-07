// Quell report Worker — executed tests, no dependencies, no network.
// Runs the real src/index.js against a real SQLite database (node:sqlite,
// Node 22.5+) behind a D1-shaped adapter, so the SQL itself is exercised.
//   node server/report-worker/test.mjs

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import worker, { validHost, purgeOld, utcDay, allowedOrigin, validateEvents, scrubMessage } from './src/index.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}`); }
};

// D1 surface used by the Worker: prepare(sql).bind(...).run() / .all().
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(path.join(DIR, 'schema.sql'), 'utf8'));
  return {
    raw: db,
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
        all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
      };
      return st;
    },
  };
}
function limiter(limit) {
  const seen = new Map();
  const keys = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}
const CHROME_ID = 'hipifmmjmbnkhfajkbmcjkajlfjiehho';
const CHROME_ORIGIN = `chrome-extension://${CHROME_ID}`;
const env = (over = {}) => ({
  DB: d1(), CLIENT_LIMITER: limiter(5), GLOBAL_LIMITER: limiter(1000),
  READ_TOKEN: 'secret-token-123', RATE_SALT: 'salt',
  CHROME_EXTENSION_ID: CHROME_ID, OPERA_EXTENSION_ID: '', ...over,
});
const IP = '203.0.113.77';
const post = (body, headers = {}) => new Request('https://purpledirective.com/api/quell/report', {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': IP, 'User-Agent': 'UA-probe/1.0', Origin: CHROME_ORIGIN, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const rows = (e) => e.DB.raw.prepare('SELECT * FROM reports ORDER BY host').all().map((r) => ({ ...r }));

console.log('Report Worker — accepts exactly {host, version}:');
{
  const e = env();
  const r = await worker.fetch(post({ host: 'Shop.Example.co.uk', version: '0.6.0' }), e);
  ok(r.status === 204, `a valid report is accepted (${r.status})`);
  ok(r.headers.get('Access-Control-Allow-Origin') === CHROME_ORIGIN, 'CORS echoes the extension origin (never *)');
  const rs = rows(e);
  ok(rs.length === 1 && rs[0].host === 'shop.example.co.uk' && rs[0].version === '0.6.0' && rs[0].count === 1
     && rs[0].day === utcDay(), `stored as one aggregate row, host lower-cased (${JSON.stringify(rs)})`);
  await worker.fetch(post({ host: 'shop.example.co.uk', version: '0.6.0' }), e);
  ok(rows(e)[0].count === 2 && rows(e).length === 1, 'a second report for the same site increments the count');

  // Nothing identifying anywhere in the database.
  const dump = JSON.stringify(e.DB.raw.prepare('SELECT * FROM reports').all());
  ok(!dump.includes(IP) && !dump.includes('UA-probe'), 'no IP address and no user-agent are stored');
  const cols = e.DB.raw.prepare("SELECT name FROM pragma_table_info('reports')").all().map((c) => c.name).join(',');
  ok(cols === 'day,host,version,count', `the table has no column that could hold one (${cols})`);
  // The per-client limiter is keyed by a salted hash, never the raw IP.
  ok(e.CLIENT_LIMITER.keys.length === 2 && e.CLIENT_LIMITER.keys.every((k) => /^[0-9a-f]{64}$/.test(k) && !k.includes(IP)),
    'the rate limiter sees a salted SHA-256, not the IP');
}

console.log('Report Worker — refuses anything else:');
for (const [name, body, want] of [
  ['an extra field', { host: 'a.com', version: '0.6.0', url: 'https://a.com/x' }, 400],
  ['a missing version', { host: 'a.com' }, 400],
  ['a path in host', { host: 'a.com/cart', version: '0.6.0' }, 400],
  ['a full URL as host', { host: 'https://a.com', version: '0.6.0' }, 400],
  ['an IPv4 literal', { host: '192.168.1.10', version: '0.6.0' }, 400],
  ['localhost', { host: 'localhost', version: '0.6.0' }, 400],
  ['a private .local name', { host: 'nas.local', version: '0.6.0' }, 400],
  ['a .internal name', { host: 'git.corp.internal', version: '0.6.0' }, 400],
  ['a bad version', { host: 'a.com', version: '0.6.0-beta; drop' }, 400],
  ['a non-string version', { host: 'a.com', version: 6 }, 400],
  ['an array', [], 400],
  ['not JSON', 'host=a.com', 400],
  ['an oversize body', JSON.stringify({ host: 'a.com', version: '0.6.0', pad: 'x'.repeat(600) }), 413],
]) {
  const e = env();
  const r = await worker.fetch(post(body), e);
  ok(r.status === want && rows(e).length === 0, `${name} → ${want}, nothing stored (${r.status})`);
}
{
  const e = env();
  const r = await worker.fetch(new Request('https://purpledirective.com/api/quell/report'), e);
  ok(r.status === 405, `GET on the report path → 405 (${r.status})`);
  const o = await worker.fetch(new Request('https://purpledirective.com/api/quell/report', { method: 'OPTIONS', headers: { Origin: CHROME_ORIGIN } }), e);
  ok(o.status === 204 && /POST/.test(o.headers.get('Access-Control-Allow-Methods')), 'OPTIONS preflight answered for the extension');
  const o2 = await worker.fetch(new Request('https://purpledirective.com/api/quell/report', { method: 'OPTIONS', headers: { Origin: 'https://evil.example.com' } }), e);
  ok(o2.status === 403 && !o2.headers.get('Access-Control-Allow-Origin'), 'OPTIONS from any other origin → 403, no CORS grant');
  const n = await worker.fetch(new Request('https://purpledirective.com/api/quell/elsewhere', { method: 'POST' }), e);
  ok(n.status === 404, 'unknown path → 404');
  ok(validHost('xn--bcher-kva.example') === false && validHost('bücher.de') === false && validHost('xn--bcher-kva.de') === true,
    'IDN: punycode accepted, raw Unicode refused (the browser always reports punycode)');
}

console.log('Report Worker — only Quell may post (review #7):');
{
  const MOZ = 'moz-extension://0c7e7a3e-1b2c-4d5e-8f90-123456789abc';
  for (const [name, origin, want] of [
    ['the Chrome Web Store build', CHROME_ORIGIN, 204],
    ['a Firefox install (random per-install UUID)', MOZ, 204],
    ['another Firefox install', 'moz-extension://ffffffff-0000-4000-8000-000000000001', 204],
    ['a web page', 'https://evil.example.com', 403],
    ['no Origin at all (curl)', null, 403],
    ['a different Chrome extension', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 403],
    ['an unpacked dev build (other id)', 'chrome-extension://pppppppppppppppppppppppppppppppp', 403],
    ['a moz-extension origin that is not a UUID', 'moz-extension://quell', 403],
    ['the string "null"', 'null', 403],
  ]) {
    const e = env();
    const headers = origin === null ? { Origin: '' } : { Origin: origin };
    const req = new Request('https://purpledirective.com/api/quell/report', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': IP, ...headers },
      body: JSON.stringify({ host: 'shop.example.com', version: '0.6.0' }),
    });
    if (origin === null) req.headers.delete('Origin');
    const r = await worker.fetch(req, e);
    ok(r.status === want && rows(e).length === (want === 204 ? 1 : 0), `${name} → ${want} (${r.status})`);
    if (want === 204) ok(r.headers.get('Access-Control-Allow-Origin') === origin, `  …and the reply is readable by exactly that origin`);
  }
  // The Edge id is configuration: empty = unknown = not accepted; set = accepted.
  const OPERA = 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  ok(!allowedOrigin(OPERA, env()), 'Opera id not yet assigned (empty var) → not accepted');
  ok(allowedOrigin(OPERA, env({ OPERA_EXTENSION_ID: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })), 'Opera id set in config → accepted (no code change needed at publish)');
  ok(!allowedOrigin(CHROME_ORIGIN, env({ CHROME_EXTENSION_ID: '' })), 'no Chrome id configured → nothing chrome-extension:// is accepted');
  // Origin is checked before anything is parsed or counted.
  const e = env({ CLIENT_LIMITER: limiter(0) });
  const r = await worker.fetch(post({ host: 'a.com', version: '0.6.0' }, { Origin: 'https://evil.example.com' }), e);
  ok(r.status === 403 && e.CLIENT_LIMITER.keys.length === 0, 'a refused origin never reaches the limiter or the database');
}

console.log('Report Worker — the host rule is the extension\'s, shared (review #6):');
{
  const extSrc = readFileSync(path.join(DIR, '../../extension/src/shared/report-host.js'), 'utf8');
  const wSrc = readFileSync(path.join(DIR, 'src/index.js'), 'utf8');
  const line = (src, name) => (src.match(new RegExp(`^\\s*const ${name} = .*$`, 'm')) || [''])[0].trim();
  for (const n of ['LABEL', 'HOST_RE', 'PRIVATE_SUFFIXES']) {
    ok(line(extSrc, n) && line(extSrc, n) === line(wSrc, n), `${n} is identical in report-host.js and the Worker`);
  }
  const sb = {}; vm.createContext(sb); vm.runInContext(extSrc, sb);
  const corpus = ['example.com', 'shop.example.co.uk', 'xn--bcher-kva.de', 'a-b.io', '192.168.1.10', '10.0.0.1',
    'localhost', 'nas.local', 'router.lan', 'git.corp.internal', 'x.home.arpa', 'my_site.com', '-bad.com',
    'bad-.com', 'bücher.de', 'a.b', 'Example.com', 'site.test', 'hidden.onion', '', 'com', 'a'.repeat(64) + '.com'];
  const diff = corpus.filter((h) => sb.QuellReportHost.valid(h) !== validHost(h));
  ok(diff.length === 0, `popup and Worker agree on every host in a ${corpus.length}-host corpus (${diff.join(',') || 'no disagreements'})`);
}

console.log('Report Worker — rate limits:');
{
  const e = env();
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await worker.fetch(post({ host: `s${i}.example.com`, version: '0.6.0' }), e)).status);
  ok(codes.slice(0, 5).every((c) => c === 204) && codes.slice(5).every((c) => c === 429),
    `one client: 5 per minute, then 429 (${codes.join(',')})`);
  ok(rows(e).length === 5, 'rate-limited reports are not stored');
  const other = await worker.fetch(post({ host: 's9.example.com', version: '0.6.0' }, { 'CF-Connecting-IP': '198.51.100.1' }), e);
  ok(other.status === 204, 'a different client is not affected by the first one\'s limit');
  const g = env({ GLOBAL_LIMITER: limiter(2), CLIENT_LIMITER: limiter(100) });
  const gc = [];
  for (let i = 0; i < 3; i++) gc.push((await worker.fetch(post({ host: 'x.example.com', version: '0.6.0' }, { 'CF-Connecting-IP': `198.51.100.${i}` }), g)).status);
  ok(gc.join(',') === '204,204,429', `the global ceiling holds across clients (${gc.join(',')})`);
  const bad = await worker.fetch(post({ host: 'a.com', version: 'x' }), env({ CLIENT_LIMITER: limiter(0) }));
  ok(bad.status === 400, 'validation runs before the limiter (junk does not spend a client\'s budget)');
}

console.log('Report Worker — read endpoint for the weekly rules work:');
{
  const e = env();
  for (const h of ['a.example.com', 'a.example.com', 'b.example.org']) await worker.fetch(post({ host: h, version: '0.6.0' }, { 'CF-Connecting-IP': Math.random().toString() }), e);
  e.DB.raw.prepare("INSERT INTO reports VALUES ('2020-01-01','old.example.com','0.5.0',9)").run();
  const noAuth = await worker.fetch(new Request('https://purpledirective.com/api/quell/reports?days=7'), e);
  ok(noAuth.status === 401, 'no token → 401');
  const wrong = await worker.fetch(new Request('https://purpledirective.com/api/quell/reports', { headers: { Authorization: 'Bearer nope' } }), e);
  ok(wrong.status === 401, 'wrong token → 401');
  const unset = await worker.fetch(new Request('https://purpledirective.com/api/quell/reports', { headers: { Authorization: 'Bearer ' } }), env({ READ_TOKEN: '' }));
  ok(unset.status === 401, 'an unset READ_TOKEN never matches an empty bearer');
  const r = await worker.fetch(new Request('https://purpledirective.com/api/quell/reports?days=7', { headers: { Authorization: 'Bearer secret-token-123' } }), e);
  const j = await r.json();
  ok(r.status === 200 && j.rows.length === 2 && j.rows[0].host === 'a.example.com' && j.rows[0].reports === 2,
    `aggregated, busiest first, inside the window only (${JSON.stringify(j.rows)})`);
  const cutoff = await purgeOld(e);
  ok(rows(e).every((x) => x.day >= cutoff) && !rows(e).some((x) => x.host === 'old.example.com'),
    `the scheduled purge drops rows older than 180 days (cutoff ${cutoff})`);
}

console.log('Events — usage counts (POST /api/quell/events):');
{
  const ID = '3b241101-e2bb-4255-8caf-4136c566a962';
  const D1 = utcDay(new Date(Date.now() - 86400000)), D2 = utcDay(new Date(Date.now() - 2 * 86400000));
  const sw = (o = {}) => ({ enabled: true, ai: true, cookies: false, popups: false, engines: false, reject: false, ...o });
  const day = (d, o = {}) => ({ day: d, switches: sw(), events: { popup_open: 2, undo: 1 }, hides: { ai: 7, cookies: 2 }, errors: [{ m: 'boom', f: 'background.js', n: 3 }], ...o });
  const payload = (o = {}) => ({ v: 1, id: ID, version: '0.7.3', browser: 'chrome', days: [day(D1)], ...o });
  const evPost = (body, headers = {}) => new Request('https://purpledirective.com/api/quell/events', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': IP, 'User-Agent': 'UA-probe/1.0', Origin: CHROME_ORIGIN, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const count = (e, t) => e.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

  const e = env();
  const r = await worker.fetch(evPost(payload()), e);
  ok(r.status === 204 && r.headers.get('Access-Control-Allow-Origin') === CHROME_ORIGIN, `a valid payload is accepted (${r.status})`);
  const row = e.DB.raw.prepare('SELECT * FROM quell_install_days').get();
  ok(row.install_id === ID && row.day === D1 && row.hides_ai === 7 && row.sw_enabled === 1 && row.sw_cookies === 0, 'one row per install-day');
  const agg = e.DB.raw.prepare('SELECT * FROM quell_daily').get();
  ok(agg.installs === 1 && agg.sw_ai === 1 && agg.hides_ai === 7 && agg.hides_cookies === 2 && agg.browser === 'chrome' && agg.version === '0.7.3', 'aggregate per day/version/browser');
  ok(e.DB.raw.prepare("SELECT count FROM quell_events WHERE name='popup_open'").get().count === 2, 'event aggregate');
  ok(e.DB.raw.prepare('SELECT count FROM quell_errors').get().count === 3, 'error aggregate');
  await worker.fetch(evPost(payload()), e);
  ok(e.DB.raw.prepare('SELECT installs FROM quell_daily').get().installs === 1 && count(e, 'quell_install_days') === 1, 'a replayed day changes nothing (idempotent)');
  await worker.fetch(evPost(payload({ id: '3b241101-e2bb-4255-8caf-4136c566a963', days: [day(D1), day(D2)] })), e);
  ok(e.DB.raw.prepare('SELECT installs FROM quell_daily WHERE day=?').get(D1).installs === 2 && count(e, 'quell_install_days') === 3, 'a second install adds to the aggregate; multi-day payloads store each day');

  const dump = JSON.stringify(['quell_install_days', 'quell_daily', 'quell_events', 'quell_errors'].map((t) => e.DB.raw.prepare(`SELECT * FROM ${t}`).all()));
  ok(!dump.includes(IP) && !dump.includes('UA-probe'), 'no IP address and no user-agent are stored');
  const cols = ['quell_install_days', 'quell_daily', 'quell_events', 'quell_errors']
    .flatMap((t) => e.DB.raw.prepare(`SELECT name FROM pragma_table_info('${t}')`).all().map((c) => c.name));
  ok(!cols.some((c) => /ip|agent|url|host|domain|query|search|page|ts|time/i.test(c.replace(/^(sw|hides)_/, '')) && c !== 'sw_popups' && c !== 'hides_popups' && c !== 'events_json' && c !== 'installs'),
    `no column could hold a URL, domain, search or finer timestamp (${cols.join(',')})`);

  for (const [name, body, want] of [
    ['an extra top-level field', payload({ url: 'https://a.com' }), 400],
    ['an extra field in a day', payload({ days: [day(D1, { host: 'a.com' })] }), 400],
    ['a missing field', (() => { const p = payload(); delete p.browser; return p; })(), 400],
    ['an unknown browser', payload({ browser: 'edge' }), 400],
    ['v 2', payload({ v: 2 }), 400],
    ['a non-uuid id', payload({ id: 'user@example.com' }), 400],
    ['a bad version', payload({ version: '0.7.3; drop' }), 400],
    ['no days', payload({ days: [] }), 400],
    ['eight days', payload({ days: Array.from({ length: 8 }, (_, i) => day(utcDay(new Date(Date.now() - (i + 1) * 86400000)))) }), 400],
    ['a duplicate day', payload({ days: [day(D1), day(D1)] }), 400],
    ['a future day', payload({ days: [day(utcDay(new Date(Date.now() + 5 * 86400000)))] }), 400],
    ['an old day', payload({ days: [day('2020-01-01')] }), 400],
    ['an impossible date', payload({ days: [day('2026-02-30')] }), 400],
    ['an unknown event name', payload({ days: [day(D1, { events: { visited_site: 1 } })] }), 400],
    ['a negative count', payload({ days: [day(D1, { events: { undo: -1 } })] }), 400],
    ['a fractional count', payload({ days: [day(D1, { hides: { ai: 1.5 } })] }), 400],
    ['an unknown hide feature', payload({ days: [day(D1, { hides: { 'example.com': 1 } })] }), 400],
    ['a non-boolean switch', payload({ days: [day(D1, { switches: sw({ ai: 'yes' }) })] }), 400],
    ['an extra switch', payload({ days: [day(D1, { switches: { ...sw(), vpn: true } })] }), 400],
    ['an error file with a path', payload({ days: [day(D1, { errors: [{ m: 'x', f: 'https://a.com/x.js', n: 1 }] })] }), 400],
    ['an over-long error message', payload({ days: [day(D1, { errors: [{ m: 'x'.repeat(161), f: 'a.js', n: 1 }] })] }), 400],
    ['eleven errors', payload({ days: [day(D1, { errors: Array.from({ length: 11 }, (_, i) => ({ m: 'e' + i, f: 'a.js', n: 1 })) })] }), 400],
    ['an array', [], 400],
    ['not JSON', 'id=1', 400],
    ['an oversize body', JSON.stringify(payload({ pad: 'x'.repeat(7000) })), 413],
  ]) {
    const x = env();
    const rr = await worker.fetch(evPost(body), x);
    ok(rr.status === want && count(x, 'quell_install_days') === 0 && count(x, 'quell_daily') === 0, `${name} → ${want}, nothing stored (${rr.status})`);
  }

  // A URL that slipped past the client is scrubbed before it is stored.
  const x = env();
  await worker.fetch(evPost(payload({ days: [day(D1, { errors: [{ m: 'fail https://shop.example.com/cart?q=secret at www.foo.org', f: 'a.js', n: 1 }] })] })), x);
  const stored = x.DB.raw.prepare('SELECT message FROM quell_errors').get().message;
  ok(!/example|secret|foo|:\/\//.test(stored), `a URL or host in an error message is scrubbed server-side (${stored})`);
  ok(scrubMessage('in popup.js line 3') === 'in popup.js line 3', 'file names survive the scrub');
  ok(scrubMessage('fetch to 192.168.1.5:8080/admin failed; localhost:3000 refused; [::1]:9/x') === 'fetch to <ip> failed; <host> refused; <ip>', 'IP literals and localhost are scrubbed server-side');

  // Same gate as /report.
  const bad = env();
  for (const [name, origin, want] of [['a web page', 'https://evil.example.com', 403], ['no Origin', '', 403], ['Firefox', 'moz-extension://0c7e7a3e-1b2c-4d5e-8f90-123456789abc', 204]]) {
    const q = evPost(payload(), { Origin: origin }); if (!origin) q.headers.delete('Origin');
    const rr = await worker.fetch(q, bad);
    ok(rr.status === want, `${name} → ${want} (${rr.status})`);
  }
  const lim = env({ CLIENT_LIMITER: limiter(1) });
  const c1 = (await worker.fetch(evPost(payload()), lim)).status, c2 = (await worker.fetch(evPost(payload({ id: '3b241101-e2bb-4255-8caf-4136c566a964' })), lim)).status;
  ok(c1 === 204 && c2 === 429, `rate limited like /report (${c1},${c2})`);
  const g = await worker.fetch(new Request('https://purpledirective.com/api/quell/events'), e);
  ok(g.status === 405, 'GET on events → 405');
  const o = await worker.fetch(new Request('https://purpledirective.com/api/quell/events', { method: 'OPTIONS', headers: { Origin: CHROME_ORIGIN } }), e);
  ok(o.status === 204, 'OPTIONS preflight answered');
  ok(validateEvents(payload()).value.days[0].hides.popups === 0, 'validated payload fills missing hide features with 0');

  console.log('Events — stats endpoint:');
  const noAuth = await worker.fetch(new Request('https://purpledirective.com/api/quell/stats'), e);
  ok(noAuth.status === 401, 'no token → 401');
  const st = await worker.fetch(new Request('https://purpledirective.com/api/quell/stats?days=7', { headers: { Authorization: 'Bearer secret-token-123' } }), e);
  const j = await st.json();
  const d1 = j.active_installs_per_day.find((a) => a.day === D1);
  ok(st.status === 200 && d1 && d1.installs === 2, `active installs per day (${JSON.stringify(j.active_installs_per_day)})`);
  ok(j.weekly_active_installs === 2, `weekly active installs counts distinct ids (${j.weekly_active_installs})`);
  const ad = j.adoption_and_hides_per_day.find((a) => a.day === D1);
  ok(ad.ai === 2 && ad.cookies === 0 && ad.hides_ai === 14, `switch adoption and hide counts (${JSON.stringify(ad)})`);
  ok(j.events[0].name === 'popup_open' && j.events[0].count === 6, `events ranked (${JSON.stringify(j.events[0])})`);
  ok(j.errors[0].source === 'background.js' && j.errors[0].count >= 3 && j.by_browser[0].browser === 'chrome' && j.by_version[0].version === '0.7.3', 'errors, browser and version summaries');

  e.DB.raw.prepare("INSERT INTO quell_install_days VALUES ('old','2020-01-01','0.7.3','chrome',1,1,0,0,0,0,0,0,0,'{}','[]')").run();
  e.DB.raw.prepare("INSERT INTO quell_daily (day,version,browser) VALUES ('2020-01-01','0.7.3','chrome')").run();
  const mid = utcDay(new Date(Date.now() - 120 * 86400000));
  e.DB.raw.prepare(`INSERT INTO quell_install_days VALUES ('mid','${mid}','0.7.3','chrome',1,1,0,0,0,0,0,0,0,'{}','[]')`).run();
  e.DB.raw.prepare(`INSERT INTO quell_daily (day,version,browser) VALUES ('${mid}','0.7.3','chrome')`).run();
  await purgeOld(e);
  ok(!e.DB.raw.prepare("SELECT 1 FROM quell_install_days WHERE install_id IN ('old','mid')").get() && !e.DB.raw.prepare("SELECT 1 FROM quell_daily WHERE day='2020-01-01'").get(),
    'purge: install-id rows after 90 days, aggregates after 180');
  ok(!!e.DB.raw.prepare(`SELECT 1 FROM quell_daily WHERE day='${mid}'`).get(), 'aggregates between 90 and 180 days are kept');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
