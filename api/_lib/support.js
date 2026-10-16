// api/_lib/support.js
//
// r34 (Sebastian, 15 Oct 01:24): "an option to contact me through a message,
// for support, for managers and owners, at the end of Settings".
//
// One conversation per restaurant, between its managers and owners and Seb's
// Analytics (migration 24, support_messages). Reached through
// api/reservations.js like everything else in Settings, so the site still
// deploys as twelve functions (files starting with _ are not functions).
//
//   support_unread   the red dot on the settings button: how many messages
//                    from the other side nobody here has read yet
//   support_thread   the conversation (and it is read now)
//   support_send     write in it
//
// The rules:
//   · managers and owners write and read; crew do not see it;
//   · the platform admin (Sebastian) answers as Seb's Analytics, at any
//     restaurant, and sees which restaurants are waiting for an answer;
//   · the other side gets an email when a message arrives — once, until they
//     have read it (five messages in a row are one email). Sebastian's address
//     is the email on his own account (My information); the managers' are on
//     theirs. No email on an account: the red dot still says it;
//   · the emails go out from the restaurant's own sending address (Settings →
//     emails, migration 16), like every other email of the site, and count
//     towards the same daily ceiling.

import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, loadAccess, accessProblem, levelAt, LEVEL } from './roles.js';
import { cleanBody, staffName, whenLabel } from './messages.js';
import { sendEmail, senderFor, escapeHtml, sendableAddress, hostOf } from './email.js';

export const SHOWN = 100;        // the last 100 messages of a conversation are shown
const MAX_TO = 10;               // emails for one message, at most

const readLimiter    = makeLimiter({ requests: 600, window: '10 m', prefix: 'support:read' });
const sendLimiter    = makeLimiter({ requests: 10,  window: '10 m', prefix: 'support:send' });
const sendDayLimiter = makeLimiter({ requests: 60,  window: '24 h', prefix: 'support:send:day' });
const emailLimiter   = makeLimiter({ requests: 30,  window: '24 h', prefix: 'support:email' });
// The same ceiling as every other email of the site (api/reservations.js):
// Resend's free plan sends 100 a day, so nothing here can run past it.
const emailDayLimiter = makeLimiter({ requests: 95, window: '24 h', prefix: 'resv:email:all' });

const NOT_READY = 'Support messages are not set up yet: migration 24 has not been run.';
const ONLY_MANAGERS = 'Support messages are for the managers and owners of this restaurant.';

