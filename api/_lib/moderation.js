// api/_lib/moderation.js — r53 (Sebastian, 5–9 Nov 2026): moderation. Migration 37.
//
// "Hide, never delete": the restaurant's owner, or a manager the owner chooses ("Can moderate reviews" in Team), hides a
// review with the Moderate review button, for one of 16 reasons — the 7 named in the FTC rule (16 CFR 465.7) and 9
// other neutral reasons — with Details. The whole review (comment and stars) leaves the score, on the restaurant's
// site and on Fork's Rating; its author still sees it and is told why (the bell). Every hide and every "Show it
// again" is in the log, which can't be changed or erased. Each restaurant's moderation is OFF until it signs the
// Review and Data Addendum; Seb's Analytics (the platform admin) switches it on.
//
//   mod_hide     moderators, switch on        reviewIds (1–20, one author), reason, details ("Illegal or dangerous
//                                             content" tells Seb's Analytics at once: a child may be at risk, 18 U.S.C. 2258A)
//   mod_show     moderators                   "Show it again" (never what the team rule hid)
//   mod_log      moderators                   the restaurant's log, newest first
//   mod_switch   Seb's Analytics only         on / off
//   mod_seen     the author (logged in)       the bell's notices are read
//   mod_mine     the author (logged in)       their hidden reviews, with the reason they were told
//
// The team rule (owners' and managers' own ratings hidden automatically, crew can't rate where they work) lives in
// the database (migration 37's triggers): it holds whoever writes the review.
import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { gate } from './staff.js';
import { tellChange } from './changes.js';
import { loadBooking } from './booking.js';
import { alertPlatform } from './support.js';
import { whenLabel } from './messages.js';

// The reasons, in the order and the words of the Moderate review window Sebastian approved (9 Nov, picture r52-3 v3:
// "Named in the FTC rule" = 16 CFR 465.7(b)'s seven, "Other neutral reasons" = nine; "Written with AI" deleted 15:37).
export const REASONS = [
  { code: 'confidential', group: 'ftc', label: 'Confidential business information' },
  { code: 'abusive', group: 'ftc', label: 'Defamatory, harassing, abusive, obscene, vulgar or sexual content' },
  { code: 'personal', group: 'ftc', label: "Someone's personal information" },
  { code: 'discrimination', group: 'ftc', label: 'Discrimination' },
  { code: 'false', group: 'ftc', label: 'Clearly false or misleading information' },
  { code: 'fake', group: 'ftc', label: 'Fake' },
  { code: 'unrelated', group: 'ftc', label: 'Not about the restaurant or its food' },
  { code: 'demands', group: 'other', label: 'Demands or threats from the writer' },
  { code: 'ads', group: 'other', label: 'Ads, sales links or contact details, and scam links' },
  { code: 'impersonation', group: 'other', label: 'Pretending to be someone else' },
  { code: 'conflict', group: 'other', label: 'Conflict of interest' },
  { code: 'meaningless', group: 'other', label: 'Meaningless text' },
  { code: 'illegal', group: 'other', label: 'Illegal or dangerous content' },
  { code: 'not-own', group: 'other', label: "Not the writer's own experience" },
  { code: 'duplicate', group: 'other', label: 'The same review posted twice' },
  { code: 'other', group: 'other', label: 'Other (explain)' },
];
export const TEAM_LABEL = "A rating by the restaurant's owner or manager (hidden automatically)";
const LABEL = Object.fromEntries(REASONS.map((r) => [r.code, r.label]));
export function reasonLabel(code) {
  if (code === 'team' || code === 'team-role') return TEAM_LABEL;
  return LABEL[code] || 'A reason in the review rules';
}
export const isTeam = (code) => code === 'team' || code === 'team-role';
export const MAX_DETAILS = 1000;
export const MAX_AT_ONCE = 20;          // the reviews of one guest's visit, hidden together from its restaurant card

// What the author reads: the reason; for "Other", the restaurant's own explanation (the Review rules page says
// "Another reason, which the restaurant explains"). The details of the other 15 stay in the log.
const FOR_AUTHOR = { fake: 'A fake review', other: 'Another reason, which the restaurant explains' };
export function reasonForAuthor(code, details) {
  if (code === 'other') return FOR_AUTHOR.other + ': ' + String(details || '').trim();
  return FOR_AUTHOR[code] || reasonLabel(code);
}

