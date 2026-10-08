// api/_lib/messages.js
//
// Messages about a table (migration 19): the guest writes to the restaurant
// instead of calling, and the restaurant answers. Reached through
// api/reservations.js like everything else about a table, so the site still
// deploys as twelve functions (files starting with _ are not functions).
//
//   guest   msg_list · msg_send     from My Reservations (logged in), or from
//                                   the link in their email (no account)
//           inbox                   the bell in the header, on every page
//   staff   staff_msgs              the messages window: one day, Open / Closed
//           staff_msg_thread        one conversation
//           staff_msg_send · staff_msg_close · staff_msg_reopen
//
// Sebastian's rules (7–8 Oct):
//   · no ready-made answers; people write;
//   · owners, managers and Sebastian answer; crew only when a manager switches
//     "Answers guest messages" on for them in Team;
//   · the guest sees "Ana · The Hungry Fork": a first name, never a job;
//   · a conversation closes by itself when the guest arrives (Arrived, or the
//     QR scanned: api/_lib/staff.js), and the staff can close it;
//   · the staff can open it again at any time while it is kept. The guest
//     (8 Oct, 05:54): as often as they like for 24 hours from the first time it
//     closed — usually the QR scanned at the door — or from the table's time if
//     it closed before the table; then ONCE more, at any time while it is kept.
//     If the restaurant closes it after that, only the restaurant reopens it;
//   · kept 90 days after the table, then deleted (the daily job);
//   · a guest without an account gets ONE email, at the restaurant's first
//     answer, and never the words of the message (api/reservations.js).
//
// What staff never see here either: the guest's email address.

import { makeLimiter, allow, keyFor, clientIp } from './auth.js';
import { sb, tasterIdFromRequest, loadAccess, accessProblem, levelAt, LEVEL } from './roles.js';
import { loadBooking, clockIn, cleanDate } from './booking.js';
import { serviceDateOf, serviceToday, addDays, canMessageAt } from './staff.js';

export const KEEP_DAYS = 90;
export const KEEP_MS = KEEP_DAYS * 24 * 3600 * 1000;
export const GUEST_FREE_MS = 24 * 3600 * 1000;      // from the first close: reopen freely for 24 hours, then once
export const MAX_BODY = 1000;

// A guest writes a handful of messages about a table; a script writes hundreds.
// The writes refuse when Redis cannot be asked (every message lands on a
// restaurant's phone); the reads only slow a runaway page down.
// Counted by the account (or the email's link) when there is one, so guests
// sharing the restaurant's Wi-Fi do not share a limit; by address otherwise.
const guestSendTable = makeLimiter({ requests: 12,  window: '10 m', prefix: 'resv:msg:send:table' });
const guestSendIp    = makeLimiter({ requests: 60,  window: '1 h',  prefix: 'resv:msg:send:ip' });
const guestRead      = makeLimiter({ requests: 400, window: '10 m', prefix: 'resv:msg:read' });
const staffRead      = makeLimiter({ requests: 900, window: '10 m', prefix: 'resv:msg:staff:read' });
const staffWrite     = makeLimiter({ requests: 150, window: '10 m', prefix: 'resv:msg:staff:write' });

const GONE = 'This conversation is not kept any more: messages are deleted 90 days after the table.';
const NOT_THERE = 'That table is not there any more.';

// The columns a message read needs about the table. guest_email is not one of them.
const TABLE_COLUMNS = 'id,restaurant_id,code,guest_name,guest_phone,taster_id,party_size,reserved_at,local_date,local_time,status,seated_at';

// ── WORDS ─────────────────────────────────────────────────────────────────────
// What a person typed, as it will be stored: line breaks kept (at most one
// empty line in a row), other control characters gone, and no more than 1000
// letters. null when nothing is left; 'long' when it is too long to keep.
export function cleanBody(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\u200B\u2028-\u202E\u2066-\u2069\uFEFF]/g, '')
    .split('\n').map((l) => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return null;
  return Array.from(text).length > MAX_BODY ? 'long' : text;
}

