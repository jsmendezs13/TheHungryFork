// api/reservation-request.js
//
// Nine people or more, and private events.
//
// A big table is not a slot on a grid — it is a conversation about whether the
// back room is free, whether the kitchen can do a set menu, and whether anyone
// is bringing a cake. So this endpoint does not try to book anything. It writes
// down what the guest wants and lets the restaurant answer, which is the part
// Red Pepper Media charges a commission for.

import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone, validateName } from './_lib/auth.js';
import { sb, tasterIdFromRequest } from './_lib/roles.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, todayIn,
  cleanDate, cleanParty, cleanPhone, cleanText, cleanEmail,
} from './_lib/booking.js';

const ipLimiter    = makeLimiter({ requests: 6, window: '1 h',  prefix: 'resv:req:ip' });
const phoneLimiter = makeLimiter({ requests: 4, window: '24 h', prefix: 'resv:req:phone' });

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

  if (!(await allow(ipLimiter, keyFor(clientIp(req)), { failOpen: false }))
      || !(await allow(phoneLimiter, keyFor(phone), { failOpen: false }))) {
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
    console.error('[reservation-request] insert failed', created.status, created.data?.message);
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
