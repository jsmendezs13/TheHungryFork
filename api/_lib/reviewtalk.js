// api/_lib/reviewtalk.js — r53c (Sebastian, 10 Nov 2026). Migration 38.
//
// 1 · "the author is able to delete his own review" (00:11), "Keep the deleted rates with all the information for
//     the record, but they don't count" (00:19). my_review_delete: only the author, logged in, deletes their review.
//     The row stays with everything it had (stars, words, dates, the conversation under it), marked deleted_at /
//     deleted_by: it leaves every page and the score at once (the database's read rule hides it from the browser),
//     and only Seb's Analytics sees it again, in Reviews → Filters → "Deleted by the author (only you)". Rating that
//     dish again is possible at once (a deleted review doesn't count for the 30 days).
//
// 2 · "here it says, tell the restaurant, but don't give them the option, please make the option to send a message
//     the same way the other messages" (00:37); the four choices "Yes I agree" (00:51). The author of a review the
//     restaurant hid writes to the restaurant about it, from My Tastings ("Message The Hungry Fork"), with photos and
//     PDFs like the other conversations:
//       · only the author starts it, and only while the restaurant hides the review (never for the team rule);
//       · the owner, the managers the owner lets moderate, and Seb's Analytics answer it (never crew);
//       · the restaurant can close it; the author writing again opens it (while the review is hidden); it closes by
//         itself when the review is shown again or deleted (it can still be read);
//       · the author's bell says "… answered about your review"; the moderators get a notification;
//       · kept with the review's record: 5 years (review_threads.keep_until), with its files.
//
//   my_review_delete             the author                 reviewId
//   rvc_mine                     the author                 their conversations: { reviewId: { open, unread, count } }
//   rvc_list / rvc_send          the author                 reviewId (, body, fileId)
//   rvc_upload / rvc_files       the author                 a slot for one file / links that work for one hour
//   rvc_staff_thread             moderators                 restaurantId, reviewId (the guest's messages are read now)
//   rvc_staff_send               moderators                 … body, fileId
//   rvc_staff_close / _reopen    moderators
//   rvc_staff_upload / _files    moderators
import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { gate } from './staff.js';
import { loadBooking } from './booking.js';
import { canModerateAt, isTeam, reasonLabel } from './moderation.js';
import { cleanBody, staffName, whenLabel, MAX_BODY } from './messages.js';
import { handlesById } from './guests.js';
import { makeSlot, claimFile, filesById, fileLinks, fileError } from './files.js';
import { notifyStaff, line } from './push.js';

export const KEEP_YEARS = 5;
const deleteLimiter = makeLimiter({ requests: 30, window: '10 m', prefix: 'rvc:delete' });
const guestRead = makeLimiter({ requests: 900, window: '10 m', prefix: 'rvc:read' });
const guestSend = makeLimiter({ requests: 12, window: '10 m', prefix: 'rvc:send' });
const guestUpload = makeLimiter({ requests: 20, window: '10 m', prefix: 'rvc:file' });
const staffRead = makeLimiter({ requests: 1800, window: '10 m', prefix: 'rvc:staff:read' });
const staffWrite = makeLimiter({ requests: 150, window: '10 m', prefix: 'rvc:staff:write' });

const NOT_READY = 'This needs migration 38 first.';
const NOT_THERE = 'That review is not there any more.';
const NO_THREAD = 'Nobody has written about this review yet.';
const TOO_MANY = 'Too many messages in a few minutes. Wait a little and try again.';

const REVIEW_COLUMNS = 'id,restaurant_id,taster_id,dish_id,created_at,flavor,worth_every_bite,signature_style,hospitality,atmosphere_vibe,'
  + 'dish_comment,restaurant_comment,reviewer_name,reviewer_username,hidden_at,hidden_reason,deleted_at';

