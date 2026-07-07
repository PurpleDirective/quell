// Quell — Chrome Web Store asset generator.
// Screenshots the REAL popup (extension loaded in Chromium) and composes the
// store images. Run via tests/run.sh's node_modules link:
//   cd tests && ./run.sh >/dev/null 2>&1 || true && cd ../store && NODE_PATH=../tests/node_modules node make-assets.mjs
// or simply:  node --experimental-vm-modules store/make-assets.mjs  (after tests/run.sh once)

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', 'extension');
const OUT = path.join(HERE, 'assets');
mkdirSync(OUT, { recursive: true });

async function getContext() {
  for (const headless of [true, false]) {
    const c = await chromium.launchPersistentContext('', {
      headless,
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
const { ctx, sw } = await getContext();
const extId = new URL(sw.url()).host;
const icon = readFileSync(path.join(EXT, 'icons/icon128.png')).toString('base64');

async function popupShot(seed) {
  await sw.evaluate((s) => chrome.storage.local.set(s), seed);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 320, height: 620 });
  await p.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await p.waitForTimeout(400);
  const buf = await p.screenshot({ fullPage: true });
  await p.close();
  return buf.toString('base64');
}

function frame({ w, h, headline, sub, popupB64, tile }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin:0; box-sizing:border-box; }
    body { width:${w}px; height:${h}px; overflow:hidden; display:flex; align-items:center;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      background:
        radial-gradient(900px 600px at 85% -10%, rgba(124,58,237,.45), transparent 60%),
        radial-gradient(700px 500px at -10% 110%, rgba(91,33,182,.55), transparent 60%),
        linear-gradient(135deg,#2e1065 0%,#1e1b2e 55%,#171426 100%); color:#fff; }
    .txt { flex:1; padding:0 ${tile ? 28 : 84}px; }
    .logo { display:flex; align-items:center; gap:14px; margin-bottom:${tile ? 12 : 34}px; }
    .logo img { width:${tile ? 44 : 56}px; height:${tile ? 44 : 56}px; border-radius:${tile ? 10 : 14}px; }
    .logo span { font-size:${tile ? 30 : 34}px; font-weight:800; letter-spacing:-.01em; }
    h1 { font-size:${tile ? 24 : 46}px; font-weight:800; line-height:1.12; letter-spacing:-.015em; margin-bottom:${tile ? 0 : 20}px; max-width:560px; }
    p { font-size:19px; line-height:1.5; color:#cfc7ee; max-width:480px; }
    .shot { flex:none; padding-right:80px; }
    .shot img { width:340px; border-radius:18px; box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.09); }
  </style></head><body>
    <div class="txt">
      <div class="logo"><img src="data:image/png;base64,${icon}"><span>Quell</span></div>
      <h1>${headline}</h1>
      ${sub ? `<p>${sub}</p>` : ''}
    </div>
    ${popupB64 ? `<div class="shot"><img src="data:image/png;base64,${popupB64}"></div>` : ''}
  </body></html>`;
}

async function render(name, w, h, html) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await p.waitForTimeout(250);
  writeFileSync(path.join(OUT, name), await p.screenshot());
  await p.close();
  console.log('wrote store/assets/' + name);
}

const shot1 = await popupShot({ enabled: true, googleMode: 'hide', totalBlocked: 0 });
await render('screenshot-1-1280x800.png', 1280, 800, frame({
  w: 1280, h: 800,
  headline: 'Turn off AI Overviews.',
  sub: 'Google and Bing, on every country domain — plus cookie-consent pop-ups. Free, open source, and it collects nothing.',
  popupB64: shot1,
}));

const shot2 = await popupShot({ enabled: true, googleMode: 'cleanweb', totalBlocked: 12847 });
await render('screenshot-2-1280x800.png', 1280, 800, frame({
  w: 1280, h: 800,
  headline: 'Quiet, counted locally.',
  sub: 'Every AI block and cookie nag quelled is tallied on your device — and shared with no one. No account. No tracking. No upsell.',
  popupB64: shot2,
}));

await render('tile-small-440x280.png', 440, 280, frame({
  w: 440, h: 280, tile: true,
  headline: 'Quiet the web.',
}));

await ctx.close();
console.log('done');
