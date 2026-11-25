// api/_lib/google.js — the restaurant's Google rating on its home page.
//
// r69 (25 Nov 2026, Sebastian 03:29: "make the stars as we had them but set "Google's Rating" and create the system
// inside the manager settings to change it manually"): the restaurant types its Google rating in Settings →
// Google's Rating (two numbers, copied from Google Maps), and the home page shows it with our own stars:
// "Google's Rating · 4.2 (504)". Nothing is asked from Google: no key, no Google Cloud, nothing to pay.
// (r64–r67 asked Google's Places API on every visit; r68 showed Google's own box. Both are gone.)
//
// { action: 'google_rating' } through /api/reservations (no login; the website says which restaurant):
//   → { ready: true, score, count, review }   what the restaurant typed, and the "write a review" link
//   → { ready: false, review }                nothing typed yet (or before migration 46): "Rate us on Google"
//   → { ready: false }                        a restaurant with no Google place here
// Settings (staff.js): googleRatingOf() for the card, saveGoogleRating() for its Save.
import { sb, LEVEL } from './roles.js';
import { siteScope } from './sites.js';

// The restaurant's Google place: only for the "write a review" link.
export const GOOGLE_PLACES = {
  2: 'ChIJozuRrlFYwokRDQQBl8uRDKI',          // Havana Social, 45 Stone St
};
export const reviewLink = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;
export const STALE_DAYS = 30;                // Settings asks for a check after this many days

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// The two numbers as typed: { score, count } or { error } in plain words. Both empty = take it off the home page.
export function cleanGoogleRating(rawScore, rawCount) {
  const s = rawScore === null || rawScore === undefined ? '' : String(rawScore).trim().replace(',', '.');
  // the count as Google Maps writes it: 504, 1,234 (or 1.234, 1 234, as some phones write it)
  const c0 = rawCount === null || rawCount === undefined ? '' : String(rawCount).trim();
  const c = /^\d{1,3}([,.\s]\d{3})+$/.test(c0) ? c0.replace(/[,.\s]/g, '') : c0;
  if (!s && !c) return { score: null, count: null };
  if (!s) return { error: 'Type the rating too (for example 4.2), or leave both empty.' };
  if (!c) return { error: 'Type the number of reviews too (for example 504), or leave both empty.' };
  if (!/^\d(\.\d)?$/.test(s)) return { error: 'The rating is a number from 1.0 to 5.0 with one decimal, as Google Maps shows it (for example 4.2).' };
  const score = Number(s);
  if (!(score >= 1 && score <= 5)) return { error: 'The rating is a number from 1.0 to 5.0 (for example 4.2).' };
  if (!/^\d{1,8}$/.test(c) || Number(c) > 10000000) return { error: 'The number of reviews is a whole number, as Google Maps shows it (for example 504).' };
  return { score, count: Number(c) };
}

