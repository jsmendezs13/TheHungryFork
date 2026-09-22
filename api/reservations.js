// api/reservations.js
//
// Everything a guest does with a table, behind one address.
//
// It began as three files — the free times, taking the table, and the request
// for a big party. Vercel's free plan allows twelve serverless functions in a
// deployment and the site already had twelve, so three more meant nothing
// deployed at all. One file with an "action" is the honest fix rather than a
// workaround: these three things share the same settings, the same restaurant
// and the same rules, and they were always going to be read together.
//
// The decision about whether a table is free is not made here. It lives in the
// database (migrations 14 and 15), where the lock is.

import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone, validateName } from './_lib/auth.js';
import { sb, tasterIdFromRequest } from './_lib/roles.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, todayIn, clockIn,
  freeSlots, isOpenOn, cleanDate, cleanParty, cleanPhone, cleanText, cleanEmail, BOOK_MESSAGES,
} from './_lib/booking.js';

// Reading is generous — the screen asks again on every tap. Writing is not, and
// it refuses rather than failing open: an unlimited booking endpoint is a
// machine for filling a dining room with guests who do not exist.
const readLimiter     = makeLimiter({ requests: 240, window: '10 m', prefix: 'resv:slots' });
const bookIpLimiter   = makeLimiter({ requests: 10,  window: '1 h',  prefix: 'resv:book:ip' });
const bookPhoneLimit  = makeLimiter({ requests: 4,   window: '24 h', prefix: 'resv:book:phone' });
const reqIpLimiter    = makeLimiter({ requests: 6,   window: '1 h',  prefix: 'resv:req:ip' });
const reqPhoneLimiter = makeLimiter({ requests: 4,   window: '24 h', prefix: 'resv:req:phone' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || 'slots');

  if (action === 'slots')   return slots(req, res, body);
  if (action === 'book')    return book(req, res, body);
  if (action === 'request') return request(req, res, body);
  return res.status(400).json({ error: 'Unknown action.' });
}

