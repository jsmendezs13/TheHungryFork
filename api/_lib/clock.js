// api/_lib/clock.js — clocking in and out (r71, migration 48).
//
// Sebastian, 25 Nov 2026: "Clock in with a QR code that manager or owner reads, he can clock someone out and see who is
// in and who isn't"; "Manager, owner and me only can make clock ins; clock out everyone by theirself and manager, owner
// or me can clock someone out anytime"; "Add the option that let someone have the option for clock in others, maybe a
// manager let to the bartender clock in someone when he's not at the restaurant"; "download an excel document with the
// information of the hours".
//
// · Each person shows a code in My shifts. It changes every 30 seconds (an HMAC of restaurant, person and the 30-second
//   window, with the server's own secret), so a photo of it is useless a minute later.
// · Who scans it: owners, managers, the platform admin, and whoever a manager lets ("Tonight only" until 5 AM, or
//   until switched off). Nobody clocks themselves in.
// · Clocking out: each person, from their own phone; owners, managers and the platform admin, anyone, at any time.
// · Who's in, the hours, the Excel file and Fix a time: owners, managers and the platform admin. Someone allowed to
//   clock the others in sees Who's in too (to know who to scan), without the buttons.
// · These are payroll records (New York: kept 6 years, Labor Law §195(4)). The database refuses to delete them and
//   writes down every change of a time, with its reason (migration 48).
//
// Reached through api/reservations.js → staff.js, actions "staff_clock_…" (still twelve functions).

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { sb, LEVEL } from './roles.js';
import { siteHost } from './sites.js';
import { tableQrSvg } from './qr.js';
import { notifyStaff, line } from './push.js';
import { teamOf, zoneOf, localOf, clockWords, dayLabel, addDays, weekStartOf, serviceDayAt, zonedMs, cleanDay, cleanClock,
         weekLabel, dayMin } from './schedule.js';

const WIN = 30 * 1000;                     // the code changes every 30 seconds
const NOT_READY = { error: 'Clocking in is not set up yet: migration 48 has not been run.' };
const CLOCK_COLS = 'id,restaurant_id,taster_id,name,shift_id,in_at,out_at,in_by,out_by,out_how,fixed_at,fixed_by,fix_reason,created_at';
const hoursOf = (min) => Math.round(min / 6) / 10;
const minutesBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60000);

// ── the code ─────────────────────────────────────────────────────────────────────
function clockKey() { return crypto.createHmac('sha256', String(process.env.SUPABASE_JWT_SECRET || '')).update('hf-clock-v1').digest(); }
function sign(rid, tid, win) { return crypto.createHmac('sha256', clockKey()).update(`${rid}.${tid}.${win}`).digest('hex').slice(0, 32); }
export function clockToken(rid, tid, now = Date.now()) { const win = Math.floor(now / WIN); return `${rid}.${tid}.${win}.${sign(rid, tid, win)}`; }
export function readToken(token, now = Date.now()) {
  const m = /^(\d{1,9})\.(\d{1,12})\.(\d{5,12})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m) return { error: 'bad' };
  const rid = Number(m[1]), tid = Number(m[2]), win = Number(m[3]);
  if (!crypto.timingSafeEqual(Buffer.from(sign(rid, tid, win), 'hex'), Buffer.from(m[4], 'hex'))) return { error: 'bad' };
  const cur = Math.floor(now / WIN);
  if (win > cur + 1 || win < cur - 3) return { error: 'old', rid, tid };       // shown up to about 2 minutes ago
  return { rid, tid, win };
}

// ── who is asking ────────────────────────────────────────────────────────────────
async function ctx(res, tasterId, body, req, h) {
  const g = await h.gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!g) return null;
  const [team, probe] = await Promise.all([teamOf(g.rid), sb(`/staff_clock?restaurant_id=eq.${g.rid}&select=id&limit=1`)]);
  if (!team) { res.status(409).json({ error: 'The schedule is not set up yet: migration 47 has not been run.' }); return null; }
  if (!probe.ok) { res.status(probe.status === 404 ? 409 : 502).json(probe.status === 404 ? NOT_READY : { error: 'Could not read the clock (the database answered ' + probe.status + ').' }); return null; }
  const me = team.people[Number(tasterId)] || null;
  const tz = await zoneOf(g.rid);
  const p = await powersOf(g, Number(tasterId));
  return { ...g, tasterId: Number(tasterId), team, me, tz, powers: p };
}
// What this person may do with the clock here.
export async function powersOf(g, tasterId) {
  const boss = g.level >= LEVEL.manager;
  let delegate = false, until = null, ended = null;
  if (!boss && g.level >= LEVEL.crew) {
    const r = await sb(`/restaurant_roles?restaurant_id=eq.${g.rid}&taster_id=eq.${tasterId}&select=clock_others,clock_others_until`);
    const row = r.ok && Array.isArray(r.data) ? r.data.find((x) => x.clock_others) : null;
    if (row) {
      if (!row.clock_others_until || Date.parse(row.clock_others_until) > Date.now()) { delegate = true; until = row.clock_others_until || null; }
      else ended = row.clock_others_until;
    }
  }
  return { boss, scan: boss || delegate, board: boss || delegate, clockOut: boss, fix: boss, hours: boss, until, ended };
}

