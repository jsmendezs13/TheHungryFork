// api/_lib/sms.js
//
// r43: the text-message code that confirms a staff device (Twilio Verify, the
// same service as signup and "Forgot your PIN"). Twilio picks the code and
// checks it; we only ask it to send one and to say whether a typed code is right.
//
// The lesson from August (484 messages, $160): every send is capped — per
// account, per day, and for everybody together — and the caps refuse (fail
// closed) when they cannot be counted.

import { makeLimiter, allow, keyFor } from './auth.js';

const perHour  = makeLimiter({ requests: 5,  window: '1 h',  prefix: 'devsms:acct:h' });
const perDay   = makeLimiter({ requests: 10, window: '24 h', prefix: 'devsms:acct:d' });
const everyone = makeLimiter({ requests: 30, window: '1 h',  prefix: 'devsms:global' });
const checks   = makeLimiter({ requests: 6,  window: '15 m', prefix: 'devsms:check' });

function twilioAuth() {
  return 'Basic ' + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
}
function ready() {
  return !!(process.env.TWILIO_VERIFY_SERVICE_SID && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

// Sends a code to the account's own phone. { ok } or { ok:false, status, error }.
export async function sendCode(accountId, phone) {
  if (!/^\+1\d{10}$/.test(String(phone || ''))) return { ok: false, status: 400, error: 'This account has no US phone number to send the code to.' };
  if (!ready()) return { ok: false, status: 503, error: 'Text messages are not set up. Please tell Seb\'s Analytics.' };
  if (!(await allow(perHour, keyFor('a' + accountId), { failOpen: false }))
      || !(await allow(perDay, keyFor('a' + accountId), { failOpen: false }))
      || !(await allow(everyone, keyFor('all'), { failOpen: false }))) {
    return { ok: false, status: 429, error: 'Too many codes for now. Please wait an hour and try again.' };
  }
  try {
    const res = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/Verifications`, {
      method: 'POST',
      headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, Channel: 'sms' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'pending') return { ok: true };
    console.error('[sms] twilio rejected', res.status, data && data.code);
    return { ok: false, status: 502, error: 'The code could not be sent. Please try again in a moment.' };
  } catch (err) {
    console.error('[sms] send threw', err && err.message);
    return { ok: false, status: 502, error: 'The code could not be sent. Please try again in a moment.' };
  }
}

// Is this the code Twilio sent to that phone? { ok } or { ok:false, status, error }.
export async function checkCode(accountId, phone, code) {
  const typed = String(code || '').trim();
  if (!/^\d{4,10}$/.test(typed)) return { ok: false, status: 400, error: 'Type the code from the text message.' };
  if (!ready()) return { ok: false, status: 503, error: 'Text messages are not set up. Please tell Seb\'s Analytics.' };
  if (!(await allow(checks, keyFor('a' + accountId), { failOpen: false }))) {
    return { ok: false, status: 429, error: 'Too many tries. Please wait 15 minutes.' };
  }
  try {
    const res = await fetch(`https://verify.twilio.com/v2/Services/${process.env.TWILIO_VERIFY_SERVICE_SID}/VerificationCheck`, {
      method: 'POST',
      headers: { Authorization: twilioAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: phone, Code: typed }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'approved') return { ok: true };
    return { ok: false, status: 400, error: 'That code is not right, or it is too old. Check the text message, or send a new code.' };
  } catch (err) {
    console.error('[sms] check threw', err && err.message);
    return { ok: false, status: 502, error: 'The code could not be checked. Please try again in a moment.' };
  }
}

// "(•••) •••-0137": enough for a person to know which phone, nothing more.
export function phoneHint(phone) {
  const m = /(\d{4})$/.exec(String(phone || ''));
  return m ? `(•••) •••-${m[1]}` : 'your phone';
}
