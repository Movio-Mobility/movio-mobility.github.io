(function() {
  'use strict';

  // --- Frame-busting: prevent embedding in iframes ---
  if (window.top !== window.self) {
    window.top.location = window.self.location;
  }

  var isAdminPortal = false;
  try {
    isAdminPortal = !!(document.body && document.body.classList.contains('admin-portal')) ||
      String(window.location.pathname || '').toLowerCase().indexOf('movio.html') !== -1;
  } catch (e) {}

  if (!isAdminPortal) {
    // --- Silence console to prevent info leaks ---
    (function() {
      var noop = function() {};
      var methods = ['log', 'debug', 'info', 'warn', 'error', 'table', 'trace', 'dir', 'dirxml', 'group', 'groupEnd', 'time', 'timeEnd', 'count', 'profile', 'profileEnd'];
      for (var i = 0; i < methods.length; i++) {
        try { window.console[methods[i]] = noop; } catch(e2) {}
      }
      setInterval(function() {
        try { console.clear(); } catch(e3) {}
      }, 1000);
    })();

    // --- Anti-inspect: disable right-click and all dangerous shortcuts ---
    document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);
    document.addEventListener('keydown', function(e) {
      var k = (e.key || '').toUpperCase();
      var block = function() { e.preventDefault(); e.stopImmediatePropagation(); return false; };

      if (e.key === 'F12' || e.keyCode === 123) return block();
      if (e.ctrlKey && e.shiftKey && ['I','J','C','K'].indexOf(k) !== -1) return block();
      if (e.metaKey && e.altKey && ['I','J','C','U'].indexOf(k) !== -1) return block();
      if (e.metaKey && e.shiftKey && k === 'C') return block();
      if (e.ctrlKey && k === 'U') return block();
      if ((e.ctrlKey || e.metaKey) && k === 'S') return block();
      if ((e.ctrlKey || e.metaKey) && k === 'P') return block();
      if ((e.ctrlKey || e.metaKey) && k === 'A') return block();
      if ((e.ctrlKey || e.metaKey) && k === 'C') return block();
    }, true);

    // --- Block drag on all elements ---
    document.addEventListener('dragstart', function(e) { e.preventDefault(); }, true);
    document.addEventListener('drop', function(e) { e.preventDefault(); }, true);

    // --- Block copy/cut of page content ---
    document.addEventListener('copy', function(e) { e.preventDefault(); }, true);
    document.addEventListener('cut', function(e) { e.preventDefault(); }, true);

    // --- Debugger trap + DevTools size detection ---
    (function trap() { setInterval(function() { (function() { return false; })['constructor']('debugger')(); }, 50); })();
    (function() {
      var threshold = 160;
      var check = function() {
        var w = window.outerWidth - window.innerWidth > threshold;
        var h = window.outerHeight - window.innerHeight > threshold;
        if (w || h) {
          document.documentElement.innerHTML = '';
        }
      };
      setInterval(check, 1000);
      window.addEventListener('resize', check);
    })();
  }

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
