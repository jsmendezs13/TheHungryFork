// api/_lib/devices.js
//
// r43 (Sebastian, 26 Oct): trusted devices for everyone with a role — crew,
// managers, owners and the platform admin. Migration 30 (table staff_devices).
//
//   · Logging in with the phone and the PIN on a phone or computer that is not
//     trusted gives no session yet: a code goes by text message to the
//     account's phone; typed back, that device is trusted for 60 days (Sebastian,
//     26 Oct 22:56: 60, and the code only for a new device).
//   · A device is a random secret kept in that browser (never a "fingerprint").
//     The database keeps only its SHA-256, so reading the database is not
//     enough to become a device.
//   · The session carries the device's number (claim "dev"), and every staff
//     request checks that the device is still trusted (api/_lib/roles.js): a
//     device removed in Settings is logged out at once.
//   · A new device sends an email to the account ("if it wasn't you, remove it").
// Guests (accounts with no role) log in exactly as before.

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { sb } from './roles.js';
import { loadBooking } from './booking.js';
import { emailReady, senderFor, sendEmail, sendableAddress, escapeHtml, hostOf } from './email.js';

export const TRUST_DAYS = 60;
export const TRUST_MS = TRUST_DAYS * 24 * 3600 * 1000;
const DEVICE_COLUMNS = 'id,taster_id,label,app,created_at,verified_at,trusted_until,last_used_at,revoked_at';

export const hashKey = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
export const cleanKey = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v) ? v : null);

// Does this account have a role anywhere (or is it the platform admin)? When the
// roles cannot be read, the answer is yes: a device check is never skipped on a guess.
export async function isStaff(taster) {
  if (!taster) return false;
  if (taster.is_platform_admin) return true;
  const got = await sb(`/restaurant_roles?taster_id=eq.${Number(taster.id)}&select=id&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) return true;
  return got.data.length > 0;
}

// The account's trusted device among the keys this browser holds.
// { off: true } before migration 30; { row } when one is trusted; {} otherwise.
export async function findDevice(tasterId, keys) {
  const list = (Array.isArray(keys) ? keys : [keys]).map(cleanKey).filter(Boolean).slice(0, 5);
  const probe = list.length
    ? await sb(`/staff_devices?taster_id=eq.${Number(tasterId)}&token_hash=in.(${list.map(hashKey).join(',')})` +
               `&revoked_at=is.null&trusted_until=gt.${new Date().toISOString()}&select=${DEVICE_COLUMNS}&limit=1`)
    : await sb(`/staff_devices?taster_id=eq.${Number(tasterId)}&select=id&limit=1`);
  if (!probe.ok) return probe.status === 404 ? { off: true } : { error: probe.status };
  if (!list.length) return {};
  return Array.isArray(probe.data) && probe.data.length ? { row: probe.data[0] } : {};
}

// "iPhone · HF Staff app", "Mac · Chrome", "Windows · Edge"… from the browser's own User-Agent.
export function deviceLabel(ua, app) {
  const s = String(ua || '');
  const what = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
    : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'Computer';
  const how = app ? 'HF Staff app'
    : /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Firefox\/|FxiOS/.test(s) ? 'Firefox'
    : /CriOS|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser';
  return `${what} · ${how}`;
}

// The session: as before, plus the device's number for a staff account.
export function sessionFor(taster, deviceId) {
  return jwt.sign(
    {
      role: 'authenticated',
      taster_id: taster.id,
      restaurant_id: taster.is_restaurant_admin ? taster.restaurant_id : null,
      ...(deviceId ? { dev: Number(deviceId) } : {}),
    },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: '30d', algorithm: 'HS256' },
  );
}

// The ticket between the PIN and the code. Its claim is "account", never
// "taster_id", so it can never be used as a session (roles.js reads taster_id).
export function challengeFor(tasterId) {
  return jwt.sign({ purpose: 'device', account: Number(tasterId) }, process.env.SUPABASE_JWT_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
}
export function readChallenge(token) {
  try {
    const c = jwt.verify(String(token || ''), process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    const id = Number(c.account);
    return c.purpose === 'device' && Number.isInteger(id) && id > 0 && !('taster_id' in c) ? id : null;
  } catch { return null; }
}

// A new trusted device. Returns { key, row } (the key goes to the browser once and is never kept here).
export async function createDevice(tasterId, label, app) {
  const key = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const made = await sb('/staff_devices', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      taster_id: Number(tasterId), token_hash: hashKey(key), label: String(label || 'Device').slice(0, 80), app: !!app,
      verified_at: new Date(now).toISOString(), trusted_until: new Date(now + TRUST_MS).toISOString(), last_used_at: new Date(now).toISOString(),
    }),
  });
  if (!made.ok || !Array.isArray(made.data) || !made.data.length) return null;
  return { key, row: made.data[0] };
}

// Used: noted at most once an hour, so a page asking every few seconds does not write every few seconds.
export async function touchDevice(row) {
  if (!row || (row.last_used_at && Date.now() - Date.parse(row.last_used_at) < 3600 * 1000)) return;
  await sb(`/staff_devices?id=eq.${Number(row.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_used_at: new Date().toISOString() }),
  });
}