// The name the guest sees on an answer: the first word of the first name,
// letters only ("Ana"), never anything else from the account.
export function staffName(firstName) {
  const first = String(firstName || '').trim().split(/\s+/)[0] || '';
  const clean = first.replace(/[^\p{L}'\u2019-]/gu, '').slice(0, 40);
  return /\p{L}/u.test(clean) ? clean : 'The team';
}

// "9:12 PM", "Yesterday 9:12 PM", "Oct 6, 9:12 PM" — the restaurant's clock.
export function whenLabel(timezone, iso, now = Date.now()) {
  const d = new Date(iso);
  const ymd = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d);
  const day = ymd(d);
  if (day === ymd(new Date(now))) return time;
  if (day === addDays(ymd(new Date(now)), -1)) return 'Yesterday ' + time;
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(d) + ', ' + time;
}

function tableDay(timezone, iso) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
}

// ── THE GUEST'S RIGHT TO WRITE ────────────────────────────────────────────────
export function isKept(row, now = Date.now()) {
  return new Date(row.reserved_at).getTime() + KEEP_MS > now;
}

// When the guest's 24 hours end: 24 hours after the first time the
// conversation closed, or after the table's time if that is later (a question
// answered and closed three days before the table does not use them up).
export function freeUntil(row, thread) {
  const tableAt = new Date(row.reserved_at).getTime();
  const first = thread && (thread.first_closed_at || thread.closed_at);
  return Math.max(tableAt, first ? new Date(first).getTime() : tableAt) + GUEST_FREE_MS;
}

// What the guest may do, and the sentence that says it.
//   open / none     → write
//   closed, within the 24 hours → write (it opens again), as often as needed
//   closed, later, the one late reopen not used yet → write (it opens again, once)
//   closed, later, used → no: the restaurant closed it
export function guestRight(row, thread, now = Date.now()) {
  if (!isKept(row, now)) return { canWrite: false, why: 'gone' };
  if (!thread || !thread.closed_at) return { canWrite: true, why: null };
  if (now <= freeUntil(row, thread)) return { canWrite: true, why: 'reopen' };
  if (!thread.guest_late_reopen_at) return { canWrite: true, why: 'reopen_once', late: true };
  return { canWrite: false, why: 'closed' };
}

// ── READS AND WRITES ──────────────────────────────────────────────────────────
async function threadOf(reservationId) {
  const got = await sb(`/reservation_threads?reservation_id=eq.${Number(reservationId)}&select=*&limit=1`);
  if (!got.ok) return { error: got.status };
  return { thread: Array.isArray(got.data) && got.data.length ? got.data[0] : null };
}

async function messagesOf(reservationId) {
  const got = await sb(`/reservation_messages?reservation_id=eq.${Number(reservationId)}` +
                       '&select=id,from_guest,author_id,author_name,body,created_at,read_at&order=id.asc&limit=500');
  return got.ok && Array.isArray(got.data) ? got.data : null;
}

// The other side's messages, now read: only the ones just shown (a message
// that lands while this runs stays new). Only written when there is something
// unread, so a page asking every few seconds does not write every few seconds.
async function markRead(reservationId, list, readerIsGuest) {
  if (!list.some((m) => !m.read_at && m.from_guest !== readerIsGuest)) return;
  const last = Math.max(...list.map((m) => Number(m.id)));
  const stamp = new Date().toISOString();
  await sb(`/reservation_messages?reservation_id=eq.${Number(reservationId)}&id=lte.${last}&from_guest=is.${readerIsGuest ? 'false' : 'true'}&read_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ read_at: stamp }),
  });
}

// The conversation of a table, made the first time somebody writes.
async function ensureThread(row) {
  const made = await sb('/reservation_threads?on_conflict=reservation_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({
      reservation_id: Number(row.id), restaurant_id: Number(row.restaurant_id),
      service_date: serviceDateOf(row), table_at: new Date(row.reserved_at).toISOString(),
    }),
  });
  if (made.ok && Array.isArray(made.data) && made.data.length) return { thread: made.data[0] };
  if (!made.ok) return { error: made.status };
  return threadOf(row.id);                     // it was made a moment ago by the other side
}

async function addMessage(row, fields) {
  const stamp = new Date().toISOString();
  const put = await sb('/reservation_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ reservation_id: Number(row.id), restaurant_id: Number(row.restaurant_id), ...fields }),
  });
  if (!put.ok || !Array.isArray(put.data) || !put.data.length) return null;
  await sb(`/reservation_threads?reservation_id=eq.${Number(row.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_at: stamp, last_from_guest: !!fields.from_guest }),
  });
  return put.data[0];
}