// ── WHAT TIMES ARE FREE ───────────────────────────────────────────────────────
// Public on purpose: a guest choosing a table has no account, and asking them to
// make one before they can see whether 7pm is free is how restaurants lose
// bookings. Nothing here says anything about other guests — only that a time is
// free for the size of party asked about, which is what the restaurant would say
// on the phone.
async function slots(req, res, body) {
  // failOpen: true — this is only a read. If Redis is asleep, showing the
  // restaurant's free times is better than showing nobody anything.
  if (!(await allow(readLimiter, keyFor(clientIp(req)), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }

  const restaurantId = Number(body.restaurantId) || DEFAULT_RESTAURANT_ID;

  const loaded = await loadBooking(restaurantId);
  if (loaded && loaded.error) {
    console.error('[reservations:slots] settings read failed', loaded.status);
    return res.status(502).json({
      error: 'Could not read the booking settings (the database answered ' + loaded.status + '). '
           + (loaded.status === 404
               ? 'That usually means migration 14 has not been run yet.'
               : 'If that is a 401 or 403, service_role is missing its grant on restaurant_booking_settings.'),
    });
  }
  if (!loaded) return res.status(404).json({ error: 'Restaurant not found.' });

  const booking = publicSettings(loaded.settings);
  const timezone = booking.timezone || 'America/New_York';
  const today = todayIn(timezone);

  // Switched off, or migration 14 ran and the manager has not been in yet:
  // the page turns this into "call the restaurant", not into an error.
  if (!booking.enabled) {
    return res.status(200).json({
      success: true, restaurant: loaded.restaurant, booking: { ...booking, today }, slots: [],
    });
  }

  const date = cleanDate(body.date) || today;
  const party = cleanParty(body.party, booking.maxPartyInstant) || 2;

  const [open, free] = await Promise.all([
    isOpenOn(restaurantId, date),
    freeSlots(restaurantId, date, party, timezone),
  ]);

  if (!free.ok) {
    console.error('[reservations:slots] hf_free_slots failed', free.status);
    return res.status(502).json({
      error: 'Could not read the free times (the database answered ' + free.status + '). '
           + 'If that is a 404, migration 14 has not been run; if it is a 401 or 403, '
           + 'service_role is missing execute on hf_free_slots.',
    });
  }

  return res.status(200).json({
    success:    true,
    restaurant: loaded.restaurant,
    booking:    { ...booking, today },
    date,
    party,
    closed:     open === false,          // a holiday, or a day they never open
    slots:      free.slots,
  });
}

// ── TAKING THE TABLE ──────────────────────────────────────────────────────────
// This checks that the request is sane, then calls hf_book, which takes a lock
// on that restaurant and day, re-checks the seats and the tables, and inserts.
// Two guests tapping the last table at the same second cannot both get it.
async function book(req, res, body) {
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
  if (!(await allow(bookIpLimiter, keyFor(clientIp(req)), { failOpen: false }))) {
    return res.status(429).json({
      error: 'Too many bookings from this connection. Please call the restaurant instead.',
    });
  }
  if (!(await allow(bookPhoneLimit, keyFor(phone), { failOpen: false }))) {
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
    console.error('[reservations:book] hf_book failed', booked.status, booked.data?.message);
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

// ── NINE OR MORE, AND PRIVATE EVENTS ──────────────────────────────────────────
// A big table is not a slot on a grid — it is a conversation about the back room,
// a set menu and whether anyone is bringing a cake. So nothing is booked here:
// what the guest wants is written down for the restaurant to answer.
async function request(req, res, body) {
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

  const name = validateName(body.name, 'name');
  if (!name || !name.ok || name.value.length < 2) {
    return res.status(400).json({ error: (name && name.error) || 'Please write your name.' });
  }
  const phone = cleanPhone(body.phone, normalizeUsPhone);
  if (!phone) return res.status(400).json({ error: 'Please write a phone number the restaurant can call.' });

  const party = cleanParty(body.party, booking.maxPartyRequest || 40);
  if (!party) {
    return res.status(400).json({
      error: 'Please say how many people are coming (up to ' + (booking.maxPartyRequest || 40) + ').',
    });
  }

  const date = cleanDate(body.date);
  if (!date) return res.status(400).json({ error: 'Please pick a day.' });
  if (date < todayIn(timezone)) return res.status(400).json({ error: 'That day has already passed.' });

  // The time is optional on purpose: "some evening in December" is a real
  // enquiry, and forcing a fake time on it only makes the restaurant call back
  // to ask what the guest actually meant.
  const rawTime = String(body.time || '').trim();
  const time = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : null;

  if (!(await allow(reqIpLimiter, keyFor(clientIp(req)), { failOpen: false }))
      || !(await allow(reqPhoneLimiter, keyFor(phone), { failOpen: false }))) {
    return res.status(429).json({
      error: 'Too many requests from here today. Please call the restaurant instead.',
    });
  }

  const created = await sb('/reservation_requests', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      restaurant_id: restaurantId,
      taster_id:     tasterIdFromRequest(req),
      guest_name:    name.value,
      guest_phone:   phone,
      guest_email:   cleanEmail(body.email),
      party_size:    party,
      wanted_date:   date,
      wanted_time:   time,
      occasion:      cleanText(body.occasion, 60),
      message:       cleanText(body.message, 1000),
    }),
  });

  if (!created.ok) {
    console.error('[reservations:request] insert failed', created.status, created.data?.message);
    return res.status(502).json({
      error: 'Could not send your request (the database answered ' + created.status + '). '
           + (created.status === 404
               ? 'That usually means migration 14 has not been run yet.'
               : 'If that is a 401 or 403, service_role is missing its grant on reservation_requests.'),
    });
  }

  const row = Array.isArray(created.data) ? created.data[0] : null;
  return res.status(200).json({
    success:    true,
    requestId:  row ? row.id : null,
    restaurant: loaded.restaurant,
    date,
    time,
    party,
  });
}
