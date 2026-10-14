// api/_lib/loyalty.js
//
// r31 (Sebastian, 13 Oct): Lucky Bite, the stamp card and invites. Every one of
// them is the restaurant's offer: Seb's Analytics and Fork's Rating give
// nothing away and pay for nothing (Sebastian, 13 Oct) — the site is only the
// way a restaurant runs its own rewards. The counting itself
// lives in the database (migrations 21 and 22): since r32 every visit the staff
// confirm gets the next Lucky Bite number, and every Nth visit wins the prize the
// restaurant writes, used in that same visit; a scanned visit also puts a stamp
// on the card, and a full card is a reward. Nothing here can
// hand anyone a number or a prize. This file only READS what the database
// decided, lets a manager choose the rules, and turns a prize into "used".
//
// r32 (Sebastian, 13 Oct 19:38): ratings no longer count; the guest sees their
// number as soon as the waiter confirms the visit; an invite is made by the
// guest after a visit, for a dish they pick, and shown as a QR to a friend.
//
// Reached through api/checkins.js (the guest: My Visits, the visit's result, the
// prize's QR, the invite), api/checkin-confirm.js (staff: give a prize) and
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
export const DEFAULTS = { luckyEvery: 100, stampsEvery: 10, rewardDays: 60, inviteDays: 7, luckyReward: 'A free dish' };

// The restaurant's day starts at 5 AM (New York), like the reservations': a
// visit at 12:30 AM belongs to the dinner that started at 9.
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
  // r32: a Lucky Bite won by a visit carries the restaurant's own words; one
  // won by a rated dish (r31) is that dish, free.
  if (r.kind === 'lucky') return r.reward_text || (r.dish_name || 'A dish') + ', free';
  return r.reward_text || 'A reward';
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

const SETTINGS_COLUMNS = 'restaurant_id,lucky_on,lucky_every,lucky_count,lucky_reward,stamps_on,stamps_every,stamps_reward,reward_days,'
                       + 'invite_on,invite_discount,invite_days';
export const PASS_COLUMNS = 'id,restaurant_id,from_taster_id,check_in_id,code,discount_text,dish_id,dish_name,made_day,created_at,expires_at,claimed_by,claimed_at,redeemed_at,redeemed_by_name';

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
    discount: p.discount_text, dishId: p.dish_id != null ? Number(p.dish_id) : null, dishName: p.dish_name || null,
    usableFrom, expiresAt: p.expires_at, status: passStatus(p),
    usableToday: serviceDay() >= usableFrom, mine,
    code: mine ? p.code : undefined,
    redeemedAt: p.redeemed_at || null,
  };
}

// ── r32: the guest makes the invite, after a visit, for a dish they pick ─────
// One invite per confirmed visit, made while that visit is today (the
// restaurant's day). Never for the restaurant's own team. The dish is the reason
// for the friend to come; the discount is the restaurant's.
async function visitForInvite(tasterId, restaurantId) {
  const tid = Number(tasterId), rid = Number(restaurantId);
  if (!Number.isInteger(rid) || rid < 1) throw Object.assign(new Error('Which restaurant?'), { status: 400 });
  const [s, role, visit] = await Promise.all([
    sb(`/loyalty_settings?restaurant_id=eq.${rid}&select=${SETTINGS_COLUMNS}&limit=1`),
    sb(`/restaurant_roles?taster_id=eq.${tid}&restaurant_id=eq.${rid}&select=id&limit=1`),
    sb(`/check_ins?taster_id=eq.${tid}&restaurant_id=eq.${rid}&visit_date=in.(${visitDays().join(',')})&select=id,visit_date&order=id.desc&limit=1`),
  ]);
  if (notReady(s)) throw Object.assign(new Error('Invites are not set up yet.'), { status: 404 });
  const set = s.ok && Array.isArray(s.data) && s.data.length ? s.data[0] : null;
  if (!set || !set.invite_on || !set.invite_discount) throw Object.assign(new Error('This restaurant has no invites right now.'), { status: 409 });
  if (role.ok && Array.isArray(role.data) && role.data.length) {
    throw Object.assign(new Error('You are on this restaurant’s team, so your visits here do not give invites.'), { status: 403 });
  }
  const v = visit.ok && Array.isArray(visit.data) && visit.data.length ? visit.data[0] : null;
  if (!v) throw Object.assign(new Error('Invites open after a visit the staff confirm today.'), { status: 409 });
  const made = await sb(`/loyalty_passes?check_in_id=eq.${Number(v.id)}&select=id&limit=1`);
  if (made.ok && Array.isArray(made.data) && made.data.length) {
    throw Object.assign(new Error('You already made the invite for this visit.'), { status: 409 });
  }
  return { set, visit: v };
}

