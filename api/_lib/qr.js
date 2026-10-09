// api/_lib/qr.js
//
// The table's QR code (migration 18). It carries one link:
//
//   https://<the restaurant's site>/manager#arrive=<arrival token>
//
// (r22: the addresses lost their .html. QR codes made before still work: the
// old address forwards to the new one and keeps the #arrive= part.)
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
import zlib from 'node:zlib';
import { sb } from './roles.js';
import { LOGO_W, LOGO_H, LOGO_PALETTE, LOGO_PIXELS_DEFLATED } from './qr-logo.js';

export const QR_CID = 'table-qr';          // the name the email's <img src="cid:…"> points at
const TOKEN = /^[0-9a-f]{32}$/;

// ── THE LOOK (r22, Sebastian 8 Oct: "I want a QR code like this one") ──
// His steak-on-a-fork logo in the middle, dark square dots, the three corner
// squares dark and softly rounded, a red frame around it all. The logo hides
// the dots under it, so the code carries the most error correction there is
// (H: 30% of it can be missing); tested with four QR readers, sharp and
// damaged (small, blurred, tilted, dim, glare, a poor photo).
// Drawn here into a small palette PNG (node's own zlib, nothing to install):
// one picture for the page, the shared card and the email alike.
const INK = [0x16, 0x12, 0x10], RED = [0xE0, 0x1E, 0x1A], WHITE = [0xFF, 0xFF, 0xFF];   // black like the fork, red like his frame
const MOD = 10;                                              // pixels per dot
const QUIET = 2, FRAME = 1.6, EDGE = 0.7, ROUND = 3.6;       // in dots: white, the red frame, white, its corners
const LOGO_PAD = 0.6;                                        // dots left white around the logo
const STEPS = 16;                                            // shades of ink and of red over white (smooth curves)
// The palette: 0 white, then the ink's shades, then the red's, then the logo's colours.
const PALETTE = (() => {
  const out = [...WHITE];
  for (const c of [INK, RED]) {
    for (let k = 1; k <= STEPS; k++) { const a = k / STEPS; for (let j = 0; j < 3; j++) out.push(Math.round(c[j] * a + 255 * (1 - a))); }
  }
  return Buffer.from(out.concat(LOGO_PALETTE));
})();
const SHADE_INK = 1, SHADE_RED = 1 + STEPS, LOGO_FIRST = 1 + 2 * STEPS;
let logoPixels = null;
function logo() {
  if (!logoPixels) logoPixels = zlib.inflateSync(Buffer.from(LOGO_PIXELS_DEFLATED, 'base64'));
  return logoPixels;
}

// How much of a pixel (its centre at x, y) lies inside a rounded rectangle:
// a signed distance, smoothed over one pixel, so the curves are not jagged.
function inside(x, y, x0, y0, x1, y1, r) {
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
  const qx = Math.abs(x - (x0 + hx)) - (hx - r), qy = Math.abs(y - (y0 + hy)) - (hy - r);
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.min(1, Math.max(0, 0.5 - d));
}

// Everything that is the same in every code of one size — the red frame, the
// three corner squares and the logo — is drawn once and kept (r23: the
// pictures cost a fifth of what they did). Only the dots are drawn per code.
const TEMPLATES = new Map();
function template(n) {
  if (TEMPLATES.has(n)) return TEMPLATES.get(n);
  const off = Math.round((QUIET + FRAME + EDGE) * MOD);
  const W = n * MOD + off * 2;
  const px = Buffer.alloc(W * W);                             // palette numbers, 0 = white
  const shade = (first, a) => (a < 0.5 / STEPS ? 0 : first + Math.min(STEPS, Math.round(a * STEPS)) - 1);
  // the red frame: only near its edges is there anything to work out
  const e = EDGE * MOD, f = FRAME * MOD, R = ROUND * MOD, band = Math.ceil(e + Math.max(f, R)) + 2;
  for (let y = 0; y < W; y++) {
    const full = y < band || y >= W - band;
    for (let x = 0; x < W; x++) {
      if (!full && x === band) x = W - band;                  // the middle of a row: no frame there
      const cx = x + 0.5, cy = y + 0.5;
      const a = inside(cx, cy, e, e, W - e, W - e, R) - inside(cx, cy, e + f, e + f, W - e - f, W - e - f, R - f);
      if (a > 0) px[y * W + x] = shade(SHADE_RED, a);
    }
  }
  // the three corner squares: a ring with softly rounded corners, and its centre
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const X = off + c0 * MOD, Y = off + r0 * MOD;
    for (let y = 0; y < 7 * MOD; y++) {
      for (let x = 0; x < 7 * MOD; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        const ring = inside(cx, cy, 0, 0, 7 * MOD, 7 * MOD, 0.55 * MOD) - inside(cx, cy, MOD, MOD, 6 * MOD, 6 * MOD, 0);
        const dot = inside(cx, cy, 2 * MOD, 2 * MOD, 5 * MOD, 5 * MOD, 0.33 * MOD);
        px[(Y + y) * W + X + x] = shade(SHADE_INK, Math.max(ring, dot));
      }
    }
  }
  // the logo, in the middle (already on white)
  const mid = n / 2, L = logo();
  const lx = Math.round(off + mid * MOD - LOGO_W / 2), ly = Math.round(off + mid * MOD - LOGO_H / 2);
  for (let y = 0; y < LOGO_H; y++) for (let x = 0; x < LOGO_W; x++) px[(ly + y) * W + lx + x] = LOGO_FIRST + L[y * LOGO_W + x];
  const t = { W, off, px };
  TEMPLATES.set(n, t);
  return t;
}
const isEye = (n, r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
const underLogo = (n, r, c) => Math.abs(c + 0.5 - n / 2) < LOGO_W / MOD / 2 + LOGO_PAD && Math.abs(r + 0.5 - n / 2) < LOGO_H / MOD / 2 + LOGO_PAD;

// The finished pictures of the last few hundred links, kept while this server
// is warm: a guest opening My Reservations again gets them at once.
const DRAWN = new Map(), KEEP = 300;
export function drawTableQr(text) {
  const kept = DRAWN.get(text);
  if (kept) { DRAWN.delete(text); DRAWN.set(text, kept); return kept; }
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size, bits = qr.modules.data;
  const { W, off, px: base } = template(n);
  const px = Buffer.from(base);
  const full = SHADE_INK + STEPS - 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!bits[r * n + c] || isEye(n, r, c) || underLogo(n, r, c)) continue;
      for (let y = 0; y < MOD; y++) { const at = (off + r * MOD + y) * W + off + c * MOD; px.fill(full, at, at + MOD); }
    }
  }
  const picture = png(px, W, W);
  DRAWN.set(text, picture);
  if (DRAWN.size > KEEP) DRAWN.delete(DRAWN.keys().next().value);
  return picture;
}

