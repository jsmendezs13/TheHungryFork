// api/_lib/email.js
//
// The emails a guest gets about a table: the confirmation, the reminder the day
// before, and inside both a link that cancels the table without logging in.
//
// One Resend account (Seb's Analytics) sends for every restaurant. What the
// guest sees — the name, the address, where a reply goes — is a setting of the
// restaurant (migration 16), so a table at The Hungry Fork is confirmed by The
// Hungry Fork, from its own domain.
//
// Two rules hold everywhere in here:
//
//   · An email never decides whether a booking happened. If Resend is down,
//     the key is missing or the domain is not verified yet, the guest still has
//     the table and the screen still shows the code; only the email is missing,
//     and the reason is written on the booking (email_error).
//   · Nothing from the guest is trusted as HTML. Their name and notes are
//     escaped before they go anywhere near a template.
//
// Resend is called with fetch rather than its npm package, so package.json does
// not change and there is nothing new to install on Vercel.

import crypto from 'node:crypto';
import { sb } from './roles.js';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 6000;

// ── is there anything to send with? ──────────────────────────────────────────
export function emailReady(settings) {
  return Boolean(
    process.env.RESEND_API_KEY &&
    settings && settings.email_enabled && settings.email_from_address
  );
}

// "The Hungry Fork <reservations@send.thehungryfork.fun>". The name is cleaned
// of anything that could break the header — a restaurant called
// 'Joe's "Place"' must not turn into two addresses.
export function senderFor(settings, restaurant) {
  const rawName = (settings && settings.email_from_name) || (restaurant && restaurant.name) || 'Reservations';
  const name = String(rawName).replace(/[<>"\\\r\n]/g, '').trim().slice(0, 80) || 'Reservations';
  return {
    // Quoted, so a name with a full stop or a comma ("Joe's Diner, Inc.") is
    // still one name and not the start of a second address.
    from: `"${name}" <${settings.email_from_address}>`,
    replyTo: settings.email_reply_to || null,
    name,
  };
}

// ── the guest's address ──────────────────────────────────────────────────────
// Only a plain address is ever sent to. The booking form accepts looser text,
// and 'name<v@gmail.com>' would reach v@gmail.com while counting as a different
// address for the cap below.
export function sendableAddress(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.length <= 120 && /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(text) ? text : null;
}
// The mailbox behind an address, for counting: v+1@gmail.com, v.ictim@gmail.com
// and victim@googlemail.com all land in one inbox, so they share one limit.
export function mailboxKey(address) {
  const [local = '', domain = ''] = String(address || '').toLowerCase().split('@');
  let user = local.split('+')[0];
  let host = domain;
  if (host === 'googlemail.com') host = 'gmail.com';
  if (host === 'gmail.com') user = user.replace(/\./g, '');
  return `${user}@${host}`;
}
// The greeting uses the first name only when it looks like a name. Whatever a
// stranger types into "name" otherwise lands, signed, in someone's inbox — and
// 'https://evil.example' would become a clickable link there.
export function greetingName(guestName) {
  const first = String(guestName || '').trim().split(/\s+/)[0] || '';
  return /^\p{L}[\p{L}'\u2019-]{0,29}$/u.test(first) ? first : '';
}

// ── the cancel link ──────────────────────────────────────────────────────────
// 24 random bytes: 192 bits, which nobody guesses. The link carries the token;
// the database keeps only its SHA-256, so reading the database is not enough
// to cancel anybody's table.
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}
export function newLinkToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, hash: hashToken(token) };
}
export function cleanToken(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9_-]{32}$/.test(text) ? text : null;
}
export async function saveLink(reservationId, hash, purpose) {
  const saved = await sb('/reservation_links', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ token_hash: hash, reservation_id: reservationId, purpose }),
  });
  return saved.ok;
}
// The token goes after #, not ?, so a browser never sends it to a web server.
// (Resend does keep a copy of each email it sends, link included, for a while —
// which is why a link also stops working a week after the table.)
export function cancelUrl(settings, token) {
  const site = (settings && settings.site_url) || 'https://thehungryfork.fun';
  return `${site}/reservations.html#cancel=${token}`;
}

