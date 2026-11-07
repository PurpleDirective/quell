// Quell — Links group (0.7.4): the tracking-parameter ruleset, the page-side cleaner
// that must agree with it, and the affiliate-swap decision. Executed, no browser.
//   node tests/links.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ FAIL ${n}`); } };

const rules = JSON.parse(readFileSync(path.join(EXT, 'rules/links-clean.json'), 'utf8'));
const strip = rules.filter((r) => r.action.redirect?.transform?.queryTransform?.removeParams);
const generic = strip.filter((r) => !r.condition.requestDomains);
const yt = strip.filter((r) => r.condition.requestDomains);
const unwrapRules = rules.filter((r) => r.action.redirect?.regexSubstitution);
const PARAMS = generic[0].action.redirect.transform.queryTransform.removeParams;

// The affiliate and page-changing parameters the list must never contain (pipeline/build_rules.py
// LINK_PROTECTED_PARAMS, restated so a bad edit to both at once still fails here).
const PROTECTED = ['tag', 'ascsubtag', 'linkCode', 'linkId', 'aff_id', 'aff', 'affiliate', 'affiliate_id', 'ref', 'ref_', 'referrer', 'partner',
  'partner_id', 'camp', 'creative', 'creativeASIN', 'q', 'query', 's', 'p', 'page', 'id', 'v', 't', 'list', 'u', 'url', 'k', 'search', 'si'];

console.log('Links ruleset (rules/links-clean.json):');
ok(rules.length >= 3 && rules.length < 50, `a handful of static rules (${rules.length}), far under the unsafe-rule limit (5000) and the regex-rule limit (1000)`);
ok(rules.every((r) => r.action.type === 'redirect') && rules.every((r) => (r.condition.resourceTypes || []).join() === 'main_frame'), 'every rule is a redirect on the main frame only (no sub-resource is ever rewritten)');
ok(new Set(rules.map((r) => r.id)).size === rules.length, 'rule ids are unique');
ok(rules.every((r) => (r.condition.regexFilter || '').length > 0 && r.condition.regexFilter.length < 1500), 'every regexFilter is present and short enough for the 2 KB regex limit');
ok(PARAMS.length >= 40, `the tracking list covers the named parameters (${PARAMS.length})`);
for (const must of ['fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'mc_eid', 'mc_cid', 'igshid', '_hsenc', '_hsmi', 'yclid', 'twclid', 'ttclid', 'li_fat_id', 'vero_id', 'oly_anon_id', 'oly_enc_id', 'rb_clickid', 's_cid', 'ref_src', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
  ok(PARAMS.includes(must), `the list removes ${must}`);
}
ok(PROTECTED.filter((p) => PARAMS.includes(p)).length === 0, `no affiliate or page-changing parameter is on the list (${PROTECTED.filter((p) => PARAMS.includes(p)).join() || 'none'})`);
ok(generic.every((r) => JSON.stringify(r.action.redirect.transform.queryTransform.removeParams) === JSON.stringify(PARAMS)), 'every general rule carries the same full list (one hop clears everything)');
ok(yt.length === 1 && JSON.stringify(yt[0].action.redirect.transform.queryTransform.removeParams) === '["si"]' && JSON.stringify(yt[0].condition.requestDomains) === '["youtube.com","youtu.be"]', '`si` is removed on YouTube hosts only');
ok(!PARAMS.includes('si'), '`si` is not in the general list');

// A tiny emulation of what Chrome does with these rules: the first matching rule applies.
function dnr(url) {
  const u = new URL(url);
  for (const r of [...unwrapRules, ...strip]) {
    const c = r.condition;
    if (c.requestDomains && !c.requestDomains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d))) continue;
    const m = new RegExp(c.regexFilter).exec(url);
    if (!m) continue;
    if (r.action.redirect.regexSubstitution) return r.action.redirect.regexSubstitution.replace('\\1', m[1]);
    const drop = new Set(r.action.redirect.transform.queryTransform.removeParams);
    const keep = u.search.slice(1).split('&').filter((p) => !drop.has(p.split('=')[0]));
    const next = new URL(url); next.search = keep.length ? '?' + keep.join('&') : '';
    return next.href;
  }
  return null; // no redirect
}

