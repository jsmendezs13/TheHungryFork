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
// guest could not see, except that it is all in one place. It never carries a phone number, an
// email or a guest's account details: the name and handle the review was posted with, and the
// conversation under it. The page groups and filters it (dish / drink / restaurant, category,
// stars, replies, dates) — the server does not, so the Filters page can count as you choose.
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
  const rows = rv.data;
  // The names of reviewers whose review has none stored (reviews from before names were saved with them).
  const names = await namesFor(rows.filter((r) => !text(r.reviewer_name)).map((r) => r.taster_id));
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
  return res.status(200).json({
    success: true,
    restaurant: who.rid,
    timezone,
    max: MAX_REVIEWS,
    more: rows.length >= MAX_REVIEWS,
    repliesReady: rv.withReplies,
    moderation: { ready: sw.ready, on: sw.on, at: sw.at || null, by: sw.by || null, canModerate, platform: who.level >= LEVEL.platform,
                  reasons: REASONS },
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
        replies: [
          text(r.reply_text) ? { side: 'restaurant', text: r.reply_text, at: r.reply_created_at || null, by: text(r.reply_by_name) } : null,
          text(r.taster_reply_text) ? { side: 'guest', text: r.taster_reply_text, at: r.taster_reply_created_at || null } : null,
          text(r.reply2_text) ? { side: 'restaurant', text: r.reply2_text, at: r.reply2_created_at || null, by: text(r.reply2_by_name) } : null,
        ].filter(Boolean),
      };
    }),
  });
}

// The reviews with their conversation; without it when the reply columns are not there (an older database).
async function readReviews(rid) {
  const base = `/reviews?restaurant_id=eq.${rid}&order=created_at.desc,id.desc&limit=${MAX_REVIEWS}&select=`;
  const all = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS + ',' + HIDDEN_COLUMNS);    // r53
  if (all.ok) return { ...all, withReplies: true };
  if (all.status !== 400) return all;
  const full = await sb(base + REVIEW_COLUMNS + ',' + REPLY_COLUMNS);
  if (full.ok) return { ...full, withReplies: true };
  if (full.status !== 400) return full;
  const plain = await sb(base + REVIEW_COLUMNS);
  return { ...plain, withReplies: false };
}

// The menu's dishes and drinks: what the Filters page groups by (category, kind of drink) and the photo.
async function menuOf(rid) {
  let got = await sb(`/dishes?restaurant_id=eq.${rid}&select=id,slug,name,restaurant_category,drink_kind,image,is_hidden,sort_order&order=sort_order.asc,id.asc&limit=2000`);
  if (!got.ok) got = await sb(`/dishes?restaurant_id=eq.${rid}&select=id,slug,name,restaurant_category,image,is_hidden,sort_order&order=sort_order.asc,id.asc&limit=2000`);
  if (!got.ok || !Array.isArray(got.data)) return [];
  return got.data.map((d) => ({
    id: d.id, slug: d.slug || null, name: d.name || 'A dish',
    category: d.restaurant_category || null, kind: d.drink_kind || null,
    img: /^[A-Za-z0-9_-]+\.(png|jpe?g)$/.test(String(d.image || '')) || /^https:\/\//.test(String(d.image || '')) ? d.image : null,
    hidden: !!d.is_hidden,
  }));
}

// The service day a review belongs to, in the restaurant's time zone: a day runs 5 AM to 5 AM (like the
// Lucky Bite's visit day), so a dinner at 11 PM rated at 1 AM is still that evening's.
export function serviceDayIn(timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => { const t = Date.parse(at); return Number.isFinite(t) ? fmt.format(new Date(t - 5 * 3600 * 1000)) : null; };
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
