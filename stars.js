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