// Open a closed conversation. extra: the guest's one late reopen. The filter
// is the guard: two taps at once open it once, and the late reopen is spent once.
async function reopen(reservationId, by, extra = {}) {
  const stamp = new Date().toISOString();
  const guard = extra.guest_late_reopen_at ? '&guest_late_reopen_at=is.null' : '';
  const done = await sb(`/reservation_threads?reservation_id=eq.${Number(reservationId)}&closed_at=not.is.null${guard}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ closed_at: null, closed_reason: null, closed_by: null, reopened_at: stamp, reopened_by: by, ...extra }),
  });
  return done.ok && Array.isArray(done.data) && done.data.length > 0;
}

// ── THE GUEST ─────────────────────────────────────────────────────────────────
// Which table, and may this person write about it? A logged-in guest by the
// table's number (theirs by account or by the account's phone, as in My
// Reservations); a guest without an account by the link in their email.
async function guestTable(req, body, helpers) {
  const tasterId = tasterIdFromRequest(req);
  let id = null;
  if (body.token) {
    const linked = typeof helpers.findByLink === 'function' ? await helpers.findByLink(body.token) : null;
    if (!linked) return { status: 404, error: helpers.linkGone || 'This link does not open a table any more.' };
    id = Number(linked.id);
  } else {
    if (!tasterId) return { status: 401, error: 'Please log in again.' };
    id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return { status: 400, error: 'Which table?' };
  }
  const found = await sb(`/reservations?id=eq.${id}&select=${TABLE_COLUMNS}&limit=1`);
  if (!found.ok) return { status: 502, error: 'Could not read the table. Please try again in a moment.' };
  const row = Array.isArray(found.data) && found.data.length ? found.data[0] : null;
  if (!row) return { status: 404, error: NOT_THERE };
  if (!body.token) {
    // Somebody else's table answers exactly like one that does not exist.
    let theirs = Number(row.taster_id) === tasterId;
    if (!theirs) {
      const who = await sb(`/tasters?id=eq.${tasterId}&select=phone_number`);
      const phone = who.ok && Array.isArray(who.data) && who.data.length ? who.data[0].phone_number : null;
      theirs = !!phone && phone === row.guest_phone;
    }
    if (!theirs) return { status: 404, error: NOT_THERE };
  }
  return { row, tasterId };
}

function guestView(row, thread, list, place, timezone, now = Date.now()) {
  const restaurant = (place && place.name) || 'The restaurant';
  const right = guestRight(row, thread, now);
  let note = null;
  if (thread && thread.closed_at) {
    const how = thread.closed_reason === 'staff' ? 'Closed by the restaurant.' : 'Closed when you arrived.';
    note = right.canWrite
      ? how + (right.why === 'reopen_once' ? ' You can open it again once: write below.' : ' Write below to open it again.')
      : (thread.closed_reason === 'staff' ? 'The restaurant closed this conversation.' : 'This conversation is closed.')
        + (place && place.phone ? ' To talk to them, call ' + place.phone + '.' : ' To talk to them, please call.');
  }
  return {
    success: true,
    restaurant, phone: (place && place.phone) || null,
    table: { day: tableDay(timezone, row.reserved_at), ...clockIn(timezone, row.reserved_at) },
    state: !thread ? 'new' : thread.closed_at ? 'closed' : 'open',
    note,
    canWrite: right.canWrite,
    keptUntil: new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'long', day: 'numeric' })
      .format(new Date(new Date(row.reserved_at).getTime() + KEEP_MS)),
    messages: list.map((m) => ({
      id: m.id,
      mine: !!m.from_guest,
      who: m.from_guest ? 'You' : `${m.author_name || 'The team'} · ${restaurant}`,
      body: m.body,
      at: new Date(m.created_at).toISOString(),
      label: whenLabel(timezone, m.created_at, now),
    })),
  };
}

async function guestReply(res, row, timezone, place) {
  const t = await threadOf(row.id);
  if (t.error) return res.status(t.error === 404 ? 503 : 502).json({ error: 'Messages are not switched on yet. Please call the restaurant.' });
  const list = t.thread ? await messagesOf(row.id) : [];
  if (list === null) return res.status(502).json({ error: 'Could not read the messages. Please try again in a moment.' });
  if (t.thread) await markRead(row.id, list, true);
  return res.status(200).json(guestView(row, t.thread, list, place, timezone));
}

function whoKey(req, body) {
  const tasterId = tasterIdFromRequest(req);
  if (tasterId) return 'a' + tasterId;
  if (typeof body.token === 'string' && /^[A-Za-z0-9_-]{32}$/.test(body.token)) return 'k' + body.token;
  return 'ip' + clientIp(req);
}

export async function guest(req, res, body, action, helpers = {}) {
  if (action === 'inbox') return inbox(req, res, body);

  if (!(await allow(guestRead, keyFor(whoKey(req, body)), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  const found = await guestTable(req, body, helpers);
  if (!found.row) return res.status(found.status).json({ error: found.error });
  const { row, tasterId } = found;
  if (!isKept(row)) return res.status(410).json({ error: GONE });
  const loaded = await loadBooking(row.restaurant_id);
  const place = loaded && !loaded.error ? loaded.restaurant : null;
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';

  if (action === 'msg_list') return guestReply(res, row, timezone, place);

  if (action === 'msg_send') {
    const text = cleanBody(body.body);
    if (!text) return res.status(400).json({ error: 'Write your message first.' });
    if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
    if (!(await allow(guestSendTable, keyFor('t' + row.id), { failOpen: false }))
        || !(await allow(guestSendIp, keyFor(whoKey(req, body)), { failOpen: false }))) {
      return res.status(429).json({ error: 'Too many messages in a few minutes. Wait a little, or call the restaurant.' });
    }
    const made = await ensureThread(row);
    if (made.error) return res.status(made.error === 404 ? 503 : 502).json({ error: 'Messages are not switched on yet. Please call the restaurant.' });
    let thread = made.thread;
    if (thread.closed_at) {
      const right = guestRight(row, thread);
      if (!right.canWrite) {
        return res.status(409).json({
          error: 'The restaurant closed this conversation.' + (place && place.phone ? ' To talk to them, call ' + place.phone + '.' : ' Please call the restaurant.'),
          reason: 'closed',
        });
      }
      const stamp = new Date().toISOString();
      const opened = await reopen(row.id, 'guest', right.late ? { guest_late_reopen_at: stamp } : {});
      if (!opened) {
        // Somebody else changed it this second: go by what it is now.
        const again = await threadOf(row.id);
        if (again.error || !again.thread || again.thread.closed_at) {
          return res.status(409).json({ error: 'The restaurant closed this conversation. Please call the restaurant.', reason: 'closed' });
        }
      }
    }
    const saved = await addMessage(row, { from_guest: true, author_id: tasterId || null, body: text });
    if (!saved) return res.status(502).json({ error: 'Your message was not sent. Please try again.' });
    console.log('[messages] guest wrote about', row.code);
    return guestReply(res, row, timezone, place);
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

// For My Reservations and the email's link: one line per table about its
// conversation. Never fails the list it is part of (before migration 19 the
// tables simply have no conversations).
export async function chatSummaries(rows, now = Date.now()) {
  const out = {};
  const ids = rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return out;
  const [threads, unread] = await Promise.all([
    sb(`/reservation_threads?reservation_id=in.(${ids.join(',')})&select=reservation_id,closed_at,closed_reason,first_closed_at,guest_late_reopen_at`),
    sb(`/reservation_messages?reservation_id=in.(${ids.join(',')})&from_guest=is.false&read_at=is.null&select=reservation_id&limit=1000`),
  ]);
  const byId = {};
  (threads.ok && Array.isArray(threads.data) ? threads.data : []).forEach((t) => { byId[t.reservation_id] = t; });
  const count = {};
  (unread.ok && Array.isArray(unread.data) ? unread.data : []).forEach((m) => { count[m.reservation_id] = (count[m.reservation_id] || 0) + 1; });
  const on = threads.ok;                        // migration 19 is there
  rows.forEach((r) => {
    const t = byId[r.id] || null;
    out[r.id] = on && isKept(r, now) ? {
      exists: !!t, open: !!t && !t.closed_at, unread: count[r.id] || 0, canWrite: guestRight(r, t, now).canWrite,
    } : null;
  });
  return out;
}

// ── THE BELL ──────────────────────────────────────────────────────────────────
// What is new for this account: the restaurants' answers it has not read, and,
// for staff (asked with staff:true), how many guest messages wait for them.
async function inbox(req, res, body) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (!(await allow(guestRead, keyFor('i' + tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  const who = await sb(`/tasters?id=eq.${tasterId}&select=id,phone_number`);
  if (!who.ok || !Array.isArray(who.data) || !who.data.length) return res.status(401).json({ error: 'Please log in again.' });
  const phone = who.data[0].phone_number || null;
  const since = new Date(Date.now() - KEEP_MS).toISOString();
  const match = phone ? `or=(taster_id.eq.${tasterId},guest_phone.eq.${encodeURIComponent(phone)})` : `taster_id=eq.${tasterId}`;

  const bell = [];
  const mine = await sb(`/reservations?${match}&reserved_at=gte.${since}&select=id,restaurant_id,reserved_at&order=reserved_at.desc&limit=100`);
  const tables = mine.ok && Array.isArray(mine.data) ? mine.data : [];
  if (tables.length) {
    const unread = await sb(`/reservation_messages?reservation_id=in.(${tables.map((r) => Number(r.id)).join(',')})` +
                            '&from_guest=is.false&read_at=is.null&select=reservation_id,author_name,created_at&order=id.desc&limit=200');
    const list = unread.ok && Array.isArray(unread.data) ? unread.data : [];
    if (list.length) {
      const byTable = {};
      list.forEach((m) => {
        const b = byTable[m.reservation_id] || (byTable[m.reservation_id] = { count: 0, who: m.author_name, at: m.created_at });
        b.count += 1;
      });
      const tableOf = {};
      tables.forEach((r) => { tableOf[r.id] = r; });
      const rids = [...new Set(Object.keys(byTable).map((id) => tableOf[id].restaurant_id))];
      const places = {};
      await Promise.all(rids.map(async (rid) => { places[rid] = await loadBooking(rid); }));
      Object.entries(byTable).forEach(([id, b]) => {
        const r = tableOf[id];
        const l = places[r.restaurant_id];
        const tz = (l && l.settings && l.settings.timezone) || 'America/New_York';
        bell.push({
          reservationId: Number(id), count: b.count,
          who: b.who || 'The team', restaurant: (l && l.restaurant && l.restaurant.name) || 'The restaurant',
          at: new Date(b.at).toISOString(), label: whenLabel(tz, b.at),
          table: tableDay(tz, r.reserved_at) + ' · ' + clockIn(tz, r.reserved_at).label,
        });
      });
      bell.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    }
  }

  let staff = null;
  if (body.staff) {
    const access = await loadAccess(tasterId);
    if (access && !accessProblem(access)) {
      // The restaurants this account answers at. Sebastian's count is the
      // restaurants he holds a role at, not every client's (he would always see one).
      const rids = [];
      for (const [rid, e] of Object.entries(access.byRestaurant || {})) {
        if (await canMessageAt(tasterId, rid, e.level)) rids.push(Number(rid));
      }
      if (rids.length) {
        const unread = await sb(`/reservation_messages?from_guest=is.true&read_at=is.null&restaurant_id=in.(${rids.join(',')})` +
          '&select=reservation_id,restaurant_id&limit=1000');
        if (unread.ok && Array.isArray(unread.data)) {
          const byRestaurant = {};
          unread.data.forEach((m) => { byRestaurant[m.restaurant_id] = (byRestaurant[m.restaurant_id] || 0) + 1; });
          staff = { unread: unread.data.length, conversations: new Set(unread.data.map((m) => m.reservation_id)).size, byRestaurant };
        }
      }
    }
  }
  return res.status(200).json({ success: true, bell, staff });
}

// ── THE RESTAURANT ────────────────────────────────────────────────────────────
// Who may read and answer at this restaurant. Answers the request itself and
// returns null when they may not.
async function msgAccess(res, tasterId, restaurantId, { hide } = {}) {
  const rid = Number(restaurantId);
  if (!Number.isInteger(rid) || rid < 1) { res.status(400).json({ error: 'Which restaurant?' }); return null; }
  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) { res.status(problem.status).json({ error: problem.error }); return null; }
  const level = levelAt(access, rid);
  if (level < LEVEL.crew) {
    // A table at another restaurant reads exactly like a table that does not exist.
    if (hide) res.status(404).json({ error: NOT_THERE });
    else res.status(403).json({ error: 'This account has no access to this restaurant.' });
    return null;
  }
  if (!(await canMessageAt(access.tasterId || tasterId, rid, level))) {
    res.status(403).json({ error: 'Guest messages are answered by the managers here. A manager can switch them on for you in Team.' });
    return null;
  }
  // Sebastian (platform admin) can open any restaurant's messages, but reading
  // them as a visitor must not take the "new" away from that restaurant's staff.
  const own = !!(access.byRestaurant && (access.byRestaurant[rid] || access.byRestaurant[String(rid)]));
  return { rid, level, access, name: staffName(access.firstName), marksRead: level < LEVEL.platform || own };
}

export async function staffMessages(req, res, body, action, helpers = {}) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action !== 'staff_msgs' && action !== 'staff_msg_thread';
  if (!(await allow(writes ? staffWrite : staffRead, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  if (action === 'staff_msgs') return staffDay(req, res, body, tasterId);

  // One conversation: the restaurant is the table's own, never the request's.
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });
  const found = await sb(`/reservations?id=eq.${id}&select=${TABLE_COLUMNS}&limit=1`);
  if (!found.ok) return res.status(502).json({ error: 'Could not read the table (the database answered ' + found.status + ').' });
  const row = Array.isArray(found.data) && found.data.length ? found.data[0] : null;
  if (!row) return res.status(404).json({ error: NOT_THERE });
  const who = await msgAccess(res, tasterId, row.restaurant_id, { hide: true });
  if (!who) return;
  const loaded = await loadBooking(row.restaurant_id);
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const t = await threadOf(row.id);
  if (t.error) return res.status(502).json({ error: 'Could not read the conversation (the database answered ' + t.error + ').'
    + (t.error === 404 ? ' That usually means migration 19 has not been run yet.' : '') });
  if (!t.thread) return res.status(404).json({ error: 'This guest has not written about this table.' });
  if (!isKept(row)) return res.status(410).json({ error: GONE });

  if (action === 'staff_msg_thread') return staffReply(res, row, t.thread, who, timezone, { read: who.marksRead });

  if (action === 'staff_msg_close') {
    const stamp = new Date().toISOString();
    const done = await sb(`/reservation_threads?reservation_id=eq.${id}&closed_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ closed_at: stamp, closed_reason: 'staff', closed_by: tasterId }),
    });
    if (!done.ok) return res.status(502).json({ error: 'Could not close it. Please try again.' });
    console.log('[messages] taster', tasterId, 'closed the conversation of', row.code);
    return staffReply(res, row, null, who, timezone);
  }

  if (action === 'staff_msg_reopen') {
    if (t.thread.closed_at && !(await reopen(id, 'staff'))) {
      const again = await threadOf(id);
      if (again.error || !again.thread || again.thread.closed_at) return res.status(502).json({ error: 'Could not open it again. Please try again.' });
    }
    console.log('[messages] taster', tasterId, 'reopened the conversation of', row.code);
    return staffReply(res, row, null, who, timezone);
  }

  if (action === 'staff_msg_send') {
    const text = cleanBody(body.body);
    if (!text) return res.status(400).json({ error: 'Write the answer first.' });
    if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
    // Writing in a closed conversation opens it again.
    if (t.thread.closed_at) await reopen(id, 'staff');
    const saved = await addMessage(row, { from_guest: false, author_id: tasterId, author_name: who.name, body: text });
    if (!saved) return res.status(502).json({ error: 'The answer was not sent. Please try again.' });
    console.log('[messages] taster', tasterId, 'answered about', row.code);
    // A guest with no account gets one email, at the restaurant's first answer.
    // If that one could not be sent (Resend down, the day's limit), the next
    // answer tries again; first_reply_emailed_at keeps it to one email ever.
    let emailed = false;
    if (!t.thread.first_reply_emailed_at && typeof helpers.answerByEmail === 'function') {
      try {
        emailed = await helpers.answerByEmail({ reservationId: id, staffName: who.name, loaded, timezone });
      } catch (err) {
        console.error('[messages] answer email threw', id, err && err.message);
      }
    }
    return staffReply(res, row, null, who, timezone, { emailed });
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

// One conversation, as the staff see it. The guest's messages are marked read
// only when the conversation is opened (read: true), not when an answer goes.
async function staffReply(res, row, thread, who, timezone, opts = {}) {
  let th = thread;
  if (!th) {
    const t = await threadOf(row.id);
    th = t.thread;
    if (!th) return res.status(502).json({ error: 'Could not read the conversation. Please try again.' });
  }
  const list = await messagesOf(row.id);
  if (list === null) return res.status(502).json({ error: 'Could not read the messages. Please try again.' });
  if (opts.read) await markRead(row.id, list, false);
  const names = await closerNames([th]);
  const now = Date.now();
  return res.status(200).json({
    success: true,
    ...(opts.emailed ? { emailed: true } : {}),
    booking: {
      id: row.id, name: row.guest_name, phone: row.guest_phone, code: row.code, party: row.party_size,
      status: row.status, day: tableDay(timezone, row.reserved_at), ...clockIn(timezone, row.reserved_at),
      serviceDate: th.service_date,
    },
    open: !th.closed_at,
    closedNote: th.closed_at ? closedNote(th, row, names, timezone) : null,
    // Can the guest open it again if it is (or gets) closed now? Within their
    // 24 hours, yes; after that, only if their one late reopen is unused.
    guestCanReopen: isKept(row, now) && (now <= freeUntil(row, th.closed_at ? th : { ...th, closed_at: new Date(now).toISOString() })
                                         || !th.guest_late_reopen_at),
    keptUntil: new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'long', day: 'numeric' })
      .format(new Date(new Date(row.reserved_at).getTime() + KEEP_MS)),
    messages: list.map((m) => ({
      id: m.id,
      fromGuest: !!m.from_guest,
      who: m.from_guest ? firstWord(row.guest_name) : (Number(m.author_id) === Number(who.access.tasterId) ? 'You' : (m.author_name || 'The team')),
      body: m.body,
      at: new Date(m.created_at).toISOString(),
      label: whenLabel(timezone, m.created_at, now),
    })),
  });
}

