// api/_lib/qr.js
//
// The table's QR code (migration 18). It carries one link:
//
//   https://<the restaurant's site>/manager.html#arrive=<arrival token>
//
// The waiter scans it with the phone's own camera; the manager page opens that
// one table and offers Arrived — to the whole crew, because the token proves
// the guest is standing there with it (api/_lib/staff.js, staff_scan). Anyone
// else who scans it sees a page asking staff to log in. The token is 32 random
// hex characters made by the database; it is only ever read here, to draw the
// QR for the guest, never in a staff list.
//
// "One-time" is the table's own state: once it says Arrived, the same QR only
// says so.

import QRCode from 'qrcode';
import { sb } from './roles.js';

export const QR_CID = 'table-qr';          // the name the email's <img src="cid:…"> points at
const TOKEN = /^[0-9a-f]{32}$/;

// Dark brown on white, a quiet zone of one module (the white card around it
// gives the rest), and medium error correction: a scuffed phone screen at a
// dim door still reads.
const LOOK = { margin: 1, width: 400, errorCorrectionLevel: 'M', color: { dark: '#2B211A', light: '#FFFFFF' } };

export function cleanArrivalToken(value) {
  const t = String(value || '').trim().toLowerCase();
  return TOKEN.test(t) ? t : null;
}

export function arrivalUrl(settings, token) {
  const site = (settings && settings.site_url) || 'https://thehungryfork.fun';
  return `${site}/manager.html#arrive=${token}`;
}

// The arrival tokens of some tables, by id. Never throws: a QR is a courtesy,
// the booking is already the guest's.
export async function arrivalTokens(ids) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return {};
  try {
    const got = await sb(`/reservations?id=in.(${list.join(',')})&select=id,arrival_token`);
    const out = {};
    (got.ok && Array.isArray(got.data) ? got.data : []).forEach((r) => {
      if (TOKEN.test(String(r.arrival_token || ''))) out[r.id] = r.arrival_token;
    });
    return out;
  } catch (err) {
    console.error('[qr] tokens read failed', err && err.message);
    return {};
  }
}

// For a page: an <img src> the browser can draw at once.
export async function qrDataUrl(settings, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  try { return await QRCode.toDataURL(arrivalUrl(settings, token), LOOK); }
  catch (err) { console.error('[qr] data url failed', err && err.message); return null; }
}

// For an email: a PNG attached inline, which every inbox shows (Gmail does not
// show images written into the email itself as data).
export async function qrAttachment(settings, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  try {
    const png = await QRCode.toBuffer(arrivalUrl(settings, token), { ...LOOK, type: 'png' });
    return { filename: 'table-qr.png', content: png.toString('base64'), content_id: QR_CID };
  } catch (err) {
    console.error('[qr] png failed', err && err.message);
    return null;
  }
}
