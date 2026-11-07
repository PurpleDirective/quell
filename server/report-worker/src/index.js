// Quell — "this site looks broken" report endpoint (Cloudflare Worker).
// Dependency-free. Deploy notes: ../README.md.
//
// CONTRACT (what the extension sends, and all it may send):
//   POST /api/quell/report
//   Origin: Quell's extension origin     (anything else → 403, see below)
//   Content-Type: text/plain            (a CORS "simple request")
//   {"host":"example.com","version":"0.6.0"}
//
// WHAT IS STORED: one row per (UTC day, host, Quell version) with a count.
// Nothing else — no IP address, no user-agent, no timestamp finer than the
// day, no headers. The client IP is used only to key the edge rate limiter,
// and even then only as a salted SHA-256, never raw, as the key of a counter
// that covers 60 seconds (wrangler.jsonc); it is not logged or written
// anywhere. Workers Logs are disabled in wrangler.jsonc so the
// platform does not keep request metadata either.
//
// USAGE COUNTS: POST /api/quell/events, same Origin rule, rate limits and
// no-IP approach. Body = the payload documented in the extension's
// src/shared/analytics.js, validated strictly (anything else → 400). Stored:
// one row per (install id, UTC day) + per-(day, version, browser) aggregates.
// GET /api/quell/stats (READ_TOKEN) summarises them.
//
// READ (for the weekly rules work): GET /api/quell/reports?days=7 with
//   Authorization: Bearer <READ_TOKEN>  → aggregated JSON rows.

const MAX_BODY_BYTES = 512;
const MAX_EVENTS_BODY_BYTES = 6144;
const INSTALL_RETAIN_DAYS = 90;
const MAX_READ_DAYS = 90;
const RETAIN_DAYS = 180;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// Which hostnames a report may name. SAME RULE as the extension's
// src/shared/report-host.js, which decides whether the popup offers the
// button at all; the three constants below are verbatim copies and test.mjs
// fails if they drift. Public DNS names only: no IP literals, no localhost,
// no underscores, no private-network or special-use names.
const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);
const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.test', '.example', '.invalid', '.onion'];

// WHO may post (0.6.0 review #7, owner default: restrict). A report comes
// from Quell's own popup, so the browser sets Origin to the extension:
//   chrome-extension://<CHROME_EXTENSION_ID>  Chrome Web Store build
//   chrome-extension://<OPERA_EXTENSION_ID>   Opera Add-ons build. Opera signs
//                                             the package itself, so an Opera
//                                             install has a DIFFERENT id from
//                                             the CWS one. Empty until Opera
//                                             publishes and assigns it; empty
//                                             = not accepted.
//   moz-extension://<uuid>                    any Firefox install — Firefox
//                                             gives each install a random UUID
// Both ids are Worker vars (wrangler.jsonc), not code, so adding Opera at
// publish time is a config change with no redeploy of this file. Anything else — a web
// page, curl without an Origin, an unpacked dev build — gets 403. This stops
// casual cross-site abuse; it is not authentication (an Origin header can be
// forged outside a browser), which is why the rate limits stay.
const MOZ_ORIGIN_RE = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT_ID_RE = /^[a-p]{32}$/;

export function allowedOrigin(origin, env) {
  if (typeof origin !== 'string' || !origin) return false;
  if (MOZ_ORIGIN_RE.test(origin)) return true;
  for (const id of [env.CHROME_EXTENSION_ID, env.OPERA_EXTENSION_ID]) {
    if (typeof id === 'string' && EXT_ID_RE.test(id) && origin === `chrome-extension://${id}`) return true;
  }
  return false;
}

function cors(origin) {
  // Echo the one allowed origin, never '*'.
  return origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } : { Vary: 'Origin' };
}

function respond(status, body, extra = {}, origin = null) {
  const headers = { ...cors(origin), 'Cache-Control': 'no-store', ...extra };
  if (body === null) return new Response(null, { status, headers });
  headers['Content-Type'] = 'application/json';
  return new Response(JSON.stringify(body), { status, headers });
}

export function validHost(h) {
  if (typeof h !== 'string') return false;
  if (!HOST_RE.test(h)) return false;
  return !PRIVATE_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
}

export function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Two limiters: per client (salted hash of the IP — never the IP itself) and
// a global ceiling that bounds what any number of clients can write. A
// missing binding (local dev) allows the request.
async function rateLimited(request, env) {
  if (env.GLOBAL_LIMITER) {
    const g = await env.GLOBAL_LIMITER.limit({ key: 'all' });
    if (!g.success) return true;
  }
  if (env.CLIENT_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const key = await sha256Hex(`${env.RATE_SALT || 'quell-report'}|${ip}`);
    const c = await env.CLIENT_LIMITER.limit({ key });
    if (!c.success) return true;
  }
  return false;
}

