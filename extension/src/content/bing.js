// Quell — Bing Search surface. Hides the Copilot sidebar / entry points.
// CSS does the hiding; a light sweep counts what was hidden for the badge.

(async () => {
  const s = await window.Quell.getSettings();
  if (!s.enabled || !s.bingEnabled) return;

  const SELECTORS = [
    '#b_sydConvCont',
    '.b_sydConvVisible',
    '[aria-label*="Copilot" i]',
    'a[href*="copilot.microsoft.com"]',
    'a[href*="bing.com/chat"]',
    '.cibsbserp',
    '#codex-bnp',
  ];
  window.Quell.injectCSS('quell-bing', SELECTORS.join(',') + '{display:none!important;}');

  // Count hidden elements (once each) so the badge reflects Bing too.
  function sweep() {
    let hidden = 0;
    for (const el of document.querySelectorAll(SELECTORS.join(','))) {
      if (el.dataset.quellSeen !== '1') {
        el.dataset.quellSeen = '1';
        hidden++;
      }
    }
    window.Quell.report(hidden);
  }

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
