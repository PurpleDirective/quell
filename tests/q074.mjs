// Quell 0.7.4 — Google blank-box collapse, AI Mode chrome, "AI on websites".
// Runs headless only (new headless Chromium loads extensions). Fixtures:
//   tests/fixtures/google-live.html  a real Google results page, stripped of all
//                                    account data (see its header comment in git)
//   inline fixtures for 10 sites, reduced to the markup the rules target plus
//   the page's own navigation, search and cart, which must keep working.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.env.QUELL_EXT || path.resolve(HERE, '..', 'extension');
let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ FAIL ${name}`); } };
const SETTINGS_SRC = readFileSync(path.join(EXT, 'src/shared/settings.js'), 'utf8');
const AIWEB_SRC = readFileSync(path.join(EXT, 'src/content/aiweb.js'), 'utf8');
const COSMETIC = JSON.parse(readFileSync(path.join(EXT, 'rules/ai-web-cosmetic.json'), 'utf8')).rules;
const GOOGLE_LIVE = readFileSync(path.join(HERE, 'fixtures', 'google-live.html'), 'utf8');

async function getContext() {
  const c = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let w = c.serviceWorkers()[0];
  if (!w) w = await c.waitForEvent('serviceworker', { timeout: 20000 });
  return { ctx: c, sw: w };
}
const { ctx, sw } = await getContext();
const extId = new URL(sw.url()).host;
const set = (o) => sw.evaluate((s) => QuellSettings.set(s), o);

// ------------------------------------------------ A. Google, live-page fixture --
console.log('Google (live-page fixture): no blank box, AI Mode chrome, organic kept, Peek/Undo:');
{
  await set({ enabled: true, aiEnabled: true, googleMode: 'hide', hideOverview: true, hideAiMode: true, hidePaa: false, hideGemini: true,
    firstRunDone: true, aiAllowlist: [], cookieAllowlist: [], popupAllowlist: [], aiWebAllowlist: [], sitePauses: {} });
  // The live page's JavaScript gives the Overview's wrappers fixed heights the
  // static copy does not have, and its outer wrapper is not the class the CSS
  // layer targets: reproduce both, so the label pass hides an inner block and
  // the wrappers stay behind (live, Japan query: 190-205 px of blank).
  const liveShaped = GOOGLE_LIVE
    .replace('class="bzXtMb M8OgIe"', 'class="bzXtMb M8OgIeLive" style="min-height:205px"')
    .replace('<div class="YNk70c EjQTId"><div class="Kevs9 SLPe5b">', '<div class="YNk70c EjQTId" style="min-height:189px"><div class="Kevs9 SLPe5b" style="min-height:189px">');
  ok(liveShaped !== GOOGLE_LIVE, 'precondition: the live-shaped variant differs from the static fixture');

  const open = async (body, enabled) => {
    await set({ enabled });
    const pg = await ctx.newPage();
    await pg.setViewportSize({ width: 1280, height: 900 });
    await pg.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body }));
    await pg.goto('https://www.google.com/search?q=how+long+to+boil+an+egg', { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(2200);
    return pg;
  };
  const measure = (pg) => pg.evaluate(() => {
    const rcnt = document.getElementById('rcnt');
    // the first visible text inside the results container
    let minTop = Infinity;
    const w = document.createTreeWalker(rcnt, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement;
      if (!n.nodeValue.trim() || !p || !p.getClientRects().length || p.closest('style')) continue;
      const cs = getComputedStyle(p);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      minTop = Math.min(minTop, p.getBoundingClientRect().top);
    }
    const nav = document.querySelector('[role="navigation"]');
    const vis = (e) => e.getClientRects().length > 0;
    const tabs = [...document.querySelectorAll('[role="listitem"] a')].filter(vis).map((a) => a.textContent.trim());
    return {
      rcntTop: rcnt.getBoundingClientRect().top, firstTextTop: minTop, rsoTop: document.getElementById('rso').getBoundingClientRect().top,
      organic: [...document.querySelectorAll('#rso a h3')].filter(vis).length,
      paa: [...document.querySelectorAll('[jsname="Cpkphb"], [data-initq]')].filter(vis).length,
      aiModeTab: tabs.includes('AI Mode'), tabs,
      ask: [...document.querySelectorAll('textarea')].some((t) => /ask anything/i.test(t.getAttribute('aria-label') || '') && vis(t)),
      navBottom: nav ? nav.getBoundingClientRect().bottom : 0,
    };
  });

  const off = await open(liveShaped, false);
  const mOff = await measure(off);
  await off.close();
  ok(mOff.organic > 0 && mOff.aiModeTab && mOff.ask, `Quell off: results, the AI Mode tab and the Ask box are all there (${mOff.organic} results)`);

  for (const [name, body] of [['live-shaped (wrappers left behind)', liveShaped], ['static', GOOGLE_LIVE]]) {
    const pg = await open(body, true);
    const m = await measure(pg);
    ok(m.firstTextTop - m.rcntTop <= 80, `${name}: no empty box above the first result (first text ${Math.round(m.firstTextTop - m.rcntTop)} px below the results area, off: ${Math.round(mOff.firstTextTop - mOff.rcntTop)})`);
    ok(m.organic === mOff.organic && m.organic > 0, `${name}: every organic result is still present (${m.organic} of ${mOff.organic})`);
    ok(m.paa === mOff.paa && m.paa > 0, `${name}: People also ask is kept (${m.paa})`);
    ok(!m.aiModeTab && m.tabs.includes('All') && m.tabs.includes('Images'), `${name}: the AI Mode tab is gone, the other tabs remain (${m.tabs.slice(0, 6).join(', ')})`);
    ok(!m.ask, `${name}: the "Ask anything" AI Mode box is hidden`);
    await pg.close();
  }

  // AI Mode switched off in Quell: the tab and the box come back.
  await set({ hideAiMode: false });
  {
    const pg = await open(liveShaped, true);
    const m = await measure(pg);
    ok(m.aiModeTab, 'with AI Mode left alone, the AI Mode tab stays');
    await pg.close();
  }
  await set({ hideAiMode: true });

  // Peek and Undo restore the wrappers too (real popup, real tab).
  {
    const pg = await open(liveShaped, true);
    const popup = await ctx.newPage();
    await popup.setViewportSize({ width: 360, height: 600 });
    await popup.addInitScript(() => {
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
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForTimeout(1200);
    const labels = await popup.evaluate(() => [...document.querySelectorAll('.item b')].map((b) => b.textContent));
    ok(labels.includes('AI Overview') && labels.includes('AI Mode tab') && labels.includes('AI Mode follow-up box'), `the hidden list names the Overview, the AI Mode tab and the follow-up box (${labels.join(' | ')})`);
    const row = popup.locator('.item', { hasText: 'AI Overview' });
    const before = await measure(pg);
    await row.locator('[data-undo]').click();
    await popup.waitForTimeout(500);
    const after = await measure(pg);
    ok(after.rsoTop > before.rsoTop + 100, `Undo brings the Overview and its wrappers back (the results move down ${Math.round(before.rsoTop)} to ${Math.round(after.rsoTop)})`);
    ok(after.organic === mOff.organic && after.paa === mOff.paa, 'organic results and People also ask all present after Undo');
    await row.locator('[data-undo]').click();
    await popup.waitForTimeout(500);
    const again = await measure(pg);
    ok(Math.abs(again.rsoTop - before.rsoTop) < 5, 'Hide again puts the collapse back');
    await row.locator('[data-peek]').click();
    await popup.waitForTimeout(500);
    const peek = await measure(pg);
    ok(peek.rsoTop > before.rsoTop + 100 && peek.organic === mOff.organic, 'Peek shows it for a moment with every result still present');
    await popup.close();
    await pg.close();
  }
}

// ------------------------------------------------ B. AI on websites, 10 sites --
console.log('AI on websites (cosmetic): ten sites, nothing else touched:');
{
  // Each site: the host, the markup the rule targets (reduced from the live
  // page), a wrapper marked data-probe that must leave no empty box, and the
  // page's own navigation, search and cart, which must keep working.
  const page = (inner) => `<!doctype html><html><body>
    <header><nav id="nav"><a id="home" href="#home">Home</a> <a id="docs" href="#docs">Docs</a></nav>
      <form id="searchform" role="search"><input id="q" type="search" placeholder="Search"></form>
      <button id="cart" onclick="document.body.dataset.cart='1'">Cart (0)</button></header>
    <main><h1>The page</h1><p>Real content.</p></main>${inner}</body></html>`;
  const SITES = [
    ['learn.microsoft.com', 'buttons', `<div id="article-header-page-actions"><button data-test-id="ask-learn-assistant-flyout-entry" id="ai">Ask Learn</button><button id="share">Share</button></div><div data-probe="x"><button id="ms--ai-summary-cta" data-test-id="ai-summary-cta">Summarize this article for me</button></div>`, ['ai', 'ms--ai-summary-cta'], ['share']],
    ['docs.pinecone.io', 'buttons', `<div class="chat-assistant-floating-input" data-probe="x" style="position:sticky;height:86px;padding:8px"><textarea id="chat-assistant-textarea"></textarea></div>`, ['chat-assistant-textarea'], []],
    ['www.kayak.com', 'buttons', `<div data-probe="x" style="position:fixed;bottom:0;width:480px;height:58px"><div role="button" aria-label="Open AI chat" id="ai">Ask AI</div></div>`, ['ai'], []],
    ['stackoverflow.com', 'buttons', `<ul id="leftnav"><li><a id="questions" href="#q">Questions</a></li><li data-probe="x" style="height:32px"><a id="nav-askstack" href="/ai-assist">AI Assist</a></li></ul>`, ['nav-askstack'], ['questions']],
    ['redis.io', 'buttons', `<form data-probe="x" style="padding:16px;border:1px solid"><input id="search-welcome" placeholder="Ask our chatbot"></form><form id="docsearch"><input id="docq"></form>`, ['search-welcome'], ['docq']],
    ['docs.temporal.io', 'buttons', `<div id="bar"><button class="ask-ai-navbar-button" id="ai" aria-label="Ask AI">Ask AI</button><a id="github" href="#gh">GitHub</a></div>`, ['ai'], ['github']],
    ['shopify.dev', 'buttons', `<ul id="hdr"><li><a id="apps" href="#apps">Apps</a></li><li data-probe="x" style="margin:8px"><button id="open-assistant">Ask assistant</button></li></ul>`, ['open-assistant'], ['apps']],
    ['www.etsy.com', 'buttons', `<div id="gifting-assistant-prompt-banner-root" data-probe="x" style="height:64px"><div>Find gifts with AI</div></div><section id="listings"><a id="listing" href="#l">A listing</a></section>`, ['gifting-assistant-prompt-banner-root'], ['listing']],
    ['www.instagram.com', 'buttons', `<footer><div data-probe="x" style="padding:8px"><a id="ai" href="https://meta.ai/">Meta AI</a></div><div><a id="about" href="#about">About</a></div></footer>`, ['ai'], ['about']],
    ['logrocket.com', 'support', `<div id="intercom-container" style="position:fixed;right:0;bottom:0;width:60px;height:60px">Chat</div>`, ['intercom-container'], []],
  ];
  const baseState = { enabled: true, aiWebOn: true, aiWebAccess: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebAllowlist: [] };
  const rulesFor = (host, st) => COSMETIC.filter((r) => ({ buttons: st.aiWebButtons, chat: st.aiWebChat, support: st.aiWebSupport })[r.g]
    && r.h.some((h) => h === '*' || host === h || host.endsWith('.' + h))).map((r) => ({ sel: r.sel, what: r.what }));
  const stub = (host, st) => `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__sent=[];window.__ml=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{id:'quell',onMessage:{addListener:(f)=>window.__ml.push(f)},
        sendMessage:async(m)=>{ if(m.type==='blocked'){window.__sent.push(m);return;} if(m.type==='aiWebRules') return {rules:${JSON.stringify(rulesFor(host, st))}}; }}};
    window.__set=(p)=>{Object.assign(window.__state,p);const ch={};for(const k in p)ch[k]={newValue:p[k]};window.__cbs.forEach(f=>f(ch,'local'));};
    window.__ask=(msg)=>{let got;for(const f of window.__ml)f(msg,{id:'quell'},(r)=>{got=r;});return got;};`;
  const open = async (host, inner, st = baseState) => {
    const pg = await ctx.newPage();
    await pg.route(`https://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: page(inner) }));
    await pg.addInitScript({ content: stub(host, st) + '\n' + SETTINGS_SRC + '\n' + AIWEB_SRC });
    await pg.goto(`https://${host}/`);
    await pg.waitForTimeout(700);
    return pg;
  };
  const vis = (pg, id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
  for (const [host, group, inner, hidden, kept] of SITES) {
    const st = group === 'support' ? { ...baseState, aiWebSupport: true } : baseState;
    // OFF first: nothing is hidden when the group's own switch is off.
    const offState = { ...baseState, [group === 'support' ? 'aiWebSupport' : 'aiWebButtons']: false };
    const pOff = await open(host, inner, offState);
    ok((await Promise.all(hidden.map((i) => vis(pOff, i)))).every(Boolean), `${host}: with ${group === 'support' ? 'Support chats' : 'AI buttons and panels'} off, nothing is hidden`);
    await pOff.close();
    const pg = await open(host, inner, st);
    ok((await Promise.all(hidden.map((i) => vis(pg, i)))).every((v) => !v), `${host}: the AI element is hidden`);
    ok(await pg.evaluate(() => [...document.querySelectorAll('[data-probe]')].every((e) => e.getClientRects().length === 0)), `${host}: no empty box is left behind`);
    ok((await Promise.all([...kept, 'home', 'docs', 'q', 'cart'].map((i) => vis(pg, i)))).every(Boolean), `${host}: navigation, search, cart and the page's other controls are all still visible`);
    await pg.click('#cart');
    ok(await pg.evaluate(() => document.body.dataset.cart === '1'), `${host}: the cart still works`);
    const list = await pg.evaluate(() => QuellSettings.hidden.list());
    ok(list.items.length >= 1 && list.items.every((i) => i.kind === 'ai-web' && typeof i.label === 'string' && i.label.length > 0), `${host}: listed for the popup as ai-web (${list.items.map((i) => i.label).join(' | ')})`);
    // Peek then Undo through the real message path.
    const id = list.items[0].id;
    const peek = await pg.evaluate((i) => window.__ask({ type: 'quell:hidden:peek', id: i, on: true }), id);
    ok(peek && peek.ok && (await Promise.all(hidden.map((h) => vis(pg, h)))).some(Boolean), `${host}: Peek shows it`);
    await pg.evaluate((i) => window.__ask({ type: 'quell:hidden:peek', id: i, on: false }), id);
    ok((await Promise.all(hidden.map((h) => vis(pg, h)))).every((v) => !v), `${host}: Peek again hides it`);
    await pg.evaluate((i) => window.__ask({ type: 'quell:hidden:keep', id: i, on: true }), id);
    ok((await Promise.all(hidden.map((h) => vis(pg, h)))).some(Boolean), `${host}: Undo keeps it shown`);
    await pg.evaluate((i) => window.__ask({ type: 'quell:hidden:keep', id: i, on: false }), id);
    // The per-site pause.
    await pg.evaluate((h) => window.__set({ aiWebAllowlist: [h] }), host);
    await pg.waitForTimeout(500);
    ok((await Promise.all(hidden.map((h) => vis(pg, h)))).every(Boolean), `${host}: paused on this site, everything shows`);
    await pg.close();
  }
  // Reported for the badge once per element.
  {
    const pg = await open('docs.temporal.io', SITES[5][2]);
    ok(await pg.evaluate(() => window.__sent.reduce((a, m) => a + m.count, 0)) === 1, 'a hidden element is reported once for the tab count');
    await pg.close();
  }
}