async function restaurantName(rid) {
  const r = await sb(`/restaurants?id=eq.${rid}&select=name`);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].name : 'The restaurant';
}
async function tell(rid, ids, body) {
  const only = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (!only.length) return 0;
  return notifyStaff(rid, 'schedule', { title: `${await restaurantName(rid)} · Schedule`, body: line(body, 170),
    url: `/manager#go=schedule&at=${rid}`, tag: `clock-${rid}-${Date.now()}` }, { only });
}
const wordsAt = (iso, tz) => clockWords(localOf(Date.parse(iso), tz).clock);

// The published shifts of a service day (what the team sees).
async function dayShifts(rid, date, tz) {
  const got = await sb(`/staff_shifts?restaurant_id=eq.${rid}&service_date=eq.${date}&pub=not.is.null&select=id,service_date,pub`);
  return (got.ok && Array.isArray(got.data) ? got.data : []).filter((s) => s.pub && s.pub.taster_id != null).map((s) => ({
    id: Number(s.id), tasterId: Number(s.pub.taster_id), positionId: s.pub.position_id == null ? null : Number(s.pub.position_id),
    startMs: Date.parse(s.pub.starts_at), endMs: Date.parse(s.pub.ends_at),
    fromWords: wordsAt(s.pub.starts_at, tz), toWords: wordsAt(s.pub.ends_at, tz) }));
}
// The shift a clock-in is for: the one running now (from an hour before it starts), or the next within 3 hours,
// or the last one that ended within 2 hours.
function matchShift(list, tid, now) {
  const mine = list.filter((s) => s.tasterId === tid).sort((a, b) => a.startMs - b.startMs);
  return mine.find((s) => now >= s.startMs - 3600e3 && now < s.endMs)
      || mine.find((s) => s.startMs > now && s.startMs - now <= 3 * 3600e3)
      || mine.filter((s) => s.endMs <= now && now - s.endMs <= 2 * 3600e3).pop() || null;
}
async function openOf(rid, tid) {
  const got = await sb(`/staff_clock?restaurant_id=eq.${rid}&taster_id=eq.${tid}&out_at=is.null&select=${CLOCK_COLS}&limit=1`);
  return got.ok && Array.isArray(got.data) ? got.data[0] || null : undefined;
}
const posName = (c, id) => (id && c.team.pos[id] ? c.team.pos[id].name : null);
const myName = (c) => (c.me ? c.me.name : c.firstName || 'A manager');

// ── MY CODE (everyone on the team) ─────────────────────────────────────────────────
export async function clockCode(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  const powers = { scan: c.powers.scan, board: c.powers.board, until: c.powers.until };
  // Seb (the platform admin) is not on the team: no code for him, and what he may do with the clock.
  if (!c.me) return res.status(200).json({ success: true, me: false, open: null, shift: null, powers });
  const now = Date.now();
  const today = serviceDayAt(now, c.tz);
  const [open, shifts] = await Promise.all([openOf(c.rid, c.tasterId), dayShifts(c.rid, today, c.tz)]);
  if (open === undefined) return res.status(502).json({ error: 'Could not read the clock. Please try again.' });
  const s = matchShift(shifts, c.tasterId, now);
  const shift = s ? { fromWords: s.fromWords, toWords: s.toWords, position: posName(c, s.positionId) } : null;
  if (open) {
    return res.status(200).json({ success: true, me: true, powers, open: { id: Number(open.id), inAt: open.in_at, inWords: wordsAt(open.in_at, c.tz),
      day: dayLabel(serviceDayAt(Date.parse(open.in_at), c.tz)), hours: hoursOf(minutesBetween(open.in_at, new Date(now).toISOString())) }, shift });
  }
  const token = clockToken(c.rid, c.tasterId, now);
  const host = siteHost(req) || (c.rid === 2 ? 'havana-social.vercel.app' : 'thehungryfork.fun');
  const url = `https://${host}/manager#clock=${token}`;
  return res.status(200).json({ success: true, me: true, powers, open: null, shift, name: c.me.fullName,
    code: { token, url, svg: tableQrSvg(url, c.rid), validFor: Math.max(1, Math.ceil((WIN - (now % WIN)) / 1000)) } });
}

