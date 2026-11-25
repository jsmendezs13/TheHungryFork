// api/_lib/reviewlist.js — r52 (Sebastian, 9 Nov 2026): the manager page's Reviews tab.
//
// "I need you please add one new section that are the comments where manager can see a list of
// all the comments, so he doesn't need to open dish by dish to identify some problem with one of
// them" — and (15:07) keep the three kinds apart: dishes, drinks, and the restaurant.
//
//   rv_list   every review of the restaurant, newest first (up to MAX), with the dishes and drinks
//             of the menu (their category, kind of drink and photo), for managers and owners.
//
// Reviews are public already (anyone can read them on the menu); this answer adds nothing a
// guest could not see, except that it is all in one place. It never carries an email or a guest's
// account details: the name and handle the review was posted with, and the conversation under it.
// The page groups and filters it (dish / drink / restaurant, category, stars, replies, dates) — the
// server does not, so the Filters page can count as you choose.
//
// r54 (Sebastian, 15 Nov 2026; migration 39): a review waiting its 48 hours comes with waiting: { until } (the page
// shows those first, with Approve and Moderate review), and — for the owner, the managers who moderate and Seb's
// Analytics only — the phone number of the author of a review written after the change (phone_ok; the Privacy Policy
// says so). "only the manager and authorized people of the restaurant… not shared with people outside the restaurant".
import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { gate } from './staff.js';
import { loadBooking } from './booking.js';
import { REASONS, reasonLabel, isTeam, canModerateAt, switchOf, visitDots } from './moderation.js';   // r53

export const MAX_REVIEWS = 3000;
const readLimiter = makeLimiter({ requests: 60, window: '5 m', prefix: 'rv:list' });

const REVIEW_COLUMNS = 'id,dish_id,taster_id,flavor,worth_every_bite,signature_style,hospitality,atmosphere_vibe,'
  + 'dish_comment,restaurant_comment,reviewer_name,reviewer_username,created_at';