// The dishes to choose from: the restaurant's menu as guests see it.
export async function inviteDishes(tasterId, restaurantId) {
  const { set } = await visitForInvite(tasterId, restaurantId);
  const rid = Number(restaurantId);
  const got = await sb(`/dishes?restaurant_id=eq.${rid}&or=(is_hidden.is.null,is_hidden.eq.false)` +
                       `&select=id,name,image,restaurant_category,sort_order&order=sort_order.asc.nullslast,id.asc&limit=300`);
  if (!got.ok) throw Object.assign(new Error('Could not read the menu.'), { status: 502 });
  const dishes = (Array.isArray(got.data) ? got.data : []).filter((d) => d.name)
    .map((d) => ({ id: Number(d.id), name: d.name, image: d.image || null, category: d.restaurant_category || null }));
  return { discount: set.invite_discount, days: Number(set.invite_days) || DEFAULTS.inviteDays, dishes };
}

export async function makeInvite(tasterId, restaurantId, dishId) {
  const did = Number(dishId), rid = Number(restaurantId), tid = Number(tasterId);
  if (!Number.isInteger(did) || did < 1) throw Object.assign(new Error('Pick a dish first.'), { status: 400 });
  const { set, visit } = await visitForInvite(tid, rid);
  const dish = await sb(`/dishes?id=eq.${did}&restaurant_id=eq.${rid}&or=(is_hidden.is.null,is_hidden.eq.false)&select=id,name&limit=1`);
  const d = dish.ok && Array.isArray(dish.data) && dish.data.length ? dish.data[0] : null;
  if (!d) throw Object.assign(new Error('That dish is not on this restaurant’s menu.'), { status: 404 });
  const days = Number(set.invite_days) || DEFAULTS.inviteDays;
  for (let attempt = 0; attempt < 3; attempt++) {
    const made = await sb('/loyalty_passes', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        restaurant_id: rid, from_taster_id: tid, check_in_id: Number(visit.id),
        code: makePassCode(), discount_text: set.invite_discount, made_day: serviceDay(),
        dish_id: did, dish_name: String(d.name).slice(0, 120),
        expires_at: new Date(Date.now() + days * 24 * 3600 * 1000).toISOString(),
      }),
    });
    if (made.ok && Array.isArray(made.data) && made.data.length) return passOut(made.data[0], await namesOf([rid]), tid);
    const why = JSON.stringify(made.data || '');
    if (/check_in_id/.test(why)) throw Object.assign(new Error('You already made the invite for this visit.'), { status: 409 });
    if (!(made.status === 409 && /code/.test(why))) {
      console.error('[loyalty:invite] not made', made.status, why.slice(0, 160));
      throw Object.assign(new Error('Could not make the invite. Please try again.'), { status: 502 });
    }
  }
  throw Object.assign(new Error('Could not make the invite. Please try again.'), { status: 502 });
}

