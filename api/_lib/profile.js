// api/_lib/profile.js
//
// "My information" (r30, Sebastian 12–13 Oct, picture A): a logged-in guest sees
// everything the site keeps about them on one page and changes what they want.
// Reached through api/reservations.js (actions me, me_save, me_pin, me_phone),
// so the site still deploys as twelve functions.
//
//   · names, birthday and gender: saved as typed (checked like the sign-up);
//   · the handle (Johan_I) never changes, whatever the name becomes;
//   · a new email is kept only after the 6-digit code sent to it is typed back
//     (the confirmations, the QR codes and the offers go there);
//   · a new phone number — it is the login — only with the text-message code
//     (send-otp / verify-otp, purpose "change") AND the current PIN;
//   · the PIN changes with the current PIN;
//   · promotions: three switches, website / email / text message. All off is
//     none. The moment the email and text switches are turned on is kept (the
//     guest's consent); turning one off forgets it.
//
// The email code needs no table: it is an HMAC of the account, the address and
// the 10-minute window, with the server's secret. It works for 10 to 20
// minutes, and the attempts are counted per account.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  makeLimiter, allow, keyFor, validateName, validateDateOfBirth, validatePin, hashPin, verifyPin,
  normalizeUsPhone, stripSecrets,
} from './auth.js';
import { sb, tasterIdFromRequest } from './roles.js';
import { cleanEmail, loadBooking, DEFAULT_RESTAURANT_ID } from './booking.js';
import { emailReady, senderFor, sendEmail, sendableAddress, mailboxKey, emailCodeEmail, hostOf } from './email.js';

const saveLimiter  = makeLimiter({ requests: 30, window: '10 m', prefix: 'me:save' });
const codeSend     = makeLimiter({ requests: 4,  window: '1 h',  prefix: 'me:code:send' });
const codeTry      = makeLimiter({ requests: 8,  window: '10 m', prefix: 'me:code:try' });
const pinTry       = makeLimiter({ requests: 5,  window: '15 m', prefix: 'me:pin' });
const readLimiter  = makeLimiter({ requests: 120, window: '10 m', prefix: 'me:read' });

export const GENDERS = ['male', 'female', 'non-binary', 'other'];
const BASE_COLUMNS = 'id,first_name,last_name,username,phone_number,email,date_of_birth,gender,promotions_accepted,created_at,is_platform_admin,is_restaurant_admin,restaurant_id';
const PROMO_COLUMNS = ',promo_email,promo_email_at,promo_sms,promo_sms_at';
const WINDOW_MS = 10 * 60 * 1000;

// ── THE EMAIL CODE ────────────────────────────────────────────────────────────
export function emailCode(tasterId, email, bucket = Math.floor(Date.now() / WINDOW_MS)) {
  const key = process.env.SUPABASE_JWT_SECRET || '';
  const mac = crypto.createHmac('sha256', 'me-email-code|' + key)
    .update(`${Number(tasterId)}|${String(email).toLowerCase()}|${bucket}`).digest();
  return String(mac.readUInt32BE(0) % 1000000).padStart(6, '0');
}
export function emailCodeOk(tasterId, email, code, now = Date.now()) {
  const typed = String(code || '').replace(/\D/g, '');
  if (typed.length !== 6) return false;
  const b = Math.floor(now / WINDOW_MS);
  return [b, b - 1].some((x) => crypto.timingSafeEqual(Buffer.from(emailCode(tasterId, email, x)), Buffer.from(typed)));
}

// ── READING ───────────────────────────────────────────────────────────────────
// The row, with the promotion columns when migration 20 is there. { row, promo }.
async function readMe(tasterId) {
  let got = await sb(`/tasters?id=eq.${Number(tasterId)}&select=${BASE_COLUMNS}${PROMO_COLUMNS}&limit=1`);
  let promo = true;
  if (!got.ok && got.status === 400) {
    promo = false;
    got = await sb(`/tasters?id=eq.${Number(tasterId)}&select=${BASE_COLUMNS}&limit=1`);
  }
  if (!got.ok) return { error: got.status };
  return { row: Array.isArray(got.data) && got.data.length ? got.data[0] : null, promo };
}

