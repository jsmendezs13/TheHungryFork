// api/reservation-slots.js
//
// "What times are free?" — the only read the booking screen makes.
//
// It is public on purpose: a guest choosing a table has no account, and asking
// them to make one before they can see whether 7pm is free is how restaurants
// lose bookings. Nothing here tells the caller anything about other guests:
// they learn that a time is free, for the size of party they asked about, and
// that is all the restaurant would tell them on the phone.

import { makeLimiter, allow, keyFor, clientIp } from './_lib/auth.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, todayIn,
  freeSlots, isOpenOn, cleanDate, cleanParty,
} from './_lib/booking.js';

// Generous: the screen asks again every time the guest taps a day or a party
// size, and a couple deciding between Friday and Saturday will tap a lot.
const readLimiter = makeLimiter({ requests: 240, window: '10 m', prefix: 'resv:slots' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // failOpen: true — this is only a read. If Redis is asleep, showing the
  // restaurant's free times is better than showing nobody anything.
  if (!(await allow(readLimiter, keyFor(clientIp(req)), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const restaurantId = Number(body.restaurantId) || DEFAULT_RESTAURANT_ID;

  const loaded = await loadBooking(restaurantId);
  if (loaded && loaded.error) {
    console.error('[reservation-slots] settings read failed', loaded.status);
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
    console.error('[reservation-slots] hf_free_slots failed', free.status);
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
