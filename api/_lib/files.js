// api/_lib/files.js
//
// r42 (Sebastian, 22 Oct 02:47): photos and PDFs in the conversations — a
// table's chat and a big-party request's chat — sent by guests and by the
// restaurant. Migration 29 (table chat_files, bucket "chat-files").
//
// How a file travels:
//   1. the page asks for a slot (…_upload): the server checks who may write
//      in that conversation, the kind and the size, writes a chat_files row
//      (not sent yet) and asks Supabase Storage for a one-time upload address;
//   2. the browser sends the file straight to that address (the file never
//      passes through Vercel, which has a 4.5 MB limit);
//   3. the message is sent with fileId: the server checks that the file is
//      really there, that its size and kind are the ones announced, and that
//      its first bytes are a photo or a PDF (claimFile) — only then is it
//      attached, once;
//   4. reading: the lists carry the file's name, kind and size; the page asks
//      for a link (…_files) that works for one hour, only for files of that
//      conversation.
//
// The rules:
//   · the bucket is private: nobody opens a file without a link from here;
//   · a file is deleted with its conversation: 90 days after the table, or
//     after the day the request asked for (the daily job, forgetOldFiles);
//   · a file chosen but never sent is deleted the next day;
//   · photos are made smaller on the phone before they go up (the pages);
//     every file is at most 10 MB; at most 40 files per conversation.

import crypto from 'node:crypto';
import { sb } from './roles.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';
export const BUCKET = 'chat-files';
export const MAX_FILE = 10 * 1024 * 1024;
export const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const UNSENT_MS = 24 * 3600 * 1000;
export const LINK_SECONDS = 3600;
export const MAX_PER_CONVERSATION = 40;
const FILE_COLUMNS = 'id,restaurant_id,reservation_id,request_id,path,name,mime,size_bytes,from_guest,uploader_id,created_at,sent_at,delete_after';

export const FILE_ERRORS = {
  type: 'Only photos (JPG, PNG, WebP) and PDF files can be sent.',
  size: 'A file can be up to 10 MB.',
  many: 'This conversation has reached 40 files. Please write instead.',
  storage: 'The file could not be prepared. Please try again in a moment.',
  missing: 'The file did not arrive. Please choose it again.',
  bad: 'That file is not a photo or a PDF. Please choose another one.',
  gone: 'That file can not be sent any more. Please choose it again.',
  off: 'Files in conversations are not switched on yet.',
};

function storageHeaders(extra = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: key, Authorization: 'Bearer ' + key, ...extra };
}