export async function support(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action === 'support_send';
  if (writes) {
    if (!(await allow(sendLimiter, keyFor(tasterId), { failOpen: true }))) {
      return res.status(429).json({ error: 'Too many messages in a few minutes. Wait a moment and try again.' });
    }
  } else if (!(await allow(readLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  if (action === 'support_unread') return unread(res, access);
  if (action === 'support_thread') return thread(res, access, body);
  if (action === 'support_send')   return send(res, access, body);
  return res.status(400).json({ error: 'Unknown action.' });
}

// ── WHO MAY ───────────────────────────────────────────────────────────────────
function gate(res, access, restaurantId) {
  const rid = Number(restaurantId);
  if (!Number.isInteger(rid) || rid < 1) { res.status(400).json({ error: 'Which restaurant?' }); return null; }
  const level = levelAt(access, rid);
  if (level < LEVEL.manager) {
    res.status(403).json({ error: level >= LEVEL.crew ? ONLY_MANAGERS : 'This account has no access to this restaurant.' });
    return null;
  }
  return { rid, platform: !!access.isPlatformAdmin };
}

// The restaurants whose conversation this account reads as "the restaurant":
// where it is a manager or an owner. A platform admin reads every one, as
// Seb's Analytics.
function myRestaurants(access) {
  return Object.entries(access.byRestaurant || {})
    .filter(([, r]) => r.level >= LEVEL.manager).map(([id]) => Number(id)).filter((n) => Number.isInteger(n) && n > 0);
}

// How many messages from the other side are not read yet, per restaurant.
// null when the table is not there (migration 24 not run).
async function waitingCounts(access) {
  let q;
  if (access.isPlatformAdmin) q = '/support_messages?from_platform=eq.false&read_at=is.null&select=restaurant_id&limit=2000';
  else {
    const ids = myRestaurants(access);
    if (!ids.length) return [];
    q = `/support_messages?from_platform=eq.true&read_at=is.null&restaurant_id=in.(${ids.join(',')})&select=restaurant_id&limit=2000`;
  }
  const got = await sb(q);
  if (!got.ok || !Array.isArray(got.data)) return got.status === 404 ? null : [];
  const by = {};
  got.data.forEach((m) => { by[m.restaurant_id] = (by[m.restaurant_id] || 0) + 1; });
  const ids = Object.keys(by);
  if (!ids.length) return [];
  const names = await sb(`/restaurants?id=in.(${ids.join(',')})&select=id,name`);
  const nameOf = {};
  (names.ok && Array.isArray(names.data) ? names.data : []).forEach((r) => { nameOf[r.id] = r.name; });
  return ids.map((id) => ({ id: Number(id), name: nameOf[id] || 'Restaurant ' + id, unread: by[id] }))
    .sort((a, b) => b.unread - a.unread || a.id - b.id);
}

// ── THE RED DOT ───────────────────────────────────────────────────────────────
async function unread(res, access) {
  const list = await waitingCounts(access);
  if (list === null) return res.status(200).json({ success: true, ready: false, total: 0, restaurants: [] });
  return res.status(200).json({
    success: true, ready: true, platform: !!access.isPlatformAdmin,
    total: list.reduce((t, r) => t + r.unread, 0), restaurants: list,
  });
}

// ── THE CONVERSATION ──────────────────────────────────────────────────────────
async function placeOf(rid) {
  const [place, settings] = await Promise.all([
    sb(`/restaurants?id=eq.${rid}&select=id,name`),
    sb(`/restaurant_booking_settings?restaurant_id=eq.${rid}&select=timezone,site_url,email_from_address,email_from_name,email_reply_to`),
  ]);
  const r = place.ok && Array.isArray(place.data) ? place.data[0] : null;
  if (!r) return null;
  const s = settings.ok && Array.isArray(settings.data) && settings.data[0] ? settings.data[0] : {};
  return { id: r.id, name: r.name, settings: s, timezone: s.timezone || 'America/New_York' };
}

async function messagesOf(rid) {
  const got = await sb(`/support_messages?restaurant_id=eq.${rid}&select=id,from_platform,author_name,body,created_at,read_at`
                     + `&order=created_at.desc,id.desc&limit=${SHOWN}`);
  if (!got.ok || !Array.isArray(got.data)) return { missing: got.status === 404, status: got.status };
  return { list: got.data.reverse() };
}

// The messages as this side sees them: its own on the right ("mine"), with
// "Seen" once the other side has read them; the other side's on the left.
function dress(list, platform, place, now = Date.now()) {
  return list.map((m) => ({
    id: m.id,
    mine: m.from_platform === platform,
    fromPlatform: !!m.from_platform,
    who: m.from_platform ? m.author_name + ' · Seb’s Analytics' : m.author_name + ' · ' + place.name,
    when: whenLabel(place.timezone, m.created_at, now),
    at: m.created_at,
    body: m.body,
    seen: m.from_platform === platform ? !!m.read_at : undefined,
  }));
}

async function threadAnswer(res, access, who, place, status = 200, extra = {}) {
  const got = await messagesOf(who.rid);
  if (got.missing) return res.status(409).json({ error: NOT_READY });
  if (!got.list) return res.status(502).json({ error: 'Could not read the messages (the database answered ' + got.status + '). Please try again.' });
  // Reading is what makes them read: every message from the other side not
  // read yet — also older ones than the 100 shown, or the dot would never go.
  if (got.list.some((m) => m.from_platform !== who.platform && !m.read_at)
      || (await sb(`/support_messages?restaurant_id=eq.${who.rid}&from_platform=eq.${!who.platform}&read_at=is.null&select=id&limit=1`)).data?.length) {
    const at = new Date().toISOString();
    const marked = await sb(`/support_messages?restaurant_id=eq.${who.rid}&from_platform=eq.${!who.platform}&read_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ read_at: at }),
    });
    if (marked.ok) got.list.forEach((m) => { if (m.from_platform !== who.platform && !m.read_at) m.read_at = at; });
  }
  const waiting = who.platform ? ((await waitingCounts(access)) || []).filter((r) => r.id !== who.rid) : undefined;
  return res.status(status).json({
    success: true, ready: true, side: who.platform ? 'platform' : 'restaurant',
    restaurant: { id: place.id, name: place.name },
    messages: dress(got.list, who.platform, place),
    ...(waiting ? { waiting } : {}),
    ...extra,
  });
}

async function thread(res, access, body) {
  const who = gate(res, access, body.restaurantId);
  if (!who) return;
  const place = await placeOf(who.rid);
  if (!place) return res.status(404).json({ error: 'Restaurant not found.' });
  return threadAnswer(res, access, who, place);
}

async function send(res, access, body) {
  const who = gate(res, access, body.restaurantId);
  if (!who) return;
  const text = cleanBody(body.body);
  if (!text) return res.status(400).json({ error: 'Write your message first.' });
  if (text === 'long') return res.status(400).json({ error: 'A message is 1,000 characters at most.' });
  if (!(await allow(sendDayLimiter, keyFor('support:' + who.rid), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many messages today. Please try again tomorrow, or call Seb’s Analytics.' });
  }
  const place = await placeOf(who.rid);
  if (!place) return res.status(404).json({ error: 'Restaurant not found.' });

  // Is the other side already waiting on an unread message from this side?
  // Then they were emailed about it, and this one adds no second email.
  const before = await sb(`/support_messages?restaurant_id=eq.${who.rid}&from_platform=eq.${who.platform}&read_at=is.null&select=id&limit=1`);
  if (!before.ok && before.status === 404) return res.status(409).json({ error: NOT_READY });
  const alreadyWaiting = before.ok && Array.isArray(before.data) && before.data.length > 0;

  const saved = await sb('/support_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      restaurant_id: who.rid, taster_id: access.tasterId, from_platform: who.platform,
      author_name: staffName(access.firstName), body: text,
    }),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
    if (saved.status === 404) return res.status(409).json({ error: NOT_READY });
    // r35: with the database's answer in it (401/403: the server's permission on support_messages)
    console.error('[support] send failed', who.rid, saved.status);
    return res.status(502).json({ error: 'Could not send that (the database answered ' + saved.status + ').'
      + (saved.status === 401 || saved.status === 403 ? ' The server is missing its permission: Seb\u2019s Analytics has to run the grants fix.' : ' Please try again.') });
  }
  const msg = saved.data[0];
  console.log('[support] taster', access.tasterId, who.platform ? '(Seb’s Analytics)' : '', 'wrote to', who.rid, 'message', msg.id);

  let emailed = 0;
  if (!alreadyWaiting) emailed = await emailOtherSide(access, who, place, msg).catch((e) => { console.error('[support:email]', e && e.message); return 0; });
  return threadAnswer(res, access, who, place, 201, { sent: msg.id, emailed });
}

// ── THE EMAIL TO THE OTHER SIDE ───────────────────────────────────────────────
async function recipients(access, who) {
  let ids;
  if (who.platform) {
    const roles = await sb(`/restaurant_roles?restaurant_id=eq.${who.rid}&role=in.(manager,owner)&select=taster_id&limit=50`);
    ids = (roles.ok && Array.isArray(roles.data) ? roles.data : []).map((r) => Number(r.taster_id)).filter(Boolean);
    if (!ids.length) return [];
    const got = await sb(`/tasters?id=in.(${[...new Set(ids)].join(',')})&email=not.is.null&select=id,first_name,email&order=id.asc&limit=${MAX_TO}`);
    return (got.ok && Array.isArray(got.data) ? got.data : []).filter((t) => t.id !== access.tasterId);
  }
  const got = await sb(`/tasters?is_platform_admin=eq.true&email=not.is.null&select=id,first_name,email&order=id.asc&limit=${MAX_TO}`);
  return (got.ok && Array.isArray(got.data) ? got.data : []).filter((t) => t.id !== access.tasterId);
}

export function supportUrl(settings, rid) {
  const site = (settings && settings.site_url) || 'https://thehungryfork.fun';
  return `${site}/manager#support=${Number(rid)}`;
}

export function supportEmail({ place, msg, toPlatform, firstName, link }) {
  const e = escapeHtml;
  const author = msg.author_name;
  const subject = toPlatform
    ? `Support: ${author} at ${place.name} wrote to Seb’s Analytics`
    : `Seb’s Analytics wrote to ${place.name}`;
  const lead = toPlatform
    ? `${e(author)} at ${e(place.name)} wrote to Seb’s Analytics support:`
    : `${firstName ? e(firstName) + ', ' : ''}${e(author)} from Seb’s Analytics wrote to ${e(place.name)}:`;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#FCF9F4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FCF9F4;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #E9E0D3;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#1E1714;padding:18px 24px;text-align:center;font:600 22px/1.2 Georgia,'Times New Roman',serif;color:#FCF9F4;">${e(place.name)}</td></tr>
  <tr><td style="padding:24px 24px 6px;">
    <p style="margin:0 0 6px;font:bold 11px/1.4 Arial,Helvetica,sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#C8261B;">Support</p>
    <p style="margin:0 0 14px;font:15px/1.5 Arial,Helvetica,sans-serif;color:#2B211A;">${lead}</p>
    <div style="margin:0 0 18px;padding:14px 16px;background:#F5EEE3;border-radius:10px;font:15px/1.55 Arial,Helvetica,sans-serif;color:#2B211A;white-space:pre-wrap;">${e(msg.body)}</div>
    <a href="${e(link)}" style="display:inline-block;padding:13px 22px;background:#C8261B;border:1px solid #C8261B;border-radius:999px;font:bold 13px/1 Arial,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#ffffff;text-decoration:none;">Read and answer</a>
  </td></tr>
  <tr><td style="padding:16px 24px 24px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#6F6255;">Answer in the manager page: Settings &rarr; Support. Replies to this email are not read. We email once until the message is read.</td></tr>
</table>
<p style="max-width:520px;margin:14px auto 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6F6255;text-align:center;">Sent by ${e(hostOf(place.settings))} for Seb’s Analytics support.</p>
</td></tr></table></body></html>`;
  const text = [
    toPlatform ? `${author} at ${place.name} wrote to Seb's Analytics support:` : `${author} from Seb's Analytics wrote to ${place.name}:`,
    '', msg.body, '',
    `Read and answer: ${link}`, '',
    'Answer in the manager page: Settings > Support. Replies to this email are not read. We email once until the message is read.',
  ].join('\n');
  return { subject, html, text };
}

async function emailOtherSide(access, who, place, msg) {
  const s = place.settings || {};
  if (!process.env.RESEND_API_KEY || !s.email_from_address) {
    console.log('[support:email] none: the restaurant has no sending address yet', who.rid);
    return 0;
  }
  const people = (await recipients(access, who)).filter((t) => sendableAddress(t.email));
  if (!people.length) return 0;
  const { from } = senderFor(s, place);
  let sent = 0;
  for (const t of people) {
    if (!(await allow(emailLimiter, keyFor('support:' + who.rid), { failOpen: false }))
        || !(await allow(emailDayLimiter, keyFor('all'), { failOpen: false }))) {
      console.log('[support:email] the daily ceiling is reached; no more emails today');
      break;
    }
    const mail = supportEmail({ place, msg, toPlatform: !who.platform, firstName: t.first_name, link: supportUrl(s, who.rid) });
    const out = await sendEmail({
      from, to: sendableAddress(t.email), subject: mail.subject, html: mail.html, text: mail.text,
      idempotencyKey: `support-${msg.id}-${t.id}`, tags: [{ name: 'kind', value: 'support' }],
    });
    if (out.ok) sent += 1;
    else console.error('[support:email] to taster', t.id, 'failed:', out.error);
  }
  return sent;
}