const hideLimiter = makeLimiter({ requests: 40, window: '10 m', prefix: 'mod:hide' });
const readLimiter = makeLimiter({ requests: 120, window: '10 m', prefix: 'mod:read' });
const guestLimiter = makeLimiter({ requests: 60, window: '10 m', prefix: 'mod:seen' });
const NOT_READY = 'Moderation needs migration 37 first (the moderation database).';
const OFF = "Moderation is off at this restaurant. Seb's Analytics switches it on once the restaurant signs the Review and Data Addendum.";
const NOT_YOURS = 'Only the owner, and the managers the owner chooses (Team → "Can moderate reviews"), can moderate reviews.';

// Owners and Seb's Analytics always; a manager when the owner switched "Can moderate reviews" on; crew never.
export async function canModerateAt(tasterId, restaurantId, level) {
  if (level >= LEVEL.owner) return true;
  if (level < LEVEL.manager) return false;
  const got = await sb(`/restaurant_roles?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${Number(restaurantId)}&role=eq.manager&select=can_moderate`);
  return got.ok && Array.isArray(got.data) && got.data.some((r) => r.can_moderate === true);
}

// The restaurant's switch: { ready, on, at, by }. ready is false before migration 37.
export async function switchOf(restaurantId) {
  const got = await sb(`/restaurants?id=eq.${Number(restaurantId)}&select=moderation_on,moderation_at,moderation_by&limit=1`);
  if (!got.ok || !Array.isArray(got.data) || !got.data[0]) return { ready: false, on: false };
  const r = got.data[0];
  let by = null;
  if (r.moderation_by) {
    const t = await sb(`/tasters?id=eq.${Number(r.moderation_by)}&select=first_name&limit=1`);
    by = t.ok && Array.isArray(t.data) && t.data[0] ? (t.data[0].first_name || null) : null;
  }
  return { ready: true, on: r.moderation_on === true, at: r.moderation_at || null, by };
}

// The service day of a moment in the restaurant's time zone (a day runs 5 AM to 5 AM, like the Lucky Bite's).
export function serviceDayOf(timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return (at) => { const t = Date.parse(at); return Number.isFinite(t) ? fmt.format(new Date(t - 5 * 3600 * 1000)) : null; };
}

