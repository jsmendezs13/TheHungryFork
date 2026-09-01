// api/reset-pin.js

import jwt from 'jsonwebtoken';
import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  validatePin,
  hashPin,
  clientIp,
  stripSecrets,
} from './_lib/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

const ipLimiter = makeLimiter({ requests: 10, window: '1 h', prefix: 'reset:ip' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ok = await allow(ipLimiter, keyFor(clientIp(req)), { failOpen: true });
  if (!ok) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  const { verificationTicket, phone_number, pin } = req.body || {};
  if (!verificationTicket || !phone_number || !pin) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const pinCheck = validatePin(pin);
  if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });

  const phone = normalizeUsPhone(phone_number);
  if (!phone) {
    return res.status(400).json({ error: 'Please enter a valid US phone number.' });
  }

  let ticket;
  try {
    ticket = jwt.verify(verificationTicket, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
  } catch (e) {
    return res.status(401).json({ error: 'Verification expired. Please verify your phone again.' });
  }

  // This route previously accepted purpose 'signup', so a ticket minted during
  // a signup attempt could be used to reset an existing account's PIN. It now
  // requires a ticket that was issued specifically for a reset. verify-otp.js
  // is updated in the next step to sign the real purpose — until then, reset
  // will correctly refuse signup tickets.
  if (ticket.purpose !== 'reset' || normalizeUsPhone(ticket.phone) !== phone) {
    return res.status(401).json({ error: 'Verification does not match this phone number.' });
  }

  try {
    const pin_hash = await hashPin(pin);

    const updRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tasters?phone_number=eq.${encodeURIComponent(phone)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Prefer': 'return=representation',
        },
        // Clear the legacy plaintext column at the same time, so any old value
        // still sitting there is removed on the next reset.
        body: JSON.stringify({ pin_hash, pin: null }),
      }
    );

    const rows = await updRes.json();
    if (!updRes.ok || !Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'No account found with this phone number.' });
    }

    const taster = rows[0];

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
    console.error('[reset-pin]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