// Supabase Storage, the way storage-js asks it. Never throws.
async function storage(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  try {
    const res = await fetch(SUPABASE_URL + '/storage/v1' + path, {
      method,
      headers: storageHeaders(body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (raw) return { ok: res.ok, status: res.status, res };
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) console.error('[files] storage', res.status, method, path.replace(/[0-9a-f]{32}/g, '…'), text.slice(0, 200));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error('[files] storage threw', method, err && err.message);
    return { ok: false, status: 0, data: null };
  }
}

// The file's name as the other side sees it: no folders, no control
// characters, at most 120 letters, and the right ending for its kind.
export function cleanFileName(value, mime) {
  const ext = TYPES[mime] || 'file';
  let name = String(value || '').split(/[\\/]/).pop()
    .replace(/[\u0000-\u001F\u007F\u200B\u2028-\u202E\u2066-\u2069\uFEFF<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (mime && mime.startsWith('image/')) name = name.replace(/\.(heic|heif|png|jpe?g|webp|gif|bmp|tiff?)$/i, '');
  else name = name.replace(/\.pdf$/i, '');
  if (!name) name = mime === 'application/pdf' ? 'file' : 'photo';
  const chars = Array.from(name);
  if (chars.length > 110) name = chars.slice(0, 110).join('');
  return `${name}.${ext}`;
}

export function fileOut(f) {
  if (!f) return null;
  return { id: Number(f.id), name: f.name, mime: f.mime, size: Number(f.size_bytes), kind: f.mime === 'application/pdf' ? 'pdf' : 'photo' };
}

// "📎 Photo" / "📎 menu.pdf": a message that is only a file, in one line.
export function fileLine(f) {
  if (!f) return '📎 File';
  return f.mime === 'application/pdf' ? `📎 ${f.name}` : '📎 Photo';
}

function where(place) {
  return place.reservationId ? `reservation_id=eq.${Number(place.reservationId)}` : `request_id=eq.${Number(place.requestId)}`;
}

// 1 · A slot for one file in one conversation. place: { restaurantId,
// reservationId | requestId }. The caller has already checked that this person
// may write there. Returns { file, uploadUrl } or { error: <key of FILE_ERRORS> }.
export async function makeSlot(place, { fromGuest, uploaderId = null, name, mime, size }) {
  if (!TYPES[mime]) return { error: 'type' };
  const n = Number(size);
  if (!Number.isInteger(n) || n < 1 || n > MAX_FILE) return { error: 'size' };
  const many = await sb(`/chat_files?${where(place)}&select=id&limit=${MAX_PER_CONVERSATION + 1}`);
  if (!many.ok) return { error: many.status === 404 ? 'off' : 'storage' };
  if (Array.isArray(many.data) && many.data.length >= MAX_PER_CONVERSATION) return { error: 'many' };

  const folder = place.reservationId ? 't' + Number(place.reservationId) : 'r' + Number(place.requestId);
  const path = `${Number(place.restaurantId)}/${folder}/${crypto.randomBytes(16).toString('hex')}.${TYPES[mime]}`;
  const made = await sb('/chat_files', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      restaurant_id: Number(place.restaurantId),
      reservation_id: place.reservationId ? Number(place.reservationId) : null,
      request_id: place.requestId ? Number(place.requestId) : null,
      path, name: cleanFileName(name, mime), mime, size_bytes: n, from_guest: !!fromGuest,
      uploader_id: uploaderId ? Number(uploaderId) : null,
      delete_after: new Date(Date.now() + UNSENT_MS).toISOString(),
    }),
  });
  if (!made.ok || !Array.isArray(made.data) || !made.data.length) return { error: made.status === 404 ? 'off' : 'storage' };
  const row = made.data[0];
  const signed = await storage(`/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', body: {} });
  const url = signed.ok && signed.data && (signed.data.url || signed.data.signedURL);
  if (!url || !/^\/object\/upload\/sign\//.test(url)) {
    await sb(`/chat_files?id=eq.${Number(row.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return { error: 'storage' };
  }
  return { file: fileOut(row), uploadUrl: SUPABASE_URL + '/storage/v1' + url };
}

// The first bytes of a photo or a PDF of the kind announced.
export function looksLike(mime, bytes) {
  const b = bytes || new Uint8Array(0);
  const at = (i, list) => list.every((v, k) => b[i + k] === v);
  if (mime === 'image/jpeg') return at(0, [0xFF, 0xD8, 0xFF]);
  if (mime === 'image/png') return at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  if (mime === 'image/webp') return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]);
  if (mime === 'application/pdf') return at(0, [0x25, 0x50, 0x44, 0x46, 0x2D]);
  return false;
}

async function firstBytes(path) {
  const got = await storage(`/object/${BUCKET}/${path}`, { headers: { Range: 'bytes=0-31' }, raw: true });
  if (!got.ok) return null;
  try {
    const reader = got.res.body.getReader();
    const parts = []; let total = 0;
    while (total < 32) {
      const { value, done } = await reader.read();
      if (done) break;
      parts.push(value); total += value.length;
    }
    try { await reader.cancel(); } catch { /* the rest is not needed */ }
    const out = new Uint8Array(Math.min(total, 32)); let k = 0;
    for (const p of parts) for (const v of p) { if (k >= out.length) break; out[k++] = v; }
    return out;
  } catch {
    return null;
  }
}

async function objectInfo(path) {
  const slash = path.lastIndexOf('/');
  const got = await storage(`/object/list/${BUCKET}`, {
    method: 'POST', body: { prefix: path.slice(0, slash), search: path.slice(slash + 1), limit: 2, offset: 0 },
  });
  if (!got.ok || !Array.isArray(got.data)) return null;
  const hit = got.data.find((o) => o && o.name === path.slice(slash + 1));
  if (!hit || !hit.metadata) return null;
  return { size: Number(hit.metadata.size), mime: hit.metadata.mimetype || hit.metadata.contentType || null };
}

export async function removeFiles(rows) {
  const list = rows.filter((f) => f && f.path);
  if (!list.length) return true;
  const gone = await storage(`/object/${BUCKET}`, { method: 'DELETE', body: { prefixes: list.map((f) => f.path) } });
  if (!gone.ok) return false;
  await sb(`/chat_files?id=in.(${list.map((f) => Number(f.id)).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return true;
}

// 3 · The message goes with this file: is it this conversation's, from this
// side, not sent yet, really there and really a photo or a PDF? Then it is
// sent (once) and kept until keepUntil. Returns { file } or { error }.
export async function claimFile(fileId, place, { fromGuest, keepUntil }) {
  const id = Number(fileId);
  if (!Number.isInteger(id) || id < 1) return { error: 'gone' };
  const got = await sb(`/chat_files?id=eq.${id}&${where(place)}&restaurant_id=eq.${Number(place.restaurantId)}&select=${FILE_COLUMNS}&limit=1`);
  if (!got.ok) return { error: got.status === 404 ? 'off' : 'storage' };
  const row = Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!row || row.sent_at || !!row.from_guest !== !!fromGuest || Date.parse(row.created_at) + UNSENT_MS < Date.now()) return { error: 'gone' };
  const info = await objectInfo(row.path);
  if (!info) return { error: 'missing' };
  if (info.size !== Number(row.size_bytes) || (info.mime && info.mime !== row.mime) || info.size > MAX_FILE) {
    await removeFiles([row]);
    return { error: 'bad' };
  }
  const head = await firstBytes(row.path);
  if (!head) return { error: 'missing' };
  if (!looksLike(row.mime, head)) {
    await removeFiles([row]);
    return { error: 'bad' };
  }
  const sent = await sb(`/chat_files?id=eq.${id}&sent_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ sent_at: new Date().toISOString(), delete_after: new Date(keepUntil).toISOString() }),
  });
  if (!sent.ok || !Array.isArray(sent.data) || !sent.data.length) return { error: 'gone' };
  return { file: fileOut(sent.data[0]) };
}

