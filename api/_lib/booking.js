// api/_lib/booking.js
//
// Shared by the three reservation endpoints. Files starting with _ are not
// turned into endpoints by Vercel.
//
// Everything about WHEN a table is free lives in the database (migrations 14
// and 15), not here: the hours, the holidays, the seats, the tables, the wait
// for a late guest, and the lock that stops two guests taking the last table at
// the same second. These helpers only ask the questions and dress the answers
// for a phone screen.

import { sb } from './roles.js';

export const DEFAULT_RESTAURANT_ID = 1;   // The Hungry Fork, until the site is multi-restaurant

// The settings row plus the restaurant's name, in one place. Returns null when
// the restaurant does not exist, and a row with enabled=false when the manager
// has not switched booking on — the page shows "call us" rather than an error.
export async function loadBooking(restaurantId) {
  const [settings, place] = await Promise.all([
    sb(`/restaurant_booking_settings?restaurant_id=eq.${restaurantId}&select=*`),
    sb(`/restaurants?id=eq.${restaurantId}&select=id,name,restaurant_phone,address,city,state,zip_code`),
  ]);

  if (!settings.ok || !place.ok) {
    return { error: true, status: settings.status || place.status };
  }
  const s = Array.isArray(settings.data) ? settings.data[0] : null;
  const r = Array.isArray(place.data) ? place.data[0] : null;
  if (!r) return null;

  return {
    restaurant: {
      id: r.id,
      name: r.name,
      phone: r.restaurant_phone || null,
      // For the confirmation screen and the calendar file the guest saves.
      address: [r.address, r.city, r.state, r.zip_code].filter(Boolean).join(', ') || null,
    },
    settings: s || null,
  };
}

// What the browser is allowed to know. The rest of the row (who edited it, when)
// is nobody's business on a public page.
export function publicSettings(s) {
  if (!s) return { enabled: false };
  return {
    enabled:          !!s.is_enabled,
    timezone:         s.timezone,
    slotMinutes:      s.slot_minutes,
    holdMinutes:      s.hold_minutes,
    bookAheadDays:    s.book_ahead_days,
    maxPartyInstant:  s.max_party_instant,
    maxPartyRequest:  s.max_party_request,
    graceMinutes:     s.grace_minutes,
  };
}

// Today where the restaurant is, not where the phone is. A guest in Madrid
// looking at a New York restaurant at 3am their time must still see today's
// evening, and a date is the one thing a browser clock gets wrong most often.
export function todayIn(timezone) {
  return new Intl.DateTimeFormat('en-CA', {          // en-CA gives YYYY-MM-DD
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// "7:00 PM" and "19:00" for a moment, in the restaurant's clock.
export function clockIn(timezone, iso) {
  const d = new Date(iso);
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return { label, time };
}

// YYYY-MM-DD, and nothing else. Anything a browser can send goes through here
// before it reaches SQL.
export function cleanDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text + 'T12:00:00Z'))
    ? text : null;
}

export function cleanParty(value, max = 50) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

// A phone number that a human can be called back on.
//
// The rest of the platform is US-only, because a taster's account is their US
// mobile. A reservation is not an account: tourists eat in restaurants, and a
// +44 number that the restaurant can ring is worth more than a refusal. So a US
// number is normalised the usual way, and anything else is kept as typed once
// it looks like a phone number at all.
export function cleanPhone(input, normalizeUs) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const us = normalizeUs(raw);
    if (us) return us;
  } catch { /* not a US number; fall through */ }
  const digits = raw.replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 7 && digits.length <= 20 ? digits : null;
}

export function cleanText(value, max) {
  const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : null;
}

// An email is optional — it only exists so the confirmation can be sent. A
// wrong one must never cost somebody their table, so this checks the shape and
// otherwise drops it silently.
export function cleanEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(text) && text.length <= 120 ? text : null;
}

// The free times for one day, straight from hf_free_slots.
export async function freeSlots(restaurantId, date, party, timezone) {
  const rows = await sb('/rpc/hf_free_slots', {
    method: 'POST',
    body: JSON.stringify({ p_restaurant: restaurantId, p_date: date, p_party: party }),
  });
  if (!rows.ok || !Array.isArray(rows.data)) return { ok: false, status: rows.status, slots: [] };

  return {
    ok: true,
    slots: rows.data.map((row) => ({
      at:       new Date(row.slot_at).toISOString(),
      areaId:   row.area_id,
      areaName: row.area_name,
      ...clockIn(timezone, row.slot_at),
    })),
  };
}

// Is the restaurant open at all that day? Empty means a holiday, or a weekday
// they never open — which reads very differently to a guest than "full".
export async function isOpenOn(restaurantId, date) {
  const rows = await sb('/rpc/hf_service_windows', {
    method: 'POST',
    body: JSON.stringify({ p_restaurant: restaurantId, p_date: date }),
  });
  if (!rows.ok || !Array.isArray(rows.data)) return null;      // unknown, not "closed"
  return rows.data.length > 0;
}

// The database says why in one word. The guest gets a sentence.
export const BOOK_MESSAGES = {
  closed:    'This restaurant is not taking bookings online yet.',
  too_big:   'For nine people or more, send a request and the restaurant will answer you.',
  past:      'That time has already passed. Please pick another one.',
  taken:     'Sorry — that table has just been taken. Please pick another time.',
  bad_party: 'Please choose how many people are coming.',
};
