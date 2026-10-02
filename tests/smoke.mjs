// Quell — integration smoke suite.
// Loads the real unpacked extension into Chrome (via Playwright persistent
// context) and verifies each surface against local fixtures — no live Google/
// Bing traffic, no network. Run:  node tests/smoke.mjs
// Needs the global playwright install (see NODE_PATH in tests/run.sh).

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const EDGE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0";
const OPERA_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0";

// QUELL_EXT lets the mutation battery load a mutated copy of the extension.
const EXT = process.env.QUELL_EXT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
let passed = 0, failed = 0;
let skipped = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}`); }
};
// Announce loudly rather than passing vacuously when the environment can't
// set up a precondition — a silent trivial pass is worse than no test.
// Every content script now reads settings through src/shared/settings.js,
// which the manifest and the background load first. Tests that inject a
// content script by hand must load it first too.
const SETTINGS_SRC = readFileSync(path.join(EXT, 'src/shared/settings.js'), 'utf8');
// True once the page's CURRENT document has Quell's isolated world with
// window.Quell defined. `contexts` is filled from Runtime.executionContextCreated
// and emptied on executionContextsCleared (i.e. per document). Polls; bounded.
async function quellWorldReady(page, contexts, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const c of [...contexts]) {
      if (!(c.origin || '').startsWith('chrome-extension://')) continue;
      const r = await c.cdp.send('Runtime.evaluate', {
        contextId: c.id, expression: 'typeof window.Quell', returnByValue: true,
      }).catch(() => null);
      if (r?.result?.value === 'object') return true;
    }
    await page.waitForTimeout(50);
  }
  return false;
}
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

// Phase 1 fixture. The point of it: Google renders a People-also-ask answer
// with the SAME "AI Overview" label and the same data-attrid as the
// unsolicited overview above the results. #paa-item-2 exists to catch the
// regression where hiding a PAA answer climbs out of its own item and takes
// every other question down with it.
const PAA_FIXTURE = `<!doctype html><html><head><title>q - Google Search</title></head><body>
<div><a id="gemini-chip" href="https://gemini.google.com/promo" aria-label="Try Gemini">Try Gemini</a></div>
<div id="search"><div id="rso">
  <div class="MjjYud" id="ai-block"><div role="heading">AI Overview</div><p>Unsolicited generated answer…</p></div>
  <div data-attrid="AIOverview" id="attrid-block"><p>Unsolicited, matched by the CSS layer…</p></div>
  <!-- The regression that review caught: Google's OWN AI Overview carries a
       "Show more" disclosure control. A structural "is it expandable?" test
       therefore classifies it as user-initiated and lets it PAINT. This block
       must stay hidden; if it ever renders, someone reintroduced that walk. -->
  <div class="MjjYud" id="ai-block-showmore">
    <div role="heading">AI Overview</div><p>Unsolicited, but expandable…</p>
    <div role="button" aria-expanded="false">Show more</div>
  </div>
  <!-- An AI Mode entry point sitting next to an unrelated dropdown. -->
  <div class="MjjYud" id="aimode-wrap">
    <div role="button" aria-expanded="false">More</div>
    <div role="heading" id="aimode-chip">AI Mode</div>
  </div>
  <div class="MjjYud" id="paa-section">
    <div jsname="Cpkphb" class="related-question-pair" id="paa-item-1">
      <div role="button" aria-expanded="true">What is a widget?</div>
      <div id="paa-answer-1"><div role="heading">AI Overview</div><p>A widget is…</p></div>
    </div>
    <div jsname="Cpkphb" class="related-question-pair" id="paa-item-2">
      <div role="button" aria-expanded="false">A second question?</div>
    </div>
    <div jsname="Cpkphb" class="related-question-pair" id="paa-item-3">
      <div role="button" aria-expanded="true">A third question?</div>
      <div data-attrid="AIOverview" id="paa-attrid-answer"><p>Clicked open, but marked like an overview…</p></div>
    </div>
  </div>
  <div class="MjjYud" id="organic-normal"><a href="https://example.com/y"><h3>Regular result</h3></a></div>
</div></div></body></html>`;

// #b_results holds Bing's organic results — the safety boundary for every
// Copilot-search selector. .b_scopebar (the bare nav tab) lives in page
// chrome under #b_header; #b_copilot_search_container (the suggestion chips)
// is a sibling of #b_results, positioned after it in document order. Both
// are structurally outside #b_results by construction (DOM-containment
// verified against live Bing). organic-copilot-link exists specifically to
// prove that: it's an organic result INSIDE #b_results that happens to link
// to /copilotsearch, and must never be hidden by either selector.
const BING_FIXTURE = `<!doctype html><html><body>
<header id="b_header"><nav class="b_scopebar">
  <a href="https://www.bing.com/search?q=test">All</a>
  <a id="scope-copilot" href="/copilotsearch?q=test&amp;FORM=CSSCOP">Search</a>
</nav></header>
<div id="b_content"><div id="b_results">
  <div id="organic-1"><a href="https://example.com/x">Regular result</a></div>
  <div><a id="organic-copilot-link" href="/copilotsearch?q=test&amp;FORM=ORGANIC">An article about Bing Copilot search</a></div>
  <!-- The query "copilot" is a query people actually type, and Microsoft's own
       product is the #1 organic result for it. Its title link points at
       copilot.microsoft.com and its card carries an aria-label echoing the
       title — so the two substring selectors matched a real result and deleted
       it. Both of these shipped visible-to-users broken in 0.4.2. -->
  <li class="b_algo" id="org-card" aria-label="Microsoft Copilot: your AI companion">
    <h2><a id="org-copilot-a" href="https://copilot.microsoft.com/">Microsoft Copilot</a></h2>
    <p>The official page.</p>
  </li>
  <li class="b_algo" id="org-aria"><a href="https://example.com/z" aria-label="Copilot review roundup">A review of Copilot</a></li>
  <li class="b_algo" id="org-plain"><a href="https://example.com/w">An unrelated result</a></li>
</div></div>
<div id="b_sydConvCont">Copilot panel</div>
<!-- The fourth /copilotsearch link measured live (IMPROVEMENT-PLAN
     2026-09-10): outside both the scope bar and the chip row. -->
<div id="b_rs_copilot"><a id="cs-other" href="/copilotsearch?q=test&amp;form=CSSRCH">Ask Copilot about this</a></div>
<div id="b_copilot_search_container"><div class="suggestion_container">
  <a class="suggestion_chip" id="chip-1" href="/copilotsearch?q=chip+one&amp;form=CSBSUG">chip query one</a>
  <a class="suggestion_chip" id="chip-2" href="/copilotsearch?q=chip+two&amp;form=CSBSUG">chip query two</a>
</div></div>
</body></html>`;

const CMP_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="onetrust-banner-sdk">We use cookies!</div><div id="content">site content</div>
</body></html>`;

// Reject-all fixture. The DECOY is the point: a page's own "Reject" control,
// outside any CMP container. Quell must never click it — a stray click is
// unrecoverable in a way a wrongly-hidden element is not.
const REJECT_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="site-ui">
  <button id="decoy-reject" onclick="document.body.dataset.decoyClicked='1'">Reject application</button>
</div>
<div id="onetrust-banner-sdk">
  We use cookies!
  <button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button>
</div>
<div id="content">site content</div>
</body></html>`;

// A CMP whose reject control is NOT a control: <div class="cky-btn-reject">.
// Clicking a non-control does nothing useful and may hit a site's own handler,
// so the tag/role gate has to hold. The real button below it must be found
// instead — proving the gate SKIPS rather than gives up.
const NONCONTROL_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="onetrust-banner-sdk">We use cookies!
  <div id="onetrust-reject-all-handler" onclick="document.body.dataset.divClicked='1'">Reject (a div)</div>
  <button id="CybotCookiebotDialogBodyButtonDecline" onclick="document.body.dataset.rejected='1'">Decline</button>
</div></body></html>`;

// A CMP that re-renders its banner after the click. Quell must click ONCE:
// each click is a consent action, and a loop against the vendor's handler is
// the difference between "made a choice" and "hammered the page".
const RERENDER_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="wrap">
  <button class="cmplz-deny"
    onclick="window.__clicks=(window.__clicks||0)+1;
             const p=document.getElementById('wrap'); const h=p.innerHTML;
             p.innerHTML=''; setTimeout(()=>{p.innerHTML=h;},60);">Deny</button>
</div></body></html>`;

// A pre-consented OneTrust: the banner is still in the DOM at display:none
// with its reject button inside. Clicking that on every page load re-fires the
// vendor's consent callback for a choice the user already made.
const HIDDENCMP_FIXTURE = `<!doctype html><html><body>
<div id="onetrust-banner-sdk" style="display:none">
  <button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button>
</div><div id="content">site content</div></body></html>`;

// Quantcast renders "MORE OPTIONS" as a secondary button too, and which
// secondary comes FIRST varies per site. Landing on it opens the preference
// pane, records no choice, and then the banner is hidden over the open pane.
const QUANTCAST_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div class="qc-cmp2-summary-buttons">
  <button mode="secondary" onclick="document.body.dataset.clicked='MORE OPTIONS'">MORE OPTIONS</button>
  <button mode="secondary" onclick="document.body.dataset.clicked='DISAGREE'">DISAGREE</button>
  <button mode="primary" onclick="document.body.dataset.clicked='AGREE'">AGREE</button>
</div></body></html>`;

// The REAL ordering: Quell runs at document_start, finds no banner, hides the
// SEED selectors, and the CMP injects afterwards. Every other reject fixture
// injects cookies.js after the banner already exists, which is the one ordering
// that hides this bug.
const LATECMP_FIXTURE = `<!doctype html><html><body><div id="content">site</div>
<script>setTimeout(function(){
  var d=document.createElement('div'); d.id='onetrust-banner-sdk';
  d.innerHTML='We use cookies! <button id="onetrust-reject-all-handler">Reject All</button>';
  d.querySelector('button').addEventListener('click',function(){document.body.dataset.rejected='1';});
  document.body.appendChild(d);
},300);<\/script></body></html>`;

// Sourcepoint, as spiegel.de and faz.net ship it: a class on <html> that the
// site's stylesheet turns into a fixed, unscrollable body.
const SP_LOCK_FIXTURE = `<!doctype html><html class="site sp-message-open"><head><style>
  .sp-message-open { height: 100vh !important; width: 100vw !important; }
  .sp-message-open body { overflow: hidden !important; position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; }
  body { position: relative; margin: 0; }
</style></head><body>
<div id="sp_message_container_1517383" style="position:fixed;inset:0;z-index:99">We value your privacy</div>
<div id="content" style="height:6000px">Long page</div>
</body></html>`;
// The same class on a page with no consent message: someone else's lock, left alone.
const SP_CLASS_NO_CMP_FIXTURE = `<!doctype html><html class="sp-message-open"><head><style>
  .sp-message-open body { overflow: hidden !important; position: fixed !important; }
</style></head><body><div id="content" style="height:6000px">App</div></body></html>`;

const CLEAN_FIXTURE = `<!doctype html><html><body style="overflow:hidden">
<div id="app">A legit scroll-locked web app — no CMP here.</div>
</body></html>`;

// --- Engine fixtures (DuckDuckGo / Brave / Yahoo) --------------------------
// Built from markup measured live on 2026-09-10 (see the engine recon). Each
// one carries a deliberate TRAP: an organic result that a naive selector would
// hit. Those traps are the point — Quell erasing a real result is worse than
// any AI block it fails to hide.
const DDG_FIXTURE = `<!doctype html><html><body>
<a href="/?q=x&assist=true">Search Assist</a>
<div class="react-results--main">
  <li data-layout="wikinlp" id="ddg-ai">
    <span>Search Assist</span>
    <div data-testid="duckassist-answer-content">Generated answer…</div>
  </li>
  <li data-layout="organic" id="ddg-organic-1"><a href="https://example.com/a">A real result</a></li>
  <!-- TRAP: an organic result whose own text begins "Search Assist". The label
       pass must refuse it, because the block carries no duckassist testid. -->
  <li data-layout="organic" id="ddg-organic-trap"><span>Search Assist explained</span></li>
  <!-- The text-resilient layer, which no test exercised: this card carries NO
       data-layout="wikinlp", so the CSS selector cannot reach it. Only the
       label pass ("search assist" + a corroborating duckassist testid) can.
       If the labels are ever gutted, only this catches it. -->
  <li data-layout="wikinlp2" id="ddg-ai-labelonly">
    <span>Search Assist</span>
    <div data-testid="duckassist-answer-content">Generated answer, label pass only…</div>
  </li>
</div></body></html>`;

const BRAVE_FIXTURE = `<!doctype html><html><body>
<div id="mixed-top">
  <div id="llm-snippet" class="snippet">Generated summary…
    <button aria-label="Good response">up</button>
    <button aria-label="Bad response">down</button>
  </div>
</div>
<div id="mixed-main">
  <div class="snippet" id="brave-organic-1"><a href="https://example.com/b">A real result</a></div>
  <!-- TRAP: an organic result carrying the same feedback aria-label. -->
  <div class="snippet" id="brave-organic-trap"><span aria-label="Good response">review</span>Rated highly</div>
</div></body></html>`;

const YAHOO_FIXTURE = `<!doctype html><html><body>
<!-- Yahoo Scout (AI chat) entry points, shaped on live markup 2026-09-25. -->
<div id="sticky-hd"><div id="hd"><div id="scoutPromoTooltip" class="scout-promo-tooltip">
  <div class="scout-promo-tooltip-card"><h3 class="scout-promo-tooltip-title">Try Yahoo Scout</h3></div>
</div></div></div>
<div id="horizontal-bar"><ol class="reg searchLeftTop">
  <li class="first"><div class="dd scoutNav" id="yahoo-scout-nav"><div class="compText"><p><a href="https://scout.yahoo.com/chat?q=test">Yahoo Scout</a></p></div></div></li>
  <li><div class="dd" id="yahoo-nav-news"><a href="https://news.search.yahoo.com/search?p=test">News</a></div></li>
</ol></div>
<div id="right"><ol class="reg searchRightBottom">
  <li class="first"><div class="dd kp" id="yahoo-right-kp"><div class="compTitle"><a href="https://en.wikipedia.org/wiki/Test">Test — knowledge panel</a></div><p>Not AI.</p></div></li>
  <li class="last"><div class="dd p-0 bd-0" id="yahoo-scout-explore">
    <div class="compTitle"><div class="title at-title"><a href="https://scout.yahoo.com/chat?q=test">Explore AI results with Yahoo Scout</a></div></div>
    <table class="compTable"><tr><td><a href="https://scout.yahoo.com/chat?p=test+in+depth">test in depth</a></td></tr></table>
  </div></li>
</ol></div>
<ol class="reg searchCenterTop"><li class="first last">
  <div class="grp grp-genAISum"><div class="dd genAiDD genAiSum" id="yahoo-ai">
    <span class="ai-summary-text">AI Summary</span><p>Generated…</p>
    <a class="citation-crsl-text" id="yahoo-citation" href="https://britannica.com/x">Britannica</a>
  </div></div>
</li></ol>
<ol class="reg searchCenterMiddle">
  <li class="first"><div class="dd algo algo-sr" id="yahoo-organic-1"><a href="https://example.com/c">A real result</a></div></li>
  <!-- TRAP: the REAL Britannica organic result. A bare domain-substring
       selector would hit the citation chip above and this together. -->
  <li class="first"><div class="dd algo algo-sr" id="yahoo-organic-trap"><span>AI Summary tools compared</span><a href="https://britannica.com/x">Britannica — the real result</a></div></li>
  <!-- TRAP: an organic result that IS about Yahoo Scout and links to it,
       with the same compTitle shape as the right-rail Scout panel. -->
  <li><div class="dd algo algo-sr" id="yahoo-organic-scout"><div class="compTitle"><a href="https://scout.yahoo.com/">Yahoo Scout review — the real result</a></div></div></li>
</ol>
<ol class="reg searchCenterFooter"><li class="first last">
  <div class="dd AlsoTry" id="yahoo-also-try"><div class="compTitle"><div class="title at-title"><a class="at-icon" href="https://scout.yahoo.com/chat?p=test" aria-label="Yahoo Scout">Explore AI results with Yahoo Scout</a></div></div>
    <table class="compTable"><tr><td><a href="https://scout.yahoo.com/chat?p=test+meaning">test meaning</a></td></tr></table></div>
</li></ol>
<!-- TRAP: a plain related-searches footer with no Scout title stays. -->
<ol class="reg searchCenterFooter"><li class="first last">
  <div class="dd AlsoTry" id="yahoo-also-try-plain"><div class="compTitle"><div class="title">Also try</div></div>
    <table class="compTable"><tr><td><a href="https://search.yahoo.com/search?p=test+meaning">test meaning</a></td></tr></table></div>
</li></ol></body></html>`;

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

// --- "Which site is this tab on?" — the real path the popup uses on Google/Bing ---
console.log('Popup → page: which site is this tab on:');
{
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('ai-block')).display === 'none').catch(() => {});
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/src/popup/popup.html?view=page`);
  const seen = await ext.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const answers = await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'where' }).then((r) => r, () => null)));
    return { urls: tabs.map((t) => t.url ?? null), answers };
  });
  ok(seen.urls.every((u) => u === null), 'precondition: the browser shows Quell no tab addresses (this is why the popup has to ask)');
  ok(JSON.stringify(seen.answers.filter(Boolean)) === '[{"host":"www.google.com"}]',
    `Quell's script on the Google tab answers with its hostname and nothing else; no other tab answers (${JSON.stringify(seen.answers)})`);
  // A web page cannot ask: the question is only answered when it comes from Quell itself.
  ok(await page.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function'),
    'a web page has no way to send the question');
  await ext.close();
  await page.close();

  // The listener itself: it answers Quell's own popup and nobody else. Run
  // against a recording chrome so the guard is exercised directly (the
  // browser would not let a stranger's message arrive in the first place).
  const lone = await ctx.newPage();
  await lone.route('http://where.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>x</title>' }));
  await lone.goto('http://where.test/');
  const answers = await lone.evaluate(({ settings, common }) => {
    const listeners = [];
    window.chrome = { runtime: { id: 'quell-id', onMessage: { addListener: (f) => listeners.push(f) } },
      storage: { local: { get: async (d) => d }, sync: { get: async (d) => d }, onChanged: { addListener() {} } } };
    new Function(settings + '\n' + common)();
    new Function(settings + '\n' + common)(); // injected twice, as the background can do
    const ask = (msg, sender) => { let got = 'no answer'; for (const f of listeners) f(msg, sender, (r) => { got = r; }); return got; };
    return {
      listeners: listeners.length,
      own: ask({ type: 'where' }, { id: 'quell-id' }),
      stranger: ask({ type: 'where' }, { id: 'another-extension' }),
      fromTab: ask({ type: 'where' }, { id: 'quell-id', tab: { id: 3 } }),
      other: ask({ type: 'blocked', count: 2 }, { id: 'quell-id' }),
      empty: ask(null, { id: 'quell-id' }),
    };
  }, { settings: SETTINGS_SRC, common: readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8') });
  ok(answers.listeners === 1, `a second injection does not add a second listener (${answers.listeners})`);
  ok(JSON.stringify(answers.own) === '{"host":"where.test"}', `Quell's popup gets the hostname and nothing else (${JSON.stringify(answers.own)})`);
  ok(answers.stranger === 'no answer', 'a message carrying another extension\'s id is not answered');
  ok(answers.fromTab === 'no answer', 'a message from a tab (a content script, not the popup) is not answered');
  ok(answers.other === 'no answer' && answers.empty === 'no answer', 'any other message is left alone');
  await lone.close();
}

// --- Google clean-web mode: redirects to udm=14 ---
console.log('Google (clean web):');
{
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'cleanweb' }));
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
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
}

// --- Google clean-web mode: verticals exempt, AI Mode redirected ---
console.log('Google (clean web verticals):');
{
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'cleanweb' }));
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
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
}

// --- Gemini selector scoping + badge single-count ---
console.log('Gemini scoping + badge count:');
{
  await sw.evaluate(() => QuellSettings.set({ totalBlocked: 0 }));
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
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block')).display) !== 'none',
    'master off → AI block left alone');
  await sw.evaluate(() => QuellSettings.set({ enabled: true }));
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

