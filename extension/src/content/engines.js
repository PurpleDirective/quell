// Quell — DuckDuckGo / Brave / Yahoo.
//
// One dispatcher rather than three near-identical files: the hiding technique
// is the same everywhere (a maintainable CSS list, plus a text-resilient pass
// anchored on the human-readable label), and three copies of that logic is
// three places for it to drift.
//
// Every engine here offers the same shape of choice Google already has:
//   'off'   — leave the engine alone
//   'hide'  — surgically remove the AI surface, keep the rest
//   'clean' — flip the engine's OWN "no AI" query parameter
//
// 'clean' is the strongest mode wherever it exists, because it is selector-proof:
// the engine simply does not build the surface, so markup churn cannot break it.
// Measured 2026-09-10 — see store/QUELL-ENGINES recon:
//   DuckDuckGo  assist=false   (DDG's own nav exposes assist=true, so it is a real toggle)
//   Brave       summary=0      (#llm-snippet is never created at all)
//   Yahoo       none found     — 'clean' is not offered there rather than faked
//
// Selectors below anchor on the ORGANIC-results containers proven by
// containment checks in that recon; none can match an organic result.

(async () => {
  const CONFIG = {
    'duckduckgo.com': {
      key: 'ddgMode',
      // A single <li> cannot be both data-layout="organic" and "wikinlp", so
      // this cannot match an organic result.
      css: ['li[data-layout="wikinlp"]:has([data-testid="duckassist-answer-content"])'],
      label: 'search assist',
      // "Search Assist" is ALSO the nav toggle link's text, so the label alone
      // is too generic — require the answer testid to co-occur in the block,
      // the same guard shape google.js uses for People-also-ask.
      labelRequires: '[data-testid*="duckassist"]',
      block: 'li[data-layout], .react-results--main > li',
      // The organic boundary is the organic RESULT, not the results list —
      // DDG renders its AI card as a sibling <li> inside the same
      // .react-results--main container, so scoping to the container marked
      // the AI card itself as organic and made both passes inert here.
      organic: 'li[data-layout="organic"]',
      cleanParam: ['assist', 'false'],
      // Web results only. `/?q=…&ia=chat` is Duck.ai — a chat the user opened
      // on purpose — and ia=images/videos/news are other verticals; none of
      // them are a place to be rewriting the URL.
      cleanPath: (u) => u.pathname === '/'
        && ['web', null].includes(u.searchParams.get('ia')),
      // DDG collapses the card to zero height rather than removing the node,
      // so 'clean' must be judged by "nothing is visible", never by "the node
      // is gone".
    },
    'search.brave.com': {
      key: 'braveMode',
      css: ['#llm-snippet', '#mixed-top #llm-snippet'],
      // Brave renders no plain-text "AI" label, so the resilient anchor is the
      // aria-label on its own feedback controls.
      ariaLabels: ['good response', 'bad response', 'ask a follow-up question'],
      // NOT '#mixed-top': a feedback control that sits in #mixed-top but
      // outside #llm-snippet resolved `block` to the entire top section, which
      // would take any sibling module down with it the day Brave adds one.
      block: '#llm-snippet, .snippet',
      organic: '#mixed-main',
      cleanParam: ['summary', '0'],
      // Brave's web results live at /search. /images, /videos, /news and
      // especially /ask (its explicit AI page) are not ours to rewrite.
      cleanPath: (u) => u.pathname === '/search',
    },
    'search.yahoo.com': {
      key: 'yahooMode',
      // genAiSum / grp-genAISum are literal semantic names, not build hashes.
      // Organic results live in a SIBLING <ol class="searchCenterMiddle">.
      css: ['.genAiSum', '.grp-genAISum', 'ol.searchCenterTop li:has(.genAiSum)',
        // Yahoo Scout, Yahoo's AI chat (live 2026-09-25): the "Yahoo Scout"
        // tab in the vertical bar, the "Try Yahoo Scout" promo under the
        // search box, and the right-rail "Explore AI results with Yahoo
        // Scout" panel, whose every link opens a Scout chat. The panel is
        // matched by its own title linking into Scout, in the right rail only;
        // an organic result that links to scout.yahoo.com (a review of it, say)
        // sits in ol.searchCenterMiddle and is excluded by the guard, because
        // this CSS layer hides before the organic check in sweep() runs.
        '.dd.scoutNav:not(ol.searchCenterMiddle *)',
        '#scoutPromoTooltip:not(ol.searchCenterMiddle *)',
        '#right .dd:has(> .compTitle a[href*="scout.yahoo.com"]):not(ol.searchCenterMiddle *)',
        // The footer "Also try" block, titled "Explore AI results with Yahoo
        // Scout" on live markup 2026-09-25: every link opens a Scout chat.
        // Only when its own title links into Scout; a plain related-searches
        // footer keeps its place.
        'ol.searchCenterFooter .dd.AlsoTry:has(> .compTitle a[href*="scout.yahoo.com"]):not(ol.searchCenterMiddle *)'],
      label: 'ai summary',
      block: '.grp-genAISum, ol.searchCenterTop > li, .dd.genAiDD',
      organic: 'ol.searchCenterMiddle',
      // "AI Summary" is a phrase Yahoo also renders in knowledge panels and
      // in organic titles, so the label alone may not hide anything — the
      // block must carry Yahoo's own AI-summary markup too, the same guard
      // shape DDG uses for duckassist.
      labelRequires: '.genAiSum, .grp-genAISum',
      cleanParam: null,   // none found; do not fake one
    },
  };

  // Match on the registrable suffix, not the exact hostname: the manifest
  // grants *.search.yahoo.com, so uk./fr./de./ca./au./in. all inject — but an
  // exact-host lookup found no config and every regional Yahoo silently did
  // nothing while the popup showed Yahoo as handled.
  const host = location.hostname.replace(/^www\./, '');
  const cfgKey = Object.keys(CONFIG)
    .find((k) => host === k || host.endsWith('.' + k));
  const cfg = cfgKey ? CONFIG[cfgKey] : null;
  if (!cfg) return;

  // Records the exact URL a clean-mode redirect THIS tab produced, so leaving
  // clean mode can undo it without fighting a user who set the parameter
  // themselves.
  //
  // It stores the URL rather than a bare '1' because a boolean cannot tell the
  // two apart once the redirect has landed: afterwards the address bar simply
  // has the parameter in it, exactly as it would if the user had set it. A
  // sticky boolean therefore survived into later navigations in the same tab
  // and, on the next mode change, deleted a value the USER had chosen — the
  // very thing the flag exists to prevent. Keyed to the URL, the mark stops
  // applying the moment the page is anything other than the one we redirected
  // to.
  const FLAG = '__quellClean_' + cfgKey;
  const flagRead = () => { try { return sessionStorage.getItem(FLAG); } catch (_) { return null; } };
  const flagSet = (v) => {
    try { v ? sessionStorage.setItem(FLAG, v) : sessionStorage.removeItem(FLAG); }
    catch (_) { /* blocked */ }
  };
  // Ours only if this is still the page we produced. Compared without the
  // fragment: a site that appends its own #hash (or replaceState's one in)
  // after load would otherwise strand Quell's parameter, because leaving clean
  // mode would no longer recognise its own redirect.
  const addressable = (u) => { try { const x = new URL(u); x.hash = ''; return x.toString(); } catch (_) { return u; } };
  const flagGet = () => flagRead() !== null && addressable(flagRead()) === addressable(location.href);
  // Any other page clears it. This is HYGIENE, not correctness — flagGet()
  // already compares against location.href, so a stale entry could not be acted
  // on; this just stops one accumulating in sessionStorage for the tab's life.
  // Deleting this line does not fail any test, and that is correct.
  if (flagRead() !== null && !flagGet()) flagSet(null);

  const alreadyCounted = (el) =>
    el.closest('[data-quell-counted="1"]') !== null ||
    el.querySelector('[data-quell-counted="1"]') !== null;

  // Never hide anything that sits inside the organic-results container. This is
  // the one invariant that must hold on every engine: Quell erasing a real
  // result is worse than any AI block it fails to hide.
  const isOrganic = (el) => !!(cfg.organic && el.closest(cfg.organic));

  function sweep() {
    let hidden = 0;
    for (const el of document.querySelectorAll(cfg.css.join(','))) {
      if (isOrganic(el)) continue;
      if (!alreadyCounted(el)) { el.dataset.quellCounted = '1'; hidden++; }
    }

    const wanted = [];
    if (cfg.label) wanted.push(cfg.label);
    const arias = cfg.ariaLabels || [];

    for (const el of document.querySelectorAll('h1,h2,h3,span,div[role="heading"],[aria-label]')) {
      if (el.closest('a')) continue;                       // organic titles live in links
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const txt = (el.textContent || '').trim().toLowerCase();
      const hitAria = aria && arias.some((l) => aria === l || aria.startsWith(l));
      const hitText = txt && txt.length <= 40 && wanted.some((l) => txt === l || txt.startsWith(l));
      if (!hitAria && !hitText) continue;

      // No el.parentElement fallback: a label that matches nothing in
      // cfg.block is a label we do not understand, and hiding its arbitrary
      // parent is how a knowledge panel or a nav item disappears.
      const block = el.closest(cfg.block);
      if (!block || isOrganic(block)) continue;
      // A generic label needs corroborating structure before it may hide a block.
      if (hitText && cfg.labelRequires && !block.querySelector(cfg.labelRequires)) continue;

      if (block.dataset.quellHidden !== '1') {
        block.style.setProperty('display', 'none', 'important');
        block.dataset.quellHidden = '1';
        if (!alreadyCounted(block)) { block.dataset.quellCounted = '1'; hidden++; }
      }
    }
    window.Quell.report(hidden);
  }

  let observer = null, scheduled = false, active = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.Quell.nextTick(() => { scheduled = false; if (observer) sweep(); });
  };

  function applyHide() {
    window.Quell.injectCSS('quell-engine', `${cfg.css.join(',\n')} { display: none !important; }`);
    if (active) { if (observer) sweep(); return; }
    active = true;
    const attach = () => {
      if (!active || observer) return;
      sweep();
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  function teardown() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    window.Quell.removeCSS('quell-engine');
    for (const el of document.querySelectorAll('[data-quell-hidden="1"]')) {
      el.style.removeProperty('display');
      delete el.dataset.quellHidden;
    }
  }

  // Clean mode adds the engine's own no-AI parameter. It may only ever ADD it.
  //
  // Rewriting the parameter whenever it did not already equal the clean value
  // meant Quell overrode the user's own opposite choice: clicking DuckDuckGo's
  // "Search Assist" toggle sets ?assist=true, and Quell flipped it straight
  // back to false — the engine's own switch was dead while Quell was
  // installed, with nothing on screen to explain why. If the parameter is
  // present at all, the user (or the engine) has already spoken; leave it.
  function applyClean() {
    if (!cfg.cleanParam) return;
    const [k, v] = cfg.cleanParam;
    const url = new URL(location.href);
    if (url.searchParams.has(k)) return;         // already decided — not ours
    if (!url.searchParams.has('q')) return;      // only a results page
    if (cfg.cleanPath && !cfg.cleanPath(url)) return;  // web results only
    url.searchParams.set(k, v);
    flagSet(url.toString());
    location.replace(url.toString());
  }

  function undoClean() {
    if (!cfg.cleanParam || !flagGet()) return;
    const [k, v] = cfg.cleanParam;
    const url = new URL(location.href);
    if (url.searchParams.get(k) !== v) return;
    flagSet(null);
    url.searchParams.delete(k);
    location.replace(url.toString());
  }

  function applyState(s, live) {
    const mode = s[cfg.key] ?? 'hide';
    const paused = s.aiEnabled === false || window.Quell.aiPaused(s);
    if (!s.enabled || paused || mode === 'off') { teardown(); if (live) undoClean(); return; }
    if (mode === 'clean' && cfg.cleanParam) { teardown(); applyClean(); return; }
    if (live) undoClean();
    applyHide();
  }

  // Guard double-injection: the background injects into already-open tabs the
  // moment the hosts are granted, and those tabs may already be running the
  // registered copy. Same guard cookies.js carries, for the same reason.
  if (window.__quellEngines) return;
  window.__quellEngines = true;

  window.Quell.onSettingsChange(['enabled', 'aiEnabled', 'aiAllowlist', cfg.key], (next) => applyState(next, true));
  applyState(await window.Quell.getSettings(), false);
})();
