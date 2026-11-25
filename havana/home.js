// havana/home.js — Havana Social's home page (19 Nov 2026), on top of the system's home (index.html).
// site.js loads it on Havana's website only. The top stays the system's (the stars, Fork's Rating, the round
// buttons, the account menu); this file gives it Havana's photo, logo and buttons, and adds Havana's own parts,
// in the colors of havanasocialnyc.com: Specials (yellow), Food (purple), Events (sky blue), Reserve (pink),
// Parties (black). (25 Nov 2026: the "Visit us" part is off; the address and hours stay at the bottom of the page.)
(function () {
  var S = window.HF_SITE || {};
  var esc = function (t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var ICON = {
    star: '<path d="M12 3.2l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.6l-5.2 2.8 1-5.9L3.5 9.4l5.9-.8z"/>',
    party: '<path d="M4 20l5-13 8 8z"/><path d="M14 4c1 1 1 2.4 0 3.6M18 8c1.2-.4 2.4 0 3 1M16 3l.6 1.6M20 5l-1.4.9"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    taco: '<path d="M3 16a9 9 0 0 1 18 0z"/><path d="M7 12.5c1-.8 2-.8 3 0s2 .8 3 0 2-.8 3 0"/>',
    drink: '<path d="M5 4h14l-7 8z"/><path d="M12 12v7M8 20h8"/><path d="M15 4l3-3"/>',
    book: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4M8.5 14.5l2.3 2.3 4.7-4.6"/>',
    camera: '<rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.6"/><path d="M8.5 7l1.6-2.6h3.8L15.5 7"/>',
    pin: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
    phone: '<path d="M6.6 3.8l2.7-.4 1.6 4-1.9 1.4a11 11 0 0 0 5.2 5.2l1.4-1.9 4 1.6-.4 2.7a2 2 0 0 1-2 1.7A15.6 15.6 0 0 1 4.9 5.8a2 2 0 0 1 1.7-2z"/>'
  };
  var svg = function (k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>'; };

  // The round buttons: Havana's places (24 Nov 2026: "Parties" off with its section). Menu stays in the middle.
  var RAIL = [
    { name: 'Specials', ico: 'star', go: '#hv-specials' },
    { name: 'Events', ico: 'party', go: '#hv-events' },
    { name: 'Menu', ico: 'taco' },
    { name: 'Drinks', ico: 'drink' },
    { name: 'Reserve', ico: 'book' },
    { name: 'Social', ico: 'camera' },
    { name: 'Visit Us', ico: 'pin', maps: true },   // 25 Nov 01:14: the "Visit us" part is off; the button opens "Open location in…"
    { name: 'Call', ico: 'phone', tel: true }
  ];
  var PLACE = { Menu: { menu: 1 }, Drinks: { drinks: 1 }, Reserve: { book: 1 }, Social: { social: 1 } };
  var PALM = '/havana/palm-button.webp';   // drawn for Havana (palm/make_options.py, look A)

  function hero() {
    if (S.hero) { document.documentElement.style.setProperty('--hv-hero', 'url("' + S.hero + '")'); document.documentElement.classList.add('hv-has-hero'); }
    var h1 = document.querySelector('.video-hero-title');
    if (h1 && !h1.querySelector('.hv-hero-logo,.hv-word')) {
      h1.setAttribute('aria-label', S.name);
      h1.innerHTML = S.logo
        ? '<img class="hv-hero-logo" src="' + esc(S.logo) + '" alt="' + esc(S.name) + ' — Caribbean & Mexican cuisine">'
        : '<span class="hv-word">Havana</span><span class="hv-word">Social</span>';
    }
    var buttons = document.querySelectorAll('.vh-btn');
    RAIL.forEach(function (r, i) {
      var b = buttons[i]; if (!b) return;
      b.dataset.name = r.name;
      delete b.dataset.menu; delete b.dataset.drinks; delete b.dataset.book; delete b.dataset.social;
      var p = PLACE[r.name]; if (p) Object.keys(p).forEach(function (k) { b.dataset[k] = '1'; });
      if (r.go) b.dataset.hvGo = r.go; else delete b.dataset.hvGo;
      if (r.tel) b.dataset.hvTel = '1'; else delete b.dataset.hvTel;
      if (r.maps) b.dataset.hvMaps = '1'; else delete b.dataset.hvMaps;
      var label = b.querySelector('span'); if (label) label.textContent = r.name;
      // every button shows Havana's glossy palm (21 Nov: "I love the first one, Glossy palm"), as The Hungry Fork's show its steak
      var img = b.querySelector('img');
      if (img) { img.alt = ''; if (img.getAttribute('src') !== PALM) { img.src = PALM; img.setAttribute('data-orig', PALM); } img.classList.add('hv-palm'); }
      var ico = b.querySelector('.hv-ico'); if (ico) ico.remove();
    });
    // 24 Nov: one round button fewer (Parties): the page's extra button goes, and the ring starts on Menu again
    for (var k = buttons.length - 1; k >= RAIL.length; k--) buttons[k].remove();
    try { var mi = RAIL.map(function (r) { return r.name; }).indexOf('Menu'); railPos = railIdx = mi; railRender(); } catch (e) {}
    // Specials and Events go down the page; Visit Us opens "Open location in…" (Google Maps, Waze, Apple Maps, with
    // Havana's address: maps() below); Call calls. (Before the page's own click.)
    var rail = document.getElementById('vh-btn-rail');
    if (rail && !rail.dataset.hv) {
      rail.dataset.hv = '1';
      rail.addEventListener('click', function (e) {
        var b = e.target.closest('.vh-btn'); if (!b) return;
        if (b.dataset.hvGo) { e.stopPropagation(); var t = document.querySelector(b.dataset.hvGo); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        else if (b.dataset.hvTel) { e.stopPropagation(); window.location.href = 'tel:' + S.tel; }
        else if (b.dataset.hvMaps) { e.stopPropagation(); var m = document.getElementById('maps-modal'); if (m) { e.preventDefault(); m.classList.add('open'); } }
      }, true);
    }
  }

  var WEEK = [
    ['Monday', 'Margarita Mondays', 'All day: $10 margaritas and $10 frozen margaritas.'],
    ['Tuesday', 'Taco Tuesday', 'All day: $4 tacos (beef, chicken or veggie), $12 frozen drinks, $12 well drinks, $10 wine.'],
    ['Wednesday', 'Mariachi Night', 'From 7 PM: live mariachi, then karaoke (free to sing), then a DJ. No cover.'],
    ['Friday', 'Salsa & Bachata', 'Free dance class every Friday at 7 PM. No cover.'],
    ['Saturday', 'Churrasco Saturdays', 'A frozen drink or a beer on the house with any churrasco.']
  ];
  // The Dec 5 party (tickets on Bucket Listers, as on today's site); gone from the page once it is over.
  var EVENTS = [
    { ends: '2026-12-05T17:00:00-05:00', month: 'Dec', day: '5', when: 'Saturday, December 5 · VIP 1–5 PM · General 2–5 PM · 21+',
      name: 'Feliz Navidad: a Tequila & Mezcal Fiesta',
      about: 'Unlimited tequila, mezcal and beer tastings, Latin food, a live mariachi band, a Latin DJ, holiday games and a photo booth.',
      link: 'https://bucketlisters.com/experience/feliz-navidad-a-tequila-mezcal-fiesta', label: 'Get tickets',
      pic: ['havana/photos/feliz-navidad.jpg', 'Feliz Navidad: a Tequila & Mezcal Fiesta. December 5th, 1 PM to 5 PM.', 1400, 1050] }
  ];

  // 23 Nov 2026 (his flyer): Karaoke on Wednesdays and a live DJ Thursday to Saturday, with the sponsors in words (no
  // logos). 24 Nov: his framed pictures — the four days in Specials, Karaoke & DJ and the Dec 5 party in Events.
  var WEEKLY_PIC = 'havana/photos/karaoke-dj.jpg';
  var WEEKLY_ALT = 'Karaoke Night: Wednesdays, 7 PM to 10 PM. Thursday to Saturday: live DJ, no cover fee.';
  var DAY_PICS = [   // [file, alt (what the picture says), width, height]
    ['havana/photos/margarita-mondays.jpg', 'Margarita Mondays. All day: $10 margaritas and $10 frozen margaritas.', 1400, 1050],
    // 24 Nov 23:41: his new Taco Tuesday (without the decorative limes) and his own Mariachi Night picture (r65)
    ['havana/photos/taco-tuesday-2.jpg', 'Taco Tuesday. All day: $4 tacos (beef, chicken or veggie), $12 frozen drinks, $12 well drinks, $10 wine.', 1254, 1254],
    ['havana/photos/mariachi-night.jpg', 'Wednesday Mariachi Night. From 7 PM: live mariachi, then karaoke (free to sing), then a DJ. No cover.', 1254, 1254],
    ['havana/photos/salsa-bachata.jpg', 'Friday Salsa & Bachata. Free dance class every Friday at 7 PM. No cover.', 1254, 1254],
    ['havana/photos/churrasco-saturdays.jpg', 'Churrasco Saturdays. A frozen drink or a beer on the house with any churrasco.', 1254, 1254]
  ];
  // A picture through Vercel's image service (640 or 1080 wide), the original if that fails.
  function pic(file, alt, w, h, cls) {
    var u = function (px) { return '/_vercel/image?url=' + encodeURIComponent('/' + file) + '&w=' + px + '&q=75'; };
    return '<img' + (cls ? ' class="' + cls + '"' : '') + ' src="' + u(1080) + '" srcset="' + u(640) + ' 640w, ' + u(1080) + ' 1080w" sizes="(min-width: 760px) 640px, 92vw"'
      + ' data-orig="/' + esc(file) + '" onerror="this.onerror=null;this.removeAttribute(\'srcset\');this.src=this.dataset.orig" alt="' + esc(alt) + '"'
      + ' width="' + w + '" height="' + h + '" loading="lazy" decoding="async">';
  }
  // 24 Nov 22:56: the "Cervezas y más" box is off the home page (the beers are in the drinks menu).

  function sections() {
    if (document.getElementById('hv-specials')) return;
    var anchor = document.querySelector('.video-hero'); if (!anchor) return;
    var week = DAY_PICS.map(function (d) { return '<figure class="hv-pic">' + pic(d[0], d[1], d[2], d[3]) + '</figure>'; }).join('');
    var now = Date.now();
    var events = EVENTS.filter(function (e) { return Date.parse(e.ends) > now; }).map(function (e) {
      if (e.pic) {   // 24 Nov: his picture, the button under it, the details in one line
        return '<article class="hv-event-pic"><figure class="hv-pic">' + pic(e.pic[0], e.pic[1], e.pic[2], e.pic[3]) + '</figure>'
          + '<a class="hv-btn" href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.label) + '</a>'
          + '<p class="hv-event-line">' + esc(e.when) + '</p></article>';
      }
      return '<article class="hv-event"><div class="hv-event-when"><div class="hv-date">' + esc(e.month) + ' ' + esc(e.day) + '</div>'
        + '<div class="hv-label" style="font-size:1rem;line-height:1.3">' + esc(e.when) + '</div></div>'
        + '<div class="hv-event-body"><h3>' + esc(e.name) + '</h3><p>' + esc(e.about) + '</p>'
        + '<a class="hv-btn" href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.label) + '</a></div></article>';
    }).join('');
    var html = ''
      + '<section class="hv-sec hv-specials" id="hv-specials"><div class="hv-wrap">'
      +   '<h2 class="hv-title">Specials</h2>'
      // 24 Nov: the old website's Happy Hour box is off ("ignora los precios del viejo website"); the Happy Hour part of
      // the drinks appears when drinks get Happy Hour prices in Manager.
      +   '<div class="hv-week hv-pics">' + week + '</div>'
      + '</div></section>'
      + '<section class="hv-sec hv-events" id="hv-events"><div class="hv-wrap">'
      +   '<h2 class="hv-title">Events</h2>'
      +   (events || '<p class="hv-sub">New events are on the way. Follow us on Instagram to hear first.</p>')
      +   '<figure class="hv-pic hv-weekly">' + pic(WEEKLY_PIC, WEEKLY_ALT, 1352, 1163)
      +     '<figcaption>Sponsored by NÜTRL and Casamigos</figcaption></figure>'   // 24 Nov 22:56: the mariachi has its picture in Specials
      + '</div></section>'
      // 25 Nov 01:14 ("Delete this as well please"): the "Visit us" part (Where, Hours, Call or write, Follow us,
      // Directions) is off. The address and hours stay at the bottom of the page; Visit Us, Call and Social are round buttons.
      + '';
    anchor.insertAdjacentHTML('afterend', html);
    if (typeof hfHoursLoad === 'function') try { hfHoursLoad(); } catch (e) {}
  }

  // Food: six dishes with a photo (the Chef's Picks first), from the same menu as /menu.
  function food(tries) {
    var grid = document.getElementById('hv-grid'); if (!grid) return;
    var list = (typeof DISHES !== 'undefined' && Array.isArray(DISHES)) ? DISHES : [];
    if (!list.length && tries < 40) { setTimeout(function () { food(tries + 1); }, 250); return; }
    var mains = list.filter(function (d) { return d.category !== 'drinks' && !d.hidden; });
    mains.sort(function (a, b) { return (b.chefsPick ? 1 : 0) - (a.chefsPick ? 1 : 0) || (b.img ? 1 : 0) - (a.img ? 1 : 0); });
    var pick = mains.filter(function (d) { return d.img; }).slice(0, 6);
    if (pick.length < 6) pick = pick.concat(mains.filter(function (d) { return !d.img; }).slice(0, 6 - pick.length));
    grid.innerHTML = pick.map(function (d) {
      var pic = d.img
        ? '<img src="/_vercel/image?url=' + encodeURIComponent('/' + d.img) + '&w=640&q=75" data-orig="/' + esc(d.img) + '" onerror="this.onerror=null;this.src=this.dataset.orig" alt="" loading="lazy" decoding="async">'
        : '<span class="hv-emoji" aria-hidden="true">' + esc(d.emoji) + '</span>';
      return '<a class="hv-dish" href="/menu?dish=' + encodeURIComponent(d.id) + '"><figure><span class="hv-photo">' + pic + '</span>'
        + '<figcaption><b>' + esc(d.name) + '</b>' + (d.price != null ? '<span>$' + esc(d.price) + '</span>' : '') + '</figcaption></figure></a>';
    }).join('');
  }

  // "Open location in…": Havana's address
  function maps() {
    var M = { 'google.com/maps': 'https://www.google.com/maps/search/?api=1&query=Havana+Social+45+Stone+Street+New+York+NY+10004',
              'maps.apple.com': 'https://maps.apple.com/?q=Havana+Social&address=45+Stone+Street,+New+York,+NY+10004',
              'waze.com': 'https://waze.com/ul?q=45%20Stone%20Street%20New%20York%20NY&navigate=yes' };
    Object.keys(M).forEach(function (k) { document.querySelectorAll('#maps-modal a[href*="' + k + '"]').forEach(function (a) { a.href = M[k]; }); });
  }
  // The Google rating next to Fork's Rating. r64–r67: our own stars, with Google's numbers asked by the server.
  // r68 (25 Nov 2026 01:55, his pick "C1": "let's delete what we did before and use C1"): Google's own rating box
  // (Places UI Kit, Place Details Compact: the rating and Google's "Google Maps" credit), see-through, in Havana's
  // letters. Google draws it in the visitor's browser and keeps it up to date; a tap opens Google's "write a review" for
  // Havana. The browser key comes from Vercel through google_box (never in the code). Until Google's box has loaded
  // (or with no key, or when Google can't be reached within 10 seconds): only "Rate us on Google".

  // Fork's line in Google's letters (25 Nov 01:00: "use the same font for Fork's Rating 5.0 (3)"): the name in Lato,
  // the score in Havana's letters, and the count as Google's, "(3)" instead of "(3 ratings)".
  function forkLine(cap) {
    if (cap.querySelector('.hv-rate-name')) return;
    var first = cap.firstChild;
    if (first && first.nodeType === 3 && /Fork/.test(first.nodeValue)) {
      var nm = document.createElement('span'); nm.className = 'hv-rate-name'; nm.textContent = first.nodeValue.trim();
      cap.replaceChild(nm, first);
    }
    var num = cap.querySelector('#vh-rating-num'); if (!num) return;
    num.classList.add('hv-rate-num');
    var tidy = function () { var t = num.textContent, u = t.replace(/\s*ratings?\)/i, ')'); if (u !== t) num.textContent = u; };
    tidy();
    try { new MutationObserver(tidy).observe(num, { childList: true, characterData: true, subtree: true }); } catch (e) {}
  }
  function google() {
    var g = S.google; if (!g || !g.review) return;
    var live = document.querySelector('.vh-rating-live'), cap = document.querySelector('.vh-rating-caption');
    if (!live || !cap || document.querySelector('.hv-ratings')) return;
    var row = document.createElement('div'); row.className = 'hv-ratings';
    var fork = document.createElement('div'); fork.className = 'hv-rate hv-rate-fork';
    live.parentNode.insertBefore(row, live); fork.appendChild(live); fork.appendChild(cap); row.appendChild(fork);
    forkLine(cap);
    row.insertAdjacentHTML('beforeend', '<a class="hv-rate hv-rate-google hv-g-plain" href="' + esc(g.review) + '" target="_blank" rel="noopener"'
      + ' aria-label="Rate ' + esc(S.name) + ' on Google"><span class="hv-rate-cap">Rate us on Google</span></a>');
    try {
      fetch('/api/reservations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'google_box' }) })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var a = row.querySelector('.hv-rate-google'); if (!a || !d) return;
          if (d.review) a.href = d.review;
          if (d.ready && d.key && d.place) googleBox(a, d);
        }).catch(function () {});
    } catch (e) {}
  }
  // Google's box: Google's script (once), then the element; shown only when Google says it has loaded ("gmp-load").
  function googleBox(a, d) {
    var done = false, el = null;
    var build = function () {
      if (el) return;
      el = document.createElement('gmp-place-details-compact');
      el.className = 'hv-gbox'; el.setAttribute('orientation', 'horizontal');
      var rq = document.createElement('gmp-place-details-place-request'); rq.setAttribute('place', d.place);
      var at = document.createElement('gmp-place-attribution'); at.setAttribute('light-scheme-color', 'white'); at.setAttribute('dark-scheme-color', 'white');
      el.appendChild(rq); el.appendChild(document.createElement('gmp-place-rating')); el.appendChild(at);
      el.addEventListener('gmp-load', function () {
        if (done) return; done = true;
        var c = a.querySelector('.hv-rate-cap'); if (c) c.remove();
        a.classList.remove('hv-g-plain'); a.classList.add('hv-g-box'); el.classList.add('on');
        a.setAttribute('aria-label', 'Google rating for ' + (S.name || 'the restaurant') + ', from Google Maps. Tap to write a review on Google.');
      });
      a.appendChild(el);
    };
    setTimeout(function () { if (!done && el) { el.remove(); el = null; } done = true; }, 10000);
    window.hvGoogleReady = function () {
      try { window.google.maps.importLibrary('places').then(build, function () {}); } catch (e) {}   // window.google: "google" here is our function
    };
    if (window.google && window.google.maps && window.google.maps.importLibrary) { window.hvGoogleReady(); return; }
    var s = document.createElement('script'); s.async = true;
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(d.key) + '&v=weekly&libraries=places&loading=async&callback=hvGoogleReady';
    document.head.appendChild(s);
  }

  function start() { hero(); google(); sections(); maps(); }   // 24 Nov: the dishes' section is off (food() stays for later)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