// --- Bing: every /copilotsearch entry point goes with Copilot (0.6.0) -------
// Owner decision 2026-09-24: the suggestion chips are hidden TOGETHER with the
// Copilot entry point, under the one Bing switch — each chip routes into
// Copilot, not into a web search. The #b_results guard must still hold: an
// organic result that links to /copilotsearch is a result, not an entry point.
console.log('Bing (Copilot search entry points + chips):');
{
  const page = await ctx.newPage();
  await page.route('https://www.bing.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: BING_FIXTURE }));
  await page.goto('https://www.bing.com/search?q=test');
  const disp = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display, id);
  const vis = (id) => page.evaluate((i) => document.getElementById(i).getClientRects().length > 0, id);
  await page.waitForFunction(() => getComputedStyle(document.getElementById('scope-copilot')).display === 'none')
    .catch(() => {});

  ok(await disp('scope-copilot') === 'none', 'bare Copilot tab in the scope bar hidden by default');
  ok(!(await vis('chip-1')), 'suggestion chip 1 hidden together with Copilot (default)');
  ok(!(await vis('chip-2')), 'suggestion chip 2 hidden together with Copilot (default)');
  ok(await disp('b_copilot_search_container') === 'none', 'the whole chip row is hidden — no empty strip left behind');
  ok(await disp('cs-other') === 'none', 'a /copilotsearch link outside the scope bar and chip row is hidden too');
  ok(await disp('organic-1') !== 'none', 'organic result untouched');
  ok(await vis('organic-copilot-link'),
    'organic result inside #b_results that links to /copilotsearch NOT hidden (containment guard)');

  // The 0.4.2 regression: every Bing selector must carry the #b_results guard,
  // not just the newest ones. Search "copilot" and these ARE the results.
  ok(await disp('org-copilot-a') !== 'none',
    'organic result linking to copilot.microsoft.com NOT hidden');
  ok(await disp('org-card') !== 'none',
    'organic card whose aria-label contains "Copilot" NOT hidden');
  ok(await disp('org-aria') !== 'none',
    'organic link carrying a "Copilot" aria-label NOT hidden');
  ok(await disp('org-plain') !== 'none', 'unrelated organic result untouched');

  // The retired 0.5.0 chip switch must not bring the chips back.
  await sw.evaluate(() => chrome.storage.local.set({ hideBingChips: false }));
  await page.waitForTimeout(300);
  ok(!(await vis('chip-1')), 'a leftover hideBingChips=false from 0.5.0 does NOT un-hide the chips');

  // The one Bing switch releases everything, live, and re-hides it.
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: false }));
  await page.waitForFunction(() => document.getElementById('chip-1').getClientRects().length > 0, null, { timeout: 4000 })
    .catch(() => {});
  ok(await vis('chip-1') && await vis('scope-copilot') && await vis('cs-other'),
    'Bing switch off (in storage.sync) releases chips, tab and entry link on the open page');
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: true }));
  await page.waitForFunction(() => document.getElementById('chip-1').getClientRects().length === 0, null, { timeout: 4000 })
    .catch(() => {});
  ok(!(await vis('chip-1')) && !(await vis('scope-copilot')), 'Bing switch back on re-hides them (live)');

  // Keep AI on this site: the per-site pause for AI surfaces.
  await sw.evaluate(() => QuellSettings.set({ aiAllowlist: ['www.bing.com'] }));
  await page.waitForFunction(() => document.getElementById('b_sydConvCont').getClientRects().length > 0, null, { timeout: 4000 })
    .catch(() => {});
  ok(await vis('b_sydConvCont') && await vis('chip-1'), '"Keep AI on this site" for www.bing.com releases Copilot there (live)');
  await sw.evaluate(() => QuellSettings.set({ aiAllowlist: [] }));
  await page.waitForFunction(() => document.getElementById('b_sydConvCont').getClientRects().length === 0, null, { timeout: 4000 })
    .catch(() => {});
  ok(!(await vis('b_sydConvCont')), 'un-pausing the site hides Copilot again (live)');

  // The Search group switch governs Bing too.
  await sw.evaluate(() => QuellSettings.set({ aiEnabled: false }));
  await page.waitForFunction(() => document.getElementById('b_sydConvCont').getClientRects().length > 0, null, { timeout: 4000 })
    .catch(() => {});
  ok(await vis('b_sydConvCont'), 'Search group switch off releases Bing Copilot (live)');
  await sw.evaluate(() => QuellSettings.set({ aiEnabled: true }));
  await page.close();
}

// --- Cookie layer logic (script injected directly; registration needs a user
//     permission gesture Playwright can't perform) ---
console.log('Cookie layer:');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
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
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'off' }));
  await settle('ai-block', 'block');
  ok(await disp('ai-block') !== 'none', 'mode → off UNHIDES the open page (no reload)');
  ok(await page.evaluate(() => !document.getElementById('quell-google')),
    'stylesheet removed on teardown');
  ok(await page.evaluate(() => !document.querySelector('[data-quell-hidden="1"]')),
    'inline display:none cleared on teardown (stylesheet removal alone is not enough)');

  // off → hide, live
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
  await settle('ai-block', 'none');
  ok(await disp('ai-block') === 'none', 'mode → hide RE-HIDES the open page (no reload)');

  // master switch, live
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await settle('ai-block', 'block');
  ok(await disp('ai-block') !== 'none', 'master off unhides the open page (no reload)');
  await sw.evaluate(() => QuellSettings.set({ enabled: true }));
  await settle('ai-block', 'none');
  ok(await disp('ai-block') === 'none', 'master on re-hides the open page (no reload)');

  // Toggling must not re-inflate the lifetime counter on the same page.
  const t1 = await sw.evaluate(() => chrome.storage.local.get({ totalBlocked: 0 }).then((s) => s.totalBlocked));
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'off' }));
  await settle('ai-block', 'block');
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
  await settle('ai-block', 'none');
  await page.waitForTimeout(600);
  const t2 = await sw.evaluate(() => chrome.storage.local.get({ totalBlocked: 0 }).then((s) => s.totalBlocked));
  ok(t2 === t1, `off→on does NOT double-count the same blocks (${t1} → ${t2})`);
  await page.close();
}

// --- LIVE-APPLY: Clean Web switches both ways without a reload ---
console.log('Live-apply (Clean Web round trip):');
{
  // Waits on STATE, not on a clock (0.6.0 review #3: a fixed 10 s wait on a
  // storage.sync change went 298/2 under load). Each step first proves the
  // content script is live on the page it is about to act on, then waits for
  // the navigation itself. The bound (60 s) only exists so a real failure ends.
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push({ ...e.context, cdp }));
  cdp.on('Runtime.executionContextsCleared', () => { contexts.length = 0; });
  await cdp.send('Runtime.enable');
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  const hiddenNow = () => page.waitForFunction(() => {
    const e = document.getElementById('ai-block');
    return !!e && e.getClientRects().length === 0;
  }, null, { timeout: 60000 }).catch(() => {});
  await page.goto('https://www.google.com/search?q=test');
  await hiddenNow(); // Quell's listener is attached in this document

  const toClean = page.waitForURL(/udm=14/, { timeout: 60000 }).catch(() => {});
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'cleanweb' }));
  await toClean;
  ok(page.url().includes('udm=14'), 'hide → Clean Web redirects the open tab (no reload)');

  // The redirect committed a NEW document, whose content script must be
  // listening before the next change can reach it — otherwise the change
  // lands between documents and the test measures the race, not Quell. Clean
  // Web shows nothing to wait on, so wait for the script itself: Quell's
  // isolated world in the new document, with window.Quell defined (google.js
  // subscribes synchronously in the same injection).
  const listening = await quellWorldReady(page, contexts);
  ok(listening, 'precondition: the redirected document\'s content script is running');
  const back = page.waitForURL((u) => !u.searchParams.has('udm'), { timeout: 60000 }).catch(() => {});
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
  await back;
  ok(!page.url().includes('udm=14'), 'Clean Web → hide returns the tab to the normal SERP');
  await hiddenNow();
  ok(await page.evaluate(() => document.getElementById('ai-block').getClientRects().length === 0),
    '...and hides the AI block there again');
  await page.close();
}

// --- Clean Web undo must NOT hijack a user's own udm=14 ---
console.log('Clean Web undo scoping:');
{
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  // User navigates to udm=14 themselves; Quell never redirected this tab.
  await page.goto('https://www.google.com/search?q=test&udm=14');
  await page.waitForTimeout(500);
  // An unrelated setting changes — must not strip the user's own udm=14.
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: false }));
  await page.waitForTimeout(600);
  ok(page.url().includes('udm=14'),
    "user's own udm=14 preserved (we only undo a redirect we performed)");
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: true }));
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
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: false }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('b_sydConvCont')).display !== 'none',
    null, { timeout: 4000 }).catch(() => {});
  ok(await disp() !== 'none', 'Bing toggle off unhides Copilot on the open page');
  await sw.evaluate(() => QuellSettings.set({ bingEnabled: true }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('b_sydConvCont')).display === 'none',
    null, { timeout: 4000 }).catch(() => {});
  ok(await disp() === 'none', 'Bing toggle on re-hides Copilot on the open page');
  await page.close();
}

// --- LIVE-APPLY: cookie layer reverts in place (seed + scroll-unlock) ---
console.log('Live-apply (cookie layer):');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
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
  ok(await page.evaluate(() => getComputedStyle(document.body).overflow) === 'auto',
    '...and the page scrolls again the second time the same banner is hidden');

  // Sourcepoint's lock is a fixed body, not an overflow: found on spiegel.de and
  // faz.net, where the banner was hidden and the page would not scroll.
  const sp = await ctx.newPage();
  await sp.setViewportSize({ width: 900, height: 600 });
  await sp.route('http://sp-lock.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SP_LOCK_FIXTURE }));
  await sp.goto('http://sp-lock.test/');
  ok(await sp.evaluate(() => getComputedStyle(document.body).position) === 'fixed', 'precondition: the consent tool has the page locked (fixed body)');
  await sp.addScriptTag({ content: stub + '\n' + src });
  await sp.waitForTimeout(400);
  const wheel = async () => { await sp.mouse.move(450, 300); await sp.mouse.wheel(0, 900); await sp.waitForTimeout(300); const y = await sp.evaluate(() => Math.round(scrollY)); await sp.evaluate(() => scrollTo(0, 0)); return y; };
  ok(await sp.evaluate(() => getComputedStyle(document.querySelector('[id^="sp_message_container"]')).display) === 'none', 'Sourcepoint message hidden');
  ok(await sp.evaluate(() => getComputedStyle(document.body).position) === 'relative', "the body is back to the site's own position (not fixed, and not forced to something else)");
  ok(await sp.evaluate(() => document.documentElement.className) === 'site', "only the consent tool's class was taken off <html>");
  ok(await wheel() > 500, 'the page scrolls');
  // The class arriving late (after the message) is lifted too.
  await sp.evaluate(() => document.documentElement.classList.add('sp-message-open'));
  await sp.waitForTimeout(300);
  ok(await sp.evaluate(() => !document.documentElement.classList.contains('sp-message-open')) && await wheel() > 500, 'a lock class added later is lifted as well');
  // Feature off: the banner and the site's own lock both come back, as they were.
  await sp.evaluate(() => window.__quellSet({ cookieEnabled: false }));
  await sp.waitForTimeout(400);
  ok(await sp.evaluate(() => document.documentElement.classList.contains('sp-message-open') && getComputedStyle(document.body).position === 'fixed'
    && getComputedStyle(document.querySelector('[id^="sp_message_container"]')).display !== 'none'), 'feature off puts the banner and its lock back in place');
  await sp.evaluate(() => window.__quellSet({ cookieEnabled: true }));
  await sp.waitForTimeout(400);
  ok(await sp.evaluate(() => getComputedStyle(document.body).position) === 'relative' && await wheel() > 500, 'feature back on: hidden and scrolling again');
  await sp.close();
  // The same class with no consent message on the page is not Quell's to touch.
  const app = await ctx.newPage();
  await app.route('http://sp-class-only.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SP_CLASS_NO_CMP_FIXTURE }));
  await app.goto('http://sp-class-only.test/');
  await app.addScriptTag({ content: stub + '\n' + src });
  await app.waitForTimeout(400);
  ok(await app.evaluate(() => document.documentElement.classList.contains('sp-message-open') && getComputedStyle(document.body).position === 'fixed'),
    'a page with that class and no consent message keeps its own lock');
  await app.close();

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
//
// This harness cannot produce a genuinely occluded/backgrounded tab: CDP
// Emulation.setPageVisibilityOverride is confirmed GONE ("wasn't found", not
// silently ignored), Page.setWebLifecycleState('frozen') does not touch
// document.hidden, window.open()-backgrounding does nothing, and neither does
// dropping Playwright's own --disable-backgrounding-occluded-windows /
// --disable-renderer-backgrounding default launch args. So: stub the two
// globals nextTick() actually reads (document.hidden, requestAnimationFrame)
// directly in the execution context it runs in.
//
// That context is NOT the page's main world — content scripts run in an
// isolated world (window.Quell is invisible from a plain page.evaluate()) —
// so the stub has to go in via CDP Runtime.evaluate({contextId}), targeting
// the isolated-world context whose origin is chrome-extension://... . Poison
// requestAnimationFrame as a no-op that flags a flag but never calls back —
// that IS the observable behavior of "rAF does not fire in a hidden tab".
console.log('Hidden-tab sweep:');
{
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide', enabled: true }));
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (evt) => contexts.push(evt.context));
  await cdp.send('Runtime.enable');

  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForFunction(() =>
    getComputedStyle(document.getElementById('ai-block')).display === 'none').catch(() => {});

  // Locate the extension's own isolated-world execution context.
  let quellContextId = null;
  for (const c of contexts) {
    if (!(c.origin || '').startsWith('chrome-extension://')) continue;
    const r = await cdp.send('Runtime.evaluate', {
      contextId: c.id, expression: 'typeof window.Quell', returnByValue: true,
    }).catch(() => null);
    if (r?.result?.value === 'object') { quellContextId = c.id; break; }
  }

  if (quellContextId == null) {
    // Same "announce loudly" contract as before — if the harness can't even
    // locate the isolated world this run, don't assert blindly.
    skip('hidden-tab sweep', "could not locate the extension's isolated-world execution context via CDP");
  } else {
    // Arm the hidden-tab condition INSIDE the world nextTick() actually runs in.
    await cdp.send('Runtime.evaluate', {
      contextId: quellContextId,
      expression: `(() => {
        Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        window.__quellRafCalled = false;
        window.requestAnimationFrame = () => { window.__quellRafCalled = true; return 0; };
      })()`,
    });

    const precondition = await cdp.send('Runtime.evaluate', {
      contextId: quellContextId, expression: 'document.hidden', returnByValue: true,
    });
    ok(precondition.result.value === true, 'precondition: document.hidden reads true inside the isolated world');

    // Trigger a real DOM mutation — the MutationObserver lives in the
    // isolated world too and reacts regardless of which world wrote the DOM
    // (the DOM is shared; only JS globals are isolated). This element is
    // injected AFTER the hidden-tab stub, so its hiding/counting can only
    // happen via the post-stub code path under test — the initial page-load
    // sweep (which ran before the stub existed) never sees it.
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.className = 'MjjYud'; // label-pass only — NOT in BLOCK_CSS, so this
      div.id = 'ai-block-2';    // can only get hidden via the JS sweep, not CSS.
      div.innerHTML = '<div role="heading">AI Overview</div><p>Second block injected post-load…</p>';
      document.getElementById('rso').appendChild(div);
    });

    await page.waitForFunction(() =>
      getComputedStyle(document.getElementById('ai-block-2')).display === 'none',
      null, { timeout: 3000 }).catch(() => {});

    const rafDiag = await cdp.send('Runtime.evaluate', {
      contextId: quellContextId, expression: 'window.__quellRafCalled', returnByValue: true,
    });
    // Deliberately NOT asserting on the total count of [data-quell-counted]
    // elements — the initial visible-tab sweep (before the stub was
    // installed) already counted ai-block/ai-block-css/gemini-upsell, so
    // that count is > 0 regardless of whether the hidden-tab fallback works
    // at all (a vacuous pass). Assert on ai-block-2's OWN counted flag
    // instead: it can only be set by a sweep that ran after the stub went in.
    ok(await page.evaluate(() => document.getElementById('ai-block-2')?.dataset.quellCounted === '1'),
      'sweep still runs in a hidden tab (second block counted via rAF fallback)');
    ok(await page.evaluate(() => getComputedStyle(document.getElementById('ai-block-2')).display) === 'none',
      'label-pass block hidden in a hidden tab');
    ok(rafDiag.result.value === false,
      'the poisoned, never-firing rAF was never called — nextTick correctly took the setTimeout branch');
  }
  await page.close();
}

// --- Popup renders with defaults (real extension page) ---
console.log('Popup:');
{
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('enabled').checked), 'master toggle reflects enabled');
  ok(await page.evaluate(() => document.getElementById('aiEnabled').checked), 'Search group switch on by default');
  ok(await page.evaluate(() => document.querySelector('input[name="gmode"][value="hide"]').checked), 'google mode radio = hide');
  ok(await page.evaluate(() => document.getElementById('sPaa').checked) === false,
    '"Answers you open in People also ask" is KEPT by default (switch off)');
  ok(await page.evaluate(() => document.getElementById('cookies').checked) === false, 'Cookie banners off by default');
  ok(await page.evaluate(() => document.getElementById('popups').checked) === false, 'Pop-ups off by default');
  ok(await page.evaluate(() => document.getElementById('popupBody').hidden) === true, 'pop-up sub-switches hidden while the group is off');
  // Every switch needs an accessible name — a bare checkbox inside a styled
  // label reads as "checkbox, unchecked" to a screen reader.
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('input, select')]
    .filter((el) => el.type !== 'radio')
    .filter((el) => !(el.labels && [...el.labels].some((l) => l.textContent.trim())) && !el.getAttribute('aria-label'))
    .map((el) => el.id));
  ok(unnamed.length === 0, `every switch and select has a text label (${unnamed.join(',') || 'none unnamed'})`);
  ok(await page.evaluate(() => [...document.querySelectorAll('input[type=checkbox]')].every((x) => x.getAttribute('role') === 'switch')),
    'every checkbox is exposed as role=switch');

  // The engine selects must reflect stored settings, not just render. Every
  // value asserted here is deliberately NOT that select's first <option>.
  await sw.evaluate(() => QuellSettings.set({
    ddgMode: 'off', braveMode: 'hide', yahooMode: 'off',
  }));
  await page.reload();
  await page.waitForTimeout(200);
  const firstOpt = (id) => page.evaluate((x) => document.getElementById(x)?.options[0]?.value, id);
  ok(await firstOpt('ddgMode') === 'clean' && await firstOpt('yahooMode') === 'hide',
    'precondition: asserted values differ from each select\'s first option');
  ok(await page.evaluate(() => document.getElementById('ddgMode')?.value) === 'off',
    'DuckDuckGo select reflects the stored mode');
  ok(await page.evaluate(() => document.getElementById('braveMode')?.value) === 'hide',
    'Brave select reflects the stored mode');
  ok(await page.evaluate(() => document.getElementById('yahooMode')?.value) === 'off',
    'Yahoo select reflects the stored mode');

  ok(await page.evaluate(() => document.getElementById('engines')?.checked) === false,
    'engines switch is off until the hosts are granted');
  ok(await page.evaluate(() => document.getElementById('engineModes')?.hidden) === true,
    'per-engine dropdowns hidden until the hosts are granted');

  await sw.evaluate(() => QuellSettings.set({
    ddgMode: 'hide', braveMode: 'hide', yahooMode: 'hide',
  }));
  ok(await page.evaluate(() => !document.querySelector('#yahooMode option[value="clean"]')),
    'Yahoo offers no "off at the source" option (no such parameter exists)');
  // The popup's own tab is an extension page, not a website: no site card.
  ok(await page.evaluate(() => getComputedStyle(document.getElementById('siteCard')).display) === 'none',
    'site card actually hidden on a non-website tab (computed style, not just attribute)');
  ok(await page.evaluate(() => document.getElementById('rate').href
    .includes('chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho')),
    'Rate Quell links the real store listing');
  ok(await page.evaluate(() => document.getElementById('sponsor').href) === 'https://github.com/sponsors/PurpleDirective',
    'Support Quell links the GitHub Sponsors profile');
  ok(await page.evaluate(() => document.getElementById('privacy').href) === 'https://purpledirective.com/quell/privacy/',
    'Privacy link points at the published policy');
  ok(await page.evaluate(() => !document.getElementById('bChips')),
    'the retired Bing chip switch is gone (chips follow the Bing switch)');
  ok(await page.evaluate(() => document.getElementById('accessNotice').hidden) === true,
    'no "allow Google and Bing" notice on Chromium, where that access is required');

  // Groups collapse to what applies: Google surfaces only in Hide mode.
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'cleanweb' }));
  await page.reload();
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('surfaces').hidden) === true,
    'per-surface switches hidden under Classic results');
  ok(await page.evaluate(() => document.getElementById('gmodeHint').textContent.length) > 0,
    'Classic results explains itself in one line');
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide', aiEnabled: false }));
  await page.reload();
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.getElementById('searchBody').hidden) === true,
    'Search group off collapses its switches');
  await sw.evaluate(() => QuellSettings.set({ aiEnabled: true }));
  await page.reload();
  await page.waitForTimeout(200);

  // Master off reads as off, in words.
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await page.reload();
  await page.waitForTimeout(200);
  ok(/off/i.test(await page.evaluate(() => document.getElementById('pageStatus').textContent)),
    'status line says Quell is off when the master switch is off');
  await sw.evaluate(() => QuellSettings.set({ enabled: true }));
  await page.close();
}

