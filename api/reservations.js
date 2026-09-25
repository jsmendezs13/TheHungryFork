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
//
// The emails (migration 16, api/_lib/email.js) live here too: the confirmation
// goes out with the booking, the link inside it cancels without an account
// (action "link" / "cancel_link"), and Vercel's daily cron calls this same
// address with GET for the reminders — no thirteenth function.
//
// And the restaurant's own side (api/_lib/staff.js): every action that starts
// with "staff_" is the Reservations tab in manager.html — the day, arrived and
// no-show, big-party requests, the hours, holidays, rooms and rules. It checks
// the caller's role in the database on every request.

import crypto from 'node:crypto';
import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone, validateName } from './_lib/auth.js';
import { sb, tasterIdFromRequest } from './_lib/roles.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, todayIn, clockIn,
  freeSlots, isOpenOn, cleanDate, cleanParty, cleanPhone, cleanText, cleanEmail, BOOK_MESSAGES,
} from './_lib/booking.js';
import {
  emailReady, senderFor, newLinkToken, saveLink, cancelUrl, cleanToken, hashToken,
  sendEmail, confirmationEmail, reminderEmail, hostOf, sendableAddress, mailboxKey,
} from './_lib/email.js';
import { staff } from './_lib/staff.js';

// The daily reminder can take a while on a busy day; 30 seconds is inside every
// Vercel plan's limit, so the run is never cut off halfway through a batch.
export const config = { maxDuration: 30 };

// Reading is generous — the screen asks again on every tap. Writing is not, and
// it refuses rather than failing open: an unlimited booking endpoint is a
// machine for filling a dining room with guests who do not exist.
const readLimiter     = makeLimiter({ requests: 240, window: '10 m', prefix: 'resv:slots' });
const bookIpLimiter   = makeLimiter({ requests: 10,  window: '1 h',  prefix: 'resv:book:ip' });
const bookPhoneLimit  = makeLimiter({ requests: 4,   window: '24 h', prefix: 'resv:book:phone' });
const reqIpLimiter    = makeLimiter({ requests: 6,   window: '1 h',  prefix: 'resv:req:ip' });
const reqPhoneLimiter = makeLimiter({ requests: 4,   window: '24 h', prefix: 'resv:req:phone' });
// The lesson from Twilio: anything that sends a message on our behalf is capped.
// A guest's address gets a handful of emails a day at most, whatever anybody
// types into the booking form, and the cancel links cannot be tried at speed.
const emailAddrLimiter = makeLimiter({ requests: 6,  window: '24 h', prefix: 'resv:email:addr' });
// And a ceiling for everything together: Resend's free plan sends 100 a day, so
// no mistake and no attack can ever run past it or into a bill.
const emailDayLimiter  = makeLimiter({ requests: 95, window: '24 h', prefix: 'resv:email:all' });
const linkLimiter      = makeLimiter({ requests: 30, window: '10 m', prefix: 'resv:link' });

const LINK_GONE = 'This link does not open a table any more. Please call the restaurant.';

export default async function handler(req, res) {
  // The one GET: Vercel's daily cron, carrying CRON_SECRET. Everybody else who
  // asks with GET gets the same 405 as before.
  if (req.method === 'GET' && isCron(req)) return remind(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || 'slots');

  if (action === 'slots')       return slots(req, res, body);
  if (action === 'book')        return book(req, res, body);
  if (action === 'request')     return request(req, res, body);
  if (action === 'mine')        return mine(req, res, body);
  if (action === 'cancel')      return cancel(req, res, body);
  if (action === 'link')        return byLink(req, res, body);
  if (action === 'cancel_link') return cancelByLink(req, res, body);
  // The confirmation email is lent to the staff side, so a big party the
  // manager says yes to hears about it the same way an online booking does.
  if (action.startsWith('staff_')) return staff(req, res, body, action, { confirmByEmail });
  return res.status(400).json({ error: 'Unknown action.' });
}