// ── sending ──────────────────────────────────────────────────────────────────
// Never throws. Returns { ok, id } or { ok:false, status, error } in words.
export async function sendEmail({ from, to, replyTo, subject, html, text, attachments, idempotencyKey, tags, timeoutMs }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, status: 0, error: 'RESEND_API_KEY is not set in Vercel' };

  const payload = { from, to: [to], subject, html, text };
  if (replyTo) payload.reply_to = replyTo;
  if (attachments && attachments.length) payload.attachments = attachments;
  if (tags && tags.length) payload.tags = tags;

  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  // Resend keeps these for 24 hours: the same key twice sends one email.
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 256);

  const abort = new AbortController();
  const limit = timeoutMs || SEND_TIMEOUT_MS;
  const timer = setTimeout(() => abort.abort(), limit);
  try {
    const res = await fetch(RESEND_URL, { method: 'POST', headers, body: JSON.stringify(payload), signal: abort.signal });
    let data = {};
    try { data = await res.json(); } catch { /* an empty or non-JSON answer */ }
    if (res.ok && data && data.id) return { ok: true, id: data.id };
    // 409 with one of these names is Resend saying "this idempotency key is
    // already used". It is NOT a delivery: the caller decides what it means.
    const duplicate = res.status === 409 && data &&
      (data.name === 'invalid_idempotent_request' || data.name === 'concurrent_idempotent_requests');
    return { ok: false, status: res.status, duplicate: Boolean(duplicate), error: describeFailure(res.status, data) };
  } catch (err) {
    // A timeout is not a "no": Resend may have sent it and not answered in time.
    if (err && err.name === 'AbortError') {
      return { ok: false, status: 0, timedOut: true, error: `Resend did not answer in ${Math.round(limit / 1000)} seconds — it may have been sent` };
    }
    return { ok: false, status: 0, error: 'Could not reach Resend' };
  } finally {
    clearTimeout(timer);
  }
}

// What went wrong, in the words Sebastian will read on the booking row.
function describeFailure(status, data) {
  const said = data && (data.message || data.error || data.name);
  const hint =
    status === 401 ? 'the API key is wrong' :
    status === 403 ? 'the domain is not verified in Resend yet, or the key may not send from it' :
    status === 409 ? 'Resend has already had an email with this key' :
    status === 422 ? 'Resend refused the email' :
    status === 429 ? 'too many emails — the free plan allows 100 a day' :
    status >= 500  ? 'Resend is having trouble' : 'unexpected answer';
  return (`Resend ${status}: ${hint}` + (said ? ` (${String(said).slice(0, 160)})` : '')).slice(0, 300);
}

// ── words and dates ──────────────────────────────────────────────────────────
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Everything about "when", in the restaurant's own time zone.
export function whenIn(timezone, iso) {
  const d = new Date(iso);
  const f = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).format(d);
  return {
    long:    f({ weekday: 'long', month: 'long', day: 'numeric' }),          // Wednesday, September 23
    short:   f({ weekday: 'short', month: 'short', day: 'numeric' }),        // Wed, Sep 23
    time:    f({ hour: 'numeric', minute: '2-digit', hour12: true }),        // 7:00 PM
    ymd:     new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
  };
}
// "Today" or "Tomorrow" if it is, otherwise the weekday — for the reminder.
export function relativeDay(timezone, iso, now = new Date()) {
  const ymd = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const target = ymd(new Date(iso));
  const today = ymd(now);
  const [y, m, d] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  if (target === today) return 'Today';
  if (target === tomorrow) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(new Date(iso));
}