export async function reviewTalk(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (action === 'my_review_delete') return deleteMine(res, tasterId, body);
  if (action === 'rvc_mine') return mine(res, tasterId);
  if (action === 'rvc_list' || action === 'rvc_send' || action === 'rvc_upload' || action === 'rvc_files') return guestSide(req, res, tasterId, body, action);
  if (action.startsWith('rvc_staff_')) return staffSide(req, res, tasterId, body, action);
  return res.status(400).json({ error: 'Unknown action.' });
}

// ── reads ─────────────────────────────────────────────────────────────────────
async function reviewRow(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { status: 400, error: 'Which review?' };
  const got = await sb(`/reviews?id=eq.${n}&select=${REVIEW_COLUMNS}&limit=1`);
  if (!got.ok) return { status: got.status === 400 ? 409 : 502, error: got.status === 400 ? NOT_READY : 'Could not read that review. Please try again.' };
  const row = Array.isArray(got.data) && got.data[0] ? got.data[0] : null;
  if (!row) return { status: 404, error: NOT_THERE };
  return { row };
}
async function threadOf(reviewId) {
  const got = await sb(`/review_threads?review_id=eq.${Number(reviewId)}&select=*&limit=1`);
  if (!got.ok) return { error: got.status };
  return { thread: Array.isArray(got.data) && got.data[0] ? got.data[0] : null };
}
async function messagesOf(reviewId) {
  const got = await sb(`/review_messages?review_id=eq.${Number(reviewId)}&select=id,from_guest,author_id,author_name,body,file_id,created_at,read_at&order=id.asc&limit=500`);
  return got.ok && Array.isArray(got.data) ? got.data : null;
}
async function dishName(id) {
  const got = await sb(`/dishes?id=eq.${Number(id)}&select=name&limit=1`);
  return got.ok && Array.isArray(got.data) && got.data[0] ? (got.data[0].name || 'a dish') : 'a dish';
}
async function placeOf(rid) {
  const loaded = await loadBooking(rid).catch(() => null);
  return {
    name: (loaded && loaded.restaurant && loaded.restaurant.name) || 'The restaurant',
    timezone: (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York',
  };
}
async function fileOfList(list) {
  const files = await filesById(list.map((m) => m.file_id).filter(Boolean));
  return (m) => (m.file_id && files[m.file_id]) || null;
}
// Hidden by the restaurant (not by the team rule), and not deleted: the author may write.
const hiddenByRestaurant = (r) => !!r.hidden_at && !isTeam(r.hidden_reason) && !r.deleted_at;
const keptLabel = (iso, timezone) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));
function fiveYears() { const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() + KEEP_YEARS); return d; }

// The other side's messages, now read (only the ones on the screen).
async function markRead(reviewId, list, readerIsGuest) {
  if (!list.some((m) => !m.read_at && !!m.from_guest !== readerIsGuest)) return;
  const last = Math.max(...list.map((m) => Number(m.id)));
  await sb(`/review_messages?review_id=eq.${Number(reviewId)}&id=lte.${last}&from_guest=is.${readerIsGuest ? 'false' : 'true'}&read_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ read_at: new Date().toISOString() }),
  });
}
async function addMessage(row, fields) {
  const put = await sb('/review_messages', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ review_id: Number(row.id), restaurant_id: Number(row.restaurant_id), ...fields }),
  });
  if (!put.ok || !Array.isArray(put.data) || !put.data.length) return null;
  await sb(`/review_threads?review_id=eq.${Number(row.id)}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ last_at: new Date().toISOString(), last_from_guest: !!fields.from_guest }),
  });
  return put.data[0];
}
async function closeThread(reviewId, reason, by = null) {
  await sb(`/review_threads?review_id=eq.${Number(reviewId)}&closed_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ closed_at: new Date().toISOString(), closed_reason: reason, closed_by: by }),
  }).catch(() => null);
}
// r53c: when the restaurant shows the review again (moderation.js), its conversation closes (it can still be read).
export async function closeTalks(reviewIds, reason) {
  const ids = (reviewIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return;
  await sb(`/review_threads?review_id=in.(${ids.join(',')})&closed_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ closed_at: new Date().toISOString(), closed_reason: reason, closed_by: null }),
  }).catch(() => null);
}
// Who answers: the owners, the managers with "Can moderate reviews", and Seb's Analytics.
async function moderatorIds(rid) {
  const [roles, admins] = await Promise.all([
    sb(`/restaurant_roles?restaurant_id=eq.${Number(rid)}&select=taster_id,role,can_moderate`),
    sb('/tasters?is_platform_admin=eq.true&select=id&limit=20'),
  ]);
  const out = [];
  (roles.ok && Array.isArray(roles.data) ? roles.data : []).forEach((r) => { if (r.role === 'owner' || (r.role === 'manager' && r.can_moderate === true)) out.push(Number(r.taster_id)); });
  (admins.ok && Array.isArray(admins.data) ? admins.data : []).forEach((t) => out.push(Number(t.id)));
  return out;
}

