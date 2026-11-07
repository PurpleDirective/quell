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
    firstRunDone: true, whatsNewSeen: '0.7.4', aiAllowlist: [], cookieAllowlist: [], popupAllowlist: [], aiWebAllowlist: [], sitePauses: {} });
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
    if (await popup.locator('#itemsMore').isVisible()) { await popup.click('#itemsMore'); await popup.waitForTimeout(200); }
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
    && r.h.some((h) => h === '*' || host === h || host.endsWith('.' + h))).map((r) => ({ sel: r.sel, what: r.what, t: r.t }));
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
  await set({ enabled: true, firstRunDone: true, whatsNewSeen: '0.7.4', aiWebOn: true, aiWebButtons: true, aiWebChat: true, aiWebSupport: false, aiWebReplay: false,
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
    && r.h.some((h) => h === '*' || host === h || host.endsWith('.' + h))).map((r) => ({ sel: r.sel, what: r.what, t: r.t }));
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
  ok(COSMETIC.filter((r) => r.id.startsWith('youtube-')).length === 6 && COSMETIC.filter((r) => r.id.startsWith('amazon-')).length === 9 && COSMETIC.filter((r) => r.id.startsWith('x-')).length === 8,
    'YouTube 6 rules, Amazon 9, X 8');
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
    const rules = COSMETIC.filter((r) => r.h.includes('learn.microsoft.com') && r.g === 'buttons').map((r) => ({ sel: r.sel, what: r.what, t: r.t }));
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
    const rules = COSMETIC.filter((r) => r.h.includes('docs.datadoghq.com')).map((r) => ({ sel: r.sel, what: r.what, t: r.t }));
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
      const rules = COSMETIC.filter((r) => r.h.some((h) => h === '*' || host === h) && ({ buttons: 1, chat: 1 })[r.g]).map((r) => ({ sel: r.sel, what: r.what, t: r.t }));
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

// ------------------------------------------------ G. real-Chrome retest fixes --------
console.log('Safety net, blank bands, app bars, sign-in callouts, Bing timing, chips:');
{
  const FIXD = path.join(HERE, 'fixtures');
  const PROMPTS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/signup-prompts.js'), 'utf8');
  const POPUPS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/popups.js'), 'utf8');
  const COOKIES = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/cookies.js'), 'utf8');
  const BING = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8') + '\n' + readFileSync(path.join(EXT, 'src/content/bing.js'), 'utf8');
  const ENGINES = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8') + '\n' + readFileSync(path.join(EXT, 'src/content/engines.js'), 'utf8');
  const stub = (st, extra = '') => `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__sent=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{id:'quell',onMessage:{addListener(){}},sendMessage:async(m)=>{ if(m.type==='blocked'){window.__sent.push(m);return;} ${extra} }}};`;
  const open = async (host, html, src, st, wait = 1800, extra = '') => {
    const pg = await ctx.newPage();
    await pg.route(`http://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: stub(st, extra) + '\n' + src });
    await pg.goto(`http://${host}/`);
    await pg.waitForTimeout(wait);
    return pg;
  };
  const vis = (pg, id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }, id);
  const LONG = 'Placeholder paragraph with plenty of words so that the page clearly has content of its own. '.repeat(12);

  // 1. Zara-shaped page: the app sizes itself with height:100% and an inner scroller.
  {
    const html = `<!doctype html><html style="height:100%"><body style="height:100%;margin:0;overflow:hidden">
      <div id="app" style="height:100%;display:flex;flex-direction:column"><div id="top" style="height:40px"><a id="hdr-link" href="/">Menu</a></div>
      <div id="content" style="flex:1;overflow:auto"><p id="body-text">${LONG}</p><a href="/1">One</a> <a href="/2">Two</a></div></div>
      <div id="wall" role="dialog" style="position:fixed;left:30%;top:30%;width:40%;background:#fff;padding:12px;z-index:9"><h2>Sign up for our newsletter</h2><p>Create a free account.</p><button>Sign up</button> <button>Log in</button></div></body></html>`;
    const pg = await open('zara.test', html, PROMPTS, { popupsEnabled: true });
    const textLen = () => pg.evaluate(() => document.getElementById('content').innerText.length);
    ok(!(await vis(pg, 'wall')), 'zara-like: the sign-up dialog is hidden');
    ok(await textLen() > 800 && await vis(pg, 'body-text') && await vis(pg, 'hdr-link'), 'zara-like: the page content is not blanked (height:100% layout intact)');
    ok(await pg.evaluate(() => { const r = document.getElementById('content').getBoundingClientRect(); return r.height > 300; }), 'zara-like: the content area keeps its height (unlock never forces height:auto)');
    await pg.close();
  }
  // 1b. The safety net itself: a hide that blanks the page is undone and the page marked.
  {
    const html = `<!doctype html><html><body><main id="m"><p id="t">${LONG}${LONG}</p></main><div id="x">x</div></body></html>`;
    const pg = await open('guard.test', html, SETTINGS_SRC, {}, 300);
    const res = await pg.evaluate(() => {
      const G = QuellSettings.guard; let undone = 0;
      G.register(() => { undone++; document.getElementById('m').style.display = ''; });
      G.measure(true);
      document.getElementById('m').style.display = 'none'; G.acted();
      const tripped = G.check();
      return { tripped, undone, attr: document.documentElement.getAttribute('data-quell-safety'), back: document.getElementById('t').getClientRects().length > 0 };
    });
    ok(res.tripped && res.undone === 1 && res.attr === '1' && res.back, 'safety net: visible text fell under half after a hide, so the hide is undone and the page marked data-quell-safety');
    const calm = await pg.evaluate(() => { const G = QuellSettings.guard; return G.protects(document.body) && G.protects(document.getElementById('m')) && !G.protects(document.getElementById('x')); });
    ok(calm, 'safety net: body and main are protected, a small element is not');
    await pg.close();
  }
  // 1c. A rule that matches the element holding the page's text is refused.
  {
    const html = `<!doctype html><html><body><div id="shell"><p id="t">${LONG}${LONG}</p></div></body></html>`;
    const pg = await open('shell.test', html, POPUPS, { popupsEnabled: true }, 1500, "if(m.type==='popupRules') return {generic:['#shell'],site:[]};");
    ok(await vis(pg, 't'), 'a pop-up rule matching the element that holds most of the page text does not hide it');
    await pg.close();
  }

  // 2. A banner's emptied slot collapses; a slot the site left empty is not Quell's to touch.
  {
    const html = `<!doctype html><html><body><div id="slot" data-probe="1" style="padding:120px 0"><div id="onetrust-banner-sdk">We use cookies</div></div>
      <div id="adslot" style="height:250px"></div><main id="main"><h1>Page</h1><p>${LONG}</p></main></body></html>`;
    const pg = await open('band.test', html, COOKIES, { enabled: true, cookieEnabled: true });
    ok(!(await vis(pg, 'onetrust-banner-sdk')) && await pg.evaluate(() => document.getElementById('slot').getClientRects().length === 0), 'cookie banner: the banner and the slot it left empty are collapsed (no band)');
    ok(await pg.evaluate(() => document.getElementById('adslot').getBoundingClientRect().height === 250) && await vis(pg, 'main'), 'cookie banner: an empty ad slot the site left itself is untouched, and the page stays');
    await pg.close();
  }

  // 3. MyRecipes "open in app" bar.
  {
    const html = `<!doctype html><html><body><header style="height:64px"><a id="hdr-app" href="/app">Get the app</a> <a id="hdr-home" href="/">Home</a></header>
      <div id="appbar" style="height:70px;background:#eee"><a href="#">Don't lose your favorite Thanksgiving recipes. Save using the MyRecipes app now!</a> <button aria-label="Close" id="appbar-close">×</button></div>
      <main id="main"><h1>Recipes</h1><p id="app-para">Try our app for timers and unit conversion while you cook; it is a short promotional line without any close control.</p><p>${LONG}</p></main></body></html>`;
    const pg = await open('recipes.test', html, POPUPS, { popupsEnabled: true, hideAppBanners: true }, 1800, "if(m.type==='popupRules') return {generic:[],site:[]};");
    ok(!(await vis(pg, 'appbar')), 'seriouseats-like: the "save using the MyRecipes app" bar is hidden');
    ok(await vis(pg, 'hdr-app') && await vis(pg, 'hdr-home') && await vis(pg, 'main') && await vis(pg, 'app-para'), 'seriouseats-like: the header\'s own Get the app link, the page and an in-article mention of the app stay');
    const off = await open('recipes.test', html, POPUPS, { popupsEnabled: true, hideAppBanners: false }, 1500, "if(m.type==='popupRules') return {generic:[],site:[]};");
    ok(await vis(off, 'appbar'), 'with "Open in app" banners off, the bar shows');
    await off.close();
    await pg.close();
  }

  // 3b. Target: a coachmark tooltip in the header ("Sign in for the best experience"), one button "Sign in or create account".
  {
    const html = `<!doctype html><html><body><nav id="hdr" style="position:relative;height:80px"><a id="hdr-signin" href="/signin">Sign in</a>
      <div id="coach" role="tooltip" style="position:absolute;left:200px;top:70px;width:360px;height:240px;background:#fff"><div><h2>Sign in for the best experience</h2><div><span>See past orders and manage returns</span><span>Check out faster</span></div><button type="button" id="coach-btn">Sign in or create account</button></div><button aria-label="close" id="coach-close"></button></div></nav>
      <main id="main"><h1>Home</h1><p>${LONG}</p></main></body></html>`;
    const pg = await open('target.test', html, PROMPTS, { popupsEnabled: true });
    ok(!(await vis(pg, 'coach')) && await vis(pg, 'hdr-signin') && await vis(pg, 'main'), 'target-like: the sign-in coachmark in the header is hidden; the header link and page stay');
    await pg.close();
  }

  // 4. IMDb: an auto-appearing sign-in callout goes; one the user opened stays.
  {
    const html = `<!doctype html><html><body><header id="hdr" style="position:relative;height:64px;background:#111"><a id="hdr-signin" href="/signin" style="color:#fff">Sign in</a>
      <button id="opener" onclick="document.getElementById('menu').style.display='block'">Account</button>
      <div id="popover" style="position:absolute;right:10px;top:70px;width:320px;height:170px;background:#fff;border:2px solid gold"><a href="/signin" id="pop-btn">Sign in</a><button aria-label="Close" id="pop-close">×</button><p>New customer? <a href="/create">Create account</a></p></div>
      <div id="menu" style="display:none;position:absolute;right:340px;top:70px;width:320px;height:170px;background:#fff"><a href="/signin" id="menu-btn">Sign in</a><button aria-label="Close menu">×</button><p>New customer? <a href="/create">Create account</a></p></div></header>
      <main id="main"><h1>Movies</h1><p>${LONG}</p></main></body></html>`;
    const pg = await open('imdb.test', html, PROMPTS, { popupsEnabled: true });
    ok(!(await vis(pg, 'popover')), 'imdb-like: the auto-appearing sign-in callout is hidden');
    ok(await vis(pg, 'hdr-signin') && await vis(pg, 'hdr') && await vis(pg, 'main'), 'imdb-like: the header\'s own Sign in and the page stay');
    await pg.click('#opener');
    await pg.waitForTimeout(2600);
    ok(await vis(pg, 'menu') && await vis(pg, 'menu-btn'), 'imdb-like: a sign-in menu the user opened stays');
    await pg.close();
  }

  // 5. Bing: tabs and panels inserted late are hidden and their gap collapses; stale first settings catch up.
  {
    const html = `<!doctype html><html><body><header id="b_header"><ul class="b_scopebar"><li><a id="t-all" href="/search?q=x">All</a></li></ul></header>
      <div id="b_content"><div id="gap" data-probe="1" style="min-height:200px"><div id="b_copilot_search_container"><a id="chip" href="/copilotsearch?q=x">Ask Copilot</a></div></div><ol id="b_results"><li class="b_algo"><a id="org" href="https://example.com">Result</a></li></ol></div>
      <script>setTimeout(function(){var li=document.createElement('li');li.id='late-li';li.innerHTML='<a id="late-tab" href="/copilotsearch?q=x&FORM=X">AI MODE</a>';document.querySelector('.b_scopebar').appendChild(li);},900);</script></body></html>`;
    const pg = await ctx.newPage();
    await pg.route('https://www.bing.com/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
    // the first settings read is stale (Quell reads "off"); the next is right
    await pg.addInitScript({ content: `window.__reads=0;window.chrome={storage:{local:{get:async(d)=>{window.__reads++;return {...d,enabled:true,aiEnabled:true,bingEnabled:window.__reads>1};}},onChanged:{addListener(){}}},runtime:{id:'quell',onMessage:{addListener(){}},sendMessage(){}}};` + '\n' + BING });
    await pg.goto('https://www.bing.com/search?q=x');
    await pg.waitForTimeout(3600);
    ok(!(await vis(pg, 'late-tab')) && !(await vis(pg, 'chip')), 'bing: the Copilot tab inserted late and the panel are hidden, even after a stale first settings read');
    ok(await pg.evaluate(() => document.getElementById('gap').getClientRects().length === 0), 'bing: the gap the Copilot panel left is collapsed');
    ok(await vis(pg, 't-all') && await vis(pg, 'org'), 'bing: the other tabs and the results stay');
    await pg.close();
  }

  // 6. DuckDuckGo: the Search Assist and Ask Duck.ai chips go; other chips and a result of the same name stay.
  {
    const html = `<!doctype html><html><body><ul id="chips"><li><a id="chip-all" href="/?q=x">All</a></li><li><a id="chip-assist" href="/?q=x&assist=true">Search Assist</a></li><li><a id="chip-duck" href="https://duck.ai/">Ask Duck.ai</a></li><li><a id="chip-img" href="/?q=x&iax=images">Images</a></li></ul>
      <ol class="react-results--main"><li data-layout="organic"><a id="organic" href="https://example.com/a">Search Assist</a></li></ol></body></html>`;
    const run = async (mode) => {
      const pg = await ctx.newPage();
      await pg.route('https://duckduckgo.com/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
      await pg.addInitScript({ content: `window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,aiEnabled:true,ddgMode:${JSON.stringify(mode)}})},onChanged:{addListener(){}}},runtime:{id:'quell',onMessage:{addListener(){}},sendMessage(){}}};` + '\n' + ENGINES });
      await pg.goto('https://duckduckgo.com/?q=x');
      await pg.waitForTimeout(1000);
      const r = { assist: await vis(pg, 'chip-assist'), duck: await vis(pg, 'chip-duck'), all: await vis(pg, 'chip-all'), img: await vis(pg, 'chip-img'), organic: await vis(pg, 'organic') };
      await pg.close();
      return r;
    };
    const on = await run('hide');
    ok(!on.assist && !on.duck && on.all && on.img, 'duckduckgo: the Search Assist and Ask Duck.ai chips are hidden with the AI switch on; All and Images remain');
    ok(on.organic, 'duckduckgo: a result named "Search Assist" is never hidden');
    ok((await run('off')).assist, 'duckduckgo: with the AI switch off the chips stay');
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

// ------------------------------------------------ H. Fable review fixes ------------------
console.log('Review fixes: safety net, user gestures, columns, login pages, What’s new card, popup fit, links, headings, Bing:');
{
  const LONGP = 'Placeholder paragraph with plenty of words so that the page clearly has content of its own. '.repeat(12);
  const stub = (st, extra = '') => `window.__state=${JSON.stringify(st)};window.__cbs=[];window.__sent=[];
    window.chrome={storage:{local:{get:async(d)=>({...d,...window.__state})},onChanged:{addListener:(f)=>window.__cbs.push(f)}},
      runtime:{id:'quell',onMessage:{addListener(){}},sendMessage:async(m)=>{ if(m.type==='blocked'){window.__sent.push(m);return;} ${extra} }}};`;
  const openAt = async (host, urlPath, html, src, st, wait = 1800, extra = '') => {
    const pg = await ctx.newPage();
    await pg.setViewportSize({ width: 1280, height: 720 });
    await pg.route(`http://${host}/**`, (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: stub(st, extra) + '\n' + src });
    await pg.goto(`http://${host}${urlPath}`);
    await pg.waitForTimeout(wait);
    return pg;
  };
  const vis = (pg, id) => pg.evaluate((i) => { const e = document.getElementById(i); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }, id);
  const AIW = SETTINGS_SRC + '\n' + AIWEB_SRC;
  const PROMPTS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/signup-prompts.js'), 'utf8');

  // 1. An app swapping its own content (spinner, then re-render) must not trip the safety net.
  {
    const html = `<!doctype html><html><body><header><button aria-label="Ask AI" id="ask1">Ask AI</button></header>
      <main id="m"><p>${'Placeholder article sentence with several words in it. '.repeat(54)}</p></main>
      <script>
        setTimeout(() => { document.getElementById('m').innerHTML = '<div id="spin">Loading</div>'; }, 900);
        setTimeout(() => { document.getElementById('m').innerHTML = '<p>${'Placeholder article sentence with several words in it. '.repeat(54)}</p>'; const b = document.createElement('button'); b.id = 'ask2'; b.setAttribute('aria-label', 'Ask AI'); b.textContent = 'Ask AI'; document.body.prepend(b); }, 2100);
      </script></body></html>`;
    const len = (html.match(/Placeholder article sentence/g) || []).length;
    const pg = await openAt('spa.test', '/', html, AIW, { enabled: true, aiWebOn: true, aiWebAccess: true }, 3800,
      "if(m.type==='aiWebRules') return {rules:[{sel:['button[aria-label=\"Ask AI\"]'],what:'Ask AI'}]};");
    ok(len >= 54 && await pg.evaluate(() => document.body.innerText.length) > 2900, 'precondition: the page holds about 2,900 characters of text');
    ok(await pg.evaluate(() => !document.documentElement.hasAttribute('data-quell-safety')), 'a page swapping its own content to a spinner and back does not trip the safety net');
    ok(!(await vis(pg, 'ask1')) && !(await vis(pg, 'ask2')), 'Ask AI is hidden before the swap and again after the re-render');
    await pg.close();
  }
  // 1b. A hide that really blanks the page still trips; the net re-arms on a new address.
  {
    const html = `<!doctype html><html><body><main id="m"><p id="t">${LONGP}${LONGP}</p></main></body></html>`;
    const pg = await openAt('guard2.test', '/a', html, SETTINGS_SRC, {}, 300);
    const res = await pg.evaluate(() => {
      const G = QuellSettings.guard; let undone = 0;
      G.register(() => { undone++; document.getElementById('m').style.display = ''; });
      G.measure();
      document.getElementById('m').style.display = 'none'; G.acted();
      return { tripped: G.check(), undone, attr: document.documentElement.getAttribute('data-quell-safety') };
    });
    ok(res.tripped && res.undone === 1 && res.attr === '1', 'Quell blanking the page in one sweep still trips the net and undoes the hide');
    await pg.evaluate(() => { window.__rearm = 0; document.addEventListener('quell:rearm', () => window.__rearm++); history.pushState({}, '', '/b'); });
    await pg.waitForTimeout(1800);
    ok(await pg.evaluate(() => !QuellSettings.guard.state.tripped && !document.documentElement.hasAttribute('data-quell-safety') && window.__rearm === 1),
      'a change of address re-arms the net and tells the layers to start again');
    await pg.close();
  }

  // 2. A login dialog that appears some seconds after the user's own click is theirs; one with no click behind it is hidden.
  {
    const mk = (delay) => `<!doctype html><html><body><main><h1>Story</h1><p>${LONGP}</p><button id="follow">Follow</button></main>
      <script>document.getElementById('follow').addEventListener('click', () => setTimeout(() => {
        const d = document.createElement('div'); d.id = 'dlg'; d.setAttribute('role', 'dialog');
        d.style.cssText = 'position:fixed;left:30%;top:20%;width:40%;background:#fff;padding:16px;z-index:9';
        d.innerHTML = '<h2>Log in to follow</h2><input type="email" aria-label="Email"><input type="password" aria-label="Password"><button>Log in</button>';
        document.body.appendChild(d); }, ${delay}));</script></body></html>`;
    for (const sec of [1, 3, 6]) {
      const pg = await openAt('gesture.test', '/', mk(sec * 1000), PROMPTS, { popupsEnabled: true }, 300);
      await pg.click('#follow');
      await pg.waitForTimeout(sec * 1000 + 2600);
      ok(await vis(pg, 'dlg'), `a login dialog ${sec} s after a click on Follow is kept`);
      await pg.close();
    }
    const auto = `<!doctype html><html><body><main><h1>Story</h1><p>${LONGP}</p></main>
      <script>setTimeout(() => { const d = document.createElement('div'); d.id = 'dlg'; d.setAttribute('role', 'dialog');
        d.style.cssText = 'position:fixed;left:30%;top:20%;width:40%;background:#fff;padding:16px;z-index:9';
        d.innerHTML = '<h2>Log in to continue</h2><input type="email" aria-label="Email"><input type="password" aria-label="Password"><button>Log in</button>'; document.body.appendChild(d); }, 800);</script></body></html>`;
    const pg = await openAt('gesture2.test', '/', auto, PROMPTS, { popupsEnabled: true }, 3500);
    ok(!(await vis(pg, 'dlg')), 'a login dialog that appears with no click or key press behind it is still hidden');
    await pg.close();
  }

  // 3. A fixed column of the page's own with one "Log in" line in it is not a prompt.
  {
    const items = Array.from({ length: 6 }, (_, i) => `<li><a href="/s${i}">Placeholder story ${i + 1}</a></li>`).join('');
    const side = `<!doctype html><html><body><main><h1>News</h1><p>${LONGP}</p></main>
      <aside id="side" style="position:fixed;right:0;top:0;width:320px;height:100vh;background:#fff;z-index:5"><h3>Saved</h3><ul>${items}</ul><p>Log in to save stories</p></aside></body></html>`;
    const pg = await openAt('side.test', '/', side, PROMPTS, { popupsEnabled: true }, 2800);
    ok(await vis(pg, 'side'), 'a 320 px content sidebar with "Log in to save stories" is kept');
    await pg.close();
    const chat = `<!doctype html><html><body><main><h1>Live</h1><p>${LONGP}</p></main>
      <div id="chat" style="position:fixed;right:0;top:0;width:340px;height:100vh;background:#fff;z-index:5"><div>Placeholder message</div><div>Placeholder message two</div><input aria-label="Message"><p>Log in to chat</p></div></body></html>`;
    const pc = await openAt('chat.test', '/', chat, PROMPTS, { popupsEnabled: true }, 2800);
    ok(await vis(pc, 'chat'), 'a fixed chat column with a message box and "Log in to chat" is kept');
    await pc.close();
    const modal = `<!doctype html><html><body><main><h1>News</h1><p>${LONGP}</p></main>
      <div id="m" role="dialog" style="position:fixed;left:30%;top:20%;width:40%;background:#fff;padding:16px;z-index:9"><h2>Sign up or log in</h2><button>Continue with Google</button><button>Log in</button></div></body></html>`;
    const pm = await openAt('modal.test', '/', modal, PROMPTS, { popupsEnabled: true }, 2800);
    ok(!(await vis(pm, 'm')), 'control: a plain sign-up modal over an article is still hidden');
    await pm.close();
  }

  // 4. A dedicated login page at an address Quell does not know is the page, not a prompt.
  {
    const links = Array.from({ length: 16 }, (_, i) => `<a href="/f${i}">Footer ${i}</a>`).join(' ');
    const html = `<!doctype html><html><body><div id="form" style="position:fixed;left:50%;top:50%;width:560px;height:470px;margin:-235px 0 0 -280px;background:#fff;padding:16px">
      <h2>Log in</h2><form><input type="text" aria-label="User"><input type="password" aria-label="Password"><button>Log in</button></form><div>${links}</div></div></body></html>`;
    const pg = await openAt('members.test', '/members/enter', html, PROMPTS, { popupsEnabled: true }, 2800);
    ok(await vis(pg, 'form'), 'a fixed login form (password field, 16 links) on /members/enter with no page text of its own is kept');
    await pg.close();
  }

  // 7. Links: a malformed %-sequence in one address does not stop the sweep.
  {
    const LINKS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/links.js'), 'utf8');
    const html = `<!doctype html><html><body><a id="bad" href="/x?%E0%A4%A=1&utm_source=mail">bad</a><a id="good" href="/y?utm_source=mail&id=3">good</a></body></html>`;
    const pg = await openAt('links.test', '/', html, LINKS, { enabled: true, linksEnabled: true }, 1500);
    const h = await pg.evaluate(() => [document.getElementById('bad').getAttribute('href'), document.getElementById('good').getAttribute('href')]);
    ok(h[1] === 'http://links.test/y?id=3', `the clean link after the malformed one is still cleaned (${h[1]})`);
    ok(!/utm_source/.test(h[0]), `and the malformed one is cleaned with its raw key (${h[0]})`);
    await pg.close();
  }

  // 8. X: the "Today's News" heading rule leaves post text alone.
  {
    const html = `<!doctype html><html><body><div id="side"><h2 id="news-h"><span id="news-s">Today's News</span></h2></div>
      <article><div data-testid="tweetText"><span id="post">Today's News</span></div></article></body></html>`;
    const pg = await openAt('x.com', '/explore', html, AIW, { enabled: true, aiWebOn: true, aiWebAccess: true }, 1500,
      `if(m.type==='aiWebRules') return {rules:${JSON.stringify(COSMETIC.filter((r) => r.id === 'x-todays-news-heading').map((r) => ({ sel: r.sel, what: r.what, t: r.t })))}};`);
    ok(!(await vis(pg, 'news-h')) && await vis(pg, 'post'), 'the "Today’s News" heading in the sidebar goes; a post that says the same words stays');
    await pg.close();
  }

  // 10. Bing News: the "AI MODE" tab goes with Bing's AI switch, nothing shifts.
  {
    const BINGJS = SETTINGS_SRC + '\n' + readFileSync(path.join(EXT, 'src/content/common.js'), 'utf8') + '\n' + readFileSync(path.join(EXT, 'src/content/bing.js'), 'utf8');
    const html = `<!doctype html><html><body><header id="b_header"><nav><ul id="tabs"><li><a id="t-all" href="/news">All</a></li><li id="aili"><a id="aimode" href="/x">AI MODE</a></li><li><a id="t-news" href="/news/search">News</a></li></ul></nav></header>
      <div id="b_results"><div class="b_algo"><a id="org" href="https://example.com/">AI mode explained</a></div></div></body></html>`;
    const pg = await ctx.newPage();
    await pg.route('https://www.bing.com/**', (r) => r.fulfill({ contentType: 'text/html', body: html }));
    await pg.addInitScript({ content: `window.chrome={storage:{local:{get:async(d)=>({...d,enabled:true,aiEnabled:true,bingEnabled:true})},onChanged:{addListener(){}}},runtime:{id:'quell',onMessage:{addListener(){}},sendMessage(){}}};` + '\n' + BINGJS });
    await pg.goto('https://www.bing.com/news');
    await pg.waitForTimeout(900);
    ok(!(await vis(pg, 'aimode')) && !(await vis(pg, 'aili')) && await vis(pg, 't-all') && await vis(pg, 't-news') && await vis(pg, 'org'),
      'Bing News: the "AI MODE" tab is hidden with its list item; the other tabs and the results stay');
    await pg.close();
  }

  // 5 + 6 + 9. The popup, in the real extension.
  {
    const popup = async ({ tabbed = false, stubPerm = false } = {}) => {
      const p = await ctx.newPage();
      await p.setViewportSize({ width: 360, height: 600 });
      await p.addInitScript(({ tabbedIn, stubIn }) => {
        window.__perm = [];
        if (stubIn) {
          chrome.permissions.request = async (o) => { window.__perm.push(['request', o]); return true; };
          chrome.permissions.remove = async (o) => { window.__perm.push(['remove', o]); return true; };
        }
        if (!tabbedIn) return;
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
      }, { tabbedIn: tabbed, stubIn: stubPerm });
      await p.goto(`chrome-extension://${extId}/src/popup/popup.html`);
      await p.waitForTimeout(900);
      return p;
    };
    const fits = (p) => p.evaluate(() => { const m = document.getElementById('main'); return { over: m.scrollHeight - m.clientHeight, body: Math.round(document.body.getBoundingClientRect().height) }; });
    const base = { enabled: true, firstRunDone: true, linksEnabled: false, aiWebOn: false, aiWebAccess: false, aiWebAllowlist: [], sitePauses: {}, analytics: 'unset', whatsNewSeen: '' };

    await set(base);
    let p = await popup();
    ok(await p.evaluate(() => !document.getElementById('whatsNew').hidden && document.getElementById('firstRun').hidden && document.getElementById('mainCard').hidden),
      'updated user: the What’s new card shows, in place of the first-run card');
    ok(await p.evaluate(() => /What.s new in Quell 0\.7\.4/.test(document.getElementById('wnT').textContent) && document.querySelectorAll('.wn-list li').length === 3
      && /Turn these on/.test(document.querySelector('#whatsNew [data-fr=turn]').textContent) && /Not now/.test(document.querySelector('#whatsNew [data-fr=skip]').textContent)),
      'the card has a title, three short lines, "Turn these on" and "Not now"');
    ok(await p.evaluate(() => !document.getElementById('wnAna').hidden && !!document.querySelector('#whatsNew [data-fr=analytics]')), 'with usage counts unset, the card carries the usage-counts line');
    let f = await fits(p);
    ok(f.over <= 0 && f.body <= 560, `the card fits the 360 x 560 popup with no scroll (overflow ${f.over}, ${f.body}px)`);
    await p.screenshot({ path: '/tmp/quell-review/whats-new-card.png' }).catch(() => {});
    await p.click('#whatsNew [data-fr=sentBtn]');
    await p.waitForTimeout(200);
    f = await fits(p);
    await p.screenshot({ path: '/tmp/quell-review/whats-new-card-sent-open.png' }).catch(() => {});
    ok(f.over <= 0 && f.body <= 560, `with "What’s sent" open it still fits (overflow ${f.over})`);
    await p.close();

    // Not now: nothing turns on, the card does not come back.
    p = await popup({ stubPerm: true });
    await p.click('#whatsNew [data-fr=skip]');
    await p.waitForTimeout(500);
    let s = await sw.evaluate(() => QuellSettings.get({ linksEnabled: false, aiWebOn: true, aiWebAccess: false, whatsNewSeen: '' }));
    ok(s.linksEnabled === false && s.aiWebOn === false && s.aiWebAccess === false && s.whatsNewSeen === '0.7.4', '"Not now" leaves Links and AI on websites off and records the card as seen');
    ok(await p.evaluate(() => document.getElementById('whatsNew').hidden && !document.getElementById('mainCard').hidden), 'and the card is gone, the normal popup shows');
    await p.close();
    p = await popup();
    ok(await p.evaluate(() => document.getElementById('whatsNew').hidden), 'a later popup does not show it again');
    await p.close();

    // Close behaves like Not now.
    await set(base);
    p = await popup();
    await p.click('#wnClose');
    await p.waitForTimeout(500);
    s = await sw.evaluate(() => QuellSettings.get({ linksEnabled: false, aiWebOn: true, whatsNewSeen: '' }));
    ok(s.linksEnabled === false && s.aiWebOn === false && s.whatsNewSeen === '0.7.4', 'the close button also leaves them off and does not show the card again');
    await p.close();

    // Turn these on.
    await set(base);
    p = await popup({ stubPerm: true });
    await p.click('#whatsNew [data-fr=turn]');
    await p.waitForTimeout(700);
    s = await sw.evaluate(() => QuellSettings.get({ linksEnabled: false, aiWebOn: false, aiWebAccess: false, whatsNewSeen: '', analytics: 'unset' }));
    ok(s.linksEnabled === true && s.aiWebOn === true && s.aiWebAccess === true && s.whatsNewSeen === '0.7.4', '"Turn these on" turns Links and AI on websites on');
    ok(await p.evaluate(() => window.__perm.some(([k, o]) => k === 'request' && (o.origins || []).includes('<all_urls>'))), 'and asks the browser for all-sites access');
    ok(s.analytics === 'on' || s.analytics === 'off', 'and saves the usage-counts choice shown on the card');
    await p.close();

    // Fresh install: the first-run card, not this one; finishing it records the card as seen.
    await set({ ...base, firstRunDone: false });
    p = await popup({ stubPerm: true });
    ok(await p.evaluate(() => !document.getElementById('firstRun').hidden && document.getElementById('whatsNew').hidden), 'fresh install: the first-run card shows and the What’s new card does not');
    await p.click('#firstRun [data-fr=skip]');
    await p.waitForTimeout(500);
    s = await sw.evaluate(() => QuellSettings.get({ firstRunDone: false, whatsNewSeen: '' }));
    ok(s.firstRunDone === true && s.whatsNewSeen === '0.7.4', 'finishing first run records the What’s new card as seen: a new user never gets it');
    await p.close();

    // Links off gives webNavigation back.
    await set({ ...base, whatsNewSeen: '0.7.4', linksEnabled: true, linksWarnAffiliate: true });
    p = await popup({ stubPerm: true });
    await p.evaluate(() => { document.getElementById('links').checked = true; });
    const linksBox = await p.evaluate(() => document.getElementById('links').checked);
    if (linksBox) { await p.evaluate(() => { document.getElementById('links').click(); }); await p.waitForTimeout(700); }
    ok(await p.evaluate(() => window.__perm.some(([k, o]) => k === 'remove' && (o.permissions || []).includes('webNavigation'))), 'turning Links off hands back the webNavigation permission');
    ok((await sw.evaluate(() => QuellSettings.get({ linksEnabled: true, linksWarnAffiliate: true }))).linksEnabled === false, 'and the Links switch is off');
    await p.close();

    // Item 6: a Google page with hidden items and the site card fits without a scroll.
    await set({ ...base, whatsNewSeen: '0.7.4', googleMode: 'hide', hideOverview: true, hideAiMode: true, hidePaa: true, hideGemini: true, aiEnabled: true, aiAllowlist: [], cookieAllowlist: [], popupAllowlist: [] });
    const g = await ctx.newPage();
    await g.setViewportSize({ width: 1280, height: 900 });
    await g.route('https://www.google.com/search**', (r) => r.fulfill({ contentType: 'text/html', body: GOOGLE_LIVE }));
    await g.goto('https://www.google.com/search?q=how+long+to+boil+an+egg', { waitUntil: 'domcontentloaded' });
    await g.waitForTimeout(2200);
    p = await popup({ tabbed: true });
    await p.waitForTimeout(500);
    const n = await p.evaluate(() => document.querySelectorAll('#itemList .item').length);
    f = await fits(p);
    ok(n >= 1 && await p.evaluate(() => !document.getElementById('siteCard').hidden), `precondition: the Google page lists hidden items (${n}) and the site card shows`);
    ok(f.over <= 0 && f.body <= 560, `a Google page with hidden items and the site card fits the popup with no scroll (overflow ${f.over}, ${f.body}px)`);
    await p.close();
    await g.close();
    await set({ aiAllowlist: [], sitePauses: {} });
  }
}

await ctx.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
