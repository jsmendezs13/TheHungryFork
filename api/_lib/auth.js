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

const WEAK_PINS = new Set([
  '000000', '111111', '222222', '333333', '444444',
  '555555', '666666', '777777', '888888', '999999',
  '123456', '654321', '121212', '112233', '123123',
  '098765', '101010', '012345',
]);

export function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
    return { ok: false, error: 'PIN must be exactly 6 digits.' };
  }
  if (WEAK_PINS.has(pin)) {
    return { ok: false, error: 'That PIN is too easy to guess. Please choose another.' };
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