// Vercel sends "Authorization: Bearer <CRON_SECRET>" when it runs the cron. A
// secret shorter than 16 characters is treated as no secret at all, so an empty
// or half-typed variable can never open the door.
function isCron(req) {
  const secret = process.env.CRON_SECRET || '';
  if (secret.length < 16) return false;
  const got = Buffer.from(String((req.headers && req.headers.authorization) || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
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
    // The manager sets this number now, so the sentence says it.
    return res.status(409).json({
      error: `For ${booking.maxPartyInstant + 1} people or more, send a request and the restaurant will answer you.`,
      reason: 'too_big',
    });
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
    `&local_date=eq.${localDate}&status=in.(booked,seated)&select=id,code,reserved_at,party_size,guest_name&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
    const row = existing.data[0];
    // Given back only to the same guest tapping twice — same number AND same
    // name. A different name is simply another party (a family booking lunch and
    // dinner from one phone), so it books like anyone else, and the answer is the
    // same whether or not that number already had a table: typing somebody's
    // phone number tells you nothing about their evening (review, 22 Sep).
    const sameGuest = String(row.guest_name || '').trim().toLowerCase().replace(/\s+/g, ' ')
                   === name.value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (sameGuest) return res.status(200).json({
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
    try {
      const area = await sb(`/restaurant_areas?id=eq.${result.area_id}&select=name`);
      if (area.ok && Array.isArray(area.data) && area.data.length) areaName = area.data[0].name;
    } catch (err) {
      console.error('[reservations:book] area name failed', err && err.message);   // the table is booked; the name is decoration
    }
  }

  // The email is sent before answering, because a Vercel function can be frozen
  // the moment it answers. It is capped at a few seconds and can only ever turn
  // into "emailSent: false" — the table is already the guest's.
  // The try matters: by this line the table is the guest's. If anything in the
  // email throws, they must still see their code, not "something went wrong" —
  // which would send them straight back to book a second table.
  let emailSent = false;
  try {
    emailSent = await confirmByEmail({
      reservationId: result.reservation_id, email, loaded, timezone,
      at: at.toISOString(), party, areaName, code: result.code, guestName: name.value,
    });
  } catch (err) {
    console.error('[reservations:email] confirmation threw', result.reservation_id, err && err.message);
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
    emailSent,
    ...clockIn(timezone, at),
  });
}

// ── THE CONFIRMATION EMAIL ────────────────────────────────────────────────────
// Returns true only when Resend took the email. Every other outcome is written
// on the booking (email_error), so "why didn't I get an email?" has an answer.
async function confirmByEmail({ reservationId, email, loaded, timezone, at, party, areaName, code, guestName }) {
  const settings = loaded && loaded.settings;
  if (!email || !reservationId || !emailReady(settings)) return false;

  const to = sendableAddress(email);
  if (!to) {
    await noteEmail(reservationId, { email_error: 'Not sent: the address is not a plain email address' });
    return false;
  }
  if (!(await allow(emailAddrLimiter, keyFor(mailboxKey(to)), { failOpen: false }))) {
    await noteEmail(reservationId, { email_error: 'Not sent: this address has had too many emails today' });
    return false;
  }
  if (!(await allow(emailDayLimiter, keyFor('all'), { failOpen: false }))) {
    await noteEmail(reservationId, { email_error: 'Not sent: the daily email limit is reached' });
    return false;
  }

  const { token, hash } = newLinkToken();
  const linkSaved = await saveLink(reservationId, hash, 'confirmation');
  const sender = senderFor(settings, loaded.restaurant);
  const mail = confirmationEmail({
    restaurant: loaded.restaurant, timezone, at, party, areaName, code, guestName,
    // Only promise "after 30 minutes the table goes" if the restaurant does that.
    graceMinutes: settings.auto_release_late ? settings.grace_minutes : null,
    holdMinutes:  settings.hold_minutes,
    link:         linkSaved ? cancelUrl(settings, token) : null,
    siteHost:     hostOf(settings),
  });

  const sent = await sendEmail({
    from: sender.from, replyTo: sender.replyTo, to,
    subject: mail.subject, html: mail.html, text: mail.text, attachments: mail.attachments,
    idempotencyKey: `confirm-${code}`,
    tags: [{ name: 'kind', value: 'confirmation' }],
    timeoutMs: 4000,          // the guest is looking at a spinner
  });

  if (sent.ok) {
    const fields = { confirmation_sent_at: new Date().toISOString(), email_error: null };
    if (sent.id) fields.confirmation_email_id = sent.id;
    await noteEmail(reservationId, fields);
    return true;
  }
  console.error('[reservations:email] confirmation not sent', reservationId, sent.error);
  await noteEmail(reservationId, { email_error: sent.error });
  return false;
}

// A note on the booking about its emails. Never allowed to break anything.
async function noteEmail(reservationId, fields) {
  const done = await sb(`/reservations?id=eq.${Number(reservationId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
  if (!done.ok) console.error('[reservations:email] could not note on booking', reservationId, done.status);
  return done.ok;
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

// ── THE TABLES THIS GUEST HAS ─────────────────────────────────────────────────
// "My Reservations" in the corner menu. A signed-in taster sees their own
// bookings and nothing else.
//
// Matched two ways on purpose: by account, and by the phone number on the
// account. Most guests book without logging in — they type their number into
// the form — and it would be strange for the site to know about a table and
// then pretend it does not. The phone number comes from the tasters row, never
// from the request, so nobody can ask about somebody else's number.
async function mine(req, res, body) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const who = await sb(`/tasters?id=eq.${tasterId}&select=id,phone_number`);
  if (!who.ok || !Array.isArray(who.data) || !who.data.length) {
    return res.status(401).json({ error: 'Please log in again.' });
  }
  const phone = who.data[0].phone_number || null;

  const match = phone
    ? `or=(taster_id.eq.${tasterId},guest_phone.eq.${encodeURIComponent(phone)})`
    : `taster_id=eq.${tasterId}`;
  const rows = await sb(
    `/reservations?${match}&select=id,code,restaurant_id,area_id,party_size,reserved_at,local_date,` +
    `local_time,status,notes,hold_minutes&order=reserved_at.desc&limit=60`
  );
  if (!rows.ok || !Array.isArray(rows.data)) {
    console.error('[reservations:mine] read failed', rows.status);
    return res.status(502).json({ error: 'Could not read your tables. Please try again in a moment.' });
  }

  // The names, in two small reads rather than one clever join.
  const restaurantIds = [...new Set(rows.data.map((r) => r.restaurant_id))];
  const areaIds = [...new Set(rows.data.map((r) => r.area_id).filter(Boolean))];
  const [places, areas] = await Promise.all([
    restaurantIds.length ? sb(`/restaurants?id=in.(${restaurantIds.join(',')})&select=id,name,restaurant_phone`) : { data: [] },
    areaIds.length ? sb(`/restaurant_areas?id=in.(${areaIds.join(',')})&select=id,name`) : { data: [] },
  ]);
  const placeName = {}, placePhone = {}, areaName = {};
  (Array.isArray(places.data) ? places.data : []).forEach((p) => { placeName[p.id] = p.name; placePhone[p.id] = p.restaurant_phone; });
  (Array.isArray(areas.data) ? areas.data : []).forEach((a) => { areaName[a.id] = a.name; });

  const settings = await loadBooking(restaurantIds[0] || DEFAULT_RESTAURANT_ID);
  const timezone = (settings && settings.settings && settings.settings.timezone) || 'America/New_York';
  const now = Date.now();

  const dressed = rows.data.map((r) => ({
    id:         r.id,
    code:       r.code,
    at:         new Date(r.reserved_at).toISOString(),
    date:       r.local_date,
    party:      r.party_size,
    status:     r.status,
    notes:      r.notes,
    areaName:   r.area_id ? areaName[r.area_id] || null : null,
    restaurant: placeName[r.restaurant_id] || 'Restaurant',
    phone:      placePhone[r.restaurant_id] || null,
    // A table can be called off right up to the moment it starts. Sebastian's
    // decision: a guest who cancels late is still better than one who never
    // arrives and says nothing.
    canCancel:  r.status === 'booked' && new Date(r.reserved_at).getTime() > now,
    ...clockIn(timezone, r.reserved_at),
  }));

  return res.status(200).json({
    success:  true,
    today:    todayIn(timezone),
    upcoming: dressed.filter((r) => new Date(r.at).getTime() >= now && r.status !== 'cancelled')
                     .sort((a, b) => new Date(a.at) - new Date(b.at)),
    past:     dressed.filter((r) => new Date(r.at).getTime() < now || r.status === 'cancelled'),
  });
}

// ── GIVING THE TABLE BACK ─────────────────────────────────────────────────────
// The row is never deleted: a cancelled booking is part of how the restaurant
// reads its own week, and hf_free_slots already ignores it, so the seats and the
// table are free again the moment this returns.
async function cancel(req, res, body) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });

  const who = await sb(`/tasters?id=eq.${tasterId}&select=id,phone_number`);
  const phone = who.ok && Array.isArray(who.data) && who.data.length ? who.data[0].phone_number : null;

  const found = await sb(`/reservations?id=eq.${id}&select=id,taster_id,guest_phone,status,reserved_at,code`);
  if (!found.ok || !Array.isArray(found.data) || !found.data.length) {
    return res.status(404).json({ error: 'That table is not there any more.' });
  }
  const row = found.data[0];

  // Theirs, or booked with their phone number. Anything else is somebody
  // else's table, and the answer is the same as if it did not exist.
  const isTheirs = row.taster_id === tasterId || (phone && row.guest_phone === phone);
  if (!isTheirs) return res.status(404).json({ error: 'That table is not there any more.' });

  if (row.status === 'cancelled') return res.status(200).json({ success: true, already: true });
  if (row.status !== 'booked') {
    return res.status(409).json({ error: 'That table cannot be cancelled online any more. Please call the restaurant.' });
  }
  if (new Date(row.reserved_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'That time has already started. Please call the restaurant.' });
  }

  if (!(await releaseTable(id, tasterId))) {
    return res.status(502).json({ error: 'Could not cancel the table. Please call the restaurant.' });
  }

  return res.status(200).json({ success: true, code: row.code });
}

