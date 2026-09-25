// Quell — Bing Search surface. Hides Copilot's own entry points on the SERP.
// CSS does the hiding; a light sweep counts what was hidden for the badge.
// Applies live: toggling Bing (or its chip sub-switch) in the popup takes
// effect without a reload.
//
// Phase 1 (2026-09-10): Bing routes "Ask Copilot" through /copilotsearch via
// two different kinds of link — a bare nav tab in the scope bar (no query
// text, an unambiguous upsell) and suggestion chips in
// #b_copilot_search_container that carry REAL QUERY TEXT and read as related
// searches. Those are opposite user intentions — same shape of problem
// google.js already solved for AI Overview vs People-Also-Ask: the bare tab
// is hidden by default, the chips get their OWN switch, off by default,
// because a chip carrying a real query is arguably something the user wants.
// The user chooses; we do not decide for them.

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
    // no query text. `.b_scopebar` is page chrome inside <header id="b_header">,
    // never inside #b_results (organic results).
    '.b_scopebar a[href*="/copilotsearch" i]',
  ].map((s) => s + GUARD);

  // Suggestion chips carry a real related-search query — gated by its own
  // switch (hideBingChips), default OFF, same reasoning as google.js's
  // hidePaa. #b_copilot_search_container is a direct child of <body>,
  // positioned after #b_results as a sibling — never inside it (confirmed by
  // DOM-containment check both directions). Double-scoped by both the
  // container id and Bing's own suggestion_chip class, so an organic result
  // (which never carries that class) can never match.
  const CHIP_SEL = [
    '#b_copilot_search_container a.suggestion_chip[href*="/copilotsearch" i]',
  ].map((s) => s + GUARD);

  // Live per-surface state, refreshed by applyState() — read by sweep() and
  // by the CSS builder, both need to agree on which surfaces are in play.
  let surfaces = { chips: false };

  function blockSelectors() {
    return BASE_SEL.concat(surfaces.chips ? CHIP_SEL : []);
  }
  function buildCSS() {
    const sel = blockSelectors().join(',\n    ');
    return sel ? `${sel} { display: none !important; }` : '';
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
  // there's a body. The stylesheet is now a function of `surfaces`, so a
  // live toggle (e.g. hideBingChips) has to REPLACE it — an early return on
  // `active` would leave the previous surfaces' CSS in place, exactly the
  // bug google.js's applyHide already had to solve for its own per-surface
  // switches. Bing hides purely via stylesheet (no inline styles), so
  // rebuilding + re-injecting is a complete, self-releasing undo: an element
  // dropped from the selector list simply stops matching and reappears.
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

  const applyState = (s) => {
    surfaces = { chips: s.hideBingChips === true };
    return (s.enabled && s.bingEnabled) ? apply() : teardown();
  };

  // Subscribe before the first async read — see the note in google.js.
  window.Quell.onSettingsChange(['enabled', 'bingEnabled', 'hideBingChips'], applyState);
  applyState(await window.Quell.getSettings());
})();
