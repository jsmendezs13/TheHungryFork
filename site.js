// site.js — which restaurant this website is (Havana Social, 19 Nov 2026).
//
// One system, one Vercel project, one database: the web address says which restaurant's website
// the person is on. thehungryfork.fun is The Hungry Fork (restaurant 1, the demo);
// havana-social.vercel.app (and later havanasocialnyc.com) is Havana Social (restaurant 2).
// Every page loads this file first, in <head>, before its own scripts, so RESTAURANT_ID and the
// restaurant's name are right from the first request. A restaurant other than The Hungry Fork
// also gets its own look (html[data-site="…"] + its theme file) and its own words in place of
// The Hungry Fork's (rebrand(), when the page is read).
//
// On the test bench (localhost) ?site=havana picks a restaurant for that tab.
(function () {
  var SITES = {
    'hungry-fork': { id: 1, key: 'hungry-fork', name: 'The Hungry Fork' },
    'havana': {
      id: 2, key: 'havana', name: 'Havana Social', short: 'Havana',
      theme: '/havana/theme.css',
      home: '/havana/home.js',
      pages: '/havana/pages.js',
      ring: true,          // photos of dishes and drinks in the ring of leaves (the restaurant's sign)
      secondPhotoFull: true,   // 22 Nov: a dish's second photo is another photo of the plate, shown as big as the first (not the small ingredients frame)
      noTypedPairs: true,  // no wine or cocktail suggestions unless the team chooses them
      logo: '/havana/havana-logo.webp',   // the restaurant's logo, as on its sign (20 Nov; his file Havana_Social_II.png)
      hero: null,          // a photo for the top of the home page (not needed while there is the video)
      heroVideo: '/havana/havana-hero.mp4',  // the top of the home page (20 Nov: his video, graded, the repeat taken out; no sound)
      heroPoster: '/havana/havana-hero.jpg',  // 1280x720 since 20 Nov 05:53 ("es posible tenerlo de mejor calidad?")
      heroVideoTall: '/havana/havana-hero-tall.mp4',  // the same video made 9:16 for phones (20 Nov 14:11): each shot reframed, the sign whole at the end
      heroPosterTall: '/havana/havana-hero-tall.jpg',
      // its Google rating, next to Fork's Rating on the home page (20 Nov: typed by hand for now, as Google Maps shows it;
      // later it comes from Google by itself). No score → nothing is shown.
      google: { url: 'https://maps.app.goo.gl/9jtCZ6SoYvdpHMHV9', score: null, count: null },
      plate: 'havana/photos/churrasco.png',   // the dish at the top of Reservations (The Hungry Fork's steak there)
      eyebrow: 'Caribbean & Mexican · Stone Street, New York',
      tagline: 'There’s no party like a Latin party',
      address: '45 Stone Street, New York, NY 10004',
      phone: '(212) 785-5400', tel: '+12127855400',
      instagram: 'https://www.instagram.com/havanasocialnyc/',
      lat: 40.70433, lng: -74.01055,
      // The parts of the menu, in Havana's own words (the keys stay the system's)
      labels: { starters: 'Aperitivos', entree: 'Platos Fuertes', salads: 'Ensaladas', sides: 'Algo Más',
                desserts: 'Postres', drinks: 'Bebidas', cocktails: 'Cócteles', beers: 'Cervezas', 'drinks-other': 'Sin Alcohol' },   // r58: the aguas frescas, the N/A beer, Jarritos
      words: [
        ['123 Stone St, Manhattan, NY', '45 Stone Street, New York, NY 10004'],
        ['Steakhouse · Stone Street, New York', 'Caribbean & Mexican · Stone Street, New York'],
        ['Delicious Cousin', 'There’s no party like a Latin party'],
        ['Tap a cave to enter', 'Tap a photo to open it'],
        ['Tap the cave to enter', 'Tap the photo to open it'],
        ['The Hungry Fork', 'Havana Social'],
        ['Hungry Fork', 'Havana Social']
      ]
    }
  };
  var HOSTS = {
    'havana-social.vercel.app': 'havana',
    'havanasocialnyc.com': 'havana',
    'www.havanasocialnyc.com': 'havana'
  };
  var host = String(location.hostname || '').toLowerCase();
  var key = HOSTS[host] || 'hungry-fork';
  if (host === 'localhost' || host === '127.0.0.1') {
    try {
      var asked = new URLSearchParams(location.search).get('site');
      if (asked && SITES[asked]) sessionStorage.setItem('hf_site', asked);
      var kept = sessionStorage.getItem('hf_site');
      if (kept && SITES[kept]) key = kept;
    } catch (e) {}
  }
  var S = SITES[key];
  window.HF_SITE = S;
  // r60: the website of each restaurant (My Tastings links a dish rated at another restaurant to that restaurant's menu)
  window.HF_SITE_KEYS = {};
  for (var k in SITES) window.HF_SITE_KEYS[SITES[k].id] = k;
  document.documentElement.setAttribute('data-site', key);
  // r60 (24 Nov 2026, Sebastian: "they need to be separate"): every request to this website's own server says which
  // restaurant's website it is (X-HF-Site), so the Manager page, the bell and the messages stay with this restaurant.
  // On our real addresses the server knows it anyway; this is for the test bench and preview addresses.
  try {
    var nativeFetch = window.fetch;
    if (nativeFetch && !nativeFetch.hfSite) {
      var siteFetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0) {
            var h = new Headers((init && init.headers) || (typeof input !== 'string' && input && input.headers) || {});
            if (!h.has('X-HF-Site')) h.set('X-HF-Site', String(S.id));
            init = Object.assign({}, init || {}, { headers: h });
          }
        } catch (e) {}
        return nativeFetch.call(window, input, init);
      };
      siteFetch.hfSite = true;
      window.fetch = siteFetch;
    }
  } catch (e) {}
  if (!S.theme) return;

  // Its own look: the theme file goes in right here, while <head> is still being read, so the
  // page never shows The Hungry Fork's look first.
  document.write('<link rel="stylesheet" href="' + S.theme + '">');

  // Its own words: text, titles and pictures that still say The Hungry Fork.
  function swap(t) {
    for (var i = 0; i < S.words.length; i++) if (t.indexOf(S.words[i][0]) !== -1) t = t.split(S.words[i][0]).join(S.words[i][1]);
    return t;
  }
  // r60: never inside [data-keep] — names that come from the system (the restaurants in My Visits, My Tastings, the
  // bell): The Hungry Fork's visits are The Hungry Fork's, on any website (24 Nov: Santiago's showed as Havana's).
  function isKept(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && el.closest && el.closest('[data-keep]'));
  }
  function rebrand(root) {
    if (isKept(root)) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (x) { return x.nodeType === 1 && x.hasAttribute('data-keep') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    }), n;
    while ((n = w.nextNode())) {
      if (n.nodeType !== 3) continue;
      var p = n.parentNode && n.parentNode.nodeName;
      if (p === 'SCRIPT' || p === 'STYLE') continue;
      if (/Hungry Fork|Stone St|Delicious Cousin|cave to enter/.test(n.nodeValue)) n.nodeValue = swap(n.nodeValue);
    }
    var imgs = root.querySelectorAll ? [].slice.call(root.querySelectorAll('img')) : [];
    if (root.nodeName === 'IMG') imgs.push(root);
    imgs.forEach(function (img) {
      if (/Hungry Fork/.test(img.alt || '') && !isKept(img)) img.alt = swap(img.alt);
      if (!/hungry-fork-logo/.test((img.getAttribute('src') || '') + ' ' + (img.getAttribute('data-orig') || ''))) return;
      img.removeAttribute('onerror');
      if (S.logo) { img.src = S.logo; img.setAttribute('data-orig', S.logo); img.classList.add('site-logo'); return; }
      var w = document.createElement('span'); w.className = 'site-logo-words'; w.textContent = S.name;   // until the logo file is here
      img.replaceWith(w);
    });
  }
  window.hfRebrand = rebrand;
  window.hfSiteWords = swap;
  document.title = swap(document.title);

  var page = location.pathname.replace(/\/+$/, '').replace(/\.html$/, '') || '/';
  var home = page === '/' || page === '/index';
  // The Hungry Fork's chef video never loads here: the moment the page reads it, its address becomes the restaurant's own video (or none).
  var watch = null;
  if (home) try {
    watch = new MutationObserver(function () {
      var v = document.querySelector('video.video-hero-bg');
      if (!v) return;
      watch.disconnect();
      if (S.heroVideo) {                                         // its own video instead (muted, as browsers require to play by itself)
        v.muted = true; v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.loop = true;
        // a phone held upright (a screen narrower than 2:3) gets the 9:16 copy; turned sideways, a tablet or a computer, the whole picture
        var up = S.heroVideoTall && window.matchMedia ? window.matchMedia('(max-aspect-ratio: 2/3)') : null;
        var pick = function () {
          var tall = !!(up && up.matches), src = tall ? S.heroVideoTall : S.heroVideo, poster = tall ? (S.heroPosterTall || S.heroPoster) : S.heroPoster;
          if (v.getAttribute('src') === src) return;
          if (poster) v.poster = poster;
          v.src = src;
          if (v.play) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
        };
        pick();
        if (up) { if (up.addEventListener) up.addEventListener('change', pick); else if (up.addListener) up.addListener(pick); }
        document.documentElement.classList.add('hv-has-video');
      } else { v.removeAttribute('src'); v.removeAttribute('autoplay'); v.preload = 'none'; }
    });
    watch.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    if (watch) watch.disconnect();
    document.title = swap(document.title);
    rebrand(document.body);
    // …and what the pages draw later (a dish's own page, its footer, windows): the same, as it appears
    try {
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++) for (var j = 0; j < list[i].addedNodes.length; j++) {
          var nd = list[i].addedNodes[j];
          if (nd.nodeType === 1) rebrand(nd);
          else if (nd.nodeType === 3 && /Hungry Fork|Stone St|Delicious Cousin|cave to enter/.test(nd.nodeValue) && !isKept(nd)) nd.nodeValue = swap(nd.nodeValue);
        }
      }).observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    // The restaurant's own home page parts (havana/home.js) and the words of the other pages (havana/pages.js)
    var extra = home ? S.home : S.pages;
    if (extra) { var s = document.createElement('script'); s.src = extra; document.body.appendChild(s); }
  });
})();
