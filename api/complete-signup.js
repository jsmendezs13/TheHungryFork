// api/complete-signup.js

import jwt from 'jsonwebtoken';
import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  validatePin,
  validateName,
  validateDateOfBirth,
  hashPin,
  clientIp,
  stripSecrets,
} from './_lib/auth.js';
import { sb } from './_lib/roles.js';
import { usernameBase, formatUsername } from './_lib/usernames.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

const ipLimiter = makeLimiter({ requests: 10, window: '1 h', prefix: 'signup:ip' });

// The next free number for a first name. One indexed lookup of the largest
// username_seq — which is exactly why the plain integer is stored alongside the
// Roman numeral. MAX() on 'MMMCMXCIX' would mean nothing.
async function nextUsernameSeq(base) {
  const r = await sb(
    '/tasters?username_base=eq.' + encodeURIComponent(base) +
    '&select=username_seq&order=username_seq.desc&limit=1'
  );
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return 1;
  return Number(r.data[0].username_seq || 0) + 1;
}

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

  // Both names are required and must contain a letter. The signup form checks
  // this too, but the form is not the authority — anyone can POST here.
  //
  // These four lines used to sit INSIDE the block above, after its return.
  // JavaScript was happy: the file parsed, the function deployed, and the
  // module loaded. But `const firstCheck` was then scoped to that block, so
  // line 113 below threw ReferenceError on every single signup, and the catch
  // turned it into the word "Server error". Nobody could create an account
  // from 16 to 20 September because of a brace in the wrong place.
  const firstCheck = validateName(first_name, 'first name');
  if (!firstCheck.ok) return res.status(400).json({ error: firstCheck.error });
  const lastCheck = validateName(last_name, 'last name');
  if (!lastCheck.ok) return res.status(400).json({ error: lastCheck.error });

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

    // The public handle — Karol_I, Karol_II — is assigned here and never
    // chosen. A handle people pick is a handle people impersonate each other
    // with, and reviews need a name that means one person.
    //
    // Two people signing up in the same second will both read "the next Karol
    // is II". The unique index on username is the referee: the loser's insert
    // is rejected, this loop reads the number again, and the second one becomes
    // Karol_III. Five attempts is far more than a real collision needs.
    const base = usernameBase(firstCheck.value);
    let taster = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = await nextUsernameSeq(base);

      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/tasters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          first_name: firstCheck.value,
          last_name:  lastCheck.value,
          date_of_birth,
          gender,
          phone_number: phone, // store the normalized form consistently
          pin_hash,            // never the raw pin
          privacy_accepted,
          promotions_accepted,
          username_base: base,
          username_seq:  seq,
          username:      formatUsername(base, seq),
        }),
      });

      const inserted = await insertRes.json();

      if (insertRes.ok) { taster = inserted[0]; break; }

      const msg = JSON.stringify(inserted);

      // Someone else took this handle between the read and the write. Not an
      // error — read the number again and take the next one.
      if (msg.includes('username')) continue;

      if (msg.includes('unique')) {
        // Safe to be specific: reaching this point required passing OTP on this
        // number, so the caller already controls it.
        return res.status(409).json({ error: 'This phone number already has an account. Please log in instead.' });
      }
      console.error('[complete-signup] insert failed', msg);
      return res.status(400).json({ error: 'Could not create account.' });
    }

    if (!taster) {
      console.error('[complete-signup] gave up assigning a username for', base);
      return res.status(409).json({ error: 'Busy right now — please try again.' });
    }

    const session = jwt.sign(
      { role: 'authenticated', taster_id: taster.id, restaurant_id: null },
      process.env.SUPABASE_JWT_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    return res.status(200).json({ success: true, session, taster: stripSecrets(taster) });
  } catch (e) {
    // "Server error" on its own cost four days. Whatever went wrong, say what
    // it was: the person seeing this is either Sebastian or somebody who
    // deserves better than a shrug.
    console.error('[complete-signup]', e);
    return res.status(500).json({
      error: 'Something broke while creating your account: ' + (e?.message || 'unknown error'),
    });
  }
}
