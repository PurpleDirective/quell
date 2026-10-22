// Quell — operator-editable constants. Change them here and nowhere else.
//
// REPORT_ENDPOINT receives the "This site looks broken" report: a POST whose
// body is exactly {"host": "<hostname>", "version": "<Quell version>"} and
// nothing more. The server side lives in server/report-worker
// (deploy notes in its README). The request is a CORS "simple request"
// (text/plain body), so no host permission is needed to make it.
globalThis.QUELL_CONFIG = Object.freeze({
  REPORT_ENDPOINT: 'https://purpledirective.com/api/quell/report',
  PRIVACY_URL: 'https://purpledirective.com/quell/privacy/',
  // Where "Rate Quell" points, per store. The Opera listing is not public yet
  // (in review): null hides the link on that browser rather than pointing at
  // a page that is not there, or at another browser's store. Fill it in once
  // the listing publishes. (The Firefox listing went public at 0.7.0.)
  RATE_URL_CHROME: 'https://chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho',
  RATE_URL_FIREFOX: 'https://addons.mozilla.org/firefox/addon/quell-quiet-the-web/',
  RATE_URL_OPERA: null,
  // Edge installs the Chrome package from the Microsoft Edge Add-ons site. Not
  // listed yet: null hides the link on Edge, same as Opera. Fill in on publish.
  RATE_URL_EDGE: null,
  FEEDBACK_MAILTO: 'mailto:support@purpledirective.com?subject=Quell%20feedback',
  // Plain link, same on every browser/store. No nag, no install-time prompt —
  // just a footer link a user can choose to follow.
  SPONSOR_URL: 'https://github.com/sponsors/PurpleDirective',
});