// ── SCAN A CODE (owners, managers, the platform admin, and whoever they let) ─────────────
export async function clockScan(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.scan) {
    return res.status(403).json({ error: c.powers.ended
      ? 'Your permission to clock the others in has ended. Ask a manager.'
      : 'Only a manager, an owner, or someone they let, can clock people in.' });
  }
  const t = readToken(body.token);
  if (t.error === 'bad') return res.status(400).json({ error: 'That is not a clock-in code.' });
  if (t.rid !== c.rid) return res.status(409).json({ error: 'That code is for another restaurant.' });
  if (t.error === 'old') return res.status(409).json({ error: 'That code is old. Ask them to show it again: it changes every 30 seconds.', old: true });
  const person = c.team.people[t.tid];
  if (!person) return res.status(404).json({ error: 'That person is not on the team here any more.' });
  if (t.tid === c.tasterId) return res.status(403).json({ error: 'Someone else clocks you in: show your code to a manager.' });
  const now = Date.now();
  const open = await openOf(c.rid, t.tid);
  if (open === undefined) return res.status(502).json({ error: 'Could not read the clock. Please try again.' });
  if (open) return res.status(409).json({ error: `${person.name} is already in, since ${wordsAt(open.in_at, c.tz)}.`, already: true, clockId: Number(open.id) });
  const today = serviceDayAt(now, c.tz);
  const s = matchShift(await dayShifts(c.rid, today, c.tz), t.tid, now);
  const saved = await sb('/staff_clock', { method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ restaurant_id: c.rid, taster_id: t.tid, name: person.fullName.slice(0, 80), shift_id: s ? s.id : null,
      in_at: new Date(now).toISOString(), in_by: c.tasterId }) });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data[0]) {
    if (saved.status === 409 || (saved.data && saved.data.code === '23505')) return res.status(409).json({ error: `${person.name} is already in.`, already: true });
    return res.status(502).json({ error: 'Could not clock them in (the database answered ' + saved.status + ').' });
  }
  const row = saved.data[0];
  const late = s ? Math.round((now - s.startMs) / 60000) : null;
  return res.status(200).json({ success: true, clock: { id: Number(row.id), name: person.fullName, inWords: wordsAt(row.in_at, c.tz),
    shift: s ? { fromWords: s.fromWords, toWords: s.toWords, position: posName(c, s.positionId) } : null,
    late: late, timing: late === null ? 'No shift today' : late > 5 ? `${late} min late` : late < -5 ? `${-late} min early` : 'On time' } });
}