// The files of some messages, by id: { id: {id, name, mime, size, kind} }.
export async function filesById(ids) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = {};
  if (!list.length) return out;
  const got = await sb(`/chat_files?id=in.(${list.join(',')})&select=id,name,mime,size_bytes`);
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((f) => { out[f.id] = fileOut(f); });
  return out;
}

// 4 · Links that work for one hour, for files of this conversation only.
// Returns { links: { id: url } } (a file not of this conversation is simply not there).
export async function fileLinks(place, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 40);
  if (!list.length) return { links: {} };
  const got = await sb(`/chat_files?id=in.(${list.join(',')})&${where(place)}&restaurant_id=eq.${Number(place.restaurantId)}` +
                       '&sent_at=not.is.null&select=id,path,name,mime');
  if (!got.ok) return { error: got.status === 404 ? 'off' : 'storage' };
  const rows = Array.isArray(got.data) ? got.data : [];
  if (!rows.length) return { links: {} };
  const signed = await storage(`/object/sign/${BUCKET}`, { method: 'POST', body: { expiresIn: LINK_SECONDS, paths: rows.map((f) => f.path) } });
  if (!signed.ok || !Array.isArray(signed.data)) return { error: 'storage' };
  const byPath = {};
  signed.data.forEach((s) => { if (s && s.path && s.signedURL && !s.error) byPath[s.path] = s.signedURL; });
  const links = {};
  rows.forEach((f) => {
    const u = byPath[f.path];
    if (!u) return;
    // A PDF opens in the browser; "download" gives it its own name when saved.
    links[f.id] = SUPABASE_URL + '/storage/v1' + u + (f.mime === 'application/pdf' ? '&download=' + encodeURIComponent(f.name) : '');
  });
  return { links, expiresIn: LINK_SECONDS };
}

// A request became a table: its files go with its messages (moveToTable).
export async function moveFiles(requestId, reservationId, keepUntil) {
  await sb(`/chat_files?request_id=eq.${Number(requestId)}&sent_at=not.is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ reservation_id: Number(reservationId), delete_after: new Date(keepUntil).toISOString() }),
  });
}

// The daily job: files whose conversation is gone, and files chosen but never
// sent. Returns how many went, or null when it could not ask. Never throws.
export async function forgetOldFiles(now = Date.now()) {
  try {
    const due = await sb(`/chat_files?delete_after=lt.${new Date(now).toISOString()}&select=id,path&order=delete_after.asc&limit=500`);
    if (!due.ok) return due.status === 404 ? 0 : null;           // before migration 29: nothing to do
    const rows = Array.isArray(due.data) ? due.data : [];
    if (!rows.length) return 0;
    let n = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100);
      if (await removeFiles(part)) n += part.length;
    }
    return n;
  } catch (err) {
    console.error('[files] forget threw', err && err.message);
    return null;
  }
}

export function fileError(res, key) {
  const status = key === 'type' || key === 'size' ? 400 : key === 'many' || key === 'gone' || key === 'bad' || key === 'missing' ? 409 : key === 'off' ? 503 : 502;
  return res.status(status).json({ error: FILE_ERRORS[key] || FILE_ERRORS.storage, reason: 'file_' + key });
}
