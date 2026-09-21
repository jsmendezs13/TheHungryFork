// stars.js — make the Fork's Rating stars actually show the rating.
//
// The widget draws five stars in full colour and was meant to cover the
// unearned ones with an overlay layer. That overlay was switched off in the
// CSS:
//
//     .vh-stars-fill   { display: none; }
//     .cave-stars-fill { display: none; }
//
// ...so the code set a width on an invisible element and every score rendered
// as five solid red stars. A 4.0 and a 5.0 looked identical; only the caption
// text was ever telling the truth.
//
// Two real layers now: a dimmed set of stars underneath, and the coloured set
// clipped to the score on top. The coloured layer is cloned from the markup at
// runtime, so the (large) star SVG still only appears once per widget in the
// source.

// The five stars sit on a 560-wide canvas at x = 2, 117, 232, 347 and 462,
// each 96 wide — so there are gaps between them. Clipping at a flat
// percentage counts those gaps as score, which puts 4.5 at 44% of the last
// star instead of half. Whole numbers stay exact either way (they land in a
// gap); fractions need the real geometry.
const STAR_WIDTH = 96, STAR_PITCH = 115, STAR_CANVAS = 560, STAR_INSET = 2;

function starClipPercent(score) {
  const whole = Math.floor(score), part = score - whole;
  const x = part === 0
    ? (whole === 0 ? 0 : STAR_PITCH * (whole - 1) + STAR_INSET + STAR_WIDTH)
    : STAR_PITCH * whole + STAR_INSET + part * STAR_WIDTH;
  return x / STAR_CANVAS * 100;
}

function setForkStars(fillId, avg) {
  const fill = document.getElementById(fillId);
  if (!fill) return;

  if (!fill.dataset.starsReady) {
    const wrap = fill.parentElement;
    // The SVG version leaves the fill layer empty; the text version already
    // has its own stars in it. Only clone when there's nothing there.
    const source = wrap && wrap.querySelector('.fork-stars, .cave-stars-base');
    if (source && !fill.children.length && !fill.textContent.trim()) {
      fill.innerHTML = source.outerHTML;
    }
    if (wrap) wrap.classList.add('stars-scored');
    // The fill divs in the markup carry an id but no class, so styling them by
    // class silently missed and the cloned stars stacked underneath instead of
    // overlapping. Tag the element here and the CSS cannot miss it.
    fill.classList.add('fork-stars-fill');
    if (!fill.querySelector('svg')) fill.classList.add('fork-stars-text');
    fill.dataset.starsReady = '1';
  }

  const score = Math.max(0, Math.min(5, Number(avg) || 0));
  // The SVG widget needs the geometry-aware mapping. The older text version
  // (plain ★ characters) is evenly spaced, so a flat percentage is right there.
  const usesSvg = !!fill.querySelector('svg');
  fill.style.width = (usesSvg ? starClipPercent(score) : score / 5 * 100) + '%';
}


// ═══════════════════════════════════════════════════════════════════════════
// SHARED BY BOTH PAGES — the rating period, and a row of stars for a score.
//
// These lived in menu.html until the home page needed them too (the "What is
// Fork's Rating?" box now shows the restaurant's own score). One copy here,
// so the two pages cannot drift apart.
//
// ── ONLY FUNCTIONS, ON PURPOSE ──
// Every file goes live on its own, one upload at a time. The menu.html that
// was live when this was written declared its own copies of these values as
// `const`. If this file declared a `const` with the same name, the browser
// would refuse to run that page's script at all — the whole menu dead until
// the next upload landed. A function may share a name with another script's
// function (the later one simply wins), so this file adds functions and
// nothing else, and is safe next to any version of either page.
// Constants live INSIDE the functions. Do not add a top-level const/let here.
// ═══════════════════════════════════════════════════════════════════════════

// ── THE PERIOD A SCORE COVERS ──
//
// Sebastian's design: a score covers the last twelve months by default, and a
// reader can widen or narrow it — one month, three, twelve, or all time.
// ROLLING, not "since January 1st": a calendar year would reset every January.
// EVERY rating in the period counts, including several from the same guest.
// It changes the SCORE only — lists of reviews always show everything.
function ratingDefaultDays() { return 365; }

function ratingInWindow(r, days) {
  if (!days) return true;                       // 0 = all time
  const t = new Date(r.created_at).getTime();
  return Number.isFinite(t) && t >= Date.now() - days * 86400000;
}

// The same boundary as a timestamp, for asking the database directly.
function windowStartISO(days) { return new Date(Date.now() - days * 86400000).toISOString(); }

// ── A ROW OF FORK'S RATING STARS ──
//
// The same drawing as the stars on the menu card: five stars on a 560-wide
// canvas, each with its own gradient, darkest on the left climbing to bright
// red on the right. Pale stars underneath; the coloured ones clipped to the
// score on top, at the real star positions (starClipPercent, above).
//
// EXACTLY the card's colours — Sebastian asked for them to match ("first they
// are dark and then more red"). A test reads the stops out of the card's own
// drawing and fails if these ever stop matching.
function forkStarGradient() {
  return [['#5A1610','#260805'], ['#7E150D','#3E0B06'], ['#A31108','#5E0A04'],
          ['#C41508','#750A04'], ['#E02414','#8E0B05']];
}

// Every row names its own gradients and clip. The card's drawing uses fixed
// names (fs1…fs5); many copies of those on one page is invalid, and when the
// first copy is inside something hidden, Chrome can paint every star with it —
// black, or nothing at all. Returns an <svg class="rv-srow">; each page sizes
// it with CSS.
function forkStarRow(score) {
  const PATH  = 'M50 4 L62 38 L98 38 L69 60 L80 95 L50 73 L20 95 L31 60 L2 38 L38 38 Z';
  const X     = [0, 115, 230, 345, 460];
  const UNLIT = '#E4D9C9';
  const s = Math.max(0, Math.min(5, Number(score) || 0));
  forkStarRow.uid = (forkStarRow.uid || 0) + 1;
  const u = 'fsr' + forkStarRow.uid;
  const clip = (starClipPercent(s) / 100 * 560).toFixed(1);
  const grads = forkStarGradient().map(([top, bottom], i) =>
    `<linearGradient id="${u}g${i}" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`).join('');
  const base = X.map((x) => `<path transform="translate(${x},0)" d="${PATH}"/>`).join('');
  const lit  = X.map((x, i) =>
    `<path transform="translate(${x},0)" fill="url(#${u}g${i})" d="${PATH}"/>`).join('');
  const said = s ? (Math.round(s * 10) / 10) + ' out of 5' : 'no score';
  return `<svg class="rv-srow" viewBox="0 0 560 100" role="img" aria-label="${said}" data-score="${s}">`
    + `<defs>${grads}<clipPath id="${u}c"><rect x="0" y="0" width="${clip}" height="100"/></clipPath></defs>`
    + `<g class="rv-srow-base" fill="${UNLIT}">${base}</g>`
    + `<g clip-path="url(#${u}c)" stroke="rgba(0,0,0,.3)" stroke-width="2" stroke-linejoin="round">${lit}</g>`
    + `</svg>`;
}