// The one place a table is given back, for the signed-in guest and for the link
// in an email alike. "&status=eq.booked" is the guard: if the staff seated the
// guest a second ago, nothing changes and the answer is false.
async function releaseTable(id, cancelledBy) {
  const now = new Date().toISOString();
  const done = await sb(`/reservations?id=eq.${Number(id)}&status=eq.booked`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'cancelled', cancelled_at: now, cancelled_by: cancelledBy || null, updated_at: now }),
  });
  if (!done.ok || !Array.isArray(done.data) || !done.data.length) {
    console.error('[reservations:cancel] update failed', id, done.status, done.data?.message);
    return false;
  }
  return true;
}

// ── THE LINK IN THE EMAIL ─────────────────────────────────────────────────────
// No account, no password: whoever holds the link holds the table, which is how
// a paper reservation card works too. The token is 192 random bits and only its
// SHA-256 is stored, so it cannot be guessed and cannot be read out of the
// database.
async function findByLink(token) {
  const link = await sb(`/reservation_links?token_hash=eq.${hashToken(token)}&select=reservation_id&limit=1`);
  if (!link.ok || !Array.isArray(link.data) || !link.data.length) return null;
  const row = await sb(
    `/reservations?id=eq.${Number(link.data[0].reservation_id)}` +
    `&select=id,code,restaurant_id,area_id,party_size,reserved_at,local_date,status,guest_name&limit=1`
  );
  if (!row.ok || !Array.isArray(row.data) || !row.data.length) return null;
  // A week after the table, the link is only an old email: it stops opening
  // anything, so a forwarded message does not show a name and a date forever.
  if (new Date(row.data[0].reserved_at).getTime() < Date.now() - LINK_LIFE_MS) return null;
  return row.data[0];
}
const LINK_LIFE_MS = 7 * 24 * 3600 * 1000;