// --- Background wiring: cookie rulesets follow master + feature toggles ---
console.log('Background gating:');
{
  const rulesets = async () => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  await sw.evaluate(() => QuellSettings.set({ cookieEnabled: true }));
  await new Promise((r) => setTimeout(r, 300));
  const on = await rulesets();
  ok(on.includes('cookie_cmp'), 'cookieEnabled → curated network ruleset ON');
  ok(on.includes('cookie_cmp_easylist'), 'cookieEnabled → EasyList network ruleset ON');
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await new Promise((r) => setTimeout(r, 300));
  const off = await rulesets();
  ok(!off.includes('cookie_cmp') && !off.includes('cookie_cmp_easylist'),
    'master off → network rulesets OFF (gating fix)');
  await sw.evaluate(() => QuellSettings.set({ enabled: true, cookieEnabled: false }));
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

// --- Phase 1: solicited vs unsolicited AI ---------------------------------
// The differentiator. An AI Overview above the results is unsolicited; a PAA
// answer is AI the user clicked to see. Google ships them as the same object,
// so the old single switch could not tell them apart and hid both — the
// "this extension broke Google" review that caps every competitor here.
console.log('Google surfaces (PAA vs overview):');
{
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: PAA_FIXTURE }));
  // getComputedStyle on a CHILD of a display:none parent returns the child's
  // OWN display, not 'none' — so a computed-style assertion cannot see a
  // collapse that happened one level up. Ask whether the element actually
  // renders instead; that is also what the user experiences.
  const vis = (id) => page.evaluate(
    (x) => document.getElementById(x).getClientRects().length > 0, id);
  // Wait for the expected state instead of a fixed 300 ms: the settings now
  // travel through storage.sync, whose change events can lag under load.
  const settle = (pairs) => page.waitForFunction((ps) => ps.every(([x, w]) =>
    (document.getElementById(x).getClientRects().length > 0) === w), pairs, { timeout: 5000 }).catch(() => {});

  // Defaults: overview hidden, clicked-open answer kept.
  await sw.evaluate(() => QuellSettings.set({
    enabled: true, googleMode: 'hide',
    hideOverview: true, hideAiMode: true, hidePaa: false, hideGemini: true,
  }));
  await page.goto('https://www.google.com/search?q=widget');
  await settle([['ai-block', false], ['aimode-chip', false], ['gemini-chip', false]]);

  ok(!(await vis('ai-block')), 'unsolicited AI Overview hidden (label pass)');
  ok(!(await vis('attrid-block')), 'unsolicited AI Overview hidden (CSS layer)');
  ok(await vis('paa-answer-1'), 'PAA answer the user clicked open is KEPT (label pass)');
  ok(await vis('paa-attrid-answer'), 'PAA answer carrying data-attrid is KEPT (CSS guard)');
  ok(await vis('organic-normal'), 'organic result untouched');
  ok(!(await vis('ai-block-showmore')),
    'an unsolicited AI Overview carrying a disclosure control is STILL hidden');
  ok(!(await vis('aimode-chip')), 'AI Mode entry point hidden beside an unrelated dropdown');
  ok(!(await vis('gemini-chip')), 'Gemini upsell hidden');

  // Each surface switch must actually govern its own surface.
  await sw.evaluate(() => QuellSettings.set({ hideAiMode: false }));
  await settle([['aimode-chip', true]]);
  ok(await vis('aimode-chip'), 'hideAiMode=false releases the AI Mode entry point');
  ok(!(await vis('ai-block')), 'hideAiMode=false leaves the overview hidden');
  await sw.evaluate(() => QuellSettings.set({ hideAiMode: true, hideGemini: false }));
  await settle([['gemini-chip', true], ['aimode-chip', false]]);
  ok(await vis('gemini-chip'), 'hideGemini=false releases the Gemini upsell');
  await sw.evaluate(() => QuellSettings.set({ hideGemini: true }));
  await settle([['gemini-chip', false]]);

  // Opt in to hiding clicked answers too — live, no reload.
  await sw.evaluate(() => QuellSettings.set({ hidePaa: true }));
  await settle([['paa-answer-1', false], ['paa-attrid-answer', false]]);
  ok(!(await vis('paa-answer-1')), 'hidePaa=true hides the clicked-open answer (live)');
  ok(!(await vis('paa-attrid-answer')),
    'hidePaa=true drops the CSS guard so the data-attrid answer hides too');
  ok(await vis('paa-item-2'),
    'hiding a PAA answer does NOT collapse the other questions');
  ok(await vis('organic-normal'), 'organic result still untouched with hidePaa on');

  // Back off again — the release path, which is what a user toggling in the
  // popup actually exercises.
  await sw.evaluate(() => QuellSettings.set({ hidePaa: false }));
  await settle([['paa-answer-1', true]]);
  ok(await vis('paa-answer-1'), 'turning hidePaa back off releases the answer (live)');

  // Per-surface release: overview off must un-hide the overview and ONLY that.
  await sw.evaluate(() => QuellSettings.set({ hideOverview: false }));
  // storage.sync change events can take longer than local ones; wait for the
  // state rather than a fixed 300 ms.
  await page.waitForFunction(() => document.getElementById('ai-block').getClientRects().length > 0,
    null, { timeout: 3000 }).catch(() => {});
  ok(await vis('ai-block'), 'hideOverview=false releases the overview (live)');
  ok(await vis('attrid-block'), 'hideOverview=false drops the CSS layer too');

  // PAA on with the overview OFF. Both layers must agree here: before the fix
  // blockSelectors() returned nothing at all in this combination, so a clicked
  // answer carrying data-attrid but no label was hidden by neither layer —
  // one answer vanished and the next painted.
  await sw.evaluate(() => QuellSettings.set({ hideOverview: false, hidePaa: true }));
  await settle([['paa-answer-1', false], ['paa-attrid-answer', false]]);
  ok(!(await vis('paa-answer-1')), 'PAA-only: labelled clicked answer hidden');
  ok(!(await vis('paa-attrid-answer')), 'PAA-only: data-attrid clicked answer hidden too');
  ok(await vis('ai-block'), 'PAA-only: the unsolicited overview is left alone');

  await sw.evaluate(() => QuellSettings.set({
    hideOverview: true, hideAiMode: true, hidePaa: false, hideGemini: true,
  }));
  await page.close();
}