// A scan made by mistake: undone within 5 minutes (the database allows it only then).
export async function clockUndo(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  const id = Number(body.clockId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which clock-in?' });
  const got = await sb(`/staff_clock?id=eq.${id}&restaurant_id=eq.${c.rid}&select=${CLOCK_COLS}`);
  const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!row) return res.status(404).json({ error: 'That clock-in is not there.' });
  if (!(c.powers.boss || (c.powers.scan && Number(row.in_by) === c.tasterId))) return res.status(403).json({ error: 'Only the person who scanned it, or a manager, can undo it.' });
  if (row.out_at || row.fixed_at || Date.now() - Date.parse(row.created_at) > 5 * 60e3) return res.status(409).json({ error: 'It is too late to undo it: a manager can fix the time instead.' });
  const del = await sb(`/staff_clock?id=eq.${id}&out_at=is.null`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  if (!del.ok || !Array.isArray(del.data) || !del.data.length) return res.status(409).json({ error: 'It is too late to undo it: a manager can fix the time instead.' });
  return res.status(200).json({ success: true });
}

// ── CLOCK OUT (yourself; or, for a manager, anyone) ────────────────────────────────────
export async function clockOut(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  let row;
  if (body.clockId === undefined || body.clockId === null) {
    row = await openOf(c.rid, c.tasterId);
    if (row === undefined) return res.status(502).json({ error: 'Could not read the clock. Please try again.' });
    if (!row) return res.status(404).json({ error: 'You are not clocked in.' });
  } else {
    const id = Number(body.clockId);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which clock-in?' });
    const got = await sb(`/staff_clock?id=eq.${id}&restaurant_id=eq.${c.rid}&select=${CLOCK_COLS}`);
    row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
    if (!row) return res.status(404).json({ error: 'That clock-in is not there.' });
    if (row.out_at) return res.status(409).json({ error: `Already clocked out at ${wordsAt(row.out_at, c.tz)}.` });
  }
  const self = Number(row.taster_id) === c.tasterId;
  if (!self && !c.powers.clockOut) return res.status(403).json({ error: 'Only a manager or an owner can clock someone else out.' });
  const now = Date.now();
  if (now - Date.parse(row.in_at) > 24 * 3600e3) return res.status(409).json({ error: 'In for more than 24 hours: a manager fixes the time (Who\'s in → the person → Fix a time).', tooLong: true });
  const done = await sb(`/staff_clock?id=eq.${Number(row.id)}&out_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ out_at: new Date(now).toISOString(), out_by: c.tasterId, out_how: self ? 'self' : 'manager' }) });
  if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: 'Already clocked out.' });
  const out = done.data[0];
  if (!self && row.taster_id) {
    await tell(c.rid, [row.taster_id], `${myName(c)} clocked you out at ${wordsAt(out.out_at, c.tz)} (in since ${wordsAt(out.in_at, c.tz)}).`);
  }
  return res.status(200).json({ success: true, outWords: wordsAt(out.out_at, c.tz), hours: hoursOf(minutesBetween(out.in_at, out.out_at)) });
}

// ── WHO'S IN (managers, owners, the platform admin; and, without the buttons, whoever may clock the others in) ─────
export async function clockBoard(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.board) return res.status(403).json({ error: 'Who\'s in is for the managers.' });
  const now = Date.now();
  const date = cleanDay(body.date) || serviceDayAt(now, c.tz);
  const fromIso = new Date(zonedMs(date, '05:00', c.tz)).toISOString(), toIso = new Date(zonedMs(addDays(date, 1), '05:00', c.tz)).toISOString();
  const [shifts, day, open] = await Promise.all([
    dayShifts(c.rid, date, c.tz),
    sb(`/staff_clock?restaurant_id=eq.${c.rid}&in_at=gte.${fromIso}&in_at=lt.${toIso}&select=${CLOCK_COLS}&order=in_at.asc&limit=500`),
    sb(`/staff_clock?restaurant_id=eq.${c.rid}&out_at=is.null&select=${CLOCK_COLS}&order=in_at.asc&limit=200`),
  ]);
  if (!day.ok || !open.ok) return res.status(502).json({ error: 'Could not read the clock. Please try again.' });
  const rows = new Map();
  [...day.data, ...open.data].forEach((r) => rows.set(Number(r.id), r));
  const all = [...rows.values()];
  const shiftOf = new Map(shifts.map((s) => [s.id, s]));
  const pos = (tid) => { const p = c.team.people[tid]; return p && p.positionId && c.team.pos[p.positionId] ? c.team.pos[p.positionId].name : null; };
  const shortName = (r) => (r.taster_id && c.team.people[Number(r.taster_id)] ? c.team.people[Number(r.taster_id)].name : r.name);
  const inNow = all.filter((r) => !r.out_at).map((r) => {
    const s = r.shift_id ? shiftOf.get(Number(r.shift_id)) : null;
    const over = s && now > s.endMs ? Math.round((now - s.endMs) / 60000) : 0;
    return { clockId: Number(r.id), tasterId: r.taster_id === null ? null : Number(r.taster_id), name: shortName(r), position: pos(Number(r.taster_id)),
      inWords: wordsAt(r.in_at, c.tz), sinceDay: serviceDayAt(Date.parse(r.in_at), c.tz) !== date ? dayLabel(serviceDayAt(Date.parse(r.in_at), c.tz)) : null,
      shift: s ? `${s.fromWords} – ${s.toWords}` : null, overMinutes: over, hours: hoursOf(minutesBetween(r.in_at, new Date(now).toISOString())),
      tooLong: now - Date.parse(r.in_at) > 24 * 3600e3 };
  });
  const done = all.filter((r) => r.out_at && Date.parse(r.in_at) >= Date.parse(fromIso)).map((r) => ({ clockId: Number(r.id), tasterId: r.taster_id === null ? null : Number(r.taster_id),
    name: shortName(r), position: pos(Number(r.taster_id)), inWords: wordsAt(r.in_at, c.tz), outWords: wordsAt(r.out_at, c.tz),
    hours: hoursOf(minutesBetween(r.in_at, r.out_at)), fixed: !!r.fixed_at, how: r.out_how }));
  const came = new Set(all.filter((r) => Date.parse(r.in_at) >= Date.parse(fromIso) || !r.out_at).map((r) => Number(r.taster_id)));
  const late = [], notYet = [];
  shifts.forEach((s) => {
    if (came.has(s.tasterId)) return;
    const p = c.team.people[s.tasterId];
    const item = { tasterId: s.tasterId, name: p ? p.name : 'Someone', position: posName(c, s.positionId), shift: `${s.fromWords} – ${s.toWords}`, due: s.fromWords };
    if (now >= s.startMs + 5 * 60e3) late.push({ ...item, minutes: Math.round((now - s.startMs) / 60000), missed: now >= s.endMs });
    else notYet.push(item);
  });
  return res.status(200).json({ success: true, date, today: serviceDayAt(now, c.tz), dayLabel: dayLabel(date), nowWords: wordsAt(new Date(now).toISOString(), c.tz),
    timezone: c.tz, powers: { scan: c.powers.scan, clockOut: c.powers.clockOut, fix: c.powers.fix, hours: c.powers.hours, until: c.powers.until },
    in: inNow, late, notYet, done,
    people: Object.values(c.team.people).map((p) => ({ tasterId: p.tasterId, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)) });
}

// ── FIX A TIME, OR ADD A MISSED ONE (managers, owners, the platform admin) ──────────────────
// { restaurantId, clockId | tasterId, date (the service day), in 'HH:MM', out 'HH:MM' | null, reason }
export async function clockFix(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.fix) return res.status(403).json({ error: 'Only a manager or an owner can change a time.' });
  const date = cleanDay(body.date), tin = cleanClock(body.in), tout = body.out === null || body.out === '' || body.out === undefined ? null : cleanClock(body.out);
  if (!date || !tin) return res.status(400).json({ error: 'Pick the day and the time in.' });
  if (body.out && !tout) return res.status(400).json({ error: 'Pick the time out.' });
  const reason = typeof body.reason === 'string' ? body.reason.trim().replace(/\s+/g, ' ') : '';
  if (Array.from(reason).length < 3) return res.status(400).json({ error: 'Write why (for example: forgot to clock out).' });
  if (Array.from(reason).length > 200) return res.status(400).json({ error: 'The reason is at most 200 letters.' });
  if (/[<>]/.test(reason)) return res.status(400).json({ error: 'The reason cannot have < or >.' });
  const s = dayMin(tin);
  const inMs = zonedMs(addDays(date, Math.floor(s / 1440)), tin, c.tz);
  let outMs = null;
  if (tout) {
    let e = dayMin(tout); if (e <= s) e += 1440;
    outMs = zonedMs(addDays(date, Math.floor(e / 1440)), tout, c.tz);
    if (outMs - inMs > 24 * 3600e3) return res.status(400).json({ error: 'At most 24 hours.' });
  }
  const now = Date.now();
  if (inMs > now + 5 * 60e3 || (outMs && outMs > now + 5 * 60e3)) return res.status(400).json({ error: 'That time has not come yet.' });
  if (serviceDayAt(inMs, c.tz) < addDays(serviceDayAt(now, c.tz), -62)) return res.status(400).json({ error: 'Times older than two months stay as they are.' });
  const inIso = new Date(inMs).toISOString(), outIso = outMs ? new Date(outMs).toISOString() : null;
  const fix = { fixed_at: new Date(now).toISOString(), fixed_by: c.tasterId, fix_reason: reason };
  const range = (x) => `${clockWords(localOf(Date.parse(x.in_at), c.tz).clock)} – ${x.out_at ? clockWords(localOf(Date.parse(x.out_at), c.tz).clock) : 'still in'}`;

  let row, before = null, who;
  if (body.clockId !== undefined && body.clockId !== null) {
    const id = Number(body.clockId);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which clock-in?' });
    const got = await sb(`/staff_clock?id=eq.${id}&restaurant_id=eq.${c.rid}&select=${CLOCK_COLS}`);
    before = got.ok && Array.isArray(got.data) ? got.data[0] : null;
    if (!before) return res.status(404).json({ error: 'That clock-in is not there.' });
    who = before.taster_id;
    if (who) { const o = await overlap(c.rid, who, inIso, outIso, id); if (o) return res.status(409).json({ error: `That overlaps another time of theirs (${range(o)}).` }); }
    const patch = { in_at: inIso, out_at: outIso, ...fix };
    if (outIso && (!before.out_at || Date.parse(before.out_at) !== Date.parse(outIso))) { patch.out_how = 'fixed'; patch.out_by = c.tasterId; }
    if (!outIso && before.out_at) return res.status(400).json({ error: 'A time out that was written stays: change it, don\'t take it away.' });
    const saved = await sb(`/staff_clock?id=eq.${id}&restaurant_id=eq.${c.rid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
      if (saved.data && saved.data.code === '23505') return res.status(409).json({ error: 'They are already clocked in now: clock that one out first.' });
      return res.status(502).json({ error: 'Could not save it (the database answered ' + saved.status + ').' });
    }
    row = saved.data[0];
  } else {
    who = Number(body.tasterId);
    const person = c.team.people[who];
    if (!person) return res.status(400).json({ error: 'Pick someone on the team.' });
    if (!outIso) return res.status(400).json({ error: 'A missed time needs the time out too.' });
    const o = await overlap(c.rid, who, inIso, outIso, null);
    if (o) return res.status(409).json({ error: `That overlaps another time of theirs (${range(o)}).` });
    const today = serviceDayAt(inMs, c.tz);
    const s2 = matchShift(await dayShifts(c.rid, today, c.tz), who, inMs);
    const saved = await sb('/staff_clock', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: c.rid, taster_id: who, name: person.fullName.slice(0, 80), shift_id: s2 ? s2.id : null,
        in_at: inIso, out_at: outIso, in_by: c.tasterId, out_by: c.tasterId, out_how: 'fixed', ...fix }) });
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) return res.status(502).json({ error: 'Could not save it (the database answered ' + saved.status + ').' });
    row = saved.data[0];
  }
  if (who && Number(who) !== c.tasterId) {
    const day = dayLabel(serviceDayAt(Date.parse(row.in_at), c.tz));
    await tell(c.rid, [who], before
      ? `${myName(c)} changed your time on ${day}: ${range(row)} (it was ${range(before)}). Why: ${reason}`
      : `${myName(c)} added a time for you on ${day}: ${range(row)}. Why: ${reason}`);
  }
  return res.status(200).json({ success: true, clock: { id: Number(row.id), inWords: wordsAt(row.in_at, c.tz), outWords: row.out_at ? wordsAt(row.out_at, c.tz) : null } });
}
async function overlap(rid, tid, inIso, outIso, exceptId) {
  const end = outIso || new Date(Date.parse(inIso) + 24 * 3600e3).toISOString();
  const got = await sb(`/staff_clock?restaurant_id=eq.${rid}&taster_id=eq.${tid}&in_at=lt.${end}&select=id,in_at,out_at&order=in_at.desc&limit=50`);
  return (got.ok && Array.isArray(got.data) ? got.data : []).find((r) => Number(r.id) !== Number(exceptId)
    && (r.out_at ? Date.parse(r.out_at) > Date.parse(inIso) : true) && Date.parse(r.in_at) < Date.parse(end)) || null;
}

