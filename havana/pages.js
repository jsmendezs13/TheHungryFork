// havana/pages.js — Havana Social's own words and pictures on the system's pages (19 Nov 2026). site.js loads it
// on Havana's website, on every page but the home page (that one is havana/home.js).
(function () {
  var S = window.HF_SITE || {};
  var MAPS = {
    google: 'https://www.google.com/maps/search/?api=1&query=Havana+Social+45+Stone+Street+New+York+NY+10004',
    apple: 'https://maps.apple.com/?q=Havana+Social&address=45+Stone+Street,+New+York,+NY+10004',
    waze: 'https://waze.com/ul?q=45%20Stone%20Street%20New%20York%20NY&navigate=yes'
  };
  var ABOUT = 'Havana Social brings the flavors of Cuba, Mexico and the Caribbean to Stone Street, the cobblestoned heart of the '
    + 'Financial District. Ropa vieja, churrasco, tostones and empanadas; tacos, fajitas and burritos; mojitos, margaritas and frozen '
    + 'cocktails. Happy hour every day from 2 to 7 PM, live mariachi on Wednesdays and a free salsa and bachata class every Friday. '
    + 'There’s no party like a Latin party.';
  function set(sel, fn) { var el = document.querySelector(sel); if (el) fn(el); }

  // The booking page: who we are, where, and one of Havana's dishes in place of The Hungry Fork's steak.
  set('.rv-eyebrow', function (el) { el.innerHTML = 'Caribbean &amp; Mexican<br>Stone Street'; });
  set('.rv-hero-line', function (el) {
    var keep = el.querySelector('.hf-hours');
    el.innerHTML = '45 Stone Street<br>New York, NY 10004';
    if (keep) el.appendChild(keep);
  });
  set('#rv-about-p', function (el) { el.textContent = ABOUT; });
  set('#map-google', function (el) { el.href = MAPS.google; });
  set('#map-apple', function (el) { el.href = MAPS.apple; });
  set('#map-waze', function (el) { el.href = MAPS.waze; });
  // The Hungry Fork's steak: one of Havana's dishes instead, the same way (the plate cut out, no ring: 19 Nov 02:12,
  // the ring of leaves only where the caves were); until his photos are here, nothing.
  set('.rv-plate', function (el) {
    if (!S.plate) { el.remove(); return; }
    el.removeAttribute('srcset'); el.alt = '';
    el.setAttribute('data-orig', S.plate);
    el.onerror = function () { el.onerror = null; el.src = '/' + S.plate; };    // the lighter copy failed: the file itself
    el.src = window.hfImgSrc ? hfImgSrc(S.plate, 420) : '/' + S.plate;
  });
  // The home page's "Open location in…" (also on the menu page)
  document.querySelectorAll('a[href*="google.com/maps"]').forEach(function (a) { a.href = MAPS.google; });
  document.querySelectorAll('a[href*="maps.apple.com"]').forEach(function (a) { a.href = MAPS.apple; });
  document.querySelectorAll('a[href*="waze.com"]').forEach(function (a) { a.href = MAPS.waze; });
})();
