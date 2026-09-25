// Quell — store asset generator (Chrome Web Store / Edge / AMO).
//
// Every product image here is a REAL render: the extension is loaded in
// Chromium and its own popup and welcome page are screenshotted, then framed.
// The only things drawn on top are the captions and a highlight ring placed
// from the rendered element's own box. No UI state is invented: the popup is
// shown in states the extension can actually be in.
//
//   node store/make-assets.mjs [ext-dir]
//
// ext-dir defaults to extension/. The popup is shown in its first-run state
// (Search on, Cookie banners and Pop-ups off until the user asks for them).
// Optional before/after search shots: QUELL_BEFORE / QUELL_AFTER (1280x800 PNGs
// from the live run) add screenshot-4.
//
// Needs tests/node_modules/playwright (tests/run.sh creates that link).

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = createRequire(new URL('../tests/package.json', import.meta.url))('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(process.argv[2] || path.join(HERE, '..', 'extension'));
const OUT = path.join(HERE, 'assets');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- captures --
// channel 'chromium' = the full browser in new-headless mode; the default
// headless shell cannot load extensions.
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  deviceScaleFactor: 2,
  colorScheme: 'light',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;
await new Promise((r) => setTimeout(r, 800));
for (const p of ctx.pages()) if (p.url().includes('welcome')) await p.close().catch(() => {});

// The popup's own page view (?view=page) at the popup's 340px width: the same
// controls, minus the "on this page" line, which a tab has no page for.
// `section` = [topSelector, bottomSelector]: capture only that slice of the
// real render (for a close-up), still a straight screenshot of the page.
async function popupShot(settings, ringId, section) {
  await sw.evaluate((s) => QuellSettings.set(s), settings);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 388, height: 1200 });
  await p.goto(`chrome-extension://${extId}/src/popup/popup.html?view=page`);
  await p.waitForTimeout(500);
  const body = await p.$('body');
  let box = await body.boundingBox();
  if (section) {
    const [a, b] = await Promise.all(section.map((sel) => p.$eval(sel, (el) => {
      const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom };
    })));
    box = { x: box.x + 1, y: a.top + 1, width: box.width - 2, height: b.bottom - a.top + 8 };
  }
  let ring = null;
  if (ringId) {
    const r = await p.$eval(`#${ringId}`, (el) => {
      const row = el.closest('.row') || el;
      const b = row.getBoundingClientRect();
      return { x: b.x, y: b.y, w: b.width, h: b.height };
    });
    ring = { x: r.x - box.x, y: r.y - box.y, w: r.w, h: r.h };
  }
  const buf = section ? await p.screenshot({ clip: box }) : await body.screenshot();
  await p.close();
  return { b64: buf.toString('base64'), w: box.width, h: box.height, ring };
}

async function welcomeShot() {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 720, height: 1100 });
  await p.goto(`chrome-extension://${extId}/src/welcome/welcome.html`);
  await p.waitForTimeout(500);
  const wrap = await p.$('.wrap');
  const buf = await wrap.screenshot();
  const box = await wrap.boundingBox();
  await p.close();
  return { b64: buf.toString('base64'), w: box.width, h: box.height };
}

const defaults = {
  enabled: true, aiEnabled: true, googleMode: 'hide', hideOverview: true, hideAiMode: true,
  hidePaa: false, hideGemini: true, bingEnabled: true,
  cookieEnabled: false, popupsEnabled: false,
};
const popDefault = await popupShot(defaults, null);
const popPaa = await popupShot(defaults, 'sPaa', ['.grp:has(#aiEnabled)', '.row:has(#bing)']);
await sw.evaluate((s) => QuellSettings.set(s), defaults);
const welcome = await welcomeShot();
await ctx.close();