// ── A TIME'S HISTORY (managers) ────────────────────────────────────────────────────
export async function clockHistory(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.fix) return res.status(403).json({ error: 'Only a manager or an owner can see that.' });
  const id = Number(body.clockId);
  const got = await sb(`/staff_clock?id=eq.${id}&restaurant_id=eq.${c.rid}&select=${CLOCK_COLS}`);
  const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!row) return res.status(404).json({ error: 'That clock-in is not there.' });
  const fixes = await sb(`/staff_clock_fixes?clock_id=eq.${id}&select=before_in,before_out,after_in,after_out,reason,fixed_by,fixed_at&order=fixed_at.asc`);
  const names = {};
  const ids = [...new Set([row.in_by, row.out_by, ...(fixes.ok ? fixes.data : []).map((f) => f.fixed_by)].filter(Boolean).map(Number))];
  if (ids.length) { const t = await sb(`/tasters?id=in.(${ids.join(',')})&select=id,first_name`); (t.ok ? t.data : []).forEach((x) => { names[x.id] = x.first_name; }); }
  const w = (x) => (x ? wordsAt(x, c.tz) : '—');
  return res.status(200).json({ success: true, clock: { id, name: row.name, day: dayLabel(serviceDayAt(Date.parse(row.in_at), c.tz)), date: serviceDayAt(Date.parse(row.in_at), c.tz),
    in: localOf(Date.parse(row.in_at), c.tz).clock, out: row.out_at ? localOf(Date.parse(row.out_at), c.tz).clock : null,
    inWords: w(row.in_at), outWords: row.out_at ? w(row.out_at) : null, inBy: names[row.in_by] || null, outBy: names[row.out_by] || null, how: row.out_how },
    fixes: (fixes.ok ? fixes.data : []).map((f) => ({ was: `${w(f.before_in)} – ${w(f.before_out)}`, now: `${w(f.after_in)} – ${w(f.after_out)}`,
      reason: f.reason, by: names[f.fixed_by] || null, at: f.fixed_at, added: !f.before_in })) });
}