// The conversation under a review (migrations 9 and 10). Asked apart, so an older database still lists the reviews.
const REPLY_COLUMNS = 'reply_text,reply_created_at,reply_by_name,taster_reply_text,taster_reply_created_at,reply2_text,reply2_created_at,reply2_by_name';
// r53: a hidden review (migration 37). Asked apart again, so the list works before the migration.
const HIDDEN_COLUMNS = 'hidden_at,hidden_reason';
// r53c: deleted by its author (migration 38): out of the list, except for Seb's Analytics' record.
const DELETED_COLUMNS = 'deleted_at';
// r54: waiting its 48 hours, approved, and whether its author's phone may be shown (migration 39). Asked apart again.
const WAIT_COLUMNS = 'waiting_until,approved_at,phone_ok';

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 5 ? Number(v) : null);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export async function reviewsStaff(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (!(await allow(readLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  if (action === 'rv_list') return list(req, res, body, tasterId);
  return res.status(400).json({ error: 'Unknown action.' });
}

async function list(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  const [rv, dishes, booking, sw, canMod] = await Promise.all([
    readReviews(who.rid),
    menuOf(who.rid),
    loadBooking(who.rid).catch(() => null),
    switchOf(who.rid),                                       // r53: moderation at this restaurant
    canModerateAt(tasterId, who.rid, who.level),
  ]);
  const canModerate = sw.ready && canMod;                    // r53: nothing of moderation before migration 37
  if (!rv.ok || !Array.isArray(rv.data)) {
    console.error('[reviews:list] read failed', who.rid, rv.status);
    return res.status(502).json({ error: 'Could not read the reviews (the database answered ' + rv.status + '). Please try again.' });
  }
  // r53c: a review its author deleted is gone for the restaurant; Seb's Analytics keeps seeing it, marked, for the record.
  const platform = who.level >= LEVEL.platform;
  const rows = platform ? rv.data : rv.data.filter((r) => !r.deleted_at);
  // r53c: the authors' conversations about hidden reviews (moderators only): open or closed, and how many wait.
  const talks = canModerate ? await talksOf(who.rid) : {};
  // The names of reviewers whose review has none stored (reviews from before names were saved with them).
  const names = await namesFor(rows.filter((r) => !text(r.reviewer_name)).map((r) => r.taster_id));
  // r54: the phone numbers, for the moderators only, of the authors of reviews written after the change (never a deleted one)
  const phones = canModerate ? await phonesFor(rows.filter((r) => r.phone_ok === true && !r.deleted_at).map((r) => r.taster_id)) : new Map();
  const nowMs = Date.now();
  const timezone = (booking && booking.settings && booking.settings.timezone) || 'America/New_York';
  // Who wrote what goes out as a number that means something only inside this answer (1, 2, 3…), never
  // the guest's account number: it is enough to put one guest's comments about the restaurant together.
  const guestNo = new Map();
  const guestOf = (id) => { const k = String(id); if (!guestNo.has(k)) guestNo.set(k, guestNo.size + 1); return guestNo.get(k); };
  const dayOf = serviceDayIn(timezone);
  // r53: why each hidden review is hidden, and by whom (the newest hide in the log); the visit dots, for moderators only.
  const hiddenIds = rows.filter((r) => r.hidden_at).map((r) => Number(r.id));
  const why = {};
  if (hiddenIds.length) {
    const got = await sb(`/review_moderation_log?restaurant_id=eq.${who.rid}&review_id=in.(${hiddenIds.slice(0, 2000).join(',')})` +
                         '&action=in.(hide,team-hide)&select=review_id,details,alerted,by_name,at&order=id.desc&limit=4000');
    (got.ok && Array.isArray(got.data) ? got.data : []).forEach((l) => { if (!why[l.review_id]) why[l.review_id] = l; });
  }
  const dots = canModerate ? await visitDots(who.rid, rows, timezone) : {};
  // r62 (migration 45): when each part was edited, and who may change each reply in the restaurant's name — the writer,
  // an owner (a reply whose writer is below owner), Sebastian (any), a manager (a crew member's). reviewedit.js decides.
  const ed = await sb(`/reviews?restaurant_id=eq.${who.rid}&order=created_at.desc,id.desc&limit=${MAX_REVIEWS}` +
                      '&select=id,reply_by,reply2_by,edited_at,reply_edited_at,taster_reply_edited_at,reply2_edited_at');
  const editReady = ed.ok && Array.isArray(ed.data);
  const edOf = {};
  (editReady ? ed.data : []).forEach((x) => { edOf[x.id] = x; });
  const writers = [...new Set(Object.values(edOf).flatMap((x) => [x.reply_by, x.reply2_by]).filter(Boolean).map(Number))];
  const wl = {};
  if (writers.length) {
    const [wr, wa] = await Promise.all([
      sb(`/restaurant_roles?restaurant_id=eq.${who.rid}&taster_id=in.(${writers.join(',')})&select=taster_id,role`),
      sb(`/tasters?id=in.(${writers.join(',')})&is_platform_admin=eq.true&select=id`),
    ]);
    (wr.ok && Array.isArray(wr.data) ? wr.data : []).forEach((x) => { wl[x.taster_id] = Math.max(wl[x.taster_id] || 0, LEVEL[x.role] || 0); });
    (wa.ok && Array.isArray(wa.data) ? wa.data : []).forEach((x) => { wl[x.id] = LEVEL.platform; });
  }
  const lvlOf = (by) => (by && wl[by] != null ? wl[by] : LEVEL.manager);
  const mayChange = (by) => editReady && who.level >= LEVEL.manager && (who.level >= LEVEL.platform || (!!by && Number(by) === Number(tasterId))
    || (who.level >= LEVEL.owner ? lvlOf(by) < LEVEL.owner : lvlOf(by) < LEVEL.manager));
  return res.status(200).json({
    success: true,
    restaurant: who.rid,
    timezone,
    max: MAX_REVIEWS,
    more: rows.length >= MAX_REVIEWS,
    repliesReady: rv.withReplies,
    editReady,                                                                                                       // r62
    moderation: { ready: sw.ready, on: sw.on, at: sw.at || null, by: sw.by || null, canModerate, platform: who.level >= LEVEL.platform,
                  reasons: REASONS, deletedReady: rv.withDeleted === true, waitReady: rv.withWait === true },          // r54
    now: new Date(nowMs).toISOString(),                                                                              // r54: the server's clock
    dishes,
    reviews: rows.map((r) => {
      const n = names.get(Number(r.taster_id)) || {};
      return {
        id: r.id,
        dish: r.dish_id,
        guest: guestOf(r.taster_id),
        day: dayOf(r.created_at),
        name: text(r.reviewer_name) || n.name || 'A guest',
        handle: text(r.reviewer_username) || n.handle || null,
        at: r.created_at,
        dishStars: [num(r.flavor), num(r.worth_every_bite), num(r.signature_style)],
        roomStars: [num(r.hospitality), num(r.atmosphere_vibe)],
        dishComment: text(r.dish_comment),
        roomComment: text(r.restaurant_comment),
        hidden: r.hidden_at ? {
          reason: r.hidden_reason, label: reasonLabel(r.hidden_reason), team: isTeam(r.hidden_reason), at: r.hidden_at,
          by: why[r.id] ? why[r.id].by_name || null : null,
          ...(canModerate && why[r.id] ? { details: why[r.id].details || null, alerted: !!why[r.id].alerted } : {}),
        } : null,
        ...(canModerate ? { visit: dots[r.id] || null } : {}),
        ...(canModerate && talks[r.id] ? { talk: talks[r.id] } : {}),
        ...(platform && r.deleted_at ? { deleted: { at: r.deleted_at } } : {}),
        // r54: still waiting its 48 hours (not approved, not hidden, not deleted): only here, never on the public pages
        ...(r.waiting_until && !r.approved_at && !r.hidden_at && !r.deleted_at && Date.parse(r.waiting_until) > nowMs ? { waiting: { until: r.waiting_until } } : {}),
        ...(canModerate && r.phone_ok === true && !r.deleted_at && phones.get(Number(r.taster_id)) ? { phone: phones.get(Number(r.taster_id)) } : {}),
        ...(edOf[r.id] && edOf[r.id].edited_at ? { edited: edOf[r.id].edited_at } : {}),                                 // r62
        replies: [
          text(r.reply_text) ? { side: 'restaurant', turn: 'reply', text: r.reply_text, at: r.reply_created_at || null, by: text(r.reply_by_name),
            edited: !!(edOf[r.id] && edOf[r.id].reply_edited_at), canEdit: mayChange(edOf[r.id] && edOf[r.id].reply_by),
            canDelete: mayChange(edOf[r.id] && edOf[r.id].reply_by) && !text(r.taster_reply_text) } : null,
          text(r.taster_reply_text) ? { side: 'guest', turn: 'answer', text: r.taster_reply_text, at: r.taster_reply_created_at || null,
            edited: !!(edOf[r.id] && edOf[r.id].taster_reply_edited_at) } : null,
          text(r.reply2_text) ? { side: 'restaurant', turn: 'reply2', text: r.reply2_text, at: r.reply2_created_at || null, by: text(r.reply2_by_name),
            edited: !!(edOf[r.id] && edOf[r.id].reply2_edited_at), canEdit: mayChange(edOf[r.id] && edOf[r.id].reply2_by),
            canDelete: mayChange(edOf[r.id] && edOf[r.id].reply2_by) } : null,
        ].filter(Boolean),
      };
    }),
  });
}

// The reviews with their conversation; without it when the reply columns are not there (an older database).
async function readReviews(rid) {
  const base = `/reviews?restaurant_id=eq.${rid}&order=created_at.desc,id.desc&limit=${MAX_REVIEWS}&select=`;
  const waits = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS + ',' + HIDDEN_COLUMNS + ',' + DELETED_COLUMNS + ',' + WAIT_COLUMNS);   // r54
  if (waits.ok) return { ...waits, withReplies: true, withDeleted: true, withWait: true };
  if (waits.status !== 400) return waits;
  const kept = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS + ',' + HIDDEN_COLUMNS + ',' + DELETED_COLUMNS);    // r53c
  if (kept.ok) return { ...kept, withReplies: true, withDeleted: true };
  if (kept.status !== 400) return kept;
  const all = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS + ',' + HIDDEN_COLUMNS);    // r53
  if (all.ok) return { ...all, withReplies: true };
  if (all.status !== 400) return all;
  const full = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS);
  if (full.ok) return { ...full, withReplies: true };
  if (full.status !== 400) return full;
  const plain = await sb(base + REVIEW_COLUMNS);
  return { ...plain, withReplies: false };
}

