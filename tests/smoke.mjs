// Quell — integration smoke suite.
// Loads the real unpacked extension into Chrome (via Playwright persistent
// context) and verifies each surface against local fixtures — no live Google/
// Bing traffic, no network. Run:  node tests/smoke.mjs
// Needs the global playwright install (see NODE_PATH in tests/run.sh).

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
let passed = 0, failed = 0;
let skipped = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}`); }
};
// Announce loudly rather than passing vacuously when the environment can't
// set up a precondition — a silent trivial pass is worse than no test.
const skip = (name, why) => { skipped++; console.log(`  ⊘ SKIP ${name} — ${why}`); };

const GOOGLE_FIXTURE = `<!doctype html><html><head><title>q - Google Search</title></head><body>
<div id="gemini-upsell"><a href="https://gemini.google.com/promo" aria-label="Try Gemini">Try Gemini</a></div>
<div id="search"><div id="rso">
  <div class="MjjYud" id="ai-block"><div role="heading">AI Overview</div><p>Generated answer…</p></div>
  <div class="M8OgIe" id="ai-block-css"><div role="heading">AI Overview</div><p>Matches BLOCK_CSS and the label pass…</p></div>
  <div class="MjjYud" id="organic-ai-title"><a href="https://example.com/x"><h3>AI Mode explained — what it means</h3></a></div>
  <div class="MjjYud" id="organic-gemini"><a href="https://gemini.google.com/app"><h3>Gemini — chat to supercharge your ideas</h3></a></div>
  <div class="MjjYud" id="organic-normal"><a href="https://example.com/y"><h3>Regular result</h3></a></div>
</div></div></body></html>`;

const BING_FIXTURE = `<!doctype html><html><body>
<div id="b_content">result list</div><div id="b_sydConvCont">Copilot panel</div>
</body></html>`;

const CMP_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="onetrust-banner-sdk">We use cookies!</div><div id="content">site content</div>
</body></html>`;