// The giver opens their invite's QR again (until a friend saves it).
export async function inviteForGiver(tasterId, passId) {
  const id = Number(passId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Which invite?'), { status: 400 });
  const got = await sb(`/loyalty_passes?id=eq.${id}&from_taster_id=eq.${Number(tasterId)}&select=${PASS_COLUMNS}&limit=1`);
  if (notReady(got)) throw Object.assign(new Error('Invites are not set up yet.'), { status: 404 });
  const p = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!p) throw Object.assign(new Error('That invite is not yours.'), { status: 404 });
  const st = passStatus(p);
  if (st !== 'open') throw Object.assign(new Error(st === 'saved' ? 'A friend already saved this invite.' : st === 'used' ? 'This invite was already used.' : 'This invite has run out.'), { status: 409 });
  return passOut(p, await namesOf([p.restaurant_id]), Number(tasterId));
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
  let dishImage = null;
  if (p.dish_id) {
    const d = await sb(`/dishes?id=eq.${Number(p.dish_id)}&select=image&limit=1`);
    dishImage = d.ok && Array.isArray(d.data) && d.data.length ? d.data[0].image || null : null;
  }
  return { ...passOut(p, names), from: fromName, saved: !!(p.claimed_by || p.claimed_at), dishImage };
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
export const REWARD_COLUMNS = 'id,restaurant_id,taster_id,kind,dish_name,reward_text,lucky_number,visits,check_in_id,created_at,expires_at,redeemed_at,redeemed_by_name';

async function namesOf(ids) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return {};
  const got = await sb(`/restaurants?id=in.(${list.join(',')})&select=id,name`);
  const out = {};
  (got.ok && Array.isArray(got.data) ? got.data : []).forEach((r) => { out[r.id] = r.name; });
  return out;
}

function programOut(s, name, mine) {
  const rid = s.restaurant_id;
  const staff = !!mine.staff[rid];
  const lucky = s.lucky_on ? {
    every: Number(s.lucky_every), counted: Number(s.lucky_count), prize: s.lucky_reward || 'A free dish',
    ...nextLucky(s.lucky_count, s.lucky_every),
    last: mine.lastNumber[rid] || null,            // their newest number here
    today: mine.todayNumber[rid] || null,          // the number of today's visit
  } : null;
  const stamps = s.stamps_on && s.stamps_reward ? {
    every: Number(s.stamps_every), reward: s.stamps_reward, have: Math.min(mine.stamps[rid] || 0, Number(s.stamps_every)),
  } : null;
  const invite = s.invite_on && s.invite_discount ? {
    discount: s.invite_discount, days: Number(s.invite_days) || DEFAULTS.inviteDays,
    canMake: !staff && !!mine.todayVisit[rid] && !mine.invitedToday[rid],
  } : null;
  return {
    restaurantId: rid, restaurant: name || 'The restaurant', staff,
    visitedToday: !!mine.todayVisit[rid], lucky, stamps, invite, rewardDays: Number(s.reward_days),
  };
}

