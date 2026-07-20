// Quell — Google Search surface.
// Two strategies:
//   'cleanweb' — append udm=14 to force Google's classic web results (zero AI,
//                selector-proof, never breaks).
//   'hide'     — surgically remove AI Overview / AI Mode blocks and keep the
//                rest of Google. Uses a maintainable selector list PLUS a
//                text-resilient pass (find the "AI Overview" label, hide its
//                block) so it survives most markup churn.

(async () => {
  const s = await window.Quell.getSettings();
  if (!s.enabled || s.googleMode === 'off') return;

  if (s.googleMode === 'cleanweb') {
    const url = new URL(location.href);
    // Rewrite only the default results page (no udm/tbm) and Google's AI Mode
    // (udm=50). Images/News/Videos/Shopping carry their own udm (or legacy
    // tbm) — redirecting those too would make every vertical unreachable.
    const udm = url.searchParams.get('udm');
    if ((udm === null || udm === '50') && !url.searchParams.has('tbm')) {
      url.searchParams.set('udm', '14');
      location.replace(url.toString());
    }
    return;
  }

  // --- hide mode ---

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
  window.Quell.injectCSS('quell-google', css);

  // Text-resilient pass — anchors on the human-readable label, not class names.
  const LABELS = ['ai overview', 'ai mode', 'generative ai', 'search with ai'];
  const BLOCK_SEL = '#rso > div, #center_col > div, [data-hveid], .MjjYud, .ULSxyf, .hlcw0c';

  // One counted-flag shared by BOTH passes — a block matching BLOCK_CSS whose
  // label also matches must increment the badge once, not twice (self,
  // ancestor, or descendant already counted all mean "same block").
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
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sweep(); });
  };

  function start() {
    sweep();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
