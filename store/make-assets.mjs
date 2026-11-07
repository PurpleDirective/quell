// Quell — store asset generator (Chrome Web Store / Opera / AMO).
//
// Every product image here is a REAL render: the extension is loaded in
// Chromium; its own popup and welcome page are screenshotted, and the
// before/after search shot is the local Google fixture (tests/fixtures/
// google-results.html) loaded once with Quell off and once with Quell on, with
// the popup read from that same tab. The only things drawn are captions,
// labels and framing; no UI state is invented.
//
//   node store/make-assets.mjs [ext-dir]
//
// Needs tests/node_modules/playwright (tests/run.sh creates that link).

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(new URL('../tests/package.json', import.meta.url))('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.argv[2] || path.join(HERE, '..', 'extension'));
const OUT = path.join(HERE, 'assets');
mkdirSync(OUT, { recursive: true });
const FIXTURE = readFileSync(path.join(HERE, '..', 'tests', 'fixtures', 'google-results.html'), 'utf8');
const FONT64 = readFileSync(path.join(EXT, 'fonts', 'atkinson-hyperlegible-next-var.woff2')).toString('base64');

// ---------------------------------------------------------------- captures --
// Extensions load only in the full browser: new headless first, headed as the fallback.
async function launch() {
  for (const opts of [{ channel: 'chromium', headless: true }, { headless: true }, { headless: false }]) {
    const c = await chromium.launchPersistentContext('', {
      ...opts, deviceScaleFactor: 2, colorScheme: 'dark',
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    }).catch(() => null);
    if (!c) continue;
    let w = c.serviceWorkers()[0];
    if (!w) w = await c.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (w) return { ctx: c, sw: w };
    await c.close();
  }
  throw new Error('could not load the extension in Chromium');
}
const { ctx, sw } = await launch();
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 800));
for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close().catch(() => {});
const set = (o) => sw.evaluate((s) => QuellSettings.set(s), o);
const base = {
  enabled: true, aiEnabled: true, googleMode: 'hide', hideOverview: true, hideAiMode: true, hidePaa: false,
  hideGemini: true, bingEnabled: true, cookieEnabled: false, popupsEnabled: false,
  aiAllowlist: [], cookieAllowlist: [], popupAllowlist: [], sitePauses: {},
  firstRunDone: true, analytics: 'on', totalBlocked: 1284,
};

const gpage = await ctx.newPage();
await gpage.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: FIXTURE }));
const searchShot = async (enabled) => {
  await set({ ...base, enabled });
  await gpage.setViewportSize({ width: 1280, height: 1000 });
  await gpage.goto('https://www.google.com/search?q=how+long+to+boil+an+egg');
  await gpage.waitForTimeout(enabled ? 1200 : 600);
  return (await gpage.screenshot()).toString('base64');
};
const before = await searchShot(false);
const after = await searchShot(true);
await set(base);
await gpage.reload();
await gpage.waitForTimeout(1000);

// The toolbar popup, exactly as it opens over the Google tab (360 x 560).
async function popupShot(act) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 560 });
  await p.addInitScript(() => {
    const orig = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (q) => {
      if (!q || !q.active) return orig(q);
      const own = (await chrome.tabs.getCurrent())?.id;
      for (const t of await orig({})) {
        if (t.id === own) continue;
        try { await chrome.tabs.sendMessage(t.id, { type: 'where' }); return [t]; } catch (_) { /* next */ }
      }
      return [];
    };
  });
  await p.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await p.waitForTimeout(900);
  if (act) await act(p);
  const b64 = (await p.screenshot({ clip: { x: 0, y: 0, width: 360, height: 560 } })).toString('base64');
  const text = await p.evaluate(() => document.getElementById('pageStatus').textContent);
  await p.close();
  return { b64, w: 360, h: 560, text };
}
const popNormal = await popupShot();
const popPeek = await popupShot(async (p) => { await p.locator('.item', { hasText: 'AI Overview' }).locator('[data-peek]').click(); await p.waitForTimeout(400); });
console.log('popup headline:', popNormal.text);
await set({ ...base, aiAllowlist: ['www.google.com'], sitePauses: { 'www.google.com': { until: Date.now() + 3600e3, added: ['aiAllowlist'] } } });
await gpage.reload();
await gpage.waitForTimeout(800);
const popPaused = await popupShot();
await set(base);
await gpage.close();