// --- Engines: DuckDuckGo, Brave, Yahoo ------------------------------------
// One page PER ENGINE. Clean mode redirects at document_start, and a redirect
// still in flight will interrupt the next engine's navigation — which produced
// a failure that looked like a Brave bug and was actually DuckDuckGo's redirect
// arriving late.
// --- Engines: the host-access GATE, on the real extension -----------------
// DuckDuckGo / Brave / Yahoo are optional hosts. Chrome compares an update's
// REQUIRED host set against what each user already granted — as raw URL
// patterns — and disables the extension until they re-approve. Declaring these
// three in content_scripts would therefore have switched Quell off for every
// existing user on update. These tests hold that door shut.
console.log('Engines — host access gate:');
{
  // Parsed out of background.js rather than restated, so the test cannot drift
  // away from what the extension actually requests and registers.
  const bg = readFileSync(path.join(EXT, 'src/background.js'), 'utf8');
  const arrOf = (name) => {
    const m = bg.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const ENGINE_ORIGINS = arrOf('ENGINE_ORIGINS');
  ok(ENGINE_ORIGINS.length === 5, `background.js declares 5 engine origins (${ENGINE_ORIGINS.length})`);

  const granted = await sw.evaluate((o) => chrome.permissions.contains({ origins: o }), ENGINE_ORIGINS);
  ok(granted === false, 'fresh profile: engine hosts are NOT granted');

  const reg = await sw.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts().then((r) => r.map((x) => x.id)));
  ok(!reg.includes('quell-engines'),
    `no engine content script registered without the grant (${JSON.stringify(reg)})`);

  // ...and prove it by loading the page: with no grant, Quell does nothing at
  // all here. Without this the "organic survives" tests below would pass
  // vacuously on a build that injects nothing.
  const pg = await ctx.newPage();
  await pg.route('https://duckduckgo.com/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
  await pg.goto('https://duckduckgo.com/?q=test').catch(() => {});
  await pg.waitForTimeout(400);
  ok(await pg.evaluate(() => !!document.getElementById('ddg-ai')?.getClientRects().length),
    'without the grant the AI card is left ALONE (extension is inert here)');
  ok(pg.url() === 'https://duckduckgo.com/?q=test',
    `without the grant clean mode cannot redirect (${pg.url()})`);
  await pg.close();
}

// --- The manifest invariant that keeps updates silent ---------------------
console.log('Manifest — required host set is frozen:');
{
  const m = JSON.parse(readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const required = new Set();
  for (const cs of m.content_scripts || []) for (const h of cs.matches) required.add(h);
  for (const h of m.host_permissions || []) required.add(h);

  // Everything required must be a Google or Bing search host — the set the
  // published 0.4.2 already asked for. Anything else is a privilege increase
  // and disables the extension for the whole installed base on update.
  const strays = [...required].filter((h) => !/^\*:\/\/(www\.google\.[a-z.]+|cn\.bing\.com|www\.bing\.com)\//.test(h));
  ok(strays.length === 0, `no required host outside Google/Bing search (${strays.slice(0, 3).join(', ') || 'none'})`);
  ok(required.size === 192, `required host count unchanged from 0.4.2 (${required.size})`);

  const opt = new Set(m.optional_host_permissions || []);
  for (const o of ['*://duckduckgo.com/*', '*://search.brave.com/*', '*://search.yahoo.com/*']) {
    ok(opt.has(o), `${o} is OPTIONAL, not required`);
  }

  // The origin list exists in three places. If they drift, the popup asks for
  // one set, the manifest permits another and the background registers against
  // a third — and the failure is silent: the user grants access and nothing
  // happens, or the switch never reports on.
  const bgSrc = readFileSync(path.join(EXT, 'src/background.js'), 'utf8');
  const popSrc = readFileSync(path.join(EXT, 'src/popup/popup.js'), 'utf8');
  const arr = (src, name) => {
    const mm = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    return mm ? [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const bgOrigins = arr(bgSrc, 'ENGINE_ORIGINS');
  const popOrigins = arr(popSrc, 'ENGINE_ORIGINS');
  const bgMatches = arr(bgSrc, 'ENGINE_MATCHES');
  ok(bgOrigins.length > 0 && JSON.stringify(bgOrigins) === JSON.stringify(popOrigins),
    'popup and background request the SAME engine origins');
  ok(bgOrigins.every((o) => opt.has(o)),
    'every requested engine origin is declared in optional_host_permissions');
  ok(bgMatches.length > 0 && bgMatches.every((mt) => {
    const hostOf = (pat) => pat.replace(/^\*:\/\//, '').split('/')[0];
    return bgOrigins.some((o) => hostOf(o) === hostOf(mt));
  }), 'every registered match is covered by a requested origin');

  // The registered script must carry common.js: engines.js is written against
  // window.Quell and throws without it — a dropped entry breaks every engine
  // while leaving the grant, the switch and the registration all looking fine.
  const regJs = bgSrc.match(/id: ENGINE_SCRIPT_ID,[\s\S]*?js: ([A-Z_]+),/);
  const files = regJs ? arr(bgSrc, regJs[1]) : [];
  ok(files.join(',') === 'src/shared/settings.js,src/content/common.js,src/content/engines.js',
    `the registered engine script injects settings.js, common.js AND engines.js, in that order (${files.join(',')})`);
  ok(/registerContentScripts/.test(bgSrc) && /permissions\.onAdded/.test(bgSrc)
     && /permissions\.onRemoved/.test(bgSrc),
    'background reacts to permission grant AND revocation');
  // Bounded to init()'s OWN body. An unbounded [\s\S]*? matched the call
  // wherever it appeared later in the file, so deleting it from init() left
  // this green — the assertion could not fail.
  const initBody = (() => {
    const i = bgSrc.indexOf('async function init()');
    if (i < 0) return '';
    const end = bgSrc.indexOf('\n}', i);
    return end < 0 ? bgSrc.slice(i) : bgSrc.slice(i, end);
  })();
  ok(initBody.includes('applyEngineScripts()'),
    'init() reconciles engine registration on startup/install');

  // Both halves of the gate, as a literal: intent AND grant. The previous
  // version was an alternation whose first branch matched the storage read
  // alone, so dropping the intent half still passed.
  ok(/const granted = enginesEnabled && hasHosts;/.test(bgSrc),
    'engine registration computes intent AND grant');
  // ...and that the registration branch actually USES it. Asserting only the
  // definition let the branch ignore `granted` and stay green — the same
  // unfailable-assertion defect as the two fixed above, one level down.
  const regBranch = bgSrc.match(/if \((.*?)\) \{\s*\n\s*await chrome\.scripting\.registerContentScripts\(\[\{\s*\n\s*id: ENGINE_SCRIPT_ID/);
  ok(!!regBranch && /\bgranted\b/.test(regBranch[1]),
    `the register branch gates on \`granted\` (${regBranch ? regBranch[1] : 'branch not found'})`);
}

// An <all_urls> grant (which the Cookie-banners feature asks for) semantically
// CONTAINS the engine origins, so a grant-only gate switched these engines on
// for anyone who had enabled cookie blocking, without asking. The stored intent
// is what makes the popup's own off switch work at all in that case.
console.log('Engines — intent is required, not just access:');
{
  await sw.evaluate(() => QuellSettings.set({ enginesEnabled: true }));
  const reg = await sw.evaluate(() =>
    chrome.scripting.getRegisteredContentScripts().then((r) => r.map((x) => x.id)));
  ok(!reg.includes('quell-engines'),
    `intent alone does not register without the grant (${JSON.stringify(reg)})`);

  const pg = await ctx.newPage();
  await pg.goto(`chrome-extension://${extId}/src/popup/popup.html`);
  await pg.waitForTimeout(400);
  ok(await pg.evaluate(() => document.getElementById('engines')?.checked) === false,
    'the switch reads OFF while the hosts are not granted, whatever is stored');
  ok(await pg.evaluate(() => document.getElementById('engineModes')?.hidden) === true,
    'and the dropdowns stay hidden');
  await pg.close();
  await sw.evaluate(() => QuellSettings.set({ enginesEnabled: false }));
  // NOTE: the converse (granted hosts + intent false) cannot be exercised here
  // — Chrome's grant prompt is browser UI Playwright cannot accept. It is
  // covered by the source assertions above, not by execution.
}

// --- Engine behaviour ------------------------------------------------------
// Injected directly with a stubbed chrome, the same convention the cookie-layer
// tests use and for the same reason: these scripts are registered dynamically
// on a permission grant, and Chrome's grant prompt is browser UI that
// Playwright cannot accept. This exercises the real engines.js against the real
// fixtures at the real hostnames; the registration path itself is covered by
// the gate tests above.
console.log('Engines (DuckDuckGo / Brave / Yahoo):');
{
  const commonSrc = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8'));
  const engineSrc = readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  void commonSrc; void engineSrc;
  // sendMessage is RECORDED, not swallowed: the badge count is a user-visible
  // claim ("N elements quelled") and reporting a hard-coded 0 went unnoticed.
  const stub = (over) => `window.__sent=[];window.chrome={storage:{local:{get:async(d)=>({...d,...${JSON.stringify(over)}})},onChanged:{addListener(){}}},runtime:{sendMessage(m){window.__sent.push(m);}}};`;

  // Injects at document_start-equivalent time for the assertions that need it.
  const run = async (glob, body, url, over) => {
    const pg = await ctx.newPage();
    await pg.route(glob, (r) => r.fulfill({ contentType: 'text/html', body }));
    await pg.addInitScript({ content: stub(over) });
    await pg.goto(url).catch(() => {});
    await pg.addScriptTag({ content: commonSrc }).catch(() => {});
    await pg.addScriptTag({ content: engineSrc }).catch(() => {});
    await pg.waitForTimeout(400);
    return pg;
  };
  const visOn = (pg, id) => pg.evaluate(
    (x) => { const e = document.getElementById(x); return !!e && e.getClientRects().length > 0; }, id);

  // --- DuckDuckGo ---
  {
    const pg = await run('https://duckduckgo.com/**', DDG_FIXTURE,
      'https://duckduckgo.com/?q=test', { enabled: true, ddgMode: 'hide' });
    ok(!(await visOn(pg, 'ddg-ai')), 'DDG: Search Assist card hidden');
    ok(await visOn(pg, 'ddg-organic-1'), 'DDG: organic result survives');
    ok(await visOn(pg, 'ddg-organic-trap'),
      'DDG: organic result whose text starts "Search Assist" survives (testid guard)');
    ok(!(await visOn(pg, 'ddg-ai-labelonly')),
      'DDG: an AI card only the LABEL pass can match is hidden (text-resilient layer)');

    // The badge is a claim made to the user; it must reflect what was hidden.
    const sent = await pg.evaluate(() => window.__sent.filter((m) => m?.type === 'blocked'));
    const total = sent.reduce((a, m) => a + (m.count || 0), 0);
    ok(total > 0, `DDG: hidden elements are actually reported for the badge (count ${total})`);
    await pg.close();

    const pg2 = await run('https://duckduckgo.com/**', DDG_FIXTURE,
      'https://duckduckgo.com/?q=test', { enabled: true, ddgMode: 'clean' });
    await pg2.waitForURL(/assist=false/, { timeout: 5000 }).catch(() => {});
    ok(pg2.url().includes('assist=false'), `DDG: clean mode ADDS assist=false (${pg2.url().slice(-22)})`);
    await pg2.close();

    // The finding that made this release FIX-THEN-SHIP. DuckDuckGo has its own
    // "Search Assist" toggle; turning it ON sets ?assist=true. Quell used to
    // rewrite the parameter whenever it was not already 'false', so the
    // engine's own switch flipped straight back and appeared broken. Clean mode
    // may ADD the parameter; it may never overrule a value already there.
    const pg3 = await run('https://duckduckgo.com/**', DDG_FIXTURE,
      'https://duckduckgo.com/?q=test&assist=true', { enabled: true, ddgMode: 'clean' });
    ok(pg3.url().includes('assist=true'),
      `DDG: the user's own assist=true is LEFT ALONE (${pg3.url().slice(-24)})`);
    await pg3.close();

    // Duck.ai — a chat the user opened deliberately. Not a results page.
    const pg4 = await run('https://duckduckgo.com/**', DDG_FIXTURE,
      'https://duckduckgo.com/?q=hello&ia=chat', { enabled: true, ddgMode: 'clean' });
    ok(!pg4.url().includes('assist='),
      `DDG: Duck.ai chat (ia=chat) is NOT rewritten (${pg4.url().slice(-26)})`);
    await pg4.close();

    // The homepage is not a results page: no q, no rewrite. Redirecting the
    // bare homepage would be Quell reaching well past what it was asked to do.
    const pg5 = await run('https://duckduckgo.com/**', DDG_FIXTURE,
      'https://duckduckgo.com/', { enabled: true, ddgMode: 'clean' });
    ok(!pg5.url().includes('assist='),
      `DDG: the homepage (no q) is NOT rewritten (${pg5.url()})`);
    await pg5.close();
  }

  // The clean-mode undo mark, across a whole tab's history. Clean mode records
  // the URL it produced so that leaving clean mode can undo its own redirect —
  // but a mark that merely says "we redirected once in this tab" outlives the
  // page it belongs to, and the next mode change then strips a parameter the
  // USER set. sessionStorage is per-tab, so this has to be one page throughout.
  {
    const pg = await ctx.newPage();
    await pg.route('https://duckduckgo.com/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
    // The mode lives in sessionStorage, not on window: clean mode navigates, and
    // a fresh document would reset a window-level flag mid-test.
    await pg.addInitScript({ content: `window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,ddgMode:(sessionStorage.getItem('__mode')||'clean')})},onChanged:{addListener(cb){window.__cb=cb;}}},runtime:{sendMessage(){}}};` });
    await pg.addInitScript({ content: commonSrc });
    await pg.addInitScript({ content: engineSrc });

    await pg.goto('https://duckduckgo.com/?q=a').catch(() => {});
    await pg.waitForURL(/assist=false/, { timeout: 5000 }).catch(() => {});
    ok(pg.url().includes('assist=false'), `flag: clean mode redirected once (${pg.url().slice(-20)})`);

    // The user searches again, this time with their OWN assist=true.
    await pg.goto('https://duckduckgo.com/?q=b&assist=true').catch(() => {});
    await pg.waitForTimeout(300);
    ok(pg.url().includes('assist=true'), `flag: the user's assist=true survives (${pg.url().slice(-20)})`);

    // ...and again with their own assist=false, which happens to equal the
    // value clean mode would have set. Indistinguishable by URL alone.
    await pg.goto('https://duckduckgo.com/?q=c&assist=false').catch(() => {});
    await pg.waitForTimeout(300);

    // Now leave clean mode LIVE, the way the popup does — undoClean only runs on
    // a live change, so switching by reload would not exercise it at all.
    // undoClean must NOT touch this page: Quell did not put that parameter here.
    await pg.waitForLoadState('load').catch(() => {});
    await pg.waitForTimeout(300);
    await pg.evaluate(() => {
      sessionStorage.setItem('__mode', 'hide');
      window.__cb?.({ ddgMode: { newValue: 'hide' } }, 'local');
    });
    await pg.waitForTimeout(700);
    ok(pg.url().includes('assist=false'),
      `flag: a user-set parameter is NOT deleted on leaving clean mode (${pg.url().slice(-22)})`);
    await pg.close();
  }

  // The counterpart: Quell's OWN redirect is still undone when clean mode is
  // left on the page it produced. Without this the fix above could just be
  // "never undo anything".
  {
    const pg = await ctx.newPage();
    await pg.route('https://duckduckgo.com/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
    await pg.addInitScript({ content: `window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,ddgMode:(sessionStorage.getItem('__mode')||'clean')})},onChanged:{addListener(cb){window.__cb=cb;}}},runtime:{sendMessage(){}}};` });
    await pg.addInitScript({ content: commonSrc });
    await pg.addInitScript({ content: engineSrc });
    await pg.goto('https://duckduckgo.com/?q=a').catch(() => {});
    await pg.waitForURL(/assist=false/, { timeout: 5000 }).catch(() => {});

    // Flip the mode live, the way the popup does. Settle first: clean mode's
    // redirect commits a new document, and the listener we want belongs to it.
    await pg.waitForLoadState('load').catch(() => {});
    await pg.waitForTimeout(300);
    await pg.evaluate(() => {
      sessionStorage.setItem('__mode', 'hide');
      window.__cb?.({ ddgMode: { newValue: 'hide' } }, 'local');
    });
    await pg.waitForURL((u) => !u.href.includes('assist='), { timeout: 5000 }).catch(() => {});
    ok(!pg.url().includes('assist='),
      `flag: Quell's own redirect IS undone on the page it produced (${pg.url().slice(-18)})`);
    await pg.close();
  }

  // --- Brave ---
  {
    const pg = await run('https://search.brave.com/**', BRAVE_FIXTURE,
      'https://search.brave.com/search?q=test', { enabled: true, braveMode: 'hide' });
    ok(!(await visOn(pg, 'llm-snippet')), 'Brave: llm-snippet hidden');
    ok(await visOn(pg, 'brave-organic-1'), 'Brave: organic result survives');
    ok(await visOn(pg, 'brave-organic-trap'),
      'Brave: organic result carrying a "Good response" aria-label survives (#mixed-main guard)');
    await pg.close();

    const pg2 = await run('https://search.brave.com/**', BRAVE_FIXTURE,
      'https://search.brave.com/search?q=test', { enabled: true, braveMode: 'clean' });
    await pg2.waitForURL(/summary=0/, { timeout: 5000 }).catch(() => {});
    ok(pg2.url().includes('summary=0'), `Brave: clean mode ADDS summary=0 (${pg2.url().slice(-18)})`);
    await pg2.close();

    // /ask is Brave's explicit AI page and /images is a different vertical —
    // clean mode redirected both, because the only guard was "has a q param".
    const pg3 = await run('https://search.brave.com/**', BRAVE_FIXTURE,
      'https://search.brave.com/ask?q=test&source=web', { enabled: true, braveMode: 'clean' });
    ok(!pg3.url().includes('summary=0'),
      `Brave: /ask (the explicit AI page) is NOT rewritten (${pg3.url().slice(-24)})`);
    await pg3.close();

    const pg4 = await run('https://search.brave.com/**', BRAVE_FIXTURE,
      'https://search.brave.com/images?q=test', { enabled: true, braveMode: 'clean' });
    ok(!pg4.url().includes('summary=0'),
      `Brave: /images is NOT rewritten (${pg4.url().slice(-22)})`);
    await pg4.close();

    // The user's own summary=1 must survive, exactly as on DDG.
    const pg5 = await run('https://search.brave.com/**', BRAVE_FIXTURE,
      'https://search.brave.com/search?q=test&summary=1', { enabled: true, braveMode: 'clean' });
    ok(pg5.url().includes('summary=1'),
      `Brave: the user's own summary=1 is LEFT ALONE (${pg5.url().slice(-20)})`);
    await pg5.close();
  }

  // --- Yahoo (hide only — no native parameter exists, and none is faked) ---
  {
    const pg = await run('https://search.yahoo.com/**', YAHOO_FIXTURE,
      'https://search.yahoo.com/search?p=test', { enabled: true, yahooMode: 'hide' });
    ok(!(await visOn(pg, 'yahoo-ai')), 'Yahoo: AI Summary block hidden');
    ok(await visOn(pg, 'yahoo-organic-1'), 'Yahoo: organic result survives');
    ok(await visOn(pg, 'yahoo-organic-trap'),
      'Yahoo: the REAL britannica.com organic result survives (citation-chip trap)');
    ok(!(await visOn(pg, 'yahoo-scout-nav')), 'Yahoo: the "Yahoo Scout" AI tab is hidden');
    ok(!(await visOn(pg, 'scoutPromoTooltip')), 'Yahoo: the "Try Yahoo Scout" promo is hidden');
    ok(!(await visOn(pg, 'yahoo-scout-explore')), 'Yahoo: the right-rail "Explore AI results with Yahoo Scout" panel is hidden');
    ok(await visOn(pg, 'yahoo-organic-scout'),
      'Yahoo: an ORGANIC result linking to scout.yahoo.com survives (organic guard)');
    ok(await visOn(pg, 'yahoo-right-kp'), 'Yahoo: a right-rail panel that is not Scout survives');
    ok(!(await visOn(pg, 'yahoo-also-try')), 'Yahoo: the footer "Explore AI results with Yahoo Scout" Also-try block is hidden');
    ok(await visOn(pg, 'yahoo-also-try-plain'), 'Yahoo: a plain "Also try" footer with no Scout title survives');
    ok(await visOn(pg, 'yahoo-nav-news'), 'Yahoo: the other vertical tabs survive');
    await pg.close();

    const off = await run('https://search.yahoo.com/**', YAHOO_FIXTURE,
      'https://search.yahoo.com/search?p=test', { enabled: true, yahooMode: 'off' });
    ok(await visOn(off, 'yahoo-ai'), 'Yahoo: mode off leaves the AI Summary alone');
    ok(await visOn(off, 'yahoo-scout-explore') && await visOn(off, 'yahoo-scout-nav') && await visOn(off, 'yahoo-also-try'),
      'Yahoo: mode off leaves Yahoo Scout alone too');
    await off.close();

    // Regional Yahoo: the manifest grants *.search.yahoo.com, but the config
    // was looked up by exact hostname, so uk./fr./de. injected and then did
    // nothing at all while the popup still showed Yahoo as handled.
    for (const h of ['uk.search.yahoo.com', 'fr.search.yahoo.com']) {
      const rp = await run(`https://${h}/**`, YAHOO_FIXTURE,
        `https://${h}/search?p=test`, { enabled: true, yahooMode: 'hide' });
      ok(!(await visOn(rp, 'yahoo-ai')), `Yahoo: ${h} is handled too (regional suffix match)`);
      ok(await visOn(rp, 'yahoo-organic-1'), `Yahoo: ${h} organic result survives`);
      await rp.close();
    }
  }
}

// --- Reject-all: opt-in, and strictly CMP-scoped ---------------------------
// Injected directly with a stubbed chrome, like the other cookie-layer tests:
// dynamic registration needs a permission gesture Playwright cannot perform.
// Each case gets its OWN page, because cookies.js guards against double
// injection and a second addScriptTag in the same page returns early.
console.log('Cookie reject-all (opt-in):');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  const stubFor = (reject) =>
    `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:${reject}})}},runtime:{sendMessage(){}}};`;

  // Same runner, any fixture — each case gets its own page.
  const runOn = async (reject, body, wait = 500) => {
    const page = await ctx.newPage();
    await page.route('http://reject-fixture.test/**', (r) =>
      r.fulfill({ contentType: 'text/html', body }));
    await page.goto('http://reject-fixture.test/');
    await page.addScriptTag({ content: stubFor(reject) + '\n' + src });
    await page.waitForTimeout(wait);
    return page;
  };

  const run = async (reject) => {
    const page = await ctx.newPage();
    await page.route('http://reject-fixture.test/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: REJECT_FIXTURE }));
    await page.goto('http://reject-fixture.test/');
    await page.addScriptTag({ content: stubFor(reject) + '\n' + src });
    await page.waitForTimeout(500);
    const out = {
      rejected: await page.evaluate(() => document.body.dataset.rejected === '1'),
      decoy: await page.evaluate(() => document.body.dataset.decoyClicked === '1'),
      hidden: await page.evaluate(() =>
        getComputedStyle(document.getElementById('onetrust-banner-sdk')).display === 'none'),
    };
    await page.close();
    return out;
  };

  const off = await run(false);
  ok(off.hidden, 'reject-all OFF: the banner is still hidden');
  ok(!off.rejected, 'reject-all OFF by default: the Reject button is NOT clicked');
  ok(!off.decoy, 'reject-all OFF: the decoy is not clicked either');

  const on = await run(true);
  ok(on.rejected, "reject-all ON: the CMP's own Reject-all button is clicked");
  ok(on.hidden, 'reject-all ON: hiding still applies as the fallback');
  ok(!on.decoy, "reject-all ON: the page's own unrelated Reject button is NEVER clicked");

  // The tag/role gate: a <div> carrying a CMP reject class is not a control.
  {
    const pg = await runOn(true, NONCONTROL_FIXTURE);
    ok(!(await pg.evaluate(() => document.body.dataset.divClicked === '1')),
      'a <div> matching a reject selector is NEVER clicked (control gate)');
    ok(await pg.evaluate(() => document.body.dataset.rejected === '1'),
      'the gate SKIPS the non-control and still finds the real button');
    await pg.close();
  }

  // A CMP that re-renders and KEEPS showing its banner has not confirmed
  // anything (0.6.0: a disconnect is not a confirmation). The retry ladder
  // continues on the replacement node — and is still bounded.
  {
    const pg = await runOn(true, RERENDER_FIXTURE, 3500);
    const clicks = await pg.evaluate(() => window.__clicks || 0);
    ok(clicks === 3, `a CMP that re-renders and keeps asking is clicked at most MAX_CLICKS times (${clicks})`);
    await pg.close();
  }

  // Pre-consented CMP left in the DOM at display:none — nothing to click.
  {
    const pg = await runOn(true, HIDDENCMP_FIXTURE);
    ok(!(await pg.evaluate(() => document.body.dataset.rejected === '1')),
      'an already-hidden banner is NOT clicked (visibility gate)');
    await pg.close();
  }

  // Quantcast: "MORE OPTIONS" and the reject button are BOTH mode="secondary"
  // and their order varies per site, so there is nothing safe to click from a
  // content script. Quell must click nothing here and fall back to hiding —
  // a wrong click on a consent banner is not recoverable.
  {
    const pg = await runOn(true, QUANTCAST_FIXTURE);
    const clicked = await pg.evaluate(() => document.body.dataset.clicked || 'none');
    ok(clicked === 'none', `Quantcast's ambiguous summary buttons are NOT clicked (clicked: ${clicked})`);
    await pg.close();
  }

  // The regression that the "inject after the banner exists" fixtures all miss:
  // Quell hides the SEED selectors at document_start, so a CMP arriving later
  // is behind Quell's OWN display:none by the time the visibility gate looks at
  // it. Measuring through our own stylesheet turned reject into a silent no-op
  // on the ordinary path while the store listing said it clicked.
  {
    const page = await ctx.newPage();
    await page.route('http://reject-fixture.test/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: LATECMP_FIXTURE }));
    // addInitScript runs before page scripts — document_start equivalent.
    await page.addInitScript({ content: stubFor(true) + '\n' + src });
    await page.goto('http://reject-fixture.test/');
    await page.waitForTimeout(1200);
    ok(await page.evaluate(() => document.body.dataset.rejected === '1'),
      'a CMP that injects AFTER Quell hid the page is still rejected (real ordering)');
    ok(await page.evaluate(() => {
      const b = document.getElementById('onetrust-banner-sdk');
      return !!b && getComputedStyle(b).display === 'none';
    }), 'and it is hidden as well');
    await page.close();
  }

  // The layer the stylesheet-toggling gate could not see. Quell hides through
  // three sheets, and rules/cookie-generic.css is injected natively by Chrome
  // for the registered script — not reachable from the page at all. A banner
  // hidden by a STYLESHEET (whichever of ours it is) must still be clicked;
  // only the SITE's own inline/attribute hiding means "already dismissed".
  {
    const STYLED = `<!doctype html><html><head><style>
      #onetrust-banner-sdk{display:none!important;visibility:hidden!important;}
    </style></head><body><div id="onetrust-banner-sdk">We use cookies!
      <button id="onetrust-reject-all-handler"
        onclick="document.body.dataset.rejected='1'">Reject All</button>
    </div></body></html>`;
    const pg = await runOn(true, STYLED);
    ok(await pg.evaluate(() => document.body.dataset.rejected === '1'),
      'a banner hidden by a STYLESHEET is still rejected (our own layers do not block us)');
    await pg.close();
  }

  // ...and the site's own attribute hiding still counts as "already dismissed".
  for (const [attr, markup] of [
    ['hidden attribute', '<div id="onetrust-banner-sdk" hidden>'],
    ['aria-hidden', '<div id="onetrust-banner-sdk" aria-hidden="true">'],
  ]) {
    const FX = `<!doctype html><html><body>${markup}
      <button id="onetrust-reject-all-handler"
        onclick="document.body.dataset.rejected='1'">Reject All</button>
    </div></body></html>`;
    const pg = await runOn(true, FX);
    ok(!(await pg.evaluate(() => document.body.dataset.rejected === '1')),
      `a banner the site hid via ${attr} is NOT clicked`);
    await pg.close();
  }

  // ...while a banner the SITE hid stays unclicked, under that same ordering.
  {
    const page = await ctx.newPage();
    await page.route('http://reject-fixture.test/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: HIDDENCMP_FIXTURE }));
    await page.addInitScript({ content: stubFor(true) + '\n' + src });
    await page.goto('http://reject-fixture.test/');
    await page.waitForTimeout(900);
    ok(!(await page.evaluate(() => document.body.dataset.rejected === '1')),
      'a banner the SITE hid is still NOT clicked at document_start (gate still real)');
    await page.close();
  }
}


// --- Popup: the engines switch, executed against a recording chrome --------
// The real popup, served over http so an init script can install a fake
// `chrome` BEFORE popup.js runs. Chrome's grant prompt cannot be accepted by
// Playwright, so the real-extension popup tests above can only see the
// "hosts not granted" state; here permissions.request answers whatever the
// case says, and every storage/permissions call is recorded in order.
console.log('Popup — engines switch (intent path / off path):');
{
  const popupDir = path.join(EXT, 'src/popup');
  const html = readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
  const js = readFileSync(path.join(popupDir, 'popup.js'), 'utf8');
  const css = readFileSync(path.join(popupDir, 'popup.css'), 'utf8');
  // What the popup itself asks for — parsed from its source, not restated.
  const POPUP_ORIGINS = (() => {
    const m = js.match(/const ENGINE_ORIGINS = \[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  })();
  ok(POPUP_ORIGINS.length === 5, `popup.js declares 5 engine origins (${POPUP_ORIGINS.length})`);

  // `granted` is the fake's current grant state; request() flips it to true
  // only when the case allows the grant, remove() flips it back.
  const fakeChrome = ({ storage, granted, allowGrant }) => `
    window.__calls = [];
    window.__state = { granted: ${granted}, local: ${JSON.stringify(storage)} };
    window.chrome = {
      runtime: { id: 'fake' },
      storage: { local: {
        get: async (d) => ({ ...d, ...window.__state.local }),
        set: async (o) => { Object.assign(window.__state.local, o); window.__calls.push(['storage.set', o]); },
      } },
      permissions: {
        contains: async () => window.__state.granted,
        request: async ({ origins }) => {
          window.__calls.push(['permissions.request', origins]);
          if (${allowGrant}) window.__state.granted = true;
          return ${allowGrant};
        },
        remove: async ({ origins }) => {
          window.__calls.push(['permissions.remove', origins]);
          window.__state.granted = false;
          return true;
        },
      },
      tabs: { query: async () => [] },
    };`;

  const openPopup = async (opts) => {
    const pg = await ctx.newPage();
    await pg.route('http://popup.test/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('popup.js')) return r.fulfill({ contentType: 'text/javascript', body: js });
      if (u.pathname.endsWith('/shared/settings.js')) return r.fulfill({ contentType: 'text/javascript', body: SETTINGS_SRC });
      if (u.pathname.endsWith('/shared/report-host.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/report-host.js'), 'utf8') });
      if (u.pathname.endsWith('/shared/config.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/config.js'), 'utf8') });
      if (u.pathname.endsWith('/shared/browser.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/browser.js'), 'utf8') });
      if (u.pathname.endsWith('popup.css')) return r.fulfill({ contentType: 'text/css', body: css });
      return r.fulfill({ contentType: 'text/html', body: html });
    });
    await pg.addInitScript({ content: fakeChrome(opts) });
    await pg.goto('http://popup.test/popup.html');
    await pg.waitForTimeout(300);
    return pg;
  };
  const calls = (pg) => pg.evaluate(() => window.__calls);
  const checked = (pg) => pg.evaluate(() => document.getElementById('engines').checked);
  const modesHidden = (pg) => pg.evaluate(() => document.getElementById('engineModes').hidden);

  // Intent path, grant ACCEPTED.
  {
    const pg = await openPopup({ storage: { enginesEnabled: false }, granted: false, allowGrant: true });
    ok((await checked(pg)) === false && (await modesHidden(pg)) === true,
      'starts off with the dropdowns hidden');
    await pg.click('#engines');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    const req = c.findIndex(([n]) => n === 'permissions.request');
    const set = c.findIndex(([n, o]) => n === 'storage.set' && o.enginesEnabled === true);
    ok(req >= 0 && JSON.stringify(c[req][1]) === JSON.stringify(POPUP_ORIGINS),
      'switching on asks Chrome for exactly the declared engine origins');
    ok(set >= 0 && set > req,
      `the intent is stored AFTER the grant comes back, not before (request@${req}, set@${set})`);
    ok((await checked(pg)) === true, 'the switch stays on after the grant');
    ok((await modesHidden(pg)) === false, 'the per-engine dropdowns appear once granted');
    ok(!c.some(([n]) => n === 'permissions.remove'), 'switching on never calls permissions.remove');
    await pg.close();
  }

  // Intent path, grant REFUSED.
  {
    const pg = await openPopup({ storage: { enginesEnabled: false }, granted: false, allowGrant: false });
    await pg.click('#engines');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    ok(c.some(([n]) => n === 'permissions.request'), 'a refused grant was at least asked for');
    ok(!c.some(([n, o]) => n === 'storage.set' && 'enginesEnabled' in o),
      'a refused grant stores NO intent (nothing for a later <all_urls> grant to resurrect)');
    ok((await checked(pg)) === false, 'the switch springs back off when Chrome refuses');
    ok((await modesHidden(pg)) === true, 'and the dropdowns stay hidden');
    await pg.close();
  }

  // Off path: intent cleared FIRST, then the hosts revoked.
  {
    const pg = await openPopup({ storage: { enginesEnabled: true }, granted: true, allowGrant: true });
    ok((await checked(pg)) === true && (await modesHidden(pg)) === false,
      'starts on with the dropdowns shown (intent + grant)');
    await pg.click('#engines');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    const set = c.findIndex(([n, o]) => n === 'storage.set' && o.enginesEnabled === false);
    const rem = c.findIndex(([n]) => n === 'permissions.remove');
    ok(set >= 0, 'switching off clears the stored intent');
    ok(rem >= 0 && JSON.stringify(c[rem][1]) === JSON.stringify(POPUP_ORIGINS),
      'switching off REVOKES the engine hosts (not merely forgets them)');
    ok(set >= 0 && rem >= 0 && set < rem,
      `intent is cleared BEFORE the revoke (set@${set}, remove@${rem}) — remove() cannot revoke an <all_urls> grant, so the flag is what turns it off`);
    ok(!c.some(([n]) => n === 'permissions.request'), 'switching off never asks for a grant');
    ok((await checked(pg)) === false && (await modesHidden(pg)) === true,
      'reads off with the dropdowns hidden afterwards');
    await pg.close();
  }
}

// --- Popup: all-sites access is given back (owner decision 2026-09-25) ----
// The real popup against a recording chrome that models Chrome's permission
// semantics: contains() is semantic (<all_urls> covers every origin);
// remove(<all_urls>) takes every granted host with it (a semantic
// intersection), but keeps them in the "soft" granted set, so asking again
// does not prompt. A request that would need the browser's dialog is logged
// as 'prompt'.
console.log('Popup — all-sites access is given back when Cookie banners and Pop-ups are both off:');
{
  const popupDir = path.join(EXT, 'src/popup');
  const html = readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
  const js = readFileSync(path.join(popupDir, 'popup.js'), 'utf8');
  const css = readFileSync(path.join(popupDir, 'popup.css'), 'utf8');
  const ENG = (() => {
    const m = js.match(/const ENGINE_ORIGINS = \[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  })();
  const fake = ({ local, granted, soft = [], allowGrant = true }) => `
    window.__calls = [];
    const st = window.__st = { granted: new Set(${JSON.stringify(granted)}), soft: new Set(${JSON.stringify(soft)}),
      local: ${JSON.stringify(local)}, session: {} };
    const covers = (o) => st.granted.has(o) || st.granted.has('<all_urls>');
    window.chrome = {
      runtime: { id: 'fake' },
      storage: {
        local: {
          get: async (d) => ({ ...d, ...st.local }),
          set: async (o) => { Object.assign(st.local, o); window.__calls.push(['storage.set', o]); },
        },
        session: {
          get: async (d) => ({ ...d, ...st.session }),
          set: async (o) => { Object.assign(st.session, o); window.__calls.push(['session.set', o]); },
          remove: async (k) => { delete st.session[k]; window.__calls.push(['session.remove', k]); },
        },
      },
      permissions: {
        contains: async ({ origins }) => (origins || []).length > 0 && origins.every(covers),
        request: async ({ origins }) => {
          window.__calls.push(['permissions.request', origins]);
          const silent = origins.every((o) => covers(o) || st.soft.has(o));
          if (!silent) window.__calls.push(['prompt', origins]);
          if (!${allowGrant}) return false;
          for (const o of origins) { st.granted.add(o); st.soft.delete(o); }
          return true;
        },
        remove: async ({ origins }) => {
          window.__calls.push(['permissions.remove', origins]);
          const all = origins.includes('<all_urls>');
          for (const o of [...st.granted]) if (all || origins.includes(o)) { st.granted.delete(o); st.soft.add(o); }
          return true;
        },
      },
      tabs: { query: async () => [] },
    };`;
  const open = async (opts) => {
    const pg = await ctx.newPage();
    await pg.route('http://popup.test/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('popup.js')) return r.fulfill({ contentType: 'text/javascript', body: js });
      if (u.pathname.endsWith('/shared/settings.js')) return r.fulfill({ contentType: 'text/javascript', body: SETTINGS_SRC });
      if (u.pathname.endsWith('/shared/report-host.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/report-host.js'), 'utf8') });
      if (u.pathname.endsWith('/shared/config.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/config.js'), 'utf8') });
      if (u.pathname.endsWith('/shared/browser.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/browser.js'), 'utf8') });
      if (u.pathname.endsWith('popup.css')) return r.fulfill({ contentType: 'text/css', body: css });
      return r.fulfill({ contentType: 'text/html', body: html });
    });
    await pg.addInitScript({ content: fake(opts) });
    await pg.goto('http://popup.test/popup.html');
    await pg.waitForTimeout(300);
    return pg;
  };
  const calls = (pg) => pg.evaluate(() => window.__calls);
  const idx = (c, name, pred = () => true) => c.findIndex(([n, a]) => n === name && pred(a));
  const granted = (pg) => pg.evaluate(() => [...window.__st.granted]);
  const info = (pg) => pg.evaluate(() => { const el = document.getElementById('infoLine'); return el.hidden ? '' : el.textContent; });
  const isAll = (a) => JSON.stringify(a) === '["<all_urls>"]';

  // Last one off → the access goes back, AFTER the switch is saved off.
  for (const [id, key] of [['cookies', 'cookieEnabled'], ['popups', 'popupsEnabled']]) {
    const pg = await open({ local: { [key]: true }, granted: ['<all_urls>'] });
    await pg.click('#' + id);
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    const set = idx(c, 'storage.set', (o) => o[key] === false);
    const rem = idx(c, 'permissions.remove', isAll);
    ok(set >= 0 && rem > set, `${id} off (the other already off): saved off, THEN <all_urls> removed (set@${set}, remove@${rem})`);
    ok(!(await granted(pg)).includes('<all_urls>'), `${id} off: the access is actually gone`);
    ok(idx(c, 'permissions.request') < 0, `${id} off: nothing is asked for`);
    ok(/gave back its access to all sites/.test(await info(pg)), `${id} off: the popup says so, in words`);
    ok(!(await pg.evaluate((i) => document.getElementById(i).checked, id)), `${id} off: the switch reads off`);
    await pg.close();
  }

  // Never while either one is still on.
  {
    const pg = await open({ local: { cookieEnabled: true, popupsEnabled: true }, granted: ['<all_urls>'] });
    await pg.click('#cookies');
    await pg.waitForTimeout(300);
    ok(idx(await calls(pg), 'permissions.remove') < 0 && (await granted(pg)).includes('<all_urls>'),
      'Cookie banners off while Pop-ups is still on: the access is KEPT');
    await pg.close();
  }
  // The master switch is a pause, not a release.
  {
    const pg = await open({ local: { cookieEnabled: true }, granted: ['<all_urls>'] });
    await pg.click('#enabled');
    await pg.waitForTimeout(200);
    await pg.click('#confirmYes');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    ok(idx(c, 'storage.set', (o) => o.enabled === false) >= 0 && idx(c, 'permissions.remove') < 0,
      'switching Quell itself off keeps the access (it is a pause)');
    await pg.close();
  }

  // Switching one back on asks again — from that click, first thing.
  {
    const pg = await open({ local: { cookieEnabled: false, popupsEnabled: false }, granted: [], soft: ['<all_urls>'] });
    await pg.click('#popups');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    const req = idx(c, 'permissions.request', isAll);
    const set = idx(c, 'storage.set', (o) => o.popupsEnabled === true);
    ok(req === 0, `re-enabling asks for <all_urls> as the click's FIRST call (request@${req})`);
    ok(set > req, 'and the switch is saved on only after the grant');
    ok(await pg.evaluate(() => document.getElementById('popups').checked), 'the switch reads on');
    await pg.close();
  }
  {
    const pg = await open({ local: { cookieEnabled: false, popupsEnabled: false }, granted: [], allowGrant: false });
    await pg.click('#cookies');
    await pg.waitForTimeout(300);
    const c = await calls(pg);
    ok(idx(c, 'permissions.request', isAll) === 0 && idx(c, 'storage.set', (o) => 'cookieEnabled' in o) < 0,
      're-enabling with the grant refused: nothing saved');
    ok(!(await pg.evaluate(() => document.getElementById('cookies').checked)), 'and the switch springs back off');
    await pg.close();
  }

  // The engines ride on <all_urls> in Chrome: keep them, silently.
  {
    const pg = await open({ local: { cookieEnabled: true, enginesEnabled: true }, granted: ['<all_urls>', ...ENG] });
    await pg.click('#cookies');
    await pg.waitForTimeout(400);
    const c = await calls(pg);
    const mark = idx(c, 'session.set', (o) => typeof o.quellReleasingAllSites === 'number');
    const rem = idx(c, 'permissions.remove', isAll);
    const req = idx(c, 'permissions.request', (o) => JSON.stringify(o) === JSON.stringify(ENG));
    ok(mark >= 0 && rem > mark, `the release is marked as Quell's own BEFORE the removal (mark@${mark}, remove@${rem})`);
    ok(req > rem, `the engine hosts are asked for again after the removal (request@${req})`);
    ok(idx(c, 'prompt') < 0, 'and that re-ask needs no browser prompt (Chrome keeps them granted)');
    ok(idx(c, 'storage.set', (o) => o.enginesEnabled === false) < 0, 'the engines intent is not touched');
    const g = await granted(pg);
    ok(!g.includes('<all_urls>') && ENG.every((o) => g.includes(o)), 'end state: engine hosts held, all-sites access gone');
    ok(await pg.evaluate(() => document.getElementById('engines').checked), 'the engines switch still reads on');
    ok(/keeps access to Google, Bing, DuckDuckGo/.test(await info(pg)), 'and the popup says which access it kept');
    await pg.close();
  }
  // ...and where they cannot come back without the user (Firefox), say so.
  {
    const pg = await open({ local: { popupsEnabled: true, enginesEnabled: true }, granted: ['<all_urls>'], allowGrant: false });
    await pg.click('#popups');
    await pg.waitForTimeout(400);
    const c = await calls(pg);
    ok(idx(c, 'storage.set', (o) => o.enginesEnabled === false) >= 0,
      'engines could not be kept: their switch is turned off rather than left reading on');
    ok(/DuckDuckGo, Brave and Yahoo were using it/.test(await info(pg)), 'and the popup explains why, and how to get them back');
    ok(!(await pg.evaluate(() => document.getElementById('engines').checked)), 'the engines switch reads off');
    await pg.close();
  }
  // Engines on with their own hosts still granted afterwards: no re-ask.
  {
    // (Firefox keeps explicitly granted engine hosts when <all_urls> goes.)
    const pg = await open({ local: { cookieEnabled: true, enginesEnabled: true }, granted: ['<all_urls>', ...ENG] });
    await pg.evaluate((eng) => {
      const rm = window.chrome.permissions.remove;
      window.chrome.permissions.remove = async (o) => { await rm(o); for (const e of eng) window.__st.granted.add(e); return true; };
    }, ENG);
    await pg.click('#cookies');
    await pg.waitForTimeout(400);
    const c = await calls(pg);
    ok(idx(c, 'permissions.request') < 0, 'engine hosts that survive the removal are not asked for again');
    await pg.close();
  }
}

// --- engines.js: the double-injection guard ---------------------------------
// The background injects into already-open tabs the moment the hosts are
// granted, and those tabs may already be running the registered copy. A
// second copy that re-registered its settings listener would apply state
// twice per toggle — and tear down what the first copy just applied.
console.log('Engines — double-injection guard:');
{
  const commonSrc = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8'));
  const engineSrc = readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  const stub = `window.__listeners=0;window.__sent=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,ddgMode:'hide'})},
      onChanged:{addListener(){window.__listeners++;}}},runtime:{sendMessage(m){window.__sent.push(m);}}};`;
  const pg = await ctx.newPage();
  await pg.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
  await pg.addInitScript({ content: stub });
  await pg.goto('https://duckduckgo.com/?q=test').catch(() => {});
  await pg.addScriptTag({ content: commonSrc });
  await pg.addScriptTag({ content: engineSrc });
  await pg.waitForTimeout(300);
  const before = await pg.evaluate(() => window.__listeners);
  ok(before === 1, `first injection registers one settings listener (${before})`);
  // Inject the same two files again — exactly what executeScript into an
  // already-registered tab does.
  await pg.addScriptTag({ content: commonSrc });
  await pg.addScriptTag({ content: engineSrc });
  await pg.waitForTimeout(300);
  const after = await pg.evaluate(() => window.__listeners);
  ok(after === 1, `a second injection registers NO second listener (${after})`);
  ok(await pg.evaluate(() => document.querySelectorAll('#quell-engine').length === 1),
    'and adds no second stylesheet');
  ok(!(await pg.evaluate(() => !!document.getElementById('ddg-ai')?.getClientRects().length)),
    'the AI card is still hidden after the second injection');
  await pg.close();
}

// --- cookies.js: reject-all switched on LIVE, and the configure guard -------
console.log('Cookie reject-all — live switch-on and the configure guard:');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  // A stub whose onChanged listener is captured so the test can fire it, and
  // whose storage reads follow window.__state so the "next" read sees the
  // flipped value. Date.now is skewable: the reject window is 20s from
  // injection, and the live switch must RESTART it — a user who flips the
  // switch after staring at a banner for a minute must still get the click.
  const liveStub = `window.__state={cookieReject:false};window.__skew=0;
    const __now=Date.now;Date.now=()=>__now()+window.__skew;
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},
      onChanged:{addListener(f){window.__onChanged=f;}}},runtime:{sendMessage(){}}};`;

  // Switched on live, after the window would have expired.
  {
    const pg = await ctx.newPage();
    await pg.route('http://reject-fixture.test/**', (r) =>
      r.fulfill({ contentType: 'text/html', body: REJECT_FIXTURE }));
    await pg.addInitScript({ content: liveStub + '\n' + src });
    await pg.goto('http://reject-fixture.test/');
    await pg.waitForTimeout(600);
    ok(!(await pg.evaluate(() => document.body.dataset.rejected === '1')),
      'precondition: with reject-all off nothing is clicked');
    ok(await pg.evaluate(() => typeof window.__onChanged === 'function'),
      'precondition: cookies.js subscribed to storage.onChanged');
    // No DOM mutation happens from here on, so only the live path can click.
    await pg.evaluate(() => {
      window.__skew = 30000; // 30s later: the original reject window has expired
      window.__state = { cookieReject: true };
      window.__onChanged({ cookieReject: { newValue: true } }, 'local');
    });
    await pg.waitForTimeout(300);
    ok(await pg.evaluate(() => document.body.dataset.rejected === '1'),
      'flipping reject-all ON in the popup clicks the banner already on screen — no reload, no mutation, window restarted');
    ok(!(await pg.evaluate(() => document.body.dataset.decoyClicked === '1')),
      'the live path is just as CMP-scoped (decoy untouched)');
    await pg.close();
  }

  // The configure guard: a reject-class control that offers to CONFIGURE
  // consent must be skipped, and the real reject found further down the list.
  const stubOn = `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:true})}},runtime:{sendMessage(){}}};`;
  for (const label of ['Manage preferences', 'Customize', 'Customise', 'MORE OPTIONS', 'Manage my choices']) {
    const FX = `<!doctype html><html><body><div id="onetrust-banner-sdk">We use cookies!
      <button class="ot-pc-refuse-all-handler" onclick="document.body.dataset.configured='1'">${label}</button>
      <button id="CybotCookiebotDialogBodyButtonDecline" onclick="document.body.dataset.rejected='1'">Decline</button>
    </div></body></html>`;
    const pg = await ctx.newPage();
    await pg.route('http://reject-fixture.test/**', (r) => r.fulfill({ contentType: 'text/html', body: FX }));
    await pg.goto('http://reject-fixture.test/');
    await pg.addScriptTag({ content: stubOn + '\n' + src });
    await pg.waitForTimeout(400);
    const configured = await pg.evaluate(() => document.body.dataset.configured === '1');
    const rejected = await pg.evaluate(() => document.body.dataset.rejected === '1');
    ok(!configured && rejected,
      `a reject-class control labelled "${label}" is skipped and the real Decline is clicked (configured=${configured}, rejected=${rejected})`);
    await pg.close();
  }
  // ...and the guard is narrow: real reject labels that merely contain a
  // word like "all" or "purposes" are NOT mistaken for configure buttons.
  for (const label of ['Reject all purposes', 'Disagree to all partners', 'Reject All']) {
    const FX = `<!doctype html><html><body><div id="onetrust-banner-sdk">We use cookies!
      <button class="ot-pc-refuse-all-handler" onclick="document.body.dataset.rejected='1'">${label}</button>
    </div></body></html>`;
    const pg = await ctx.newPage();
    await pg.route('http://reject-fixture.test/**', (r) => r.fulfill({ contentType: 'text/html', body: FX }));
    await pg.goto('http://reject-fixture.test/');
    await pg.addScriptTag({ content: stubOn + '\n' + src });
    await pg.waitForTimeout(400);
    ok(await pg.evaluate(() => document.body.dataset.rejected === '1'),
      `"${label}" is a real reject label and IS clicked`);
    await pg.close();
  }
}


// --- Reject-all: the click has to land while the vendor is listening -------
// Round 4 (2026-09-10): the first sweep fires ~13 ms in, when the banner
// markup is parsed; the WordPress-shaped CMPs bind their handler from a
// defer/async script that has not run yet. The click went into the void and
// `rejected` latched on it. Every case here injects at document_start, the
// real ordering, and counts clicks with a capture listener on the document.
console.log('Cookie reject-all — the click must land (defer / async / never-bound):');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  const stubOn = `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:true})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};`;
  const CAPTURE = `window.__clicks=[];document.addEventListener('click',()=>window.__clicks.push(document.readyState),true);`;
  const BANNER = '<div class="cmplz-cookiebanner"><button class="cmplz-btn cmplz-deny">Deny</button></div>';
  // A real CMP hides its banner once it has recorded the choice; that is
  // what tells Quell the click landed.
  const BIND = `document.querySelector('.cmplz-deny').addEventListener('click',()=>{document.body.dataset.rejected='1';document.querySelector('.cmplz-cookiebanner').style.display='none';});`;
  const filler = '<p>' + 'lorem ipsum '.repeat(20000) + '</p>';

  const run = async (html, { bindDelayMs = 0, wait = 1200 } = {}) => {
    const pg = await ctx.newPage();
    await pg.route('https://race.test/**', async (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === '/bind.js') {
        if (bindDelayMs) await new Promise((res) => setTimeout(res, bindDelayMs));
        return r.fulfill({ contentType: 'text/javascript', body: BIND });
      }
      return r.fulfill({ contentType: 'text/html', body: html });
    });
    await pg.addInitScript({ content: stubOn + '\n' + src });
    await pg.goto('https://race.test/');
    await pg.waitForTimeout(wait);
    const out = await pg.evaluate(() => ({
      rejected: document.body.dataset.rejected === '1', clicks: window.__clicks,
    }));
    await pg.close();
    return out;
  };

  // Server-rendered banner, handler bound by <script defer> — the Complianz /
  // CookieYes / cookie-law-info / Borlabs shape.
  {
    const r = await run(`<!doctype html><html><head><script>${CAPTURE}<\/script><script defer src="/bind.js"><\/script></head><body>${BANNER}<div>site</div></body></html>`);
    ok(r.rejected, `defer-bound handler receives the click (clicks at readyState: ${r.clicks.join(',')})`);
    ok(r.clicks.length === 1, `...and exactly one click was needed (${r.clicks.length})`);
    ok(r.clicks.every((st) => st !== 'loading'), 'no click is fired while the document is still parsing');
  }
  // Inline binding at the end of a large body — the same "parsed but not yet
  // bound" window, without defer.
  {
    const r = await run(`<!doctype html><html><head><script>${CAPTURE}<\/script></head><body>${BANNER}${filler}<script>${BIND}<\/script></body></html>`);
    ok(r.rejected && r.clicks.length === 1, `handler bound at the end of a 240 KB body receives one click (rejected=${r.rejected}, clicks=${r.clicks.length})`);
  }
  // Handler bound late (250 ms after DOMContentLoaded, the way an async CMP
  // script does): the first click is lost by construction; a bounded retry
  // must land it. The late bind is an in-page timer rather than a delayed
  // network response: both are "after DCL", but a Playwright route delay
  // rides on the test runner's own event loop and made this flaky under load
  // (0.6.0 — seen twice in full-suite runs, never in isolation).
  {
    const r = await run(`<!doctype html><html><head><script>${CAPTURE}<\/script></head><body>${BANNER}<script>document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{${BIND}},250));<\/script></body></html>`,
      { wait: 1500 });
    ok(r.rejected, `async-bound handler (250 ms after DCL) still receives a click (${r.clicks.length} clicks)`);
    ok(r.clicks.length === 2, `...via exactly one retry, then confirmed by the hide (${r.clicks.length})`);
  }
  // Never bound, never hidden: the budget is spent and then we stop.
  {
    const r = await run(`<!doctype html><html><head><script>${CAPTURE}<\/script></head><body>${BANNER}</body></html>`, { wait: 3200 });
    ok(!r.rejected && r.clicks.length === 3, `a control nothing ever binds is clicked exactly MAX_CLICKS times, then left alone (${r.clicks.length})`);
  }
  // The click landed and the CMP hid its banner the way CMPs do (inline
  // display:none): confirmed on the next sweep, no retry.
  {
    const r = await run(`<!doctype html><html><head><script>${CAPTURE}<\/script></head><body>
      <div id="cmp" class="cmplz-cookiebanner"><button class="cmplz-btn cmplz-deny" onclick="document.body.dataset.rejected='1';document.getElementById('cmp').style.display='none'">Deny</button></div>
      </body></html>`, { wait: 2600 });
    ok(r.rejected && r.clicks.length === 1, `a click the CMP answered by hiding its banner is not retried (${r.clicks.length} clicks)`);
  }
}

// --- Reject-all: dismissed-by-class banners are the site's choice, not ours --
// Round 4: Complianz server-renders every banner with `cmplz-hidden` and its
// script removes the class from the one it shows; CookieYes hides with
// `cky-hide` after a choice; OneTrust keeps the preference centre (which
// holds `.ot-pc-refuse-all-handler`) behind `ot-hide`. None set an inline
// style or attribute, so the round-3 gate clicked all three on every load —
// flipping a deliberate accept to deny.
console.log('Cookie reject-all — vendor dismissed-state classes:');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  const stubOn = `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:true})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};`;
  const open = async (html, wait = 500) => {
    const pg = await ctx.newPage();
    await pg.route('http://cls-fixture.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: stubOn + '\n' + src });
    await pg.goto('http://cls-fixture.test/');
    await pg.waitForTimeout(wait);
    return pg;
  };
  const clicked = (pg) => pg.evaluate(() => document.body.dataset.rejected === '1');

  // Complianz, fresh: hidden by class at parse time; the plugin later reveals
  // it (and binds its handler at the same moment). Quell must wait for that.
  {
    const pg = await open(`<!doctype html><html><body>
      <div id="cmp" class="cmplz-cookiebanner cmplz-hidden"><button class="cmplz-btn cmplz-deny">Deny</button></div>
      </body></html>`);
    ok(!(await clicked(pg)), 'Complianz banner still carrying cmplz-hidden is NOT clicked');
    await pg.evaluate(() => {
      const b = document.querySelector('.cmplz-deny');
      b.addEventListener('click', () => { document.body.dataset.rejected = '1'; document.getElementById('cmp').classList.add('cmplz-hidden'); });
      document.getElementById('cmp').classList.remove('cmplz-hidden'); // the plugin shows it
    });
    await pg.waitForTimeout(500);
    ok(await clicked(pg), 'once the plugin reveals the banner (class removed), it IS clicked');
    await pg.close();
  }
  // Post-consent shapes: never clicked.
  for (const [name, html] of [
    ['Complianz cmplz-dismissed', '<div class="cmplz-cookiebanner cmplz-dismissed"><button class="cmplz-btn cmplz-deny" onclick="document.body.dataset.rejected=\'1\'">Deny</button></div>'],
    ['CookieYes cky-hide', '<div class="cky-consent-container cky-hide"><button class="cky-btn-reject" onclick="document.body.dataset.rejected=\'1\'">Reject</button></div>'],
    ['OneTrust preference centre ot-hide', '<div id="onetrust-pc-sdk" class="otPcCenter ot-hide"><button class="ot-pc-refuse-all-handler" onclick="document.body.dataset.rejected=\'1\'">Reject All</button></div>'],
  ]) {
    const pg = await open(`<!doctype html><html><body>${html}</body></html>`);
    ok(!(await clicked(pg)), `${name}: a banner the site dismissed by class is NOT clicked`);
    await pg.close();
  }
  // ...and the visible OneTrust banner next to a hidden preference centre is.
  {
    const pg = await open(`<!doctype html><html><body>
      <div id="onetrust-pc-sdk" class="otPcCenter ot-hide"><button class="ot-pc-refuse-all-handler" onclick="document.body.dataset.pc='1'">Reject All</button></div>
      <div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button></div>
      </body></html>`);
    ok(await clicked(pg) && !(await pg.evaluate(() => document.body.dataset.pc === '1')),
      "OneTrust: the visible banner's Reject-all is clicked, the hidden preference centre's is not");
    await pg.close();
  }
  // Round-3 #6 coverage: the inline visibility:hidden branch.
  {
    const pg = await open(`<!doctype html><html><body>
      <div id="onetrust-banner-sdk" style="visibility:hidden"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button></div>
      </body></html>`);
    ok(!(await clicked(pg)), 'a banner the site hid via inline visibility:hidden is NOT clicked');
    await pg.close();
  }
}

// --- engines.js: leaving clean mode still undoes its own redirect after a hash --
// Round-3 #6: undo was keyed to the exact href, so a site that appended its
// own #fragment after load stranded Quell's parameter. The flag is now
// compared without the fragment.
console.log('Engines — undoClean survives a site-added fragment:');
{
  const commonSrc = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8'));
  const engineSrc = readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  const stub = `window.__state={enabled:true,ddgMode:'clean'};
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},
      onChanged:{addListener(f){window.__onChanged=f;}}},runtime:{sendMessage(){}}};`;
  const pg = await ctx.newPage();
  await pg.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
  await pg.addInitScript({ content: stub });
  await pg.goto('https://duckduckgo.com/?q=abc');
  await pg.addScriptTag({ content: commonSrc });
  await pg.addScriptTag({ content: engineSrc });
  await pg.waitForURL((u) => u.searchParams.get('assist') === 'false', { timeout: 3000 }).catch(() => {});
  ok(pg.url() === 'https://duckduckgo.com/?q=abc&assist=false', `precondition: clean mode redirected (${pg.url()})`);
  // The redirect landed on a fresh document; re-inject (the stub survives via addInitScript).
  await pg.addScriptTag({ content: commonSrc });
  await pg.addScriptTag({ content: engineSrc });
  await pg.waitForTimeout(200);
  await pg.evaluate(() => { location.hash = '#frag'; }); // the site's own fragment
  await pg.evaluate(() => {
    window.__state = { enabled: true, ddgMode: 'hide' };
    window.__onChanged({ ddgMode: { newValue: 'hide' } }, 'local');
  });
  await pg.waitForURL((u) => !u.searchParams.has('assist'), { timeout: 3000 }).catch(() => {});
  ok(pg.url() === 'https://duckduckgo.com/?q=abc#frag',
    `leaving clean mode removes Quell's parameter and keeps the fragment (${pg.url()})`);
  await pg.close();
}

// --- PR #875 review (a): a choice the user already made is never overridden --
// The visibility gate covers a banner the SITE hid. But sites also re-SHOW the
// banner when the user asks to review consent (Complianz "Manage consent",
// OneTrust's floating button) — same control, now visible, the user already
// accepted. The vendor's own consent-state cookie is what says a choice exists.
console.log('Cookie reject-all — the vendor consent cookie wins (review finding a):');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  const stubOn = `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:true})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};`;
  let n = 0;
  const open = async (head, body, wait = 900) => {
    const pg = await ctx.newPage();
    const host = `http://state${++n}.test/`; // fresh cookie jar per case
    await pg.route(host + '**', (r) => r.fulfill({ contentType: 'text/html',
      body: `<!doctype html><html><head><script>${head}<\/script></head><body>${body}</body></html>` }));
    await pg.addInitScript({ content: stubOn + '\n' + src });
    await pg.goto(host);
    await pg.waitForTimeout(wait);
    return pg;
  };
  const clicked = (pg) => pg.evaluate(() => document.body.dataset.rejected === '1');
  const CMPLZ = `<div id="cmp" class="cmplz-cookiebanner cmplz-hidden"><button class="cmplz-btn cmplz-deny" onclick="document.body.dataset.rejected='1';document.getElementById('cmp').classList.add('cmplz-hidden')">Deny</button></div>`;
  // The exact reviewer walk: prior ACCEPT recorded in Complianz's cookies, the
  // user opens "Manage consent" (the plugin removes cmplz-hidden) inside the
  // 20 s window. Before the fix: flipped to deny + forced reload.
  const REVEAL = `setTimeout(()=>document.getElementById('cmp').classList.remove('cmplz-hidden'),300);`;
  {
    const pg = await open(`document.cookie='cmplz_banner-status=dismissed;path=/';document.cookie='cmplz_consent_status=allow;path=/';document.addEventListener('DOMContentLoaded',()=>{${REVEAL}});`, CMPLZ, 1400);
    ok(await pg.evaluate(() => !document.getElementById('cmp').classList.contains('cmplz-hidden')),
      'precondition: the site re-showed the Complianz banner (Manage consent)');
    ok(!(await clicked(pg)), 'Complianz: a banner re-shown AFTER the user accepted is NOT clicked (state cookie)');
    await pg.close();
  }
  {
    const pg = await open(`document.addEventListener('DOMContentLoaded',()=>{${REVEAL}});`, CMPLZ, 1400);
    ok(await clicked(pg), 'Complianz: the same reveal with NO saved choice IS clicked (fix does not disable reject)');
    await pg.close();
  }
  // The same promise, vendor by vendor, for a banner visible from the start.
  for (const [name, cookie, markup, expectClick] of [
    ['OneTrust OptanonAlertBoxClosed', 'OptanonAlertBoxClosed=2026-09-01T10:00:00.000Z',
      `<div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button></div>`, false],
    ['OneTrust OptanonConsent alone (written before any choice)', 'OptanonConsent=isGpcEnabled=0&interactionCount=0',
      `<div id="onetrust-banner-sdk"><button id="onetrust-reject-all-handler" onclick="document.body.dataset.rejected='1'">Reject All</button></div>`, true],
    ['Cookiebot CookieConsent', 'CookieConsent={stamp:%27abc%27%2Cnecessary:true}',
      `<div id="CybotCookiebotDialog"><button id="CybotCookiebotDialogBodyButtonDecline" onclick="document.body.dataset.rejected='1'">Decline</button></div>`, false],
    ['Didomi didomi_token', 'didomi_token=eyJ1c2VyX2lkIjoiMSJ9',
      `<div id="didomi-host"><button id="didomi-notice-disagree-button" onclick="document.body.dataset.rejected='1'">Disagree</button></div>`, false],
    ['CookieYes action:yes', 'cookieyes-consent=consentid:abc,consent:yes,action:yes,necessary:yes',
      `<div class="cky-consent-container"><button class="cky-btn-reject" onclick="document.body.dataset.rejected='1'">Reject</button></div>`, false],
    ['CookieYes cookie with no action yet', 'cookieyes-consent=consentid:abc,consent:no,action:,necessary:yes',
      `<div class="cky-consent-container"><button class="cky-btn-reject" onclick="document.body.dataset.rejected='1'">Reject</button></div>`, true],
    ['cookie-law-info viewed_cookie_policy', 'viewed_cookie_policy=yes',
      `<div id="cookie-law-info-bar"><a id="cookie_action_close_header_reject" role="button" onclick="document.body.dataset.rejected='1'">Reject</a></div>`, false],
    ['Borlabs borlabs-cookie', 'borlabs-cookie=%7B%22consents%22%3A%7B%7D%7D',
      `<div id="BorlabsCookieBox"><a id="BorlabsCookieBoxOptOut" role="button" onclick="document.body.dataset.rejected='1'">Refuse</a></div>`, false],
  ]) {
    const pg = await open(`document.cookie=${JSON.stringify(cookie + ';path=/')};`, markup, 700);
    const c = await clicked(pg);
    ok(c === expectClick, `${name}: ${expectClick ? 'clicked' : 'NOT clicked'} (clicked=${c})`);
    await pg.close();
  }
  // A vendor with no state cookie Quell can read (Osano): a banner that was
  // hidden and is then SHOWN cannot be told apart from "the user opened it to
  // review", so it is hidden, never clicked. Shown from the start, it is.
  {
    const OSANO = `<div id="osano" class="osano-cm-dialog" style="display:none"><button class="osano-cm-denyAll" onclick="document.body.dataset.rejected='1'">Deny</button></div>`;
    const pg = await open(`document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{document.getElementById('osano').style.display='';},300));`, OSANO, 1400);
    ok(!(await clicked(pg)), 'Osano (no readable state cookie): a banner revealed after load is NOT clicked');
    await pg.close();
    const pg2 = await open('', OSANO.replace(' style="display:none"', ''), 700);
    ok(await clicked(pg2), 'Osano: a banner visible from the start IS clicked');
    await pg2.close();
  }
}

