(function () {
  'use strict';

  // ── Fade-in + slide-up for .animate-in ──────────────────────────

  var EASING   = 'cubic-bezier(0.16, 1, 0.3, 1)';
  var DURATION = 400;
  var STAGGER  = 80;
  var SLIDE    = 12;

  // Set initial hidden state before first paint
  document.querySelectorAll('.animate-in').forEach(function (el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(' + SLIDE + 'px)';
    el.style.willChange = 'opacity, transform';
  });

  // Collect siblings that intersect in the same observer callback tick,
  // sort by DOM order, then stagger them.
  var pendingBatch = new Map();
  var batchTimer   = null;

  function processBatch() {
    pendingBatch.forEach(function (els, parent) {
      var allChildren = Array.from(parent.children);
      els.sort(function (a, b) {
        return allChildren.indexOf(a) - allChildren.indexOf(b);
      });
      els.forEach(function (el, i) {
        var delay = i * STAGGER;
        el.style.transition =
          'opacity ' + DURATION + 'ms ' + EASING + ' ' + delay + 'ms, ' +
          'transform ' + DURATION + 'ms ' + EASING + ' ' + delay + 'ms';
        el.style.opacity    = '1';
        el.style.transform  = 'translateY(0)';
        el.style.willChange = 'auto';
      });
    });
    pendingBatch.clear();
  }

  var fadeObs = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el     = entry.target;
      var parent = el.parentElement;
      if (!pendingBatch.has(parent)) pendingBatch.set(parent, []);
      pendingBatch.get(parent).push(el);
      fadeObs.unobserve(el);
    });
    clearTimeout(batchTimer);
    batchTimer = setTimeout(processBatch, 0);
  }, { threshold: 0.1 });

  document.querySelectorAll('.animate-in').forEach(function (el) {
    fadeObs.observe(el);
  });

  // ── Count-up for .stat-counter ──────────────────────────────────

  function countUp(el) {
    var target   = parseInt(el.dataset.value, 10);
    var suffix   = el.dataset.suffix || '';
    if (isNaN(target)) return;
    var duration = 800;
    var start    = performance.now();

    function tick(now) {
      var p     = Math.min((now - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
      el.textContent = Math.round(eased * target) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  }

  var counterObs = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      countUp(entry.target);
      counterObs.unobserve(entry.target);
    });
  }, { threshold: 0.5 });

  document.querySelectorAll('.stat-counter').forEach(function (el) {
    counterObs.observe(el);
  });

})();
