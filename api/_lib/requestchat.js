// api/_lib/requestchat.js
//
// Messages about a big-party request (migration 20, r30). Sebastian, 13 Oct:
// the chat button belongs on the request card too, "like the other chats",
// beside Call and Write SMS. Reached through api/reservations.js, so the site
// still deploys as twelve functions (files starting with _ are not functions).
//
//   guest   req_msg_list · req_msg_send    from My Reservations (logged in): the
//                                          request is theirs by account or by the
//                                          account's phone number, as the tables are
//   staff   staff_req_thread · staff_req_send
//   r42     req_msg_upload · req_msg_files · staff_req_upload · staff_req_files
//                                          photos and PDFs (api/_lib/files.js)
//
// The rules, kept short on purpose:
//   · both sides write while the request is waiting for its answer;
//   · when the restaurant books the table, the conversation moves to the table
//     (moveToTable, called from staff.js), so nothing said is lost and the chat
//     sign on the table's card has it all;
//   · declined, or its day gone: nobody writes any more; it is deleted 90 days
//     after the day asked for (the daily job in api/reservations.js);
//   · a guest without an account gets ONE email, the first time the restaurant
//     writes, saying so — never the words (helpers.requestByEmail);
//   · r42: owners, managers and Sebastian see the guest's email address on the
//     request's conversation; crew never (read on its own, by id).

import { makeLimiter, allow, keyFor, clientIp } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { loadBooking, todayIn } from './booking.js';
import { cleanBody, staffName, whenLabel, msgAccess, MAX_BODY, KEEP_MS } from './messages.js';
import { handlesById, addHandles } from './guests.js';
import { makeSlot, claimFile, filesById, fileLinks, fileError, moveFiles } from './files.js';

const guestSend = makeLimiter({ requests: 12,  window: '10 m', prefix: 'resv:reqmsg:send' });
const guestRead = makeLimiter({ requests: 900, window: '10 m', prefix: 'resv:reqmsg:read' });
const staffRead = makeLimiter({ requests: 1800, window: '10 m', prefix: 'resv:reqmsg:staff:read' });
const staffWrite = makeLimiter({ requests: 150, window: '10 m', prefix: 'resv:reqmsg:staff:write' });
const guestUpload = makeLimiter({ requests: 20, window: '10 m', prefix: 'resv:reqmsg:file' });   // r42

// guest_email is not one of them.
const REQUEST_COLUMNS = 'id,restaurant_id,taster_id,guest_name,guest_phone,party_size,wanted_date,wanted_time,occasion,status,chat_emailed_at';
const NOT_THERE = 'That request is not there any more.';
const NOT_ON = 'Messages about requests are not switched on yet. Please call the restaurant.';

// "Sat, Oct 24" for a day written "2026-10-24" (no clock involved: it is a day).
export function dayLabel(date) {
  const p = String(date || '').split('-').map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isInteger(n))) return String(date || '');
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(Date.UTC(p[0], p[1] - 1, p[2])));
}
// "7:00 PM" for "19:00:00"; null when the guest gave no time.
export function timeLabel(time) {
  const m = /^(\d{2}):(\d{2})/.exec(String(time || ''));
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
function keptUntil(date) {
  const p = String(date || '').split('-').map(Number);
  const end = new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1) + KEEP_MS);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).format(end);
}

// While the request waits for its answer, and its day has not passed.
export function writable(q, timezone) {
  return q.status === 'new' && String(q.wanted_date) >= todayIn(timezone || 'America/New_York');
}

async function requestRow(id) {
  const got = await sb(`/reservation_requests?id=eq.${Number(id)}&select=${REQUEST_COLUMNS}&limit=1`);
  if (!got.ok && got.status === 400) {
    // Before migration 20 chat_emailed_at is not there: the request, without it.
    const again = await sb(`/reservation_requests?id=eq.${Number(id)}&select=${REQUEST_COLUMNS.replace(',chat_emailed_at', '')}&limit=1`);
    if (!again.ok) return { error: again.status };
    return { row: Array.isArray(again.data) && again.data.length ? again.data[0] : null };
  }
  if (!got.ok) return { error: got.status };
  return { row: Array.isArray(got.data) && got.data.length ? got.data[0] : null };
}

