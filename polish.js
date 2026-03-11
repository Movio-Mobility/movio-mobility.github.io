(function() {
  'use strict';

  // --- Anti-inspect: disable right-click and DevTools/source shortcuts (Mac, Windows, Linux) ---
  document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);
  document.addEventListener('keydown', function(e) {
    var k = (e.key || '').toUpperCase();
    // F12 - DevTools (Windows/Linux)
    if (e.key === 'F12' || e.keyCode === 123) { e.preventDefault(); e.stopImmediatePropagation(); return false; }
    // Ctrl+Shift+I, J, C, K - DevTools (Windows/Linux: Chrome, Firefox)
    if (e.ctrlKey && e.shiftKey && ['I','J','C','K'].indexOf(k) !== -1) { e.preventDefault(); e.stopImmediatePropagation(); return false; }
    // Cmd+Option+I, J, C, U - DevTools, View Source (Mac: Chrome, Safari)
    if (e.metaKey && e.altKey && ['I','J','C','U'].indexOf(k) !== -1) { e.preventDefault(); e.stopImmediatePropagation(); return false; }
    // Cmd+Shift+C - Inspect element (Mac Chrome)
    if (e.metaKey && e.shiftKey && k === 'C') { e.preventDefault(); e.stopImmediatePropagation(); return false; }
    // Ctrl+U - View Source (Windows/Linux)
    if (e.ctrlKey && k === 'U') { e.preventDefault(); e.stopImmediatePropagation(); return false; }
  }, true);

  // --- Debugger trap: pauses execution when DevTools is open ---
  (function trap() { setInterval(function() { (function() { return false; })['constructor']('debugger')(); }, 50); })();

  // --- Scroll-aware navbar ---
  var nav = document.querySelector('nav');
  if (nav) {
    var navTicking = false;
    window.addEventListener('scroll', function() {
      if (!navTicking) {
        requestAnimationFrame(function() {
          nav.classList.toggle('nav-scrolled', window.scrollY > 50);
          navTicking = false;
        });
        navTicking = true;
      }
    }, { passive: true });
  }

  // --- Scroll progress bar ---
  var progressBar = document.querySelector('.scroll-progress');
  if (progressBar) {
    var progressTicking = false;
    window.addEventListener('scroll', function() {
      if (!progressTicking) {
        requestAnimationFrame(function() {
          var scrollTop = window.scrollY;
          var docHeight = document.documentElement.scrollHeight - window.innerHeight;
          var progress = docHeight > 0 ? scrollTop / docHeight : 0;
          progressBar.style.transform = 'scaleX(' + Math.min(progress, 1) + ')';
          progressTicking = false;
        });
        progressTicking = true;
      }
    }, { passive: true });
  }

  // --- Scroll reveals with stagger ---
  var revealElements = document.querySelectorAll('.reveal-on-scroll');
  if (revealElements.length > 0) {
    var revealObserver = new IntersectionObserver(function(entries) {
      var visibleDelay = 0;
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          entry.target.style.transitionDelay = visibleDelay + 'ms';
          entry.target.classList.add('revealed');
          visibleDelay += 80;
          revealObserver.unobserve(entry.target);
        }
      });
    }, {
      threshold: 0.08,
      rootMargin: '0px 0px -40px 0px'
    });

    revealElements.forEach(function(el) {
      revealObserver.observe(el);
    });
  }
})();
