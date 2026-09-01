// api/login.js

import jwt from 'jsonwebtoken';
import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  verifyPin,
  clientIp,
  stripSecrets,
} from './_lib/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

// Per phone number: 5 attempts per 15 minutes. This is the limit that makes
// brute-forcing a 6-digit PIN impossible. Without it, a million guesses is a
// few hours of scripting.
const phoneLimiter = makeLimiter({ requests: 5, window: '15 m', prefix: 'login:phone' });

// Per IP: catches someone spraying one common PIN across many phone numbers,
// which the per-phone limit alone would not stop.
const ipLimiter = makeLimiter({ requests: 20, window: '15 m', prefix: 'login:ip' });

// One message for every failure. The old version said "Phone number not found"
// versus "Incorrect PIN", which let anyone discover which numbers have
// accounts on the platform just by watching which error came back.
const GENERIC_FAILURE = 'Incorrect phone number or PIN.';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, pin } = req.body || {};
  if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN are required' });

  const normalized = normalizeUsPhone(phone);
  if (!normalized || typeof pin !== 'string') {
    return res.status(401).json({ error: GENERIC_FAILURE });
  }

  // failOpen: false on the phone limiter. If Redis is unreachable we would
  // rather refuse logins for a while than silently run with no brute-force
  // protection at all — that is the whole point of this file.
  const [phoneOk, ipOk] = await Promise.all([
    allow(phoneLimiter, keyFor(normalized), { failOpen: false }),
    allow(ipLimiter, keyFor(clientIp(req)), { failOpen: true }),
  ]);

  if (!phoneOk || !ipOk) {
    return res.status(429).json({
      error: 'Too many login attempts. Please wait 15 minutes and try again.',
    });
  }

  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tasters?phone_number=eq.${encodeURIComponent(normalized)}&select=*`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );

    const rows = await lookupRes.json();

    if (!lookupRes.ok || !Array.isArray(rows) || rows.length === 0) {
      return res.status(401).json({ error: GENERIC_FAILURE });
    }

    const taster = rows[0];

    // Compares against the bcrypt hash. The plaintext `pin` column is no
    // longer read by anything.
    const pinOk = await verifyPin(pin, taster.pin_hash);
    if (!pinOk) {
      return res.status(401).json({ error: GENERIC_FAILURE });
    }

    const session = jwt.sign(
      {
        role: 'authenticated',
        taster_id: taster.id,
        restaurant_id: taster.is_restaurant_admin ? taster.restaurant_id : null,
      },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    return res.status(200).json({ success: true, session, taster: stripSecrets(taster) });
  } catch (e) {
    console.error('[login]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