// ── 1 · the author deletes their review ───────────────────────────────────────
async function deleteMine(res, tasterId, body) {
  if (!(await allow(deleteLimiter, keyFor('d' + tasterId), { failOpen: false }))) return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  const got = await reviewRow(body.reviewId);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const r = got.row;
  // Somebody else's review answers exactly like one that is not there.
  if (Number(r.taster_id) !== Number(tasterId) || r.deleted_at) return res.status(404).json({ error: NOT_THERE });
  const at = new Date().toISOString();
  const saved = await sb(`/reviews?id=eq.${Number(r.id)}&taster_id=eq.${Number(tasterId)}&deleted_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ deleted_at: at, deleted_by: Number(tasterId) }),
  });
  if (!saved.ok) return res.status(502).json({ error: 'Could not delete it (the database answered ' + saved.status + '). Please try again.' });
  if (!Array.isArray(saved.data) || !saved.data.length) return res.status(404).json({ error: NOT_THERE });
  await closeTalks([r.id], 'deleted');
  console.log('[reviewtalk] taster', tasterId, 'deleted review', r.id, 'at', r.restaurant_id);
  return res.status(200).json({ success: true, deleted: Number(r.id), at });
}

// ── 2 · the author's side ─────────────────────────────────────────────────────
async function mine(res, tasterId) {
  if (!(await allow(guestRead, keyFor('m' + tasterId), { failOpen: true }))) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  const t = await sb(`/review_threads?taster_id=eq.${Number(tasterId)}&select=review_id,closed_at&limit=500`);
  if (!t.ok) return res.status(200).json({ success: true, ready: false, threads: {} });      // before migration 38
  const rows = Array.isArray(t.data) ? t.data : [];
  const out = {};
  if (rows.length) {
    const ids = rows.map((x) => Number(x.review_id));
    const m = await sb(`/review_messages?review_id=in.(${ids.join(',')})&select=review_id,from_guest,read_at&limit=5000`);
    rows.forEach((x) => { out[x.review_id] = { open: !x.closed_at, unread: 0, count: 0 }; });
    (m.ok && Array.isArray(m.data) ? m.data : []).forEach((x) => {
      const o = out[x.review_id]; if (!o) return;
      o.count += 1;
      if (!x.from_guest && !x.read_at) o.unread += 1;
    });
  }
  return res.status(200).json({ success: true, ready: true, threads: out });
}

function guestView(r, thread, list, place, dish, handles, fileOf) {
  const can = hiddenByRestaurant(r);
  let note = null;
  if (r.deleted_at) note = 'You deleted this review, so this conversation is closed.';
  else if (!r.hidden_at) note = thread ? 'The restaurant showed your review again, so this conversation is closed.' : 'You can write to the restaurant here only about a review it hid.';
  else if (!can) note = 'Ratings by a restaurant’s owners and managers are hidden automatically: there is nothing to write about.';
  else if (thread && thread.closed_at) note = 'The restaurant closed this conversation. Write below to open it again.';
  const keep = thread ? thread.keep_until : fiveYears().toISOString();
  return {
    success: true,
    restaurant: place.name,
    review: { id: Number(r.id), dish, at: r.created_at },
    state: !thread ? 'new' : thread.closed_at ? 'closed' : 'open',
    canWrite: can, note,
    empty: `Write to ${place.name} about this review. Its owner and managers answer you here. Photos and PDFs are welcome (a receipt, for example).`,
    foot: `Only you and the restaurant’s owner and managers see these messages. Kept with your review’s record until ${keptLabel(keep, place.timezone)} (${KEEP_YEARS} years).`,
    messages: list.map((m) => ({
      id: m.id, mine: !!m.from_guest,
      name: m.from_guest ? 'You' : (m.author_name || 'The team'),
      handle: m.from_guest ? null : (handles[m.author_id] || null),
      place: m.from_guest ? null : place.name,
      body: m.body, file: fileOf(m),
      at: new Date(m.created_at).toISOString(), label: whenLabel(place.timezone, m.created_at),
    })),
  };
}

async function guestReply(res, r, place) {
  const t = await threadOf(r.id);
  if (t.error) return res.status(t.error === 404 ? 409 : 502).json({ error: t.error === 404 ? NOT_READY : 'Could not read the messages. Please try again.' });
  const list = t.thread ? await messagesOf(r.id) : [];
  if (list === null) return res.status(502).json({ error: 'Could not read the messages. Please try again.' });
  if (t.thread) await markRead(r.id, list, true);
  const [handles, fileOf, dish] = await Promise.all([
    handlesById(list.filter((m) => !m.from_guest).map((m) => m.author_id)), fileOfList(list), dishName(r.dish_id),
  ]);
  return res.status(200).json(guestView(r, t.thread, list, place, dish, handles, fileOf));
}

async function guestSide(req, res, tasterId, body, action) {
  const reads = action === 'rvc_list' || action === 'rvc_files';
  if (reads && !(await allow(guestRead, keyFor('g' + tasterId), { failOpen: true }))) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  const got = await reviewRow(body.reviewId);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const r = got.row;
  if (Number(r.taster_id) !== Number(tasterId)) return res.status(404).json({ error: NOT_THERE });
  const place = await placeOf(r.restaurant_id);
  const filePlace = { restaurantId: r.restaurant_id, reviewId: r.id };

  if (action === 'rvc_list') return guestReply(res, r, place);
  if (action === 'rvc_files') {
    const links = await fileLinks(filePlace, body.fileIds);
    if (links.error) return fileError(res, links.error);
    return res.status(200).json({ success: true, links: links.links, expiresIn: links.expiresIn || null });
  }
  if (!hiddenByRestaurant(r)) {
    const t0 = await threadOf(r.id);
    return res.status(409).json({ error: r.deleted_at ? 'You deleted this review, so this conversation is closed.'
      : r.hidden_at ? 'Ratings by a restaurant\u2019s owners and managers are hidden automatically: there is nothing to write about.'
      : t0.thread ? 'The restaurant showed your review again, so this conversation is closed.'
      : 'You can write to the restaurant here only about a review it hid.', reason: 'closed' });
  }
  if (action === 'rvc_upload') {
    if (!(await allow(guestUpload, keyFor('v' + r.id), { failOpen: false }))) return res.status(429).json({ error: 'Too many files in a few minutes. Wait a little.' });
    const slot = await makeSlot(filePlace, { fromGuest: true, uploaderId: tasterId, name: body.name, mime: body.mime, size: body.size });
    if (slot.error) return fileError(res, slot.error);
    return res.status(200).json({ success: true, file: slot.file, uploadUrl: slot.uploadUrl });
  }
  // rvc_send
  const hasFile = body.fileId !== undefined && body.fileId !== null && body.fileId !== '';
  let text = cleanBody(body.body);
  if (!text && !hasFile) return res.status(400).json({ error: 'Write your message first.' });
  if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
  if (!text) text = '';
  if (!(await allow(guestSend, keyFor('v' + r.id), { failOpen: false }))) return res.status(429).json({ error: TOO_MANY });
  const made = await sb('/review_threads?on_conflict=review_id', {
    method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ review_id: Number(r.id), restaurant_id: Number(r.restaurant_id), taster_id: Number(tasterId), keep_until: fiveYears().toISOString() }),
  });
  if (!made.ok) return res.status(made.status === 404 ? 409 : 502).json({ error: made.status === 404 ? NOT_READY : 'Your message was not sent. Please try again.' });
  const t = await threadOf(r.id);
  if (t.error || !t.thread) return res.status(502).json({ error: 'Your message was not sent. Please try again.' });
  if (t.thread.closed_at) {
    // The restaurant closed it: the author writing again opens it (while the review is hidden).
    await sb(`/review_threads?review_id=eq.${Number(r.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ closed_at: null, closed_reason: null, closed_by: null }) });
  }
  let fileId = null, kind = null;
  if (hasFile) {
    const claimed = await claimFile(body.fileId, filePlace, { fromGuest: true, keepUntil: t.thread.keep_until });
    if (claimed.error) return fileError(res, claimed.error);
    fileId = claimed.file.id; kind = claimed.file.kind;
  }
  const saved = await addMessage(r, { from_guest: true, author_id: Number(tasterId), body: text, ...(fileId ? { file_id: fileId } : {}) });
  if (!saved) return res.status(502).json({ error: 'Your message was not sent. Please try again.' });
  const dish = await dishName(r.dish_id);
  const first = String(r.reviewer_name || '').trim().split(/\s+/)[0] || 'A guest';
  console.log('[reviewtalk] the author wrote about review', r.id, fileId ? '(with a file)' : '');
  await notifyStaff(r.restaurant_id, 'messages', {
    title: place.name + ' · Review',
    body: line(`${first} wrote about their hidden review of ${dish}` + (text ? ': ' + text : kind === 'pdf' ? ' (a PDF)' : kind ? ' (a photo)' : '')),
    url: `/manager#go=reviews&talk=${Number(r.id)}&at=${Number(r.restaurant_id)}`, tag: 'talk-' + Number(r.id),
  }, { only: await moderatorIds(r.restaurant_id) });
  return guestReply(res, r, place);
}

