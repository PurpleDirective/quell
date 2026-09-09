// Quell — Google Search surface.
// Two strategies:
//   'cleanweb' — append udm=14 to force Google's classic web results (zero AI,
//                selector-proof, never breaks).
//   'hide'     — surgically remove AI Overview / AI Mode blocks and keep the
//                rest of Google. Uses a maintainable selector list PLUS a
//                text-resilient pass (find the "AI Overview" label, hide its
//                block) so it survives most markup churn.
//
// Every mode applies LIVE: a popup toggle re-runs applyState() on the open tab
// instead of waiting for a reload.

(async () => {
  // Maintainable selector list (the part the Phase 2 pipeline keeps fresh).
  // BLOCK_CSS entries are whole AI blocks — they're also counted for the badge.
  const BLOCK_CSS = 'div[data-attrid="AIOverview" i], div[aria-label="AI Overview" i], .M8OgIe, .YzCcne';
  // The Gemini selectors target upsell chips/promos in Google's own chrome —
  // NOT organic results. Unscoped they erased legitimate results linking to
  // gemini.google.com (searching "gemini" lost real links), so exempt anything
  // inside the organic containers.
  const css = `
    ${BLOCK_CSS},
    [data-hveid] [aria-label*="AI Overview" i],
    a[href*="gemini.google.com"]:not(#rso *):not(#search *),
    [aria-label*="Gemini" i]:not(#rso *):not(#search *) { display: none !important; }
  `;

  // Text-resilient pass — anchors on the human-readable label, not class names.
  const LABELS = ['ai overview', 'ai mode', 'generative ai', 'search with ai'];
  const BLOCK_SEL = '#rso > div, #center_col > div, [data-hveid], .MjjYud, .ULSxyf, .hlcw0c';

  // Marks a Clean Web redirect THIS tab performed, so switching back out of
  // Clean Web can undo it — while never fighting a user who reached udm=14 on
  // their own (typed it, bookmarked it, came via udm14.com).
  const CLEANWEB_FLAG = '__quellCleanWeb';
  const flagGet = () => { try { return sessionStorage.getItem(CLEANWEB_FLAG) === '1'; } catch (_) { return false; } };
  const flagSet = (v) => { try { v ? sessionStorage.setItem(CLEANWEB_FLAG, '1') : sessionStorage.removeItem(CLEANWEB_FLAG); } catch (_) { /* storage blocked */ } };

  // One counted-flag shared by BOTH passes — a block matching BLOCK_CSS whose
  // label also matches must increment the badge once, not twice (self,
  // ancestor, or descendant already counted all mean "same block").
  // Counted flags deliberately SURVIVE teardown: toggling a feature off and on
  // again on the same page must not re-inflate the lifetime counter.
  const alreadyCounted = (el) =>
    el.closest('[data-quell-counted="1"]') !== null ||
    el.querySelector('[data-quell-counted="1"]') !== null;

  function sweep() {
    let hidden = 0;

    // Count what the CSS layer already hid (once per block).
    for (const el of document.querySelectorAll(BLOCK_CSS)) {
      if (!alreadyCounted(el)) {
        el.dataset.quellCounted = '1';
        hidden++;
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
      const block = el.closest(BLOCK_SEL) || el.parentElement;
      if (block && block.dataset.quellHidden !== '1') {
        block.style.setProperty('display', 'none', 'important');
        block.dataset.quellHidden = '1';
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

  // CSS goes in immediately (document_start, before <body> exists) so the AI
  // block never paints. The sweep + observer need a body, so they attach on
  // DOMContentLoaded when we're early.
  let hideActive = false;
  function applyHide() {
    if (hideActive) return;
    hideActive = true;
    window.Quell.injectCSS('quell-google', css);
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
  // drove us here. Only a live change may navigate the tab — doing it on load
  // would yank users mid-browse.
  function applyState(s, live) {
    if (!s.enabled || s.googleMode === 'off') {
      teardownHide();
      if (live) undoCleanWeb();
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
    ['enabled', 'googleMode'],
    (next) => applyState(next, true)
  );
  // Run at document_start — applyHide/applyCleanWeb both handle a missing
  // <body> themselves, and redirecting early avoids loading the AI page at all.
  applyState(await window.Quell.getSettings(), false);
})();
