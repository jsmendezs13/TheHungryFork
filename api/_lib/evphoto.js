// api/_lib/evphoto.js
//
// r51 (Sebastian, 3 Nov 18:25: "would it be possible have a photo as the
// another invitation? That would be cool"; the 4 pictures: "I love the
// pictures you chose"): a photo for each event. Migration 35 (events.photo,
// events.photo_next, the private bucket "event-photos").
//
// How a photo travels (like the photos in conversations, api/_lib/files.js):
//   1. the manager's page makes two JPEGs on the phone: the photo (at most
//      1600 px) and a 1200 × 630 one for link previews (WhatsApp, iMessage…);
//   2. it asks for a slot (ev_photo_slot): a new random name, written as the
//      event's photo_next, and two one-time upload addresses from Supabase
//      Storage. The browser sends the files straight there;
//   3. ev_photo_set: the server checks both files are really there, JPEGs,
//      and not too big; only then is the name the event's photo (the old
//      photo's files are deleted);
//   4. anyone sees it at /event-photo/<name>.jpg (vercel.json → here): the
//      name cannot be guessed, the bucket stays private, and the answer can be
//      kept by browsers and Vercel for a year (a new photo = a new name).

import crypto from 'node:crypto';
import { sb } from './roles.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';
export const PHOTO_BUCKET = 'event-photos';
export const PHOTO_MAX = 3 * 1024 * 1024;     // the photo (the bucket says the same)
export const OG_MAX = 600 * 1024;             // the preview's picture (WhatsApp shows small ones best)
const NAME = /^[0-9a-f]{32}$/;
const FILE = /^([0-9a-f]{32})(_og)?\.jpg$/;

export const PHOTO_ERRORS = {
  migration: 'Event photos are not switched on yet (migration 35).',
  storage: 'The photo could not be prepared. Please try again in a moment.',
  missing: 'The photo did not arrive. Please choose it again.',
  bad: 'That file is not a photo (JPEG). Please choose another one.',
  big: 'That photo is too big. Please choose another one.',
  gone: 'That photo can not be used any more. Please choose it again.',
};

function headers(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, ...extra };
}
// Supabase Storage, the way storage-js asks it. Never throws.
async function storage(path, { method = 'GET', body, extra = {}, raw = false } = {}) {
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1' + path, {
      method,
      headers: headers(body !== undefined ? { 'Content-Type': 'application/json', ...extra } : extra),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return { ok: res.ok, status: res.status, res };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) console.error('[evphoto] storage', res.status, method, path.replace(/[0-9a-f]{32}/g, '…'), text.slice(0, 200));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('[evphoto] storage threw', method, err && err.message);
    return { ok: false, status: 0, data: null };
  }
}

const folder = (e) => `${Number(e.restaurant_id)}/${Number(e.id)}`;
export const photoPath = (e, name, og) => `${folder(e)}/${name}${og ? '_og' : ''}.jpg`;
// What the pages and the previews use (the site's own address, so the photo is never a Supabase link).
export const photoUrl = (name, og) => (name && NAME.test(String(name)) ? `/event-photo/${name}${og ? '_og' : ''}.jpg` : null);

async function info(path) {
  const slash = path.lastIndexOf('/');
  const got = await storage(`/object/list/${PHOTO_BUCKET}`, {
    method: 'POST', body: { prefix: path.slice(0, slash), search: path.slice(slash + 1), limit: 2, offset: 0 },
  });
  if (!got.ok || !Array.isArray(got.data)) return null;
  const hit = got.data.find((o) => o && o.name === path.slice(slash + 1));
  if (!hit || !hit.metadata) return null;
  return { size: Number(hit.metadata.size), mime: hit.metadata.mimetype || hit.metadata.contentType || null };
}
async function isJpeg(path) {
  const got = await storage(`/object/${PHOTO_BUCKET}/${path}`, { extra: { Range: 'bytes=0-15' }, raw: true });
  if (!got.ok) return false;
  try {
    const b = new Uint8Array(await got.res.arrayBuffer());
    return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  } catch { return false; }
}
async function forget(e, name) {
  if (!name || !NAME.test(String(name))) return;
  await storage(`/object/${PHOTO_BUCKET}`, { method: 'DELETE', body: { prefixes: [photoPath(e, name, false), photoPath(e, name, true)] } });
}
const noColumn = (r) => r && (r.status === 400 || r.status === 404) && /photo/.test(JSON.stringify(r.data || ''));