// --- PR #875 review (b): a disconnect is not a confirmation ------------------
// A click that went into the void and was followed by the CMP re-rendering its
// banner (replacing the node) used to latch `rejected` with no choice made.
console.log('Cookie reject-all — a re-render is not a confirmation (review finding b):');
{
  const src = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8'));
  const stubOn = `window.chrome={storage:{local:{get:async(d)=>({...d,cookieReject:true})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};`;
  const CAPTURE = `window.__clicks=0;document.addEventListener('click',()=>window.__clicks++,true);`;
  let n = 0;
  const run = async (head, body, wait) => {
    const pg = await ctx.newPage();
    const host = `http://rerender${++n}.test/`;
    await pg.route(host + '**', (r) => r.fulfill({ contentType: 'text/html',
      body: `<!doctype html><html><head><script>${CAPTURE}${head}<\/script></head><body>${body}</body></html>` }));
    await pg.addInitScript({ content: stubOn + '\n' + src });
    await pg.goto(host);
    await pg.waitForTimeout(wait);
    const out = await pg.evaluate(() => ({ rejected: document.body.dataset.rejected === '1', clicks: window.__clicks }));
    await pg.close();
    return out;
  };
  // The reviewer's case J: first click lands before any handler exists; the
  // CMP then re-renders (new node) and binds. The ladder must follow it.
  {
    const r = await run(`document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
        const c=document.getElementById('cky');
        c.innerHTML='<button class="cky-btn-reject">Reject</button>';
        c.querySelector('button').addEventListener('click',()=>{document.body.dataset.rejected='1';c.classList.add('cky-hide');});
      },200));`,
      `<div id="cky" class="cky-consent-container"><button class="cky-btn-reject">Reject</button></div>`, 1500);
    ok(r.rejected, `void click + re-render before binding: the replacement node is clicked and the choice lands (${r.clicks} clicks)`);
    ok(r.clicks === 2, `...with exactly one more click, then confirmed by the hide (${r.clicks})`);
  }
  // A re-render that records the choice (sets the vendor cookie) and shows the
  // banner again is confirmed: no visible candidate the user has not answered.
  {
    const r = await run('',
      `<div id="cky" class="cky-consent-container"><button class="cky-btn-reject" onclick="
         document.cookie='cookieyes-consent=consentid:x,consent:no,action:yes;path=/';
         const c=document.getElementById('cky'); const h=c.innerHTML; c.innerHTML=''; setTimeout(()=>{c.innerHTML=h;},60);">Reject</button></div>`, 2600);
    ok(r.clicks === 1, `a re-render that recorded the choice (state cookie) is confirmed after ONE click (${r.clicks})`);
  }
  // The banner removed outright: nothing left to click, confirmed after one.
  {
    const r = await run('',
      `<div id="cky" class="cky-consent-container"><button class="cky-btn-reject" onclick="document.getElementById('cky').remove()">Reject</button></div>`, 2600);
    ok(r.clicks === 1, `a banner removed after the click is confirmed after ONE click (${r.clicks})`);
  }
}