// ── 3 · the restaurant's side ─────────────────────────────────────────────────
async function staffSide(req, res, tasterId, body, action) {
  const reads = action === 'rvc_staff_thread' || action === 'rvc_staff_files';
  if (!(await allow(reads ? staffRead : staffWrite, keyFor(tasterId), { failOpen: true }))) return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  if (!(await canModerateAt(tasterId, who.rid, who.level))) {
    return res.status(403).json({ error: 'Only the owner, and the managers the owner chooses (Team → "Can moderate reviews"), answer messages about hidden reviews.' });
  }
  const got = await reviewRow(body.reviewId);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const r = got.row;
  if (Number(r.restaurant_id) !== who.rid) return res.status(404).json({ error: NOT_THERE });
  const t = await threadOf(r.id);
  if (t.error) return res.status(t.error === 404 ? 409 : 502).json({ error: t.error === 404 ? NOT_READY : 'Could not read the conversation. Please try again.' });
  if (!t.thread) return res.status(404).json({ error: NO_THREAD });
  const place = await placeOf(r.restaurant_id);
  const filePlace = { restaurantId: r.restaurant_id, reviewId: r.id };

  if (action === 'rvc_staff_thread') return staffReply(res, r, place, who, tasterId, { read: who.level < LEVEL.platform });
  if (action === 'rvc_staff_files') {
    const links = await fileLinks(filePlace, body.fileIds);
    if (links.error) return fileError(res, links.error);
    return res.status(200).json({ success: true, links: links.links, expiresIn: links.expiresIn || null });
  }
  if (r.deleted_at) return res.status(409).json({ error: 'The author deleted this review, so this conversation is closed.' });
  if (action === 'rvc_staff_upload') {
    const slot = await makeSlot(filePlace, { fromGuest: false, uploaderId: tasterId, name: body.name, mime: body.mime, size: body.size });
    if (slot.error) return fileError(res, slot.error);
    return res.status(200).json({ success: true, file: slot.file, uploadUrl: slot.uploadUrl });
  }
  if (action === 'rvc_staff_close') {
    await closeThread(r.id, 'staff', tasterId);
    const seen = Number(body.seen);
    if (Number.isInteger(seen) && seen > 0) {
      await sb(`/review_messages?review_id=eq.${Number(r.id)}&id=lte.${seen}&from_guest=is.true&read_at=is.null`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ read_at: new Date().toISOString() }),
      });
    }
    return staffReply(res, r, place, who, tasterId);
  }
  if (action === 'rvc_staff_reopen') {
    await sb(`/review_threads?review_id=eq.${Number(r.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ closed_at: null, closed_reason: null, closed_by: null }) });
    return staffReply(res, r, place, who, tasterId);
  }
  if (action === 'rvc_staff_send') {
    const hasFile = body.fileId !== undefined && body.fileId !== null && body.fileId !== '';
    let text = cleanBody(body.body);
    if (!text && !hasFile) return res.status(400).json({ error: 'Write the message first.' });
    if (text === 'long') return res.status(400).json({ error: `A message can be up to ${MAX_BODY} letters.` });
    if (!text) text = '';
    if (t.thread.closed_at) {
      await sb(`/review_threads?review_id=eq.${Number(r.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ closed_at: null, closed_reason: null, closed_by: null }) });
    }
    let fileId = null;
    if (hasFile) {
      const claimed = await claimFile(body.fileId, filePlace, { fromGuest: false, keepUntil: t.thread.keep_until });
      if (claimed.error) return fileError(res, claimed.error);
      fileId = claimed.file.id;
    }
    const saved = await addMessage(r, { from_guest: false, author_id: Number(tasterId), author_name: staffName(who.firstName), body: text, ...(fileId ? { file_id: fileId } : {}) });
    if (!saved) return res.status(502).json({ error: 'The message was not sent. Please try again.' });
    console.log('[reviewtalk] taster', tasterId, 'answered about review', r.id, fileId ? '(with a file)' : '');
    return staffReply(res, r, place, who, tasterId);
  }
  return res.status(400).json({ error: 'Unknown action.' });
}