// ── the calendar file ────────────────────────────────────────────────────────
// The same file the booking screen offers, attached to the confirmation so the
// guest can add the table from their inbox too.
export function icsFor({ code, startIso, minutes, restaurant, party, siteHost }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + (minutes || 90) * 60000);
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
  // RFC 5545: a line longer than 75 octets continues on the next line after a
  // space. Some phones refuse the whole file otherwise.
  const fold = (line) => {
    const out = []; let cur = '';
    for (const ch of line) {
      if (Buffer.byteLength(cur + ch, 'utf8') > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
      cur += ch;
    }
    out.push(cur);
    return out.join('\r\n ');
  };
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seb\'s Analytics//Reservations//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${code}@${siteHost || 'thehungryfork.fun'}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`Table for ${party} at ${restaurant.name}`)}`,
    `LOCATION:${esc(restaurant.address || restaurant.name)}`,
    `DESCRIPTION:${esc(`Booking code ${code}` + (restaurant.phone ? `. Restaurant: ${restaurant.phone}` : ''))}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}

// ── the two emails ───────────────────────────────────────────────────────────
// Plain HTML with inline styles and tables, because that is what every inbox —
// Gmail, Outlook, Apple Mail, a phone in dark mode — draws the same way. Light
// on purpose: a dark email is repainted unpredictably by dark-mode inboxes.
const INK = '#2B211A', MUTED = '#6F6255', RED = '#C8261B', PAPER = '#FCF9F4', LINE = '#E9E0D3', HEAD = '#1E1714';

function layout({ preheader, restaurantName, heading, intro, when, rows, notice, button, footer }) {
  const e = escapeHtml;
  const rowHtml = rows.map(([label, value, strong]) =>
    `<tr><td style="padding:9px 0;border-top:1px solid ${LINE};font:13px/1.4 Arial,Helvetica,sans-serif;color:${MUTED};width:110px;vertical-align:top;">${e(label)}</td>` +
    `<td style="padding:9px 0;border-top:1px solid ${LINE};font:${strong ? 'bold 15px' : '15px'}/1.4 Arial,Helvetica,sans-serif;color:${INK};letter-spacing:${strong ? '.06em' : '0'};">${value}</td></tr>`
  ).join('');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light">
<title>${e(heading)}</title></head>
<body style="margin:0;padding:0;background:${PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAPER};">${e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;overflow:hidden;">
  <tr><td style="background:${HEAD};padding:20px 24px;text-align:center;font:600 22px/1.2 Georgia,'Times New Roman',serif;color:#FCF9F4;letter-spacing:.02em;">${e(restaurantName)}</td></tr>
  <tr><td style="padding:26px 24px 8px;">
    <p style="margin:0 0 6px;font:bold 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:${RED};">${e(heading)}</p>
    <p style="margin:0 0 18px;font:15px/1.5 Arial,Helvetica,sans-serif;color:${INK};">${intro}</p>
    <p style="margin:0;font:600 26px/1.25 Georgia,'Times New Roman',serif;color:${INK};">${e(when.long)}</p>
    <p style="margin:2px 0 16px;font:600 26px/1.25 Georgia,'Times New Roman',serif;color:${RED};">${e(when.time)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>
  </td></tr>
  ${notice ? `<tr><td style="padding:10px 24px 4px;font:14px/1.5 Arial,Helvetica,sans-serif;color:${MUTED};">${notice}</td></tr>` : ''}
  ${button ? `<tr><td style="padding:18px 24px 26px;">
    <p style="margin:0 0 10px;font:14px/1.5 Arial,Helvetica,sans-serif;color:${INK};">${button.lead}</p>
    <a href="${e(button.href)}" style="display:inline-block;padding:12px 22px;border:1px solid ${RED};border-radius:999px;font:bold 13px/1 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${RED};text-decoration:none;">${e(button.label)}</a>
  </td></tr>` : '<tr><td style="padding:0 0 18px;"></td></tr>'}
</table>
<p style="max-width:520px;margin:14px auto 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:${MUTED};text-align:center;">${footer}</p>
</td></tr></table>
</body></html>`;
}

function detailRows({ party, areaName, code, restaurant }) {
  const e = escapeHtml;
  const rows = [['People', e(party + (party === 1 ? ' person' : ' people'))]];
  if (areaName) rows.push(['Room', e(areaName)]);
  rows.push(['Your code', e(code), true]);
  if (restaurant.address) rows.push(['Where', e(restaurant.address)]);
  if (restaurant.phone) {
    const tel = String(restaurant.phone).replace(/[^\d+]/g, '');
    rows.push(['Phone', `<a href="tel:${e(tel)}" style="color:${INK};">${e(restaurant.phone)}</a>`]);
  }
  return rows;
}

// If the link could not be saved, the email still goes out — it just asks the
// guest to call instead of offering a button that would not work.
function callToCancel(restaurant) {
  return restaurant.phone ? `Can't make it? Please call ${restaurant.phone} to cancel.` : 'Can\'t make it? Please call the restaurant to cancel.';
}