// ------------------------------------------------ C. the popup group, real extension --
console.log('Popup: AI on websites group:');
{
  await set({ enabled: true, firstRunDone: true, aiWebOn: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebReplay: false,
    aiWebAccess: false, aiWebAllowlist: [], sitePauses: {}, aiAllowlist: [], cookieEnabled: false, popupsEnabled: false });
  const g = await ctx.newPage();
  await g.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="rso"><div class="MjjYud"><div role="heading">AI Overview</div></div></div>' }));
  await g.goto('https://www.google.com/search?q=t');
  await g.waitForTimeout(800);
  const openPopup = async (scheme = 'dark') => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width: 360, height: 600 });
    await p.emulateMedia({ colorScheme: scheme });
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
    return p;
  };
  const p = await openPopup();
  const f = await p.evaluate(() => { const m = document.getElementById('main'); return { over: m.scrollHeight - m.clientHeight, body: Math.round(document.body.getBoundingClientRect().height) }; });
  ok(f.over <= 0 && f.body <= 560, `with the new group the default popup is 360 x ${f.body} and does not scroll (overflow ${f.over})`);
  ok(await p.evaluate(() => document.getElementById('aiWebBody').hidden && document.getElementById('aiWeb').checked), 'the group is on and collapsed, like Search');
  ok(/AI on websites/.test(await p.evaluate(() => document.getElementById('gAiWeb').textContent)), 'the row is called "AI on websites"');
  await p.click('#aiWebExpand');
  const st = await p.evaluate(() => ['aiWebButtons', 'aiWebChat', 'aiWebSupport', 'aiWebReplay'].map((k) => document.getElementById(k).checked));
  ok(JSON.stringify(st) === '[true,true,false,false]', `defaults: buttons and chat on, support chats and session recording off (${st})`);
  ok(await p.evaluate(() => !document.getElementById('aiWebAccessRow').hidden), 'page-level hiding says it needs all-sites access, with an Allow button');
  await p.click('#aiWebSupport');
  await p.click('#aiWebReplay');
  await p.waitForTimeout(400);
  const s2 = await sw.evaluate(() => QuellSettings.get({ aiWebSupport: false, aiWebReplay: false }));
  ok(s2.aiWebSupport === true && s2.aiWebReplay === true, 'the switches write the settings');
  await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets()).then((ids) => {
    ok(['ai_web_chat', 'ai_web_support', 'ai_web_replay'].every((i) => ids.includes(i)), `the background enabled the three rulesets (${ids.join(', ')})`);
  });
  await p.click('#aiWebSupport');
  await p.click('#aiWebReplay');
  await p.click('#aiWebChat');
  await p.waitForTimeout(500);
  const ids = await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets());
  ok(!ids.includes('ai_web_support') && !ids.includes('ai_web_replay') && !ids.includes('ai_web_chat'), `switching them off disables their rulesets (${ids.join(', ')})`);
  await p.click('#aiWebChat');
  await p.waitForTimeout(400);
  ok((await sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).includes('ai_web_chat'), 'AI chat assistants back on enables its ruleset');
  // Pause covers the group.
  await p.click('#pauseBtn');
  await p.waitForTimeout(600);
  const al = await sw.evaluate(() => QuellSettings.get({ aiWebAllowlist: [], aiAllowlist: [] }));
  ok(al.aiWebAllowlist.includes('www.google.com') && al.aiAllowlist.includes('www.google.com'), 'Pause here covers AI on websites as well as search');
  const dyn = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  ok(dyn.some((r) => r.id >= 200000 && r.action.type === 'allow' && (r.condition.initiatorDomains || []).includes('www.google.com')), 'the network rules get a per-site allow rule');
  await p.close();
  // Light too.
  const pl = await openPopup('light');
  ok(await pl.evaluate(() => !!document.getElementById('aiWeb')) && (await pl.evaluate(() => { const m = document.getElementById('main'); return m.scrollHeight - m.clientHeight; })) <= 0, 'light variant: renders and does not scroll');
  await pl.close();
  await g.close();
  await set({ aiWebAllowlist: [], sitePauses: {}, aiAllowlist: [] });
}