async function staffReply(res, r, place, who, tasterId, opts = {}) {
  const t = await threadOf(r.id);
  if (t.error || !t.thread) return res.status(502).json({ error: 'Could not read the conversation. Please try again.' });
  const th = t.thread;
  const list = await messagesOf(r.id);
  if (list === null) return res.status(502).json({ error: 'Could not read the messages. Please try again.' });
  if (opts.read) await markRead(r.id, list, false);
  const [handles, fileOf, dish, hid] = await Promise.all([
    handlesById([r.taster_id, ...list.filter((m) => !m.from_guest).map((m) => m.author_id)]), fileOfList(list), dishName(r.dish_id),
    r.hidden_at ? sb(`/review_moderation_log?review_id=eq.${Number(r.id)}&action=eq.hide&select=by_name,at&order=id.desc&limit=1`) : null,
  ]);
  const hide = hid && hid.ok && Array.isArray(hid.data) && hid.data[0] ? hid.data[0] : null;
  const first = String(r.reviewer_name || '').trim().split(/\s+/)[0] || 'The guest';
  const closedBy = th.closed_reason === 'staff' && th.closed_by ? await sb(`/tasters?id=eq.${Number(th.closed_by)}&select=first_name&limit=1`) : null;
  const closer = closedBy && closedBy.ok && Array.isArray(closedBy.data) && closedBy.data[0] ? staffName(closedBy.data[0].first_name) : null;
  return res.status(200).json({
    success: true,
    kind: 'review',
    review: {
      id: Number(r.id), dish, at: r.created_at, day: whenLabel(place.timezone, r.created_at),
      name: String(r.reviewer_name || '').trim() || first, handle: handles[r.taster_id] || r.reviewer_username || null,
      dishStars: [r.flavor, r.worth_every_bite, r.signature_style], roomStars: [r.hospitality, r.atmosphere_vibe],
      hidden: r.hidden_at ? { reason: r.hidden_reason, label: reasonLabel(r.hidden_reason), team: isTeam(r.hidden_reason), by: hide ? hide.by_name : null, at: r.hidden_at } : null,
      deleted: !!r.deleted_at,
    },
    open: !th.closed_at,
    closedNote: th.closed_at ? (th.closed_reason === 'shown' ? 'Closed: the review is shown again.'
      : th.closed_reason === 'deleted' ? 'Closed: the author deleted the review.'
      : 'Closed by ' + (closer || 'the restaurant') + '. ' + first + ' can write again (that opens it).') : null,
    foot: `Only ${first}, the owner and the managers who moderate reviews see this conversation. Kept with the review’s record until ${keptLabel(th.keep_until, place.timezone)} (${KEEP_YEARS} years).`,
    messages: list.map((m) => ({
      id: m.id, fromGuest: !!m.from_guest,
      who: m.from_guest ? first : (Number(m.author_id) === Number(tasterId) ? 'You' : (m.author_name || 'The team')),
      handle: m.from_guest ? (handles[r.taster_id] || null) : (handles[m.author_id] || null),
      body: m.body, file: fileOf(m), at: new Date(m.created_at).toISOString(), label: whenLabel(place.timezone, m.created_at),
    })),
  });
}

