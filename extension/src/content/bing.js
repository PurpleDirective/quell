// Quell — Bing Search surface. Hides the Copilot sidebar / entry points.
// CSS does the hiding; a light sweep counts what was hidden for the badge.
// Applies live: toggling Bing in the popup takes effect without a reload.

(async () => {
  const SELECTORS = [
    '#b_sydConvCont',
    '.b_sydConvVisible',
    '[aria-label*="Copilot" i]',
    'a[href*="copilot.microsoft.com"]',
    'a[href*="bing.com/chat"]',
    '.cibsbserp',
    '#codex-bnp',
  ];
  const SEL = SELECTORS.join(',');

  // Count hidden elements (once each) so the badge reflects Bing too. The
  // seen-flags survive teardown so a toggle off/on doesn't re-inflate the
  // lifetime counter on the same page.
  function sweep() {
    let hidden = 0;
    for (const el of document.querySelectorAll(SEL)) {
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

  // CSS at document_start so the Copilot panel never paints; sweep/observer
  // attach once there's a body.
  let active = false;
  function apply() {
    if (active) return;
    active = true;
    window.Quell.injectCSS('quell-bing', SEL + '{display:none!important;}');
    const attach = () => {
      if (!active || observer) return;
      sweep();
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach, { once: true });
  }

  // Bing hides purely via stylesheet — no inline styles to restore, so
  // dropping the <style> is a complete undo.
  function teardown() {
    active = false;
    if (observer) { observer.disconnect(); observer = null; }
    window.Quell.removeCSS('quell-bing');
  }

  const applyState = (s) => (s.enabled && s.bingEnabled ? apply() : teardown());

  // Subscribe before the first async read — see the note in google.js.
  window.Quell.onSettingsChange(['enabled', 'bingEnabled'], applyState);
  applyState(await window.Quell.getSettings());
})();