// --- Search group switch + "Keep AI on this site" on Google -------------------
console.log('Google — Search group switch and "Keep AI on this site":');
{
  await sw.evaluate(() => QuellSettings.set({ enabled: true, aiEnabled: true, googleMode: 'hide', aiAllowlist: [] }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  const vis = (id) => page.evaluate((x) => document.getElementById(x).getClientRects().length > 0, id);
  const until = (id, want) => page.waitForFunction(([x, w]) => (document.getElementById(x).getClientRects().length > 0) === w,
    [id, want], { timeout: 4000 }).catch(() => {});
  await until('ai-block', false);
  ok(!(await vis('ai-block')), 'baseline: overview hidden');
  await sw.evaluate(() => QuellSettings.set({ aiAllowlist: ['www.google.com'] }));
  await until('ai-block', true);
  ok(await vis('ai-block') && await vis('ai-block-css'), 'Keep AI on www.google.com releases every AI block there (live)');
  ok(await vis('organic-normal'), 'organic result still there');
  await sw.evaluate(() => QuellSettings.set({ aiAllowlist: [] }));
  await until('ai-block', false);
  ok(!(await vis('ai-block')), 'un-pausing hides it again (live)');
  await sw.evaluate(() => QuellSettings.set({ aiEnabled: false }));
  await until('ai-block', true);
  ok(await vis('ai-block'), 'Search group switch off releases Google AI (live)');
  await sw.evaluate(() => QuellSettings.set({ aiEnabled: true }));
  await page.close();

  // A paused site is left exactly as served: Clean Web does not redirect it.
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'cleanweb', aiAllowlist: ['www.google.com'] }));
  const p2 = await ctx.newPage();
  await p2.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await p2.goto('https://www.google.com/search?q=test');
  await p2.waitForTimeout(500);
  ok(!p2.url().includes('udm=14'), `Keep AI on this site: Classic results does NOT redirect a paused site (${p2.url().slice(-20)})`);
  await p2.close();
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide', aiAllowlist: [] }));
}