async function byLink(req, res, body) {
  if (!(await allow(linkLimiter, keyFor(clientIp(req)), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many tries from here. Wait a moment, or call the restaurant.' });
  }
  const token = cleanToken(body.token);
  const row = token ? await findByLink(token) : null;
  if (!row) return res.status(404).json({ error: LINK_GONE });

  const loaded = await loadBooking(row.restaurant_id);
  const restaurant = loaded && !loaded.error ? loaded.restaurant : { name: 'The restaurant', phone: null };
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';

  let areaName = null;
  if (row.area_id) {
    const area = await sb(`/restaurant_areas?id=eq.${Number(row.area_id)}&select=name`);
    if (area.ok && Array.isArray(area.data) && area.data.length) areaName = area.data[0].name;
  }

  return res.status(200).json({
    success: true,
    booking: {
      code:       row.code,
      at:         new Date(row.reserved_at).toISOString(),
      date:       row.local_date,
      party:      row.party_size,
      status:     row.status,
      areaName,
      restaurant: restaurant.name,
      phone:      restaurant.phone || null,
      // First name only: a forwarded email should not hand a stranger the rest.
      firstName:  String(row.guest_name || '').trim().split(/\s+/)[0] || null,
      canCancel:  row.status === 'booked' && new Date(row.reserved_at).getTime() > Date.now(),
      ...clockIn(timezone, row.reserved_at),
    },
  });
}

async function cancelByLink(req, res, body) {
  // failOpen: false — this one writes.
  if (!(await allow(linkLimiter, keyFor(clientIp(req)), { failOpen: false }))) {
    return res.status(429).json({ error: 'Too many tries from here. Wait a moment, or call the restaurant.' });
  }
  const token = cleanToken(body.token);
  const row = token ? await findByLink(token) : null;
  if (!row) return res.status(404).json({ error: LINK_GONE });

  if (row.status === 'cancelled') return res.status(200).json({ success: true, already: true, code: row.code });
  if (row.status !== 'booked') {
    return res.status(409).json({ error: 'That table cannot be cancelled online any more. Please call the restaurant.' });
  }
  if (new Date(row.reserved_at).getTime() <= Date.now()) {
    return res.status(409).json({ error: 'That time has already started. Please call the restaurant.' });
  }
  if (!(await releaseTable(row.id, null))) {
    return res.status(502).json({ error: 'Could not cancel the table. Please call the restaurant.' });
  }
  return res.status(200).json({ success: true, code: row.code });
}

// ── THE REMINDER, ONCE A DAY ──────────────────────────────────────────────────
// vercel.json runs this at 14:00 UTC — 10 in the morning in New York, give or
// take the hour Vercel's free plan allows. hf_claim_reminders picks the tables
// that are due and marks them in the same step, so a doubled run sends nothing
// twice. A send that fails is handed back to the next run, unless Resend says
// the address itself is bad, which would only fail again.
const REMIND_BUDGET_MS = 15000;          // of the 30 seconds this function may run

async function remind(req, res) {
  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ success: true, skipped: 'RESEND_API_KEY is not set in Vercel' });
  }
  const started = Date.now();

  // 40 at most: the daily ceiling is 95, and the confirmations of the next 24
  // hours need most of it (a confirmation refused means no reminder later).
  const claimed = await sb('/rpc/hf_claim_reminders', { method: 'POST', body: JSON.stringify({ p_limit: 40 }) });
  if (!claimed.ok || !Array.isArray(claimed.data)) {
    console.error('[reservations:remind] claim failed', claimed.status, claimed.data?.message);
    return res.status(502).json({
      error: 'Could not pick the reminders (the database answered ' + claimed.status + '). '
           + 'If that is a 404, migration 16 has not been run.',
    });
  }
  const rows = claimed.data;
  if (!rows.length) return res.status(200).json({ success: true, claimed: 0, sent: 0, failed: 0, later: 0 });

  // From here on the rows are marked as taken. Whatever happens — a database
  // error, a crash — every row this run did not finish goes back, in one write,
  // so tomorrow's run can try again (found in review, 22 Sep).
  const handled = new Set();
  let sent = 0, failed = 0, later = 0, crashed = false;
  try {
    const places = {};
    for (const id of new Set(rows.map((r) => r.restaurant_id))) places[id] = await loadBooking(id);

    const areaIds = [...new Set(rows.map((r) => r.area_id).filter(Boolean))];
    const areas = areaIds.length ? await sb(`/restaurant_areas?id=in.(${areaIds.join(',')})&select=id,name`) : { data: [] };
    const areaName = {};
    (Array.isArray(areas.data) ? areas.data : []).forEach((a) => { areaName[a.id] = a.name; });

    // Four at a time: Resend accepts ten requests a second.
    for (let i = 0; i < rows.length; i += 4) {
      const batch = rows.slice(i, i + 4);
      if (Date.now() - started > REMIND_BUDGET_MS) { later += batch.length; continue; }   // handed back below
      const outcomes = await Promise.all(batch.map((r) => remindSafely(r, places[r.restaurant_id], areaName[r.area_id] || null)));
      outcomes.forEach((ok, k) => { handled.add(batch[k].id); if (ok) sent += 1; else failed += 1; });
    }
  } catch (err) {
    crashed = true;
    console.error('[reservations:remind] run failed', err && err.message);
  } finally {
    const back = rows.map((r) => r.id).filter((id) => !handled.has(id));
    if (back.length) {
      try {
        await sb(`/reservations?id=in.(${back.map(Number).join(',')})&reminder_email_id=is.null`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ reminder_sent_at: null }),
        });
      } catch (err) {
        console.error('[reservations:remind] could not hand back', back, err && err.message);
      }
    }
  }
  // A crashed run must look like one in Vercel's cron log, not like a quiet day.
  if (crashed) return res.status(500).json({ error: 'The reminder run failed; every table it had not finished was handed back.', claimed: rows.length, sent, failed });
  return res.status(200).json({ success: true, claimed: rows.length, sent, failed, later });
}