// ── the author's bell (api/_lib/messages.js inbox, through reservations.js): "Ana · The Hungry Fork answered about
//    your review of Sliced Steak". [] before migration 38.
export async function talkBell(tasterId) {
  const th = await sb(`/review_threads?taster_id=eq.${Number(tasterId)}&select=review_id,restaurant_id&limit=500`);
  if (!th.ok || !Array.isArray(th.data) || !th.data.length) return [];
  const ids = th.data.map((x) => Number(x.review_id));
  const unread = await sb(`/review_messages?review_id=in.(${ids.join(',')})&from_guest=is.false&read_at=is.null&select=review_id,author_name,created_at&order=id.desc&limit=200`);
  if (!unread.ok || !Array.isArray(unread.data) || !unread.data.length) return [];
  const by = {};
  unread.data.forEach((m) => { const b = by[m.review_id] || (by[m.review_id] = { count: 0, who: m.author_name, at: m.created_at }); b.count += 1; });
  const rids = [...new Set(th.data.filter((x) => by[x.review_id]).map((x) => Number(x.restaurant_id)))];
  const [reviews, places] = await Promise.all([
    sb(`/reviews?id=in.(${Object.keys(by).join(',')})&select=id,dish_id`),
    sb(`/restaurants?id=in.(${rids.join(',')})&select=id,name`),
  ]);
  const dishOf = {}; (reviews.ok && Array.isArray(reviews.data) ? reviews.data : []).forEach((r) => { dishOf[r.id] = r.dish_id; });
  const dishIds = [...new Set(Object.values(dishOf))];
  const dishes = dishIds.length ? await sb(`/dishes?id=in.(${dishIds.join(',')})&select=id,name`) : { ok: true, data: [] };
  const dn = {}; (dishes.ok && Array.isArray(dishes.data) ? dishes.data : []).forEach((d) => { dn[d.id] = d.name; });
  const pn = {}; (places.ok && Array.isArray(places.data) ? places.data : []).forEach((p) => { pn[p.id] = p.name; });
  const placeOfReview = {}; th.data.forEach((x) => { placeOfReview[x.review_id] = x.restaurant_id; });
  return Object.entries(by).map(([id, b]) => ({
    reviewTalk: Number(id), count: b.count, who: b.who || 'The team', restaurant: pn[placeOfReview[id]] || 'The restaurant',
    dish: dn[dishOf[id]] || 'a dish', at: new Date(b.at).toISOString(), label: whenLabel('America/New_York', b.at),
  }));
}