// 1 · a slot: a new name (the event's photo_next) and two upload addresses.
export async function photoSlot(e) {
  const name = crypto.randomBytes(16).toString('hex');
  if (e.photo_next && e.photo_next !== e.photo) await forget(e, e.photo_next);   // the last one that never arrived
  const up = await sb(`/events?id=eq.${Number(e.id)}&restaurant_id=eq.${Number(e.restaurant_id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ photo_next: name }),
  });
  if (!up.ok) return { error: noColumn(up) || up.status === 400 ? 'migration' : 'storage' };
  const urls = {};
  for (const og of [false, true]) {
    const signed = await storage(`/object/upload/sign/${PHOTO_BUCKET}/${photoPath(e, name, og)}`, { method: 'POST', body: {} });
    const url = signed.ok && signed.data && (signed.data.url || signed.data.signedURL);
    if (!url || !/^\/object\/upload\/sign\//.test(url)) return { error: signed.status === 404 || signed.status === 400 ? 'migration' : 'storage' };
    urls[og ? 'og' : 'photo'] = SUPABASE_URL + '/storage/v1' + url;
  }
  return { name, upload: urls };
}

// 2 · the photo arrived: both files there, JPEGs, not too big → the event's photo.
export async function photoClaim(e, name) {
  if (!NAME.test(String(name || '')) || name !== e.photo_next) return { error: 'gone' };
  for (const og of [false, true]) {
    const path = photoPath(e, name, og);
    const got = await info(path);
    if (!got) return { error: 'missing' };
    if (got.size > (og ? OG_MAX : PHOTO_MAX) || got.size < 100) { await forget(e, name); return { error: 'big' }; }
    if ((got.mime && got.mime !== 'image/jpeg') || !(await isJpeg(path))) { await forget(e, name); return { error: 'bad' }; }
  }
  const set = await sb(`/events?id=eq.${Number(e.id)}&restaurant_id=eq.${Number(e.restaurant_id)}&photo_next=eq.${name}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ photo: name, photo_next: null }),
  });
  if (!set.ok || !Array.isArray(set.data) || !set.data.length) return { error: 'gone' };
  if (e.photo && e.photo !== name) await forget(e, e.photo);
  return { event: set.data[0] };
}

// 3 · no photo.
export async function photoRemove(e) {
  const set = await sb(`/events?id=eq.${Number(e.id)}&restaurant_id=eq.${Number(e.restaurant_id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ photo: null, photo_next: null }),
  });
  if (!set.ok || !Array.isArray(set.data) || !set.data.length) return { error: noColumn(set) ? 'migration' : 'storage' };
  await forget(e, e.photo);
  if (e.photo_next && e.photo_next !== e.photo) await forget(e, e.photo_next);
  return { event: set.data[0] };
}

// 4 · GET /event-photo/<name>.jpg (and <name>_og.jpg): the photo of the event that has that name.
export async function servePhoto(req, res, file) {
  const m = FILE.exec(String(file || ''));
  const none = () => { res.setHeader('Cache-Control', 'no-store'); return res.status(404).json({ error: 'No such photo.' }); };
  if (!m) return none();
  const r = await sb(`/events?photo=eq.${m[1]}&select=id,restaurant_id,photo&limit=1`);
  const e = r.ok && Array.isArray(r.data) && r.data.length ? r.data[0] : null;
  if (!e) return none();
  const got = await storage(`/object/${PHOTO_BUCKET}/${photoPath(e, m[1], !!m[2])}`, { raw: true });
  if (!got.ok) return none();
  let bytes;
  try { bytes = Buffer.from(await got.res.arrayBuffer()); } catch { return none(); }
  if (!(bytes[0] === 0xFF && bytes[1] === 0xD8)) return none();
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');   // a new photo has a new name
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200);
  return res.end(bytes);
}