async function handleReport(request, env) {
  const origin = request.headers.get('Origin');
  if (!allowedOrigin(origin, env)) return respond(403, { error: 'origin not allowed' });
  const r = (status, body, extra) => respond(status, body, extra, origin);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) return r(413, { error: 'too large' });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return r(413, { error: 'too large' });

  let data;
  try { data = JSON.parse(text); } catch (_) { return r(400, { error: 'not json' }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return r(400, { error: 'not an object' });
  // Exactly these two keys. Anything else is refused rather than dropped, so
  // a client that starts sending more cannot do so silently.
  const keys = Object.keys(data).sort().join(',');
  if (keys !== 'host,version') return r(400, { error: 'expected exactly {host, version}' });
  const host = String(data.host).toLowerCase();
  if (!validHost(host)) return r(400, { error: 'bad host' });
  if (typeof data.version !== 'string' || !VERSION_RE.test(data.version)) return r(400, { error: 'bad version' });

  if (await rateLimited(request, env)) return r(429, { error: 'slow down' }, { 'Retry-After': '60' });

  await env.DB.prepare(
    'INSERT INTO reports (day, host, version, count) VALUES (?1, ?2, ?3, 1) ' +
    'ON CONFLICT (day, host, version) DO UPDATE SET count = count + 1'
  ).bind(utcDay(), host, data.version).run();
  return r(204, null);
}

// ---------------------------------------------------------------- usage counts --
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BROWSERS = ['chrome', 'firefox', 'opera'];
const SWITCHES = ['enabled', 'ai', 'cookies', 'popups', 'engines', 'reject'];
const EVENT_NAMES = ['popup_open', 'peek', 'undo', 'pause', 'report_open', 'firstrun_turn_on', 'firstrun_skip'];
const FEATURES = ['ai', 'cookies', 'popups'];
const MAX_DAYS = 7;
const MAX_ERRORS = 10;
const MAX_MSG = 160;
const COUNT_MAX = 100000;
const FILE_EXT = /^(js|mjs|json|css|html|map|wasm)$/i;

// Same scrub as the extension's analytics.js: whatever slipped through is
// replaced, never stored.
export function scrubMessage(text) {
  let s = String(text);
  s = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>]*/gi, '<url>');
  s = s.replace(/\b(?:[a-z0-9-]+\.)+([a-z]{2,63})\b(?:[/:?#][^\s)'"<>]*)?/gi, (m, tld) => (FILE_EXT.test(tld) ? m : '<host>'));
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, MAX_MSG);
}

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const sameKeys = (o, keys) => Object.keys(o).sort().join() === [...keys].sort().join();
const isCount = (n) => Number.isInteger(n) && n >= 0 && n <= COUNT_MAX;
const isDay = (d, now) => {
  if (typeof d !== 'string' || !DAY_RE.test(d)) return false;
  const t = Date.parse(d + 'T00:00:00Z');
  if (!Number.isFinite(t) || utcDay(new Date(t)) !== d) return false;
  return d >= utcDay(new Date(now - (MAX_DAYS + 1) * 86400000)) && d <= utcDay(new Date(now + 86400000));
};

// Returns { error } or { value } with the normalised, scrubbed payload.
export function validateEvents(data, now = Date.now()) {
  if (!isObj(data)) return { error: 'not an object' };
  if (!sameKeys(data, ['v', 'id', 'version', 'browser', 'days'])) return { error: 'unexpected keys' };
  if (data.v !== 1) return { error: 'bad v' };
  if (typeof data.id !== 'string' || !UUID_RE.test(data.id)) return { error: 'bad id' };
  if (typeof data.version !== 'string' || !VERSION_RE.test(data.version)) return { error: 'bad version' };
  if (!BROWSERS.includes(data.browser)) return { error: 'bad browser' };
  if (!Array.isArray(data.days) || data.days.length < 1 || data.days.length > MAX_DAYS) return { error: 'bad days' };
  const seen = new Set();
  const days = [];
  for (const d of data.days) {
    if (!isObj(d) || !sameKeys(d, ['day', 'switches', 'events', 'hides', 'errors'])) return { error: 'bad day entry' };
    if (!isDay(d.day, now) || seen.has(d.day)) return { error: 'bad day' };
    seen.add(d.day);
    if (!isObj(d.switches) || !sameKeys(d.switches, SWITCHES) || !SWITCHES.every((k) => typeof d.switches[k] === 'boolean')) return { error: 'bad switches' };
    if (!isObj(d.events) || !Object.keys(d.events).every((k) => EVENT_NAMES.includes(k) && isCount(d.events[k]))) return { error: 'bad events' };
    if (!isObj(d.hides) || !Object.keys(d.hides).every((k) => FEATURES.includes(k) && isCount(d.hides[k]))) return { error: 'bad hides' };
    if (!Array.isArray(d.errors) || d.errors.length > MAX_ERRORS) return { error: 'bad errors' };
    const errors = [];
    for (const e of d.errors) {
      if (!isObj(e) || !sameKeys(e, ['m', 'f', 'n'])) return { error: 'bad error entry' };
      if (typeof e.m !== 'string' || !e.m || e.m.length > MAX_MSG) return { error: 'bad error message' };
      if (typeof e.f !== 'string' || !/^[\w.-]{1,64}$/.test(e.f)) return { error: 'bad error file' };
      if (!Number.isInteger(e.n) || e.n < 1 || e.n > 1000) return { error: 'bad error count' };
      errors.push({ m: scrubMessage(e.m), f: e.f, n: e.n });
    }
    days.push({
      day: d.day, switches: d.switches,
      events: d.events, hides: { ai: 0, cookies: 0, popups: 0, ...d.hides }, errors,
    });
  }
  return { value: { id: data.id, version: data.version, browser: data.browser, days } };
}

async function handleEvents(request, env) {
  const origin = request.headers.get('Origin');
  if (!allowedOrigin(origin, env)) return respond(403, { error: 'origin not allowed' });
  const r = (status, body, extra) => respond(status, body, extra, origin);
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_EVENTS_BODY_BYTES) return r(413, { error: 'too large' });
  const text = await request.text();
  if (text.length > MAX_EVENTS_BODY_BYTES) return r(413, { error: 'too large' });
  let data;
  try { data = JSON.parse(text); } catch (_) { return r(400, { error: 'not json' }); }
  const v = validateEvents(data);
  if (v.error) return r(400, { error: v.error });

  if (await rateLimited(request, env)) return r(429, { error: 'slow down' }, { 'Retry-After': '60' });

  const { id, version, browser } = v.value;
  for (const d of v.value.days) {
    // The per-install-day row is the idempotency key: a replayed day changes
    // nothing, so aggregates are never double counted.
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO quell_install_days (install_id, day, version, browser, sw_enabled, sw_ai, sw_cookies, sw_popups, sw_engines, sw_reject, ' +
      'hides_ai, hides_cookies, hides_popups, events_json, errors_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)'
    ).bind(id, d.day, version, browser,
      +d.switches.enabled, +d.switches.ai, +d.switches.cookies, +d.switches.popups, +d.switches.engines, +d.switches.reject,
      d.hides.ai, d.hides.cookies, d.hides.popups, JSON.stringify(d.events), JSON.stringify(d.errors)).run();
    if (!res || !res.meta || res.meta.changes !== 1) continue;
    await env.DB.prepare(
      'INSERT INTO quell_daily (day, version, browser, installs, sw_enabled, sw_ai, sw_cookies, sw_popups, sw_engines, sw_reject, hides_ai, hides_cookies, hides_popups) ' +
      'VALUES (?1,?2,?3,1,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT (day, version, browser) DO UPDATE SET ' +
      'installs = installs + 1, sw_enabled = sw_enabled + ?4, sw_ai = sw_ai + ?5, sw_cookies = sw_cookies + ?6, sw_popups = sw_popups + ?7, ' +
      'sw_engines = sw_engines + ?8, sw_reject = sw_reject + ?9, hides_ai = hides_ai + ?10, hides_cookies = hides_cookies + ?11, hides_popups = hides_popups + ?12'
    ).bind(d.day, version, browser, +d.switches.enabled, +d.switches.ai, +d.switches.cookies, +d.switches.popups,
      +d.switches.engines, +d.switches.reject, d.hides.ai, d.hides.cookies, d.hides.popups).run();
    for (const [name, n] of Object.entries(d.events)) {
      if (!n) continue;
      await env.DB.prepare(
        'INSERT INTO quell_events (day, version, browser, name, count) VALUES (?1,?2,?3,?4,?5) ' +
        'ON CONFLICT (day, version, browser, name) DO UPDATE SET count = count + ?5'
      ).bind(d.day, version, browser, name, n).run();
    }
    for (const e of d.errors) {
      await env.DB.prepare(
        'INSERT INTO quell_errors (day, version, browser, source, message, count) VALUES (?1,?2,?3,?4,?5,?6) ' +
        'ON CONFLICT (day, version, browser, source, message) DO UPDATE SET count = count + ?6'
      ).bind(d.day, version, browser, e.f, e.m, e.n).run();
    }
  }
  return r(204, null);
}

