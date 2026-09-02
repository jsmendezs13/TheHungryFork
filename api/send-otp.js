// api/send-otp.js

import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  clientIp,
} from './_lib/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

// Per number: a real person needs one code, maybe two if the first is slow.
const phoneLimiter = makeLimiter({ requests: 3, window: '24 h', prefix: 'sendotp:phone' });

// Per IP: stops a loop from a single source.
const ipLimiter = makeLimiter({ requests: 5, window: '1 h', prefix: 'sendotp:ip' });

// ---------------------------------------------------------------------------
// Global circuit breakers — separate budgets for signup and reset
// ---------------------------------------------------------------------------
//
// Signups and resets no longer share one counter, so a flood of fake signups
// can't lock existing users out of resetting their PIN.
//
// 50 new signups per hour. Raise this before a launch or a promotion; a busy
// day of ~300 signups averages 12-13 per hour, so 50 leaves room for bursts.
// The August incident sent 484 messages — this would have stopped it at 50.
const globalSignupLimiter = makeLimiter({
  requests: 50, window: '1 h', prefix: 'sendotp:global:signup',
});

// Resets only affect people who already have an account, so the number should
// always be small. If 15 people reset in one hour, something is wrong.
const globalResetLimiter = makeLimiter({
  requests: 15, window: '1 h', prefix: 'sendotp:global:reset',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { phone, purpose } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });

  const isReset = purpose === 'reset';

  // ---- Gate 1: US only, free ---------------------------------------------
  //
  // The old code ended with:
  //
  //   else if (!phone.startsWith('+')) phone = '+' + phone;
  //
  // Non-digits had already been stripped, so that branch always ran and built
  // +223... numbers for Mali. There was no country check at all.
  //
  // A foreign number now dies here, before Twilio is contacted, at zero cost.
  const normalized = normalizeUsPhone(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'Please enter a valid US phone number.' });
  }

  // ---- Gate 2: rate limits, ~free ----------------------------------------
  //
  // failOpen: false everywhere. If Redis is unreachable we refuse to send. An
  // SMS endpoint running with no limits is worse than one that is briefly
  // unavailable — that is exactly how the August bill happened.
  const globalLimiter = isReset ? globalResetLimiter : globalSignupLimiter;

  const [globalOk, phoneOk, ipOk] = await Promise.all([
    allow(globalLimiter, 'all', { failOpen: false }),
    allow(phoneLimiter, keyFor(normalized), { failOpen: false }),
    allow(ipLimiter, keyFor(clientIp(req)), { failOpen: false }),
  ]);

  if (!globalOk) {
    // Worth alerting on: either real growth or an attack in progress.
    console.error('[send-otp] GLOBAL LIMIT TRIPPED', {
      flow: isReset ? 'reset' : 'signup',
      ip: clientIp(req),
    });
    return res.status(503).json({
      error: isReset
        ? 'PIN reset is temporarily unavailable. Please try again later.'
        : 'Signup is temporarily unavailable. Please try again later.',
    });
  }

  if (!phoneOk || !ipOk) {
    return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  }

  // ---- Gate 3: account state ---------------------------------------------
  //
  // The old version wrapped this in a try/catch that fell through to Twilio if
  // the lookup failed, with a comment saying downstream steps would protect
  // us. They do not — Twilio IS the downstream step. A Supabase outage meant
  // unrestricted sending. It now fails closed.
  let exists;
  try {
    const lookupRes = await fetch(
      `${SUPABASE_URL}/rest/v1/tasters?phone_number=eq.${encodeURIComponent(normalized)}&select=id`,
      {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }
    );

    if (!lookupRes.ok) throw new Error(`lookup failed: ${lookupRes.status}`);

    const rows = await lookupRes.json();
    exists = Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.error('[send-otp] account lookup failed', e?.message);
    return res.status(503).json({ error: 'Verification is temporarily unavailable. Please try again later.' });
  }

  if (isReset) {
    if (!exists) {
      return res.status(404).json({ error: 'No account found with this phone number.', code: 'NOT_REGISTERED' });
    }
  } else if (exists) {
    return res.status(409).json({ error: 'This phone number already has an account.', code: 'ALREADY_REGISTERED' });
  }

  // ---- Gate 4: send ------------------------------------------------------
  try {
    const response = await fetch(
      `https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: normalized, Channel: 'sms' }),
      }
    );

    const data = await response.json();

    if (data.status === 'pending') {
      return res.status(200).json({ success: true });
    }

    // Twilio's own message can reveal routing and account details, so it is
    // logged rather than returned to the browser.
    console.error('[send-otp] twilio rejected', data);
    return res.status(400).json({ error: 'Could not send verification code.' });
  } catch (err) {
    console.error('[send-otp]', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
