/*
 * Contact us: whether anyone is there right now.
 *
 * The hours are in the HTML for everyone. This adds one line above them, worked out in India's
 * time whatever the reader's own clock says, so someone abroad, or on a phone set to another
 * zone, is told about GridX's day rather than their own. It does not know about public
 * holidays, and neither do the hours printed under it.
 *
 * Not an aria-live region: the line changes at most twice a day, and a screen reader should
 * not be interrupted to hear it.
 */
(() => {
  'use strict';

  const status = document.getElementById('contact-status');
  if (!status) return;

  const OPEN = 11 * 60;  // 11 AM, in minutes
  const CLOSE = 18 * 60; // 6 PM
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SHORT = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const working = (day) => day >= 1 && day <= 5;

  let clock;
  try {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    });
  } catch {
    return; // no time zone data: the printed hours are enough on their own
  }

  function india(now) {
    const parts = {};
    for (const p of clock.formatToParts(now)) parts[p.type] = p.value;
    return { day: SHORT[parts.weekday], minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
  }

  function line(now) {
    const { day, minutes } = india(now);
    if (working(day) && minutes >= OPEN && minutes < CLOSE) {
      return { open: true, text: 'Open now, until 6 PM' };
    }
    // Closed: count forward to the next working morning.
    let ahead = working(day) && minutes < OPEN ? 0 : 1;
    while (!working((day + ahead) % 7)) ahead++;
    const when = ahead === 0 ? 'today' : ahead === 1 ? 'tomorrow' : DAYS[(day + ahead) % 7];
    return { open: false, text: `Closed now, opens ${when} at 11 AM` };
  }

  let timer = 0;
  function tick() {
    const { open, text } = line(new Date());
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
})();
