// api/_lib/loyalty.js
//
// r31 (Sebastian, 13 Oct): Lucky Bite, the stamp card and invites. Every one of
// them is the restaurant's offer: Seb's Analytics and Fork's Rating give
// nothing away and pay for nothing (Sebastian, 13 Oct) — the site is only the
// way a restaurant runs its own rewards. The counting itself
// lives in the database (migration 21): a dish rated by someone with a scanned
// visit that day gets the next number, and every Nth number is free; a scanned
// visit puts a stamp on the card, and a full card is a reward. Nothing here can
// hand anyone a number or a prize. This file only READS what the database
// decided, lets a manager choose the rules, and turns a prize into "used".
//
// Reached through api/checkins.js (the guest: My Visits, after a rating, the
// prize's QR), api/checkin-confirm.js (staff: give a prize) and
// api/_lib/staff.js (Settings, and a reservation's QR scanned at the door
// counting as a visit). No new function: Vercel's free plan stops at twelve.

import crypto from 'crypto';
import { sb } from './roles.js';
import { newYorkDate } from './checkin.js';

// What a manager may choose. The database checks the same numbers.
export const LIMITS = {
  luckyEvery:  [2, 100000],
  stampsEvery: [2, 100],
  rewardDays:  [1, 365],
  rewardText:  80,
  inviteDays:  [1, 30],
};
export const DEFAULTS = { luckyEvery: 100, stampsEvery: 10, rewardDays: 60, maxPerVisit: 3, inviteDays: 7 };

// The restaurant's day starts at 5 AM (New York), like the reservations': a
// dish rated at 12:30 AM belongs to the dinner that started at 9.
export function serviceDay(now = Date.now()) {
  return newYorkDate(new Date(now - 5 * 3600 * 1000));
}
// The days a visit can be on and still count now: today, and between midnight
// and 5 AM also last night. The database uses exactly this rule.
export function visitDays(now = Date.now()) {
  return [...new Set([newYorkDate(new Date(now)), serviceDay(now)])];
}

// Before migration 21 the tables are not there: PostgREST answers 404 for a
// missing table and 400 for a missing column. Either way: "not set up yet".
export function notReady(r) {
  return !!r && !r.ok && (r.status === 404 || r.status === 400);
}

export function nextLucky(count, every) {
  const c = Number(count) || 0, e = Number(every) || DEFAULTS.luckyEvery;
  const nextAt = (Math.floor(c / e) + 1) * e;
  return { nextAt, toGo: nextAt - c };
}

export function rewardStatus(r, now = Date.now()) {
  if (r.redeemed_at) return 'used';
  return new Date(r.expires_at).getTime() <= now ? 'expired' : 'ready';
}

export function rewardTitle(r) {
  return r.kind === 'lucky' ? (r.dish_name || 'A dish') + ', free' : (r.reward_text || 'A reward');
}

export function rewardOut(r, names = {}) {
  return {
    id: r.id,
    restaurantId: r.restaurant_id,
    restaurant: names[r.restaurant_id] || names[String(r.restaurant_id)] || 'The restaurant',
    kind: r.kind,
    title: rewardTitle(r),
    luckyNumber: r.lucky_number != null ? Number(r.lucky_number) : null,
    visits: r.visits != null ? Number(r.visits) : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    redeemedAt: r.redeemed_at || null,
    status: rewardStatus(r),
  };
}

const SETTINGS_COLUMNS = 'restaurant_id,lucky_on,lucky_every,lucky_count,max_per_visit,stamps_on,stamps_every,stamps_reward,reward_days,'
                       + 'invite_on,invite_discount,invite_days';
export const PASS_COLUMNS = 'id,restaurant_id,from_taster_id,code,discount_text,made_day,created_at,expires_at,claimed_by,claimed_at,redeemed_at,redeemed_by_name';

