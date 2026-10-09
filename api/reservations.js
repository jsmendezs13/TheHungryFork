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
// The table's QR code (migration 18, api/_lib/qr.js) goes to the guest four
// ways: the booked screen, My Reservations, the confirmation and the reminder.
// It is never a reason for a booking to fail: no token, no QR, the code shows.
//
// And the restaurant's own side (api/_lib/staff.js): every action that starts
// with "staff_" is the Reservations tab in manager.html — the day, arrived and
// no-show, big-party requests, the hours, holidays, rooms and rules. It checks
// the caller's role in the database on every request.
//
// Messages about a table (migration 19, api/_lib/messages.js): the guest writes
// from My Reservations or from the link in their email, the restaurant answers
// from manager.html, and the bell in the header says what is new. A guest with
// no account gets one email, at the restaurant's first answer (answerByEmail
// below). The daily cron deletes conversations 90 days after the table.

import crypto from 'node:crypto';
import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone, validateName } from './_lib/auth.js';
import { sb, tasterIdFromRequest } from './_lib/roles.js';
import {
  DEFAULT_RESTAURANT_ID, loadBooking, publicSettings, todayIn, clockIn,
  freeSlots, isOpenOn, cleanDate, cleanParty, cleanPhone, cleanText, cleanEmail, BOOK_MESSAGES,
} from './_lib/booking.js';
import {
  emailReady, senderFor, newLinkToken, saveLink, cancelUrl, talkUrl, cleanToken, hashToken,
  sendEmail, confirmationEmail, reminderEmail, answerEmail, hostOf, sendableAddress, mailboxKey,
} from './_lib/email.js';
import { staff } from './_lib/staff.js';
import { guest, staffMessages, chatSummaries, KEEP_MS } from './_lib/messages.js';
import { arrivalTokens, qrDataUrl, qrAttachment, QR_CID } from './_lib/qr.js';

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
  if (action === 'qr')          return oneQr(req, res, body);
  if (action === 'cancel')      return cancel(req, res, body);
  if (action === 'link')        return byLink(req, res, body);
  if (action === 'cancel_link') return cancelByLink(req, res, body);
  // Messages about a table, and the bell.
  if (action === 'msg_list' || action === 'msg_send' || action === 'inbox') {
    return guest(req, res, body, action, {
      findByLink: (t) => { const clean = cleanToken(t); return clean ? findByLink(clean) : null; },
      linkGone: LINK_GONE,
    });
  }
  if (action.startsWith('staff_msg')) return staffMessages(req, res, body, action, { answerByEmail });
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
  // The email is required (Sebastian, 7 Oct): the QR code and the confirmation
  // go there, and a guest without them is a guest the door cannot find.
  const email = requiredEmail(body.email);
  if (!email) return res.status(400).json({ error: EMAIL_NEEDED, reason: 'email' });

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
  // Sebastian's rule (2 Oct): one phone number gets one table a day at a
  // restaurant online; a second one is a phone call. So a party of twelve
  // cannot book two tables of six and skip the request the manager answers.
  // secondTable() below gives the two answers; it runs again right after the
  // booking, so two bookings sent at the same moment cannot both stay.
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', month: 'long', day: 'numeric' }).format(at);
  const sameDay = { req, res, restaurantId, phone, localDate, day, name: name.value, loaded, timezone };

  const before = await tablesThatDay(restaurantId, phone, localDate);
  if (before.length) return secondTable(sameDay, before);

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

  // Two bookings for this phone and day sent at the same moment both passed
  // the check above. The older one stays; this one is given straight back.
  const after = await tablesThatDay(restaurantId, phone, localDate);
  const earlier = after.filter((r) => Number(r.id) < Number(result.reservation_id));
  if (earlier.length) {
    const stamp = new Date().toISOString();
    const gave = await sb(`/reservations?id=eq.${Number(result.reservation_id)}&status=eq.booked`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'cancelled', cancelled_at: stamp, updated_at: stamp }),
    });
    if (gave.ok && Array.isArray(gave.data) && gave.data.length) {
      console.log('[reservations:book] a second table for one phone that day, given back', result.reservation_id);
      // The other booking, a moment older, is sending its own confirmation now.
      return secondTable({ ...sameDay, race: true }, earlier);
    }
    // Could not give it back: the table is real, so the guest is told so,
    // as for any booking (never "nothing was booked" about a table that stays).
    console.error('[reservations:book] could not give back a second table', result.reservation_id, gave.status);
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
    qr:       await qrFor(result.reservation_id, loaded.settings),
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