// One guest's reminder going wrong must not stop the others'. If it throws,
// the booking is handed back so tomorrow's run can try again.
async function remindSafely(row, loaded, areaName) {
  try {
    return await remindOne(row, loaded, areaName);
  } catch (err) {
    console.error('[reservations:remind] threw', row.id, err && err.message);
    try { await noteEmail(row.id, { reminder_sent_at: null, email_error: 'Reminder not sent: an error in the sending code' }); } catch { /* the next run will see it unclaimed or not at all */ }
    return false;
  }
}

async function remindOne(row, loaded, areaName) {
  const settings = loaded && !loaded.error ? loaded.settings : null;
  if (!loaded || loaded.error || !emailReady(settings)) {
    await noteEmail(row.id, { reminder_sent_at: null, email_error: 'Reminder not sent: email is not set up for this restaurant' });
    return false;
  }
  const to = sendableAddress(row.guest_email);
  if (!to) {                                   // final: it would fail the same way every day
    await noteEmail(row.id, { email_error: 'Reminder not sent: the address is not a plain email address' });
    return false;
  }
  if (!(await allow(emailDayLimiter, keyFor('all'), { failOpen: false }))) {
    await noteEmail(row.id, { reminder_sent_at: null, email_error: 'Reminder not sent yet: the daily email limit is reached' });
    return false;
  }
  const { token, hash } = newLinkToken();
  const linkSaved = await saveLink(row.id, hash, 'reminder');
  const sender = senderFor(settings, loaded.restaurant);
  const mail = reminderEmail({
    restaurant: loaded.restaurant, timezone: settings.timezone || 'America/New_York',
    at: new Date(row.reserved_at).toISOString(), party: row.party_size, areaName, code: row.code,
    guestName: row.guest_name, link: linkSaved ? cancelUrl(settings, token) : null, siteHost: hostOf(settings),
  });
  const sent = await sendEmail({
    from: sender.from, replyTo: sender.replyTo, to,
    subject: mail.subject, html: mail.html, text: mail.text,
    // One key per table per day: a doubled cron run the same morning sends one
    // email; a retry tomorrow, after a real failure, is a new attempt.
    idempotencyKey: `remind-${row.code}-${todayIn(settings.timezone || 'America/New_York')}`,
    tags: [{ name: 'kind', value: 'reminder' }],
  });
  if (sent.ok) {
    await noteEmail(row.id, { reminder_email_id: sent.id, email_error: null });
    return true;
  }
  if (sent.duplicate) {
    // Another run this same morning is sending (or sent) this very reminder.
    await noteEmail(row.id, { email_error: 'Sent by another run of the reminder job this morning' });
    return true;
  }
  console.error('[reservations:remind] not sent', row.id, sent.error);
  // Tried again tomorrow only when trying again can help. A bad address (422)
  // fails forever, and a timeout may already have reached the guest — sending
  // it again tomorrow would be a second reminder with a second link.
  const final = sent.status === 422 || sent.timedOut;
  await noteEmail(row.id, final ? { email_error: sent.error } : { reminder_sent_at: null, email_error: sent.error });
  return false;
}