// ── THE GUEST: My Visits ──────────────────────────────────────────────────────
// Their prizes (newest first), and the programs of the restaurants they go to.
// A guest who has been nowhere yet sees the programs that are on, so they learn
// what a check-in is worth.
export async function guestLoyalty(tasterId) {
  const id = Number(tasterId);
  const [rewards, stamps, settings, visits, numbers, given, received, roles] = await Promise.all([
    sb(`/loyalty_rewards?taster_id=eq.${id}&select=${REWARD_COLUMNS}&order=created_at.desc&limit=60`),
    sb(`/loyalty_stamps?taster_id=eq.${id}&reward_id=is.null&select=restaurant_id&limit=2000`),
    sb(`/loyalty_settings?or=(lucky_on.eq.true,stamps_on.eq.true,invite_on.eq.true)&select=${SETTINGS_COLUMNS}&limit=60`),
    sb(`/check_ins?taster_id=eq.${id}&select=id,restaurant_id,visit_date&order=id.desc&limit=2000`),
    sb(`/loyalty_lucky?taster_id=eq.${id}&select=check_in_id,restaurant_id,number&order=number.desc&limit=200`),
    sb(`/loyalty_passes?from_taster_id=eq.${id}&select=${PASS_COLUMNS}&order=created_at.desc&limit=20`),
    sb(`/loyalty_passes?claimed_by=eq.${id}&select=${PASS_COLUMNS}&order=created_at.desc&limit=20`),
    sb(`/restaurant_roles?taster_id=eq.${id}&select=restaurant_id`),
  ]);
  if ([rewards, stamps, settings, numbers, given, received].some(notReady)) return { ready: false };
  if (![rewards, stamps, settings, numbers].every((r) => r.ok && Array.isArray(r.data))) {
    const bad = [rewards, stamps, settings, numbers].find((r) => !r.ok);
    throw Object.assign(new Error('Could not read your rewards (the database answered ' + (bad ? bad.status : '?') + ').'), { status: 502 });
  }
  const days = visitDays();
  const visited = new Set(), todayVisit = {}, todayIds = new Set();
  (visits.ok && Array.isArray(visits.data) ? visits.data : []).forEach((v) => {
    visited.add(Number(v.restaurant_id));
    if (days.includes(v.visit_date) && !todayVisit[v.restaurant_id]) { todayVisit[v.restaurant_id] = Number(v.id); todayIds.add(Number(v.id)); }
  });
  const gave = given.ok && Array.isArray(given.data) ? given.data : [];
  const got = received.ok && Array.isArray(received.data) ? received.data : [];
  const mine = { stamps: {}, lastNumber: {}, todayNumber: {}, todayVisit, invitedToday: {}, staff: {} };
  stamps.data.forEach((s) => { mine.stamps[s.restaurant_id] = (mine.stamps[s.restaurant_id] || 0) + 1; });
  numbers.data.forEach((n) => {
    if (mine.lastNumber[n.restaurant_id] == null) mine.lastNumber[n.restaurant_id] = Number(n.number);
    if (todayIds.has(Number(n.check_in_id))) mine.todayNumber[n.restaurant_id] = Number(n.number);
  });
  gave.forEach((p) => { if (p.check_in_id && todayIds.has(Number(p.check_in_id))) mine.invitedToday[p.restaurant_id] = true; });
  (roles.ok && Array.isArray(roles.data) ? roles.data : []).forEach((r) => { mine.staff[r.restaurant_id] = true; });

  let on = settings.data;
  const theirs = on.filter((s) => visited.has(Number(s.restaurant_id)) || mine.stamps[s.restaurant_id]);
  on = (theirs.length ? theirs : on).slice(0, 6);
  const names = await namesOf([...on.map((s) => s.restaurant_id), ...rewards.data.map((r) => r.restaurant_id),
                               ...gave.map((p) => p.restaurant_id), ...got.map((p) => p.restaurant_id)]);
  return {
    ready: true,
    programs: on.map((s) => programOut(s, names[s.restaurant_id], mine)),
    rewards: rewards.data.map((r) => rewardOut(r, names)),
    // Invites they made: the ones nobody has saved yet and that still work,
    // then the ones a friend saved (without saying who) and the used ones.
    invitesGiven: gave.map((p) => passOut(p, names, id)).filter((p) => p.status !== 'expired'),
    invitesReceived: got.map((p) => passOut(p, names, id)),
  };
}

// ── A CONFIRMED VISIT: what it did (r32) ─────────────────────────────────────
// Shown to the guest the moment the waiter confirms (their screen asks every
// few seconds while the QR is up), to the waiter on the confirm screen, and to
// the host who scanned a booking at the door. Read from what the database did.
// forGuest: the invite's code is only ever sent to the guest who made it.
export async function visitSummary(visit, { forGuest = false } = {}) {
  try {
    const vid = Number(visit.id), rid = Number(visit.restaurant_id), tid = Number(visit.taster_id);
    const [s, num, prize, role, pass, names] = await Promise.all([
      sb(`/loyalty_settings?restaurant_id=eq.${rid}&select=${SETTINGS_COLUMNS}&limit=1`),
      sb(`/loyalty_lucky?check_in_id=eq.${vid}&select=number&limit=1`),
      sb(`/loyalty_rewards?check_in_id=eq.${vid}&kind=eq.lucky&select=${REWARD_COLUMNS}&limit=1`),
      sb(`/restaurant_roles?taster_id=eq.${tid}&restaurant_id=eq.${rid}&select=id&limit=1`),
      sb(`/loyalty_passes?check_in_id=eq.${vid}&select=${PASS_COLUMNS}&limit=1`),
      namesOf([rid]),
    ]);
    if ([s, num, prize, pass].some(notReady) || !s.ok) return null;
    const set = Array.isArray(s.data) && s.data.length ? s.data[0] : null;
    const staff = !!(role.ok && Array.isArray(role.data) && role.data.length);
    const base = { visitId: vid, restaurantId: rid, restaurant: names[rid] || 'The restaurant', staff };
    if (!set) return { ...base, lucky: null, card: null, invite: null };
    const n = num.ok && Array.isArray(num.data) && num.data.length ? Number(num.data[0].number) : null;
    const won = prize.ok && Array.isArray(prize.data) && prize.data.length ? rewardOut(prize.data[0], names) : null;
    const lucky = set.lucky_on ? {
      every: Number(set.lucky_every), prize: set.lucky_reward || 'A free dish', number: n,
      ...nextLucky(set.lucky_count, set.lucky_every), won,
    } : (won ? { number: n, won } : null);
    const made = pass.ok && Array.isArray(pass.data) && pass.data.length ? pass.data[0] : null;
    const today = visitDays().includes(visit.visit_date);
    const invite = set.invite_on && set.invite_discount ? {
      discount: set.invite_discount, days: Number(set.invite_days) || DEFAULTS.inviteDays,
      made: made ? passOut(made, names, forGuest ? tid : null) : null,
      canMake: !staff && !made && today,
    } : null;
    const card = await cardAfterVisit(vid, tid, rid);
    return { ...base, lucky, card, invite };
  } catch (e) {
    console.error('[loyalty:visit-summary] failed', e && e.message);
    return null;
  }
}

