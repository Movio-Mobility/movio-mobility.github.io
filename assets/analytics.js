/*
 * Pageview beacon.
 *
 * First party, cookieless and deliberately dull. It reports the path, the referring host
 * and whether this is the first hit of the browsing session, and nothing else. No
 * identifier for the visitor is created, sent or stored, here or on the server, which is
 * why this needs no consent banner and why a leak of the resulting data would reveal
 * nothing about anyone.
 *
 * The session flag lives in sessionStorage, so it resets when the tab closes. That makes
 * "visitors" mean "browsing sessions", which is the honest reading of the number on the
 * dashboard.
 */
(() => {
  'use strict';

  const api = window.gridxApi;
  if (!api || !api.beacon) return;

  const KEY = 'gridx.seen';

  function firstOfSession() {
    try {
      if (sessionStorage.getItem(KEY)) return false;
      sessionStorage.setItem(KEY, '1');
      return true;
    } catch (_) {
      // Private mode, or storage blocked. Counting the hit but not the visitor is better
      // than losing both, and better than inventing an identifier to work around it.
      return false;
    }
  }

  function send() {
    api.beacon('/api/public/website/pageview', {
      path: location.pathname,
      // Only our own site's referrer is interesting; anything else is grouped by host
      // server side, and an empty string is reported as "direct".
      referrer: document.referrer || '',
      firstOfSession: firstOfSession(),
    });
  }

  // Wait for a real view. A prerendered or background tab has not been seen by anyone.
  if (document.visibilityState === 'hidden') {
    document.addEventListener('visibilitychange', function once() {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', once);
      send();
    });
  } else {
    send();
  }
})();
