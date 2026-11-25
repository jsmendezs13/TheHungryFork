// api/_lib/google.js — the restaurant's Google rating on its home page.
//
// r68 (25 Nov 2026, Sebastian 01:55: "let's delete what we did before and use C1"): Google's own rating box (Places UI
// Kit, Place Details Compact element), drawn by Google in the visitor's browser. Before (r64–r67) this server asked
// Google for the numbers on every page view (Place Details Enterprise, 1,000 free a month); that is gone.
//
// { action: 'google_box' } through /api/reservations (no login; the website says which restaurant, as everywhere):
//   → { ready: true, key, place, review }   the browser key, the restaurant's Google place and the "write a review" link
//   → { ready: false, review }              no browser key in Vercel yet: the page shows only "Rate us on Google"
//   → { ready: false }                      a restaurant with no Google place here
// The browser key (GOOGLE_MAPS_BROWSER_KEY, in Vercel only) is not a secret the way a server key is: every page that
// uses Google's box shows it to the browser. It is kept out of the code (and GitHub) and limited by Google to Havana's
// web addresses and to the Maps JavaScript API and Places UI Kit.
import { siteScope } from './sites.js';

// The restaurant's Google place (the place ID is the one thing Google lets us keep).
export const GOOGLE_PLACES = {
  2: 'ChIJozuRrlFYwokRDQQBl8uRDKI',          // Havana Social, 45 Stone St
};
export const reviewLink = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

export async function googleBox(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rid = siteScope(req);
  const placeId = rid ? GOOGLE_PLACES[rid] : null;
  if (!placeId) return res.status(200).json({ ready: false });
  const review = reviewLink(placeId);
  const key = String(process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  if (!key) return res.status(200).json({ ready: false, review });
  return res.status(200).json({ ready: true, key, place: placeId, review });
}