// --- Pop-ups layer ------------------------------------------------------------
// Injected with a stubbed chrome, like the cookie layer (registration needs an
// <all_urls> grant Playwright cannot accept); the stub answers 'popupRules'
// from the REAL rules/popups.json the way background.js does. Selectors for
// the fixture are picked from that file, so a weekly rules refresh cannot
// strand the test on a selector upstream removed.
console.log('Pop-ups layer (off by default; never hides page content):');
{
  const RULES = JSON.parse(readFileSync(path.join(EXT, 'rules/popups.json'), 'utf8'));
  const simple = (cat) => RULES[cat].generic.find((x) => /^[#.][A-Za-z][\w-]*$/.test(x));
  const NL = simple('newsletter'), APP = simple('app');
  ok(!!NL && !!APP, `precondition: rules/popups.json has simple selectors to build a fixture from (${NL}, ${APP})`);
  const el = (sel, id, inner) => sel.startsWith('#')
    ? `<div id="${sel.slice(1)}" data-t="${id}">${inner}</div>` : `<div class="${sel.slice(1)}" id="${id}">${inner}</div>`;
  const byT = (t) => `[data-t="${t}"],#${t}`;
  const popSrc = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/popups.js'), 'utf8');
  const stub = (over) => `window.__state=${JSON.stringify(over)};window.__cbs=[];window.__sent=[];
    window.__RULES=${JSON.stringify(RULES)};
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{sendMessage:async(m)=>{ if(m.type==='blocked'){window.__sent.push(m);return;}
        if(m.type!=='popupRules') return; const g=[],site=[...(window.__SITE||[])]; for(const c of m.cats){const r=window.__RULES[c]; if(!r) continue; g.push(...r.generic);} return {generic:g,site}; }}};
    window.__set=(p)=>{Object.assign(window.__state,p);const ch={};for(const k in p)ch[k]={newValue:p[k]};window.__cbs.forEach(f=>f(ch,'local'));};`;
  const FIX = `<!doctype html><html><body style="overflow:hidden">
    <main id="content-main"><h1>Real article</h1><p>The page the user came for.</p></main>
    ${el(NL, 'nl-modal', '<p>Join our newsletter!</p><input placeholder="email">').replace('<div', '<div style="position:fixed;inset:20% 20%"')}
    ${el(APP, 'app-banner', 'Open in the app')}
    <div id="intercom-container">chat</div>
    <!-- TRAP: an element a newsletter rule matches, holding an article's
         worth of text. That is content, whatever the rule says. -->
    ${el(NL, 'trap-long', 'word '.repeat(900))}
  </body></html>`;
  const open = async (over, url = 'http://popups.test/') => {
    const pg = await ctx.newPage();
    await pg.route(url + '**', (r) => r.fulfill({ contentType: 'text/html', body: FIX }));
    await pg.addInitScript({ content: stub(over) + '\n' + popSrc });
    await pg.goto(url);
    await pg.waitForTimeout(900);
    return pg;
  };
  const vis = (pg, sel) => pg.evaluate((s) => { const e = document.querySelector(s); return !!e && e.getClientRects().length > 0; }, sel);

  // Default: off — even with the script present, nothing is hidden.
  {
    const pg = await open({ popupsEnabled: false });
    ok(await vis(pg, byT('nl-modal')) && await vis(pg, '#intercom-container'), 'OFF by default: nothing hidden');
    await pg.close();
  }
  {
    const pg = await open({ popupsEnabled: true });
    ok(!(await vis(pg, byT('nl-modal'))), `newsletter modal hidden (${NL})`);
    ok(!(await vis(pg, byT('app-banner'))), `"open in app" banner hidden (${APP})`);
    ok(!(await vis(pg, '#intercom-container')), 'chat widget hidden');
    ok(await vis(pg, '#content-main'), 'page content (main) untouched');
    ok(await vis(pg, byT('trap-long')), 'an element matching a rule but holding an article\'s worth of text is KEPT (runtime guard)');
    ok(await pg.evaluate(() => getComputedStyle(document.body).overflow) === 'auto',
      'the scroll lock a hidden overlay left behind is released');
    const sent = await pg.evaluate(() => window.__sent.reduce((a, m) => a + m.count, 0));
    ok(sent >= 3, `hidden items are reported for the page count (${sent})`);
    // Live: a category switched off comes back on the open page.
    await pg.evaluate(() => window.__set({ hideChat: false }));
    await pg.waitForTimeout(500);
    ok(await vis(pg, '#intercom-container') && !(await vis(pg, byT('nl-modal'))),
      'turning Chat widgets off shows the chat again, newsletter stays hidden (live)');
    // Per-site pause.
    await pg.evaluate(() => window.__set({ popupAllowlist: ['popups.test'] }));
    await pg.waitForTimeout(500);
    ok(await vis(pg, byT('nl-modal')) && await vis(pg, byT('app-banner')), '"Allow pop-ups here" lifts the layer on this site (live)');
    ok(await pg.evaluate(() => getComputedStyle(document.body).overflow) === 'hidden',
      "and hands the site back its own scroll lock");
    ok(await pg.evaluate(() => !document.getElementById('quell-popups')), 'and removes its stylesheet');
    await pg.close();
  }
  // Attentive's e-mail/SMS sign-up (live 2026-09-25, gap.com): one full-screen
  // cross-origin iframe over the page with the scroll locked. EasyList has no
  // rule for it; the curated seed does, under the Newsletter switch only.
  {
    const ATT = `<!doctype html><html><body style="overflow:hidden">
      <main id="shop"><h1>Fall event</h1><a id="bag" href="/cart">Bag (1)</a></main>
      <iframe id="attentive_creative" title="Sign Up via Text for Offers" src="about:blank"
        style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>
    </body></html>`;
    const run = async (over) => {
      const pg = await ctx.newPage();
      await pg.route('http://attentive.test/**', (r) => r.fulfill({ contentType: 'text/html', body: ATT }));
      await pg.addInitScript({ content: stub(over) + '\n' + popSrc });
      await pg.goto('http://attentive.test/');
      await pg.waitForTimeout(900);
      return pg;
    };
    const pg = await run({ popupsEnabled: true });
    ok(!(await vis(pg, '#attentive_creative')), 'Attentive sign-up iframe (not in EasyList) is hidden');
    ok(await vis(pg, '#shop') && await vis(pg, '#bag'), 'and the page and its bag link are untouched');
    ok(await pg.evaluate(() => getComputedStyle(document.body).overflow) === 'auto',
      'and the scroll lock it left is released');
    await pg.close();
    const off = await run({ popupsEnabled: true, hideNewsletters: false });
    ok(await vis(off, '#attentive_creative'), 'with Newsletter sign-ups switched off, the Attentive iframe is left alone');
    await off.close();
    // The lock usually lands AFTER the iframe: the vendor script sets
    // body.style.overflow when its creative opens. That is an attribute
    // change, not a new node, so a childList-only observer never swept again
    // and the page stayed unscrollable behind an overlay nobody could see.
    const late = await run({ popupsEnabled: true });
    await late.evaluate(() => { document.body.style.overflow = 'visible'; });
    await late.waitForTimeout(500);
    await late.evaluate(() => { document.body.style.overflow = 'hidden'; document.documentElement.style.overflow = 'hidden'; });
    await late.waitForTimeout(900);
    ok(await late.evaluate(() => getComputedStyle(document.body).overflow !== 'hidden' && getComputedStyle(document.documentElement).overflow !== 'hidden'),
      'a scroll lock set LATER by attribute (after the hidden overlay) is released too');
    await late.close();
  }
  // A site's OWN scroll lock is never released. Review finding 2026-09-25: a
  // hidden chat bubble made Quell treat any later lock as a nag's, so opening
  // the site's checkout/login drawer (locked by a body class) left the page
  // scrolling behind it — the shape of ardene.com (chat bubble + drawers).
  {
    const SHOP = (drawer) => `<!doctype html><html><head><style>
        body.modal-open{overflow:hidden}
        #checkout{display:none;position:fixed;inset:0 0 0 40%;background:#fff}
        body.modal-open #checkout{display:block}
      </style></head><body>
      <main id="shop"><h1>Shop</h1><p>Products…</p></main>
      <div id="intercom-container" style="position:fixed;right:10px;bottom:10px;width:60px;height:60px">chat</div>
      <div id="checkout" ${drawer}><form><label>Password <input type="password"></label></form></div>
      ${'<p>more</p>'.repeat(200)}
    </body></html>`;
    const run = async (html, host, over = {}) => {
      const pg = await ctx.newPage();
      await pg.route(`http://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await pg.addInitScript({ content: stub({ popupsEnabled: true, ...over }) + '\n' + popSrc });
      await pg.goto(`http://${host}/`);
      await pg.waitForTimeout(900);
      return pg;
    };
    const locked = (pg) => pg.evaluate(() => getComputedStyle(document.body).overflow === 'hidden');
    for (const [drawer, label] of [['role="dialog" aria-modal="true"', 'a dialog'], ['', 'a drawer with no dialog role']]) {
      const pg = await run(SHOP(drawer), 'shoplock.test');
      ok(!(await vis(pg, '#intercom-container')), `(${label}) the chat bubble is hidden`);
      await pg.evaluate(() => document.body.classList.add('modal-open'));
      await pg.waitForTimeout(900);
      ok(await locked(pg), `(${label}) opening the site's own checkout keeps the SITE's scroll lock (chat bubble alone never justifies unlocking)`);
      await pg.close();
    }
    // After a real nag WAS hidden and its lock released, the site opening its
    // own drawer later still gets its lock back.
    const NAG_THEN_DRAWER = SHOP('').replace('<main id="shop">',
      el(NL, 'nl-late', 'Subscribe <input type="email">').replace('<div ', '<div style="position:fixed;inset:0" ') + '<main id="shop">')
      .replace('<body>', '<body style="overflow:hidden">');
    const pg = await run(NAG_THEN_DRAWER, 'naglock.test', { hideChat: false });
    ok(!(await locked(pg)), 'a hidden newsletter overlay\'s lock is released');
    await pg.evaluate(() => { document.body.style.overflow = ''; document.body.classList.add('modal-open'); });
    await pg.waitForTimeout(900);
    ok(await locked(pg), "then the site's own drawer, opened later, locks the page as the site intended");
    await pg.evaluate(() => document.body.classList.remove('modal-open'));
    await pg.waitForTimeout(900);
    ok(!(await locked(pg)), 'and closing it leaves the page scrollable');
    await pg.close();
  }
  // The runtime guard is not a single-rule accident: a page whose <main> sits
  // inside a rule-matched wrapper keeps it.
  {
    const RULE_WRAP = `<!doctype html><html><body>${el(NL, 'wrap', '<main id="m"><p>content</p></main>')}</body></html>`;
    const pg = await ctx.newPage();
    await pg.route('http://popwrap.test/**', (r) => r.fulfill({ contentType: 'text/html', body: RULE_WRAP }));
    await pg.addInitScript({ content: stub({ popupsEnabled: true }) + '\n' + popSrc });
    await pg.goto('http://popwrap.test/');
    await pg.waitForTimeout(900);
    ok(await vis(pg, '#m'), 'a rule-matched element that wraps <main> is kept visible (data-quell-keep)');
    await pg.close();
  }
  // Review #1 (the reviewer's own harness, reproduced): a SITE rule that is
  // just the site's modal shell (`.modal`) must not take its login or cart
  // dialog with it — while a newsletter modal matched by the same rule still
  // goes. And a GENERIC rule that lands on a sign-in form is put back.
  {
    const SITE_FIX = `<!doctype html><html><body>
      <main><h1>Shop</h1></main>
      <div class="modal" id="login-modal" role="dialog" aria-modal="true" style="position:fixed">
        <h2>Sign in</h2><form action="/account/login"><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></form>
      </div>
      <div class="modal" id="cart-modal" role="dialog" aria-modal="true" style="position:fixed">
        <h2>Added to your cart</h2><p>1 × Sweater</p><a href="/checkout">Checkout</a>
      </div>
      <!-- A cart modal that ALSO carries a newsletter upsell (e-mail field):
           it looks like a nag, and only the cart/checkout guard keeps it. -->
      <div class="modal" id="cart-upsell" role="dialog" aria-modal="true" style="position:fixed"><h2>Added to your cart</h2><p>1 × Scarf</p><p>Sign up for our newsletter</p><input type="email"><a href="/checkout">Checkout</a></div>
      <div class="modal" id="plain-modal" style="position:fixed"><p>Choose your size</p><button>S</button><button>M</button></div>
      <div class="modal" id="nl-site-modal" style="position:fixed">
        <h2>Get 10% off</h2><p>Join our newsletter.</p><input type="email" placeholder="Email address"><button>Subscribe</button>
      </div>
      <div class="${NL.startsWith('.') ? NL.slice(1) : 'nlx'}" ${NL.startsWith('#') ? `id="${NL.slice(1)}"` : 'id="generic-login"'}>
        <form class="login-form"><input type="password"></form>
      </div>
    </body></html>`;
    const pg = await ctx.newPage();
    await pg.route('http://popsite.test/**', (r) => r.fulfill({ contentType: 'text/html', body: SITE_FIX }));
    await pg.addInitScript({ content: stub({ popupsEnabled: true }) + `\nwindow.__SITE=['.modal'];\n` + popSrc });
    await pg.goto('http://popsite.test/');
    await pg.waitForTimeout(1000);
    ok(await vis(pg, '#login-modal'), 'site rule `.modal`: the LOGIN modal stays visible (password field / sign-in dialog)');
    ok(await vis(pg, '#cart-modal'), 'site rule `.modal`: the CART modal stays visible (cart / checkout dialog)');
    ok(await vis(pg, '#cart-upsell'), 'site rule `.modal`: a CART modal carrying a newsletter upsell still stays visible (cart guard, text read with element boundaries)');
    ok(await vis(pg, '#plain-modal'), 'site rule `.modal`: a modal that is not a sign-up/chat/app nag stays visible');
    ok(!(await vis(pg, '#nl-site-modal')), 'site rule `.modal`: the NEWSLETTER modal is still hidden');
    const gl = NL.startsWith('#') ? NL : '#generic-login';
    ok(await vis(pg, gl), `a GENERIC rule (${NL}) that lands on a sign-in form is put back`);
    // A site modal that BECOMES a newsletter later is caught on a later sweep.
    await pg.evaluate(() => {
      const d = document.createElement('div');
      d.className = 'modal'; d.id = 'late-nl';
      d.innerHTML = '<p>Sign up for our emails</p><input type="email">';
      document.body.appendChild(d);
    });
    await pg.waitForTimeout(900);
    ok(!(await vis(pg, '#late-nl')), 'a newsletter modal injected later is hidden on the next sweep');
    await pg.close();
  }

  // Build-time guard: nothing structural ships in the rules at all.
  const bad = [];
  for (const cat of Object.keys(RULES)) {
    const all = [...RULES[cat].generic, ...Object.values(RULES[cat].domains).flat()];
    for (const x of all) {
      const last = x.trim().split(/[\s>+~]+/).pop().toLowerCase();
      if (['main', 'article', 'header', 'footer', 'nav', 'section', 'div'].includes(last)
          || /^(html|body)(?![\w-])|^:root/.test(last)          // html/body in ANY form (review #2)
          || /^[#.](main|content|page|app|root|wrapper|container)$/.test(last)
          || /^[#.]?(modal|modal-backdrop|overlay|popup|dialog|ui-widget-overlay|ui-dialog|lightbox|backdrop)$/.test(last)) bad.push(x);
    }
  }
  ok(bad.length === 0, `no structural, html/body or bare modal-shell selector ships in rules/popups.json (${bad.slice(0, 3).join(' | ') || 'none'})`);
}

// --- Welcome page --------------------------------------------------------------
console.log('Welcome page:');
{
  const pg = await ctx.newPage();
  await pg.goto(`chrome-extension://${extId}/src/welcome/welcome.html`);
  await pg.waitForTimeout(200);
  const text = await pg.evaluate(() => document.body.innerText);
  ok(/Search/.test(text) && /Cookie banners/.test(text) && /Pop-ups/.test(text), 'names the three groups');
  ok(/never/i.test(text) && /real search result/i.test(text), 'says what Quell will never do');
  ok(await pg.evaluate(() => document.getElementById('privacy').href) === 'https://purpledirective.com/quell/privacy/',
    'links the privacy policy');
  ok(await pg.evaluate(() => document.getElementById('sponsor').href) === 'https://github.com/sponsors/PurpleDirective',
    'links the GitHub Sponsors profile');
  ok(await pg.evaluate(() => document.getElementById('accessNotice').hidden) === true,
    'no access prompt on Chromium, where Google/Bing access is granted at install');
  ok(!/\bcompliant\b/i.test(text), 'no "compliant" claim');
  ok(/sync through your own browser account/.test(text), 'on Chrome, says settings sync through the browser account');
  await pg.close();
}
// Opera installs the Chrome package but does not sync extension data: the
// welcome page must not promise it there.
{
  const pg = await ctx.newPage();
  await pg.addInitScript({ content: `Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(OPERA_UA)} });` });
  await pg.goto(`chrome-extension://${extId}/src/welcome/welcome.html`);
  await pg.waitForTimeout(200);
  const text = await pg.evaluate(() => document.body.innerText);
  ok(await pg.evaluate(() => navigator.userAgent.includes('OPR/')), 'precondition: the page sees an Opera user agent');
  ok(!/\bsync/i.test(text), `on Opera, the welcome page makes no sync claim`);
  ok(/saved in this browser/.test(text), 'on Opera, says settings are saved in this browser');
  await pg.close();
}

// --- Popup: confirm-before-AI-on, per-site card, breakage report -------------
// Same fake-chrome harness as the engines-switch tests above, with an active
// tab on a Google results page so the site card and report button appear.
console.log('Popup — confirm before AI comes back, site card, breakage report:');
{
  const popupDir = path.join(EXT, 'src/popup');
  const html = readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
  const js = readFileSync(path.join(popupDir, 'popup.js'), 'utf8');
  const css = readFileSync(path.join(popupDir, 'popup.css'), 'utf8');
  const cfg = readFileSync(path.join(EXT, 'src/shared/config.js'), 'utf8');
  const ENDPOINT = cfg.match(/REPORT_ENDPOINT: '([^']+)'/)[1];
  // `where` is what Quell's content script in that tab answers when the popup
  // asks which site it is on (null: no Quell script in the tab).
  const fake = (local, tabUrl, where = null, firefox = false) => `
    window.__calls = [];
    window.__state = { local: ${JSON.stringify(local)}, session: { 'tab:7': 4 } };
    window.chrome = {
      runtime: { id: 'fake', getManifest: () => ({ version: '0.6.0', content_scripts: [] }),
        getURL: (p) => ${JSON.stringify(firefox ? 'moz-extension://fake/' : 'chrome-extension://fake/')} + p },
      storage: {
        local: { get: async (d) => ({ ...d, ...window.__state.local }),
                 set: async (o) => { Object.assign(window.__state.local, o); window.__calls.push(['storage.set', o]); } },
        session: { get: async (d) => ({ ...d, ...window.__state.session }) },
      },
      permissions: { contains: async () => false, request: async () => false, remove: async () => true },
      tabs: { query: async () => [{ id: 7, url: ${JSON.stringify(tabUrl)} }], create: async () => ({}),
              sendMessage: async (id, msg) => {
                window.__calls.push(['tabs.sendMessage', id, msg]);
                const where = ${JSON.stringify(where)};
                if (where !== null && id === 7 && msg && msg.type === 'where') return { host: where };
                throw new Error('Could not establish connection. Receiving end does not exist.');
              } },
    };`;
  const reports = [];
  let endpointStatus = 204;
  const openPopup = async (local, tabUrl = 'https://www.google.com/search?q=widgets', { ua, where = null, width, firefox = false, cfgSrc } = {}) => {
    const pg = await ctx.newPage();
    if (ua) await pg.addInitScript({ content: `Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(ua)} });` });
    await pg.route('http://popup.test/**', (r) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith('popup.js')) return r.fulfill({ contentType: 'text/javascript', body: js });
      if (u.pathname.endsWith('popup.css')) return r.fulfill({ contentType: 'text/css', body: css });
      if (u.pathname.endsWith('/shared/settings.js')) return r.fulfill({ contentType: 'text/javascript', body: SETTINGS_SRC });
      if (u.pathname.endsWith('/shared/report-host.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/report-host.js'), 'utf8') });
      if (u.pathname.endsWith('/shared/config.js')) return r.fulfill({ contentType: 'text/javascript', body: cfgSrc || cfg });
      if (u.pathname.endsWith('/shared/browser.js')) return r.fulfill({ contentType: 'text/javascript', body: readFileSync(path.join(EXT, 'src/shared/browser.js'), 'utf8') });
      return r.fulfill({ contentType: 'text/html', body: html });
    });
    await pg.route(ENDPOINT, async (r) => {
      const req = r.request();
      reports.push({ method: req.method(), body: req.postData(), headers: await req.allHeaders() });
      return r.fulfill({ status: endpointStatus, headers: { 'access-control-allow-origin': '*' } });
    });
    if (width) await pg.setViewportSize({ width, height: 700 });
    await pg.addInitScript({ content: fake(local, tabUrl, where, firefox) });
    await pg.goto('http://popup.test/popup.html');
    await pg.waitForTimeout(300);
    return pg;
  };
  const stored = (pg) => pg.evaluate(() => window.__state.local);
  const dlgOpen = (pg, id) => pg.evaluate((x) => document.getElementById(x).open, id);

  // Rate Quell points at the store the browser installs from. Opera's listing
  // is not public yet, so the link is hidden there, never the Chrome store.
  {
    const pg = await openPopup({});
    ok(await pg.evaluate(() => document.getElementById('rate').href.includes('chromewebstore.google.com/detail/')),
      'Rate Quell links the Chrome Web Store on Chrome');
    await pg.close();
    const op = await openPopup({}, undefined, { ua: OPERA_UA });
    ok(await op.evaluate(() => globalThis.QuellBrowser && globalThis.QuellBrowser.opera === true), 'precondition: the popup detects Opera');
    ok(await op.evaluate(() => document.getElementById('rate').hidden), 'Rate Quell is hidden on Opera (no Chrome Web Store link)');
    await op.close();
  }
  // On Firefox the listing is public: the link goes to it. (IS_FIREFOX is read
  // from the extension's own address, which a test page cannot fake — so this
  // pins the configured address instead.)
  ok(/RATE_URL_FIREFOX: 'https:\/\/addons\.mozilla\.org\/firefox\/addon\/quell-quiet-the-web\/'/.test(cfg),
    'Rate Quell has the Firefox listing to point at');
  // ...and the popup really follows it: on Firefox the link is the AMO listing,
  // never the Chrome store; on Opera it follows RATE_URL_OPERA once that is set.
  {
    const ff = await openPopup({}, undefined, { firefox: true });
    ok(await ff.evaluate(() => { const a = document.getElementById('rate'); return !a.hidden && a.href === 'https://addons.mozilla.org/firefox/addon/quell-quiet-the-web/'; }),
      'Rate Quell links the Firefox listing on Firefox (not the Chrome Web Store)');
    await ff.close();
    const operaLive = cfg.replace('RATE_URL_OPERA: null', "RATE_URL_OPERA: 'https://addons.opera.com/extensions/details/quell-example/'");
    ok(operaLive !== cfg, 'precondition: the Opera address can be set in config.js');
    const op2 = await openPopup({}, undefined, { ua: OPERA_UA, cfgSrc: operaLive });
    ok(await op2.evaluate(() => { const a = document.getElementById('rate'); return !a.hidden && a.href.startsWith('https://addons.opera.com/'); }),
      'Rate Quell links the Opera listing on Opera once RATE_URL_OPERA is set');
    await op2.close();
  }
  // Edge installs the Chrome package from its own add-ons site, so it is not
  // sent to the Chrome Web Store either: hidden until RATE_URL_EDGE is set.
  {
    const ed = await openPopup({}, undefined, { ua: EDGE_UA });
    ok(await ed.evaluate(() => { const b = globalThis.QuellBrowser; return b && b.edge === true && !b.opera && !b.firefox; }), 'the popup detects Edge (and not Opera or Firefox)');
    ok(await ed.evaluate(() => document.getElementById('rate').hidden), 'Rate Quell is hidden on Edge until its listing exists (no Chrome Web Store link)');
    await ed.close();
    const edgeLive = cfg.replace('RATE_URL_EDGE: null', "RATE_URL_EDGE: 'https://microsoftedge.microsoft.com/addons/detail/quell-example/'");
    ok(edgeLive !== cfg, 'precondition: the Edge address can be set in config.js');
    const ed2 = await openPopup({}, undefined, { ua: EDGE_UA, cfgSrc: edgeLive });
    ok(await ed2.evaluate(() => { const a = document.getElementById('rate'); return !a.hidden && a.href.startsWith('https://microsoftedge.microsoft.com/'); }), 'Rate Quell links the Edge listing on Edge once RATE_URL_EDGE is set');
    await ed2.close();
    const ch = await openPopup({});
    ok(await ch.evaluate(() => globalThis.QuellBrowser.edge === false), 'Chrome is not mistaken for Edge');
    await ch.close();
    const op3 = await openPopup({}, undefined, { ua: OPERA_UA });
    ok(await op3.evaluate(() => globalThis.QuellBrowser.edge === false), 'Opera is not mistaken for Edge');
    await op3.close();
  }
  // The total reads right in the singular: "1 thing", not "1 things".
  for (const [n, word] of [[0, 'things'], [1, 'thing'], [2, 'things'], [1234, 'things']]) {
    const t = await openPopup({ totalBlocked: n });
    const line = await t.evaluate(() => document.querySelector('.counter').textContent.replace(/\s+/g, ' ').trim());
    ok(line === `${n.toLocaleString()} ${word} quelled so far`, `the counter says "${n.toLocaleString()} ${word} quelled so far" (read: ${line})`);
    await t.close();
  }
  // Chrome does not show the popup the address of a Google or Bing tab (Quell
  // reaches those as content-script hosts only). The popup then asks Quell's
  // own script in the tab which site it is on. Found by using the real popup
  // over a live Bing results page: it said "Quell doesn't run on this page"
  // while the page's count was 3, and the This-site card never appeared.
  {
    const pg = await openPopup({}, null, { where: 'www.bing.com' });
    ok(/hid 4 things/i.test(await pg.evaluate(() => document.getElementById('pageStatus').textContent)),
      'no tab address, but Quell\'s script answers: the status still says what Quell hid on this page');
    ok(await pg.evaluate(() => !document.getElementById('siteCard').hidden && document.getElementById('siteHost').textContent) === 'www.bing.com',
      '...and the This-site card names the site');
    ok(await pg.evaluate(() => !document.getElementById('siteAiRow').hidden), '...with "Keep AI on this site"');
    ok(await pg.evaluate(() => !document.getElementById('reportBtn').hidden), '...and "This site looks broken"');
    const asked = (await pg.evaluate(() => window.__calls)).filter((c) => c[0] === 'tabs.sendMessage');
    ok(asked.length === 1 && asked[0][1] === 7 && JSON.stringify(asked[0][2]) === '{"type":"where"}',
      'the popup asked that tab, once, and sent nothing but the question');
    await pg.close();
    // A tab address the browser does show is used as it is; the page is not asked.
    const shown = await openPopup({}, 'https://www.google.com/search?q=widgets', { where: 'elsewhere.example' });
    ok(await shown.evaluate(() => document.getElementById('siteHost').textContent) === 'www.google.com', 'a tab address the browser shows wins');
    ok(!(await shown.evaluate(() => window.__calls)).some((c) => c[0] === 'tabs.sendMessage'), '...and the page is not asked');
    await shown.close();
    // No address and nothing of Quell's in the tab: Quell really is not running there.
    const none = await openPopup({}, null);
    ok(/doesn’t run on this page/.test(await none.evaluate(() => document.getElementById('pageStatus').textContent)),
      'no tab address and no answer: "Quell doesn’t run on this page."');
    ok(await none.evaluate(() => document.getElementById('siteCard').hidden), '...and no This-site card');
    await none.close();
    // An answer that is not a hostname is not believed.
    for (const junk of ['', 'not a host', 42, 'user@evil.example', 'a.example/path?x=1', 'a.example:99']) {
      const j = await openPopup({}, null, { where: junk });
      ok(await j.evaluate(() => document.getElementById('siteCard').hidden), `an answer of ${JSON.stringify(junk)} is not taken for a site`);
      await j.close();
    }
  }
  // The footer fits the popup: four links on Chrome, three where Rate is hidden.
  // (Before 0.7.1 it was one line 415px wide in a 340px popup.)
  for (const [name, ua] of [['Chrome', undefined], ['Opera', OPERA_UA], ['Edge', EDGE_UA]]) {
    const pg = await openPopup({}, undefined, { ua, width: 340 });
    const m = await pg.evaluate(() => ({ doc: document.documentElement.scrollWidth,
      right: Math.max(...[...document.querySelectorAll('footer a')].filter((a) => a.offsetParent).map((a) => a.getBoundingClientRect().right)) }));
    ok(m.doc <= 340 && m.right <= 340 - 16 + 0.5, `the footer fits a 340px popup on ${name} (page ${m.doc}px, last link ends at ${Math.round(m.right)}px)`);
    await pg.close();
  }
  // Two of the four Google surfaces are more than one thing: the question says "them".
  {
    const pg = await openPopup({});
    for (const [id, word] of [['sGemini', 'them'], ['sOverview', 'it'], ['sAiMode', 'it']]) {
      await pg.click(`label.switch:has(#${id})`);
      await pg.waitForTimeout(120);
      const body = await pg.evaluate(() => document.getElementById('confirmB').textContent);
      ok(new RegExp(`will show ${word} as usual\\. You can hide ${word} again`).test(body), `the question for ${id} says "${word}" ("${body}")`);
      await pg.click('#confirmNo');
    }
    await pg.close();
  }
  // Status line: the per-tab count, in words.
  {
    const pg = await openPopup({});
    ok(/hid 4 things/i.test(await pg.evaluate(() => document.getElementById('pageStatus').textContent)),
      'status says what Quell hid on THIS page (from the per-tab count)');
    ok(await pg.evaluate(() => document.getElementById('siteHost').textContent) === 'www.google.com', 'site card names the host');
    ok(await pg.evaluate(() => !document.getElementById('siteAiRow').hidden), '"Keep AI on this site" offered on a search engine');
    ok(await pg.evaluate(() => document.getElementById('siteRow').hidden && document.getElementById('sitePopRow').hidden),
      'cookie/pop-up pause rows only appear when those features are on');
    await pg.close();
  }
  // Confirm before an AI surface is shown again — "Keep hidden" changes nothing.
  {
    const pg = await openPopup({});
    await pg.click('#sOverview');
    await pg.waitForTimeout(150);
    ok(await dlgOpen(pg, 'confirmDlg'), 'switching the AI Overview back on asks first');
    ok((await stored(pg)).hideOverview === undefined, 'nothing is saved while the question is open');
    await pg.click('#confirmNo');
    await pg.waitForTimeout(200);
    ok((await stored(pg)).hideOverview === undefined && await pg.evaluate(() => document.getElementById('sOverview').checked),
      '"Keep hidden" leaves the setting AND the switch as they were');
    await pg.click('#sOverview');
    await pg.waitForTimeout(150);
    await pg.click('#confirmYes');
    await pg.waitForTimeout(200);
    ok((await stored(pg)).hideOverview === false && !(await pg.evaluate(() => document.getElementById('sOverview').checked)),
      '"Show it" saves the change');
    // Esc is a "no".
    await pg.click('#bing');
    await pg.waitForTimeout(150);
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(200);
    ok((await stored(pg)).bingEnabled === undefined && await pg.evaluate(() => document.getElementById('bing').checked),
      'Esc on the question keeps Bing Copilot hidden');
    // Hiding MORE never asks.
    await pg.click('#sPaa');
    await pg.waitForTimeout(200);
    ok(!(await dlgOpen(pg, 'confirmDlg')) && (await stored(pg)).hidePaa === true, 'switching a hide ON saves at once, no question');
    await pg.close();
  }
  // Master switch and Search group ask too.
  {
    const pg = await openPopup({});
    await pg.click('#enabled');
    await pg.waitForTimeout(150);
    ok(await dlgOpen(pg, 'confirmDlg'), 'turning Quell off asks first');
    await pg.click('#confirmYes');
    await pg.waitForTimeout(200);
    ok((await stored(pg)).enabled === false, 'confirmed: Quell off');
    await pg.click('#enabled');
    await pg.waitForTimeout(200);
    ok((await stored(pg)).enabled === true && !(await dlgOpen(pg, 'confirmDlg')), 'turning Quell ON never asks');
    await pg.close();
  }
  // Keep AI on this site: confirm, then the host goes into aiAllowlist.
  {
    const pg = await openPopup({});
    await pg.click('#siteAi');
    await pg.waitForTimeout(150);
    ok(await dlgOpen(pg, 'confirmDlg'), '"Keep AI on this site" asks first');
    await pg.click('#confirmYes');
    await pg.waitForTimeout(200);
    ok(JSON.stringify((await stored(pg)).aiAllowlist) === '["www.google.com"]', 'the host is added to aiAllowlist');
    await pg.click('#siteAi');
    await pg.waitForTimeout(200);
    ok(JSON.stringify((await stored(pg)).aiAllowlist) === '[]', 'switching it back removes it, no question');
    await pg.close();
  }
  // A synced list at its byte budget is refused with a message, not dropped.
  {
    const full = Array.from({ length: 400 }, (_, i) => `site-${i}.example.com`);
    const pg = await openPopup({ cookieEnabled: true, cookieAllowlist: full }, 'https://news.example.org/');
    await pg.click('#siteAllow');
    await pg.waitForTimeout(200);
    ok(await pg.evaluate(() => !document.getElementById('saveError').hidden && /full/i.test(document.getElementById('saveError').textContent)),
      'a paused-site list over the sync budget shows "full" instead of failing silently');
    ok(!(await stored(pg)).cookieAllowlist.includes('news.example.org') && !(await pg.evaluate(() => document.getElementById('siteAllow').checked)),
      'and the switch reflects that nothing was saved');
    await pg.close();
  }
  // Breakage report: shows exactly what goes, sends exactly that, once.
  {
    const pg = await openPopup({}, 'https://shop.example.co.uk/basket/123?session=abc#x');
    await pg.click('#reportBtn');
    await pg.waitForTimeout(150);
    ok(await dlgOpen(pg, 'reportDlg'), 'the report opens a confirmation first');
    const shown = JSON.parse(await pg.evaluate(() => document.getElementById('reportPayload').textContent));
    ok(JSON.stringify(shown) === JSON.stringify({ host: 'shop.example.co.uk', version: '0.6.0' }),
      `the dialog shows exactly {host, version} — no path, query or fragment (${JSON.stringify(shown)})`);
    ok(reports.length === 0, 'nothing is sent before the user presses Send');
    await pg.click('#reportCancel');
    await pg.waitForTimeout(150);
    ok(reports.length === 0 && !(await dlgOpen(pg, 'reportDlg')), 'Cancel sends nothing');
    await pg.click('#reportBtn');
    await pg.waitForTimeout(100);
    await pg.click('#reportSend');
    await pg.waitForTimeout(500);
    ok(reports.length === 1, `Send makes exactly one request (${reports.length})`);
    const rep = reports[0] || { headers: {} };
    ok(rep.method === 'POST' && JSON.stringify(JSON.parse(rep.body || '{}')) === JSON.stringify(shown),
      `the body sent is byte-for-byte what was shown (${rep.body})`);
    ok(/^text\/plain/.test(rep.headers['content-type'] || ''), 'sent as text/plain (a CORS simple request, no host permission needed)');
    ok(!rep.headers.cookie && !rep.headers.referer, 'no cookie and no referrer travel with it');
    ok(/Sent/.test(await pg.evaluate(() => document.getElementById('reportStatus').textContent)), 'the user is told it was sent');
    await pg.close();
  }
  // Review #6: never offer a report the endpoint must refuse — same host rule.
  for (const url of ['http://192.168.1.10/admin', 'http://localhost:3000/', 'http://nas.local/', 'https://my_site.example.org/']) {
    const pg = await openPopup({}, url);
    const h = new URL(url).hostname;
    ok(await pg.evaluate(() => !document.getElementById('siteCard').hidden) && await pg.evaluate(() => document.getElementById('reportBtn').hidden),
      `no report button for ${h} (the endpoint would refuse it)`);
    await pg.close();
  }
  // ...and a refusal that does happen says what it means, not "try again later".
  for (const [status, re, name] of [[400, /public website/, '400'], [429, /minute/, '429'], [500, /try again later/, '500']]) {
    endpointStatus = status;
    const pg = await openPopup({}, 'https://shop.example.com/');
    await pg.click('#reportBtn');
    await pg.waitForTimeout(100);
    await pg.click('#reportSend');
    await pg.waitForTimeout(400);
    const msg = await pg.evaluate(() => document.getElementById('reportStatus').textContent);
    ok(re.test(msg), `a ${name} from the endpoint is explained ("${msg}")`);
    if (status === 400) ok(await pg.evaluate(() => document.getElementById('reportSend').hidden), '...and Send is not offered again for a 400');
    await pg.close();
  }
  endpointStatus = 204;
}

// --- Quell off means off (owner report 2026-10-01) ----------------------------
// "Even when I turned the entire Quell app off, some of the AI pop-ups were
// still being blocked." Walked on the real extension with the master switch
// off, four things were still in effect. Each block below is one of them and
// fails on the code as it was.

// (1) The toolbar badge kept its number on every open tab, over a popup that
// said "Nothing is hidden anywhere".
console.log('Quell off — the toolbar badge:');
{
  await sw.evaluate(() => QuellSettings.set({ enabled: true, aiEnabled: true, googleMode: 'hide', bingEnabled: true, aiAllowlist: [] }));
  const badges = () => sw.evaluate(async () => {
    const out = [];
    for (const t of await chrome.tabs.query({})) out.push(await chrome.action.getBadgeText({ tabId: t.id }));
    return out.filter(Boolean);
  });
  const until = async (want) => {
    for (let i = 0; i < 120; i++) { if (JSON.stringify(await badges()) === want) return; await new Promise((r) => setTimeout(r, 100)); }
  };
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.goto('https://www.google.com/search?q=badge');
  await until('["2"]');
  ok(JSON.stringify(await badges()) === '["2"]', `precondition: the tab's badge counts what was hidden (${JSON.stringify(await badges())})`);
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await until('[]');
  ok((await badges()).length === 0, `Quell off clears the badge on the open tab (${JSON.stringify(await badges())})`);
  await sw.evaluate(() => QuellSettings.set({ enabled: true }));
  await until('["2"]');
  ok(JSON.stringify(await badges()) === '["2"]', `Quell back on shows the same count again, not an empty badge (${JSON.stringify(await badges())})`);
  await page.close();
}

// (2) Classic results rewrites the address, and the rewrite replaces the tab's
// history entry. Back, a restored session or a tab the browser put to sleep
// reload that address — with Quell off it stayed on Google's AI-free list, and
// so did every search made from it (Google's form carries udm=14 forward).
console.log('Quell off — a Classic results address is not left behind:');
{
  await sw.evaluate(() => QuellSettings.set({ enabled: true, googleMode: 'cleanweb' }));
  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await page.route('http://result.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><p>a result</p>' }));
  const onGoogle = (pred) => page.waitForURL((u) => u.hostname === 'www.google.com' && pred(u), { timeout: 60000 }).catch(() => {});
  await page.goto('https://www.google.com/search?q=test');
  await onGoogle((u) => u.searchParams.get('udm') === '14');
  ok(page.url() === 'https://www.google.com/search?q=test&udm=14', `precondition: Classic results redirected this tab (${page.url()})`);
  await page.goto('http://result.test/'); // the user opens a result
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await page.goBack().catch(() => {});
  await onGoogle((u) => !u.searchParams.has('udm'));
  ok(page.url() === 'https://www.google.com/search?q=test',
    `Back to the address Quell rewrote, with Quell off, returns to Google as Google serves it (${page.url()})`);
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => document.getElementById('ai-block').getClientRects().length > 0), '...and nothing is hidden there');

  // The user's OWN udm=14 is still theirs — Quell off must not strip it.
  await page.goto('https://www.google.com/search?q=mine&udm=14');
  await page.waitForTimeout(600);
  ok(page.url().includes('udm=14'), `a udm=14 the user chose is left alone with Quell off (${page.url().slice(-16)})`);
  await page.close();

  // ...including in a tab Quell redirected earlier. The mark for that redirect
  // stops applying once the tab has been on a results page without udm=14.
  await sw.evaluate(() => QuellSettings.set({ enabled: true, googleMode: 'cleanweb' }));
  const p2 = await ctx.newPage();
  await p2.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await p2.route('http://result.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><p>a result</p>' }));
  await p2.goto('https://www.google.com/search?q=a');
  await p2.waitForURL((u) => u.searchParams.get('udm') === '14', { timeout: 60000 }).catch(() => {});
  await p2.goto('http://result.test/');
  await sw.evaluate(() => QuellSettings.set({ googleMode: 'hide' }));
  await p2.goto('https://www.google.com/search?q=b');
  await p2.waitForFunction(() => document.getElementById('ai-block')?.getClientRects().length === 0, null, { timeout: 60000 }).catch(() => {});
  ok(!p2.url().includes('udm') && await p2.evaluate(() => sessionStorage.getItem('__quellCleanWeb')) === null,
    'the redirect mark is dropped once the tab is on a results page without udm=14');
  await sw.evaluate(() => QuellSettings.set({ enabled: false }));
  await p2.goto('https://www.google.com/search?q=c&udm=14');
  await p2.waitForTimeout(600);
  ok(p2.url().includes('udm=14'), `so a later udm=14 the user chose in that tab is left alone too (${p2.url().slice(-16)})`);
  await p2.close();
  await sw.evaluate(() => QuellSettings.set({ enabled: true, googleMode: 'hide' }));
}

