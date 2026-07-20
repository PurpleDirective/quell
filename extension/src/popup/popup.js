// Quell — popup controller. Reads/writes settings in chrome.storage.local;
// the background worker reacts to storage changes (rulesets, script registration).

const DEFAULTS = {
  enabled: true,
  googleMode: 'hide',
  bingEnabled: true,
  cookieEnabled: false,
  cookieAllowlist: [],
  totalBlocked: 0,
};
const $ = (id) => document.getElementById(id);

const hasChrome = typeof chrome !== 'undefined' && chrome.runtime;

// Use chrome.storage when running as a real extension; fall back to defaults
// when the popup is opened outside an extension context (e.g. a preview).
const store = (hasChrome && chrome.storage?.local)
  ? chrome.storage.local
  : { get: async (d) => d, set: async () => {} };

// Hostname of the active tab — readable only while we hold host access
// (i.e. the Cookie-banners feature is on), which is exactly when we need it.
async function currentHost() {
  if (!hasChrome || !chrome.tabs) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  try {
    const u = new URL(tab?.url || '');
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch (_) { return null; }
}

// The per-site pause row is shown only when the cookie feature is on AND the
// active tab is a normal website.
async function renderSiteRow(s) {
  const row = $('siteRow');
  if (!row) return;
  const host = s.cookieEnabled ? await currentHost() : null;
  if (!host) { row.hidden = true; return; }
  row.hidden = false;
  $('siteHost').textContent = host;
  $('siteAllow').checked = (s.cookieAllowlist || []).includes(host);
  $('siteAllow').dataset.host = host;
}

// The AI-features section badge must reflect reality: it was a static
// "Active" that kept lying with the master switch off (or every AI feature
// individually off).
function renderAiState(s) {
  const badge = $('aiState');
  if (!badge) return;
  const active = s.enabled && (s.googleMode !== 'off' || s.bingEnabled);
  badge.textContent = active ? 'Active' : 'Off';
  badge.classList.toggle('on', active);
}

async function refreshAiState() {
  renderAiState(await store.get(DEFAULTS));
}

async function load() {
  const s = await store.get(DEFAULTS);
  $('enabled').checked = s.enabled;
  $('stateLabel').textContent = s.enabled ? 'on' : 'off';
  for (const r of document.querySelectorAll('input[name="gmode"]')) {
    r.checked = r.value === s.googleMode;
  }
  $('bing').checked = s.bingEnabled;
  if ($('cookies')) $('cookies').checked = s.cookieEnabled;
  $('total').textContent = Number(s.totalBlocked).toLocaleString();
  renderAiState(s);
  await renderSiteRow(s);
}

$('enabled').addEventListener('change', (e) => {
  store.set({ enabled: e.target.checked }).then(refreshAiState);
  $('stateLabel').textContent = e.target.checked ? 'on' : 'off';
});

for (const r of document.querySelectorAll('input[name="gmode"]')) {
  r.addEventListener('change', () => store.set({ googleMode: r.value }).then(refreshAiState));
}

$('bing').addEventListener('change', (e) => {
  store.set({ bingEnabled: e.target.checked }).then(refreshAiState);
});

// Cookie banners — needs all-sites access for the cosmetic layer, so we request
// it on the user's click (a gesture) and only enable on grant. The background
// picks the change up via storage.onChanged.
const cookies = $('cookies');
if (cookies) {
  cookies.addEventListener('change', async (e) => {
    if (!hasChrome) return; // preview context — no-op
    if (e.target.checked) {
      const granted = await chrome.permissions
        .request({ origins: ['<all_urls>'] })
        .catch(() => false);
      if (!granted) { e.target.checked = false; return; }
      await store.set({ cookieEnabled: true });
    } else {
      await store.set({ cookieEnabled: false });
    }
    await renderSiteRow(await store.get(DEFAULTS));
  });
}

// Per-site pause — the breakage escape hatch for the beta cookie feature.
const siteAllow = $('siteAllow');
if (siteAllow) {
  siteAllow.addEventListener('change', async (e) => {
    const host = e.target.dataset.host;
    if (!host) return;
    const { cookieAllowlist } = await store.get({ cookieAllowlist: [] });
    const next = e.target.checked
      ? [...new Set([...cookieAllowlist, host])]
      : cookieAllowlist.filter((h) => h !== host);
    await store.set({ cookieAllowlist: next });
  });
}

load();
