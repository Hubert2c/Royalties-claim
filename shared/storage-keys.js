// =============================================================================
// storage-keys.js — separate browser storage keys for each portal
// -----------------------------------------------------------------------------
// Each portal keeps its own login, so being logged in to the artist portal does
// not log you in to the government console in the same browser.
// Works in the browser (window.PORTAL_STORAGE_KEYS) and in Node tests (require).
// =============================================================================
(function () {
  const STORAGE_KEYS = Object.freeze({
    government: Object.freeze({ token: 'royalty_gov_token', user: 'royalty_gov_user' }),
    rightsholder: Object.freeze({ token: 'royalty_artist_token', user: 'royalty_artist_user' }),
    licensee: Object.freeze({ token: 'royalty_licensee_token', user: 'royalty_licensee_user' })
  });

  if (typeof window !== 'undefined') window.PORTAL_STORAGE_KEYS = STORAGE_KEYS;
  if (typeof module !== 'undefined' && module.exports) module.exports = STORAGE_KEYS;
})();