// r53c: { reviewId: { open, unread, count } } — the authors' conversations about hidden reviews. {} before migration 38.
async function talksOf(rid) {
  const out = {};
  const [th, m] = await Promise.all([
    sb(`/review_threads?restaurant_id=eq.${Number(rid)}&select=review_id,closed_at&limit=3000`),
    sb(`/review_messages?restaurant_id=eq.${Number(rid)}&select=review_id,from_guest,read_at&limit=10000`),
  ]);
  if (!th.ok || !Array.isArray(th.data)) return out;
  th.data.forEach((t) => { out[t.review_id] = { open: !t.closed_at, unread: 0, count: 0 }; });
  (m.ok && Array.isArray(m.data) ? m.data : []).forEach((x) => {
    const o = out[x.review_id]; if (!o) return;
    o.count += 1;
    if (x.from_guest && !x.read_at) o.unread += 1;
  });
  return out;
}

// The menu's dishes and drinks: what the Filters page groups by (category, kind of drink) and the photo.
async function menuOf(rid) {
  let got = await sb(`/dishes?restaurant_id=eq.${rid}&select=id,slug,name,restaurant_category,drink_kind,image,is_hidden,sort_order&order=sort_order.asc,id.asc&limit=2000`);
  if (!got.ok) got = await sb(`/dishes?restaurant_id=eq.${rid}&select=id,slug,name,restaurant_category,image,is_hidden,sort_order&order=sort_order.asc,id.asc&limit=2000`);
  if (!got.ok || !Array.isArray(got.data)) return [];
  return got.data.map((d) => ({
    id: d.id, slug: d.slug || null, name: d.name || 'A dish',
    category: d.restaurant_category || null, kind: d.drink_kind || null,
    img: /^(?:[a-z0-9-]+\/photos\/)?[A-Za-z0-9_-]+\.(png|jpe?g)$/.test(String(d.image || '')) || /^https:\/\//.test(String(d.image || '')) ? d.image : null,   // 19 Nov: or havana/photos/…
    hidden: !!d.is_hidden,
  }));
}

