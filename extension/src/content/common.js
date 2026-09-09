// Quell — shared content-script helpers, loaded before each per-surface script.
// Multiple content-script files share one isolated world, so this object is
// visible to google.js / bing.js. Guard against double-injection.

window.Quell = window.Quell || {
  DEFAULTS: { enabled: true, googleMode: 'hide', bingEnabled: true, totalBlocked: 0 },

  async getSettings() {
    return chrome.storage.local.get(this.DEFAULTS);
  },

  // Inject a <style> as early as possible — works even at document_start,
  // before <head> exists, by falling back to <html>.
  injectCSS(id, css) {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  },

  // Counterpart to injectCSS — lets a surface undo its own hiding when the
  // user turns a feature off, without a page reload.
  removeCSS(id) {
    document.getElementById(id)?.remove();
  },

  // Re-run `cb(settings)` whenever any of `keys` changes in storage.local.
  // This is what makes a popup toggle affect the page the user is ALREADY
  // looking at. Without it every toggle silently needed a reload, which reads
  // as "the extension doesn't work" — the top cause of 1-star reviews in this
  // niche (see store/COMPETITIVE-LANDSCAPE §backlog 2).
  onSettingsChange(keys, cb) {
    if (!chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!keys.some((k) => k in changes)) return;
      this.getSettings().then(cb).catch(() => {});
    });
  },

  // Coalesce mutation bursts into one sweep per frame. requestAnimationFrame
  // is the right pacing while the tab is visible, but it does NOT fire at all
  // in a hidden tab — which would defer the text-resilient pass and the badge
  // count indefinitely for anything opened in a background tab. Fall back to a
  // macrotask there so background tabs still settle.
  nextTick(fn) {
    if (document.hidden) setTimeout(fn, 0);
    else requestAnimationFrame(fn);
  },

  // Tell the background how many AI elements we just removed (for the badge).
  report(n) {
    if (n > 0) {
      try { chrome.runtime.sendMessage({ type: 'blocked', count: n }); } catch (_) { /* sw asleep */ }
    }
  },
};