// The private visit dots (Sebastian, 9 Nov): { dot: 'day', by, at } = the staff confirmed a visit of this guest on the
// review's day (green: "Visit confirmed by Carlos · Today, 12:05 PM"); { dot: 'other', at } = a visit on another day (blue:
// "Visit on another day · Sat, Oct 24", the newest one); null = no visit there. Only moderators ever see them.
export async function visitDots(restaurantId, rows, timezone) {
  const out = {};
  const ids = [...new Set(rows.map((r) => Number(r.taster_id)).filter((x) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return out;
  const got = await sb(`/check_ins?restaurant_id=eq.${Number(restaurantId)}&taster_id=in.(${ids.slice(0, 1000).join(',')})&select=taster_id,created_at,confirmed_by_name&order=created_at.desc&limit=20000`);
  if (!got.ok || !Array.isArray(got.data)) return out;
  const day = serviceDayOf(timezone);
  const visits = {};
  got.data.forEach((c) => { (visits[c.taster_id] || (visits[c.taster_id] = [])).push({ day: day(c.created_at), at: c.created_at, by: c.confirmed_by_name || null }); });
  rows.forEach((r) => {
    const list = visits[r.taster_id];
    if (!list) { out[r.id] = null; return; }
    const d = day(r.created_at);
    const same = list.find((v) => v.day === d);
    out[r.id] = same ? { dot: 'day', by: same.by, at: same.at } : { dot: 'other', at: list[0].at };
  });
  return out;
}

// What a person typed as details: line breaks kept (at most one empty line), other control characters gone.
export function cleanDetails(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return null;
  return Array.from(t).length > MAX_DETAILS ? 'long' : t;
}

const REVIEW_COLUMNS = 'id,restaurant_id,taster_id,dish_id,created_at,flavor,worth_every_bite,signature_style,hospitality,atmosphere_vibe,dish_comment,restaurant_comment,hidden_at,hidden_reason';

export async function moderation(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (action === 'mod_seen') return seen(res, tasterId);
  if (action === 'mod_mine') return mine(res, tasterId);
  const writes = action === 'mod_hide' || action === 'mod_show' || action === 'mod_switch';
  if (!(await allow(writes ? hideLimiter : readLimiter, keyFor(tasterId), { failOpen: !writes }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  if (action === 'mod_switch') return setSwitch(res, tasterId, who, body);
  if (!(await canModerateAt(tasterId, who.rid, who.level))) return res.status(403).json({ error: NOT_YOURS });
  if (action === 'mod_hide') return hide(res, tasterId, who, body);
  if (action === 'mod_show') return show(res, tasterId, who, body);
  if (action === 'mod_log') return log(res, who, body);
  return res.status(400).json({ error: 'Unknown action.' });
}

function idsOf(body) {
  const raw = Array.isArray(body.reviewIds) ? body.reviewIds : [body.reviewId];
  const ids = [...new Set(raw.map(Number))];
  if (!ids.length || ids.length > MAX_AT_ONCE || !ids.every((x) => Number.isInteger(x) && x > 0)) return null;
  return ids;
}

async function readRows(rid, ids) {
  let got = await sb(`/reviews?id=in.(${ids.join(',')})&select=${REVIEW_COLUMNS},deleted_at`);       // r53c: deleted by its author
  if (!got.ok && got.status === 400) got = await sb(`/reviews?id=in.(${ids.join(',')})&select=${REVIEW_COLUMNS}`);   // before migration 38
  if (!got.ok) return { status: got.status === 400 ? 409 : 502, error: got.status === 400 ? NOT_READY : 'Could not read that review. Please try again.' };
  const rows = Array.isArray(got.data) ? got.data : [];
  if (rows.length !== ids.length || rows.some((r) => Number(r.restaurant_id) !== rid)) return { status: 404, error: 'That review is not there any more.' };
  if (rows.some((r) => r.deleted_at)) return { status: 404, error: 'The author deleted that review.' };
  return { rows };
}

async function dishNames(ids) {
  const want = [...new Set(ids.map(Number).filter(Boolean))];
  if (!want.length) return {};
  const got = await sb(`/dishes?id=in.(${want.join(',')})&select=id,name`);
  const out = {};
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((d) => { out[d.id] = d.name || 'a dish'; });
  return out;
}
const listWords = (names) => names.length <= 1 ? (names[0] || 'a dish') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

async function timezoneOf(rid) {
  const loaded = await loadBooking(rid).catch(() => null);
  return (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';
}

async function hide(res, tasterId, who, body) {
  const sw = await switchOf(who.rid);
  if (!sw.ready) return res.status(409).json({ error: NOT_READY });
  if (!sw.on) return res.status(403).json({ error: OFF });
  const reason = String(body.reason || '');
  if (!LABEL[reason]) return res.status(400).json({ error: 'Choose why you are hiding this review.' });
  const details = cleanDetails(body.details);
  if (!details) return res.status(400).json({ error: 'Write the details first.' });
  if (details === 'long') return res.status(400).json({ error: 'The details are 1,000 characters at most.' });
  const alert = reason === 'illegal';
  const ids = idsOf(body);
  if (!ids) return res.status(400).json({ error: 'Which review?' });
  const found = await readRows(who.rid, ids);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const rows = found.rows;
  if (new Set(rows.map((r) => String(r.taster_id))).size > 1) return res.status(400).json({ error: 'Those reviews are by different people. Hide them one at a time.' });
  if (rows.some((r) => r.hidden_at)) return res.status(409).json({ error: rows.length > 1 ? 'One of those reviews is already hidden.' : 'That review is already hidden.' });

  const at = new Date().toISOString();
  const saved = await sb(`/reviews?id=in.(${ids.join(',')})&restaurant_id=eq.${who.rid}&hidden_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ hidden_at: at, hidden_reason: reason }),
  });
  if (!saved.ok) return res.status(saved.status === 400 ? 409 : 502).json({ error: saved.status === 400 ? NOT_READY : 'Could not hide that review (the database answered ' + saved.status + '). Please try again.' });
  const done = (Array.isArray(saved.data) ? saved.data : []).map((r) => Number(r.id));
  if (!done.length) return res.status(409).json({ error: 'That review is already hidden.' });
  const timezone = await timezoneOf(who.rid);
  const dots = await visitDots(who.rid, rows, timezone);
  const byName = who.firstName || 'The restaurant';
  const logged = await sb('/review_moderation_log', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(rows.filter((r) => done.includes(Number(r.id))).map((r) => ({
      review_id: r.id, restaurant_id: who.rid, action: 'hide', reason, details, alerted: alert,
      stars: [r.flavor, r.worth_every_bite, r.signature_style, r.hospitality, r.atmosphere_vibe],
      words: { dish: r.dish_comment || null, restaurant: r.restaurant_comment || null },
      visit: dots[r.id] ? dots[r.id].dot : null, author_id: r.taster_id, review_at: r.created_at, by_id: tasterId, by_name: byName,
    }))),
  });
  if (!logged.ok) {
    // A hide without its record must not stay: show it again and say so.
    await sb(`/reviews?id=in.(${done.join(',')})&hidden_at=eq.${encodeURIComponent(at)}`, { method: 'PATCH', body: JSON.stringify({ hidden_at: null, hidden_reason: null }) });
    console.error('[moderation] log failed, hide undone', who.rid, logged.status);
    return res.status(502).json({ error: 'Could not keep the record of this, so nothing was hidden (the database answered ' + logged.status + '). Please try again.' });
  }
  const author = Number(rows[0].taster_id);
  await sb('/review_notices', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(done.map((id) => ({ taster_id: author, review_id: id, restaurant_id: who.rid, kind: 'hidden', reason: reasonForAuthor(reason, details) }))),
  }).catch(() => null);
  const names = await dishNames(rows.map((r) => r.dish_id));
  const dishes = listWords([...new Set(rows.filter((r) => done.includes(Number(r.id))).map((r) => names[r.dish_id] || 'a dish'))]);
  console.log('[moderation] taster', tasterId, 'hid', done.join(','), 'at', who.rid, 'reason', reason, alert ? '(Seb\'s Analytics told)' : '');
  await tellChange(who.rid, tasterId, `hid ${done.length > 1 ? done.length + ' reviews' : 'a review'} of ${dishes} · Reason: ${LABEL[reason]}`, { go: 'reviews' });
  let alerted = false;
  if (alert) {
    alerted = await alertPlatform(who.rid, tasterId, who.firstName,
      `Alert (Moderate review): ${byName} hid ${done.length > 1 ? done.length + ' reviews' : 'a review'} of ${dishes} `
      + `(review ${done.map((x) => '#' + x).join(', ')}) as "Illegal or dangerous content". If a child could be at risk, US law `
      + `(18 U.S.C. 2258A) requires Fork's Rating to report it. Details: ${details}`);
  }
  return res.status(200).json({ success: true, hidden: done, reason, at, ...(alert ? { alerted } : {}) });
}

async function show(res, tasterId, who, body) {
  const ids = idsOf(body);
  if (!ids) return res.status(400).json({ error: 'Which review?' });
  const found = await readRows(who.rid, ids);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const rows = found.rows;
  if (rows.some((r) => isTeam(r.hidden_reason))) return res.status(409).json({ error: "The team rule hides this one (a rating by the restaurant's owner or manager). It can't be shown." });
  if (rows.some((r) => !r.hidden_at)) return res.status(409).json({ error: 'That review is already shown.' });
  const saved = await sb(`/reviews?id=in.(${ids.join(',')})&restaurant_id=eq.${who.rid}&hidden_at=not.is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ hidden_at: null, hidden_reason: null }),
  });
  if (!saved.ok) return res.status(502).json({ error: 'Could not show that review again (the database answered ' + saved.status + '). Please try again.' });
  const done = (Array.isArray(saved.data) ? saved.data : []).map((r) => Number(r.id));
  const byName = who.firstName || 'The restaurant';
  const kept = rows.filter((r) => done.includes(Number(r.id)));
  if (kept.length) {
    const logged = await sb('/review_moderation_log', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(kept.map((r) => ({
        review_id: r.id, restaurant_id: who.rid, action: 'show', reason: r.hidden_reason,
        stars: [r.flavor, r.worth_every_bite, r.signature_style, r.hospitality, r.atmosphere_vibe],
        author_id: r.taster_id, review_at: r.created_at, by_id: tasterId, by_name: byName,
      }))),
    });
    if (!logged.ok) console.error('[moderation] show not logged', who.rid, logged.status);
    await sb('/review_notices', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(kept.map((r) => ({ taster_id: r.taster_id, review_id: r.id, restaurant_id: who.rid, kind: 'shown' }))),
    }).catch(() => null);
    // The bell's "hid your review" for these is answered: it is shown again.
    await sb(`/review_notices?review_id=in.(${done.join(',')})&kind=eq.hidden&read_at=is.null`, { method: 'PATCH', body: JSON.stringify({ read_at: new Date().toISOString() }) }).catch(() => null);
    // r53c: the author's conversation about it closes (it can still be read). Nothing before migration 38.
    await sb(`/review_threads?review_id=in.(${done.join(',')})&closed_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ closed_at: new Date().toISOString(), closed_reason: 'shown', closed_by: null }),
    }).catch(() => null);
    const names = await dishNames(kept.map((r) => r.dish_id));
    await tellChange(who.rid, tasterId, `showed ${kept.length > 1 ? kept.length + ' reviews' : 'a review'} of ${listWords([...new Set(kept.map((r) => names[r.dish_id] || 'a dish'))])} again`, { go: 'reviews' });
  }
  console.log('[moderation] taster', tasterId, 'showed', done.join(','), 'at', who.rid);
  return res.status(200).json({ success: true, shown: done });
}

async function log(res, who, body) {
  const one = Number(body.reviewId);
  const filter = Number.isInteger(one) && one > 0 ? `&review_id=eq.${one}` : '';
  const got = await sb(`/review_moderation_log?restaurant_id=eq.${who.rid}${filter}&select=id,review_id,action,reason,details,alerted,stars,words,visit,review_at,by_name,at&order=id.desc&limit=300`);
  if (!got.ok) return res.status(got.status === 404 ? 409 : 502).json({ error: got.status === 404 ? NOT_READY : 'Could not read the log. Please try again.' });
  const rows = Array.isArray(got.data) ? got.data : [];
  const reviews = rows.length ? await sb(`/reviews?id=in.(${[...new Set(rows.map((r) => Number(r.review_id)))].join(',')})&select=id,dish_id`) : { ok: true, data: [] };
  const dishOf = {};
  (reviews.ok && Array.isArray(reviews.data) ? reviews.data : []).forEach((r) => { dishOf[r.id] = r.dish_id; });
  const names = await dishNames(Object.values(dishOf));
  return res.status(200).json({
    success: true,
    entries: rows.map((r) => ({
      id: r.id, review: r.review_id, action: r.action, reason: r.reason, label: r.reason ? reasonLabel(r.reason) : null,
      details: r.details || null, alerted: !!r.alerted, stars: r.stars || null, words: r.words || null,
      visit: r.visit || null, reviewAt: r.review_at || null, by: r.by_name || null, at: r.at, dish: names[dishOf[r.review_id]] || null,
    })),
  });
}

async function setSwitch(res, tasterId, who, body) {
  if (who.level < LEVEL.platform) return res.status(403).json({ error: "Only Seb's Analytics switches moderation on or off (after the restaurant signs the Review and Data Addendum)." });
  if (typeof body.on !== 'boolean') return res.status(400).json({ error: 'On or off?' });
  const before = await switchOf(who.rid);
  if (!before.ready) return res.status(409).json({ error: NOT_READY });
  const saved = await sb(`/restaurants?id=eq.${who.rid}`, {
    method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ moderation_on: body.on, moderation_at: new Date().toISOString(), moderation_by: tasterId }),
  });
  if (!saved.ok) return res.status(502).json({ error: 'Could not save that (the database answered ' + saved.status + ').' });
  if (before.on !== body.on) {
    await tellChange(who.rid, tasterId, body.on ? 'switched moderation on (the Review and Data Addendum is signed)' : 'switched moderation off', { go: 'reviews' });
  }
  console.log('[moderation] taster', tasterId, 'switched moderation', body.on ? 'on' : 'off', 'at', who.rid);
  return res.status(200).json({ success: true, moderation: await switchOf(who.rid) });
}

async function seen(res, tasterId) {
  if (!(await allow(guestLimiter, keyFor('g' + tasterId), { failOpen: true }))) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  const got = await sb(`/review_notices?taster_id=eq.${tasterId}&read_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ read_at: new Date().toISOString() }) });
  return res.status(200).json({ success: true, read: got.ok && Array.isArray(got.data) ? got.data.length : 0 });
}

// The author's own hidden reviews, with the reason in the words they were told (for "Other", the restaurant's own
// explanation): My Tastings and the menu show it on the review, with Contact the restaurant.
async function mine(res, tasterId) {
  if (!(await allow(guestLimiter, keyFor('g' + tasterId), { failOpen: true }))) return res.status(429).json({ error: 'Too many requests. Wait a moment.' });
  const ask = (extra) => sb(`/reviews?taster_id=eq.${tasterId}&hidden_at=not.is.null${extra}&select=id,restaurant_id,dish_id,hidden_at,hidden_reason&order=id.desc&limit=500`);
  let got = await ask('&deleted_at=is.null');                          // r53c: a review its author deleted is gone
  if (!got.ok && got.status === 400) got = await ask('');             // before migration 38
  if (!got.ok) return res.status(200).json({ success: true, ready: false, reviews: [] });      // before migration 37
  const rows = Array.isArray(got.data) ? got.data : [];
  const told = {};
  if (rows.length) {
    const n = await sb(`/review_notices?taster_id=eq.${tasterId}&kind=eq.hidden&review_id=in.(${rows.map((r) => Number(r.id)).join(',')})&select=review_id,reason&order=id.desc`);
    (n.ok && Array.isArray(n.data) ? n.data : []).forEach((x) => { if (!told[x.review_id]) told[x.review_id] = x.reason; });
  }
  return res.status(200).json({
    success: true, ready: true,
    reviews: rows.map((r) => ({ id: r.id, restaurant: r.restaurant_id, dish: r.dish_id, at: r.hidden_at, team: isTeam(r.hidden_reason),
                                reason: told[r.id] || reasonForAuthor(r.hidden_reason, '') })),
  });
}

// The bell (api/_lib/messages.js inbox): the author's notices not read yet. [] before migration 37.
export async function reviewBell(tasterId) {
  const got = await sb(`/review_notices?taster_id=eq.${Number(tasterId)}&read_at=is.null&select=id,review_id,restaurant_id,kind,reason,created_at&order=id.desc&limit=20`);
  if (!got.ok || !Array.isArray(got.data) || !got.data.length) return [];
  const rows = got.data;
  const [reviews, places] = await Promise.all([
    sb(`/reviews?id=in.(${[...new Set(rows.map((r) => Number(r.review_id)))].join(',')})&select=id,dish_id`),
    sb(`/restaurants?id=in.(${[...new Set(rows.map((r) => Number(r.restaurant_id)))].join(',')})&select=id,name`),
  ]);
  const dishOf = {};
  (reviews.ok && Array.isArray(reviews.data) ? reviews.data : []).forEach((r) => { dishOf[r.id] = r.dish_id; });
  const names = await dishNames(Object.values(dishOf));
  const placeName = {};
  (places.ok && Array.isArray(places.data) ? places.data : []).forEach((p) => { placeName[p.id] = p.name; });
  return rows.map((r) => ({
    reviewNotice: Number(r.id), kind: r.kind, review: Number(r.review_id), at: new Date(r.created_at).toISOString(), label: whenLabel('America/New_York', r.created_at),
    restaurant: placeName[r.restaurant_id] || 'The restaurant', dish: names[dishOf[r.review_id]] || 'a dish',
    reason: r.kind === 'hidden' ? (r.reason || null) : null,
  }));
}