// The welcome page's first-run card, with the three features above it.
await set({ ...base, firstRunDone: false, analytics: 'unset' });
const wp = await ctx.newPage();
await wp.setViewportSize({ width: 1100, height: 1000 });
await wp.emulateMedia({ colorScheme: 'dark' });
await wp.goto(`chrome-extension://${extId}/src/welcome/welcome.html`);
await wp.waitForTimeout(700);
const wbox = await wp.evaluate(() => {
  const a = document.querySelector('.fcs').getBoundingClientRect(), b = document.querySelector('.duo').getBoundingClientRect();
  return { x: a.left - 1, y: a.top - 1, width: a.width + 2, height: b.bottom - a.top + 2 };
});
const welcome = { b64: (await wp.screenshot({ clip: wbox })).toString('base64'), w: wbox.width, h: wbox.height };
await wp.close();
await set(base);
await ctx.close();

// ------------------------------------------------------------------ frames --
// The moon, drawn as the popup draws it.
const MOON = (size) => `<svg width="${size}" height="${Math.round(size * 1.1)}" viewBox="26 20 80 88" aria-hidden="true">
  <defs><radialGradient id="mg" cx=".28" cy=".3" r=".95"><stop offset="0" stop-color="#F7FAFC"/><stop offset=".55" stop-color="#CFE0EE"/><stop offset="1" stop-color="#8CA7BD"/></radialGradient>
  <radialGradient id="mterm" gradientUnits="userSpaceOnUse" cx="99" cy="64" r="50"><stop offset=".62" stop-color="#08121C" stop-opacity=".62"/><stop offset="1" stop-color="#08121C" stop-opacity="0"/></radialGradient>
  <clipPath id="mclip"><path d="M89.3 31.41A36 36 0 1 0 89.3 96.59A34 34 0 0 1 89.3 31.41Z"/></clipPath></defs>
  <path d="M89.3 31.41A36 36 0 1 0 89.3 96.59A34 34 0 0 1 89.3 31.41Z" fill="url(#mg)"/>
  <g clip-path="url(#mclip)"><circle cx="47" cy="50" r="4.2" fill="rgba(60,90,120,.26)" stroke="rgba(255,255,255,.22)" stroke-width=".6"/><circle cx="44" cy="72" r="5.8" fill="rgba(60,90,120,.24)" stroke="rgba(255,255,255,.2)" stroke-width=".6"/><circle cx="55" cy="87" r="3.2" fill="rgba(60,90,120,.26)"/><circle cx="53" cy="39" r="2.6" fill="rgba(60,90,120,.24)"/><circle cx="58" cy="62" r="2" fill="rgba(60,90,120,.22)"/><circle cx="62" cy="76" r="2.4" fill="rgba(60,90,120,.2)"/><rect x="26" y="20" width="80" height="88" fill="url(#mterm)"/></g>
  <path d="M89.3 31.41A36 36 0 1 0 89.3 96.59A34 34 0 0 1 89.3 31.41Z" fill="none" stroke="rgba(255,255,255,.5)" stroke-width=".7"/></svg>`;
const HALO = (size) => `<div style="position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:radial-gradient(circle,rgba(184,212,232,.28),rgba(184,212,232,.06) 50%,transparent 70%)"></div>`;

const BASE_CSS = `
  @font-face { font-family:'Atkinson Hyperlegible Next'; src:url(data:font/woff2;base64,${FONT64}) format('woff2'); font-weight:200 800; }
  * { margin:0; box-sizing:border-box; }
  body { overflow:hidden; font-family:'Atkinson Hyperlegible Next',system-ui,sans-serif; color:#EAF0F5; -webkit-font-smoothing:antialiased;
    background: radial-gradient(900px 520px at 50% -12%, rgba(184,212,232,.16), transparent 70%), linear-gradient(180deg,#131E2A,#0B121A); }
  h1 { font-weight:600; letter-spacing:-.025em; line-height:1.1; }
  .muted { color:#9FB0C0; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand b { font-weight:600; letter-spacing:-.01em; }
  .moonw { position:relative; display:grid; place-items:center; }
  .frame { position:relative; overflow:hidden; border-radius:14px; background:#fff; box-shadow:0 24px 64px rgba(0,0,0,.5), 0 0 0 1px rgba(184,212,232,.14); }
  .frame img { display:block; width:100%; }
  .pop { border-radius:14px; overflow:hidden; box-shadow:0 24px 64px rgba(0,0,0,.55), 0 0 0 1px rgba(184,212,232,.16); background:#0F1822; }
  .pop img { display:block; width:100%; }
  .label { font-size:15px; font-weight:600; color:#9FB0C0; margin-bottom:12px; letter-spacing:.01em; }
  .label.on { color:#B8D4E8; }
`;
const img = (b64) => `data:image/png;base64,${b64}`;
const popup = (s, w, extra = '') => `<div class="pop" style="width:${w}px;${extra}"><img src="${img(s.b64)}" alt=""></div>`;

