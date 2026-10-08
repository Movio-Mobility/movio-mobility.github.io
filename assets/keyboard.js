/*
 * The on-screen keyboard, for any form inside a fixed panel.
 *
 * The site's forms live in fixed shells (the configurator's panel, a sheet), and a phone's
 * keyboard shrinks only the visual viewport (iOS Safari, and Chrome on Android since 108).
 * Left alone, the panel would carry on at full height underneath it, with the field being
 * typed in and the panel's footer behind the keys. So while a keyboard is up the panel takes
 * exactly the visible area above it (html.is-typing, --vv-top and --vv-h, which the page's
 * stylesheet turns into a top and a height), following iOS as it pans, and the field being
 * typed in is scrolled into view inside it. The rule this exists for: the field someone is
 * typing in is never hidden behind the keyboard.
 *
 * Moved verbatim from powerpod-gen2.js, which now calls it like any other form:
 *
 *   const kb = window.gridKeyboard.watch({
 *     shell,          // the element that gets --vv-top and --vv-h (the fixed panel or its shell)
 *     scope,          // where the fields are: focus and input inside it are what count
 *     scroller,       // optional: the scrolling box the field is revealed in
 *     minShrink,      // optional: px the viewport must lose before it counts as a keyboard
 *   });
 *   kb.stop();        // listeners off, and the page put back if a keyboard was up
 *
 * A field is anything carrying .field__input (fields.css), so choices and checkboxes, which
 * raise no keyboard, never resize the panel. Event driven only: nothing runs per frame, and
 * each burst of events is coalesced into one pass on the next frame.
 */
(() => {
  'use strict';

  const root = document.documentElement;

  function watch({ shell, scope, scroller = null, minShrink = 120 } = {}) {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // How much shorter than its fullest the visual viewport must be before it counts as a
    // keyboard rather than a browser's address bar coming and going.
    const KEYBOARD_MIN = minShrink;
    let vvFull = 0;
    let vvWidth = 0;
    let typing = false;
    let keyboardFrame = 0;

    const typingIn = () => {
      const el = document.activeElement;
      return el && el.classList && el.classList.contains('field__input') && scope.contains(el) ? el : null;
    };

    // The whole field (label, input and any error under it) in view, a little below the top
    // of the scroll area so the next one shows beneath it. Left alone if it is already in view.
    function revealField(input) {
      const block = input.closest('.field') || input;
      const view = scroller.getBoundingClientRect();
      const r = block.getBoundingClientRect();
      const margin = 12;
      if (r.top >= view.top + margin && r.bottom <= view.bottom - margin) return;
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollTop + (r.top - view.top) - margin),
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }

    function syncKeyboard() {
      keyboardFrame = 0;
      const vv = window.visualViewport;
      if (!vv || !shell) return;
      // The fullest it has been at this width. A new width is a rotation, and starts over.
      if (Math.abs(vv.width - vvWidth) > 1) {
        vvWidth = vv.width;
        vvFull = 0;
      }
      vvFull = Math.max(vvFull, vv.height);

      const field = typingIn();
      const open = Boolean(field) && vvFull - vv.height > KEYBOARD_MIN;
      if (open) {
        shell.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
        shell.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      }
      if (open !== typing) {
        typing = open;
        root.classList.toggle('is-typing', open);
        if (!open) {
          shell.style.removeProperty('--vv-top');
          shell.style.removeProperty('--vv-h');
        }
      }
      // Measured after the panel has taken its new size, which the class above has just set.
      // Without a scroller the page has said the field is always in view already.
      if (field && scroller) revealField(field);
    }

    const queueKeyboard = () => {
      if (!keyboardFrame) keyboardFrame = requestAnimationFrame(syncKeyboard);
    };
    // An error message appearing under the field grows it, so it is checked again.
    const onInput = () => { if (typing) queueKeyboard(); };

    if (!scope) return { stop() {} };

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', queueKeyboard);
      window.visualViewport.addEventListener('scroll', queueKeyboard);
      queueKeyboard();
    }
    // Moving from one field to the next is a focusout and then a focusin; one coalesced pass
    // sees only where focus landed.
    scope.addEventListener('focusin', queueKeyboard);
    scope.addEventListener('focusout', queueKeyboard);
    scope.addEventListener('input', onInput);

    return {
      stop() {
        if (window.visualViewport) {
          window.visualViewport.removeEventListener('resize', queueKeyboard);
          window.visualViewport.removeEventListener('scroll', queueKeyboard);
        }
        scope.removeEventListener('focusin', queueKeyboard);
        scope.removeEventListener('focusout', queueKeyboard);
        scope.removeEventListener('input', onInput);
        if (keyboardFrame) cancelAnimationFrame(keyboardFrame);
        keyboardFrame = 0;
        // A sheet closing with the keyboard still up must not leave the page sized to it.
        if (typing) {
          typing = false;
          root.classList.remove('is-typing');
          if (shell) {
            shell.style.removeProperty('--vv-top');
            shell.style.removeProperty('--vv-h');
          }
        }
      },
    };
  }

  window.gridKeyboard = { watch };
})();