async function messagesOf(requestId) {
  const ask = (cols) => sb(`/request_messages?request_id=eq.${Number(requestId)}&select=${cols}&order=id.asc&limit=500`);
  let got = await ask('id,from_guest,author_id,author_name,body,created_at,read_at,file_id');
  if (!got.ok && got.status === 400) got = await ask('id,from_guest,author_id,author_name,body,created_at,read_at');   // before migration 29
  if (!got.ok) return { error: got.status };
  return { list: Array.isArray(got.data) ? got.data : [] };
}

// r42: when the messages (and files) of a request are deleted: 90 days after its day.
function keepUntilOf(q) {
  const p = String(q.wanted_date || '').split('-').map(Number);
  return new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1) + KEEP_MS + 24 * 3600 * 1000);
}
async function fileOfList(list) {
  const files = await filesById(list.map((m) => m.file_id).filter(Boolean));
  return (m) => (m.file_id && files[m.file_id]) || null;
}

async function markRead(requestId, list, readerIsGuest) {
  if (!list.some((m) => !m.read_at && m.from_guest !== readerIsGuest)) return;
  const last = Math.max(...list.map((m) => Number(m.id)));
  await sb(`/request_messages?request_id=eq.${Number(requestId)}&id=lte.${last}&from_guest=is.${readerIsGuest ? 'false' : 'true'}&read_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ read_at: new Date().toISOString() }),
  });
}

async function addMessage(q, fields) {
  const put = await sb('/request_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ request_id: Number(q.id), restaurant_id: Number(q.restaurant_id), ...fields }),
  });
  return put.ok && Array.isArray(put.data) && put.data.length ? put.data[0] : null;
}

// Is this request the account's own: by the account, or by its phone number
// (most big parties ask without logging in). Somebody else's request answers
// exactly like one that does not exist.
async function isTheirs(q, tasterId) {
  if (Number(q.taster_id) === Number(tasterId)) return true;
  const who = await sb(`/tasters?id=eq.${Number(tasterId)}&select=phone_number`);
  const phone = who.ok && Array.isArray(who.data) && who.data.length ? who.data[0].phone_number : null;
  return !!phone && phone === q.guest_phone;
}

// Does the guest have an account (by the request, or by its phone number)?
// Unknown counts as "has one": no email goes out on a guess.
export async function hasAccount(q) {
  if (q.taster_id) return true;
  const got = await sb(`/tasters?phone_number=eq.${encodeURIComponent(q.guest_phone || '')}&select=id&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) return true;
  return got.data.length > 0;
}

// ── THE GUEST ─────────────────────────────────────────────────────────────────
function guestView(q, list, place, timezone, handles, now = Date.now(), fileOf = () => null) {
  const restaurant = (place && place.name) || 'The restaurant';
  const canWrite = writable(q, timezone);
  let note = null;
  if (!canWrite) {
    note = q.status === 'accepted'
      ? 'The restaurant booked your table: the conversation goes on with the table, under Coming up.'
      : 'This request is closed.' + (place && place.phone ? ' To talk to the restaurant, call ' + place.phone + '.' : '');
  }
  return {
    success: true,
    restaurant, phone: (place && place.phone) || null,
    request: { id: q.id, day: dayLabel(q.wanted_date), time: timeLabel(q.wanted_time), party: q.party_size },
    state: list.length ? 'open' : 'new',
    note, canWrite,
    keptUntil: keptUntil(q.wanted_date),
    foot: `Messages about this request are kept until ${keptUntil(q.wanted_date)}, then deleted.`,
    empty: `Write to ${restaurant} about your request: the menu, the room, a cake. They answer you here.`,
    messages: list.map((m) => ({
      id: m.id,
      mine: !!m.from_guest,
      name: m.from_guest ? 'You' : (m.author_name || 'The team'),
      handle: m.from_guest ? null : (handles[m.author_id] || null),
      place: m.from_guest ? null : restaurant,
      who: m.from_guest ? 'You' : `${m.author_name || 'The team'}${handles[m.author_id] ? ` (${handles[m.author_id]})` : ''} · ${restaurant}`,
      body: m.body,
      file: fileOf(m),
      at: new Date(m.created_at).toISOString(),
      label: whenLabel(timezone, m.created_at, now),
    })),
  };
}

