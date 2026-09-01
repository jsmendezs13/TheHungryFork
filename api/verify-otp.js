// api/verify-otp.js

import jwt from 'jsonwebtoken';
import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  clientIp,
} from './_lib/auth.js';

// Twilio caps attempts per verification, but nothing stopped someone from
// requesting endless fresh verifications and guessing at each one.
const phoneLimiter = makeLimiter({ requests: 10, window: '1 h', prefix: 'verifyotp:phone' });
const ipLimiter = makeLimiter({ requests: 20, window: '1 h', prefix: 'verifyotp:ip' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, code, purpose } = req.body || {};
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

  // Same US-only rule as send-otp. A code was never sent to a foreign number,
  // so there is nothing to check for one.
  const normalized = normalizeUsPhone(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'Please enter a valid US phone number.' });
  }

  if (typeof code !== 'string' || !/^\d{4,10}$/.test(code)) {
    return res.status(400).json({ error: 'Invalid or expired code' });
  }

  const [phoneOk, ipOk] = await Promise.all([
    allow(phoneLimiter, keyFor(normalized), { failOpen: false }),
    allow(ipLimiter, keyFor(clientIp(req)), { failOpen: true }),
  ]);

  if (!phoneOk || !ipOk) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  // The ticket records what the user actually asked to do. Previously every
  // ticket said 'signup', so a ticket created while signing up was also
  // accepted by reset-pin.js to change an existing account's PIN.
  const ticketPurpose = purpose === 'reset' ? 'reset' : 'signup';

  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: normalized, Code: code }),
      }
    );

    const data = await response.json();

    if (data.status !== 'approved') {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }

    const verificationTicket = jwt.sign(
      { phone: normalized, purpose: ticketPurpose },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '10m', algorithm: 'HS256' }
    );

    return res.status(200).json({ success: true, verificationTicket });
  } catch (err) {
    console.error('[verify-otp]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
