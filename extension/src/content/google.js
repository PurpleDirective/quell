// Quell — Google Search surface.
// Two strategies:
//   'cleanweb' — append udm=14 to force Google's classic web results (zero AI,
//                selector-proof, never breaks).
//   'hide'     — surgically remove AI Overview / AI Mode blocks and keep the
//                rest of Google. Uses a maintainable selector list PLUS a
//                text-resilient pass (find the "AI Overview" label, hide its
//                block) so it survives most markup churn.
//
// Phase 1 (2026-09-10) splits 'hide' by SURFACE. Google renders a
// People-Also-Ask answer as the same object as an AI Overview — same
// "AI Overview" label, same block shape — so the old single switch hid both.
// But those are opposite user intentions: the overview above the results is
// unsolicited, while a PAA answer is AI the user explicitly clicked to see.
// Hiding the second one reads as "Quell broke Google", which is the review
// that caps every competitor in this niche. So the label pass now has to know
// WHERE a match sits, not just that it matched.
//
// Every mode applies LIVE: a popup toggle re-runs applyState() on the open tab
// instead of waiting for a reload.

(async () => {
  // Whole AI-block selectors (the part the Phase 2 pipeline keeps fresh).
  // Kept as an array because each one now has to be composed with the PAA
  // guard below at runtime, depending on the user's per-surface settings.
  const OVERVIEW_SEL = [
    'div[data-attrid="AIOverview" i]',
    'div[aria-label="AI Overview" i]',
    '.M8OgIe',
    '.YzCcne',
    '[data-hveid] [aria-label*="AI Overview" i]',
  ];

  // The Gemini selectors target upsell chips/promos in Google's own chrome —
  // NOT organic results. Unscoped they erased legitimate results linking to
  // gemini.google.com (searching "gemini" lost real links), so exempt anything
  // inside the organic containers.
  const GEMINI_SEL = [
    'a[href*="gemini.google.com"]:not(#rso *):not(#search *)',
    '[aria-label*="Gemini" i]:not(#rso *):not(#search *)',
  ];

  // People-Also-Ask markers. An answer painting inside one of these was
  // REQUESTED — the user clicked the question open. Everything else that
  // carries an AI label appeared without being asked for.
  const PAA_SEL = [
    '[jsname="Cpkphb"]',
    '.related-question-pair',
    '[data-initq]',
    '[jsname="yEVEwb"]',
  ];
  // CSS form of "not inside a PAA item", appended to the overview selectors
  // when the user is keeping clicked answers. Without this the stylesheet
  // layer would hide the PAA answer before the label pass ever sees it.
  const PAA_GUARD = PAA_SEL.map((s) => `:not(${s} *)`).join('');

  // Text-resilient pass — anchors on the human-readable label, not class names.
  const LABELS = ['ai overview', 'ai mode', 'generative ai', 'search with ai'];
  const BLOCK_SEL = '#rso > div, #center_col > div, [data-hveid], .MjjYud, .ULSxyf, .hlcw0c';

  // Live per-surface state, refreshed by applyState(). Read by sweep() and by
  // the CSS builder — both need to agree on which surfaces are in play.
  let surfaces = { overview: true, aiMode: true, paa: false, gemini: true };

  // Which selectors are live right now. Overview selectors carry the PAA guard
  // whenever PAA answers are being kept, so the two layers can never disagree.
  // All four combinations, because the two layers must never disagree. The
  // paa-only case is the one that was missing: with the overview surface off
  // and PAA on, a clicked-open answer carrying data-attrid but no visible
  // label was hidden by neither layer, so one answer vanished and the next
  // painted.
  function blockSelectors() {
    const out = [];
    if (surfaces.overview && surfaces.paa) {
      out.push(...OVERVIEW_SEL);                                  // everywhere
    } else if (surfaces.overview) {
      for (const s of OVERVIEW_SEL) out.push(s + PAA_GUARD);      // outside PAA only
    } else if (surfaces.paa) {
      for (const m of PAA_SEL) for (const s of OVERVIEW_SEL) out.push(`${m} ${s}`); // inside PAA only
    }
    return out;
  }
  function buildCSS() {
    const parts = blockSelectors().concat(surfaces.gemini ? GEMINI_SEL : []);
    return parts.length ? `${parts.join(',\n    ')} { display: none !important; }` : '';
  }

  // Marks a Clean Web redirect THIS tab performed, so switching back out of
  // Clean Web can undo it — while never fighting a user who reached udm=14 on
  // their own (typed it, bookmarked it, came via udm14.com).
  const CLEANWEB_FLAG = '__quellCleanWeb';
  const flagGet = () => { try { return sessionStorage.getItem(CLEANWEB_FLAG) === '1'; } catch (_) { return false; } };
  const flagSet = (v) => { try { v ? sessionStorage.setItem(CLEANWEB_FLAG, '1') : sessionStorage.removeItem(CLEANWEB_FLAG); } catch (_) { /* storage blocked */ } };
  // The mark describes the page the redirect produced and the searches made
  // from it (Google's own form carries udm=14 forward). Once the tab is on a
  // results page without udm=14 it no longer describes anything, and left set
  // it would later undo a udm=14 the USER chose in this tab.
  if (flagGet() && new URL(location.href).searchParams.get('udm') !== '14') flagSet(false);

  // One counted-flag shared by BOTH passes — a block matching a block selector
  // whose label also matches must increment the badge once, not twice (self,
  // ancestor, or descendant already counted all mean "same block").
  // Counted flags deliberately SURVIVE teardown: toggling a feature off and on
  // again on the same page must not re-inflate the lifetime counter.
  const alreadyCounted = (el) =>
    el.closest('[data-quell-counted="1"]') !== null ||
    el.querySelector('[data-quell-counted="1"]') !== null;

  // The PAA item containing `el`, or null. MARKER-ONLY, and that is the whole
  // safety property: a false positive here lets an unsolicited AI Overview
  // PAINT, while a false negative merely hides something the user clicked —
  // v0.4.2's behaviour, and only annoying.
  //
  // An earlier version also walked up looking for an ancestor owning a
  // [role=button][aria-expanded], on the theory that PAA items are expandable.
  // Review killed it with executed evidence: Google's own AI Overview carries a
  // "Show more" disclosure control, so that walk classified the unsolicited
  // overview as PAA and skipped it — a regression against v0.4.2 that fired
  // exactly when the class selectors were stale, which is the one case the
  // label pass exists for. Markup churn is not worth a heuristic that fails
  // open.
  function paaContainer(el) {
    return el.closest(PAA_SEL.join(','));
  }

  function sweep() {
    let hidden = 0;

    // Count what the CSS layer already hid (once per block).
    const sel = blockSelectors().join(',');
    if (sel) {
      for (const el of document.querySelectorAll(sel)) {
        if (!alreadyCounted(el)) {
          el.dataset.quellCounted = '1';
          hidden++;
        }
      }
    }

    const candidates = document.querySelectorAll(
      'h1,h2,h3,div[role="heading"],[aria-label]'
    );
    for (const el of candidates) {
      // Organic result titles live inside links ("AI Mode explained — …" is a
      // legitimate result, not the AI Mode block). Genuine AI-block labels are
      // never inside an <a>.
      if (el.closest('a')) continue;
      const txt = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 40) continue;
      if (!LABELS.some((l) => txt === l || txt.startsWith(l))) continue;

      // Classify BEFORE hiding. Sitting inside a PAA item wins over the label
      // text: Google labels the clicked answer "AI Overview" too, and that
      // label is exactly why the old single switch could not tell them apart.
      const paa = paaContainer(el);
      const surface = paa ? 'paa' : (txt.startsWith('ai mode') ? 'aiMode' : 'overview');
      if (!surfaces[surface]) continue;

      let block = el.closest(BLOCK_SEL) || el.parentElement;
      // Inside a PAA item, BLOCK_SEL can resolve to an ancestor of the whole
      // PAA section — hiding that would take every other question with it.
      if (paa && block && (block === paa || block.contains(paa))) block = el.parentElement;

      if (block && block.dataset.quellHidden !== '1') {
        block.style.setProperty('display', 'none', 'important');
        block.dataset.quellHidden = '1';
        block.dataset.quellSurface = surface;
        if (!alreadyCounted(block)) {
          block.dataset.quellCounted = '1';
          hidden++;
        }
      }
    }
    window.Quell.report(hidden);
  }

  // Google SERPs mutate constantly — coalesce observer callbacks into one
  // sweep per frame instead of a full-document scan on every mutation.
  // nextTick handles the hidden-tab case where rAF never fires.
  let observer = null;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    window.Quell.nextTick(() => { scheduled = false; if (observer) sweep(); });
  };

  // Release blocks whose surface the user just turned OFF, leaving the rest
  // hidden. Without this, un-ticking one surface did nothing until reload.
  function releaseDisabled() {
    for (const el of document.querySelectorAll('[data-quell-hidden="1"]')) {
      const s = el.dataset.quellSurface;
      if (s && !surfaces[s]) {
        el.style.removeProperty('display');
        delete el.dataset.quellHidden;
        delete el.dataset.quellSurface;
      }
    }
  }

  // CSS goes in immediately (document_start, before <body> exists) so the AI
  // block never paints. The sweep + observer need a body, so they attach on
  // DOMContentLoaded when we're early.
  let hideActive = false;
  function applyHide() {
    // The stylesheet is a function of the per-surface settings, so a live
    // toggle has to REPLACE it — an early return on hideActive would leave the
    // previous surfaces' CSS in place.
    window.Quell.removeCSS('quell-google');
    const css = buildCSS();
    if (css) window.Quell.injectCSS('quell-google', css);
    if (hideActive) { releaseDisabled(); if (observer) sweep(); return; }
    hideActive = true;
    const attach = () => {
      if (!hideActive || observer) return;
      sweep();
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  // Undo everything applyHide() did, in place. The inline display:none set by
  // the label pass has to be cleared per element — removing the stylesheet
  // alone would leave those blocks hidden.
  function teardownHide() {
    hideActive = false;
    if (observer) { observer.disconnect(); observer = null; }
    window.Quell.removeCSS('quell-google');
    for (const el of document.querySelectorAll('[data-quell-hidden="1"]')) {
      el.style.removeProperty('display');
      delete el.dataset.quellHidden;
      delete el.dataset.quellSurface;
    }
  }

  function applyCleanWeb() {
    const url = new URL(location.href);
    // Rewrite only the default results page (no udm/tbm) and Google's AI Mode
    // (udm=50). Images/News/Videos/Shopping carry their own udm (or legacy
    // tbm) — redirecting those too would make every vertical unreachable.
    const udm = url.searchParams.get('udm');
    if ((udm === null || udm === '50') && !url.searchParams.has('tbm')) {
      flagSet(true);
      url.searchParams.set('udm', '14');
      location.replace(url.toString());
    }
  }

  // Leaving Clean Web: return to the normal SERP, but only if WE redirected
  // this tab. Otherwise a user who deliberately browses udm=14 would get
  // yanked off it the moment they changed an unrelated setting.
  function undoCleanWeb() {
    if (!flagGet()) return;
    const url = new URL(location.href);
    if (url.searchParams.get('udm') !== '14') return;
    flagSet(false);
    url.searchParams.delete('udm');
    location.replace(url.toString());
  }

  // `live` is false on first run (page load) and true when a settings change
  // drove us here. Switching between hide and Clean Web navigates the tab only
  // on a live change — doing it on load would yank users mid-browse.
  //
  // Off is different: it undoes Quell's own redirect on load as well. The
  // redirect replaces the tab's history entry, so Back, a restored session or
  // a tab the browser put to sleep all reload the udm=14 address — and with
  // Quell off that page stayed on Google's AI-free list, as did every search
  // made from it. Only an address this tab's own redirect produced (the mark
  // above) is touched.
  function applyState(s, live) {
    surfaces = {
      overview: s.hideOverview !== false,
      aiMode: s.hideAiMode !== false,
      paa: s.hidePaa === true,
      gemini: s.hideGemini !== false,
    };
    // The Search group switch and "Keep AI on this site" both mean: leave
    // Google exactly as Google serves it — no hiding, no Clean Web redirect.
    if (!s.enabled || s.aiEnabled === false || window.Quell.aiPaused(s) || s.googleMode === 'off') {
      teardownHide();
      undoCleanWeb();
      return;
    }
    if (s.googleMode === 'cleanweb') {
      teardownHide();
      applyCleanWeb();
      return;
    }
    if (live) undoCleanWeb();
    applyHide();
  }

  // Subscribe BEFORE the first async read: a toggle landing during that read
  // would otherwise be missed entirely (the read returns the new value, the
  // listener isn't attached yet) and the page would sit stale until reload.
  window.Quell.onSettingsChange(
    ['enabled', 'aiEnabled', 'aiAllowlist', 'googleMode', 'hideOverview', 'hideAiMode', 'hidePaa', 'hideGemini'],
    (next) => applyState(next, true)
  );
  // Cut off from the extension (see onGone in settings.js), no switch can reach
  // this copy again, so it stops hiding. The address is left alone: the next
  // load runs the current Quell, which decides afresh.
  window.Quell.onGone(teardownHide);
  // Run at document_start — applyHide/applyCleanWeb both handle a missing
  // <body> themselves, and redirecting early avoids loading the AI page at all.
  applyState(await window.Quell.getSettings(), false);
})();
