// Quell — co-existence suite.
//
// The smoke suite proves Quell works ALONE. Users do not run it alone: the
// people who install an AI-overview blocker are the same people running uBlock
// Origin, Consent-O-Matic, Dark Reader. Two extensions each injecting CSS and
// each running a MutationObserver that MUTATES on mutation is the shape that
// ping-pongs, and neither extension's own test suite can see it.
//
// So this loads Quell alongside a deliberately adversarial test double
// (tests/fixtures/rival-ext) and asserts three things that matter to a user:
//   1. Quell still hides what it is supposed to hide.
//   2. The other extension's work survives Quell.
//   3. Neither observer drives the other — the page settles.
//
// Run: node tests/compat.mjs   (same global-playwright link as run.sh)

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(HERE, '..', 'extension');
const RIVAL = path.resolve(HERE, 'fixtures', 'rival-ext');

let passed = 0, failed = 0, skipped = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL ${name}`); }
};
const skip = (name, why) => { skipped++; console.log(`  ⊘ SKIP ${name} — ${why}`); };

const FIXTURE = `<!doctype html><html><head><title>q - Google Search</title></head><body>
<div id="search"><div id="rso">
  <div class="MjjYud" id="ai-block"><div role="heading">AI Overview</div><p>Generated answer…</p></div>
  <div class="MjjYud" id="organic-1"><a href="https://example.com/a"><h3>First result</h3></a></div>
  <div class="MjjYud" id="organic-2"><a href="https://example.com/b"><h3>Second result</h3></a></div>
</div></div></body></html>`;

async function getContext() {
  for (const headless of [true, false]) {
    // Load BOTH unpacked extensions. Order matters to Chrome only for install
    // id, not for content-script ordering, but keep Quell first for clarity.
    const c = await chromium.launchPersistentContext('', {
      headless,
      args: [
        `--disable-extensions-except=${EXT},${RIVAL}`,
        `--load-extension=${EXT}`,
        `--load-extension=${RIVAL}`,
      ],
    }).catch(() => null);
    if (!c) continue;
    let w = c.serviceWorkers()[0];
    if (!w) w = await c.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (w) return { ctx: c, sw: w };
    await c.close();
  }
  throw new Error('could not load both extensions in Chromium');
}

const { ctx, sw } = await getContext();
ok(!!sw, 'both extensions loaded, a service worker started');

console.log('Co-existence with a rival blocker:');
{
  await sw.evaluate(() => chrome.storage.local.set({
    enabled: true, googleMode: 'hide',
    hideOverview: true, hideAiMode: true, hidePaa: false, hideGemini: true,
  })).catch(() => {});

  const page = await ctx.newPage();
  await page.route('https://www.google.com/search**', (r) =>
    r.fulfill({ contentType: 'text/html', body: FIXTURE }));
  await page.goto('https://www.google.com/search?q=test');
  await page.waitForTimeout(800);

  const vis = (id) => page.evaluate(
    (x) => { const e = document.getElementById(x); return !!e && e.getClientRects().length > 0; }, id);

  // 1. Quell's job still gets done with a rival present.
  ok(!(await vis('ai-block')), 'Quell still hides the AI block with a rival extension loaded');
  ok(await vis('organic-1'), 'organic result 1 survives both extensions');
  ok(await vis('organic-2'), 'organic result 2 survives both extensions');

  // 2. The rival's work survives Quell. If Quell's sweep stripped or reset
  //    foreign attributes, this is where it would show.
  const rivalMarks = await page.evaluate(
    () => document.querySelectorAll('#rso .MjjYud[data-rival-seen="1"]').length);
  ok(rivalMarks >= 2, `rival extension's own DOM marks survive Quell (${rivalMarks} marked)`);
  ok(await page.evaluate(() => !!document.getElementById('rival-style')),
    "rival extension's stylesheet is not removed by Quell");
  ok(await page.evaluate(() => !!document.getElementById('quell-google')),
    "Quell's stylesheet is not removed by the rival");

  // 3. Neither observer drives the other. The rival counts every mutation it
  //    sees; if Quell's sweep re-triggered it (and vice versa) the count grows
  //    without bound. Sample twice while the page is idle: a settled page adds
  //    nothing.
  // The rival publishes its count to the shared DOM precisely because each
  // extension has its OWN isolated world — a counter on `window` would be
  // unreadable here and the assertion could never fail.
  const readCount = () => page.evaluate(
    () => Number(document.documentElement.getAttribute('data-rival-mutations') ?? -1));
  const m1 = await readCount();
  ok(m1 >= 0, 'rival mutation counter is readable (precondition — not a vacuous skip)');
  await page.waitForTimeout(1200);
  const m2 = await readCount();
  ok(m2 === m1, `no observer ping-pong while idle (mutations ${m1} → ${m2})`);

  // A settled page must also stop growing. This one is readable from the page
  // world, so it works regardless of the isolated-world question above.
  const n1 = await page.evaluate(() => document.querySelectorAll('*').length);
  await page.waitForTimeout(1200);
  const n2 = await page.evaluate(() => document.querySelectorAll('*').length);
  ok(n2 === n1, `DOM size is stable while idle (${n1} → ${n2} nodes)`);

  // 4. Toggling Quell off must release ONLY Quell's hiding, not the rival's.
  await sw.evaluate(() => chrome.storage.local.set({ googleMode: 'off' })).catch(() => {});
  await page.waitForTimeout(500);
  ok(await vis('ai-block'), 'turning Quell off releases its own hiding with a rival present');
  ok(await page.evaluate(() => !!document.getElementById('rival-style')),
    "turning Quell off leaves the rival's stylesheet alone");

  await page.close();
}

await ctx.close();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