const EMAIL_NEEDED = 'Please write your email: your QR code and the confirmation go there.';

// ── a second table for the same phone, the same day ──────────────────────────
// The tables this phone already has at this restaurant that day, oldest first.
async function tablesThatDay(restaurantId, phone, localDate) {
  const got = await sb(
    `/reservations?restaurant_id=eq.${restaurantId}&guest_phone=eq.${encodeURIComponent(phone)}` +
    `&local_date=eq.${localDate}&status=in.(booked,seated)` +
    `&select=id,code,reserved_at,party_size,guest_name,guest_email,guest_phone,taster_id,area_id,status,hold_minutes,confirmation_sent_at&order=id.asc&limit=5`
  );
  return got.ok && Array.isArray(got.data) ? got.data : [];
}

// "José Álvarez" and "jose  alvarez" are the same guest.
function sameName(a, b) {
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  return fold(a) === fold(b);
}

// The two answers:
//   · the same guest again (same number AND same name): their table is theirs.
//     Nothing about it goes on this screen — not the time, not the code, not
//     the QR — unless the account that owns it is logged in, because a name
//     and a phone number are on every staff list (and the QR lets crew press
//     Arrived), and because a name and a number should not tell a stranger
//     when somebody will be at a restaurant. Instead the confirmation, QR
//     inside, is sent again to the email SAVED with the table (never the one
//     typed now), not again within ten minutes of the last one that went.
//   · another name on the same number: nothing is booked; call the restaurant.
// What either answer tells someone who types another person's number: that it
// has a table there that day. Accepted with the rule; the privacy page says so.
async function secondTable({ req, res, phone, localDate, day, name, loaded, timezone, race }, rows) {
  const restaurantPhone = (loaded.restaurant && loaded.restaurant.phone) || null;
  const callLine = `For a second table the same day, please call the restaurant${restaurantPhone ? ': ' + restaurantPhone : ''}.`;
  const row = rows.find((r) => sameName(r.guest_name, name));
  if (!row) {
    return res.status(409).json({
      reason: 'one_per_day',
      error: `This phone number already has a table at ${loaded.restaurant.name} on ${day}. ${callLine}`,
      day, phone: restaurantPhone,
    });
  }
  // Theirs: the account that booked it, or an account on that same phone number
  // (My Reservations shows them the same table).
  const owner = tasterIdFromRequest(req);
  let theirs = !!owner && Number(row.taster_id) === Number(owner);
  if (owner && !theirs) {
    const who = await sb(`/tasters?id=eq.${Number(owner)}&select=phone_number`);
    theirs = who.ok && Array.isArray(who.data) && who.data.length > 0 && !!who.data[0].phone_number
          && who.data[0].phone_number === row.guest_phone;
  }
  if (theirs) {
    let areaName = null;
    if (row.area_id) {
      const area = await sb(`/restaurant_areas?id=eq.${Number(row.area_id)}&select=name`);
      if (area.ok && Array.isArray(area.data) && area.data.length) areaName = area.data[0].name;
    }
    return res.status(200).json({
      success: true, already: true, day, date: localDate, phone: restaurantPhone,
      code: row.code, qr: await qrFor(row.id, loaded.settings),
      at: new Date(row.reserved_at).toISOString(), party: row.party_size, areaName,
      ...clockIn(timezone, row.reserved_at),
    });
  }
  // Not logged in as its owner: the QR goes to the email saved with the table,
  // if the table is still to come (or still inside its time).
  const holdMs = (Number(row.hold_minutes) || (loaded.settings && Number(loaded.settings.hold_minutes)) || 90) * 60 * 1000;
  const live = row.status === 'booked' && new Date(row.reserved_at).getTime() + holdMs > Date.now();
  // "Sent a few minutes ago" only when an email really went (the booking notes
  // when Resend took one), or when the twin booking is sending it right now.
  const sentAt = row.confirmation_sent_at ? new Date(row.confirmation_sent_at).getTime() : 0;
  let resent = false, recent = false;
  if (live && row.guest_email) {
    if (race || (sentAt && Date.now() - sentAt < 10 * 60 * 1000)) {
      recent = true;                                // not again so soon
    } else {
      try {
        let areaName = null;
        if (row.area_id) {
          const area = await sb(`/restaurant_areas?id=eq.${Number(row.area_id)}&select=name`);
          if (area.ok && Array.isArray(area.data) && area.data.length) areaName = area.data[0].name;
        }
        resent = await confirmByEmail({
          reservationId: row.id, email: row.guest_email, loaded, timezone,
          at: new Date(row.reserved_at).toISOString(), party: row.party_size, areaName, code: row.code, guestName: row.guest_name,
          idempotencyKey: `again-${row.code}-${Math.floor(Date.now() / (10 * 60 * 1000))}`,
        });
      } catch (err) {
        console.error('[reservations:email] sending again threw', row.id, err && err.message);
      }
    }
  }
  return res.status(200).json({
    success: true, already: true, day, date: localDate, phone: restaurantPhone, resent, recent,
  });
}