function memberSince(iso) {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', year: 'numeric' }).format(d);
}
function birthdayOf(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
// What the page sends: exactly YYYY-MM-DD, and a day that exists (no 31 February).
function cleanBirthday(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[0] : null;
}

// What the page shows. The taster object goes back too, without secrets, so the
// browser's copy (the corner menu's "Hi, Name (Handle)") follows at once.
function view(row, promo, extra = {}) {
  return {
    success: true,
    me: {
      firstName: row.first_name || '', lastName: row.last_name || '', handle: row.username || null,
      email: row.email || '', phone: row.phone_number || '',
      birthday: birthdayOf(row.date_of_birth), gender: GENDERS.includes(row.gender) ? row.gender : (row.gender || ''),
      promoWeb: !!row.promotions_accepted,
      promoEmail: promo ? !!row.promo_email : false,
      promoSms: promo ? !!row.promo_sms : false,
      promoReady: promo,
      memberSince: memberSince(row.created_at),
    },
    taster: stripSecrets(row),
    ...extra,
  };
}

// ── THE ACTIONS ───────────────────────────────────────────────────────────────
export async function profile(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const limiter = action === 'me' ? readLimiter : saveLimiter;
  if (!(await allow(limiter, keyFor('a' + tasterId), { failOpen: action === 'me' }))) {
    return res.status(429).json({ error: 'Too many changes in a few minutes. Wait a moment and try again.' });
  }
  const got = await readMe(tasterId);
  if (got.error) return res.status(502).json({ error: 'Could not read your information. Please try again in a moment.' });
  if (!got.row) return res.status(401).json({ error: 'Please log in again.' });

  if (action === 'me') return res.status(200).json(view(got.row, got.promo));
  if (action === 'me_save') return save(req, res, body, tasterId, got);
  if (action === 'me_pin') return changePin(res, body, tasterId);
  if (action === 'me_phone') return changePhone(res, body, tasterId, got);
  return res.status(400).json({ error: 'Unknown action.' });
}

async function patchMe(tasterId, fields) {
  return sb(`/tasters?id=eq.${Number(tasterId)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(fields),
  });
}

async function save(req, res, body, tasterId, { row, promo }) {
  const first = validateName(body.firstName, 'first name');
  if (!first.ok) return res.status(400).json({ error: first.error, field: 'firstName' });
  const last = validateName(body.lastName, 'last name');
  if (!last.ok) return res.status(400).json({ error: last.error, field: 'lastName' });

  const fields = { first_name: first.value, last_name: last.value };
  if (body.birthday) {
    const b = cleanBirthday(body.birthday);
    const check = b ? validateDateOfBirth(b) : { ok: false, error: 'Invalid date of birth.' };
    if (!check.ok) return res.status(400).json({ error: check.error === 'Invalid date of birth.' ? 'Please choose a real date of birth.' : check.error.replace('to sign up', 'to have an account'), field: 'birthday' });
    fields.date_of_birth = b;
  }
  if (body.gender !== undefined && body.gender !== row.gender) {
    if (!GENDERS.includes(body.gender)) return res.status(400).json({ error: 'Please choose your gender.', field: 'gender' });
    fields.gender = body.gender;
  }

  // The email: kept as it is, removed, or changed only with its code.
  const was = String(row.email || '').toLowerCase();
  const typed = String(body.email || '').trim();
  let email = was || null;
  let pending = null;
  if (!typed) {
    email = null;
    fields.email = null;
  } else {
    const clean = cleanEmail(typed);
    if (!clean || !sendableAddress(clean)) return res.status(400).json({ error: 'Please write a real email address.', field: 'email' });
    if (clean !== was) {
      if (body.emailCode) {
        if (!(await allow(codeTry, keyFor('a' + tasterId), { failOpen: false }))) {
          return res.status(429).json({ error: 'Too many tries. Wait 10 minutes and ask for a new code.', field: 'emailCode' });
        }
        if (!emailCodeOk(tasterId, clean, body.emailCode)) {
          return res.status(400).json({ error: 'That code is not right, or it is more than 10 minutes old.', field: 'emailCode' });
        }
        email = clean;
        fields.email = clean;
      } else {
        pending = clean;                    // the code goes out below; everything else is saved now
      }
    }
  }

  // The promotions. Offers by email need an email that is the guest's own.
  const now = new Date().toISOString();
  fields.promotions_accepted = body.promoWeb === true;
  let note = null;
  if (promo) {
    let wantEmail = body.promoEmail === true;
    if (wantEmail && !email) {
      wantEmail = false;
      note = pending ? 'Offers by email start once your new email is confirmed.' : 'Add your email to get offers by email.';
    }
    fields.promo_email = wantEmail;
    fields.promo_email_at = wantEmail ? (row.promo_email ? row.promo_email_at || now : now) : null;
    const wantSms = body.promoSms === true;
    fields.promo_sms = wantSms;
    fields.promo_sms_at = wantSms ? (row.promo_sms ? row.promo_sms_at || now : now) : null;
  }

  const put = await patchMe(tasterId, fields);
  if (!put.ok || !Array.isArray(put.data) || !put.data.length) {
    console.error('[profile] save failed', tasterId, put.status);
    return res.status(502).json({ error: 'Your information was not saved. Please try again.' });
  }
  const saved = put.data[0];
  console.log('[profile] taster', tasterId, 'saved My information' + (fields.email !== undefined && fields.email !== row.email ? ' (email changed)' : ''));

  let sent = null;
  if (pending) {
    sent = await sendCode(tasterId, pending, saved);
    if (!sent.ok) return res.status(sent.status).json({ ...view(saved, promo), success: false, error: sent.error, field: 'email', saved: true });
  }
  return res.status(200).json(view(saved, promo, {
    ...(pending ? { emailPending: pending, message: `We sent a 6-digit code to ${pending}. Type it below to keep this email.` } : {}),
    ...(note ? { note } : {}),
  }));
}

async function sendCode(tasterId, address, row) {
  const loaded = await loadBooking(DEFAULT_RESTAURANT_ID);
  const settings = loaded && !loaded.error ? loaded.settings : null;
  if (!emailReady(settings)) return { ok: false, status: 503, error: 'We cannot send the code by email right now. Your other changes are saved; try the email again later.' };
  if (!(await allow(codeSend, keyFor('a' + tasterId), { failOpen: false }))
      || !(await allow(codeSend, keyFor('m' + mailboxKey(address)), { failOpen: false }))) {
    return { ok: false, status: 429, error: 'Too many codes in an hour. Your other changes are saved; try the email again later.' };
  }
  const sender = senderFor(settings, loaded.restaurant);
  const code = emailCode(tasterId, address);
  const mail = emailCodeEmail({ restaurant: loaded.restaurant, code, guestName: row.first_name, siteHost: hostOf(settings) });
  const out = await sendEmail({
    from: sender.from, replyTo: null, to: address, subject: mail.subject, html: mail.html, text: mail.text,
    idempotencyKey: `me-code-${tasterId}-${mailboxKey(address)}-${Math.floor(Date.now() / WINDOW_MS)}`,
    tags: [{ name: 'kind', value: 'email-code' }], timeoutMs: 5000,
  });
  if (out.ok || out.duplicate) return { ok: true };
  console.error('[profile] code not sent', tasterId, out.error);
  return { ok: false, status: 502, error: 'The code could not be sent. Check the address, or try again in a moment. Your other changes are saved.' };
}

async function changePin(res, body, tasterId) {
  if (!(await allow(pinTry, keyFor('a' + tasterId), { failOpen: false }))) {
    return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  }
  const current = String(body.currentPin || '').replace(/\D/g, '');
  const next = String(body.newPin || '').replace(/\D/g, '');
  const check = validatePin(next);
  if (!check.ok) return res.status(400).json({ error: 'The new PIN must be 6 digits.', field: 'newPin' });
  const got = await sb(`/tasters?id=eq.${Number(tasterId)}&select=id,pin_hash&limit=1`);
  const row = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!row) return res.status(502).json({ error: 'Could not check your PIN. Please try again.' });
  if (!(await verifyPin(current, row.pin_hash))) return res.status(400).json({ error: 'Your current PIN is not right.', field: 'currentPin' });
  const pin_hash = await hashPin(next);
  const put = await sb(`/tasters?id=eq.${Number(tasterId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ pin_hash }) });
  if (!put.ok) return res.status(502).json({ error: 'Your PIN was not changed. Please try again.' });
  console.log('[profile] taster', tasterId, 'changed the PIN');
  return res.status(200).json({ success: true, message: 'Your new PIN is saved. Use it next time you log in.' });
}

