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

  // After Quell hides something, the boxes that wrapped it can stay behind as
  // an empty strip (padding, min-height, a fixed-size frame): the Google AI
  // Overview left a 190-205 px blank band above the results. emptyAncestor()
  // walks up from a hidden element and returns the HIGHEST ancestor that now
  // has nothing visible in it (no visible text, image, video, canvas, input,
  // button or frame), stopping at `stop` and never passing one that holds
  // anything matching `safe` (an organic result, the search box). collapse()
  // then hides it the same way Quell hides anything, marked so the page's
  // Peek/Undo list can bring it back together with the element it wrapped.
  emptyAncestor(el, { stop = null, safe = '' } = {}) {
    const SAFE = ['input:not([type="hidden"])', 'textarea', '[role="search"]', safe].filter(Boolean).join(',');
    const MEDIA = 'img,video,canvas,iframe,object,embed,input:not([type="hidden"]),textarea,select,button,svg';
    const hasContent = (root) => {
      let budget = 3000;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            const cs = getComputedStyle(n);
            if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (--budget < 0) return true; // too big to judge: leave it alone
        if (n.nodeType === 3) {
          if (n.nodeValue.trim() && n.parentElement && n.parentElement.getClientRects().length) return true;
        } else if (n.matches(MEDIA)) {
          const r = n.getBoundingClientRect();
          if (r.width > 1 && r.height > 1) return true;
        }
      }
      return false;
    };
    let top = null;
    for (let cur = el.parentElement; cur && cur !== stop && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      if (cur.matches(SAFE) || cur.querySelector(SAFE)) break;
      if (hasContent(cur)) break;
      top = cur;
    }
    return top;
  },

  collapse(w, label) {
    if (!w || w.dataset.quellCollapsed === '1') return;
    w.dataset.quellCollapsed = '1';
    if (label) w.dataset.quellLabel = label;
    w.style.setProperty('display', 'none', 'important');
  },

  uncollapseAll() {
    for (const w of document.querySelectorAll('[data-quell-collapsed="1"]')) {
      w.style.removeProperty('display');
      delete w.dataset.quellCollapsed;
      delete w.dataset.quellLabel;
    }
  },

  // Tell the background how many AI elements we just removed (for the badge).
  report(n) {
    if (n > 0) {
      try { chrome.runtime.sendMessage({ type: 'blocked', count: n, feature: 'ai' }); } catch (_) { /* sw asleep */ }
    }
  },
};

// The popup's questions (which site this tab is on; what Quell hid here; Peek
// and Undo) are answered by the one listener in src/shared/settings.js. It
// answers Quell's own popup only, never a page, a tab or another extension.
globalThis.QuellSettings.hidden.listen();