// ------------------------------------------------ E. YouTube, Amazon, X (live-mapped) ---
console.log('AI on websites: YouTube, Amazon and X (fixtures reduced from live-recorded markup):');
{
  const fx = (n) => readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
  const st = { enabled: true, aiWebOn: true, aiWebAccess: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebAllowlist: [] };
  const rulesFor = (host, state) => COSMETIC.filter((r) => ({ buttons: state.aiWebButtons, chat: state.aiWebChat, support: state.aiWebSupport })[r.g]
    && r.h.some((h) => h === '*' || host === h || host.endsWith('.' + h))).map((r) => ({ sel: r.sel, what: r.what }));
  const stub = (host, state) => `window.__state=${JSON.stringify(state)};window.__cbs=[];window.__ml=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{id:'quell',onMessage:{addListener:(f)=>window.__ml.push(f)},
        sendMessage:async(m)=>{ if(m.type==='aiWebRules') return {rules:${JSON.stringify(rulesFor(host, state))}}; }}};
    window.__ask=(msg)=>{let got;for(const f of window.__ml)f(msg,{id:'quell'},(r)=>{got=r;});return got;};`;
  const SITES = [
    ['www.youtube.com', 'youtube search results', 'aiweb-youtube-results.html'],
    ['www.youtube.com', 'youtube watch page', 'aiweb-youtube-watch.html'],
    ['www.amazon.com', 'amazon search results', 'aiweb-amazon-search.html'],
    ['www.amazon.com', 'amazon product page', 'aiweb-amazon-product.html'],
    ['x.com', 'x home', 'aiweb-x-home.html'],
  ];
  const ids = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
  for (const [host, name, file] of SITES) {
    const html = fx(file);
    const keep = ids(html, /id="(keep-[a-z0-9-]+)"/g);
    let ai = [];
    const run = async (state) => {
      const pg = await ctx.newPage();
      await pg.route(`https://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await pg.addInitScript({ content: stub(host, state) + '\n' + SETTINGS_SRC + '\n' + AIWEB_SRC });
      await pg.goto(`https://${host}/x`);
      await pg.waitForTimeout(700);
      return pg;
    };
    const vis = (pg, i) => pg.evaluate((x) => { const e = document.getElementById(x); return !!e && e.getClientRects().length > 0; }, i);
    const pOff = await run({ ...st, aiWebButtons: false });
    ai = await pOff.evaluate(() => [...document.querySelectorAll('[id^="ai-"],[data-ai]')].map((e) => e.id).filter(Boolean));
    ok((await Promise.all(ai.map((i) => vis(pOff, i)))).every(Boolean), `${name}: with AI buttons and panels off, all ${ai.length} AI elements show`);
    await pOff.close();
    const pg = await run(st);
    const shown = (await Promise.all(ai.map(async (i) => [i, await vis(pg, i)]))).filter(([, v]) => v).map(([i]) => i);
    ok(shown.length === 0 && ai.length >= 2, `${name}: every AI element is hidden (${ai.length} of them${shown.length ? '; still showing ' + shown.join(', ') : ''})`);
    ok(await pg.evaluate(() => [...document.querySelectorAll('[data-probe]')].every((e) => e.getClientRects().length === 0)), `${name}: no empty box is left behind`);
    const gone = (await Promise.all(keep.map(async (i) => [i, await vis(pg, i)]))).filter(([, v]) => !v).map(([i]) => i);
    ok(gone.length === 0 && keep.length >= 4, `${name}: the page's own controls all stay (${keep.length} checked${gone.length ? '; missing ' + gone.join(', ') : ''})`);
    // The recorded protected controls, named: players, like/subscribe, price, buy, replies.
    const must = { 'youtube watch page': ['keep-player', 'keep-like', 'keep-subscribe', 'keep-description'], 'amazon product page': ['keep-price', 'keep-add-to-cart', 'keep-buy-now', 'keep-reviews', 'keep-cart', 'keep-search'],
      'x home': ['keep-reply', 'keep-repost', 'keep-like', 'keep-bookmark', 'keep-nav-home', 'keep-nav-explore', 'keep-nav-notifications'], 'amazon search results': ['keep-search', 'keep-cart'], 'youtube search results': ['keep-search', 'keep-result-1'] }[name];
    ok((await Promise.all(must.map((i) => vis(pg, i)))).every(Boolean), `${name}: ${must.map((m) => m.replace('keep-', '')).join(', ')} still show`);
    const list = await pg.evaluate(() => QuellSettings.hidden.list());
    ok(list.items.length >= 1 && list.items.every((i) => i.kind === 'ai-web'), `${name}: listed for the popup (${list.items.map((i) => i.label).join(' | ')})`);
    const id = list.items[0].id;
    await pg.evaluate((i) => window.__ask({ type: 'quell:hidden:keep', id: i, on: true }), id);
    ok((await Promise.all(ai.map((i) => vis(pg, i)))).some(Boolean), `${name}: Undo shows it again`);
    await pg.close();
  }
  // the rules exist and are scoped to their hosts
  const hostsOf = (re) => [...new Set(COSMETIC.filter((r) => re.test(r.id)).flatMap((r) => r.h))];
  ok(JSON.stringify(hostsOf(/^youtube-/)) === '["www.youtube.com"]' && JSON.stringify(hostsOf(/^amazon-/)) === '["www.amazon.com"]'
    && JSON.stringify(hostsOf(/^x-/).sort()) === '["twitter.com","x.com"]', 'the new rules are scoped to youtube.com, amazon.com and x.com / twitter.com');
  ok(!COSMETIC.some((r) => /how-this-was-made|auto-dub/i.test(r.id + r.what + r.sel.join())), 'the "How this was made / Auto-dubbed" disclosure is not hidden (it is information)');
  ok(COSMETIC.filter((r) => r.id.startsWith('youtube-')).length === 6 && COSMETIC.filter((r) => r.id.startsWith('amazon-')).length === 8 && COSMETIC.filter((r) => r.id.startsWith('x-')).length === 5,
    'YouTube 6 rules, Amazon 8, X 5');
}

// ------------------------------------------------ F. live-retest fixes (0.7.4) ----------
console.log('Sign-up prompts never hide navigation; emptied cells collapse; more consent platforms:');
{
  const FIXD = path.join(HERE, 'fixtures');
  const read = (n) => readFileSync(path.join(FIXD, n), 'utf8');
  const PROMPTS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/signup-prompts.js'), 'utf8');
  const stub = (st) => `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__sent=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{sendMessage:async(m)=>{ if(m.type==='blocked') window.__sent.push(m); }}};`;
  const open = async (host, html, src, st, wait = 1800) => {
    const pg = await ctx.newPage();
    await pg.route(`http://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: stub(st) + '\n' + src });
    await pg.goto(`http://${host}/`);
    await pg.waitForTimeout(wait);
    return pg;
  };
  const vis = (pg, sel) => pg.evaluate((q) => { const e = document.querySelector(q); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }, sel);

  // 1. Wired: a slide-out navigation drawer that holds "Sign In" stays whole.
  {
    const pg = await open('drawer.test', read('signup-drawer.html'), PROMPTS, { popupsEnabled: true });
    ok(!(await vis(pg, '#modal')), 'a real sign-up dialog that appears by itself is still hidden');
    ok(await vis(pg, '#hdr-signin') && await vis(pg, '#hdr-home'), 'the header with Sign In stays');
    await pg.click('#hamburger');
    await pg.waitForTimeout(2600);
    ok(await vis(pg, '#menu-panel') && await vis(pg, '#drawer-signin') && (await pg.evaluate(() => document.querySelectorAll('#menu-panel a').length)) === 10 && await pg.evaluate(() => [...document.querySelectorAll('#menu-panel a')].every((a) => a.getClientRects().length > 0)),
      'the hamburger opens the whole drawer: all ten links, Sign In among them (many links, controlled by an expanded button)');
    await pg.click('#hamburger-lite');
    await pg.waitForTimeout(2600);
    ok(await vis(pg, '#menu-lite') && await vis(pg, '#lite-signin'), 'a small drawer opened by a click, with no aria at all, stays (it opened right after the user\'s own click)');
    ok(await vis(pg, '#main'), 'the page content stays');
    await pg.close();
    const off = await open('drawer.test', read('signup-drawer.html'), PROMPTS, { popupsEnabled: true, hideSignupPrompts: false });
    ok(await vis(off, '#modal'), 'with Sign-up and log-in prompts off, the dialog shows');
    await off.close();
  }

  // 2. Microsoft Learn: only the AI buttons go; the header, breadcrumb and page actions stay.
  {
    const AIWEB = readFileSync(path.join(EXT, 'src/content/aiweb.js'), 'utf8');
    const st = { enabled: true, aiWebOn: true, aiWebAccess: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebAllowlist: [] };
    const rules = COSMETIC.filter((r) => r.h.includes('learn.microsoft.com') && r.g === 'buttons').map((r) => ({ sel: r.sel, what: r.what }));
    const aiStub = `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__ml=[];
      window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
        runtime:{id:'quell',onMessage:{addListener:(f)=>window.__ml.push(f)},sendMessage:async(m)=>{ if(m.type==='aiWebRules') return {rules:${JSON.stringify(rules)}}; }}};`;
    const pg = await ctx.newPage();
    await pg.route('https://learn.microsoft.com/**', (r) => r.fulfill({ contentType: 'text/html', body: read('aiweb-learn.html') }));
    await pg.addInitScript({ content: aiStub + '\n' + SETTINGS_SRC + '\n' + AIWEB });
    await pg.goto('https://learn.microsoft.com/x');
    await pg.waitForTimeout(2400);
    const v = (id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
    ok(!(await v('ai-ask1')) && !(await v('ai-ask2')), 'learn.microsoft.com: both Ask Learn buttons are hidden');
    ok(await v('keep-breadcrumb') && await v('article-header') && await v('article-header-page-actions') && await v('keep-share') && await v('keep-print'),
      'learn.microsoft.com: the article header, the breadcrumb (filled in after the first sweep) and the page actions all stay');
    await pg.close();
  }

  // 3. Datadog: no dangling "or" beside the search box.
  {
    const AIWEB = readFileSync(path.join(EXT, 'src/content/aiweb.js'), 'utf8');
    const st = { enabled: true, aiWebOn: true, aiWebAccess: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebAllowlist: [] };
    const rules = COSMETIC.filter((r) => r.h.includes('docs.datadoghq.com')).map((r) => ({ sel: r.sel, what: r.what }));
    const aiStub = `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__ml=[];
      window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
        runtime:{id:'quell',onMessage:{addListener:(f)=>window.__ml.push(f)},sendMessage:async(m)=>{ if(m.type==='aiWebRules') return {rules:${JSON.stringify(rules)}}; }}};`;
    const pg = await ctx.newPage();
    await pg.route('https://docs.datadoghq.com/**', (r) => r.fulfill({ contentType: 'text/html', body: read('aiweb-datadog.html') }));
    await pg.addInitScript({ content: aiStub + '\n' + SETTINGS_SRC + '\n' + AIWEB });
    await pg.goto('https://docs.datadoghq.com/x');
    await pg.waitForTimeout(1200);
    const v = (id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
    ok(!(await v('ai-ask')) && !(await v('ai-ask-b')), 'datadog docs: both Ask AI buttons are hidden');
    ok(!(await v('sep')), 'datadog docs: the "or" separator element goes with the button');
    ok(await pg.evaluate(() => !/\bor\b/.test(document.getElementById('hero2').innerText)), 'datadog docs: a bare "or" text next to the button goes too');
    ok(await v('keep-search') && await v('keep-search2') && await v('keep-main'), 'datadog docs: the search boxes and the page stay');
    await pg.close();
  }

  // 4. WebMD: a hidden footer newsletter leaves no empty cell.
  {
    const POPUPS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/popups.js'), 'utf8');
    const html = `<!doctype html><html><body><main id="main"><h1>Placeholder</h1><p>Placeholder text.</p></main>
      <footer id="foot"><div id="cols" style="display:flex"><div id="col-links"><a href="/a">About</a> <a href="/b">Privacy</a></div>
      <div id="cell" data-probe="1" style="width:300px;height:110px;padding:8px"><div class="newsletter-wrapper" id="nl" style="height:90px">Sign up for our free Good Health Newsletter <input placeholder="email"></div></div>
      <div id="col-social"><a href="/c">Social</a></div></div></footer></body></html>`;
    const pg = await ctx.newPage();
    await pg.route('http://www.webmd.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: `window.__state={popupsEnabled:true};window.__cbs=[];window.__sent=[];
      window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},runtime:{sendMessage:async(m)=>{ if(m.type==='blocked'){window.__sent.push(m);return;} if(m.type==='popupRules') return {generic:['.newsletter-wrapper'],site:[]}; }}};` + '\n' + POPUPS });
    await pg.goto('http://www.webmd.test/');
    await pg.waitForTimeout(1500);
    const v = (id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
    ok(!(await v('nl')), 'webmd: the footer newsletter box is hidden');
    ok(!(await v('cell')), 'webmd: the empty footer cell around it is collapsed too');
    ok(await v('col-links') && await v('col-social') && await v('foot') && await v('main'), 'webmd: the other footer columns and the page stay');
    await pg.close();
  }

  // 5. Consent platforms: Axeptio (gorgias.com) and a Finsweet banner (forethought.ai).
  {
    const COOKIES = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
    for (const [name, html, hidden, kept] of [
      ['Axeptio', `<!doctype html><html><body><div id="axeptio_overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div id="dlg" style="position:fixed;left:30%;top:30%;background:#fff;padding:12px">Here's why we use cookies. <button>Ok got it</button></div></div><div id="axeptio_btn" style="position:fixed;left:10px;bottom:10px">Cookies</div><main id="main"><h1>Page</h1><p>Placeholder.</p></main></body></html>`, ['axeptio_overlay', 'axeptio_btn'], ['main']],
      ['Finsweet banner', `<!doctype html><html><body><div class="consent_opt-out_banner" id="fs-banner" fs-consent-element="banner" style="position:fixed;right:10px;bottom:10px;width:480px;background:#fff;padding:12px">By clicking "Accept", you agree to the storing of cookies on your device. <button>Reject</button><button>Accept</button></div><main id="main"><h1>Page</h1><p>Placeholder.</p></main></body></html>`, ['fs-banner'], ['main']],
    ]) {
      const pg = await ctx.newPage();
      await pg.route('http://consent.test/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await pg.addInitScript({ content: `window.__state={enabled:true,cookieEnabled:true,cookieReject:false};window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener(){}}},runtime:{sendMessage(){}}};` + '\n' + COOKIES });
      await pg.goto('http://consent.test/');
      await pg.waitForTimeout(900);
      const v = (id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }, id);
      ok((await Promise.all(hidden.map((i) => v(i)))).every((x) => !x), `${name}: the consent UI is hidden`);
      ok((await Promise.all(kept.map((i) => v(i)))).every(Boolean), `${name}: the page stays`);
      await pg.close();
    }
  }

  // 6. New rules: Airbnb's AI search bar and the 1mind AI assistant (Salesloft).
  {
    const has = (id) => COSMETIC.some((r) => r.id === id);
    ok(has('airbnb-ai-search') && has('onemind-chat'), 'rules exist for Airbnb\'s "new AI search" bar and the 1mind AI assistant');
    const AIWEB = readFileSync(path.join(EXT, 'src/content/aiweb.js'), 'utf8');
    const st = { enabled: true, aiWebOn: true, aiWebAccess: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebAllowlist: [] };
    const run = async (host, html, ids) => {
      const rules = COSMETIC.filter((r) => r.h.some((h) => h === '*' || host === h) && ({ buttons: 1, chat: 1 })[r.g]).map((r) => ({ sel: r.sel, what: r.what }));
      const pg = await ctx.newPage();
      await pg.route(`https://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await pg.addInitScript({ content: `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__ml=[];window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},runtime:{id:'quell',onMessage:{addListener:(f)=>window.__ml.push(f)},sendMessage:async(m)=>{ if(m.type==='aiWebRules') return {rules:${JSON.stringify(rules)}}; }}};` + '\n' + SETTINGS_SRC + '\n' + AIWEB });
      await pg.goto(`https://${host}/x`);
      await pg.waitForTimeout(900);
      const out = await pg.evaluate((l) => l.map((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0; }), ids);
      await pg.close();
      return out;
    };
    const air = `<!doctype html><html><body><div id="page"><div id="bar" style="height:76px"><div><span id="unified-search-microphone-prompt">Describe what you are looking for with the new AI search</span><button role="switch">Off</button></div></div><header id="keep-header"><input id="keep-search" placeholder="Where"></header><main id="keep-main">Placeholder</main></div></body></html>`;
    let r = await run('www.airbnb.com', air, ['unified-search-microphone-prompt', 'bar', 'keep-header', 'keep-search', 'keep-main']);
    ok(!r[0] && !r[1] && r[2] && r[3] && r[4], 'airbnb: the AI search bar is hidden with no empty row; the header, search and page stay');
    const one = `<!doctype html><html><body><main id="keep-main">Placeholder</main><div id="onemind-widget" style="position:fixed;right:20px;bottom:20px;width:300px;height:400px"><iframe id="onemind-iframe" title="AI assistant" style="width:100%;height:100%"></iframe></div></body></html>`;
    r = await run('www.salesloft.com', one, ['onemind-widget', 'keep-main']);
    ok(!r[0] && r[1], 'salesloft: the 1mind AI assistant is hidden, the page stays');
  }
}

