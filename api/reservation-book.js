// api/reservation-book.js
//
// Taking the table.
//
// The decision is not made here. This endpoint checks that the request is
// sane, then calls hf_book, which takes a lock on that restaurant and day,
// re-checks the seats and the tables, and inserts — so two guests tapping the
// last table at the same second cannot both get it. Anything this file
// believed about availability a moment ago is only a guess; the database has
// the last word, and it says why in one word.

import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone, validateName } from './_lib/auth.js';
import { sb, tasterIdFromRequest } from './_lib/roles.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, clockIn,
  cleanParty, cleanPhone, cleanText, cleanEmail, BOOK_MESSAGES,
} from './_lib/booking.js';

// A booking costs the restaurant a table, so these refuse rather than fail open:
// an unlimited booking endpoint is a machine for filling a dining room with
// guests who do not exist. Same reasoning as send-otp, which spends money.
const ipLimiter    = makeLimiter({ requests: 10, window: '1 h',  prefix: 'resv:book:ip' });
const phoneLimiter = makeLimiter({ requests: 4,  window: '24 h', prefix: 'resv:book:phone' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const restaurantId = Number(body.restaurantId) || DEFAULT_RESTAURANT_ID;

  const loaded = await loadBooking(restaurantId);
  if (!loaded || loaded.error) {
    return res.status(loaded && loaded.error ? 502 : 404).json({
      error: loaded && loaded.error
        ? 'Could not read the booking settings. Please try again in a moment.'
        : 'Restaurant not found.',
    });
  }
  const booking = publicSettings(loaded.settings);
  const timezone = booking.timezone || 'America/New_York';
  if (!booking.enabled) {
    return res.status(409).json({ error: BOOK_MESSAGES.closed, reason: 'closed' });
  }

  // ── what the guest sent ──────────────────────────────────────────────────
  const name = validateName(body.name, 'name');
  if (!name || !name.ok || name.value.length < 2) {
    return res.status(400).json({ error: (name && name.error) || 'Please write the name for the table.' });
  }
  const phone = cleanPhone(body.phone, normalizeUsPhone);
  if (!phone) return res.status(400).json({ error: 'Please write a phone number the restaurant can call.' });

  const party = cleanParty(body.party, 50);
  if (!party) return res.status(400).json({ error: BOOK_MESSAGES.bad_party, reason: 'bad_party' });
  if (party > booking.maxPartyInstant) {
    return res.status(409).json({ error: BOOK_MESSAGES.too_big, reason: 'too_big' });
  }

  const at = new Date(String(body.at || ''));
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Please pick a time.' });
  if (at.getTime() < Date.now() - 60 * 1000) {
    return res.status(409).json({ error: BOOK_MESSAGES.past, reason: 'past' });
  }

  const email = cleanEmail(body.email);
  const notes = cleanText(body.notes, 400);

  // ── how often ────────────────────────────────────────────────────────────
  if (!(await allow(ipLimiter, keyFor(clientIp(req)), { failOpen: false }))) {
    return res.status(429).json({
      error: 'Too many bookings from this connection. Please call the restaurant instead.',
    });
  }
  if (!(await allow(phoneLimiter, keyFor(phone), { failOpen: false }))) {
    return res.status(429).json({
      error: 'That number already has several bookings today. Please call the restaurant instead.',
    });
  }

  // ── one table per phone, per day ─────────────────────────────────────────
  // Not a rule the database can enforce (a family really can book lunch and
  // dinner from one phone, and staff do it all the time), but a guest who taps
  // twice should get their own booking back rather than a second table.
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);

  const existing = await sb(
    `/reservations?restaurant_id=eq.${restaurantId}&guest_phone=eq.${encodeURIComponent(phone)}` +
    `&local_date=eq.${localDate}&status=in.(booked,seated)&select=id,code,reserved_at,party_size&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
    const row = existing.data[0];
    return res.status(200).json({
      success: true,
      already: true,
      code: row.code,
      at: new Date(row.reserved_at).toISOString(),
      party: row.party_size,
      date: localDate,
      ...clockIn(timezone, row.reserved_at),
      message: 'You already have a table that day. Here it is again.',
    });
  }

  // ── the database decides ─────────────────────────────────────────────────
  // A signed-in taster gets their booking tied to their account, so it can
  // appear in their own screens later. Nobody has to be signed in to eat here.
  const tasterId = tasterIdFromRequest(req);

  const booked = await sb('/rpc/hf_book', {
    method: 'POST',
    body: JSON.stringify({
      p_restaurant: restaurantId,
      p_slot:       at.toISOString(),
      p_party:      party,
      p_name:       name.value,
      p_phone:      phone,
      p_email:      email,
      p_taster:     tasterId,
      p_notes:      notes,
      p_source:     'web',
      p_created_by: null,
    }),
  });

  if (!booked.ok || !Array.isArray(booked.data) || !booked.data.length) {
    console.error('[reservation-book] hf_book failed', booked.status, booked.data?.message);
    return res.status(502).json({
      error: 'Could not take the booking (the database answered ' + booked.status + '). '
           + 'If that is a 404, migration 14 has not been run; if it is a 401 or 403, '
           + 'service_role is missing execute on hf_book.',
    });
  }

  const result = booked.data[0];
  if (!result.ok) {
    const reason = result.reason || 'taken';
    return res.status(409).json({ error: BOOK_MESSAGES[reason] || BOOK_MESSAGES.taken, reason });
  }

  // The area is named for the staff, not the guest ("Bar" is a different
  // evening from "Dining room"), so it goes back to the screen as well.
  let areaName = null;
  if (result.area_id) {
    const area = await sb(`/restaurant_areas?id=eq.${result.area_id}&select=name`);
    if (area.ok && Array.isArray(area.data) && area.data.length) areaName = area.data[0].name;
  }

  return res.status(200).json({
    success:  true,
    code:     result.code,
    at:       at.toISOString(),
    date:     localDate,
    party,
    areaName,
    holdMinutes: booking.holdMinutes,
    restaurant:  loaded.restaurant,
    ...clockIn(timezone, at),
  });
}
