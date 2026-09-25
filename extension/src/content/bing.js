// Quell — Bing Search surface. Hides Copilot's own entry points on the SERP.
// CSS does the hiding; a light sweep counts what was hidden for the badge.
// Applies live: toggling Bing in the popup takes effect without a reload.
//
// 0.6.0 (owner decision 2026-09-24): the /copilotsearch suggestion chips are
// hidden TOGETHER with the Copilot entry point, under the one Bing switch.
// 0.5.0 gave them their own switch, off by default, on the theory that a
// chip carrying a real query reads as a related search. It does not behave
// like one: every chip routes into Copilot, not into a web search, so it is
// an AI entry point with a query pre-filled. One switch, one meaning.
//
// Live Bing (measured 2026-09-10, IMPROVEMENT-PLAN): 4 /copilotsearch links on
// one SERP — the bare "Search" tab in the scope bar, suggestion chips inside
// #b_copilot_search_container (a direct child of <body>, a sibling AFTER
// #b_results), and one more outside both. So the rule is the route itself:
// any link into /copilotsearch that is not an organic result.
(async () => {
  // Always-on: no query text, pure navigation into Copilot chat/panel.
  //
  // EVERY selector here carries the :not(#b_results *) guard, without
  // exception. Two of these are substring matches on the word "Copilot" —
  // an aria-label and a copilot.microsoft.com href — and Microsoft's own
  // product is a thing people search FOR. Unguarded, the query "copilot"
  // deleted its own #1 organic result: the title link is
  // href="…copilot.microsoft.com", and result cards carry aria-labels
  // echoing their title. That shipped in 0.4.2 because the guard was added
  // only to the newest two selectors while the older ones were assumed safe
  // on the strength of where Bing puts its chrome. #b_results is the organic
  // boundary; nothing Quell hides may live inside it, and the cheapest way to
  // guarantee that is to never write a Bing selector without the guard.
  const GUARD = ':not(#b_results *)';
  const BASE_SEL = [
    '#b_sydConvCont',
    '.b_sydConvVisible',
    '[aria-label*="Copilot" i]',
    'a[href*="copilot.microsoft.com"]',
    'a[href*="bing.com/chat"]',
    '.cibsbserp',
    '#codex-bnp',
    // The bare "Search"/Copilot tab in Bing's own scope bar — icon + label,
    // no query text. `.b_scopebar` is page chrome inside <header id="b_header">.
    '.b_scopebar a[href*="/copilotsearch" i]',
    // The suggestion-chip row as a whole, so no empty strip is left behind.
    '#b_copilot_search_container',
    // Every other link into Copilot search — chips, the fourth link measured
    // live, and whatever Bing adds next. The GUARD below keeps an organic
    // result that happens to link to /copilotsearch visible.
    'a[href*="/copilotsearch" i]',
  ].map((s) => s + GUARD);

  function blockSelectors() {
    return BASE_SEL;
  }
  function buildCSS() {
    return `${BASE_SEL.join(',\n    ')} { display: none !important; }`;
  }

  // Count hidden elements (once each) so the badge reflects Bing too. The
  // seen-flags survive teardown so a toggle off/on doesn't re-inflate the
  // lifetime counter on the same page.
  function sweep() {
    const sel = blockSelectors().join(',');
    if (!sel) { window.Quell.report(0); return; }
    let hidden = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (el.dataset.quellSeen !== '1') {
        el.dataset.quellSeen = '1';
        hidden++;
      }
    }
    window.Quell.report(hidden);
  }

  let observer = null;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.Quell.nextTick(() => { scheduled = false; if (observer) sweep(); });
  };

  // CSS at document_start so nothing paints; sweep/observer attach once
  // there's a body. The stylesheet is rebuilt on every apply (rather than an
  // early return on `active`) so the selector list can never go stale on a
  // live page. Bing hides purely via stylesheet (no inline styles), so
  // removing it is a complete, self-releasing undo.
  let active = false;
  function apply() {
    window.Quell.removeCSS('quell-bing');
    const css = buildCSS();
    if (css) window.Quell.injectCSS('quell-bing', css);
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
    window.Quell.removeCSS('quell-bing');
  }

  const applyState = (s) =>
    (s.enabled && s.aiEnabled !== false && s.bingEnabled && !window.Quell.aiPaused(s))
      ? apply() : teardown();

  // Subscribe before the first async read — see the note in google.js.
  window.Quell.onSettingsChange(['enabled', 'aiEnabled', 'aiAllowlist', 'bingEnabled'], applyState);
  applyState(await window.Quell.getSettings());
})();
