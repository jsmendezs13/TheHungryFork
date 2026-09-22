// api/checkins.js
//
// The check-in code a guest shows at the table, and the calendar of visits
// behind it. These were two files, api/checkin-token.js and api/my-checkins.js,
// and they are one now because Vercel's free plan allows twelve serverless
// functions in a deployment — the reservation screen needed the room. Nothing
// about how either one works has changed: same checks, same answers, same
// limits. Only the address moved, to /api/checkins with an "action".
//
// Both refuse to say anything about anyone but the account that asked. The
// taster id comes from the signed token and from nowhere else, so there is no
// parameter to tamper with.

import QRCode from 'qrcode';
import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import { tasterIdFromRequest, sb } from './_lib/roles.js';
import {
  TOKEN_SECONDS, makeToken, hashToken, makeShortCode, siteUrl, newYorkDate,
} from './_lib/checkin.js';

// The screen refreshes itself every ninety seconds while it is open, so a
// customer waiting five minutes for a table legitimately asks for a few. This
// is loose enough never to interrupt that and tight enough that nobody farms
// tokens.
const issueLimiter = makeLimiter({ requests: 60, window: '10 m', prefix: 'checkin:issue' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || 'token');

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  if (action === 'token') return issueToken(req, res, tasterId);
  if (action === 'list')  return listVisits(req, res, tasterId);
  return res.status(400).json({ error: 'Unknown action.' });
}

// ── "I AM HERE" ───────────────────────────────────────────────────────────────
async function issueToken(req, res, tasterId) {
  if (!(await allow(issueLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many codes at once. Wait a minute and try again.' });
  }

  const token = makeToken();
  const expiresAt = new Date(Date.now() + TOKEN_SECONDS * 1000);

  // The short code has to be unique among the codes that are still alive. Six
  // characters from an alphabet of 31 is about a billion combinations against
  // at most a handful of live tokens, so a clash is a curiosity rather than a
  // risk — but "a curiosity" is not "impossible", and a clash would check in
  // the wrong person. Three tries, then the QR alone.
  let shortCode = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = makeShortCode();
    const clash = await sb(
      `/check_in_tokens?short_code=eq.${candidate}&used_at=is.null` +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`
    );
    if (clash.ok && Array.isArray(clash.data) && clash.data.length === 0) { shortCode = candidate; break; }
  }

  const created = await sb('/check_in_tokens', {
    method: 'POST',
    body: JSON.stringify({
      token_hash: hashToken(token),
      taster_id:  tasterId,
      short_code: shortCode,
      expires_at: expiresAt.toISOString(),
    }),
  });
  if (!created.ok) {
    console.error('[checkins:token] insert failed', created.status, created.data?.message);
    return res.status(500).json({
      error: 'Could not create your check-in code (the database answered ' + created.status + '). '
           + (created.status === 404
               ? 'That usually means migration 7 has not been run yet.'
               : 'If that is a 401 or 403, service_role is missing its grant on check_in_tokens.'),
    });
  }

  // Housekeeping, here rather than in a scheduled job: this table is pure
  // litter an hour later, and the person who just made a row is the right
  // person to sweep up their own. Failure is ignored — a stale row nobody can
  // use is not a reason to refuse somebody a check-in code.
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await sb(
      `/check_in_tokens?taster_id=eq.${tasterId}&expires_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE' }
    );
  } catch (e) {
    console.error('[checkins:token] sweep failed', e?.message);
  }

  const url = `${siteUrl()}/checkin.html?t=${encodeURIComponent(token)}`;

  // Drawn on the server, as an SVG. No QR library in the browser, no request to
  // a QR website, and nothing about this customer ever leaves our own servers
  // to have a picture made of it.
  //
  // Error correction M, not H: the code has to survive a fingerprint on a
  // screen, not a sun-bleached sticker on a window. M keeps the squares big,
  // which is what actually matters when one phone photographs another.
  let svg;
  try {
    svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#2B211A', light: '#FFFFFF' },
    });
  } catch (e) {
    console.error('[checkins:token] qr failed', e?.message);
    return res.status(500).json({ error: 'Could not draw your check-in code.' });
  }

  return res.status(200).json({
    success:   true,
    svg,
    shortCode,
    expiresAt: expiresAt.toISOString(),
    seconds:   TOKEN_SECONDS,
  });
}

// ── THE TWO CALENDARS ─────────────────────────────────────────────────────────
async function listVisits(req, res, tasterId) {
  const rows = await sb(
    `/check_ins?taster_id=eq.${tasterId}&select=restaurant_id,visit_date&order=visit_date.desc&limit=2000`
  );
  if (!rows.ok || !Array.isArray(rows.data)) {
    console.error('[checkins:list] read failed', rows.status, rows.data?.message);
    return res.status(502).json({
      error: 'Could not read your visits (the database answered ' + rows.status + '). '
           + (rows.status === 404
               ? 'That usually means migration 7 has not been run yet.'
               : 'If that is a 401 or 403, service_role is missing its grant on check_ins.'),
    });
  }

  // Names for the restaurant picker. Only the ones they have actually been to
  // — a list of every restaurant on the platform would be a list of places
  // they have never been, which is not a calendar.
  const ids = [...new Set(rows.data.map((r) => r.restaurant_id))];
  let names = {};
  if (ids.length) {
    const places = await sb(`/restaurants?id=in.(${ids.join(',')})&select=id,name`);
    (Array.isArray(places.data) ? places.data : []).forEach((p) => { names[p.id] = p.name; });
  }

  return res.status(200).json({
    success: true,
    today:   newYorkDate(),   // the browser's clock may be in another timezone
    visits:  rows.data.map((r) => ({
      restaurantId: r.restaurant_id,
      date:         r.visit_date,     // YYYY-MM-DD, already New York
    })),
    restaurants: ids.map((id) => ({ id, name: names[id] || 'Restaurant' })),
  });
}