// The new number was proved by its text-message code (verify-otp, purpose
// "change"), and that ticket names this account. The current PIN is asked
// again here, so a phone left unlocked cannot move somebody's account.
async function changePhone(res, body, tasterId, { row, promo }) {
  if (!(await allow(pinTry, keyFor('a' + tasterId), { failOpen: false }))) {
    return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  }
  let ticket;
  try {
    ticket = jwt.verify(String(body.verificationTicket || ''), process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'The code has expired. Ask for a new one.' });
  }
  const phone = normalizeUsPhone(ticket && ticket.phone);
  if (!ticket || ticket.purpose !== 'change' || Number(ticket.account) !== Number(tasterId) || !phone) {
    return res.status(401).json({ error: 'That code was not for this account. Ask for a new one.' });
  }
  const pinRow = await sb(`/tasters?id=eq.${Number(tasterId)}&select=pin_hash&limit=1`);
  const hash = pinRow.ok && Array.isArray(pinRow.data) && pinRow.data.length ? pinRow.data[0].pin_hash : null;
  if (!(await verifyPin(String(body.currentPin || '').replace(/\D/g, ''), hash))) {
    return res.status(400).json({ error: 'Your current PIN is not right.', field: 'currentPin' });
  }
  if (phone === row.phone_number) return res.status(200).json(view(row, promo, { message: 'That is already your number.' }));
  const taken = await sb(`/tasters?phone_number=eq.${encodeURIComponent(phone)}&select=id&limit=1`);
  if (!taken.ok) return res.status(502).json({ error: 'Could not check the number. Please try again.' });
  if (Array.isArray(taken.data) && taken.data.length) return res.status(409).json({ error: 'That number already has an account.' });
  const put = await patchMe(tasterId, { phone_number: phone });
  if (!put.ok || !Array.isArray(put.data) || !put.data.length) {
    const unique = put.status === 409 || JSON.stringify(put.data || '').includes('unique');
    return res.status(unique ? 409 : 502).json({ error: unique ? 'That number already has an account.' : 'Your number was not changed. Please try again.' });
  }
  console.log('[profile] taster', tasterId, 'changed the phone number');
  return res.status(200).json(view(put.data[0], promo, { message: 'Your new number is saved. Log in with it from now on.' }));
}
