// Quell — real-Firefox checks (headless), OPTIONAL.
//
// Playwright's Firefox build cannot install extensions, so this uses
// Puppeteer over WebDriver BiDi against an installed Firefox:
//   QUELL_FIREFOX_BIN=/Applications/Firefox.app/Contents/MacOS/firefox \
//   QUELL_PUPPETEER=/path/to/node_modules/puppeteer  node tests/firefox.mjs
// Without both, it prints SKIP and exits 0 (CI has neither).
//
// What it proves on real Firefox: the derived Firefox manifest installs; the
// background event page runs (settings.js + background.js), fires onInstalled
// 'install' and opens the welcome page; the Google and Bing content scripts
// hide AI while organic results survive; and a storage.sync write reaches an
// open page live. What it cannot reach: the toolbar popup and Firefox's
// permission prompts (BiDi refuses to navigate to moz-extension:// pages), and
// Firefox for Android.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = process.env.QUELL_FIREFOX_BIN;
const PPTR = process.env.QUELL_PUPPETEER;
let passed = 0, failed = 0;
const ok = (c, n) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ FAIL ${n}`); } };

console.log('Firefox (real browser, headless):');
if (!BIN || !PPTR) {
  console.log('  ⊘ SKIP — set QUELL_FIREFOX_BIN and QUELL_PUPPETEER to run');
  process.exit(0);
}
const pkg = JSON.parse(readFileSync(path.join(PPTR, 'package.json'), 'utf8'));
const entry = pkg.exports?.['.']?.import || pkg.module || pkg.main;
const puppeteer = (await import(pathToFileURL(path.join(PPTR, entry)).href)).default;

// Build the Firefox variant from the source tree, plus a TEST-ONLY hook that
// reports background milestones by opening https://example.com/?stage=… tabs
// (BiDi cannot see extension pages, but it can see those).
const dir = mkdtempSync(path.join(tmpdir(), 'quell-ff-'));
cpSync(path.join(ROOT, 'extension'), dir, { recursive: true, filter: (s) => !s.includes('_metadata') });
writeFileSync(path.join(dir, 'manifest.json'),
  execFileSync('python3', [path.join(ROOT, 'pipeline/make_manifest.py'), 'firefox']));
const bgPath = path.join(dir, 'src/background.js');
writeFileSync(bgPath, readFileSync(bgPath, 'utf8') + `
;/* TEST HOOK (tests/firefox.mjs only) */
const __stage = (s) => chrome.tabs.create({ url: 'https://example.com/?stage=' + encodeURIComponent(s) });
chrome.runtime.onInstalled.addListener(async (d) => {
  __stage('installed-' + d.reason + '-' + typeof QuellSettings);
  setTimeout(async () => {
    const tabs = await chrome.tabs.query({});
    const w = tabs.find((t) => (t.url || '').endsWith('/src/welcome/welcome.html'));
    __stage('welcome-' + (w ? w.title : 'none'));
  }, 1200);
  setTimeout(async () => { await QuellSettings.set({ hideOverview: false }); __stage('synced'); }, 12000);
});
`);

const G = `<!doctype html><html><body><div id="search"><div id="rso">
<div class="MjjYud" id="ai-block"><div role="heading">AI Overview</div><p>gen</p></div>
<div class="MjjYud" id="organic"><a href="https://example.com/x"><h3>AI Mode explained</h3></a></div></div></div></body></html>`;
const B = `<!doctype html><html><body><header id="b_header"><nav class="b_scopebar"><a id="scope" href="/copilotsearch?q=t">Search</a></nav></header>
<div id="b_results"><li class="b_algo" id="org"><a href="https://copilot.microsoft.com/">Microsoft Copilot</a></li>
<div><a id="org-cs" href="/copilotsearch?q=t&form=ORG">An article</a></div></div>
<div id="b_copilot_search_container"><a class="suggestion_chip" id="chip" href="/copilotsearch?q=c">chip</a></div></body></html>`;

const browser = await puppeteer.launch({ browser: 'firefox', headless: true, executablePath: BIN });
try {
  const id = await browser.installExtension(dir);
  ok(id === 'quell@purpledirective.com', `the Firefox build installs (${id}, ${await browser.version()})`);
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('https://www.google.com/search')) return req.respond({ status: 200, contentType: 'text/html', body: G });
    if (u.startsWith('https://www.bing.com/search')) return req.respond({ status: 200, contentType: 'text/html', body: B });
    return req.continue();
  });
  const vis = (x) => page.evaluate((i) => document.getElementById(i).getClientRects().length > 0, x);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await page.goto('https://www.google.com/search?q=test');
  await wait(1500);
  ok(!(await vis('ai-block')), 'Google: AI Overview hidden');
  ok(await vis('organic'), 'Google: organic result titled "AI Mode…" kept');

  await page.goto('https://www.bing.com/search?q=test');
  await wait(1200);
  ok(!(await vis('scope')) && !(await vis('chip')), 'Bing: Copilot tab and suggestion chip hidden');
  ok(await vis('org') && await vis('org-cs'), 'Bing: organic results kept (incl. one linking to /copilotsearch)');

  const stages = () => browser.targets().map((t) => t.url()).filter((u) => u.includes('stage='))
    .map((u) => decodeURIComponent(u.split('stage=')[1]));
  ok(stages().includes('installed-install-object'), `background event page ran settings.js + onInstalled('install') (${stages().join(' | ')})`);
  ok(stages().includes('welcome-Welcome to Quell'), 'the welcome page opened on install');

  await page.goto('https://www.google.com/search?q=test2');
  await wait(1000);
  ok(!(await vis('ai-block')), 'precondition: hidden before the synced change');
  for (let i = 0; i < 40 && !stages().includes('synced'); i++) await wait(500);
  await wait(800);
  ok(stages().includes('synced') && await vis('ai-block'), 'a storage.sync write reaches the open page live (overview released)');
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
