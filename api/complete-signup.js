// api/complete-signup.js

import jwt from 'jsonwebtoken';
import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  validatePin,
  validateDateOfBirth,
  hashPin,
  clientIp,
  stripSecrets,
} from './_lib/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

const ipLimiter = makeLimiter({ requests: 10, window: '1 h', prefix: 'signup:ip' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit account creation per IP. failOpen: a broken Redis should not
  // stop real people from signing up — nothing is being spent here.
  const ok = await allow(ipLimiter, keyFor(clientIp(req)), { failOpen: true });
  if (!ok) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const {
    verificationTicket,
    first_name,
    last_name,
    date_of_birth,
    gender,
    phone_number,
    pin,
    privacy_accepted,
    promotions_accepted,
  } = req.body || {};

  if (!verificationTicket) return res.status(400).json({ error: 'Missing verification ticket' });
  if (!first_name || !last_name || !date_of_birth || !gender || !phone_number || !pin) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // PIN rules. The old version accepted any value here while reset-pin.js
  // required 6 digits; both now use the same rule.
  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });

  const dobCheck = validateDateOfBirth(date_of_birth);
  if (!dobCheck.ok) return res.status(400).json({ error: dobCheck.error });

  if (privacy_accepted !== true) {
    return res.status(400).json({ error: 'You must accept the privacy policy to continue.' });
  }

  // Normalize before comparing to the ticket, so a differently formatted but
  // identical number still matches.
  const phone = normalizeUsPhone(phone_number);
  if (!phone) {
    return res.status(400).json({ error: 'Please enter a valid US phone number.' });
  }

  let ticket;
  try {
    ticket = jwt.verify(verificationTicket, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'], // pin the algorithm rather than trusting defaults
    });
  } catch (e) {
    return res.status(401).json({ error: 'Verification expired. Please verify your phone again.' });
  }

  if (ticket.purpose !== 'signup' || normalizeUsPhone(ticket.phone) !== phone) {
    return res.status(401).json({ error: 'Verification does not match this phone number.' });
  }

  try {
    // Hash before the PIN ever reaches the database.
    const pin_hash = await hashPin(pin);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tasters`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        first_name,
        last_name,
        date_of_birth,
        gender,
        phone_number: phone, // store the normalized form consistently
        pin_hash,            // never the raw pin
        privacy_accepted,
        promotions_accepted,
      }),
    });

    const inserted = await insertRes.json();

    if (!insertRes.ok) {
      const msg = JSON.stringify(inserted);
      if (msg.includes('unique')) {
        // Safe to be specific: reaching this point required passing OTP on this
        // number, so the caller already controls it.
        return res.status(409).json({ error: 'This phone number already has an account. Please log in instead.' });
      }
      console.error('[complete-signup] insert failed', msg);
      return res.status(400).json({ error: 'Could not create account.' });
    }

    const taster = inserted[0];

    const session = jwt.sign(
      { role: 'authenticated', taster_id: taster.id, restaurant_id: null },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    return res.status(200).json({ success: true, session, taster: stripSecrets(taster) });
  } catch (e) {
    console.error('[complete-signup]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
