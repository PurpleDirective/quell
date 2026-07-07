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

  // Tell the background how many AI elements we just removed (for the badge).
  report(n) {
    if (n > 0) {
      try { chrome.runtime.sendMessage({ type: 'blocked', count: n }); } catch (_) { /* sw asleep */ }
    }
  },
};