export async function guestRequestChat(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (!(await allow(guestRead, keyFor('a' + tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }
  const id = Number(body.requestId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which request?' });
  const found = await requestRow(id);
  if (found.error) return res.status(502).json({ error: 'Could not read the request. Please try again in a moment.' });
  const q = found.row;
  if (!q || !(await isTheirs(q, tasterId))) return res.status(404).json({ error: NOT_THERE });
  const loaded = await loadBooking(q.restaurant_id);
  const place = loaded && !loaded.error ? loaded.restaurant : null;
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';

  const reply = async () => {
    const got = await messagesOf(q.id);
    if (got.error) return res.status(got.error === 404 ? 503 : 502).json({ error: got.error === 404 ? NOT_ON : 'Could not read the messages. Please try again in a moment.' });
    await markRead(q.id, got.list, true);
    const [handles, fileOf] = await Promise.all([
      handlesById(got.list.filter((m) => !m.from_guest).map((m) => m.author_id)), fileOfList(got.list),
    ]);
    return res.status(200).json(guestView(q, got.list, place, timezone, handles, Date.now(), fileOf));
  };
  if (action === 'req_msg_list') return reply();
  const placeOf = { restaurantId: q.restaurant_id, requestId: q.id };

  // r42: links (one hour) for this request's files, and a place for a new one.
  if (action === 'req_msg_files') {
    const got = await fileLinks(placeOf, body.fileIds);
    if (got.error) return fileError(res, got.error);
    return res.status(200).json({ success: true, links: got.links, expiresIn: got.expiresIn || null });
  }
  if (action === 'req_msg_upload') {
    if (!writable(q, timezone)) {
      return res.status(409).json({ error: 'This request is closed.' + (place && place.phone ? ' To talk to the restaurant, call ' + place.phone + '.' : ''), reason: 'closed' });
    }
    if (!(await allow(guestUpload, keyFor('r' + q.id), { failOpen: false }))) {
      return res.status(429).json({ error: 'Too many files in a few minutes. Wait a little, or call the restaurant.' });
    }
    const slot = await makeSlot(placeOf, { fromGuest: true, uploaderId: tasterId, name: body.name, mime: body.mime, size: body.size });
    if (slot.error) return fileError(res, slot.error);
    return res.status(200).json({ success: true, file: slot.file, uploadUrl: slot.uploadUrl });
  }

  if (action === 'req_msg_send') {
    const hasFile = body.fileId !== undefined && body.fileId !== null && body.fileId !== '';
    let text = cleanBody(body.body);
    if (!text && !hasFile) return res.status(400).json({ error: 'Write your message first.' });
    if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
    if (!text) text = '';
    if (!writable(q, timezone)) {
      return res.status(409).json({ error: 'This request is closed.' + (place && place.phone ? ' To talk to the restaurant, call ' + place.phone + '.' : ''), reason: 'closed' });
    }
    if (!(await allow(guestSend, keyFor('r' + q.id), { failOpen: false }))
        || !(await allow(guestSend, keyFor('ip' + clientIp(req)), { failOpen: false }))) {
      return res.status(429).json({ error: 'Too many messages in a few minutes. Wait a little, or call the restaurant.' });
    }
    let fileId = null;
    if (hasFile) {
      const claimed = await claimFile(body.fileId, placeOf, { fromGuest: true, keepUntil: keepUntilOf(q) });
      if (claimed.error) return fileError(res, claimed.error);
      fileId = claimed.file.id;
    }
    const saved = await addMessage(q, { from_guest: true, author_id: tasterId, body: text, ...(fileId ? { file_id: fileId } : {}) });
    if (!saved) return res.status(502).json({ error: 'Your message was not sent. Please try again.' });
    console.log('[requestchat] guest wrote about request', q.id);
    return reply();
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

// For My Reservations: the account's requests still waiting for an answer,
// each with a line about its conversation. Never fails the list it is part of.
export async function guestRequests(match, timezone) {
  const today = todayIn(timezone || 'America/New_York');
  const got = await sb(`/reservation_requests?${match}&status=eq.new&wanted_date=gte.${today}` +
                       `&select=${REQUEST_COLUMNS.replace(',chat_emailed_at', '')}&order=wanted_date.asc,id.asc&limit=20`);
  const rows = got.ok && Array.isArray(got.data) ? got.data : [];
  if (!rows.length) return [];
  const ids = rows.map((q) => Number(q.id));
  const unread = await sb(`/request_messages?request_id=in.(${ids.join(',')})&from_guest=is.false&read_at=is.null&select=request_id&limit=1000`);
  const on = unread.ok;                        // migration 20 is there
  const count = {};
  (on && Array.isArray(unread.data) ? unread.data : []).forEach((m) => { count[m.request_id] = (count[m.request_id] || 0) + 1; });
  const rids = [...new Set(rows.map((q) => q.restaurant_id))];
  const names = {};
  await Promise.all(rids.map(async (rid) => {
    const l = await loadBooking(rid);
    names[rid] = l && !l.error && l.restaurant ? l.restaurant : null;
  }));
  return rows.map((q) => ({
    id: q.id, party: q.party_size, date: q.wanted_date, day: dayLabel(q.wanted_date), time: timeLabel(q.wanted_time),
    occasion: q.occasion || null,
    restaurant: (names[q.restaurant_id] && names[q.restaurant_id].name) || 'Restaurant',
    phone: (names[q.restaurant_id] && names[q.restaurant_id].phone) || null,
    chat: on ? { unread: count[q.id] || 0, canWrite: true } : null,
  }));
}

// For the bell: the restaurants' messages about this account's requests that
// it has not read. [] before migration 20.
export async function requestBell(match) {
  const got = await sb(`/reservation_requests?${match}&status=eq.new&select=id,restaurant_id,wanted_date,party_size&limit=50`);
  const rows = got.ok && Array.isArray(got.data) ? got.data : [];
  if (!rows.length) return [];
  const unread = await sb(`/request_messages?request_id=in.(${rows.map((q) => Number(q.id)).join(',')})` +
                          '&from_guest=is.false&read_at=is.null&select=request_id,author_id,author_name,created_at&order=id.desc&limit=200');
  const list = unread.ok && Array.isArray(unread.data) ? unread.data : [];
  if (!list.length) return [];
  const by = {};
  list.forEach((m) => {
    const b = by[m.request_id] || (by[m.request_id] = { count: 0, who: m.author_name, author: m.author_id, at: m.created_at });
    b.count += 1;
  });
  const handles = await handlesById(Object.values(by).map((b) => b.author));
  const rowOf = {};
  rows.forEach((q) => { rowOf[q.id] = q; });
  const places = {};
  await Promise.all([...new Set(Object.keys(by).map((id) => rowOf[id].restaurant_id))].map(async (rid) => { places[rid] = await loadBooking(rid); }));
  return Object.entries(by).map(([id, b]) => {
    const q = rowOf[id], l = places[q.restaurant_id];
    const tz = (l && l.settings && l.settings.timezone) || 'America/New_York';
    return {
      requestId: Number(id), count: b.count, who: b.who || 'The team', handle: handles[b.author] || null,
      restaurant: (l && l.restaurant && l.restaurant.name) || 'The restaurant',
      at: new Date(b.at).toISOString(), label: whenLabel(tz, b.at),
      table: dayLabel(q.wanted_date) + ' · ' + q.party_size + ' people',
    };
  });
}

// ── THE RESTAURANT ────────────────────────────────────────────────────────────
// For the day's request cards: how many messages each has, and how many the
// guest wrote that nobody has read. null per request before migration 20.
export async function requestSummaries(ids) {
  const out = {};
  const list = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return out;
  const got = await sb(`/request_messages?request_id=in.(${list.join(',')})&select=id,request_id,from_guest,read_at&limit=3000`);
  if (!got.ok || !Array.isArray(got.data)) { list.forEach((id) => { out[id] = null; }); return out; }
  list.forEach((id) => { out[id] = { count: 0, unread: 0 }; });
  got.data.forEach((m) => {
    const s = out[m.request_id];
    if (!s) return;
    s.count += 1;
    if (m.from_guest && !m.read_at) s.unread += 1;
  });
  return out;
}

export async function staffRequestChat(req, res, body, action, helpers = {}) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action === 'staff_req_send' || action === 'staff_req_upload';
  if (!(await allow(writes ? staffWrite : staffRead, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  const id = Number(body.requestId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which request?' });
  const found = await requestRow(id);
  if (found.error) return res.status(502).json({ error: 'Could not read the request (the database answered ' + found.error + ').' });
  const q = found.row;
  if (!q) return res.status(404).json({ error: NOT_THERE });
  // The restaurant is the request's own, never the page's.
  const who = await msgAccess(res, tasterId, q.restaurant_id, { hide: true });
  if (!who) return;
  const loaded = await loadBooking(q.restaurant_id);
  const timezone = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';

  if (action === 'staff_req_thread') return staffReply(res, q, who, timezone, { read: who.marksRead });
  const placeOf = { restaurantId: q.restaurant_id, requestId: q.id };

  if (action === 'staff_req_files') {
    const got = await fileLinks(placeOf, body.fileIds);
    if (got.error) return fileError(res, got.error);
    return res.status(200).json({ success: true, links: got.links, expiresIn: got.expiresIn || null });
  }
  if (action === 'staff_req_upload') {
    if (!writable(q, timezone)) return res.status(409).json({ error: 'This request has been answered: write to the guest on the table, or call them.' });
    const slot = await makeSlot(placeOf, { fromGuest: false, uploaderId: tasterId, name: body.name, mime: body.mime, size: body.size });
    if (slot.error) return fileError(res, slot.error);
    return res.status(200).json({ success: true, file: slot.file, uploadUrl: slot.uploadUrl });
  }

  if (action === 'staff_req_send') {
    const hasFile = body.fileId !== undefined && body.fileId !== null && body.fileId !== '';
    let text = cleanBody(body.body);
    if (!text && !hasFile) return res.status(400).json({ error: 'Write the message first.' });
    if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
    if (!text) text = '';
    if (!writable(q, timezone)) return res.status(409).json({ error: 'This request has been answered: write to the guest on the table, or call them.' });
    let fileId = null;
    if (hasFile) {
      const claimed = await claimFile(body.fileId, placeOf, { fromGuest: false, keepUntil: keepUntilOf(q) });
      if (claimed.error) return fileError(res, claimed.error);
      fileId = claimed.file.id;
    }
    const saved = await addMessage(q, { from_guest: false, author_id: tasterId, author_name: who.name, body: text, ...(fileId ? { file_id: fileId } : {}) });
    if (!saved) {
      // The table of messages is not there yet (migration 20 not run) or the database said no.
      const probe = await messagesOf(q.id);
      return res.status(probe.error === 404 ? 503 : 502).json({ error: probe.error === 404
        ? 'Messages about requests need migration 20 first (Supabase, SQL editor).' : 'The message was not sent. Please try again.' });
    }
    console.log('[requestchat] taster', tasterId, 'wrote about request', q.id);
    // A guest without an account hears once that the restaurant wrote.
    let emailed = false;
    if (!q.chat_emailed_at && typeof helpers.requestByEmail === 'function') {
      try {
        emailed = await helpers.requestByEmail({ requestId: q.id, staffName: who.name + (who.handle ? ` (${who.handle})` : ''), loaded, timezone });
      } catch (err) {
        console.error('[requestchat] email threw', q.id, err && err.message);
      }
    }
    return staffReply(res, q, who, timezone, { emailed });
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

async function staffReply(res, q, who, timezone, opts = {}) {
  const got = await messagesOf(q.id);
  if (got.error) return res.status(got.error === 404 ? 503 : 502).json({ error: got.error === 404
    ? 'Messages about requests need migration 20 first (Supabase, SQL editor).' : 'Could not read the messages. Please try again.' });
  if (opts.read) await markRead(q.id, got.list, false);
  const [account, , byId, fileOf, email] = await Promise.all([
    hasAccount(q), addHandles([q]),
    handlesById(got.list.filter((m) => !m.from_guest).map((m) => m.author_id)),
    fileOfList(got.list),
    who.level >= LEVEL.manager ? requestEmail(q.id) : undefined,
  ]);
  const first = String(q.guest_name || '').trim().split(/\s+/)[0] || 'Guest';
  const now = Date.now();
  return res.status(200).json({
    success: true,
    kind: 'request',
    ...(opts.emailed ? { emailed: true } : {}),
    request: {
      id: q.id, name: q.guest_name, handle: q.handle || null, phone: q.guest_phone, party: q.party_size,
      day: dayLabel(q.wanted_date), time: timeLabel(q.wanted_time), occasion: q.occasion || null, status: q.status,
      ...(email !== undefined ? { email } : {}),          // r42: managers and up only
    },
    open: writable(q, timezone),
    // Where the guest reads this: in My Reservations when they have an account;
    // otherwise one email tells them to log in with the number they gave.
    guestReads: account ? 'account' : 'email',
    keptUntil: keptUntil(q.wanted_date),
    messages: got.list.map((m) => ({
      id: m.id,
      fromGuest: !!m.from_guest,
      who: m.from_guest ? first : (Number(m.author_id) === Number(who.access.tasterId) ? 'You' : (m.author_name || 'The team')),
      handle: m.from_guest ? (q.handle || null) : (byId[m.author_id] || null),
      body: m.body,
      file: fileOf(m),
      at: new Date(m.created_at).toISOString(),
      label: whenLabel(timezone, m.created_at, now),
    })),
  });
}

// r42: the guest's email on a request, for managers and up only (read on its own, by id).
async function requestEmail(id) {
  const got = await sb(`/reservation_requests?id=eq.${Number(id)}&select=guest_email&limit=1`);
  return got.ok && Array.isArray(got.data) && got.data.length ? (got.data[0].guest_email || null) : null;
}

// The table is booked: its conversation starts with everything said about the
// request. Copies the messages to the table's own conversation (migration 19),
// then deletes them here. Never fails the booking: on any problem the messages
// simply stay with the request.
export async function moveToTable(requestId, reservation) {
  const got = await messagesOf(requestId);
  if (got.error || !got.list.length) return false;
  const last = got.list[got.list.length - 1];
  const made = await sb('/reservation_threads?on_conflict=reservation_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      reservation_id: Number(reservation.id), restaurant_id: Number(reservation.restaurant_id),
      service_date: reservation.serviceDate, table_at: reservation.at,
      last_at: new Date(last.created_at).toISOString(), last_from_guest: !!last.from_guest,
    }),
  });
  if (!made.ok) return false;
  // Every row of one insert must have the same fields: file_id for all, or for none.
  const withFiles = got.list.some((m) => m.file_id);
  const copied = await sb('/reservation_messages', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(got.list.map((m) => ({
      reservation_id: Number(reservation.id), restaurant_id: Number(reservation.restaurant_id),
      from_guest: !!m.from_guest, author_id: m.author_id || null, author_name: m.author_name || null,
      body: m.body, created_at: m.created_at, read_at: m.read_at || null,
      ...(withFiles ? { file_id: m.file_id || null } : {}),       // r42: the files go too
    }))),
  });
  if (!copied.ok) return false;
  if (withFiles) {
    try { await moveFiles(requestId, reservation.id, new Date(Date.parse(reservation.at) + KEEP_MS)); }
    catch (err) { console.error('[requestchat] files did not move', requestId, err && err.message); }
  }
  await sb(`/request_messages?request_id=eq.${Number(requestId)}&id=lte.${Number(last.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  return true;
}

// The daily job: requests whose day is more than 90 days gone lose their messages.
export async function forgetOldRequestMessages() {
  const before = new Date(Date.now() - KEEP_MS).toISOString().slice(0, 10);
  const old = await sb(`/reservation_requests?wanted_date=lt.${before}&select=id&limit=500`);
  if (!old.ok || !Array.isArray(old.data) || !old.data.length) return 0;
  const ids = old.data.map((q) => Number(q.id));
  const gone = await sb(`/request_messages?request_id=in.(${ids.join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  return gone.ok && Array.isArray(gone.data) ? gone.data.length : 0;
}