const CLEAN_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="app">A legit scroll-locked web app — no CMP here.</div>
</body></html>`;

// Playwright's bundled Chromium (NOT stable Chrome — it dropped --load-extension).
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
ok(!!sw, 'extension service worker started');
const extId = new URL(sw.url()).host;

// --- Google hide mode: AI block hidden, organic "AI Mode…" title survives ---
console.log('Google (hide mode):');
{
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('ai-block')).display === 'none').catch(() => {});
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block')).display) === 'none',
    'AI Overview block hidden');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('organic-ai-title')).display) !== 'none',
    'organic result titled "AI Mode…" NOT hidden (false-positive guard)');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('organic-normal')).display) !== 'none',
    'normal organic result NOT hidden');
  await page.close();
}

// --- Google clean-web mode: redirects to udm=14 ---
console.log('Google (clean web):');
{
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'cleanweb' }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForURL(/udm=14/, { timeout: 5000 }).catch(() => {});
  ok(page.url().includes('udm=14'), 'redirected to classic web results (udm=14)');
  // Close BEFORE restoring the mode: with live-apply, flipping to hide while
  // this udm=14 tab is open now sends it back through a redirect, whose sweep
  // would land in the next test's counter.
  await page.close();
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
}

// --- Google clean-web mode: verticals exempt, AI Mode redirected ---
console.log('Google (clean web verticals):');
{
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'cleanweb' }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test&udm=2');
  await page.waitForTimeout(400);
  ok(!page.url().includes('udm=14'), 'Images tab (udm=2) NOT redirected');
  await page.goto('https://www.google.com/search?q=test&tbm=isch');
  await page.waitForTimeout(400);
  ok(!page.url().includes('udm=14'), 'legacy vertical (tbm=isch) NOT redirected');
  await page.goto('https://www.google.com/search?q=test&udm=50');
  await page.waitForURL(/udm=14/, { timeout: 5000 }).catch(() => {});
  ok(page.url().includes('udm=14'), 'AI Mode (udm=50) redirected to web results');
  await page.close(); // close before restoring the mode — see note above
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
}

// --- Gemini selector scoping + badge single-count ---
console.log('Gemini scoping + badge count:');
{
  await sw.evaluate(() => chrome.storage.local.set({ totalBlocked: 0 }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=gemini');
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('ai-block')).display === 'none').catch(() => {});
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#organic-gemini a')).display) !== 'none',
    'organic result linking gemini.google.com NOT hidden (false-positive guard)');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('#gemini-upsell a')).display) === 'none',
    'Gemini upsell outside organic containers IS hidden');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block-css')).display) === 'none',
    'block matching BLOCK_CSS hidden');
  // Settle: content script → message → serialized badge queue → storage.
  let total = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(150);
    const t = await sw.evaluate(() => chrome.storage.local.get({ totalBlocked: 0 }).then((s) => s.totalBlocked));
    if (t === total && t > 0) break;
    total = t;
  }
  ok(total === 2, `two AI blocks counted exactly once each (totalBlocked=${total}, was 3 with the double-count bug)`);
  await page.close();
}

// --- Master switch off: nothing hidden ---
console.log('Master switch:');
{
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block')).display) !== 'none',
    'master off → AI block left alone');
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  await page.close();
}

// --- Bing: Copilot panel hidden, results intact ---
console.log('Bing:');
{
  const page = await ctx.newPage();
  await page.route('https://www.bing.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: BING_FIXTURE }));
  await page.goto('https://www.bing.com/search?q=test');
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('b_sydConvCont')).display === 'none').catch(() => {});
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('b_sydConvCont')).display) === 'none',
    'Copilot panel hidden');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('b_content')).display) !== 'none',
    'result list NOT hidden');
  await page.close();
}

// --- Cookie layer logic (script injected directly; registration needs a user
//     permission gesture Playwright can't perform) ---
console.log('Cookie layer:');
{
  const src = readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
  const stub = 'window.chrome={storage:{local:{get:async(d)=>d}},runtime:{sendMessage(){}}};';

  const page = await ctx.newPage();
  await page.route('http://cmp-fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: CMP_FIXTURE }));
  await page.goto('http://cmp-fixture.test/');
  await page.addScriptTag({ content: stub + '\n' + src });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) === 'none',
    'OneTrust banner hidden');
  ok(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'auto',
    'CMP scroll-lock released');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('content')).display) !== 'none',
    'page content untouched');
  await page.close();

  const clean = await ctx.newPage();
  await clean.route('http://clean-app.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: CLEAN_FIXTURE }));
  await clean.goto('http://clean-app.test/');
  await clean.addScriptTag({ content: stub + '\n' + src });
  await clean.waitForTimeout(300);
  ok(await clean.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden',
    'legit scroll-lock NOT touched on CMP-free site (regression: blanket overflow)');
  await clean.close();

  // Per-site pause: allowlisted host → layer stays out entirely.
  const paused = await ctx.newPage();
  await paused.route('http://cmp-fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: CMP_FIXTURE }));
  await paused.goto('http://cmp-fixture.test/');
  await paused.addScriptTag({ content:
    'window.chrome={storage:{local:{get:async(d)=>({...d,cookieAllowlist:["cmp-fixture.test"]})}},runtime:{sendMessage(){}}};\n' + src });
  await paused.waitForTimeout(300);
  ok(await paused.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) !== 'none',
    'allowlisted site → banner left alone (per-site pause)');
  await paused.close();
}

// --- LIVE-APPLY: popup toggles must affect the page ALREADY open ---
// Regression guard for the launch-blocking gap: before this, every toggle
// silently needed a reload, which reads as "the extension does nothing".
console.log('Live-apply (no reload):');
{
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  const disp = (id) => page.evaluate(
    (i) => getComputedStyle(document.getElementById(i)).display, id);
  const settle = async (id, want) => {
    await page.waitForFunction(
      ([i, w]) => getComputedStyle(document.getElementById(i)).display === w,
      [id, want], { timeout: 4000 }).catch(() => {});
  };

  await settle('ai-block', 'none');
  ok(await disp('ai-block') === 'none', 'baseline: AI block hidden in hide mode');

  // hide → off, live
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'off' }));
  await settle('ai-block', 'block');
  ok(await disp('ai-block') !== 'none', 'mode → off UNHIDES the open page (no reload)');
  ok(await page.evaluate(() => !document.getElementById('quell-google')),
    'stylesheet removed on teardown');
  ok(await page.evaluate(() => !document.querySelector('[data-quell-hidden="1"]')),
    'inline display:none cleared on teardown (stylesheet removal alone is not enough)');

  // off → hide, live
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
  await settle('ai-block', 'none');
  ok(await disp('ai-block') === 'none', 'mode → hide RE-HIDES the open page (no reload)');

  // master switch, live
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await settle('ai-block', 'block');
  ok(await disp('ai-block') !== 'none', 'master off unhides the open page (no reload)');
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true }));
  await settle('ai-block', 'none');
  ok(await disp('ai-block') === 'none', 'master on re-hides the open page (no reload)');

  // Toggling must not re-inflate the lifetime counter on the same page.
  const t1 = await sw.evaluate(() => chrome.storage.local.get({ totalBlocked: 0 }).then((s) => s.totalBlocked));
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'off' }));
  await settle('ai-block', 'block');
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
  await settle('ai-block', 'none');
  await page.waitForTimeout(600);
  const t2 = await sw.evaluate(() => chrome.storage.local.get({ totalBlocked: 0 }).then((s) => s.totalBlocked));
  ok(t2 === t1, `off→on does NOT double-count the same blocks (${t1} → ${t2})`);
  await page.close();
}

// --- LIVE-APPLY: Clean Web switches both ways without a reload ---
console.log('Live-apply (Clean Web round trip):');
{
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');

  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'cleanweb' }));
  await page.waitForURL(/udm=14/, { timeout: 5000 }).catch(() => {});
  ok(page.url().includes('udm=14'), 'hide → Clean Web redirects the open tab (no reload)');

  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
  await page.waitForFunction(() => !location.search.includes('udm=14'), null,
    { timeout: 5000 }).catch(() => {});
  ok(!page.url().includes('udm=14'), 'Clean Web → hide returns the tab to the normal SERP');
  await page.close();
}

// --- Clean Web undo must NOT hijack a user's own udm=14 ---
console.log('Clean Web undo scoping:');
{
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide' }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  // User navigates to udm=14 themselves; Quell never redirected this tab.
  await page.goto('https://www.google.com/search?q=test&udm=14');
  await page.waitForTimeout(500);
  // An unrelated setting changes — must not strip the user's own udm=14.
  await sw.evaluate(() => chrome.storage.local.set({ bingEnabled: false }));
  await page.waitForTimeout(600);
  ok(page.url().includes('udm=14'),
    "user's own udm=14 preserved (we only undo a redirect we performed)");
  await sw.evaluate(() => chrome.storage.local.set({ bingEnabled: true }));
  await page.close();
}

// --- LIVE-APPLY: Bing ---
console.log('Live-apply (Bing):');
{
  const page = await ctx.newPage();
  await page.route('https://www.bing.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: BING_FIXTURE }));
  await page.goto('https://www.bing.com/search?q=test');
  const disp = () => page.evaluate(() => getComputedStyle(document.getElementById('b_sydConvCont')).display);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('b_sydConvCont')).display === 'none',
    null, { timeout: 4000 }).catch(() => {});
  ok(await disp() === 'none', 'baseline: Copilot panel hidden');
  await sw.evaluate(() => chrome.storage.local.set({ bingEnabled: false }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('b_sydConvCont')).display !== 'none',
    null, { timeout: 4000 }).catch(() => {});
  ok(await disp() !== 'none', 'Bing toggle off unhides Copilot on the open page');
  await sw.evaluate(() => chrome.storage.local.set({ bingEnabled: true }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('b_sydConvCont')).display === 'none',
    null, { timeout: 4000 }).catch(() => {});
  ok(await disp() === 'none', 'Bing toggle on re-hides Copilot on the open page');
  await page.close();
}

// --- LIVE-APPLY: cookie layer reverts in place (seed + scroll-unlock) ---
console.log('Live-apply (cookie layer):');
{
  const src = readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
  // Minimal storage stub with a working onChanged, so the script's own
  // listener drives the transition exactly as it does in the browser.
  const stub = `window.__quellState={enabled:true,cookieEnabled:true,cookieAllowlist:[]};
    window.__quellCbs=[];
    window.chrome={
      storage:{local:{get:async(d)=>({...d,...window.__quellState})},
      onChanged:{addListener:(f)=>window.__quellCbs.push(f)}},
      runtime:{sendMessage:async()=>({selectors:[]})}
    };
    window.__quellSet=(patch)=>{Object.assign(window.__quellState,patch);
      const ch={};for(const k of Object.keys(patch))ch[k]={newValue:patch[k]};
      window.__quellCbs.forEach(f=>f(ch,'local'));};`;

  const page = await ctx.newPage();
  await page.route('http://cmp-fixture.test/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: CMP_FIXTURE }));
  await page.goto('http://cmp-fixture.test/');
  await page.addScriptTag({ content: stub + '\n' + src });
  await page.waitForTimeout(300);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) === 'none',
    'baseline: banner hidden, scroll unlocked');
  ok(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'auto',
    'baseline: CMP scroll-lock released');

  await page.evaluate(() => window.__quellSet({ cookieEnabled: false }));
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) !== 'none',
    'cookie feature off restores the banner in place (no reload)');
  ok(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden',
    "scroll-unlock reverted to the site's own overflow (not left forced open)");

  await page.evaluate(() => window.__quellSet({ cookieEnabled: true }));
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) === 'none',
    'cookie feature back on re-hides the banner in place');

  // Per-site pause is live too — the tooltip no longer tells users to reload.
  await page.evaluate(() => window.__quellSet({ cookieAllowlist: ['cmp-fixture.test'] }));
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('onetrust-banner-sdk')).display) !== 'none',
    'per-site pause applies live');
  await page.close();
}

// --- Hidden tab: rAF never fires there, so the sweep must still settle ---
// Without the nextTick fallback the label pass and badge count are deferred
// indefinitely for anything opened in a background tab.
console.log('Hidden-tab sweep:');
{
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide', enabled: true }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  // Force a background tab. setPageVisibilityOverride is gone from current
  // Chrome, so drive it the way a user would: front a different tab.
  const front = await ctx.newPage();
  await page.goto('https://www.google.com/search?q=test');
  await front.bringToFront();
  await page.waitForTimeout(300);
  const isHidden = await page.evaluate(() => document.visibilityState === 'hidden');

  if (!isHidden) {
    // Headless Chromium reports every page visible; asserting here would pass
    // for the wrong reason and hide a real regression.
    skip('hidden-tab sweep', 'this Chromium reports all pages visible — rAF still fires, precondition unmet');
  } else {
    const rafDead = await page.evaluate(async () => {
      let fired = false;
      requestAnimationFrame(() => { fired = true; });
      await new Promise((r) => setTimeout(r, 500));
      return !fired;
    });
    ok(rafDead, 'precondition: rAF does NOT fire while hidden');
    await page.waitForFunction(
      () => document.querySelectorAll('[data-quell-counted="1"]').length > 0,
      null, { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(() => document.querySelectorAll('[data-quell-counted="1"]').length) > 0,
      'sweep still runs in a hidden tab (rAF fallback)');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block')).display) === 'none',
      'label-pass block hidden in a hidden tab');
  }
  await front.close();
  await page.close();
}

// --- Popup renders with defaults ---
console.log('Popup:');
{
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  ok(await page.evaluate(() => document.getElementById('enabled').checked), 'master toggle reflects enabled');
  ok(await page.evaluate(() => document.querySelector('input[name="gmode"][value="hide"]').checked), 'google mode radio = hide');
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('siteRow')).display) === 'none',
    'site-pause row actually hidden while cookie feature off (computed style, not just attribute)');
  ok(await page.evaluate(() => document.getElementById('rate').href
    .includes('chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho')),
    'Rate Quell links the real store listing');
  ok(await page.evaluate(() => document.getElementById('aiState').textContent) === 'Active',
    'AI-features badge Active with defaults');

  // Badge honesty: master off → Off; both AI features off → Off.
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('aiState').textContent === 'Off',
    { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => document.getElementById('aiState').textContent) === 'Off',
    'AI-features badge Off when master switch is off');
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, googleMode: 'off', bingEnabled: false }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('aiState').textContent === 'Off',
    { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(() => document.getElementById('aiState').textContent) === 'Off',
    'AI-features badge Off when every AI feature is off');
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'hide', bingEnabled: true }));
  await page.close();
}

// --- Background wiring: cookie rulesets follow master + feature toggles ---
console.log('Background gating:');
{
  const rulesets = async () => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  await sw.evaluate(() => chrome.storage.local.set({ cookieEnabled: true }));
  await new Promise((r) => setTimeout(r, 300));
  const on = await rulesets();
  ok(on.includes('cookie_cmp'), 'cookieEnabled → curated network ruleset ON');
  ok(on.includes('cookie_cmp_easylist'), 'cookieEnabled → EasyList network ruleset ON');
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await new Promise((r) => setTimeout(r, 300));
  const off = await rulesets();
  ok(!off.includes('cookie_cmp') && !off.includes('cookie_cmp_easylist'),
    'master off → network rulesets OFF (gating fix)');
  await sw.evaluate(() => chrome.storage.local.set({ enabled: true, cookieEnabled: false }));
}

// --- Phase-2 pipeline artifacts: present, parseable, host-slicing works ---
console.log('Pipeline artifacts:');
{
  const domains = await sw.evaluate(async () => {
    const r = await fetch(chrome.runtime.getURL('rules/cookie-domains.json'));
    const map = await r.json();
    const hosts = Object.keys(map);
    return { hosts: hosts.length, sample: hosts[0], sampleSelectors: map[hosts[0]].length };
  });
  ok(domains.hosts > 1000, `cookie-domains.json loads in SW (${domains.hosts} hosts)`);
  ok(domains.sampleSelectors > 0, 'domain entries carry selectors');
  const css = await sw.evaluate(async () => {
    const r = await fetch(chrome.runtime.getURL('rules/cookie-generic.css'));
    const t = await r.text();
    return { bytes: t.length, rules: (t.match(/display:none!important/g) || []).length };
  });
  ok(css.bytes > 100000 && css.rules > 10, `cookie-generic.css loads in SW (${Math.round(css.bytes / 1024)} KB, ${css.rules} chunks)`);
  const easylist = await sw.evaluate(async () => {
    const r = await fetch(chrome.runtime.getURL('rules/cookie-cmp-easylist.json'));
    const rules = await r.json();
    return { n: rules.length, ids: new Set(rules.map((x) => x.id)).size };
  });
  ok(easylist.n > 50 && easylist.ids === easylist.n, `EasyList dNR ruleset valid (${easylist.n} unique rules)`);
}

await ctx.close();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