// The same for DuckDuckGo's "Off at the source" (engines.js, injected with a
// stubbed chrome like the other engine tests; the stub's state lives in
// sessionStorage so it survives the reload).
console.log('Quell off — an "Off at the source" address is not left behind:');
{
  const commonSrc = (SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8'));
  const engineSrc = readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  const stub = `window.__state=JSON.parse(sessionStorage.getItem('__st')||'{"enabled":true,"ddgMode":"clean"}');
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};`;
  const pg = await ctx.newPage();
  await pg.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
  await pg.addInitScript({ content: stub });
  const inject = async () => { await pg.addScriptTag({ content: commonSrc }).catch(() => {}); await pg.addScriptTag({ content: engineSrc }).catch(() => {}); };
  await pg.goto('https://duckduckgo.com/?q=abc');
  await inject();
  await pg.waitForURL((u) => u.searchParams.get('assist') === 'false', { timeout: 5000 }).catch(() => {});
  ok(pg.url() === 'https://duckduckgo.com/?q=abc&assist=false', `precondition: clean mode redirected (${pg.url()})`);
  // Quell is switched off while this tab is asleep; the tab then reloads.
  await pg.evaluate(() => sessionStorage.setItem('__st', '{"enabled":false,"ddgMode":"clean"}'));
  await pg.reload();
  await inject();
  await pg.waitForURL((u) => !u.searchParams.has('assist'), { timeout: 5000 }).catch(() => {});
  ok(pg.url() === 'https://duckduckgo.com/?q=abc', `reloaded with Quell off, the tab drops the parameter Quell added (${pg.url()})`);
  await pg.goto('https://duckduckgo.com/?q=mine&assist=false');
  await inject();
  await pg.waitForTimeout(500);
  ok(pg.url() === 'https://duckduckgo.com/?q=mine&assist=false', `an assist=false the user set is left alone with Quell off (${pg.url()})`);
  await pg.close();
}

// (3) The generic cookie list. Chrome injects rules/cookie-generic.css itself
// and cannot take it out of a loaded page, so with Quell off — or the feature
// off, or the site paused — it went on hiding on the open page. Every rule in
// the sheet is now gated on a mark cookies.js sets on <html>.
console.log('Quell off — the generic cookie list lifts on the open page:');
{
  const CSS = readFileSync(path.join(EXT, 'rules/cookie-generic.css'), 'utf8');
  const cookieSrc = readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
  const pipeline = readFileSync(path.join(EXT, '..', 'pipeline', 'build_rules.py'), 'utf8');
  const gate = (pipeline.match(/^GENERIC_GATE = '([^']+)'/m) || [])[1];
  const attr = (cookieSrc.match(/const GENERIC_OFF = '([^']+)'/) || [])[1];
  ok(!!gate && !!attr && gate === `:root:not([${attr}="off"])`,
    `the pipeline's gate and the content script's mark are the same thing (${gate} / ${attr})`);
  const chunks = CSS.split('\n').filter((l) => l.includes('display:none'));
  ok(!!gate && chunks.length > 10 && chunks.every((l) => l.startsWith(gate + '{') && l.endsWith('{display:none!important;}}')),
    `every rule of the shipped sheet sits inside the gate (${chunks.length} chunks)`);
  const GEN = (CSS.match(/#[A-Za-z][\w-]*(?=,)/) || [])[0];
  ok(!!GEN, `precondition: the sheet has a simple id selector to build a fixture from (${GEN})`);

  const stub = (state) => `window.__quellState=${JSON.stringify(state)};
    window.__quellCbs=[];
    window.chrome={
      storage:{local:{get:async(d)=>({...d,...window.__quellState})},
      onChanged:{addListener:(f)=>window.__quellCbs.push(f)}},
      runtime:{sendMessage:async()=>({selectors:[]})}
    };
    window.__quellSet=(patch)=>{Object.assign(window.__quellState,patch);
      const ch={};for(const k of Object.keys(patch))ch[k]={newValue:patch[k]};
      window.__quellCbs.forEach(f=>f(ch,'local'));};`;
  const open = async (state) => {
    const pg = await ctx.newPage();
    await pg.route('http://cmp-fixture.test/**', (r) => r.fulfill({ contentType: 'text/html',
      body: CMP_FIXTURE.replace('<div id="content">', `<div id="${GEN.slice(1)}">a banner only the generic list knows</div><div id="content">`) }));
    await pg.goto('http://cmp-fixture.test/');
    await pg.addStyleTag({ content: CSS }); // what Chrome injects with the registered script
    await pg.addScriptTag({ content: stub(state) + '\n' + SETTINGS_SRC + '\n' + cookieSrc });
    await pg.waitForTimeout(400);
    return pg;
  };
  const shown = (pg, sel) => pg.evaluate((s) => document.querySelector(s).getClientRects().length > 0, sel);

  const page = await open({ enabled: true, cookieEnabled: true, cookieAllowlist: [] });
  ok(!(await shown(page, GEN)) && !(await shown(page, '#onetrust-banner-sdk')), 'baseline: the generic list and the curated list both hide');
  await page.evaluate(() => window.__quellSet({ enabled: false }));
  await page.waitForTimeout(400);
  ok(await shown(page, GEN), 'Quell off shows a banner the generic list was hiding, on the open page (no reload)');
  ok(await shown(page, '#onetrust-banner-sdk'), '...and the curated one');
  await page.evaluate(() => window.__quellSet({ enabled: true }));
  await page.waitForTimeout(400);
  ok(!(await shown(page, GEN)), 'Quell back on hides it again');
  await page.evaluate(() => window.__quellSet({ cookieAllowlist: ['cmp-fixture.test'] }));
  await page.waitForTimeout(400);
  ok(await shown(page, GEN), 'pausing the site lifts the generic list on the open page too');
  await page.close();

  const paused = await open({ enabled: true, cookieEnabled: true, cookieAllowlist: ['cmp-fixture.test'] });
  ok(await shown(paused, GEN), 'a paused site is not hidden by the generic list on a fresh load either');
  await paused.close();
}

// (4) A content script outlives its extension. After an update — or Quell
// disabled or removed in the browser — the copy in an open tab has no storage
// and no messages, so no switch reaches it: it went on hiding, and hiding new
// blocks, until the tab was reloaded.
console.log('Quell off — a copy cut off from the extension stands down:');
{
  // cookies.js against a stub whose extension can be taken away. Each copy
  // gets its own `chrome`, and a second copy starts from a clean slate, the
  // way a newly injected one gets a fresh isolated world (measured).
  const cookieSrc = readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
  const copy = (name) => `window.${name}={storage:{local:{get:async(d)=>({...d,...(window.${name}State||{})})},
      onChanged:{addListener:(f)=>{window.${name}Cb=f;}}},runtime:{id:'quell-test',sendMessage:async(m)=>{(window.${name}Msgs=window.${name}Msgs||[]).push(m);return {selectors:[]};}}};
    delete globalThis.QuellSettings; delete window.__quellCookies;
    (function(chrome){\n${SETTINGS_SRC}\n${cookieSrc}\n})(window.${name});`;
  const open = async () => {
    const pg = await ctx.newPage();
    await pg.route('http://cmp-fixture.test/**', (r) => r.fulfill({ contentType: 'text/html', body: CMP_FIXTURE }));
    await pg.goto('http://cmp-fixture.test/');
    await pg.addScriptTag({ content: copy('__extA') });
    await pg.waitForTimeout(400);
    return pg;
  };
  const banner = (pg) => pg.evaluate(() => document.getElementById('onetrust-banner-sdk').getClientRects().length > 0);
  const until = (pg, want) => pg.waitForFunction((w) => (document.getElementById('onetrust-banner-sdk').getClientRects().length > 0) === w,
    want, { timeout: 8000 }).catch(() => {});

  const page = await open();
  ok(!(await banner(page)), 'baseline: banner hidden');
  await page.evaluate(() => { delete window.__extA.runtime.id; }); // the extension is gone
  await until(page, true);
  ok(await banner(page), 'with its extension gone the script puts the banner back by itself');
  ok(await page.evaluate(() => !document.getElementById('quell-cookies') && getComputedStyle(document.body).overflow === 'hidden'),
    "...its stylesheet is out and the site's own scroll lock is back");
  await page.close();

  // An update: the old copy is cut off and the new version's copy arrives in
  // the same page straight away (the background injects it). The old one has
  // to be out of the way BEFORE the new one starts, or it takes the new one's
  // stylesheet down with it when its own timer fires.
  const p2 = await open();
  await p2.evaluate(() => { delete window.__extA.runtime.id; });
  await p2.evaluate(() => { window.__extBState = { enabled: true, cookieEnabled: true }; });
  await p2.addScriptTag({ content: copy('__extB') });
  await p2.waitForTimeout(400);
  ok(!(await banner(p2)) && await p2.evaluate(() => document.querySelectorAll('#quell-cookies').length === 1),
    'a new copy arriving after an update takes over: banner still hidden, one stylesheet');
  // The old copy's count went with its extension, so the new one has to count
  // the banner it is hiding, or the badge sits empty over a page that hides.
  const counted = (pg, name) => pg.evaluate((n) => (window[n + 'Msgs'] || []).filter((m) => m && m.type === 'blocked').reduce((a, m) => a + m.count, 0), name);
  ok(await counted(p2, '__extA') > 0 && await counted(p2, '__extB') > 0,
    `...and counts what it hides (old copy ${await counted(p2, '__extA')}, new copy ${await counted(p2, '__extB')})`);
  await p2.waitForTimeout(2600); // past the old copy's own check
  ok(!(await banner(p2)), '...and the old copy does not undo the new one afterwards');
  await p2.evaluate(() => { window.__extBState.enabled = false; window.__extBCb({ enabled: { newValue: false } }, 'sync'); });
  await until(p2, true);
  ok(await banner(p2), '...which then obeys the switch: Quell off shows the banner');
  await p2.close();

  // A page cannot use the hand-over signal to switch a working Quell off.
  const p3 = await open();
  await p3.evaluate(() => document.dispatchEvent(new Event('quell-takeover')));
  await p3.waitForTimeout(300);
  ok(!(await banner(p3)), 'a page sending the hand-over signal to a working copy changes nothing');
  await p3.close();

  // The other two scripts Quell puts into pages on a grant stand down the same way.
  const shownIn = (pg, x) => pg.evaluate((i) => document.getElementById(i).getClientRects().length > 0, x);
  const untilIn = (pg, x, want) => pg.waitForFunction(([i, w]) => (document.getElementById(i).getClientRects().length > 0) === w,
    [x, want], { timeout: 8000 }).catch(() => {});
  const wrapped = (stubSrc, src) => `window.__ext=${stubSrc};(function(chrome){\n${SETTINGS_SRC}\n${src}\n})(window.__ext);`;

  const ddg = await ctx.newPage();
  await ddg.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: DDG_FIXTURE }));
  await ddg.goto('https://duckduckgo.com/?q=test');
  await ddg.addScriptTag({ content: wrapped(
    `{storage:{local:{get:async(d)=>({...d,enabled:true,ddgMode:'hide'})},onChanged:{addListener(){}}},runtime:{id:'quell-test',sendMessage(){}}}`,
    readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8') + '\n' + readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8')) });
  await untilIn(ddg, 'ddg-ai', false);
  ok(!(await shownIn(ddg, 'ddg-ai')) && !(await shownIn(ddg, 'ddg-ai-labelonly')), 'baseline: DuckDuckGo AI card hidden (stylesheet and label pass)');
  await ddg.evaluate(() => { delete window.__ext.runtime.id; });
  await untilIn(ddg, 'ddg-ai', true);
  ok(await shownIn(ddg, 'ddg-ai') && await shownIn(ddg, 'ddg-ai-labelonly'), 'engines.js: with its extension gone, both come back');
  await ddg.close();

  const pop = await ctx.newPage();
  await pop.route('http://popups.test/**', (r) => r.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><main><h1>Page</h1></main><div id="intercom-container">chat</div></body></html>' }));
  await pop.goto('http://popups.test/');
  await pop.addScriptTag({ content: wrapped(
    `{storage:{local:{get:async(d)=>({...d,enabled:true,popupsEnabled:true})},onChanged:{addListener(){}}},runtime:{id:'quell-test',sendMessage:async(m)=>(m.type==='popupRules'?{generic:[],site:[]}:undefined)}}`,
    readFileSync(path.join(EXT, 'src/content/popups.js'), 'utf8')) });
  await untilIn(pop, 'intercom-container', false);
  ok(!(await shownIn(pop, 'intercom-container')), 'baseline: chat widget hidden');
  await pop.evaluate(() => { delete window.__ext.runtime.id; });
  await untilIn(pop, 'intercom-container', true);
  ok(await shownIn(pop, 'intercom-container'), 'popups.js: with its extension gone, the chat widget comes back');
  await pop.close();
}

// The same on the real extension, on Google and Bing: tabs left open across an
// update. Its own browser, because the reload replaces the service worker the
// rest of this suite holds.
console.log('Quell off — Google and Bing tabs left open across an update:');
{
  const { ctx: c2, sw: w2 } = await getContext();
  const id2 = new URL(w2.url()).host;
  const g = await c2.newPage();
  await g.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_FIXTURE }));
  await g.goto('https://www.google.com/search?q=test');
  const b = await c2.newPage();
  await b.route('https://www.bing.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: BING_FIXTURE }));
  await b.goto('https://www.bing.com/search?q=test');
  const shown = (pg, x) => pg.evaluate((i) => document.getElementById(i).getClientRects().length > 0, x);
  const until = (pg, x, want, ms = 60000) => pg.waitForFunction(([i, w]) => (document.getElementById(i).getClientRects().length > 0) === w,
    [x, want], { timeout: ms }).catch(() => {});
  await until(g, 'ai-block', false); await until(b, 'b_sydConvCont', false);
  ok(!(await shown(g, 'ai-block')) && !(await shown(b, 'b_sydConvCont')), 'baseline: AI Overview and Copilot hidden');

  // Reload the extension the way an update does. Developer mode keeps an
  // unpacked extension enabled across it.
  const mgr = await c2.newPage();
  let reloaded = false;
  try {
    await mgr.goto('chrome://extensions/');
    await mgr.evaluate(() => new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, res)));
    await mgr.evaluate((x) => new Promise((res) => chrome.developerPrivate.reload(x, { failQuietly: true }, res)), id2);
    for (let i = 0; i < 100 && !reloaded; i++) {
      await new Promise((r) => setTimeout(r, 100));
      reloaded = await mgr.evaluate((x) => new Promise((res) => chrome.developerPrivate.getExtensionInfo(x, (e) => res(e && e.state === 'ENABLED'))), id2).catch(() => false);
    }
  } catch (_) { /* reported below */ }
  if (!reloaded) {
    skip('tabs open across an update', 'this Chromium would not reload the extension from chrome://extensions');
  } else {
    await until(g, 'ai-block', true, 15000); await until(b, 'b_sydConvCont', true, 15000);
    ok(await shown(g, 'ai-block') && await shown(g, 'ai-block-css'), 'Google: the old copy stops hiding (label pass and stylesheet both)');
    ok(await g.evaluate(() => !document.getElementById('quell-google') && !document.querySelector('[data-quell-hidden]')),
      'Google: its stylesheet and its marks are gone');
    ok(await shown(b, 'b_sydConvCont') && await shown(b, 'chip-1'), 'Bing: the old copy stops hiding');
    // ...and stays out: a block arriving later is not hidden by the old observer.
    await g.evaluate(() => {
      const d = document.createElement('div'); d.className = 'MjjYud'; d.id = 'late-ai';
      d.innerHTML = '<div role="heading">AI Overview</div><p>late</p>';
      document.getElementById('rso').appendChild(d);
    });
    await g.waitForTimeout(600);
    ok(await shown(g, 'late-ai'), 'Google: an AI block arriving later is left alone (the old observer is stopped)');
    // The next load runs the new version, which hides again — Quell is still on.
    await g.reload();
    await until(g, 'ai-block', false);
    ok(!(await shown(g, 'ai-block')), 'the next load of that tab runs the current Quell, which hides again');
  }
  await c2.close();
}

await ctx.close();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