export function deviceOut(row, currentId) {
  return {
    id: Number(row.id), label: row.label, app: !!row.app,
    added: row.created_at, lastUsed: row.last_used_at || row.created_at, trustedUntil: row.trusted_until,
    current: Number(row.id) === Number(currentId),
  };
}

export async function listDevices(tasterId) {
  const got = await sb(`/staff_devices?taster_id=eq.${Number(tasterId)}&revoked_at=is.null&trusted_until=gt.${new Date().toISOString()}` +
                       `&select=${DEVICE_COLUMNS}&order=last_used_at.desc.nullslast,id.desc&limit=50`);
  return got.ok && Array.isArray(got.data) ? got.data : null;
}

// Removed: logged out at once, and its notifications stop (its subscriptions go).
export async function removeDevice(tasterId, deviceId, by) {
  const gone = await sb(`/staff_devices?id=eq.${Number(deviceId)}&taster_id=eq.${Number(tasterId)}&revoked_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString(), revoked_by: by ? Number(by) : null }),
  });
  if (!gone.ok || !Array.isArray(gone.data) || !gone.data.length) return false;
  await sb(`/push_subscriptions?device_id=eq.${Number(deviceId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return true;
}

// A new PIN ("Forgot your PIN?"): every trusted device of the account is logged out,
// and their notifications stop. Returns false before migration 30 (no table).
export async function removeAllDevices(tasterId) {
  const gone = await sb(`/staff_devices?taster_id=eq.${Number(tasterId)}&revoked_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ revoked_at: new Date().toISOString(), revoked_by: Number(tasterId) }),
  });
  if (!gone.ok) return false;
  const ids = (Array.isArray(gone.data) ? gone.data : []).map((d) => Number(d.id)).filter((n) => n > 0);
  if (ids.length) await sb(`/push_subscriptions?device_id=in.(${ids.join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return true;
}

// The email that says a device was added. Sent from the restaurant the account
// works at (its sending address). Never fails the login; returns whether it went.
export async function newDeviceEmail(taster, row, timezone = 'America/New_York') {
  try {
    const to = sendableAddress(taster.email);
    if (!to) return false;
    const roles = await sb(`/restaurant_roles?taster_id=eq.${Number(taster.id)}&select=restaurant_id&order=restaurant_id.asc&limit=1`);
    const rid = roles.ok && Array.isArray(roles.data) && roles.data.length ? roles.data[0].restaurant_id : 1;
    const loaded = await loadBooking(rid);
    const settings = loaded && !loaded.error ? loaded.settings : null;
    if (!emailReady(settings)) return false;
    const e = escapeHtml;
    const when = new Intl.DateTimeFormat('en-US', { timeZone: (settings && settings.timezone) || timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      .format(new Date(row.created_at || Date.now()));
    const first = String(taster.first_name || '').trim().split(/\s+/)[0];
    const subject = 'A new device was added to your staff account';
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#FCF9F4;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FCF9F4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #E9E0D3;border-radius:14px;overflow:hidden;">
<tr><td style="background:#1E1714;padding:18px 24px;text-align:center;font:600 22px/1.2 Georgia,'Times New Roman',serif;color:#FCF9F4;">${e(loaded.restaurant.name)} · Staff</td></tr>
<tr><td style="padding:24px;font:15px/1.55 Arial,Helvetica,sans-serif;color:#2B211A;">
<p style="margin:0 0 12px;">${first ? e(first) + ', a' : 'A'} new device can now open your staff account:</p>
<p style="margin:0 0 4px;font:bold 17px/1.4 Arial,Helvetica,sans-serif;">${e(row.label)}</p>
<p style="margin:0 0 16px;color:#6F6255;">${e(when)}</p>
<p style="margin:0 0 10px;">If it was you, there is nothing to do.</p>
<p style="margin:0;"><b>If it wasn't you:</b> open the manager page → Settings → Your devices → <b>Remove</b> it, and change your PIN (Log in → Forgot your PIN?).</p>
</td></tr></table>
<p style="max-width:480px;margin:14px auto 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6F6255;text-align:center;">Sent by ${e(hostOf(settings))} for your safety. Replies to this email are not read.</p>
</td></tr></table></body></html>`;
    const text = `${first ? first + ', a' : 'A'} new device can now open your staff account: ${row.label} (${when}).\n\nIf it was you, there is nothing to do.\nIf it wasn't you: open the manager page → Settings → Your devices → Remove it, and change your PIN (Log in → Forgot your PIN?).`;
    const sender = senderFor(settings, loaded.restaurant);
    const sent = await sendEmail({ from: sender.from, replyTo: null, to, subject, html, text,
      idempotencyKey: `new-device-${row.id}`, tags: [{ name: 'kind', value: 'new-device' }], timeoutMs: 4000 });
    return !!sent.ok;
  } catch (err) {
    console.error('[devices] new device email threw', err && err.message);
    return false;
  }
}
