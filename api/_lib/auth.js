// api/_lib/auth.js
//
// Shared helpers for The Hungry Fork API routes.
// Files starting with _ are not turned into endpoints by Vercel.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
 
// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------
// Vercel's Upstash integration creates KV_REST_API_URL / KV_REST_API_TOKEN,
// not the UPSTASH_* names, so the client is configured explicitly here.
 
export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
 
export function makeLimiter({ requests, window, prefix }) {
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `thf:${prefix}`, // thf = the hungry fork, so other sites can share this DB
  });
}
 
// Returns true if the request is allowed.
//
// failOpen decides what happens when Redis itself is unreachable — which can
// happen on the free tier, since Upstash may delete a database that sits idle
// for a week. Availability-critical routes allow the request through and log
// it; money-spending routes refuse, because an unlimited SMS endpoint is worse
// than a temporarily broken one.
export async function allow(limiter, key, { failOpen = true } = {}) {
  try {
    const { success } = await limiter.limit(key);
    return success;
  } catch (err) {
    console.error('[ratelimit] redis unavailable', err?.message);
    return failOpen;
  }
}
 
// Phone numbers are personal data, so they are never used as Redis keys
// directly. The hash is stable, so counting still works.
export function keyFor(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}
 
// ---------------------------------------------------------------------------
// Phone normalization — US only
// ---------------------------------------------------------------------------
// Replaces the old inline logic. That version ended with:
//
//   else if (!phone.startsWith('+')) phone = '+' + phone;
//
// Non-digits had already been stripped by then, so nothing could start with
// '+' and that branch always ran — happily building +223... numbers for Mali.
//
// Returns E.164 (+15551234567) or null. null always means reject.
 
export function normalizeUsPhone(input) {
  if (typeof input !== 'string' || input.length > 20) return null;
 
  const parsed = parsePhoneNumberFromString(input, 'US');
  if (!parsed || !parsed.isValid()) return null;
 
  // +1 is shared with Canada and ~20 Caribbean countries, so checking the
  // country code is not enough. This checks the assigned country.
  if (parsed.country !== 'US') return null;
 
  return parsed.number;
}
 
// ---------------------------------------------------------------------------
// PIN validation
// ---------------------------------------------------------------------------
 
// There used to be a list of 18 banned PINs here — 123456, 000000 and so on.
// Sebastian removed it on purpose: this is a restaurant menu, people are
// standing at a table with a plate going cold, and a signup that argues with
// them about their PIN is a signup that does not finish.
//
// What actually stops someone guessing a PIN is the rate limit in login.js —
// 5 attempts per phone number per 15 minutes. A million possible PINs at 480
// guesses a day is not a way in. The blocked list only mattered for the twenty
// or so PINs a person would try first, and it cost every honest user a
// rejection to cover them.
//
// The one place that trade is worse: an account that can edit a menu, or the
// platform admin account. The guard for those belongs at the moment a role is
// granted — "this PIN is too weak to be a manager" — not in every customer's
// signup. That check is not written yet.
// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
// The server used to accept anything truthy, so a single space passed — ' ' is
// not empty in JavaScript. Both names are required, and "required" has to mean
// something: at least one actual letter.
//
// Deliberately permissive beyond that. \p{L} matches a letter in ANY script, so
// 李, Ñuñez and O'Brien all pass. A name field that only accepts A-Z tells a
// large part of New York that their name is invalid, which is both wrong and
// insulting.

export function validateName(value, label) {
  if (typeof value !== 'string') return { ok: false, error: `Please enter your ${label}.` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: `Please enter your ${label}.` };
  if (trimmed.length > 60) return { ok: false, error: `That ${label} is too long.` };
  if (!/\p{L}/u.test(trimmed)) return { ok: false, error: `Please enter a real ${label}.` };
  return { ok: true, value: trimmed };
}

export function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return { ok: false, error: 'PIN must be exactly 6 digits.' };
  }
  return { ok: true };
}
 
// ---------------------------------------------------------------------------
// PIN hashing
// ---------------------------------------------------------------------------
// A 6-digit PIN has only 1,000,000 possible values, so bcrypt alone would not
// stop someone who stole the database from grinding the whole keyspace.
// PIN_PEPPER is an HMAC key that lives only in the environment, never in the
// database, so a stolen table cannot be attacked offline at all.
 
const BCRYPT_ROUNDS = 12;
 
function pepper(pin) {
  const key = process.env.PIN_PEPPER;
  if (!key) throw new Error('PIN_PEPPER is not set');
  return crypto.createHmac('sha256', key).update(pin).digest('hex');
}
 
export async function hashPin(pin) {
  return bcrypt.hash(pepper(pin), BCRYPT_ROUNDS);
}
 
export async function verifyPin(pin, storedHash) {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(pepper(pin), storedHash);
  } catch {
    return false;
  }
}
 
// ---------------------------------------------------------------------------
// Date of birth
// ---------------------------------------------------------------------------
// 13 is the COPPA floor. Raise it to 18 if you would rather not hold personal
// data on minors at all — you collect name, date of birth and gender, which is
// a heavier compliance load in New York if any users are underage.
 
const MIN_AGE = 13;
 
export function validateDateOfBirth(dob) {
  if (typeof dob !== 'string') return { ok: false, error: 'Invalid date of birth.' };
 
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return { ok: false, error: 'Invalid date of birth.' };
 
  const now = new Date();
  if (date > now) return { ok: false, error: 'Invalid date of birth.' };
 
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) age--;
 
  if (age > 120) return { ok: false, error: 'Invalid date of birth.' };
  if (age < MIN_AGE) {
    return { ok: false, error: `You must be at least ${MIN_AGE} years old to sign up.` };
  }
 
  return { ok: true };
}
 
// ---------------------------------------------------------------------------
// Cloudflare Turnstile
// ---------------------------------------------------------------------------
// The widget in the browser proves a human is present. Its token means nothing
// until it is checked here: anyone can POST to /api/send-otp directly without
// ever loading the page, which is exactly what happened in August.
//
// Tokens are single-use and valid for about five minutes, so the page resets
// the widget after every send attempt.
 
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
 
// Returns { ok, reason }. reason is 'missing' or 'rejected' when the caller is
// at fault, and 'unconfigured' or 'unavailable' when we are — the two need
// different HTTP statuses, so they are not collapsed into a boolean.
export async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('[turnstile] TURNSTILE_SECRET_KEY is not set');
    return { ok: false, reason: 'unconfigured' };
  }
 
  if (typeof token !== 'string' || token.length < 10 || token.length > 2048) {
    return { ok: false, reason: 'missing' };
  }
 
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
 
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
 
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
 
    const data = await res.json();
    if (data.success === true) return { ok: true };
 
    console.warn('[turnstile] rejected', data['error-codes']);
    return { ok: false, reason: 'rejected' };
  } catch (e) {
    // Fails closed, like the rate limiters. This route spends money, so an
    // unverifiable request is refused rather than waved through.
    console.error('[turnstile] siteverify unreachable', e?.message);
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
 
// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
 
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return 'unknown';
}
 
// Never send PIN columns back to the client under any name.
export function stripSecrets(taster) {
  if (!taster) return taster;
  const clean = { ...taster };
  delete clean.pin;
  delete clean.pin_hash;
  return clean;
}
 
