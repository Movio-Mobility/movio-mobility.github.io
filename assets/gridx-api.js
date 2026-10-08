/*
 * Where the site talks to Paddock.
 *
 * The base URL is a constant rather than something injected: the build (tools/build.mjs)
 * minifies and versions this file but never rewrites what it says, so the same file works
 * opened from disk, served by tools/serve.mjs, and deployed. A localhost override lets a
 * developer running Paddock (or tools/check/paddock-mock.mjs) on :3000 test against it
 * without editing this file and then having to remember to revert it.
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
 * Everything here is public by design and lives under /api/public/website/: orders and
 * orders/track, careers (read, apply, schedule), dealers, support, and the analytics
 * beacons (pageview, event, live). Nothing is a secret. The Razorpay key that reaches the
 * browser is the publishable key id, handed back by the order endpoint rather than
 * hardcoded, so rotating it is a server side change.
 *
 * THREE WAYS IN, ONE WAY OUT. getJSON reads, postJSON writes, postForm uploads (with
 * progress), and all three fail the same way: a thrown Error carrying
 *   .kind           'timeout' | 'offline' | 'aborted' | 'http'
 *   .status         the HTTP status, only when the server answered (kind 'http')
 *   .code           the server's machine-readable reason (body.code), e.g. 'duplicate'
 *   .fields         per-field messages for a 400 (body.fields)
 *   .retryAfterSec  how long a 429 asks to wait (body.retryAfterSec)
 *   .body           the server's whole answer, parsed (an empty object when there was none)
 * and describeError(err) turns any of them into a sentence fit to show a customer. A
 * timeout or a caller's cancel is also named 'AbortError', and anything that never reached
 * the server has no .status, which is what the older callers (track.js) test for.
 *
 * THIS REPOSITORY IS PUBLIC. The only values that may ever appear in it are ones that are
 * public by design:
 *   - Paddock's URL (above)
 *   - the reCAPTCHA Enterprise site key (below), which Google designs to be shown to browsers
 *   - the Razorpay key id, which is not even stored here: Paddock hands it over per order
 * Every secret (Razorpay's key secret and webhook secret, signing keys, passwords) lives in
 * Google Secret Manager behind Paddock, and nothing in the browser can reach it.
 */
