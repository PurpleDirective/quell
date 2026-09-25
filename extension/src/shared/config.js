// Quell — operator-editable constants. Change them here and nowhere else.
//
// REPORT_ENDPOINT receives the "This site looks broken" report: a POST whose
// body is exactly {"host": "<hostname>", "version": "<Quell version>"} and
// nothing more. The server side lives in products/Quell/server/report-worker
// (deploy notes in its README). The request is a CORS "simple request"
// (text/plain body), so no host permission is needed to make it.
globalThis.QUELL_CONFIG = Object.freeze({
  REPORT_ENDPOINT: 'https://purpledirective.com/api/quell/report',
  PRIVACY_URL: 'https://purpledirective.com/quell/privacy/',
  // Where "Rate Quell" points, per store. Firefox's AMO listing does not exist
  // yet (submission is the operator's step): null hides the link on Firefox
  // rather than pointing at a page that is not there. Fill it in after AMO
  // publishes the listing.
  RATE_URL_CHROME: 'https://chromewebstore.google.com/detail/hipifmmjmbnkhfajkbmcjkajlfjiehho',
  RATE_URL_FIREFOX: null,
  FEEDBACK_MAILTO: 'mailto:support@purpledirective.com?subject=Quell%20feedback',
});
