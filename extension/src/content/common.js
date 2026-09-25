// Quell — shared content-script helpers, loaded before each per-surface script.
// Multiple content-script files share one isolated world, so this object is
// visible to google.js / bing.js. Guard against double-injection.

window.Quell = window.Quell || {
  // Per-surface AI switches (Phase 1, 2026-09-10). `hidePaa` defaults to
  // FALSE on purpose: a People-Also-Ask answer is AI the user clicked to see,
  // and Google renders it as the same object as an unsolicited AI Overview.
  // Suppressing what someone explicitly asked for is what earns "this
  // extension broke Google" reviews. chrome.storage.local.get(DEFAULTS) fills
  // missing keys, so existing installs pick these up without a migration.
  DEFAULTS: {
    enabled: true,
    googleMode: 'hide',
    hideOverview: true,
    hideAiMode: true,
    hidePaa: false,
    hideGemini: true,
    bingEnabled: true,
    // Bing's suggestion chips carry a real related-search query, so they get
    // their own switch — default FALSE, same reasoning as hidePaa above.
    hideBingChips: false,
    // Per-engine mode: 'off' | 'hide' | 'clean'. 'clean' flips the engine's own
    // no-AI query parameter, which is selector-proof — but it does so by
    // REDIRECTING the page, and a redirect is not something to impose on
    // someone who never asked for it. So 'hide' is the default everywhere and
    // 'clean' is a deliberate choice, listed first because it is the most
    // reliable mode once chosen. Yahoo publishes no such parameter at all.
    ddgMode: 'hide',
    braveMode: 'hide',
    yahooMode: 'hide',
    // Reject-all is opt-in: hiding a banner leaves the choice unmade, while
    // rejecting makes one on the user's behalf.
    cookieReject: false,
    totalBlocked: 0,
  },

  async getSettings() {
    return chrome.storage.local.get(this.DEFAULTS);
  },

  // Inject a <style> as early as possible — works even at document_start,
  // before <head> exists, by falling back to <html>.
  injectCSS(id, css) {
    if (document.getElementById(id)) return;
    const root = document.head || document.documentElement;
    // Retry rather than throw when there is nothing to attach to yet. Chrome's
    // document_start guarantees a documentElement, but scripts injected via
    // executeScript into an open tab make no such promise, and an exception
    // here aborts the caller mid-apply.
    if (!root) {
      // Bounded — a document that never regains a root must not spin forever.
      this._cssRetries = (this._cssRetries || 0) + 1;
      if (this._cssRetries > 50) return;
      setTimeout(() => this.injectCSS(id, css), 0);
      return;
    }
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    root.appendChild(style);
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