// ------------------------------------------------------------------ frames --
const CRESCENT = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs><linearGradient id="qg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7C3AED"/><stop offset="1" stop-color="#4C1D95"/></linearGradient>
  <mask id="qm"><rect width="128" height="128" fill="#000"/><circle cx="74" cy="64" r="36" fill="#fff"/><circle cx="99" cy="64" r="34" fill="#000"/></mask></defs>
  <rect width="128" height="128" rx="28" fill="url(#qg)"/><circle cx="74" cy="64" r="36" fill="#fff" mask="url(#qm)"/></svg>`;

const BASE_CSS = `
  * { margin:0; box-sizing:border-box; }
  body { overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
    color:#fff; -webkit-font-smoothing:antialiased;
    background:
      radial-gradient(900px 620px at 88% -12%, rgba(124,58,237,.50), transparent 62%),
      radial-gradient(760px 520px at -8% 112%, rgba(91,33,182,.55), transparent 60%),
      linear-gradient(140deg,#2e1065 0%,#1f1837 52%,#161225 100%); }
  .brand { display:flex; align-items:center; gap:12px; }
  .brand b { font-weight:800; letter-spacing:-.015em; }
  .kicker { color:#c4b5fd; font-weight:600; letter-spacing:.02em; }
  h1 { font-weight:800; letter-spacing:-.022em; line-height:1.06; }
  p.sub { color:#d6cff2; line-height:1.5; }
  .card { position:relative; border-radius:18px; overflow:hidden; background:#fff;
    box-shadow:0 34px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.10); }
  .card img { display:block; width:100%; }
  .ring { position:absolute; border:3px solid #a78bfa; border-radius:12px;
    box-shadow:0 0 0 6px rgba(167,139,250,.28); pointer-events:none; }
`;

function shotCard(s, width, extra = '') {
  const scale = width / s.w;
  const ring = s.ring ? `<div class="ring" style="left:${s.ring.x * scale - 6}px;top:${s.ring.y * scale - 5}px;width:${s.ring.w * scale + 12}px;height:${s.ring.h * scale + 10}px"></div>` : '';
  return `<div class="card" style="width:${width}px${extra}"><img src="data:image/png;base64,${s.b64}" alt="">${ring}</div>`;
}

// A 1280x800 screenshot: caption left, real render right (cropped to fit).
function screenshotPage({ kicker, headline, sub, right }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width:1280px; height:800px; display:flex; align-items:center; }
    .txt { flex:1; padding:0 40px 0 88px; }
    .brand { margin-bottom:40px; } .brand b { font-size:30px; }
    .kicker { font-size:17px; margin-bottom:14px; text-transform:uppercase; }
    h1 { font-size:58px; margin-bottom:24px; max-width:560px; }
    p.sub { font-size:21px; max-width:520px; }
    .right { flex:none; width:560px; height:800px; display:flex; align-items:flex-start; justify-content:center; padding-top:64px; overflow:hidden; }
  </style></head><body>
    <div class="txt">
      <div class="brand">${CRESCENT(52)}<b>Quell</b></div>
      ${kicker ? `<div class="kicker">${kicker}</div>` : ''}
      <h1>${headline}</h1>
      <p class="sub">${sub}</p>
    </div>
    <div class="right">${right}</div>
  </body></html>`;
}

// Chromium renders these pages; one fixed-size, 1x viewport per image.
const browser = await chromium.launch({ headless: true });
async function render(name, w, h, html) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.setContent(html);
  await page.waitForTimeout(300);
  writeFileSync(path.join(OUT, name), await page.screenshot());
  await page.close();
  console.log('wrote store/assets/' + name);
}

// 1 — the promise.
await render('screenshot-1-1280x800.png', 1280, 800, screenshotPage({
  kicker: 'Google · Bing · DuckDuckGo · Brave · Yahoo',
  headline: 'Hide the AI you didn’t ask for.',
  sub: 'AI Overviews, AI Mode, Gemini promos and Bing Copilot — gone. Every real search result stays, and every release is tested to prove it.',
  right: shotCard(popDefault, 380),
}));

// 2 — the differentiator: clicked-open People-also-ask answers are kept.
await render('screenshot-2-1280x800.png', 1280, 800, screenshotPage({
  kicker: 'Only Quell tells them apart',
  headline: 'Keep the answers you open.',
  sub: 'Open a “People also ask” question and the answer stays — you asked for that one. The AI Overview you didn’t ask for is still hidden. Your call, one switch.',
  right: shotCard(popPaa, 500, ';margin-top:130px'),
}));

// 3 — first run: plain words, nothing on until you say so.
await render('screenshot-3-1280x800.png', 1280, 800, screenshotPage({
  kicker: 'Cookie banners & pop-ups — when you want',
  headline: 'Quiet, on your terms.',
  sub: 'Cookie banners and pop-ups stay off until you switch them on. Quell only asks for access to all sites then — and gives it back when you switch them off.',
  right: shotCard(welcome, 500),
}));

// 4 — optional: a real before/after from the live verification run.
const B = process.env.QUELL_BEFORE, A = process.env.QUELL_AFTER;
if (B && A && existsSync(B) && existsSync(A)) {
  const img = (f) => readFileSync(f).toString('base64');
  const label = process.env.QUELL_BA_LABEL || 'Same search, same results';
  const cropTop = Number(process.env.QUELL_BA_CROP || 0);
  await render('screenshot-4-1280x800.png', 1280, 800, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
    body { width:1280px; height:800px; padding:44px 56px; }
    .top { display:flex; align-items:center; justify-content:space-between; margin-bottom:26px; }
    .brand b { font-size:24px; }
    h1 { font-size:40px; }
    .pair { display:flex; gap:28px; }
    .pane { flex:1; }
    .tag { font-size:16px; font-weight:700; margin-bottom:10px; color:#c4b5fd; letter-spacing:.03em; text-transform:uppercase; }
    .shot { height:590px; border-radius:14px; overflow:hidden; background:#fff; box-shadow:0 24px 70px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.1); }
    .shot img { width:100%; display:block; margin-top:-${cropTop}px; }
  </style></head><body>
    <div class="top"><h1>${label}</h1><div class="brand">${CRESCENT(40)}<b>Quell</b></div></div>
    <div class="pair">
      <div class="pane"><div class="tag">Without Quell</div><div class="shot"><img src="data:image/png;base64,${img(B)}"></div></div>
      <div class="pane"><div class="tag">With Quell</div><div class="shot"><img src="data:image/png;base64,${img(A)}"></div></div>
    </div>
  </body></html>`);
}

// Small promo tile.
await render('tile-small-440x280.png', 440, 280, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width:440px; height:280px; padding:34px 34px; display:flex; flex-direction:column; justify-content:center; }
  .brand { margin-bottom:22px; } .brand b { font-size:34px; }
  h1 { font-size:31px; margin-bottom:10px; }
  p.sub { font-size:15px; }
</style></head><body>
  <div class="brand">${CRESCENT(54)}<b>Quell</b></div>
  <h1>Quiet the web.</h1>
  <p class="sub">Hide the AI you didn’t ask for.</p>
</body></html>`);

// Marquee promo tile.
await render('marquee-1400x560.png', 1400, 560, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
  body { width:1400px; height:560px; display:flex; align-items:center; }
  .txt { flex:1; padding-left:96px; }
  .brand { margin-bottom:30px; } .brand b { font-size:34px; }
  h1 { font-size:60px; margin-bottom:14px; }
  h1 + h1 { color:#c4b5fd; }
  p.sub { font-size:20px; margin-top:18px; max-width:600px; }
  .right { flex:none; width:520px; height:560px; overflow:hidden; display:flex; justify-content:center; padding-top:52px; }
</style></head><body>
  <div class="txt">
    <div class="brand">${CRESCENT(58)}<b>Quell</b></div>
    <h1>Hide the AI you didn’t ask for.</h1>
    <h1>Keep the answers you open.</h1>
    <p class="sub">Free, open source, no tracking. Chrome, Edge and Firefox.</p>
  </div>
  <div class="right">${shotCard(popDefault, 360)}</div>
</body></html>`);

await browser.close();
console.log('done');