// The service day a review belongs to, in the restaurant's time zone: a day runs 5 AM to 5 AM (like the
// Lucky Bite's visit day), so a dinner at 11 PM rated at 1 AM is still that evening's.
export function serviceDayIn(timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => { const t = Date.parse(at); return Number.isFinite(t) ? fmt.format(new Date(t - 5 * 3600 * 1000)) : null; };
}

// r54: { tasterId: '+12125550147' } — the account's phone number as saved (the page writes it (212) 555-0147).
async function phonesFor(ids) {
  const want = [...new Set(ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 1000);
  const map = new Map();
  if (!want.length) return map;
  const got = await sb(`/tasters?id=in.(${want.join(',')})&select=id,phone_number`);
  if (got.ok && Array.isArray(got.data)) {
    got.data.forEach((t) => { const p = text(t.phone_number); if (p && /^\+?[0-9() .-]{7,20}$/.test(p)) map.set(Number(t.id), p); });
  }
  return map;
}

async function namesFor(ids) {
  const want = [...new Set(ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500);
  const map = new Map();
  if (!want.length) return map;
  const got = await sb(`/tasters?id=in.(${want.join(',')})&select=id,first_name,last_name,username`);
  if (got.ok && Array.isArray(got.data)) {
    got.data.forEach((t) => map.set(Number(t.id), {
      name: [t.first_name, t.last_name].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null,
      handle: text(t.username),
    }));
  }
  return map;
}