(() => {
  'use strict';

  const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const BASE = LOCAL
    ? 'http://localhost:3000'
    : 'https://paddockgridx.app';

  // ---------------------------------------------------------------- errors
  // The words for failures that never got an answer from the server. Shared with
  // describeError() below, and also used as the thrown error's own message, so a caller that
  // just prints err.message (the order sheet, the configurator) shows a sentence rather than
  // the browser's "Failed to fetch" or "signal is aborted without reason".
  const SAY = {
    timeout: 'That took too long to come back. Please try again in a moment.',
    offline: 'Could not reach GridX. Check your connection and try again.',
    aborted: 'Cancelled. You can try again whenever you are ready.',
    server: 'Something went wrong on our side. Please try again in a moment.',
  };

  function failure(kind, extra = {}) {
    const err = new Error(extra.message || SAY[kind] || SAY.server);
    err.kind = kind;
    // A timeout and a cancel are both aborts; track.js tells them apart from a dropped
    // connection by this name, as it did when they were raw fetch errors.
    if (kind === 'timeout' || kind === 'aborted') err.name = 'AbortError';
    if (extra.status !== undefined) err.status = extra.status;
    err.code = extra.code;
    err.fields = extra.fields;
    err.retryAfterSec = extra.retryAfterSec;
    return err;
  }

  /** An answer from the server that was not a success, as the one error shape. */
  function httpFailure(status, data, retryHeader) {
    const body = data && typeof data === 'object' ? data : {};
    // The body says how long to wait (CORS hides Retry-After from scripts unless Paddock
    // exposes it, so the header is only a fallback).
    let retry = Number(body.retryAfterSec);
    if (!Number.isFinite(retry) && retryHeader) retry = Number(retryHeader);
    const err = failure('http', {
      status,
      message: typeof body.error === 'string' && body.error ? body.error : `Request failed (${status})`,
      code: typeof body.code === 'string' ? body.code : undefined,
      fields: body.fields && typeof body.fields === 'object' ? body.fields : undefined,
      retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
    // The whole answer, for the callers that need more than the shared fields: a duplicate
    // application's appliedAt, a closed role's openApplication, the fresh slots that come
    // back with an interview's slot_taken.
    err.body = body;
    return err;
  }

  /**
   * fetch with a deadline and an optional caller's signal, failing in the one shape.
   * Resolves the Response for any status: what counts as success is the caller's call.
   */
  async function send(url, init, timeoutMs, signal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const cancel = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', cancel, { once: true });
    }
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (_) {
      if (timedOut) throw failure('timeout');
      if (signal && signal.aborted) throw failure('aborted');
      throw failure('offline');
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
    }
  }

  async function postJSON(path, body, { timeoutMs = 20000, signal } = {}) {
    const res = await send(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs, signal);
    // 204 is a valid answer from the beacon and has no body to parse.
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw httpFailure(res.status, data, res.headers.get('Retry-After'));
    return data;
  }

  /**
   * A read. Credentials are omitted and no header is set, so the request stays CORS-simple
   * (no preflight) and the response is shareable by every visitor's cache.
   *
   * `cache` goes straight to fetch: 'no-cache' asks the browser to revalidate. Paddock's
   * GET routes answer with an ETag, so the browser's HTTP cache sends If-None-Match by
   * itself and turns a 304 into the stored 200 before this code sees it. Never set
   * If-None-Match here by hand: it is not a CORS-safelisted header, so it would cost every
   * read a preflight, and the browser would hand a bare 304 back with no body.
   */
  async function getJSON(path, { timeoutMs = 15000, cache, signal } = {}) {
    const res = await send(`${BASE}${path}`, {
      method: 'GET',
      credentials: 'omit',
      mode: 'cors',
      cache,
    }, timeoutMs, signal);
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (!res.ok) throw httpFailure(res.status, data, res.headers.get('Retry-After'));
    // A success that is not JSON is a proxy's error page or a captive portal, not an answer.
    if (data === null || typeof data !== 'object') {
      throw failure('http', { status: res.status, code: 'invalid_response', message: SAY.server });
    }
    return data;
  }

  /**
   * An upload: multipart, with progress. XMLHttpRequest rather than fetch, because fetch
   * still cannot report how much of a request body has gone up, and a ten megabyte resume
   * on a phone's uplink is exactly when someone needs to see that it is moving.
   *
   * onProgress gets { loaded, total, phase: 'upload' } as the body goes up (total is 0 when
   * the browser cannot tell), then { phase: 'server' } once it is all sent and the server is
   * working on it. Listening for upload progress makes the request preflighted (a plain form
   * post would not be), which Paddock answers like any other.
   *
   * withCredentials stays false, as fetch's credentials: 'omit' does elsewhere: these are
   * public routes, and nothing here should ever carry a cookie to them. The Content-Type is
   * left to the browser, which is the only thing that knows the multipart boundary.
   *
   * Resolves the parsed JSON on 2xx; rejects in the shared error shape otherwise.
   */
  function postForm(path, formData, { timeoutMs = 120000, onProgress, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(failure('aborted'));
        return;
      }
      const xhr = new XMLHttpRequest();
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', cancel);
        fn(value);
      };
      const cancel = () => xhr.abort();

      xhr.open('POST', `${BASE}${path}`);
      xhr.withCredentials = false;
      xhr.timeout = timeoutMs;
      xhr.responseType = 'text';
      if (typeof onProgress === 'function') {
        const tell = (detail) => {
          try { onProgress(detail); } catch (_) { /* a progress bar must never fail the upload */ }
        };
        xhr.upload.onprogress = (event) => tell({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
          phase: 'upload',
        });
        xhr.upload.onload = () => tell({ phase: 'server' });
      }

      xhr.onload = () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch (_) {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (data === null || typeof data !== 'object') {
            done(reject, failure('http', { status: xhr.status, code: 'invalid_response', message: SAY.server }));
          } else {
            done(resolve, data);
          }
          return;
        }
        let retryHeader = null;
        try { retryHeader = xhr.getResponseHeader('Retry-After'); } catch (_) { /* not exposed */ }
        done(reject, httpFailure(xhr.status, data, retryHeader));
      };
      xhr.ontimeout = () => done(reject, failure('timeout'));
      xhr.onerror = () => done(reject, failure('offline'));
      xhr.onabort = () => done(reject, failure('aborted'));

      if (signal) signal.addEventListener('abort', cancel, { once: true });
      xhr.send(formData);
    });
  }

  /**
   * One sentence for a customer, for any error the three calls above throw, in the voice of
   * order tracking (track.js): what happened, and what to do, never the browser's wording.
   *
   * `context` is optional: a string is the fallback for a server answer that carried no
   * message of its own; an object can carry { fallback }. A 429 says how long to wait, from
   * the server's retryAfterSec; any other answer from the server is shown as it was sent,
   * because the server owns those words (and some, like order tracking's, are deliberately
   * the same whatever went wrong).
   */
  function describeError(err, context) {
    const fallback = typeof context === 'string' ? context : (context && context.fallback) || '';
    if (!err) return fallback || SAY.server;
    if (err.kind === 'aborted') return SAY.aborted;
    if (err.kind === 'timeout' || err.name === 'AbortError') return SAY.timeout;
    if (err.status === undefined) return SAY.offline;
    if (err.status === 429) {
      const sec = Number(err.retryAfterSec);
      if (!Number.isFinite(sec) || sec <= 0) return 'Too many tries for now. Please wait a little and try again.';
      const minutes = Math.max(1, Math.ceil(sec / 60));
      return `Too many tries for now. Please wait ${minutes === 1 ? 'a minute' : `${minutes} minutes`} and try again.`;
    }
    const own = err.message && !/^Request failed \(\d+\)$/.test(err.message) ? err.message : '';
    if (own) return own;
    if (fallback) return fallback;
    return SAY.server;
  }

  /**
   * Fire and forget. Used by the analytics beacons (pageview, event, live), which nobody is
   * waiting on.
   *
   * Sent as text/plain JSON, which keeps the request CORS-simple: a POST whose Content-Type
   * is text/plain, with no other custom header, goes straight out with no OPTIONS preflight
   * ahead of it. The body is still JSON, and Paddock reads it as text and parses it. That
   * halves the requests every page view costs, and means a beacon fired on the way out of a
   * page is one request that keepalive can carry rather than two it has to sequence.
   *
   * Deliberately NOT navigator.sendBeacon. sendBeacon always sends in credentialed mode,
   * which cross-origin obliges the server to answer with
   * Access-Control-Allow-Credentials: true. That would mean opening a public, unauthenticated
   * write endpoint to credentialed requests purely to count pageviews, which is a worse
   * trade than it looks. A keepalive fetch with credentials omitted does the same job: it
   * survives the page unloading, which is the one thing sendBeacon is for.
   */
  function beacon(path, body) {
    try {
      fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body),
        keepalive: true,
        mode: 'cors',
        credentials: 'omit',
      }).catch(() => {});
    } catch (_) { /* analytics must never break a page */ }
  }

  /**
   * Razorpay's checkout script, loaded the first time something asks for it. Pages call this
   * as soon as a purchase looks likely (an order sheet opening, the configurator being used),
   * so it has normally arrived long before Pay is pressed, and openCheckout() waits for it in
   * case it has not. It used to load with every page view on five pages: a third-party script,
   * its own requests and its parse cost, for the few visits that end in a payment.
   * Resolves either way; a failed load leaves window.Razorpay unset, which checkout reports.
   */
  let razorpay = null;
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (!razorpay) {
      razorpay = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = 'https://checkout.razorpay.com/v1/checkout.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          razorpay = null; // let a later attempt try again
          resolve();
        };
        document.head.appendChild(s);
      });
    }
    return razorpay;
  }

  /**
   * reCAPTCHA Enterprise, which Paddock asks Google about before it creates an order, so a
   * script cannot fill Razorpay with junk orders. The site key is public by design and
   * restricted to gridxenergy.in in Google Cloud. Empty means not set up yet: the order is
   * sent without a token, and Paddock only lets that through while it is not enforcing.
   */
  const RECAPTCHA_SITE_KEY = '';

  let recaptcha = null;
  function loadRecaptcha() {
    if (!RECAPTCHA_SITE_KEY) return Promise.resolve();
    if (window.grecaptcha && window.grecaptcha.enterprise) return Promise.resolve();
    if (!recaptcha) {
      recaptcha = new Promise((resolve) => {
        const s = document.createElement('script');
        s.src = `https://www.google.com/recaptcha/enterprise.js?render=${encodeURIComponent(RECAPTCHA_SITE_KEY)}`;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          recaptcha = null; // let a later attempt try again
          resolve();
        };
        document.head.appendChild(s);
      });
    }
    return recaptcha;
  }

  /**
   * A fresh token for one action, or null when there is none to be had (not set up, blocked
   * by an extension, offline). Never throws and never waits more than a few seconds: Paddock
   * decides what a missing token means, not the page.
   */
  async function recaptchaToken(action) {
    if (!RECAPTCHA_SITE_KEY) return null;
    await loadRecaptcha();
    const g = window.grecaptcha && window.grecaptcha.enterprise;
    if (!g) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      g.ready(() => {
        g.execute(RECAPTCHA_SITE_KEY, { action }).then(
          (token) => { clearTimeout(timer); resolve(token || null); },
          () => { clearTimeout(timer); resolve(null); },
        );
      });
    });
  }

  /*
   * Event calls made before analytics.js has loaded. It is deferred, so a script reacting to
   * an early tap (or a sheet opened from a link) can call gridTrack before it exists. Until
   * then this stub queues each call with the page and the time it happened; analytics.js
   * drains window.gridTrack.q when it takes over, so nothing said early is lost and nothing
   * has to check whether analytics has arrived. A stub analytics.js has already replaced is
   * left alone.
   */
  window.gridTrack = window.gridTrack || function () {
    (window.gridTrack.q = window.gridTrack.q || []).push([arguments[0], arguments[1], location.pathname, Date.now()]);
  };

  window.gridxApi = {
    BASE,
    getJSON,
    postJSON,
    postForm,
    describeError,
    beacon,
    loadRazorpay,
    loadRecaptcha,
    recaptchaToken,
  };
})();