async function handleStats(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!sameToken(token, env.READ_TOKEN)) return respond(401, { error: 'unauthorized' });
  const days = Math.min(MAX_READ_DAYS, Math.max(1, parseInt(url.searchParams.get('days') || '14', 10) || 14));
  const since = utcDay(new Date(Date.now() - (days - 1) * 86400000));
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).all().then((x) => x.results || []);
  const [active, byBrowser, byVersion, adoption, events, errors, distinct] = await Promise.all([
    q('SELECT day, SUM(installs) AS installs FROM quell_daily WHERE day >= ?1 GROUP BY day ORDER BY day', since),
    q('SELECT browser, SUM(installs) AS install_days FROM quell_daily WHERE day >= ?1 GROUP BY browser ORDER BY browser', since),
    q('SELECT version, SUM(installs) AS install_days FROM quell_daily WHERE day >= ?1 GROUP BY version ORDER BY version', since),
    q('SELECT day, SUM(installs) AS installs, SUM(sw_enabled) AS enabled, SUM(sw_ai) AS ai, SUM(sw_cookies) AS cookies, SUM(sw_popups) AS popups, ' +
      'SUM(sw_engines) AS engines, SUM(sw_reject) AS reject, SUM(hides_ai) AS hides_ai, SUM(hides_cookies) AS hides_cookies, SUM(hides_popups) AS hides_popups ' +
      'FROM quell_daily WHERE day >= ?1 GROUP BY day ORDER BY day', since),
    q('SELECT name, SUM(count) AS count FROM quell_events WHERE day >= ?1 GROUP BY name ORDER BY count DESC, name', since),
    q('SELECT source, message, SUM(count) AS count FROM quell_errors WHERE day >= ?1 GROUP BY source, message ORDER BY count DESC LIMIT 50', since),
    q('SELECT COUNT(DISTINCT install_id) AS installs FROM quell_install_days WHERE day >= ?1', utcDay(new Date(Date.now() - 6 * 86400000))),
  ]);
  return respond(200, {
    since, days,
    active_installs_per_day: active,
    weekly_active_installs: distinct[0] ? distinct[0].installs : 0,
    by_browser: byBrowser, by_version: byVersion,
    // installs = installs active that day; the other columns = how many of
    // them had that switch on (adoption = column / installs), and hide counts.
    adoption_and_hides_per_day: adoption,
    events, errors,
  });
}