// For Settings: { ready, place, score, count, changedOn, changedBy, days, stale, mapsLink }.
// place false = this restaurant has no Google place here (the card is not shown).
export async function googleRatingOf(rid, timezone = 'America/New_York') {
  const place = GOOGLE_PLACES[Number(rid)] || null;
  const got = await sb(`/restaurants?id=eq.${Number(rid)}&select=google_score,google_count,google_at,google_by,social_google,name&limit=1`);
  if (!got.ok || !Array.isArray(got.data) || !got.data[0]) return { ready: false, place: !!place };
  const r = got.data[0];
  let by = null;
  if (r.google_by) {
    const t = await sb(`/tasters?id=eq.${Number(r.google_by)}&select=first_name`);
    by = t.ok && Array.isArray(t.data) && t.data[0] ? (String(t.data[0].first_name || '').trim().split(/\s+/)[0] || null) : null;
  }
  const at = r.google_at ? new Date(r.google_at) : null;
  const on = at ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }).format(at) : null;
  const days = at ? Math.floor((Date.now() - at.getTime()) / 86400000) : null;
  const score = num(r.google_score), count = num(r.google_count);
  return {
    ready: true, place: !!place, score, count, changedOn: on, changedBy: by, days,
    stale: score !== null && days !== null && days >= STALE_DAYS,
    // where to look: the restaurant's own Google Maps link (Settings → Social media), or a search by its name
    mapsLink: r.social_google || (place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r.name || '')}&query_place_id=${encodeURIComponent(place)}` : null),
  };
}

// The reminder at the top of Manager: { days } when the numbers are shown and were last saved STALE_DAYS or more
// days ago; null otherwise (nothing typed, no Google place, or before migration 46).
export async function googleStale(rid) {
  if (!GOOGLE_PLACES[Number(rid)]) return null;
  const got = await sb(`/restaurants?id=eq.${Number(rid)}&select=google_score,google_at&limit=1`);
  const r = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!r || r.google_score === null || !r.google_at) return null;
  const days = Math.floor((Date.now() - new Date(r.google_at).getTime()) / 86400000);
  return days >= STALE_DAYS ? { days } : null;
}

// Settings → Google's Rating → Save. Managers and owners; crew see the card but cannot change it.
// body: { score, count } — both empty takes it off the home page.
export async function saveGoogleRating(req, res, body, tasterId, { gate, tellChange, timezoneOf }) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  if (!GOOGLE_PLACES[who.rid]) return res.status(400).json({ error: 'This restaurant has no Google place set up yet. Ask Seb’s Analytics.' });
  const c = cleanGoogleRating(body.score, body.count);
  if (c.error) return res.status(400).json({ error: c.error });
  const was = await sb(`/restaurants?id=eq.${who.rid}&select=google_score,google_count`);
  if (!was.ok) {
    const code = was.data && was.data.code;
    if (was.status === 400 && (code === '42703' || code === 'PGRST204' || !code)) return res.status(409).json({ error: 'Google’s Rating is not set up yet: migration 46 has not been run.' });
    return res.status(502).json({ error: 'Could not read Google’s Rating (the database answered ' + was.status + '). Please try again.' });
  }
  const before = was.data && was.data[0] ? { score: num(was.data[0].google_score), count: num(was.data[0].google_count) } : { score: null, count: null };
  const saved = await sb(`/restaurants?id=eq.${who.rid}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ google_score: c.score, google_count: c.count, google_at: new Date().toISOString(), google_by: tasterId }),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
    const st = saved.status, code = saved.data && saved.data.code;
    console.error('[google] save failed', who.rid, st, code || '');
    if (st === 400 && (!code || code === 'PGRST204' || code === '42703')) return res.status(409).json({ error: 'Google’s Rating is not set up yet: migration 46 has not been run.' });
    if (st === 400 && code === '23514') return res.status(400).json({ error: 'Those numbers don’t look right. The rating is 1.0 to 5.0 and the reviews a whole number.' });
    if (st === 401 || st === 403) return res.status(502).json({ error: 'Could not save Google’s Rating (the database answered ' + st + '): the server is missing its permission. Seb’s Analytics has to run migration 46 again.' });
    return res.status(502).json({ error: 'Could not save Google’s Rating (the database answered ' + st + '). Please try again.' });
  }
  const words = (x) => (x.score === null ? 'none' : x.score.toFixed(1) + (x.count === null ? '' : ' (' + x.count.toLocaleString('en-US') + ')'));
  console.log('[google] taster', tasterId, 'saved Google’s Rating of', who.rid, words(before), '→', words(c));
  if (before.score !== c.score || before.count !== c.count) {
    await tellChange(who.rid, tasterId, c.score === null
      ? `took Google’s Rating off the home page (it was ${words(before)})`
      : `changed Google’s Rating on the home page: ${words(before)} → ${words(c)}`, { go: 'settings' });
  }
  const tz = timezoneOf ? await timezoneOf(who.rid) : 'America/New_York';
  return res.status(200).json({ success: true, googleRating: await googleRatingOf(who.rid, tz) });
}

// The home page: what the restaurant typed. Nothing typed (or before migration 46): only the link.
export async function googleRating(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rid = siteScope(req);
  const placeId = rid ? GOOGLE_PLACES[rid] : null;
  if (!placeId) return res.status(200).json({ ready: false });
  const review = reviewLink(placeId);
  const got = await sb(`/restaurants?id=eq.${Number(rid)}&select=google_score,google_count&limit=1`).catch(() => null);
  const r = got && got.ok && Array.isArray(got.data) ? got.data[0] : null;
  const score = r ? num(r.google_score) : null, count = r ? num(r.google_count) : null;
  if (!(score >= 1 && score <= 5) || !(count >= 0)) return res.status(200).json({ ready: false, review });
  return res.status(200).json({ ready: true, score, count, review });
}
