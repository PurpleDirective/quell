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
// READ (for the weekly rules work): GET /api/quell/reports?days=7 with
//   Authorization: Bearer <READ_TOKEN>  → aggregated JSON rows.

const MAX_BODY_BYTES = 512;
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
//   chrome-extension://<CHROME_EXTENSION_ID>  Chrome Web Store build (also
//                                             what Edge users get from the CWS)
//   chrome-extension://<EDGE_EXTENSION_ID>    Edge Add-ons build, once known
//                                             (empty = unknown = not accepted)
//   moz-extension://<uuid>                    any Firefox install — Firefox
//                                             gives each install a random UUID
// Both ids are Worker vars (wrangler.jsonc), not code. Anything else — a web
// page, curl without an Origin, an unpacked dev build — gets 403. This stops
// casual cross-site abuse; it is not authentication (an Origin header can be
// forged outside a browser), which is why the rate limits stay.
const MOZ_ORIGIN_RE = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT_ID_RE = /^[a-p]{32}$/;

export function allowedOrigin(origin, env) {
  if (typeof origin !== 'string' || !origin) return false;
  if (MOZ_ORIGIN_RE.test(origin)) return true;
  for (const id of [env.CHROME_EXTENSION_ID, env.EDGE_EXTENSION_ID]) {
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