const CASES = [
  ['https://example.com/a?utm_source=news&utm_medium=email&id=7', 'https://example.com/a?id=7'],
  ['https://example.com/a?id=7&fbclid=IwAR123', 'https://example.com/a?id=7'],
  ['https://example.com/?gclid=abc&q=eggs&page=2', 'https://example.com/?q=eggs&page=2'],
  ['https://example.com/?utm_campaign=x', 'https://example.com/'],
  ['https://example.com/p?mc_eid=1&mc_cid=2&_hsenc=3&_hsmi=4', 'https://example.com/p'],
  ['https://www.instagram.com/p/abc/?igshid=xyz', 'https://www.instagram.com/p/abc/'],
  ['https://x.test/?msclkid=1&ttclid=2&twclid=3&yclid=4&dclid=5&gbraid=6&wbraid=7', 'https://x.test/'],
  ['https://x.test/?li_fat_id=1&vero_id=2&oly_anon_id=3&oly_enc_id=4&rb_clickid=5&s_cid=6&ref_src=twsrc', 'https://x.test/'],
  ['https://www.youtube.com/watch?v=abc123&si=SHARE', 'https://www.youtube.com/watch?v=abc123'],
  ['https://youtu.be/abc123?si=SHARE&t=30', 'https://youtu.be/abc123?t=30'],
  // Never changed:
  ['https://example.com/a?si=keepme', null],
  ['https://www.amazon.com/dp/B000?tag=blog-20&linkCode=ur2', null],
  ['https://www.amazon.com/dp/B000?tag=blog-20&utm_source=x', 'https://www.amazon.com/dp/B000?tag=blog-20'],
  ['https://shop.test/?aff_id=77&affiliate=me&ref=partner&ascsubtag=z', null],
  ['https://example.com/search?q=utm_source&page=3&id=9&v=1&t=5', null],
  ['https://example.com/a?xutm_source=1', null],
  ['https://example.com/a', null],
  ['https://example.com/a?utm_source', null],
  // Google's redirect step, only for an address with no percent-escapes:
  ['https://www.google.com/url?sa=t&q=https://example.com/a/b&ved=1', 'https://example.com/a/b'],
  ['https://www.google.co.uk/url?q=https://example.com/&sa=U', 'https://example.com/'],
  ['https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&sa=U', null],
];
console.log('Ruleset behaviour (emulated first-match):');
for (const [from, want] of CASES) ok(dnr(from) === want, `${from.slice(0, 80)} -> ${want === null ? '(untouched)' : want.slice(0, 60)}`);
// A redirect to an unchanged address must never be possible (no loop): every rule's regex needs a listed parameter.
ok(strip.every((r) => { const r0 = new RegExp(r.condition.regexFilter); return PARAMS.some((p) => r0.test(`https://x.test/?${p}=1`)) || r.condition.requestDomains; }), 'a rule fires only when a listed parameter is present (no redirect to the same address)');

console.log('Page cleaner (src/content/links.js) agrees with the ruleset:');
const sandbox = { setTimeout, clearTimeout, URL, URLSearchParams, TextDecoder, atob, Uint8Array, location: { href: 'https://example.com/', hostname: 'example.com' },
  MutationObserver: class { observe() {} disconnect() {} }, chrome: { runtime: { onMessage: { addListener() {} }, id: 'x' } } };