// ------------------------------------------------ D. Brave: the Ask tab -------------
console.log('Brave Search: the "Ask" tab goes with the AI answer:');
{
  const COMMON = readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8');
  const ENGINES = readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  const HTML = `<!doctype html><html><body>
    <ul id="tabs"><li id="askli"><a id="asktab" href="/ask?q=egg">Ask</a></li><li><a id="alltab" href="/search?q=egg">All</a></li><li><a id="imgtab" href="/images?q=egg">Images</a></li></ul>
    <div id="mixed-main"><div id="llm-snippet">AI summary</div><div class="snippet"><a id="organic-ask" href="/ask">Ask</a><a id="organic" href="https://example.com/">Egg</a></div></div></body></html>`;
  const run = async (mode) => {
    const pg = await ctx.newPage();
    await pg.route('https://search.brave.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: HTML }));
    await pg.addInitScript({ content: `window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,aiEnabled:true,braveMode:${JSON.stringify(mode)}})},onChanged:{addListener(){}}},runtime:{id:'quell',onMessage:{addListener(){}},sendMessage(){}}};` + '\n' + SETTINGS_SRC + '\n' + COMMON + '\n' + ENGINES });
    await pg.goto('https://search.brave.com/search?q=egg');
    await pg.waitForTimeout(700);
    const v = (id) => pg.evaluate((i) => document.getElementById(i).getClientRects().length > 0, id);
    const r = { ask: await v('asktab'), all: await v('alltab'), img: await v('imgtab'), organic: await v('organic'), organicAsk: await v('organic-ask'), askLi: await v('askli') };
    await pg.close();
    return r;
  };
  const on = await run('hide');
  ok(!on.ask && !on.askLi && on.all && on.img, 'Hide mode: the Ask tab is hidden with its list item, the other tabs remain');
  ok(on.organic && on.organicAsk, 'a result inside the organic area, even one named "Ask", is never hidden');
  const off = await run('off');
  ok(off.ask && off.all, 'Leave it: the Ask tab stays');
}

await ctx.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
