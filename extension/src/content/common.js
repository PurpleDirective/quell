// Quell — shared content-script helpers, loaded before each per-surface script.
// Multiple content-script files share one isolated world, so this object is
// visible to google.js / bing.js. Guard against double-injection.

window.Quell = window.Quell || {
  // Settings live in src/shared/settings.js (loaded first). DEFAULTS is kept
  // here as an alias because every surface script reads it through Quell.
  DEFAULTS: globalThis.QuellSettings.DEFAULTS,

  getSettings() {
    return globalThis.QuellSettings.get();
  },

  // Keep-AI-on-this-site: the per-site pause for every AI surface.
  aiPaused(s) {
    return (s.aiAllowlist || []).includes(location.hostname);
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

  // Re-run `cb(settings)` whenever any of `keys` changes (storage.sync for
  // choices, storage.local for grant-bound switches). This is what makes a
  // popup toggle affect the page the user is ALREADY looking at. Without it
  // every toggle silently needed a reload, which reads as "the extension
  // doesn't work" — the top cause of 1-star reviews in this niche (see
  // store/COMPETITIVE-LANDSCAPE §backlog 2).
  onSettingsChange(keys, cb) {
    globalThis.QuellSettings.onChange(keys, cb);
  },

  // Run cb() once if this copy of Quell loses its extension (an update, or
  // Quell switched off or removed in the browser) — see settings.js.
  onGone(cb) {
    globalThis.QuellSettings.onGone(cb);
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

// The popup asks which site this tab is on. Quell's access to Google and Bing
// is content-script access only, and Chrome does not show the popup a tab's
// address on that kind of access — so without this the popup said "Quell
// doesn't run on this page" on the very pages it runs on, and the This-site
// card never appeared there. The answer is the hostname and nothing else, and
// it goes to Quell's own popup only (a page cannot send this message).
if (!window.__quellWhere) {
  window.__quellWhere = true;
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'where' && sender.id === chrome.runtime.id && !sender.tab) {
        sendResponse({ host: location.hostname });
      }
    });
  } catch (_) { /* not an extension context (tests inject this file into a plain page) */ }
}