const browser = await chromium.launch({ headless: true });
async function render(name, w, h, html) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForTimeout(300);
  writeFileSync(path.join(OUT, name), await page.screenshot());
  await page.close();
  console.log('wrote store/assets/' + name);
}
const shell = (css, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
const caption = (h, sub) => `<div class="cap"><h1>${h}</h1>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;
const CAPCSS = `body { width:1280px; height:800px; position:relative; }
  .cap { position:absolute; left:64px; top:52px; } .cap h1 { font-size:46px; } .cap p { font-size:20px; margin-top:12px; max-width:900px; }
  .mk { position:absolute; right:64px; top:56px; }`;
const MK = `<div class="mk brand"><b style="font-size:24px">Quell</b><div class="moonw">${HALO(90)}${MOON(34)}</div></div>`;

// 1 — the lead image: the same results page without and with Quell.
await render('screenshot-1-1280x800.png', 1280, 800, shell(CAPCSS + `
  .pane { position:absolute; top:196px; width:440px; }
  .pane .frame { height:490px; } .pane .frame img { width:640px; max-width:none; margin-left:-88px; margin-top:-8px; }
  .pop { position:absolute; left:960px; top:180px; }
`, `
  ${caption('Hide the AI answer. Keep the results.', 'The same search, without and with Quell.')}
  ${MK}
  <div class="pane" style="left:64px"><div class="label">Without Quell</div><div class="frame"><img src="${img(before)}" alt=""></div></div>
  <div class="pane" style="left:532px"><div class="label on">With Quell</div><div class="frame"><img src="${img(after)}" alt=""></div></div>
  ${popup(popNormal, 256)}
`));

// 2 — see what was hidden; pause a site.
await render('screenshot-2-1280x800.png', 1280, 800, shell(CAPCSS + `
  .pops { position:absolute; left:0; right:0; top:178px; display:flex; justify-content:center; gap:48px; }
`, `
  ${caption('See what Quell hid. Bring it back in one click.', 'Peek at it, undo it, or pause Quell on a site for an hour.')}
  ${MK}
  <div class="pops">
    <div><div class="label">Peek or Undo, per item</div>${popup(popPeek, 360)}</div>
    <div><div class="label">Pause on this site</div>${popup(popPaused, 360)}</div>
  </div>
`));

// 3 — cookie banners and pop-ups.
await render('screenshot-3-1280x800.png', 1280, 800, shell(CAPCSS + `
  .wel { position:absolute; left:140px; top:200px; width:1000px; }
`, `
  ${caption('Cookie banners and pop-ups, quietly gone.', 'Off until you turn them on. Quell asks your browser once, and gives the access back when both are off.')}
  ${MK}
  <div class="wel"><div class="frame" style="background:#0F1822"><img src="${img(welcome.b64)}" alt=""></div></div>
`));

// Small promo tile and marquee: the moon and one line.
await render('tile-small-440x280.png', 440, 280, shell(`
  body { width:440px; height:280px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
  .moonw { margin-bottom:22px; } h1 { font-size:30px; } p { font-size:15px; margin-top:8px; }
`, `<div class="moonw">${HALO(150)}${MOON(64)}</div><h1>Quell — Quiet the web.</h1><p class="muted">Hide the AI answer. Keep the results.</p>`));

await render('marquee-1400x560.png', 1400, 560, shell(`
  body { width:1400px; height:560px; display:flex; align-items:center; }
  .txt { flex:1; padding-left:120px; } .txt .moonw { width:fit-content; margin-bottom:28px; }
  h1 { font-size:58px; } p { font-size:22px; margin-top:16px; }
  .right { width:540px; display:flex; justify-content:center; padding-right:60px; }
`, `<div class="txt"><div class="moonw">${HALO(130)}${MOON(56)}</div><h1>Quell — Quiet the web.</h1><p class="muted">Hide the AI answer. Keep the results.</p></div>
  <div class="right">${popup(popNormal, 330)}</div>`));

await browser.close();
console.log('done');
