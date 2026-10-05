/*
 * Where the site talks to Paddock.
 *
 * This is a static site with no build step, so there is no environment variable to
 * inject: the base URL is a constant, with a localhost override so a developer running
 * Paddock on :3000 does not have to edit and then remember to revert this file.
 *
 * TWO DIFFERENT DOMAINS, on purpose:
 *
 *   gridxenergy.in     this site. What a customer types and what they always open.
 *   paddockgridx.app   Paddock, the staff app and the API behind this site. A separate
 *                      domain on a separate GCP project (gridxenergy-production), fronted
 *                      by a load balancer because Cloud Run domain mapping is not
 *                      available in asia-south1.
 *
 * So every call from here is CROSS ORIGIN and depends on Paddock's CORS allowlist.
 * WEBSITE_ALLOWED_ORIGINS on Paddock must contain this site's exact origin, scheme and
 * all, or the browser refuses the preflight and nothing reaches the server. Unset means
 * same-origin only, which is the safe default and also means "the site cannot order".
 *
 * A same-origin setup would be preferable and is not available: Firebase Hosting can
 * rewrite a path to Cloud Run only within its own project, and Paddock is in another one.
 *
 * Only two endpoints exist and both are public by design. Nothing here is a secret. The
 * Razorpay key that reaches the browser is the publishable key id, handed back by the
 * order endpoint rather than hardcoded, so rotating it is a server side change.
 */
(() => {
  'use strict';

  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const BASE = LOCAL
    ? 'http://localhost:3000'
    : 'https://paddockgridx.app';

  async function postJSON(path, body, { timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // 204 is a valid answer from the beacon and has no body to parse.
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.fields = data.fields;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fire and forget. Used by the pageview beacon, which nobody is waiting on.
   *
   * Deliberately NOT navigator.sendBeacon. sendBeacon always sends in credentialed mode,
   * which cross-origin obliges the server to answer with
   * Access-Control-Allow-Credentials: true. That would mean opening a public, unauthenticated
   * write endpoint to credentialed requests purely to count pageviews, which is a worse
   * trade than it looks.
   *
   * keepalive fetch with credentials omitted does the same job here. sendBeacon's real
   * advantage is surviving unload, and this beacon fires on load, so there is nothing to
   * survive.
   */
  function beacon(path, body) {
    try {
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
      }).catch(() => {});
    } catch (_) { /* analytics must never break a page */ }
  }

  window.gridxApi = { BASE, postJSON, beacon };
})();