// An email that can really be sent to: the booking form's own check, and the
// sender's stricter one (no quotes, no spaces, a real domain).
function requiredEmail(value) {
  const email = cleanEmail(value);
  return email && sendableAddress(email) ? email : null;
}

// The restaurant's menu, for the message a guest shares with friends.
function menuUrlOf(settings) {
  if (!settings || !settings.site_url) return null;           // no site saved: no menu link, never another restaurant's
  const site = String(settings.site_url).replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(site) ? site + '/menu' : null;
}

// The table's QR as an image the page can show, or null. Never throws.
async function qrFor(reservationId, settings) {
  try {
    const tokens = await arrivalTokens([reservationId]);
    return tokens[reservationId] ? await qrDataUrl(settings, tokens[reservationId]) : null;
  } catch (err) {
    console.error('[reservations:qr] failed', reservationId, err && err.message);
    return null;
  }
}

// The table's QR as an inline email attachment, or null (the email then shows
// the code, as it always did).
async function qrForEmail(reservationId, settings) {
  try {
    const tokens = await arrivalTokens([reservationId]);
    return tokens[reservationId] ? await qrAttachment(settings, tokens[reservationId]) : null;
  } catch (err) {
    console.error('[reservations:qr] email png failed', reservationId, err && err.message);
    return null;
  }
}