// ── INVITES ───────────────────────────────────────────────────────────────────
// Eight characters a friend can read out or type: no O/0, I/1, S/5.
const PASS_ALPHABET = '23456789ABCDEFGHJKLMNPQRTUVWXYZ';
export function makePassCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += PASS_ALPHABET[bytes[i] % PASS_ALPHABET.length];
  return out;
}
export function cleanPassCode(input) {
  const c = String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{8}$/.test(c) ? c : null;
}
function addDay(date, n) {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Saved by a friend, used, run out, or still waiting to be shared.
export function passStatus(p, now = Date.now()) {
  if (p.redeemed_at) return 'used';
  if (new Date(p.expires_at).getTime() <= now) return 'expired';
  // claimed_at stays when the friend's account is deleted (claimed_by goes to
  // null with it): the invite was saved, and it does not become free again.
  return p.claimed_by || p.claimed_at ? 'saved' : 'open';
}
// What a person sees of an invite. The code goes only to the person who was
// given it and the friend who saved it; the friend's name never goes back.
export function passOut(p, names = {}, viewer = null) {
  const mine = viewer != null && Number(p.from_taster_id) === Number(viewer) ? 'given'
             : viewer != null && Number(p.claimed_by) === Number(viewer) ? 'received' : null;
  const usableFrom = addDay(p.made_day, 1);
  return {
    id: p.id, restaurantId: p.restaurant_id,
    restaurant: names[p.restaurant_id] || names[String(p.restaurant_id)] || 'The restaurant',
    discount: p.discount_text, usableFrom, expiresAt: p.expires_at, status: passStatus(p),
    usableToday: serviceDay() >= usableFrom, mine,
    code: mine ? p.code : undefined,
    redeemedAt: p.redeemed_at || null,
  };
}

// A scanned visit gives one invite, when the restaurant has invites on. Made
// here (not in the database) because the code is drawn with crypto. Never
// stops the visit itself.
export async function passForVisit(checkInId, tasterId, restaurantId) {
  try {
    const s = await sb(`/loyalty_settings?restaurant_id=eq.${Number(restaurantId)}&select=${SETTINGS_COLUMNS}&limit=1`);
    if (!s.ok || !Array.isArray(s.data) || !s.data.length) return null;
    const set = s.data[0];
    if (!set.invite_on || !set.invite_discount) return null;
    const role = await sb(`/restaurant_roles?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${Number(restaurantId)}&select=id&limit=1`);
    if (!role.ok || (Array.isArray(role.data) && role.data.length)) return null;      // staff do not invite from their own restaurant
    const days = Number(set.invite_days) || DEFAULTS.inviteDays;
    for (let attempt = 0; attempt < 3; attempt++) {
      const made = await sb('/loyalty_passes', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          restaurant_id: Number(restaurantId), from_taster_id: Number(tasterId), check_in_id: Number(checkInId),
          code: makePassCode(), discount_text: set.invite_discount, made_day: serviceDay(),
          expires_at: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
        }),
      });
      if (made.ok && Array.isArray(made.data) && made.data.length) return made.data[0];
      const why = JSON.stringify(made.data || '');
      if (/check_in_id/.test(why)) return null;                // this visit already has one
      if (!(made.status === 409 && /code/.test(why))) { console.error('[loyalty:pass] not made', made.status, why.slice(0, 160)); return null; }
    }
    return null;
  } catch (e) {
    console.error('[loyalty:pass] failed', e && e.message);
    return null;
  }
}

async function passByCode(code) {
  const c = cleanPassCode(code);
  if (!c) throw Object.assign(new Error('That invite code is eight letters and numbers.'), { status: 400 });
  const got = await sb(`/loyalty_passes?code=eq.${c}&select=${PASS_COLUMNS}&limit=1`);
  if (notReady(got)) throw Object.assign(new Error('Invites are not set up yet.'), { status: 404 });
  if (!got.ok) throw Object.assign(new Error('Could not read that invite.'), { status: 502 });
  const p = Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!p) throw Object.assign(new Error('That invite code does not exist. Check it with the friend who sent it.'), { status: 404 });
  return p;
}

// The invite page, before anyone logs in: who, where, what, until when.
export async function previewPass(code) {
  const p = await passByCode(code);
  const [names, from] = await Promise.all([
    namesOf([p.restaurant_id]),
    sb(`/tasters?id=eq.${Number(p.from_taster_id)}&select=first_name,last_name&limit=1`),
  ]);
  const f = from.ok && Array.isArray(from.data) && from.data.length ? from.data[0] : {};
  const fromName = [f.first_name, f.last_name ? f.last_name.trim().charAt(0) + '.' : ''].filter(Boolean).join(' ') || 'A friend';
  return { ...passOut(p, names), from: fromName, saved: !!(p.claimed_by || p.claimed_at) };
}