// The guest's own check-in QR: has the waiter confirmed it yet? Asked every few
// seconds while the QR is on their screen; the answer is the visit's result.
export async function ticketStatus(tasterId, ticketId) {
  const id = Number(ticketId), tid = Number(tasterId);
  if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Which code?'), { status: 400 });
  const q = `/check_in_tokens?id=eq.${id}&taster_id=eq.${tid}&limit=1&select=id,used_at,expires_at`;
  let got = await sb(q + ',reward_id,pass_id');
  if (!got.ok && got.status === 400) got = await sb(q);       // before migration 21: no prize or invite tickets
  const t = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
  if (!t) return { used: false, gone: true };
  if (!t.used_at) return { used: false, expiresAt: t.expires_at };
  if (t.reward_id || t.pass_id) return { used: true, kind: t.reward_id ? 'reward' : 'invite' };
  const v = await sb(`/check_ins?taster_id=eq.${tid}&visit_date=in.(${visitDays().join(',')})&select=id,taster_id,restaurant_id,visit_date&order=id.desc&limit=1`);
  const visit = v.ok && Array.isArray(v.data) && v.data.length ? v.data[0] : null;
  return { used: true, kind: 'visit', visit: visit ? await visitSummary(visit, { forGuest: true }) : null };
}

// ── The r31 names, kept so the r31 files keep working in the minutes between
// two uploads (and after an Undo): a rating no longer counts for anything, and
// an invite is no longer made by itself at the visit (the guest makes it).
export async function afterRating() { return { ready: true, lucky: { on: false } }; }
export async function passForVisit() { return null; }

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
    luckyReward: row ? row.lucky_reward || '' : '',
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
  const text = words(x.stampsReward), discount = words(x.inviteDiscount), prize = words(x.luckyReward);
  if (text.length > LIMITS.rewardText) return { error: `The reward is ${LIMITS.rewardText} characters at most.` };
  if (discount.length > LIMITS.rewardText) return { error: `The discount is ${LIMITS.rewardText} characters at most.` };
  if (prize.length > LIMITS.rewardText) return { error: `The Lucky Bite prize is ${LIMITS.rewardText} characters at most.` };
  if (/[<>]/.test(text + discount + prize)) return { error: 'The words cannot contain < or >.' };
  const stampsOn = x.stampsOn === true, inviteOn = x.inviteOn === true, luckyOn = x.luckyOn === true;
  if (luckyOn && !prize) return { error: 'Write the Lucky Bite prize, for example "A free entrée".' };
  if (stampsOn && !text) return { error: 'Write the reward for a full card, for example "A free dessert".' };
  if (inviteOn && !discount) return { error: 'Write the discount for a friend, for example "10% off your meal".' };
  return { row: {
    lucky_on: luckyOn, lucky_every: luckyEvery, lucky_reward: prize || null,
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
      const sum = await visitSummary({ ...visit, taster_id: guest, restaurant_id: row.restaurant_id });
      return { recorded: true, account: true, card: sum ? sum.card : null, lucky: sum ? sum.lucky : null,
               invite: !!(sum && sum.invite && sum.invite.canMake), staff: !!(sum && sum.staff) };
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