// Constant-time compare so the token cannot be recovered by timing.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function handleRead(request, env, url) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!sameToken(token, env.READ_TOKEN)) return respond(401, { error: 'unauthorized' });
  const days = Math.min(MAX_READ_DAYS, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  const since = utcDay(new Date(Date.now() - (days - 1) * 86400000));
  const { results } = await env.DB.prepare(
    'SELECT host, version, SUM(count) AS reports, MIN(day) AS first_day, MAX(day) AS last_day ' +
    'FROM reports WHERE day >= ?1 GROUP BY host, version ORDER BY reports DESC, host ASC LIMIT 1000'
  ).bind(since).all();
  return respond(200, { since, days, rows: results || [] });
}

export async function purgeOld(env, now = new Date()) {
  const cutoff = utcDay(new Date(now.getTime() - RETAIN_DAYS * 86400000));
  await env.DB.prepare('DELETE FROM reports WHERE day < ?1').bind(cutoff).run();
  for (const t of ['quell_daily', 'quell_events', 'quell_errors']) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE day < ?1`).bind(cutoff).run();
  }
  // Rows that carry an install id go sooner.
  const installCutoff = utcDay(new Date(now.getTime() - INSTALL_RETAIN_DAYS * 86400000));
  await env.DB.prepare('DELETE FROM quell_install_days WHERE day < ?1').bind(installCutoff).run();
  return cutoff;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      return allowedOrigin(origin, env) ? respond(204, null, {}, origin) : respond(403, null);
    }
    if (path.endsWith('/api/quell/report')) {
      if (request.method !== 'POST') return respond(405, { error: 'POST only' }, { Allow: 'POST, OPTIONS' });
      return handleReport(request, env);
    }
    if (path.endsWith('/api/quell/events')) {
      if (request.method !== 'POST') return respond(405, { error: 'POST only' }, { Allow: 'POST, OPTIONS' });
      return handleEvents(request, env);
    }
    if (path.endsWith('/api/quell/stats')) {
      if (request.method !== 'GET') return respond(405, { error: 'GET only' }, { Allow: 'GET' });
      return handleStats(request, env, url);
    }
    if (path.endsWith('/api/quell/reports')) {
      if (request.method !== 'GET') return respond(405, { error: 'GET only' }, { Allow: 'GET' });
      return handleRead(request, env, url);
    }
    return respond(404, { error: 'not found' });
  },
  async scheduled(_event, env) {
    await purgeOld(env);
  },
};