// ── THE CONFIRMATION EMAIL ────────────────────────────────────────────────────
// Returns true only when Resend took the email. Every other outcome is written
// on the booking (email_error), so "why didn't I get an email?" has an answer.
async function confirmByEmail({ reservationId, email, loaded, timezone, at, party, areaName, code, guestName, idempotencyKey }) {
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
  const qr = await qrForEmail(reservationId, settings);
  const sender = senderFor(settings, loaded.restaurant);
  const mail = confirmationEmail({
    restaurant: loaded.restaurant, timezone, at, party, areaName, code, guestName, qrCid: qr ? QR_CID : null,
    // Only promise "after 30 minutes the table goes" if the restaurant does that.
    graceMinutes: settings.auto_release_late ? settings.grace_minutes : null,
    holdMinutes:  settings.hold_minutes,
    link:         linkSaved ? cancelUrl(settings, token) : null,
    talk:         linkSaved ? talkUrl(settings, token) : null,
    siteHost:     hostOf(settings),
  });

  const sent = await sendEmail({
    from: sender.from, replyTo: sender.replyTo, to,
    subject: mail.subject, html: mail.html, text: mail.text, attachments: [...mail.attachments, ...(qr ? [qr] : [])],
    idempotencyKey: idempotencyKey || `confirm-${code}`,
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

// ── THE RESTAURANT ANSWERED ───────────────────────────────────────────────────
// Sebastian's rule (8 Oct): a guest WITHOUT an account gets ONE email, at the
// restaurant's first answer — "Ana from The Hungry Fork answered your message"
// and a button back to the conversation, never the words of the message. A
// guest with an account sees the answer on the bell instead. More answers,
// more emails? No: one per conversation, ever (first_reply_emailed_at, claimed
// in the same write that checks it, so two answers at once send one email).
// Returns true only when Resend took it.
async function answerByEmail({ reservationId, staffName, loaded, timezone }) {
  const settings = loaded && !loaded.error ? loaded.settings : null;
  if (!emailReady(settings)) return false;
  const found = await sb(`/reservations?id=eq.${Number(reservationId)}&select=id,code,taster_id,guest_name,guest_phone,guest_email,reserved_at&limit=1`);
  const row = found.ok && Array.isArray(found.data) && found.data.length ? found.data[0] : null;
  if (!row || !row.guest_email) return false;
  // An account: booked while logged in, or an account on the table's phone number.
  if (row.taster_id) return false;
  const account = await sb(`/tasters?phone_number=eq.${encodeURIComponent(row.guest_phone)}&select=id&limit=1`);
  if (!account.ok || !Array.isArray(account.data) || account.data.length) return false;   // unknown counts as "has one": no email
  const to = sendableAddress(row.guest_email);
  if (!to) return false;

  const claimed = await sb(`/reservation_threads?reservation_id=eq.${Number(row.id)}&first_reply_emailed_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ first_reply_emailed_at: new Date().toISOString() }),
  });
  if (!claimed.ok || !Array.isArray(claimed.data) || !claimed.data.length) return false;      // already sent (or being sent)
  const giveBack = async () => {
    await sb(`/reservation_threads?reservation_id=eq.${Number(row.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ first_reply_emailed_at: null }),
    });
  };
  if (!(await allow(emailAddrLimiter, keyFor(mailboxKey(to)), { failOpen: false }))
      || !(await allow(emailDayLimiter, keyFor('all'), { failOpen: false }))) {
    await giveBack();                          // the next answer may try again
    return false;
  }
  const { token, hash } = newLinkToken();
  if (!(await saveLink(row.id, hash, 'answer'))) { await giveBack(); return false; }
  const sender = senderFor(settings, loaded.restaurant);
  const mail = answerEmail({
    restaurant: loaded.restaurant, timezone, at: new Date(row.reserved_at).toISOString(),
    staffName, guestName: row.guest_name, link: talkUrl(settings, token), siteHost: hostOf(settings),
  });
  // No reply-to: a reply would land in the restaurant's inbox and show the
  // guest's address to whoever reads it (staff never see guest emails). The
  // email says to answer on the page instead.
  const sent = await sendEmail({
    from: sender.from, replyTo: null, to,
    subject: mail.subject, html: mail.html, text: mail.text,
    idempotencyKey: `answer-${row.id}`,
    tags: [{ name: 'kind', value: 'answer' }],
    timeoutMs: 4000,                           // the manager is looking at a spinner
  });
  if (sent.ok || sent.duplicate) return !!sent.ok;
  console.error('[reservations:email] answer not sent', row.id, sent.error);
  // A timeout may already have reached the guest: then it counts as sent.
  if (!sent.timedOut) await giveBack();
  return false;
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
  const email = requiredEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Please write your email: if the restaurant says yes, your confirmation and QR code go there.', reason: 'email' });

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
      guest_email:   email,
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
// Whose tables: the account's own, and any booked with its phone number.
async function mineMatch(tasterId) {
  const who = await sb(`/tasters?id=eq.${tasterId}&select=id,phone_number`);
  if (!who.ok || !Array.isArray(who.data) || !who.data.length) return null;
  const phone = who.data[0].phone_number || null;
  return phone
    ? `or=(taster_id.eq.${tasterId},guest_phone.eq.${encodeURIComponent(phone)})`
    : `taster_id=eq.${tasterId}`;
}
// A table whose QR the guest may have: still to come, or started but still
// inside its own time (hold_minutes) and nobody has marked it yet.
function qrTime(r, now) {
  if (r.status !== 'booked') return false;
  const at = new Date(r.reserved_at).getTime();
  return at >= now || now - at <= (Number(r.hold_minutes) || 90) * 60 * 1000;
}
const QRS_AT_ONCE = 3;        // r23: the rest are drawn when the guest opens them

async function mine(req, res, body) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const match = await mineMatch(tasterId);
  if (!match) return res.status(401).json({ error: 'Please log in again.' });
  const columns = 'id,code,restaurant_id,area_id,party_size,reserved_at,local_date,local_time,status,notes,hold_minutes';
  let rows = await sb(`/reservations?${match}&select=${columns},arrival_token&order=reserved_at.desc&limit=60`);
  // Before migration 18 the column is not there: the tables, without QRs.
  if (!rows.ok && rows.status === 400) rows = await sb(`/reservations?${match}&select=${columns}&order=reserved_at.desc&limit=60`);
  if (!rows.ok || !Array.isArray(rows.data)) {
    console.error('[reservations:mine] read failed', rows.status);
    return res.status(502).json({ error: 'Could not read your tables. Please try again in a moment.' });
  }

  // The names, in two small reads rather than one clever join.
  const restaurantIds = [...new Set(rows.data.map((r) => r.restaurant_id))];
  const areaIds = [...new Set(rows.data.map((r) => r.area_id).filter(Boolean))];
  const [places, areas] = await Promise.all([
    restaurantIds.length ? sb(`/restaurants?id=in.(${restaurantIds.join(',')})&select=id,name,restaurant_phone,address,city,state,zip_code`) : { data: [] },
    areaIds.length ? sb(`/restaurant_areas?id=in.(${areaIds.join(',')})&select=id,name`) : { data: [] },
  ]);
  const placeName = {}, placePhone = {}, placeAddress = {}, areaName = {};
  (Array.isArray(places.data) ? places.data : []).forEach((p) => {
    placeName[p.id] = p.name; placePhone[p.id] = p.restaurant_phone;
    placeAddress[p.id] = [p.address, p.city, p.state, p.zip_code].filter(Boolean).join(', ') || null;
  });
  (Array.isArray(areas.data) ? areas.data : []).forEach((a) => { areaName[a.id] = a.name; });

  const settings = await loadBooking(restaurantIds[0] || DEFAULT_RESTAURANT_ID);
  const timezone = (settings && settings.settings && settings.settings.timezone) || 'America/New_York';
  const now = Date.now();

  // The QR for the tables still to come (it is what the guest shows at the
  // door), and for one that has started but is still inside its own time
  // (hold_minutes) and nobody has marked yet: a guest a few minutes late is at
  // the door. Not for past or cancelled ones. r23 (Sebastian, 8 Oct: "too slow
  // when I'm logged in"): the pictures of the three soonest come with the
  // list; the others say qrLater, and the page asks for one (action "qr")
  // when the guest opens it or it comes into view.
  const qrs = {}, later = new Set();
  const startedNow = (r) => r.status === 'booked' && new Date(r.reserved_at).getTime() < now && qrTime(r, now);
  const lateIds = new Set(rows.data.filter(startedNow).map((r) => r.id));
  const allComing = rows.data.filter((r) => r.status === 'booked' && (new Date(r.reserved_at).getTime() >= now || lateIds.has(r.id)))
                             .sort((a, b) => new Date(a.reserved_at) - new Date(b.reserved_at));
  const comingUp = allComing.slice(0, QRS_AT_ONCE);
  allComing.slice(QRS_AT_ONCE).forEach((r) => { if (r.arrival_token) later.add(r.id); });
  // Each restaurant's own site goes in its QR (one read per restaurant).
  const siteOf = {};
  await Promise.all([...new Set(allComing.map((r) => r.restaurant_id))].map(async (rid) => {
    const l = rid === (restaurantIds[0] || DEFAULT_RESTAURANT_ID) ? settings : await loadBooking(rid);
    siteOf[rid] = l && !l.error ? l.settings : null;
  }));
  await Promise.all(comingUp.map(async (r) => { qrs[r.id] = await qrDataUrl(siteOf[r.restaurant_id], r.arrival_token); }));

  // The conversation of each table: Message, with a count of unread answers.
  const chats = await chatSummaries(rows.data, now);

  const dressed = rows.data.map((r) => ({
    id:         r.id,
    code:       r.code,
    chat:       chats[r.id] || null,
    qr:         qrs[r.id] || null,
    qrLater:    later.has(r.id) || undefined,
    at:         new Date(r.reserved_at).toISOString(),
    date:       r.local_date,
    party:      r.party_size,
    status:     r.status,
    notes:      r.notes,
    areaName:   r.area_id ? areaName[r.area_id] || null : null,
    restaurant: placeName[r.restaurant_id] || 'Restaurant',
    phone:      placePhone[r.restaurant_id] || null,
    // For sharing the table with friends (the page writes the message).
    address:    placeAddress[r.restaurant_id] || null,
    menuUrl:    menuUrlOf(siteOf[r.restaurant_id]),
    // A table can be called off right up to the moment it starts. Sebastian's
    // decision: a guest who cancels late is still better than one who never
    // arrives and says nothing.
    canCancel:  r.status === 'booked' && new Date(r.reserved_at).getTime() > now,
    ...clockIn(timezone, r.reserved_at),
  }));

  // Coming up: tables still to start, and a booked one still inside its time
  // (the guest a few minutes late, at the door, needs it first).
  const stillOn = (r) => r.status !== 'cancelled' && (new Date(r.at).getTime() >= now || lateIds.has(r.id));
  return res.status(200).json({
    success:  true,
    today:    todayIn(timezone),
    now:      new Date().toISOString(),        // the countdown runs on the server's clock (taken as it answers)
    upcoming: dressed.filter(stillOn).sort((a, b) => new Date(a.at) - new Date(b.at)),
    past:     dressed.filter((r) => !stillOn(r)),
  });
}

// One table's QR, for My Reservations (r23): the guest opened a table whose
// picture did not come with the list. Only the account's own table, and only
// while its QR is still good (as in mine).
async function oneQr(req, res, body) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (!(await allow(readLimiter, keyFor('q' + tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which table?' });
  const match = await mineMatch(tasterId);
  if (!match) return res.status(401).json({ error: 'Please log in again.' });
  const got = await sb(`/reservations?id=eq.${id}&${match}&select=id,restaurant_id,status,reserved_at,hold_minutes,arrival_token&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) return res.status(502).json({ error: 'Could not read the table. Please try again in a moment.' });
  const r = got.data[0];
  // Another guest's table reads exactly like one that does not exist.
  if (!r || !qrTime(r, Date.now())) return res.status(404).json({ error: 'This table has no QR code now.' });
  const loaded = await loadBooking(r.restaurant_id);
  const qr = await qrDataUrl(loaded && !loaded.error ? loaded.settings : null, r.arrival_token);
  if (!qr) return res.status(404).json({ error: 'This table has no QR code now.' });
  return res.status(200).json({ success: true, id: r.id, qr });
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
  // The link lives as long as the table's conversation is kept: 90 days after
  // the table (it was a week until r21). A guest without an account writes
  // about the glasses they left through this link, so it has to open as long as
  // Sebastian's rule lets them write. After that it opens nothing, so a
  // forwarded email does not show a first name and a date forever.
  if (new Date(row.data[0].reserved_at).getTime() < Date.now() - LINK_LIFE_MS) return null;
  return row.data[0];
}
const LINK_LIFE_MS = KEEP_MS;

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
  const chat = (await chatSummaries([row]))[row.id] || null;

  return res.status(200).json({
    success: true,
    booking: {
      chat,                                   // null: no messages for this table (too old, or not switched on)
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
  // First the forgetting: conversations 90 days after their table. Whatever
  // happens with the emails, this runs.
  const forgotten = await forgetOldMessages();
  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ success: true, forgotten, skipped: 'RESEND_API_KEY is not set in Vercel' });
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
      forgotten,
    });
  }
  const rows = claimed.data;
  if (!rows.length) return res.status(200).json({ success: true, forgotten, claimed: 0, sent: 0, failed: 0, later: 0 });

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
  if (crashed) return res.status(500).json({ error: 'The reminder run failed; every table it had not finished was handed back.', forgotten, claimed: rows.length, sent, failed });
  return res.status(200).json({ success: true, forgotten, claimed: rows.length, sent, failed, later });
}

// Sebastian's rule (8 Oct): a conversation is kept 90 days after its table,
// then deleted — the conversation and every message in it (the database
// deletes the messages with it). Returns how many went, or null when it could
// not ask (before migration 19, or the database is down). Never throws.
async function forgetOldMessages() {
  try {
    const before = new Date(Date.now() - KEEP_MS).toISOString();
    const gone = await sb(`/reservation_threads?table_at=lt.${before}&select=reservation_id`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' },
    });
    if (!gone.ok) { console.error('[reservations:forget] failed', gone.status); return null; }
    const n = Array.isArray(gone.data) ? gone.data.length : 0;
    if (n) console.log('[reservations:forget] deleted', n, 'conversations older than 90 days after their table');
    return n;
  } catch (err) {
    console.error('[reservations:forget] threw', err && err.message);
    return null;
  }
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
  const qr = await qrForEmail(row.id, settings);
  const sender = senderFor(settings, loaded.restaurant);
  const mail = reminderEmail({
    restaurant: loaded.restaurant, timezone: settings.timezone || 'America/New_York',
    at: new Date(row.reserved_at).toISOString(), party: row.party_size, areaName, code: row.code,
    guestName: row.guest_name, link: linkSaved ? cancelUrl(settings, token) : null, siteHost: hostOf(settings),
    talk: linkSaved ? talkUrl(settings, token) : null,
    qrCid: qr ? QR_CID : null,
  });
  const sent = await sendEmail({
    from: sender.from, replyTo: sender.replyTo, to,
    subject: mail.subject, html: mail.html, text: mail.text,
    ...(qr ? { attachments: [qr] } : {}),
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
