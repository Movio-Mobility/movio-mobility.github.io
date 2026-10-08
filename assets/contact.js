/*
 * Contact us: whether anyone is there right now.
 *
 * The hours are in the HTML for everyone. This adds one line above them, worked out in India's
 * time whatever the reader's own clock says, so someone abroad, or on a phone set to another
 * zone, is told about GridX's day rather than their own. It does not know about public
 * holidays, and neither do the hours printed under it.
 *
 * The arithmetic is assets/hours.js (window.gridHours), shared with the dealer cards; this file
 * only keeps its own words. A page should load hours.js before this; one that does not gets it
 * fetched here, once, so the line never silently goes missing.
 *
 * Not an aria-live region: the line changes at most twice a day, and a screen reader should
 * not be interrupted to hear it.
 */
(() => {
  'use strict';

  const status = document.getElementById('contact-status');
  if (!status) return;

  // GridX's own hours, as printed beside the line: Monday to Friday, 11 AM to 6 PM.
  const WEEKDAY = [['11:00', '18:00']];
  const HOURS = { mon: WEEKDAY, tue: WEEKDAY, wed: WEEKDAY, thu: WEEKDAY, fri: WEEKDAY, sat: [], sun: [] };

  function line(H, now) {
    const s = H.state(HOURS, now);
    if (s.open) return { open: true, text: `Open now, until ${H.clock(s.closesAt)}` };
    // Closed: the next working morning, as today, tomorrow or its weekday.
    const { ahead, day, time } = s.opensAt;
    const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : H.LONG[day];
    return { open: false, text: `Closed now, opens ${when} at ${H.clock(time)}` };
  }

  function start(H) {
    let timer = 0;
    function tick() {
      const { open, text } = line(H, new Date());
      status.textContent = text;
      status.classList.toggle('is-open', open);
      status.hidden = false;
      // Again on the next minute, and at once when the tab comes back from the background,
      // where timers are slowed and the line could have gone stale.
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    tick();
  }

  if (window.gridHours) {
    start(window.gridHours);
    return;
  }
  const script = document.createElement('script');
  script.src = 'assets/hours.js';
  script.onload = () => { if (window.gridHours) start(window.gridHours); };
  document.head.appendChild(script);
})();
