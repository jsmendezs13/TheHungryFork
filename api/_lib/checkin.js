// api/_lib/checkin.js
//
// The small pieces the three check-in endpoints share: the ticket itself, and
// what day it is in New York.

import crypto from 'crypto';

// How long a QR on a customer's screen is worth anything. Long enough that the
// waiter can walk over; short enough that a screenshot sent to a friend on the
// other side of the city is already dead when it arrives.
export const TOKEN_SECONDS = 90;

// 32 random bytes, url-safe. Not a counter, not a hash of the account id —
// there is nothing in it to guess or increment.
export function makeToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// The database stores this, never the token. See migration 7.
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// The six characters printed under the QR, for the night the camera will not
// focus. No O/0, no I/1, no S/5 — the point is that somebody reads them aloud
// across a noisy dining room and somebody else types them correctly.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRTUVWXYZ';
export function makeShortCode() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// What the waiter typed, turned into what we stored. Lower case, spaces and
// the dash people insert in the middle all have to survive this.
export function normalizeShortCode(input) {
  const cleaned = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{6}$/.test(cleaned) ? cleaned : null;
}

// Today, in the only timezone that matters here: the one the restaurant is
// standing in. Used for display and for "have they already been in today?" —
// the visit_date column itself is filled by the database with the same rule, so
// the two can never drift.
export function newYorkDate(d = new Date()) {
  // en-CA gives YYYY-MM-DD, which is what Postgres wants and what sorts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Where the QR points. Set SITE_URL in Vercel if the domain ever changes;
// the fallback is the live site so nothing breaks if it is missing.
export function siteUrl() {
  const raw = process.env.SITE_URL || 'https://thehungryfork.fun';
  return raw.replace(/\/+$/, '');
}
