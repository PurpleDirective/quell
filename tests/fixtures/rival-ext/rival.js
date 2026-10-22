// A deliberately ADVERSARIAL co-installed extension, modelled on what real
// blockers do: inject a stylesheet, run a MutationObserver, and mutate the DOM
// in response to mutations. The last part is what can ping-pong with another
// extension's observer, so this is the shape most likely to expose a conflict.
//
// The mutation counter is published to the shared DOM, NOT to `window`: each
// extension gets its own isolated world, so a counter on `window` is invisible
// to the test and the assertion reading it can never fail. That is exactly how
// the first version of this fixture produced a vacuous skip.
(() => {
  const COUNT_ATTR = 'data-rival-mutations';
  let count = 0;

  const style = document.createElement('style');
  style.id = 'rival-style';
  style.textContent = '.rival-hidden{display:none !important;}';
  (document.head || document.documentElement).appendChild(style);

  const publish = () => { document.documentElement.setAttribute(COUNT_ATTR, String(count)); };

  const attach = () => {
    // Rival marks its own territory, re-applying on any mutation exactly like a
    // real blocker re-sweeping.
    const sweep = () => {
      for (const el of document.querySelectorAll('#rso .MjjYud')) {
        if (el.dataset.rivalSeen !== '1') el.dataset.rivalSeen = '1';
      }
    };
    sweep();
    publish();

    const obs = new MutationObserver((records) => {
      // Ignore our OWN counter write, or the observer feeds itself forever and
      // the test measures the fixture rather than the interaction.
      const real = records.filter((r) => !(
        r.type === 'attributes' &&
        r.target === document.documentElement &&
        r.attributeName === COUNT_ATTR
      ));
      if (!real.length) return;
      count += real.length;
      sweep();
      publish();
    });
    // Subtree + attributes: the greedy configuration, most likely to loop.
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  };

  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });
})();
