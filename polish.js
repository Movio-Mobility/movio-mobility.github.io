(function() {
  'use strict';

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