// ── THE HOURS AND THE EXCEL FILE (managers, owners, the platform admin) ───────────────────
async function hoursData(c, body) {
  const today = serviceDayAt(Date.now(), c.tz);
  let from = cleanDay(body.from), to = cleanDay(body.to);
  if (!from || !to) { from = weekStartOf(today); to = addDays(from, 6); }
  if (to < from) [from, to] = [to, from];
  if (addDays(from, 62) < to) return { error: 'At most two months at a time.' };
  const fromIso = new Date(zonedMs(from, '05:00', c.tz)).toISOString(), toIso = new Date(zonedMs(addDays(to, 1), '05:00', c.tz)).toISOString();
  const got = await sb(`/staff_clock?restaurant_id=eq.${c.rid}&in_at=gte.${fromIso}&in_at=lt.${toIso}&select=${CLOCK_COLS}&order=in_at.asc&limit=5000`);
  if (!got.ok || !Array.isArray(got.data)) return { error: 'Could not read the clock (the database answered ' + got.status + ').' };
  const shiftIds = [...new Set(got.data.map((r) => r.shift_id).filter(Boolean).map(Number))];
  const sh = shiftIds.length ? await sb(`/staff_shifts?id=in.(${shiftIds.join(',')})&select=id,pub`) : { ok: true, data: [] };
  const shiftWords = {};
  (sh.ok ? sh.data : []).forEach((s) => { if (s.pub) shiftWords[s.id] = `${wordsAt(s.pub.starts_at, c.tz)} – ${wordsAt(s.pub.ends_at, c.tz)}`; });
  const per = new Map();
  const clocks = got.data.map((r) => {
    const date = serviceDayAt(Date.parse(r.in_at), c.tz);
    const tid = r.taster_id === null ? null : Number(r.taster_id);
    const p = tid !== null ? c.team.people[tid] : null;
    const position = p && p.positionId && c.team.pos[p.positionId] ? c.team.pos[p.positionId].name : '';
    const minutes = r.out_at ? minutesBetween(r.in_at, r.out_at) : 0;
    const key = tid !== null ? 't' + tid : 'n' + r.name;
    if (!per.has(key)) per.set(key, { tasterId: tid, name: r.name, position, days: new Set(), weeks: {}, minutes: 0, open: false });
    const x = per.get(key);
    x.days.add(date);
    if (r.out_at) { x.minutes += minutes; const wk = weekStartOf(date); x.weeks[wk] = (x.weeks[wk] || 0) + minutes; } else x.open = true;
    return { id: Number(r.id), date, day: dayLabel(date), name: r.name, position, inWords: wordsAt(r.in_at, c.tz), outWords: r.out_at ? wordsAt(r.out_at, c.tz) : null,
      minutes, hours: hoursOf(minutes), shift: r.shift_id ? shiftWords[r.shift_id] || '' : '', fixed: r.fix_reason || null, open: !r.out_at };
  });
  const people = [...per.values()].map((x) => {
    const overtime = Object.values(x.weeks).reduce((s, m) => s + Math.max(0, m - 40 * 60), 0);
    return { tasterId: x.tasterId, name: x.name, position: x.position, days: x.days.size, minutes: x.minutes, regular: x.minutes - overtime, overtime, open: x.open };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const label = from === to ? dayLabel(from) : (weekStartOf(from) === from && to === addDays(from, 6) ? weekLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`);
  return { from, to, label, people, clocks, total: people.reduce((s, p) => s + p.minutes, 0) };
}
export async function clockHours(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.hours) return res.status(403).json({ error: 'The hours are for the managers.' });
  const d = await hoursData(c, body);
  if (d.error) return res.status(400).json({ error: d.error });
  return res.status(200).json({ success: true, ...d, people: d.people.map((p) => ({ ...p, hours: hoursOf(p.minutes), regularHours: hoursOf(p.regular), overtimeHours: hoursOf(p.overtime) })),
    totalHours: hoursOf(d.total), people_list: Object.values(c.team.people).map((p) => ({ tasterId: p.tasterId, name: p.name })) });
}
export async function clockXlsx(req, res, body, tasterId, h) {
  const c = await ctx(res, tasterId, body, req, h);
  if (!c) return;
  if (!c.powers.hours) return res.status(403).json({ error: 'The hours are for the managers.' });
  const d = await hoursData(c, body);
  if (d.error) return res.status(400).json({ error: d.error });
  const name = await restaurantName(c.rid);
  const file = hoursWorkbook(name, d);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'restaurant';
  console.log('[clock] taster', c.tasterId, 'downloaded the hours of', c.rid, d.from, '→', d.to);
  return res.status(200).json({ success: true, filename: `${slug}-hours-${d.from}-to-${d.to}.xlsx`, base64: file.toString('base64') });
}

// ── a small Excel writer (Office Open XML, no package) ──────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export function zipFiles(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = zlib.deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5B79, 12);   // 12:00, 25 Nov 2026
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, deflated);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x5B79, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(deflated.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + deflated.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const col = (i) => { let s = ''; i += 1; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
// a cell: a number, or text (a formula can't come in: text that starts with = is still text, and inline)
function cellXml(r, ci, v, style) {
  const ref = col(ci) + r, s = style ? ` s="${style}"` : '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  if (v === null || v === undefined || v === '') return style ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
}
function sheetXml(rows, widths, styleOf) {
  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const data = rows.map((row, ri) => `<row r="${ri + 1}">${row.map((v, ci) => cellXml(ri + 1, ci, v, styleOf(ri, ci, v))).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${data}</sheetData></worksheet>`;
}
export function hoursWorkbook(restaurant, d) {
  const h2 = (m) => Math.round(m / 60 * 100) / 100;
  const title = `${restaurant} · hours · ${d.label}${d.from.slice(0, 4) === d.to.slice(0, 4) ? ', ' + d.to.slice(0, 4) : ''}`;
  const sum = [[title], ['Overtime: the hours over 40 in a Monday–Sunday week (counting the days in this file). Someone still clocked in is not counted yet.'],
    ['Name', 'Position', 'Days worked', 'Regular hours', 'Overtime hours', 'Total hours']];
  d.people.forEach((p) => sum.push([p.name, p.position || '', p.days, h2(p.regular), h2(p.overtime), h2(p.minutes)]));
  sum.push(['Total', '', '', h2(d.people.reduce((s, p) => s + p.regular, 0)), h2(d.people.reduce((s, p) => s + p.overtime, 0)), h2(d.total)]);
  const lst = [[title], ['Every clock-in and clock-out. "Changed" shows a time a manager fixed, and why.'],
    ['Date', 'Name', 'Position', 'In', 'Out', 'Hours', 'Shift', 'Changed']];
  d.clocks.forEach((x) => lst.push([x.day + ', ' + x.date.slice(0, 4), x.name, x.position || '', x.inWords, x.outWords || 'still in', x.open ? '' : h2(x.minutes), x.shift || '', x.fixed || '']));
  const head = (ri) => ri === 2;
  const s1 = sheetXml(sum, [26, 16, 12, 15, 16, 13], (ri, ci, v) => (ri === 0 ? 1 : ri === 1 ? 4 : head(ri) ? 2 : ri === sum.length - 1 ? (ci >= 3 ? 5 : 1) : ci >= 3 ? 3 : 0));
  const s2 = sheetXml(lst, [18, 24, 14, 11, 11, 9, 22, 40], (ri, ci) => (ri === 0 ? 1 : ri === 1 ? 4 : head(ri) ? 2 : ci === 5 ? 3 : 0));
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>'
    + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF5B6472"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF8"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return zipFiles([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Hours" sheetId="1" r:id="rId1"/><sheet name="Clock-ins" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: s1 },
    { name: 'xl/worksheets/sheet2.xml', data: s2 },
    { name: 'xl/styles.xml', data: styles },
  ]);
}