function firstWord(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Guest';
}

async function closerNames(threads) {
  const ids = [...new Set(threads.filter((t) => t && t.closed_reason === 'staff' && t.closed_by).map((t) => Number(t.closed_by)))];
  if (!ids.length) return {};
  const got = await sb(`/tasters?id=in.(${ids.join(',')})&select=id,first_name`);
  const out = {};
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((t) => { out[t.id] = staffName(t.first_name); });
  return out;
}

// "Closed by itself: Johan arrived at 9:03 PM (QR)" · "Closed by Ana · 9:12 PM"
function closedNote(th, row, names, timezone) {
  const at = clockIn(timezone, th.closed_at).label;
  if (th.closed_reason === 'qr' || th.closed_reason === 'arrived') {
    return { kind: 'arrived', text: `Closed by itself: ${firstWord(row.guest_name)} arrived at ${at}${th.closed_reason === 'qr' ? ' (QR)' : ''}`,
             short: `Arrived ${at}${th.closed_reason === 'qr' ? ' (QR)' : ''}` };
  }
  const by = names[th.closed_by] || 'the team';
  return { kind: 'staff', text: `Closed by ${by} · ${at}`, short: `Closed by ${by} · ${at}` };
}

// ── THE MESSAGES WINDOW: ONE DAY ──────────────────────────────────────────────
// The conversations whose table is on that day (5 AM to 5 AM, like the list),
// open and closed, plus the days around it that have any, for the strip.
async function staffDay(req, res, body, tasterId) {
  const who = await msgAccess(res, tasterId, body.restaurantId);
  if (!who) return;
  const loaded = await loadBooking(who.rid);
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const today = serviceToday(timezone);
  const since = new Date(Date.now() - KEEP_MS).toISOString();

  const [threads, unread] = await Promise.all([
    sb(`/reservation_threads?restaurant_id=eq.${who.rid}&table_at=gte.${since}` +
       '&select=reservation_id,service_date,closed_at,closed_reason,closed_by,last_at,last_from_guest,guest_late_reopen_at&order=last_at.desc&limit=2000'),
    sb(`/reservation_messages?restaurant_id=eq.${who.rid}&from_guest=is.true&read_at=is.null&select=reservation_id&limit=2000`),
  ]);
  if (!threads.ok || !Array.isArray(threads.data)) {
    return res.status(502).json({ error: 'Could not read the messages (the database answered ' + threads.status + ').'
      + (threads.status === 404 ? ' That usually means migration 19 has not been run yet.' : '') });
  }
  const count = {};
  (unread.ok && Array.isArray(unread.data) ? unread.data : []).forEach((m) => { count[m.reservation_id] = (count[m.reservation_id] || 0) + 1; });

  const days = {};
  threads.data.forEach((t) => {
    const d = days[t.service_date] || (days[t.service_date] = { date: t.service_date, open: 0, closed: 0, unread: 0 });
    if (t.closed_at) d.closed += 1; else d.open += 1;
    d.unread += count[t.reservation_id] || 0;
  });

  // The day shown: the one asked for; otherwise today — unless today has
  // nothing new and another day does, then the day of the newest message.
  let date = cleanDate(body.date);
  if (!date) {
    date = today;
    if (!(days[today] && days[today].unread)) {
      const waiting = threads.data.find((t) => count[t.reservation_id]);
      if (waiting) date = waiting.service_date;
    }
  }

  const here = threads.data.filter((t) => t.service_date === date);
  let list = [];
  if (here.length) {
    const ids = here.map((t) => Number(t.reservation_id));
    const [tables, last, names] = await Promise.all([
      sb(`/reservations?id=in.(${ids.join(',')})&select=${TABLE_COLUMNS}`),
      sb(`/reservation_messages?reservation_id=in.(${ids.join(',')})&select=reservation_id,from_guest,author_name,body,created_at&order=id.desc&limit=${Math.min(2000, ids.length * 40)}`),
      closerNames(here),
    ]);
    const rowOf = {};
    (tables.ok && Array.isArray(tables.data) ? tables.data : []).forEach((r) => { rowOf[r.id] = r; });
    const lastOf = {};
    (last.ok && Array.isArray(last.data) ? last.data : []).forEach((m) => { if (!lastOf[m.reservation_id]) lastOf[m.reservation_id] = m; });
    const now = Date.now();
    list = here.filter((t) => rowOf[t.reservation_id]).map((t) => {
      const r = rowOf[t.reservation_id], m = lastOf[t.reservation_id];
      const preview = m ? String(m.body).replace(/\s+/g, ' ') : '';
      return {
        id: Number(t.reservation_id), name: r.guest_name, code: r.code, party: r.party_size, status: r.status,
        ...clockIn(timezone, r.reserved_at),
        minutes: minutesOf(r),
        open: !t.closed_at,
        closed: t.closed_at ? closedNote(t, r, names, timezone) : null,
        unread: count[t.reservation_id] || 0,
        lastAt: new Date(t.last_at).toISOString(),
        lastLabel: whenLabel(timezone, t.last_at, now),
        lastFromGuest: m ? !!m.from_guest : !!t.last_from_guest,
        lastWho: m ? (m.from_guest ? firstWord(r.guest_name) : (m.author_name || 'The team')) : null,
        preview: Array.from(preview).length > 90 ? Array.from(preview).slice(0, 88).join('') + '…' : preview,
      };
    }).sort((a, b) => (b.unread > 0) - (a.unread > 0) || a.minutes - b.minutes || a.id - b.id);
  }

  return res.status(200).json({
    success: true, today, date, timezone,
    openCount: threads.data.filter((t) => !t.closed_at).length,
    // Closed with something unread (the guest wrote, then arrived): the Closed
    // tab carries this number, so a count on the bubble can always be found.
    closedUnread: threads.data.filter((t) => t.closed_at && count[t.reservation_id]).length,
    unreadCount: Object.values(count).reduce((n, c) => n + c, 0),
    days: Object.values(days).sort((a, b) => a.date.localeCompare(b.date)),
    threads: list,
  });
}

// A 12:30 AM table on the night before's list counts as 24:30, as on the clock.
function minutesOf(r) {
  const [hh, mm] = String(r.local_time || '00:00').split(':').map(Number);
  return (serviceDateOf(r) !== r.local_date ? 1440 : 0) + hh * 60 + mm;
}
