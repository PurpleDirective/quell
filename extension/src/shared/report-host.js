// Quell — which hostnames a breakage report may name. The popup uses this to
// decide whether to offer the button at all; the report Worker
// (server/report-worker/src/index.js) enforces the SAME rule. The three
// constants below are copied there verbatim, and
// server/report-worker/test.mjs fails if the two copies ever differ in text
// or in behaviour.
//
// A public DNS hostname: labels of [a-z0-9-] (no underscores, no leading or
// trailing hyphen), ≤253 chars, at least two labels, and a TLD that is letters
// or punycode — so no IP literals and no "localhost". Private-network and
// special-use names are refused: they say something about the user's own
// network, not about a public site Quell could have broken.
(() => {
  const g = globalThis;
  if (g.QuellReportHost) return;
  const LABEL = '(?!-)[a-z0-9-]{1,63}(?<!-)';
  const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`);
  const PRIVATE_SUFFIXES = ['.local', '.localhost', '.internal', '.lan', '.home.arpa', '.test', '.example', '.invalid', '.onion'];
  g.QuellReportHost = {
    valid(h) {
      if (typeof h !== 'string' || !HOST_RE.test(h)) return false;
      return !PRIVATE_SUFFIXES.some((s) => h === s.slice(1) || h.endsWith(s));
    },
  };
})();