// The same look as an SVG (r23: the My Visits code, Sebastian 8 Oct "it looks
// as well as the new version"): sharp at any size; the logo inside it as a
// small picture.
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
let logoPng = null;
function logoDataUrl() {
  if (!logoPng) {
    const L = logo(), pal = Buffer.from(LOGO_PALETTE);
    logoPng = 'data:image/png;base64,' + png(L, LOGO_W, LOGO_H, pal).toString('base64');
  }
  return logoPng;
}
export function tableQrSvg(text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'H' });
  const n = qr.modules.size, bits = qr.modules.data;
  const pad = QUIET + FRAME + EDGE, S = n + pad * 2;
  let dots = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (bits[r * n + c] && !isEye(n, r, c) && !underLogo(n, r, c)) dots += `M${c} ${r}h1v1h-1z`;
    }
  }
  const s = 0.55, ink = hex(INK);
  const eyes = [[0, 0], [0, n - 7], [n - 7, 0]].map(([r, c]) =>
    `<path fill-rule="evenodd" fill="${ink}" d="M${c + s} ${r}h${7 - 2 * s}a${s} ${s} 0 0 1 ${s} ${s}v${7 - 2 * s}a${s} ${s} 0 0 1 ${-s} ${s}h${-(7 - 2 * s)}a${s} ${s} 0 0 1 ${-s} ${-s}v${-(7 - 2 * s)}a${s} ${s} 0 0 1 ${s} ${-s}z`
    + `M${c + 1} ${r + 1}v5h5v-5z"/><rect x="${c + 2}" y="${r + 2}" width="3" height="3" rx="0.33" fill="${ink}"/>`).join('');
  const lw = LOGO_W / MOD, lh = LOGO_H / MOD, o = -pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${o} ${o} ${S} ${S}" role="img" aria-label="QR code">`
    + `<rect x="${o}" y="${o}" width="${S}" height="${S}" fill="#fff"/>`
    + `<rect x="${o + EDGE + FRAME / 2}" y="${o + EDGE + FRAME / 2}" width="${S - 2 * EDGE - FRAME}" height="${S - 2 * EDGE - FRAME}" rx="${ROUND - FRAME / 2}" fill="none" stroke="${hex(RED)}" stroke-width="${FRAME}"/>`
    + `<path fill="${ink}" shape-rendering="crispEdges" d="${dots}"/>` + eyes
    + `<image href="${logoDataUrl()}" x="${n / 2 - lw / 2}" y="${n / 2 - lh / 2}" width="${lw}" height="${lh}"/>`
    + '</svg>';
}

// A palette PNG: the signature, IHDR, PLTE, the pixels deflated, IEND.
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function png(px, w, h, palette = PALETTE) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;      // 8 bits, a palette
  const rows = Buffer.alloc((w + 1) * h);                                             // each row: filter 0, then its pixels
  for (let y = 0; y < h; y++) px.copy(rows, y * (w + 1) + 1, y * w, (y + 1) * w);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', palette),
    chunk('IDAT', zlib.deflateSync(rows, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

export function cleanArrivalToken(value) {
  const t = String(value || '').trim().toLowerCase();
  return TOKEN.test(t) ? t : null;
}

export function arrivalUrl(settings, token) {
  const site = (settings && settings.site_url) || 'https://thehungryfork.fun';
  return `${site}/manager#arrive=${token}`;
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
  try { return 'data:image/png;base64,' + drawTableQr(arrivalUrl(settings, token)).toString('base64'); }
  catch (err) { console.error('[qr] data url failed', err && err.message); return null; }
}

// For an email: a PNG attached inline, which every inbox shows (Gmail does not
// show images written into the email itself as data).
export async function qrAttachment(settings, token) {
  if (!TOKEN.test(String(token || ''))) return null;
  try {
    const picture = drawTableQr(arrivalUrl(settings, token));
    return { filename: 'table-qr.png', content: picture.toString('base64'), content_id: QR_CID };
  } catch (err) {
    console.error('[qr] png failed', err && err.message);
    return null;
  }
}
