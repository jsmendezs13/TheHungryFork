// api/_lib/google.js — r64 (24 Nov 2026, Sebastian 22:56): "put Google's stars there now, and if the person taps it,
// take them to rate the restaurant directly".
//
// { action: 'google_rating' } through /api/reservations (no login; the website says which restaurant, as everywhere):
//   → { ready: true, score, count, review }   live from Google (Places API, Place Details: rating, userRatingCount)
//   → { ready: false, review }                 no key in Vercel yet, or Google didn't answer: the page shows only the
//                                              "Rate us on Google Maps" link
//   → { ready: false }                         a restaurant with no Google place here
// Google's rules for this data: nothing is stored or kept here but the place ID (no cache), the page writes
// "Google Maps" beside it, and the numbers are Google's as they are now. Each call is one Place Details request
// (billed by Google past the free monthly amount), so it runs once per page view and is limited per address.
// The key: GOOGLE_MAPS_API_KEY in Vercel only (restricted to the Places API (New)); never in the code or the chat.
import { makeLimiter, allow, keyFor, clientIp } from './auth.js';
import { siteScope } from './sites.js';

// The restaurant's Google place (the place ID is the one thing Google lets us keep).
export const GOOGLE_PLACES = {
  2: 'ChIJozuRrlFYwokRDQQBl8uRDKI',          // Havana Social, 45 Stone St
};
const BASE = process.env.GOOGLE_PLACES_BASE || 'https://places.googleapis.com/v1/places/';   // tests point it elsewhere
const limiter = makeLimiter({ requests: 30, window: '10 m', prefix: 'google:rating' });
export const reviewLink = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

export async function googleRating(req, res) {
  const rid = siteScope(req);
  const placeId = rid ? GOOGLE_PLACES[rid] : null;
  if (!placeId) return res.status(200).json({ ready: false });
  const review = reviewLink(placeId);
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(200).json({ ready: false, review });
  if (!(await allow(limiter, keyFor('g' + clientIp(req)), { failOpen: true }))) return res.status(200).json({ ready: false, review });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(BASE + encodeURIComponent(placeId), {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'rating,userRatingCount' }, signal: ctl.signal,
    });
    const d = await r.json().catch(() => ({}));
    const score = Number(d.rating), count = Number(d.userRatingCount);
    if (!r.ok || !(score >= 1 && score <= 5)) {
      console.warn('[google] no rating', r.status, d && d.error ? d.error.status : '');
      return res.status(200).json({ ready: false, review });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ready: true, score: Math.round(score * 10) / 10, count: Number.isInteger(count) && count >= 0 ? count : null, review });
  } catch (e) {
    console.warn('[google] failed', e && e.name);
    return res.status(200).json({ ready: false, review });
  } finally { clearTimeout(t); }
}
