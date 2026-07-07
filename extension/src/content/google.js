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
    if (url.searchParams.get('udm') !== '14') {
      url.searchParams.set('udm', '14');
      location.replace(url.toString());
    }
    return;
  }

  // --- hide mode ---

  // Maintainable selector list (the part the Phase 2 pipeline keeps fresh).
  // BLOCK_CSS entries are whole AI blocks — they're also counted for the badge.
  const BLOCK_CSS = 'div[data-attrid="AIOverview" i], div[aria-label="AI Overview" i], .M8OgIe, .YzCcne';
  const css = `
    ${BLOCK_CSS},
    [data-hveid] [aria-label*="AI Overview" i],
    a[href*="gemini.google.com"],
    [aria-label*="Gemini" i] { display: none !important; }
  `;
  window.Quell.injectCSS('quell-google', css);

  // Text-resilient pass — anchors on the human-readable label, not class names.
  const LABELS = ['ai overview', 'ai mode', 'generative ai', 'search with ai'];
  const BLOCK_SEL = '#rso > div, #center_col > div, [data-hveid], .MjjYud, .ULSxyf, .hlcw0c';

  function sweep() {
    let hidden = 0;

    // Count what the CSS layer already hid (once per element).
    for (const el of document.querySelectorAll(BLOCK_CSS)) {
      if (el.dataset.quellSeen !== '1') {
        el.dataset.quellSeen = '1';
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
        hidden++;
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
