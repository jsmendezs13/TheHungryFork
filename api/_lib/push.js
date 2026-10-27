// api/_lib/push.js
//
// r43 (Sebastian, 26 Oct): notifications on the staff's phones and computers —
// the HF Staff app on the Home Screen (iPhone, iOS 16.4 and later) and any
// browser that supports Web Push. Five kinds, each switched on or off per device:
//
//   messages       a guest writes (a table's chat or a big-party request's)
//                  → those who answer guests there
//   requests       a new big-party request → managers and up
//   bookings       a table booked online → everyone on the team
//   cancellations  a guest cancels a table → everyone on the team
//   changes        someone changed the restaurant's setup (team, menu, hours,
//                  settings): who, what, when → owners and managers, never
//                  crew, never the person who did it (api/_lib/changes.js)
//
// The platform admin counts as everyone's manager. A subscription belongs to a
// trusted device (api/_lib/devices.js): a device removed, or past its 60 days,
// gets nothing.
//
// Web Push without an extra package: the VAPID signature (ES256) and the
// encryption of the message (RFC 8291, aes128gcm) with node:crypto. Only the
// phone can read a message: the push service carries it sealed.
// Keys: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (base64url) in Vercel; without
// them nothing is sent and Settings says notifications are not set up yet.

import crypto from 'node:crypto';
import { sb } from './roles.js';

export const KINDS = ['messages', 'requests', 'bookings', 'cancellations', 'changes'];
const SEND_TIMEOUT_MS = 3000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s || ''), 'base64url');

export function vapidReady() {
  const pub = unb64u(process.env.VAPID_PUBLIC_KEY), priv = unb64u(process.env.VAPID_PRIVATE_KEY);
  return pub.length === 65 && pub[0] === 4 && priv.length === 32;
}
export function publicKey() { return vapidReady() ? process.env.VAPID_PUBLIC_KEY.trim() : null; }

function privateKeyObject() {
  const pub = unb64u(process.env.VAPID_PUBLIC_KEY);
  return crypto.createPrivateKey({ key: {
    kty: 'EC', crv: 'P-256', d: process.env.VAPID_PRIVATE_KEY.trim(), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)),
  }, format: 'jwk' });
}

// "vapid t=<JWT>, k=<public key>" for the push service of this endpoint.
export function vapidHeader(endpoint, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:advisory@sebsanalytics.com' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKeyObject(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${process.env.VAPID_PUBLIC_KEY.trim()}`;
}

// RFC 8291: the message sealed for one subscription (its p256dh and auth keys).
export function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = 65;
  return Buffer.concat([header, asPublic, sealed]);
}

// A push service may only be one of the real ones, over https (never an address of ours).
export function cleanSubscription(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = String(sub.endpoint || '');
  const keys = sub.keys || {};
  let host;
  try { const u = new URL(endpoint); if (u.protocol !== 'https:') return null; host = u.hostname; } catch { return null; }
  if (endpoint.length > 1000 || !/(^|\.)(push\.apple\.com|googleapis\.com|mozilla\.com|mozaws\.net|notify\.windows\.com|push\.services\.mozilla\.com)$/.test(host)) return null;
  if (unb64u(keys.p256dh).length !== 65 || unb64u(keys.auth).length < 16) return null;
  return { endpoint, p256dh: String(keys.p256dh), auth: String(keys.auth) };
}

// One message to one subscription. { ok } | { gone } (404/410: the subscription is dead) | { ok:false }.
export async function sendOne(sub, message, { urgency = 'normal', ttl = 12 * 3600 } = {}) {
  if (!vapidReady()) return { ok: false, off: true };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST', signal: abort.signal,
      headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(ttl), Urgency: urgency },
      body: encrypt(JSON.stringify(message), sub.p256dh, sub.auth),
    });
    if (res.status === 404 || res.status === 410) return { gone: true, status: res.status };
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Who may get which kind, at one restaurant. role: 'platform' | 'owner' | 'manager' | 'crew'.
export function allowedKinds(role, canMessage) {
  if (role === 'platform' || role === 'owner' || role === 'manager') return KINDS.slice();
  if (role === 'crew') return (canMessage ? ['messages'] : []).concat(['bookings', 'cancellations']);   // never "changes"
  return [];
}

// The kinds a person may switch on at all (any of their restaurants).
export async function kindsFor(access) {
  if (!access) return [];
  if (access.isPlatformAdmin) return KINDS.slice();
  const got = await sb(`/restaurant_roles?taster_id=eq.${Number(access.tasterId)}&select=role,can_message`);
  const set = new Set();
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((r) => allowedKinds(r.role, r.can_message === true).forEach((k) => set.add(k)));
  return KINDS.filter((k) => set.has(k));
}

// The restaurant's team who may get this kind: { tasterId: true }.
async function recipients(restaurantId, kind) {
  const [roles, admins] = await Promise.all([
    sb(`/restaurant_roles?restaurant_id=eq.${Number(restaurantId)}&select=taster_id,role,can_message`),
    sb('/tasters?is_platform_admin=eq.true&select=id&limit=20'),
  ]);
  const out = {};
  (roles.ok && Array.isArray(roles.data) ? roles.data : []).forEach((r) => { if (allowedKinds(r.role, r.can_message === true).includes(kind)) out[r.taster_id] = true; });
  (admins.ok && Array.isArray(admins.data) ? admins.data : []).forEach((t) => { out[t.id] = true; });
  return out;
}

// Tell the team. message: { title, body, url, tag }. except: the account that
// caused it (a change is not told to the person who made it). Never throws,
// never slow for long (3 s at most per phone, all at once). Returns how many went.
export async function notifyStaff(restaurantId, kind, message, { urgency, except } = {}) {
  try {
    if (!vapidReady() || !KINDS.includes(kind)) return 0;
    const who = Object.keys(await recipients(restaurantId, kind)).map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n !== Number(except));
    if (!who.length) return 0;
    const subs = await sb(`/push_subscriptions?taster_id=in.(${who.join(',')})&kinds=cs.{${kind}}&select=id,device_id,endpoint,p256dh,auth,failures&limit=200`);
    if (!subs.ok || !Array.isArray(subs.data) || !subs.data.length) return 0;
    const devIds = [...new Set(subs.data.map((x) => Number(x.device_id)))];
    const devs = await sb(`/staff_devices?id=in.(${devIds.join(',')})&revoked_at=is.null&trusted_until=gt.${new Date().toISOString()}&select=id`);
    const live = new Set((devs.ok && Array.isArray(devs.data) ? devs.data : []).map((d) => Number(d.id)));
    const list = subs.data.filter((x) => live.has(Number(x.device_id)));
    const results = await Promise.all(list.map((x) => sendOne(x, { ...message, kind }, { urgency: urgency || (kind === 'messages' || kind === 'requests' ? 'high' : 'normal') })));
    const dead = list.filter((x, i) => results[i].gone).map((x) => Number(x.id));
    if (dead.length) await sb(`/push_subscriptions?id=in.(${dead.join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const ok = list.filter((x, i) => results[i].ok).map((x) => Number(x.id));
    if (ok.length) await sb(`/push_subscriptions?id=in.(${ok.join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_ok_at: new Date().toISOString(), failures: 0 }) });
    return ok.length;
  } catch (err) {
    console.error('[push] notify threw', kind, err && err.message);
    return 0;
  }
}

// Words for a notification: one line, at most 120 letters.
export function line(text, max = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const a = Array.from(t);
  return a.length > max ? a.slice(0, max - 1).join('') + '…' : t;
}
