// api/login.js
//
// r43 (Sebastian, 26 Oct): an account with a role (crew, manager, owner, the
// platform admin) logs in on a trusted device only. The PIN alone on a new
// phone or computer gives no session: a code goes by text message to the
// account's phone, and the device is trusted for 60 days once it is typed
// (action "device"; "device_resend" sends another). api/_lib/devices.js.

import {
  makeLimiter,
  allow,
  keyFor,
  normalizeUsPhone,
  verifyPin,
  clientIp,
  stripSecrets,
} from './_lib/auth.js';
import {
  isStaff, findDevice, deviceLabel, sessionFor, challengeFor, readChallenge, createDevice, touchDevice, newDeviceEmail,
} from './_lib/devices.js';
import { sendCode, checkCode, phoneHint } from './_lib/sms.js';

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

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.action === 'device') return confirmDevice(req, res, body);
  if (body.action === 'device_resend') return resendDeviceCode(req, res, body);

  const { phone, pin } = body;
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

    // r43: staff log in on a trusted device only.
    if (await isStaff(taster)) {
      const found = await findDevice(taster.id, body.devices);
      if (found.row) {
        await touchDevice(found.row);
        return res.status(200).json({ success: true, session: sessionFor(taster, found.row.id), taster: stripSecrets(taster), device: { id: found.row.id, label: found.row.label } });
      }
      if (!found.off) {
        if (found.error) return res.status(502).json({ error: 'Could not check this device. Please try again in a moment.' });
        const sent = await sendCode(taster.id, taster.phone_number);
        if (!sent.ok) return res.status(sent.status).json({ error: sent.error });
        console.log('[login] staff account', taster.id, 'on a new device: code sent');
        return res.status(200).json({ success: false, needDevice: true, challenge: challengeFor(taster.id), phoneHint: phoneHint(taster.phone_number) });
      }
      // Before migration 30 there are no devices yet: the login stays as it was.
    }

    return res.status(200).json({ success: true, session: sessionFor(taster, null), taster: stripSecrets(taster) });
  } catch (e) {
    console.error('[login]', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function accountOf(challenge) {
  const id = readChallenge(challenge);
  if (!id) return null;
  const got = await fetch(`${SUPABASE_URL}/rest/v1/tasters?id=eq.${id}&select=*`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY },
  });
  const rows = got.ok ? await got.json() : null;
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// The code from the text message: the device is trusted for 60 days, and the session starts.
async function confirmDevice(req, res, body) {
  const taster = await accountOf(body.challenge);
  if (!taster) return res.status(401).json({ error: 'This step took too long. Please log in again.', reason: 'challenge' });
  const ok = await checkCode(taster.id, taster.phone_number, body.code);
  if (!ok.ok) return res.status(ok.status).json({ error: ok.error });
  const label = deviceLabel(req.headers['user-agent'], body.app === true);
  const made = await createDevice(taster.id, label, body.app === true);
  if (!made) return res.status(502).json({ error: 'Could not save this device. Please try again.' });
  console.log('[login] staff account', taster.id, 'trusted a new device', made.row.id, label);
  await newDeviceEmail(taster, made.row);
  return res.status(200).json({
    success: true, session: sessionFor(taster, made.row.id), taster: stripSecrets(taster),
    device: { id: made.row.id, label: made.row.label, key: made.key, trustedUntil: made.row.trusted_until },
  });
}

async function resendDeviceCode(req, res, body) {
  const taster = await accountOf(body.challenge);
  if (!taster) return res.status(401).json({ error: 'This step took too long. Please log in again.', reason: 'challenge' });
  const sent = await sendCode(taster.id, taster.phone_number);
  if (!sent.ok) return res.status(sent.status).json({ error: sent.error });
  return res.status(200).json({ success: true, phoneHint: phoneHint(taster.phone_number) });
}