function textDetails({ when, party, areaName, code, restaurant }) {
  return [
    `${when.long} at ${when.time}`,
    `${party} ${party === 1 ? 'person' : 'people'}` + (areaName ? ` · ${areaName}` : ''),
    `Your code: ${code}`,
    restaurant.address ? `Where: ${restaurant.address}` : null,
    restaurant.phone ? `Phone: ${restaurant.phone}` : null,
  ].filter(Boolean).join('\n');
}

export function confirmationEmail({ restaurant, timezone, at, party, areaName, code, guestName, graceMinutes, holdMinutes, link, siteHost }) {
  const when = whenIn(timezone, at);
  const first = greetingName(guestName);
  const late = graceMinutes
    ? `Running late? Please call us. After ${graceMinutes} minutes the table goes to the next guest.`
    : 'Running late? Please call us.';
  const subject = `Your table at ${restaurant.name} · ${when.short}, ${when.time}`;
  const html = layout({
    preheader: `${when.long} at ${when.time} · ${party} ${party === 1 ? 'person' : 'people'} · ${code}`,
    restaurantName: restaurant.name,
    heading: 'Your table is booked',
    intro: `${first ? escapeHtml(first) + ', we' : 'We'} look forward to seeing you. Show your code when you arrive.`,
    when,
    rows: detailRows({ party, areaName, code, restaurant }),
    notice: `${escapeHtml(late)}<br>The calendar file is attached — open it to put the table in your phone.`
            + (link ? '' : `<br>${escapeHtml(callToCancel(restaurant))}`),
    button: link ? { lead: 'Can\'t make it? Cancelling takes a minute and gives the table to somebody else.',
                     label: 'Cancel this table', href: link } : null,
    footer: `You booked this table on ${escapeHtml(siteHost)}. This address only sends emails about your bookings.`,
  });
  const text = [
    `${restaurant.name} — your table is booked.`, '',
    textDetails({ when, party, areaName, code, restaurant }), '',
    late, '',
    link ? `Can't make it? Cancel here: ${link}` : callToCancel(restaurant), '',
    `You booked this table on ${siteHost}.`,
  ].join('\n');
  return {
    subject, html, text,
    attachments: [{
      filename: `table-${code}.ics`,
      content: Buffer.from(icsFor({ code, startIso: at, minutes: holdMinutes, restaurant, party, siteHost }), 'utf8').toString('base64'),
    }],
  };
}

export function reminderEmail({ restaurant, timezone, at, party, areaName, code, guestName, link, siteHost, now }) {
  const when = whenIn(timezone, at);
  const day = relativeDay(timezone, at, now);
  const first = greetingName(guestName);
  const subject = `${day}, ${when.time} · your table at ${restaurant.name}`;
  const html = layout({
    preheader: `${day} at ${when.time} · ${party} ${party === 1 ? 'person' : 'people'} · ${code}`,
    restaurantName: restaurant.name,
    heading: day === 'Today' ? 'See you today' : day === 'Tomorrow' ? 'See you tomorrow' : 'See you soon',
    intro: `${first ? escapeHtml(first) + ', a' : 'A'} reminder of your table. Show your code when you arrive.`,
    when,
    rows: detailRows({ party, areaName, code, restaurant }),
    notice: link ? null : escapeHtml(callToCancel(restaurant)),
    button: link ? { lead: 'Plans changed? Tell us now and somebody else can have the table.',
                     label: 'Cancel this table', href: link } : null,
    footer: `You booked this table on ${escapeHtml(siteHost)}. This address only sends emails about your bookings.`,
  });
  const text = [
    `${restaurant.name} — see you ${day.toLowerCase() === 'today' || day.toLowerCase() === 'tomorrow' ? day.toLowerCase() : 'soon'}.`, '',
    textDetails({ when, party, areaName, code, restaurant }), '',
    link ? `Plans changed? Cancel here: ${link}` : callToCancel(restaurant), '',
    `You booked this table on ${siteHost}.`,
  ].join('\n');
  return { subject, html, text };
}

export function hostOf(settings) {
  try { return new URL((settings && settings.site_url) || 'https://thehungryfork.fun').host; }
  catch { return 'thehungryfork.fun'; }
}