// The friend saves it to their account. Once saved it is theirs: nobody else
// can save it, and the person who was given it cannot use it.
export async function claimPass(tasterId, code) {
  const p = await passByCode(code);
  const me = Number(tasterId);
  if (Number(p.from_taster_id) === me) throw Object.assign(new Error('This is your own invite: send it to a friend.'), { status: 409 });
  const st = passStatus(p);
  if (st === 'used') throw Object.assign(new Error('This invite was already used.'), { status: 409 });
  if (st === 'expired') throw Object.assign(new Error('This invite has run out.'), { status: 410 });
  if ((p.claimed_by && Number(p.claimed_by) !== me) || (!p.claimed_by && p.claimed_at)) {
    throw Object.assign(new Error('Someone else already saved this invite.'), { status: 409 });
  }
  if (!p.claimed_by) {
    const saved = await sb(`/loyalty_passes?id=eq.${Number(p.id)}&claimed_by=is.null&claimed_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ claimed_by: me, claimed_at: new Date().toISOString() }),
    });
    if (!saved.ok) throw Object.assign(new Error('Could not save that invite.'), { status: 502 });
    if (!Array.isArray(saved.data) || !saved.data.length) throw Object.assign(new Error('Someone else saved this invite a moment ago.'), { status: 409 });
    Object.assign(p, saved.data[0]);
  }
  return passOut(p, await namesOf([p.restaurant_id]), me);
}

// One invite the friend has saved, good today, for its 90-second QR.
export async function passForGuest(tasterId, passId) {
  const id = Number(passId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Which invite?'), { status: 400 });
  const got = await sb(`/loyalty_passes?id=eq.${id}&select=${PASS_COLUMNS}&limit=1`);
  if (notReady(got)) throw Object.assign(new Error('Invites are not set up yet.'), { status: 404 });
  const p = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!p || Number(p.claimed_by) !== Number(tasterId)) throw Object.assign(new Error('That invite is not yours.'), { status: 404 });
  const st = passStatus(p);
  if (st === 'used') throw Object.assign(new Error('This invite was already used.'), { status: 409 });
  if (st === 'expired') throw Object.assign(new Error('This invite has run out.'), { status: 410 });
  if (serviceDay() < addDay(p.made_day, 1)) throw Object.assign(new Error('This invite works from tomorrow.'), { status: 409 });
  return p;
}
export const REWARD_COLUMNS = 'id,restaurant_id,taster_id,kind,dish_name,reward_text,lucky_number,visits,created_at,expires_at,redeemed_at,redeemed_by_name';

async function namesOf(ids) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return {};
  const got = await sb(`/restaurants?id=in.(${list.join(',')})&select=id,name`);
  const out = {};
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((r) => { out[r.id] = r.name; });
  return out;
}

function programOut(s, name, mine) {
  const invite = s.invite_on && s.invite_discount ? { discount: s.invite_discount, days: Number(s.invite_days) || DEFAULTS.inviteDays } : null;
  const lucky = s.lucky_on ? {
    every: Number(s.lucky_every), counted: Number(s.lucky_count), maxPerVisit: Number(s.max_per_visit || DEFAULTS.maxPerVisit),
    ...nextLucky(s.lucky_count, s.lucky_every),
    today: mine.todayNumbers[s.restaurant_id] || [],
  } : null;
  const stamps = s.stamps_on && s.stamps_reward ? {
    every: Number(s.stamps_every), reward: s.stamps_reward, have: Math.min(mine.stamps[s.restaurant_id] || 0, Number(s.stamps_every)),
  } : null;
  return {
    restaurantId: s.restaurant_id, restaurant: name || 'The restaurant',
    visitedToday: !!mine.visitedToday[s.restaurant_id], lucky, stamps, invite, rewardDays: Number(s.reward_days),
  };
}

// ── THE GUEST: My Visits ──────────────────────────────────────────────────────
// Their prizes (newest first), and the programs of the restaurants they go to.
// A guest who has been nowhere yet sees the programs that are on, so they learn
// what a check-in is worth.
export async function guestLoyalty(tasterId) {
  const id = Number(tasterId);
  const [rewards, stamps, settings, visits, today, given, received] = await Promise.all([
    sb(`/loyalty_rewards?taster_id=eq.${id}&select=${REWARD_COLUMNS}&order=created_at.desc&limit=60`),
    sb(`/loyalty_stamps?taster_id=eq.${id}&reward_id=is.null&select=restaurant_id&limit=2000`),
    sb(`/loyalty_settings?or=(lucky_on.eq.true,stamps_on.eq.true)&select=${SETTINGS_COLUMNS}&limit=60`),
    sb(`/check_ins?taster_id=eq.${id}&select=restaurant_id,visit_date&order=visit_date.desc&limit=2000`),
    sb(`/loyalty_ratings?taster_id=eq.${id}&visit_day=eq.${serviceDay()}&select=restaurant_id,number&order=number.asc`),
    sb(`/loyalty_passes?from_taster_id=eq.${id}&select=${PASS_COLUMNS}&order=created_at.desc&limit=20`),
    sb(`/loyalty_passes?claimed_by=eq.${id}&select=${PASS_COLUMNS}&order=created_at.desc&limit=20`),
  ]);
  if ([rewards, stamps, settings, today, given, received].some(notReady)) return { ready: false };
  if (![rewards, stamps, settings, today].every((r) => r.ok && Array.isArray(r.data))) {
    const bad = [rewards, stamps, settings, today].find((r) => !r.ok);
    throw Object.assign(new Error('Could not read your rewards (the database answered ' + (bad ? bad.status : '?') + ').'), { status: 502 });
  }
  const days = visitDays();
  const visited = new Set(), visitedToday = {};
  (visits.ok && Array.isArray(visits.data) ? visits.data : []).forEach((v) => {
    visited.add(Number(v.restaurant_id));
    if (days.includes(v.visit_date)) visitedToday[v.restaurant_id] = true;
  });
  const mine = { stamps: {}, todayNumbers: {}, visitedToday };
  stamps.data.forEach((s) => { mine.stamps[s.restaurant_id] = (mine.stamps[s.restaurant_id] || 0) + 1; });
  today.data.forEach((t) => { (mine.todayNumbers[t.restaurant_id] = mine.todayNumbers[t.restaurant_id] || []).push(Number(t.number)); });

  let on = settings.data;
  const theirs = on.filter((s) => visited.has(Number(s.restaurant_id)) || mine.stamps[s.restaurant_id]);
  on = (theirs.length ? theirs : on).slice(0, 6);
  const gave = given.ok && Array.isArray(given.data) ? given.data : [];
  const got = received.ok && Array.isArray(received.data) ? received.data : [];
  const names = await namesOf([...on.map((s) => s.restaurant_id), ...rewards.data.map((r) => r.restaurant_id),
                               ...gave.map((p) => p.restaurant_id), ...got.map((p) => p.restaurant_id)]);
  return {
    ready: true,
    programs: on.map((s) => programOut(s, names[s.restaurant_id], mine)),
    rewards: rewards.data.map((r) => rewardOut(r, names)),
    // Invites to share: the ones nobody has saved yet and that still work,
    // then the ones a friend saved (without saying who) and the used ones.
    invitesGiven: gave.map((p) => passOut(p, names, id)).filter((p) => p.status !== 'expired'),
    invitesReceived: got.map((p) => passOut(p, names, id)),
  };
}

// ── THE GUEST: "did that rating count?" ──────────────────────────────────────
// Asked by the menu right after a rating is saved. The answer comes from what
// the database already did; asking cannot change it.
export async function afterRating(tasterId, reviewId) {
  const rid = Number(reviewId);
  if (!Number.isInteger(rid) || rid < 1) throw Object.assign(new Error('Which rating?'), { status: 400 });
  const review = await sb(`/reviews?id=eq.${rid}&select=id,taster_id,restaurant_id,dish_id&limit=1`);
  if (!review.ok) throw Object.assign(new Error('Could not read that rating.'), { status: 502 });
  const row = Array.isArray(review.data) && review.data.length ? review.data[0] : null;
  // Somebody else's rating and no rating at all get the same answer.
  if (!row || Number(row.taster_id) !== Number(tasterId)) throw Object.assign(new Error('That rating is not yours.'), { status: 404 });

  const s = await sb(`/loyalty_settings?restaurant_id=eq.${row.restaurant_id}&select=${SETTINGS_COLUMNS}&limit=1`);
  if (notReady(s)) return { ready: false };
  const set = s.ok && Array.isArray(s.data) && s.data.length ? s.data[0] : null;
  if (!set || !set.lucky_on) return { ready: true, lucky: { on: false } };
  const every = Number(set.lucky_every);
  const base = { on: true, every, maxPerVisit: Number(set.max_per_visit || DEFAULTS.maxPerVisit), ...nextLucky(set.lucky_count, every) };

  const counted = await sb(`/loyalty_ratings?review_id=eq.${rid}&visit_day=eq.${serviceDay()}&select=id,number&order=id.desc&limit=1`);
  const hit = counted.ok && Array.isArray(counted.data) && counted.data.length ? counted.data[0] : null;
  if (hit) {
    const won = await sb(`/loyalty_rewards?rating_id=eq.${hit.id}&select=${REWARD_COLUMNS}&limit=1`);
    const prize = won.ok && Array.isArray(won.data) && won.data.length ? won.data[0] : null;
    const names = prize ? await namesOf([prize.restaurant_id]) : {};
    return { ready: true, lucky: { ...base, counted: true, number: Number(hit.number), won: !!prize, reward: prize ? rewardOut(prize, names) : null } };
  }
  // Not counted: say why, in the order the database decides it.
  const role = await sb(`/restaurant_roles?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${row.restaurant_id}&select=id&limit=1`);
  if (role.ok && Array.isArray(role.data) && role.data.length) return { ready: true, lucky: { ...base, counted: false, reason: 'staff' } };
  const v = await sb(`/check_ins?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${row.restaurant_id}` +
                     `&visit_date=in.(${visitDays().join(',')})&select=id&limit=1`);
  const here = v.ok && Array.isArray(v.data) && v.data.length > 0;
  return { ready: true, lucky: { ...base, counted: false, reason: here ? 'limit' : 'visit' } };
}

// ── THE GUEST: one prize, theirs and still good ──────────────────────────────
export async function rewardForGuest(tasterId, rewardId) {
  const id = Number(rewardId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Which reward?'), { status: 400 });
  const got = await sb(`/loyalty_rewards?id=eq.${id}&select=${REWARD_COLUMNS}&limit=1`);
  if (notReady(got)) throw Object.assign(new Error('Rewards are not set up yet.'), { status: 404 });
  const r = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!r || Number(r.taster_id) !== Number(tasterId)) throw Object.assign(new Error('That reward is not yours.'), { status: 404 });
  const status = rewardStatus(r);
  if (status === 'used') throw Object.assign(new Error('This reward was already used.'), { status: 409 });
  if (status === 'expired') throw Object.assign(new Error('This reward has expired.'), { status: 410 });
  return r;
}

// ── STAFF: the Settings card ─────────────────────────────────────────────────
export async function staffLoyalty(restaurantId) {
  const rid = Number(restaurantId);
  const [s, recent, counts, passes] = await Promise.all([
    sb(`/loyalty_settings?restaurant_id=eq.${rid}&select=${SETTINGS_COLUMNS}&limit=1`),
    sb(`/loyalty_rewards?restaurant_id=eq.${rid}&select=${REWARD_COLUMNS}&order=created_at.desc&limit=8`),
    sb(`/loyalty_rewards?restaurant_id=eq.${rid}&select=redeemed_at,expires_at&limit=5000`),
    sb(`/loyalty_passes?restaurant_id=eq.${rid}&select=claimed_by,redeemed_at,expires_at&limit=5000`),
  ]);
  if ([s, recent, counts, passes].some(notReady)) return { ready: false };
  if (![s, recent, counts, passes].every((r) => r.ok && Array.isArray(r.data))) return { ready: false, error: 'Could not read the rewards.' };
  const row = s.data[0] || null;
  const luckyEvery = row ? Number(row.lucky_every) : DEFAULTS.luckyEvery;
  const luckyCount = row ? Number(row.lucky_count) : 0;
  const stats = { waiting: 0, given: 0, expired: 0 };
  counts.data.forEach((r) => { const st = rewardStatus(r); stats[st === 'ready' ? 'waiting' : st === 'used' ? 'given' : 'expired'] += 1; });
  const invites = { made: passes.data.length, saved: passes.data.filter((p) => p.claimed_by).length, used: passes.data.filter((p) => p.redeemed_at).length };
  const ids = recent.data.map((r) => r.taster_id);
  const people = {};
  if (ids.length) {
    const got = await sb(`/tasters?id=in.(${[...new Set(ids)].join(',')})&select=id,first_name,last_name,username`);
    (got.ok && Array.isArray(got.data) ? got.data : []).forEach((t) => {
      people[t.id] = { name: [t.first_name, t.last_name].filter(Boolean).join(' ') || 'A guest', handle: t.username || null };
    });
  }
  return {
    ready: true,
    luckyOn: !!(row && row.lucky_on), luckyEvery, luckyCount, ...nextLucky(luckyCount, luckyEvery),
    maxPerVisit: row ? Number(row.max_per_visit) : DEFAULTS.maxPerVisit,
    stampsOn: !!(row && row.stamps_on), stampsEvery: row ? Number(row.stamps_every) : DEFAULTS.stampsEvery,
    stampsReward: row ? row.stamps_reward || '' : '',
    rewardDays: row ? Number(row.reward_days) : DEFAULTS.rewardDays,
    inviteOn: !!(row && row.invite_on), inviteDiscount: row ? row.invite_discount || '' : '',
    inviteDays: row ? Number(row.invite_days) : DEFAULTS.inviteDays,
    stats, invites,
    recent: recent.data.map((r) => ({ ...rewardOut(r), guest: people[r.taster_id] || { name: 'A guest', handle: null },
                                      givenBy: r.redeemed_by_name || null })),
  };
}

// What a manager sent, checked. Returns { row } or { error }.
export function cleanLoyalty(input) {
  const x = input && typeof input === 'object' ? input : {};
  const int = (v) => (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v))) ? Number(v) : NaN;
  const within = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
  const luckyEvery = int(x.luckyEvery), stampsEvery = int(x.stampsEvery), rewardDays = int(x.rewardDays), inviteDays = int(x.inviteDays);
  if (!within(luckyEvery, LIMITS.luckyEvery)) return { error: `Lucky Bite: a number from ${LIMITS.luckyEvery[0]} to ${LIMITS.luckyEvery[1].toLocaleString('en-US')}.` };
  if (!within(stampsEvery, LIMITS.stampsEvery)) return { error: `Stamp card: from ${LIMITS.stampsEvery[0]} to ${LIMITS.stampsEvery[1]} visits.` };
  if (!within(rewardDays, LIMITS.rewardDays)) return { error: `A reward lasts from ${LIMITS.rewardDays[0]} to ${LIMITS.rewardDays[1]} days.` };
  if (!within(inviteDays, LIMITS.inviteDays)) return { error: `An invite lasts from ${LIMITS.inviteDays[0]} to ${LIMITS.inviteDays[1]} days.` };
  const words = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const text = words(x.stampsReward), discount = words(x.inviteDiscount);
  if (text.length > LIMITS.rewardText) return { error: `The reward is ${LIMITS.rewardText} characters at most.` };
  if (discount.length > LIMITS.rewardText) return { error: `The discount is ${LIMITS.rewardText} characters at most.` };
  if (/[<>]/.test(text + discount)) return { error: 'The words cannot contain < or >.' };
  const stampsOn = x.stampsOn === true, inviteOn = x.inviteOn === true;
  if (stampsOn && !text) return { error: 'Write the reward for a full card, for example "A free dessert".' };
  if (inviteOn && !discount) return { error: 'Write the discount for a friend, for example "10% off your meal".' };
  return { row: {
    lucky_on: x.luckyOn === true, lucky_every: luckyEvery,
    stamps_on: stampsOn, stamps_every: stampsEvery, stamps_reward: text || null,
    reward_days: rewardDays,
    invite_on: inviteOn, invite_discount: discount || null, invite_days: inviteDays,
  } };
}

// ── STAFF: a reservation's QR scanned at the door is a visit (Sebastian, 13 Oct)
// The guest's account is the one that booked, or the account on the table's
// phone number. No account, or the scanner's own table: nothing to count.
// Never stops the arrival itself.
export async function visitFromTable(row, staffId, staffName) {
  try {
    let guest = row.taster_id ? Number(row.taster_id) : null;
    if (!guest && row.guest_phone) {
      const acc = await sb(`/tasters?phone_number=eq.${encodeURIComponent(row.guest_phone)}&select=id&limit=1`);
      guest = acc.ok && Array.isArray(acc.data) && acc.data.length ? Number(acc.data[0].id) : null;
    }
    if (!guest || guest === Number(staffId)) return { recorded: false, account: !!guest };
    const body = { taster_id: guest, restaurant_id: row.restaurant_id, confirmed_by: Number(staffId),
                   confirmed_by_name: staffName || null, reservation_id: row.id };
    let saved = await sb('/check_ins', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
    if (!saved.ok && saved.status === 400 && /reservation_id/.test(JSON.stringify(saved.data || ''))) {
      delete body.reservation_id;          // before migration 21: the visit still counts on the calendar
      saved = await sb('/check_ins', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
    }
    if (saved.ok) {
      const visit = Array.isArray(saved.data) && saved.data.length ? saved.data[0] : null;
      if (!visit) return { recorded: true, account: true };
      const [card, invite] = await Promise.all([
        cardAfterVisit(visit.id, guest, row.restaurant_id),
        passForVisit(visit.id, guest, row.restaurant_id),
      ]);
      return { recorded: true, account: true, card, invite: !!invite };
    }
    if (saved.status === 409 || (saved.data && saved.data.code === '23505')) return { recorded: false, account: true, alreadyToday: true };
    console.error('[loyalty:visit] not recorded', row.id, saved.status, saved.data && saved.data.message);
    return { recorded: false, account: true };
  } catch (e) {
    console.error('[loyalty:visit] failed', row && row.id, e && e.message);
    return { recorded: false };
  }
}

// The arrival was a mistake (Undo): the visit it made goes too, and with it its
// stamp if the card was not full yet. A prize already given stays given.
export async function undoVisitFromTable(reservationId) {
  try {
    await sb(`/check_ins?reservation_id=eq.${Number(reservationId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  } catch (e) {
    console.error('[loyalty:undo-visit] failed', reservationId, e && e.message);
  }
}

// After a visit was confirmed: the card, and the prize if this visit filled it.
export async function cardAfterVisit(checkInId, tasterId, restaurantId) {
  try {
    const [s, stamp] = await Promise.all([
      sb(`/loyalty_settings?restaurant_id=eq.${Number(restaurantId)}&select=${SETTINGS_COLUMNS}&limit=1`),
      sb(`/loyalty_stamps?check_in_id=eq.${Number(checkInId)}&select=reward_id&limit=1`),
    ]);
    if (notReady(s) || notReady(stamp) || !s.ok || !stamp.ok) return null;
    const set = Array.isArray(s.data) && s.data.length ? s.data[0] : null;
    if (!set || !set.stamps_on || !set.stamps_reward) return null;
    const mine = Array.isArray(stamp.data) && stamp.data.length ? stamp.data[0] : null;
    let earned = null;
    if (mine && mine.reward_id) {
      const r = await sb(`/loyalty_rewards?id=eq.${Number(mine.reward_id)}&select=${REWARD_COLUMNS}&limit=1`);
      earned = r.ok && Array.isArray(r.data) && r.data.length ? rewardOut(r.data[0]) : null;
    }
    const open = await sb(`/loyalty_stamps?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${Number(restaurantId)}&reward_id=is.null&select=check_in_id`);
    const have = open.ok && Array.isArray(open.data) ? open.data.length : 0;
    return { stamps: { have, every: Number(set.stamps_every), reward: set.stamps_reward, counted: !!mine }, earned };
  } catch (e) {
    console.error('[loyalty:card] failed', e && e.message);
    return null;
  }
}