sandbox.window = sandbox;
sandbox.document = { body: {}, documentElement: {}, addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] };
vm.createContext(sandbox);
const linksSrc = readFileSync(path.join(EXT, 'src/content/links.js'), 'utf8');
vm.runInContext(linksSrc, sandbox, { filename: 'links.js' });
await new Promise((r) => setTimeout(r, 20));
const clean = sandbox.__quellLinksClean;
ok(typeof clean === 'function', 'links.js exposes its pure cleaner for the test');
const jsList = [...linksSrc.match(/const TRACKING = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
ok(JSON.stringify(jsList) === JSON.stringify(PARAMS), 'links.js tracking list == the generated ruleset list (same names, same order)');
for (const [from, want] of CASES) {
  if (from.includes('%2F')) continue; // the page script handles escaped Google addresses (below)
  if (from.endsWith('?utm_source')) continue; // a bare name with no value: only the page script drops it (harmless)
  ok((clean(from) ?? null) === want, `page: ${from.slice(0, 80)}`);
}
ok(clean('https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1%26utm_source%3Dx&sa=U') === 'https://example.com/a?b=1', 'page: an escaped Google redirect is decoded, then cleaned');
const b64 = Buffer.from('https://example.com/page?x=1&utm_medium=a').toString('base64url');
ok(clean(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`) === 'https://example.com/page?x=1', 'page: a Bing ck/a redirect is decoded to the site, then cleaned');
ok(clean('https://www.bing.com/ck/a?u=a1bm90IGEgdXJs') === null && clean('https://www.bing.com/ck/a?u=zzz') === null, 'page: an undecodable Bing link is left alone');
ok(clean('https://www.google.com/url?q=javascript:alert(1)') === null, 'page: a non-web address inside a redirect is never followed');
ok(clean('mailto:a@b.c?utm_source=x') === null && clean('javascript:void(0)') === null, 'page: mailto: and javascript: links are untouched');
ok(clean('https://example.com/?q=a%20b&utm_source=x&z=%C3%A9') === 'https://example.com/?q=a%20b&z=%C3%A9', 'page: kept parameters stay byte-for-byte (escapes preserved)');

console.log('Affiliate-swap decision (src/shared/affiliate.js):');
const asb = { URL, URLSearchParams, setTimeout, console };
asb.globalThis = asb; vm.createContext(asb);
vm.runInContext(readFileSync(path.join(EXT, 'src/shared/affiliate.js'), 'utf8'), asb, { filename: 'affiliate.js' });
const A = asb.QuellAffiliate;
const prev = { page: true, tag: 'blog-20' };
const redir = (url, extra = {}) => A.decide(prev, { url, type: 'link', qualifiers: ['client_redirect'], ...extra });
ok(redir('https://www.amazon.com/dp/B000?tag=other-21').warn === true, 'tag replaced by a client redirect: warns');
ok(redir('https://www.amazon.com/dp/B000?tag=other-21', { qualifiers: ['server_redirect'] }).warn === true, 'tag replaced by a server redirect: warns');
ok(A.decide({ page: true, tag: '' }, { url: 'https://www.amazon.co.uk/gp/cart/view.html?tag=x-21', type: 'link', qualifiers: ['client_redirect'] }).warn === true, 'a tag ADDED on a cart page by a redirect: warns');
ok(A.decide(prev, { url: 'https://www.amazon.com/dp/B000?tag=other-21', type: 'link', qualifiers: [] }).warn === false, 'signal 1 alone (tag changed on an ordinary link click): no warning');
ok(redir('https://www.amazon.com/dp/B000?tag=blog-20').warn === false, 'signal 2 alone (redirect, same tag): no warning');
ok(redir('https://www.amazon.com/dp/B000').warn === false, 'a redirect that drops the tag: no warning (only replacing or adding)');
ok(A.decide(null, { url: 'https://www.amazon.com/dp/B000?tag=other-21', type: 'link', qualifiers: ['server_redirect'] }).warn === false, 'arriving from outside Amazon through an affiliate redirect: no warning (no earlier Amazon page)');
ok(A.decide({ page: false, tag: 'a' }, { url: 'https://www.amazon.com/dp/B000?tag=b', type: 'link', qualifiers: ['server_redirect'] }).warn === false, 'earlier page was not a product or cart page: no warning');
for (const type of ['typed', 'auto_bookmark', 'form_submit', 'reload', 'generated']) {
  ok(redir('https://www.amazon.com/dp/B000?tag=other-21', { type }).warn === false, `a ${type} navigation is the user's: no warning`);
}
ok(redir('https://www.amazon.com/dp/B000?tag=other-21', { qualifiers: ['client_redirect', 'from_address_bar'] }).warn === false, 'from the address bar: no warning');
ok(redir('https://www.amazon.com/dp/B000?tag=other-21', { qualifiers: ['client_redirect', 'forward_back'] }).warn === false, 'back/forward: no warning');
ok(redir('https://www.amazon.com/s?k=eggs&tag=other-21').warn === false, 'a search page is not a product or cart page: no warning');
ok(redir('https://www.example.com/dp/B000?tag=other-21').warn === false, 'a look-alike host is not Amazon: no warning');
ok(redir('https://www.amazon.evil.com/dp/B000?tag=other-21').warn === false && redir('https://amazon.com.evil.test/dp/B1?tag=x').warn === false, 'hosts that only contain "amazon" are not Amazon');
const src = readFileSync(path.join(EXT, 'src/shared/affiliate.js'), 'utf8');
ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/.test(src), 'nothing in affiliate.js can send anything anywhere');
ok(!/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/.test(linksSrc), 'nothing in links.js can send anything anywhere');
const mf = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
ok(!(mf.permissions || []).includes('webNavigation') && (mf.optional_permissions || []).join() === 'webNavigation', 'webNavigation is an OPTIONAL permission, never required');
ok((mf.optional_host_permissions || []).includes('<all_urls>') && !(mf.host_permissions || []).includes('<all_urls>'), '<all_urls> stays optional');

// Event flow against a fake webNavigation: two signals, shown once, nothing without the switch.
console.log('Affiliate-swap event flow:');
function boot() {
  const store = {}; const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), fire: async (...a) => { for (const f of ls) await f(...a); } }; };
  const scripts = []; const settings = { enabled: true, linksEnabled: true, linksWarnAffiliate: true };
  const chrome = {
    storage: { session: { get: async (k) => (typeof k === 'string' ? (k in store ? { [k]: store[k] } : {}) : k === null ? { ...store } : {}), set: async (o) => Object.assign(store, o), remove: async (k) => { for (const x of [].concat(k)) delete store[x]; } } },
    webNavigation: { onCommitted: ev(), onHistoryStateUpdated: ev(), onCompleted: ev() },
    tabs: { onUpdated: ev(), onRemoved: ev() },
    scripting: { executeScript: async (o) => { scripts.push(o); } },
  };
  const sb = { chrome, URL, URLSearchParams, setTimeout, console, QuellSettings: { get: async () => ({ ...settings }) } };
  sb.globalThis = sb; vm.createContext(sb);
  vm.runInContext(src, sb);
  return { chrome, scripts, settings, store, A: sb.QuellAffiliate };
}
const nav = (h, d) => h.chrome.webNavigation.onCommitted.fire({ frameId: 0, tabId: 5, ...d });
const done = (h) => h.chrome.webNavigation.onCompleted.fire({ frameId: 0, tabId: 5 });
{
  const h = boot();
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=blog-20', transitionType: 'link', transitionQualifiers: [] });
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=thief-20', transitionType: 'link', transitionQualifiers: ['client_redirect'] });
  await done(h);
  ok(h.scripts.length === 1 && typeof h.scripts[0].func === 'function' && h.scripts[0].target.tabId === 5, 'tag swapped by a redirect: the notice is put into that tab, once the page has loaded');
  await done(h);
  ok(h.scripts.length === 1, 'and not again for the same swap');
}
{
  const h = boot();
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=blog-20', transitionType: 'link', transitionQualifiers: [] });
  await nav(h, { url: 'https://www.amazon.com/dp/B111?tag=other-20', transitionType: 'link', transitionQualifiers: [] });
  await done(h);
  ok(h.scripts.length === 0, 'two product pages with different tags, reached by clicks: no notice');
}
{
  const h = boot();
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=blog-20', transitionType: 'link', transitionQualifiers: [] });
  await h.chrome.tabs.onUpdated.fire(5, { url: 'https://blog.example/post' });
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=other-20', transitionType: 'link', transitionQualifiers: ['server_redirect'] });
  await done(h);
  ok(h.scripts.length === 0, 'a trip through another site and an affiliate redirect back is a new visit: no notice');
}
{
  const h = boot(); h.settings.linksWarnAffiliate = false;
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=blog-20', transitionType: 'link', transitionQualifiers: [] });
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=thief-20', transitionType: 'link', transitionQualifiers: ['client_redirect'] });
  await done(h);
  ok(h.scripts.length === 0 && Object.keys(h.store).length === 0, 'switch off: no notice and nothing is even remembered');
}
{
  const h = boot();
  await nav(h, { url: 'https://www.amazon.com/dp/B000?tag=blog-20', transitionType: 'link', transitionQualifiers: [] });
  await h.A.sync(false);
  ok(Object.keys(h.store).length === 0, 'turning the switch off forgets the remembered tags');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
