// api/_lib/schedule.js — the team's schedule (r70, migration 47).
//
// Sebastian, 25 Nov 2026: "I want to build a scheduling system for the team". It lives inside Team (People · Schedule);
// the manager's week is a grid (his pick A). Everyone on the team sees the whole schedule; only the people who build it
// change it. Notifications: Staff app only (kind "schedule").
//
// Who builds the schedule: owners, managers, the platform admin, and crew whose position has "Build the schedule".
// Builders add, change and remove shifts, copy last week, publish, and approve or decline the requests.
// Everyone on the team: My shifts, the published week (Everyone), time off, availability, offer a shift, take an
// offered one, pick up an open one.
//
// A shift has two faces: the builders' (the row as it is now) and the team's (pub, as it was at the last Publish).
// A change is a draft until Publish; removing a published shift keeps it for the team until Publish.
// An approved request (a swap, a pick-up) changes both faces at once: the manager has said yes.
//
// Reached through api/reservations.js → staff.js with actions that start with "staff_sched_", "staff_timeoff_",
// "staff_availability_" and "staff_shift_" (still twelve functions).

import { sb, LEVEL } from './roles.js';
import { loadBooking } from './booking.js';
import { notifyStaff, line } from './push.js';
import { tellChange } from './changes.js';

const DAY_STARTS_MIN = 5 * 60;                 // a restaurant's day starts at 5 AM (staff.js, migration 17)
const MAX_SHIFT_MIN = 16 * 60;
const MIN_SHIFT_MIN = 15;
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NOT_READY = { error: 'The schedule is not set up yet: migration 47 has not been run.' };

// ── dates and times ─────────────────────────────────────────────────────────────
export const cleanDay = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
  && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v ? v : null);
export const cleanClock = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
export function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
export function weekdayOf(date) { return (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7; }     // 0 = Monday
export function weekStartOf(date) { return addDays(date, -weekdayOf(date)); }
const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

function partsAt(ms, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return p;
}
function offsetMs(tz, ms) {
  const p = partsAt(ms, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// A wall-clock time at the restaurant → the instant.
export function zonedMs(date, clock, tz) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(mins(clock) / 60), mins(clock) % 60);
  let ms = guess - offsetMs(tz, guess);
  ms = guess - offsetMs(tz, ms);
  return ms;
}
export function localOf(ms, tz) {
  const p = partsAt(ms, tz);
  return { date: `${p.year}-${p.month}-${p.day}`, clock: `${String(+p.hour % 24).padStart(2, '0')}:${p.minute}` };
}
export function serviceDayAt(ms, tz) {
  const l = localOf(ms, tz);
  return mins(l.clock) < DAY_STARTS_MIN ? addDays(l.date, -1) : l.date;
}
// The service day's minutes: 5 AM … 4:59 AM next day = 300 … 1739.
export const dayMin = (clock) => mins(clock) + (mins(clock) < DAY_STARTS_MIN ? 1440 : 0);

// "from"–"to" on a service day → { startMs, endMs, minutes } or { error }.
export function shiftSpan(date, from, to, tz) {
  const s = dayMin(from);
  let e = dayMin(to);
  if (e <= s) e += 1440;
  const minutes = e - s;
  if (minutes < MIN_SHIFT_MIN) return { error: 'A shift is at least 15 minutes.' };
  if (minutes > MAX_SHIFT_MIN) return { error: 'A shift is at most 16 hours.' };
  const startMs = zonedMs(addDays(date, Math.floor(s / 1440)), hhmm(s % 1440), tz);
  const endMs = zonedMs(addDays(date, Math.floor(e / 1440)), hhmm(e % 1440), tz);
  return { startMs, endMs, minutes: Math.round((endMs - startMs) / 60000) };
}
export function clockWords(clock) {
  const m = mins(clock), h = Math.floor(m / 60) % 24, mm = m % 60;
  return `${h % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ':00'} ${h < 12 ? 'AM' : 'PM'}`;
}
export function dayLabel(date) {
  const d = new Date(date + 'T00:00:00Z');
  return `${WEEKDAY[weekdayOf(date)]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function weekLabel(start) {
  const a = new Date(start + 'T00:00:00Z'), b = new Date(addDays(start, 6) + 'T00:00:00Z');
  return a.getUTCMonth() === b.getUTCMonth()
    ? `${MONTH[a.getUTCMonth()]} ${a.getUTCDate()} – ${b.getUTCDate()}`
    : `${MONTH[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTH[b.getUTCMonth()]} ${b.getUTCDate()}`;
}
const hoursOf = (minutes) => Math.round(minutes / 6) / 10;          // one decimal

// ── the restaurant and its team ─────────────────────────────────────────────────
export async function zoneOf(rid) {
  const loaded = await loadBooking(rid);
  return (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';
}
function todayService(tz) { return serviceDayAt(Date.now(), tz); }

// Positions and people. null when migration 47 is not in.
export async function teamOf(rid) {
  const [roles, positions] = await Promise.all([
    sb(`/restaurant_roles?restaurant_id=eq.${rid}&select=id,taster_id,role,position_id,own_message,own_codes,can_message,can_issue_codes`),
    sb(`/staff_positions?restaurant_id=eq.${rid}&archived_at=is.null&select=id,name,color,sort_order,can_message,can_rewards,can_schedule,job&order=sort_order.asc,id.asc`),
  ]);
  if (!roles.ok || !positions.ok || !Array.isArray(roles.data) || !Array.isArray(positions.data)) return null;
  const ids = [...new Set(roles.data.map((r) => Number(r.taster_id)))];
  const names = {};
  if (ids.length) {
    const t = await sb(`/tasters?id=in.(${ids.join(',')})&select=id,first_name,last_name,username`);
    (t.ok && Array.isArray(t.data) ? t.data : []).forEach((x) => { names[x.id] = x; });
  }
  const pos = {};
  positions.data.forEach((p) => { pos[p.id] = p; });
  const people = {};
  roles.data.forEach((r) => {
    const id = Number(r.taster_id), level = LEVEL[r.role] || 0;
    const cur = people[id];
    const positionId = r.position_id && pos[r.position_id] ? Number(r.position_id) : null;
    if (!cur) {
      const t = names[id] || {};
      const first = String(t.first_name || '').trim(), last = String(t.last_name || '').trim();
      people[id] = { tasterId: id, role: r.role, level, positionId,
        name: first ? first + (last ? ' ' + Array.from(last)[0] + '.' : '') : (t.username || 'Someone'),
        fullName: [first, last].filter(Boolean).join(' ') || t.username || 'Someone' };
    } else {
      if (level > cur.level) { cur.role = r.role; cur.level = level; }
      if (!cur.positionId && positionId) cur.positionId = positionId;
    }
  });
  return { positions: positions.data, pos, people };
}

// Who is asking, and may they build the schedule? (gate answers 4xx itself and returns null.)
async function who(res, tasterId, body, req, h, { build = false } = {}) {
  const g = await h.gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!g) return null;
  const team = await teamOf(g.rid);
  if (!team) { res.status(409).json(NOT_READY); return null; }
  const me = team.people[Number(tasterId)];
  const myPos = me && me.positionId ? team.pos[me.positionId] : null;
  const canBuild = g.level >= LEVEL.manager || !!(myPos && myPos.can_schedule);
  if (build && !canBuild) {
    res.status(403).json({ error: 'Only a manager, or someone whose position can build the schedule, can change it.' });
    return null;
  }
  const tz = await zoneOf(g.rid);
  return { ...g, tasterId: Number(tasterId), team, me: me || null, canBuild, tz };
}

// The people who build the schedule here (for the requests' notifications).
function builderIds(team) {
  return Object.values(team.people).filter((p) => p.level >= LEVEL.manager
    || (p.positionId && team.pos[p.positionId] && team.pos[p.positionId].can_schedule)).map((p) => p.tasterId);
}

async function restaurantName(rid) {
  const r = await sb(`/restaurants?id=eq.${rid}&select=name`);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].name : 'The restaurant';
}
const scheduleUrl = (rid, date) => `/manager#go=schedule&at=${rid}${date ? '&wk=' + date.replace(/-/g, '') : ''}`;
async function tell(rid, ids, body, date, { except } = {}) {
  const only = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n > 0 && n !== Number(except));
  if (!only.length) return 0;
  return notifyStaff(rid, 'schedule', {
    title: `${await restaurantName(rid)} · Schedule`, body: line(body, 170), url: scheduleUrl(rid, date),
    tag: `schedule-${rid}-${Date.now()}`,
  }, { only });
}

// ── a shift, as a page wants it ───────────────────────────────────────────────────
function face(row, published) {
  if (!published) return { tasterId: row.taster_id === null ? null : Number(row.taster_id), positionId: row.position_id === null ? null : Number(row.position_id),
    startsAt: row.starts_at, endsAt: row.ends_at, note: row.note || null };
  const p = row.pub || {};
  return { tasterId: p.taster_id == null ? null : Number(p.taster_id), positionId: p.position_id == null ? null : Number(p.position_id),
    startsAt: p.starts_at, endsAt: p.ends_at, note: p.note || null };
}
const pubOf = (row) => ({ taster_id: row.taster_id === null ? null : Number(row.taster_id), position_id: row.position_id === null ? null : Number(row.position_id),
  starts_at: new Date(row.starts_at).toISOString(), ends_at: new Date(row.ends_at).toISOString(), note: row.note || null });
function sameFace(row) {
  if (!row.pub) return false;
  const a = pubOf(row), b = row.pub;
  const n = (x) => (x === null || x === undefined ? null : Number(x));
  return n(a.taster_id) === n(b.taster_id) && n(a.position_id) === n(b.position_id)
    && Date.parse(a.starts_at) === Date.parse(b.starts_at) && Date.parse(a.ends_at) === Date.parse(b.ends_at)
    && (a.note || null) === (b.note || null);
}
function dress(row, f, tz) {
  const s = Date.parse(f.startsAt), e = Date.parse(f.endsAt);
  const a = localOf(s, tz), b = localOf(e, tz);
  return { id: Number(row.id), date: row.service_date, tasterId: f.tasterId, positionId: f.positionId, note: f.note,
    from: a.clock, to: b.clock, fromWords: clockWords(a.clock), toWords: clockWords(b.clock),
    minutes: Math.round((e - s) / 60000), startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() };
}
const SHIFT_COLS = 'id,restaurant_id,service_date,taster_id,position_id,starts_at,ends_at,note,pub,removed_at,changed_at';

// ── THE WEEK ────────────────────────────────────────────────────────────────────
// { restaurantId, week: any day of it }. Builders get the draft (the rows as they are, with what changed since the last
// Publish); everyone else gets the published week.
export async function schedWeek(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  const today = todayService(w.tz);
  const start = weekStartOf(cleanDay(body.week) || today);
  const end = addDays(start, 6);
  const [shifts, offs, avail, counts, weekRow, reqs, waiting] = await Promise.all([
    sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${start}&service_date=lte.${end}&select=${SHIFT_COLS}&order=starts_at.asc,id.asc&limit=2000`),
    sb(`/staff_time_off?restaurant_id=eq.${w.rid}&status=in.(approved,waiting)&from_date=lte.${end}&to_date=gte.${start}&select=id,taster_id,from_date,to_date,status`),
    sb(`/staff_availability?restaurant_id=eq.${w.rid}&select=taster_id,weekday,kind,at_time`),
    sb('/rpc/hf_day_counts', { method: 'POST', body: JSON.stringify({ p_restaurant: w.rid, p_from: start, p_to: end }) }),
    sb(`/staff_schedule_weeks?restaurant_id=eq.${w.rid}&week_start=eq.${start}&select=published_at,published_by`),
    w.canBuild ? sb(`/staff_shift_requests?restaurant_id=eq.${w.rid}&status=eq.taken&select=id`) : null,
    w.canBuild ? sb(`/staff_time_off?restaurant_id=eq.${w.rid}&status=eq.waiting&to_date=gte.${today}&select=id`) : null,
  ]);
  if (!shifts.ok || !Array.isArray(shifts.data)) return res.status(502).json({ error: 'Could not read the schedule (the database answered ' + shifts.status + ').' });
  const guests = {};
  (counts && counts.ok && Array.isArray(counts.data) ? counts.data : []).forEach((r) => { guests[r.day] = Number(r.people) || 0; });

  const rows = [];
  let changes = 0;
  shifts.data.forEach((row) => {
    if (w.canBuild) {
      const changed = !sameFace(row) || !!row.removed_at;
      if (changed) changes += 1;
      if (row.removed_at) return;
      rows.push({ ...dress(row, face(row, false), w.tz), changed, published: !!row.pub });
    } else {
      if (!row.pub) return;
      rows.push(dress(row, face(row, true), w.tz));
    }
  });
  const people = Object.values(w.team.people).map((p) => ({ tasterId: p.tasterId, name: p.name, role: p.role, positionId: p.positionId }));
  const order = {};
  w.team.positions.forEach((p, i) => { order[p.id] = i; });
  people.sort((a, b) => (a.positionId == null ? 999 : order[a.positionId]) - (b.positionId == null ? 999 : order[b.positionId]) || a.name.localeCompare(b.name));
  const published = weekRow.ok && Array.isArray(weekRow.data) && weekRow.data[0] ? weekRow.data[0] : null;
  let publishedBy = null;
  if (published && published.published_by) {
    const t = await sb(`/tasters?id=eq.${Number(published.published_by)}&select=first_name`);
    publishedBy = t.ok && Array.isArray(t.data) && t.data[0] ? String(t.data[0].first_name || '').trim().split(/\s+/)[0] || null : null;
  }
  return res.status(200).json({
    success: true, me: w.tasterId, canBuild: w.canBuild, today, timezone: w.tz,
    week: { start, end, label: weekLabel(start), days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(start, i);
      return { date, weekday: WEEKDAY[i], day: Number(date.slice(8, 10)), guests: guests[date] || 0, past: date < today };
    }) },
    positions: w.team.positions.map((p) => ({ id: Number(p.id), name: p.name, color: p.color })),
    people, shifts: rows,
    timeOff: (offs.ok && Array.isArray(offs.data) ? offs.data : []).filter((o) => o.status === 'approved')
      .map((o) => ({ tasterId: Number(o.taster_id), from: o.from_date, to: o.to_date })),
    unavailable: (avail.ok && Array.isArray(avail.data) ? avail.data : []).map((a) => ({ tasterId: Number(a.taster_id), weekday: Number(a.weekday), kind: a.kind, at: a.at_time ? String(a.at_time).slice(0, 5) : null })),
    changes: w.canBuild ? changes : undefined,
    publishedAt: published ? published.published_at : null, publishedBy,
    // every request waiting for an answer (any week): taken shifts, and time off not over yet
    toApprove: w.canBuild ? (reqs && reqs.ok && Array.isArray(reqs.data) ? reqs.data.length : 0) + (waiting && waiting.ok && Array.isArray(waiting.data) ? waiting.data.length : 0) : undefined,
  });
}

// What the week says about a person on a day: approved time off, can't work, or outside their hours.
async function warningsFor(rid, tasterId, date, from, to, name) {
  if (!tasterId) return [];
  const [off, av] = await Promise.all([
    sb(`/staff_time_off?restaurant_id=eq.${rid}&taster_id=eq.${tasterId}&status=eq.approved&from_date=lte.${date}&to_date=gte.${date}&select=id`),
    sb(`/staff_availability?restaurant_id=eq.${rid}&taster_id=eq.${tasterId}&weekday=eq.${weekdayOf(date)}&select=kind,at_time`),
  ]);
  const out = [];
  if (off.ok && Array.isArray(off.data) && off.data.length) out.push(`${name} has time off that day.`);
  const a = av.ok && Array.isArray(av.data) ? av.data[0] : null;
  if (a && a.kind === 'none') out.push(`${name} said they can't work on ${WEEKDAYS[weekdayOf(date)]}.`);
  else if (a && a.kind === 'from' && dayMin(from) < dayMin(String(a.at_time).slice(0, 5))) out.push(`${name} can work from ${clockWords(String(a.at_time).slice(0, 5))} on ${WEEKDAYS[weekdayOf(date)]}.`);
  else if (a && a.kind === 'until') {
    let end = dayMin(to); if (end <= dayMin(from)) end += 1440;
    if (end > dayMin(String(a.at_time).slice(0, 5))) out.push(`${name} can work until ${clockWords(String(a.at_time).slice(0, 5))} on ${WEEKDAYS[weekdayOf(date)]}.`);
  }
  return out;
}

// Another shift of the same person at the same time (the draft faces; removed ones do not count).
async function overlapOf(rid, tasterId, startMs, endMs, exceptId) {
  const got = await sb(`/staff_shifts?restaurant_id=eq.${rid}&taster_id=eq.${tasterId}&removed_at=is.null`
    + `&starts_at=lt.${new Date(endMs).toISOString()}&ends_at=gt.${new Date(startMs).toISOString()}&select=id,starts_at,ends_at,service_date`);
  if (!got.ok || !Array.isArray(got.data)) return { error: true };
  return { row: got.data.find((r) => Number(r.id) !== Number(exceptId)) || null };
}

// ── ADD, CHANGE OR REMOVE A SHIFT (builders) ─────────────────────────────────────
// { restaurantId, shift: { id?, date, from, to, tasterId|null, positionId|null, note } } or { restaurantId, shiftId, remove: true }
export async function schedSave(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h, { build: true });
  if (!w) return;
  const today = todayService(w.tz);
  if (body.remove === true) {
    const id = Number(body.shiftId);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which shift?' });
    const got = await sb(`/staff_shifts?id=eq.${id}&restaurant_id=eq.${w.rid}&select=${SHIFT_COLS}`);
    const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
    if (!row || row.removed_at) return res.status(404).json({ error: 'That shift is not there any more.' });
    if (row.service_date < addDays(today, -7)) return res.status(400).json({ error: 'Shifts more than a week old stay as they are.' });
    const done = row.pub
      ? await sb(`/staff_shifts?id=eq.${id}&removed_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ removed_at: new Date().toISOString(), changed_at: new Date().toISOString(), changed_by: w.tasterId }) })
      : await sb(`/staff_shifts?id=eq.${id}&pub=is.null`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    if (!done.ok) return res.status(502).json({ error: 'Could not remove the shift. Please try again.' });
    await sb(`/staff_shift_requests?shift_id=eq.${id}&status=in.(open,taken)`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled', decided_at: new Date().toISOString(), decided_by: w.tasterId }) });
    return res.status(200).json({ success: true, removed: id, published: !!row.pub });
  }

  const s = body.shift || {};
  const date = cleanDay(s.date), from = cleanClock(s.from), to = cleanClock(s.to);
  if (!date) return res.status(400).json({ error: 'Which day?' });
  if (!from || !to) return res.status(400).json({ error: 'Pick the start and the end of the shift.' });
  if (date < addDays(today, -7)) return res.status(400).json({ error: 'That day is more than a week ago.' });
  if (date > addDays(today, 120)) return res.status(400).json({ error: 'The schedule goes up to 4 months ahead.' });
  const span = shiftSpan(date, from, to, w.tz);
  if (span.error) return res.status(400).json({ error: span.error });
  const person = s.tasterId === null || s.tasterId === undefined || s.tasterId === '' ? null : Number(s.tasterId);
  if (person !== null && !w.team.people[person]) return res.status(400).json({ error: 'That person is not on the team here.' });
  const positionId = s.positionId === null || s.positionId === undefined || s.positionId === '' ? null : Number(s.positionId);
  if (positionId !== null && !w.team.pos[positionId]) return res.status(400).json({ error: 'That position is not here.' });
  const note = typeof s.note === 'string' && s.note.trim() ? s.note.trim().replace(/\s+/g, ' ') : null;
  if (note && Array.from(note).length > 120) return res.status(400).json({ error: 'A note is at most 120 letters.' });
  if (note && /[<>]/.test(note)) return res.status(400).json({ error: 'A note cannot have < or >.' });

  const id = s.id === undefined || s.id === null ? null : Number(s.id);
  let before = null;
  if (id !== null) {
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which shift?' });
    const got = await sb(`/staff_shifts?id=eq.${id}&restaurant_id=eq.${w.rid}&select=${SHIFT_COLS}`);
    before = got.ok && Array.isArray(got.data) ? got.data[0] : null;
    if (!before || before.removed_at) return res.status(404).json({ error: 'That shift is not there any more.' });
  }
  if (person !== null) {
    const o = await overlapOf(w.rid, person, span.startMs, span.endMs, id);
    if (o.error) return res.status(502).json({ error: 'Could not check the other shifts. Please try again.' });
    if (o.row) {
      const l = localOf(Date.parse(o.row.starts_at), w.tz), e = localOf(Date.parse(o.row.ends_at), w.tz);
      return res.status(409).json({ error: `${w.team.people[person].name} already works ${clockWords(l.clock)} – ${clockWords(e.clock)} on ${dayLabel(o.row.service_date)}.` });
    }
  }
  const now = new Date().toISOString();
  const fields = { service_date: date, taster_id: person, position_id: positionId, starts_at: new Date(span.startMs).toISOString(),
    ends_at: new Date(span.endMs).toISOString(), note, changed_at: now, changed_by: w.tasterId };
  const saved = id === null
    ? await sb('/staff_shifts', { method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ restaurant_id: w.rid, ...fields, created_by: w.tasterId }) })
    : await sb(`/staff_shifts?id=eq.${id}&restaurant_id=eq.${w.rid}&removed_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify(fields) });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data[0]) {
    if (saved.status === 404 || (saved.data && saved.data.code === '42P01')) return res.status(409).json(NOT_READY);
    return res.status(502).json({ error: 'Could not save the shift (the database answered ' + saved.status + ').' });
  }
  // A changed person: an offer or a pick-up of this shift is over.
  if (before && Number(before.taster_id) !== Number(person)) {
    await sb(`/staff_shift_requests?shift_id=eq.${id}&status=in.(open,taken)`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'cancelled', decided_at: now, decided_by: w.tasterId }) });
  }
  const row = saved.data[0];
  const warn = person !== null ? await warningsFor(w.rid, person, date, from, to, w.team.people[person].name) : [];
  return res.status(200).json({ success: true, shift: { ...dress(row, face(row, false), w.tz), changed: !sameFace(row), published: !!row.pub }, warn });
}

// ── COPY LAST WEEK (builders) ─────────────────────────────────────────────────────
export async function schedCopy(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h, { build: true });
  if (!w) return;
  const today = todayService(w.tz);
  const start = weekStartOf(cleanDay(body.week) || today), end = addDays(start, 6);
  if (end < today) return res.status(400).json({ error: 'That week is over.' });
  const [here, last] = await Promise.all([
    sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${start}&service_date=lte.${end}&removed_at=is.null&select=id&limit=1`),
    sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${addDays(start, -7)}&service_date=lte.${addDays(start, -1)}&removed_at=is.null&select=${SHIFT_COLS}&limit=2000`),
  ]);
  if (!here.ok || !last.ok) return res.status(502).json({ error: 'Could not read the schedule. Please try again.' });
  if (Array.isArray(here.data) && here.data.length) return res.status(409).json({ error: 'This week already has shifts. Copy last week only into an empty week.' });
  const src = Array.isArray(last.data) ? last.data : [];
  if (!src.length) return res.status(404).json({ error: 'Last week has no shifts to copy.' });
  const now = new Date().toISOString();
  const rows = [];
  for (const r of src) {
    const date = addDays(r.service_date, 7);
    if (date < today) continue;                       // the days already gone of this week
    const a = localOf(Date.parse(r.starts_at), w.tz), b = localOf(Date.parse(r.ends_at), w.tz);
    const span = shiftSpan(date, a.clock, b.clock, w.tz);
    if (span.error) continue;
    const person = r.taster_id !== null && w.team.people[Number(r.taster_id)] ? Number(r.taster_id) : null;   // left the team: open
    rows.push({ restaurant_id: w.rid, service_date: date, taster_id: person,
      position_id: r.position_id !== null && w.team.pos[Number(r.position_id)] ? Number(r.position_id) : null,
      starts_at: new Date(span.startMs).toISOString(), ends_at: new Date(span.endMs).toISOString(), note: r.note || null,
      created_by: w.tasterId, changed_by: w.tasterId, changed_at: now });
  }
  if (!rows.length) return res.status(404).json({ error: 'Nothing left to copy: those days are over.' });
  const saved = await sb('/staff_shifts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) });
  if (!saved.ok) return res.status(502).json({ error: 'Could not copy the week (the database answered ' + saved.status + ').' });
  return res.status(200).json({ success: true, copied: Array.isArray(saved.data) ? saved.data.length : rows.length });
}

// ── PUBLISH (builders) ──────────────────────────────────────────────────────────
export async function schedPublish(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h, { build: true });
  if (!w) return;
  const today = todayService(w.tz);
  const start = weekStartOf(cleanDay(body.week) || today), end = addDays(start, 6);
  const got = await sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${start}&service_date=lte.${end}&select=${SHIFT_COLS}&limit=2000`);
  if (!got.ok || !Array.isArray(got.data)) return res.status(502).json({ error: 'Could not read the schedule. Please try again.' });
  const touched = new Set();        // people whose published week changed
  const newOpen = [];               // open shifts the team sees for the first time (or again)
  let n = 0;
  for (const row of got.data) {
    if (row.removed_at) {
      if (row.pub && row.pub.taster_id != null) touched.add(Number(row.pub.taster_id));
      const del = await sb(`/staff_shifts?id=eq.${Number(row.id)}&removed_at=not.is.null`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (!del.ok) return res.status(502).json({ error: 'Could not publish (the database answered ' + del.status + '). Nothing else was sent.' });
      n += 1; continue;
    }
    if (sameFace(row)) continue;
    if (row.pub && row.pub.taster_id != null) touched.add(Number(row.pub.taster_id));
    if (row.taster_id !== null) touched.add(Number(row.taster_id));
    if (row.taster_id === null && (!row.pub || row.pub.taster_id != null || Date.parse(row.pub.starts_at) !== Date.parse(row.starts_at))) newOpen.push(row);
    const up = await sb(`/staff_shifts?id=eq.${Number(row.id)}&removed_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ pub: pubOf(row) }),
    });
    if (!up.ok) return res.status(502).json({ error: 'Could not publish (the database answered ' + up.status + ').' });
    n += 1;
  }
  const now = new Date().toISOString();
  await sb('/staff_schedule_weeks?on_conflict=restaurant_id,week_start', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ restaurant_id: w.rid, week_start: start, published_at: now, published_by: w.tasterId }),
  });

  // Each person whose week changed: their shifts now.
  let told = 0;
  if (touched.size) {
    const mine = await sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${start}&service_date=lte.${end}&pub=not.is.null&select=pub`);
    const per = {};
    (mine.ok && Array.isArray(mine.data) ? mine.data : []).forEach((r) => {
      const t = r.pub && r.pub.taster_id != null ? Number(r.pub.taster_id) : null;
      if (t === null) return;
      const m = Math.round((Date.parse(r.pub.ends_at) - Date.parse(r.pub.starts_at)) / 60000);
      per[t] = per[t] || { n: 0, m: 0 }; per[t].n += 1; per[t].m += m;
    });
    for (const t of touched) {
      const x = per[t];
      const words = x ? `Your shifts for ${weekLabel(start)}: ${x.n} shift${x.n === 1 ? '' : 's'}, ${hoursOf(x.m)} h.`
                      : `You have no shifts for ${weekLabel(start)} any more.`;
      told += await tell(w.rid, [t], words, start);
    }
  }
  // Open shifts: the people of that position (or everyone, for an open shift with no position).
  for (const row of newOpen) {
    const a = localOf(Date.parse(row.starts_at), w.tz), b = localOf(Date.parse(row.ends_at), w.tz);
    const posName = row.position_id !== null && w.team.pos[row.position_id] ? ' · ' + w.team.pos[row.position_id].name : '';
    const ids = Object.values(w.team.people).filter((p) => row.position_id === null || p.positionId === Number(row.position_id)).map((p) => p.tasterId);
    told += await tell(w.rid, ids, `Open shift: ${dayLabel(row.service_date)} · ${clockWords(a.clock)} – ${clockWords(b.clock)}${posName}. Tap to pick it up.`, row.service_date, { except: w.tasterId });
  }
  await tellChange(w.rid, w.tasterId, `published the schedule for ${weekLabel(start)}`, { go: 'schedule' });
  return res.status(200).json({ success: true, published: n, people: touched.size, told, publishedAt: now });
}

// ── MY SHIFTS (everyone on the team) ────────────────────────────────────────────
export async function schedMine(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  const today = todayService(w.tz);
  const start = weekStartOf(today), until = addDays(today, 42);
  const [shifts, offers, myReqs, offs, avail] = await Promise.all([
    sb(`/staff_shifts?restaurant_id=eq.${w.rid}&service_date=gte.${addDays(start, 0)}&service_date=lte.${until}&pub=not.is.null&select=${SHIFT_COLS}&order=starts_at.asc&limit=2000`),
    sb(`/staff_shift_requests?restaurant_id=eq.${w.rid}&status=in.(open,taken)&select=id,shift_id,kind,from_taster,to_taster,status`),
    sb(`/staff_shift_requests?restaurant_id=eq.${w.rid}&or=(from_taster.eq.${w.tasterId},to_taster.eq.${w.tasterId})&status=in.(open,taken,approved,declined)&order=created_at.desc&limit=20&select=id,shift_id,kind,from_taster,to_taster,status,created_at,decided_at`),
    sb(`/staff_time_off?restaurant_id=eq.${w.rid}&taster_id=eq.${w.tasterId}&to_date=gte.${addDays(today, -30)}&status=neq.cancelled&order=from_date.asc&select=id,from_date,to_date,note,status,decided_at`),
    sb(`/staff_availability?restaurant_id=eq.${w.rid}&taster_id=eq.${w.tasterId}&select=weekday,kind,at_time`),
  ]);
  if (!shifts.ok || !Array.isArray(shifts.data)) return res.status(502).json({ error: 'Could not read the schedule (the database answered ' + shifts.status + ').' });
  const live = (offers.ok && Array.isArray(offers.data) ? offers.data : []);
  const liveBy = {};
  live.forEach((r) => { liveBy[r.shift_id] = r; });
  const now = Date.now();
  const myPos = w.me ? w.me.positionId : null;
  const mine = [], open = [], offered = [];
  let weekMin = 0;
  shifts.data.forEach((row) => {
    const f = face(row, true);
    const d = dress(row, f, w.tz);
    const r = liveBy[row.id];
    if (f.tasterId === w.tasterId) {
      if (row.service_date >= start && row.service_date <= addDays(start, 6)) weekMin += d.minutes;
      if (Date.parse(d.endsAt) <= now) { if (row.service_date >= start) mine.push({ ...d, past: true }); return; }
      mine.push({ ...d, offered: !!(r && r.kind === 'offer' && Number(r.from_taster) === w.tasterId), takenBy: r && r.status === 'taken' && r.to_taster ? (w.team.people[r.to_taster] || {}).name || null : null,
        requestId: r && Number(r.from_taster) === w.tasterId ? Number(r.id) : null });
      return;
    }
    if (Date.parse(d.startsAt) <= now || row.removed_at) return;
    const fits = f.positionId === null || f.positionId === myPos;
    if (f.tasterId === null && fits) {
      open.push({ ...d, asked: !!(r && Number(r.to_taster) === w.tasterId), requestId: r && Number(r.to_taster) === w.tasterId ? Number(r.id) : null, someoneAsked: !!(r && Number(r.to_taster) !== w.tasterId) });
    } else if (r && r.kind === 'offer' && fits && (r.status === 'open' || Number(r.to_taster) === w.tasterId)) {
      offered.push({ ...d, by: (w.team.people[f.tasterId] || {}).name || 'Someone', asked: Number(r.to_taster) === w.tasterId, requestId: Number(r.id) });
    }
  });
  const pname = (id) => (id && w.team.people[id] ? w.team.people[id].name : null);
  const shiftOf = {};
  shifts.data.forEach((row) => { shiftOf[row.id] = row; });
  return res.status(200).json({
    success: true, me: w.tasterId, canBuild: w.canBuild, today, weekStart: start, weekLabel: weekLabel(start), weekHours: hoursOf(weekMin),
    position: myPos && w.team.pos[myPos] ? { id: myPos, name: w.team.pos[myPos].name, color: w.team.pos[myPos].color } : null,
    positions: w.team.positions.map((p) => ({ id: Number(p.id), name: p.name, color: p.color })),
    shifts: mine, open, offered,
    requests: (myReqs.ok && Array.isArray(myReqs.data) ? myReqs.data : []).map((r) => {
      const row = shiftOf[r.shift_id];
      const d = row ? dress(row, face(row, true), w.tz) : null;
      return { id: Number(r.id), kind: r.kind, status: r.status, mine: Number(r.from_taster) === w.tasterId ? 'offer' : 'take',
        other: pname(Number(r.from_taster) === w.tasterId ? r.to_taster : r.from_taster), shift: d };
    }),
    timeOff: (offs.ok && Array.isArray(offs.data) ? offs.data : []).map((o) => ({ id: Number(o.id), from: o.from_date, to: o.to_date, note: o.note || null, status: o.status })),
    availability: Array.from({ length: 7 }, (_, i) => {
      const a = (avail.ok && Array.isArray(avail.data) ? avail.data : []).find((x) => Number(x.weekday) === i);
      return { weekday: i, kind: a ? a.kind : 'all', at: a && a.at_time ? String(a.at_time).slice(0, 5) : null };
    }),
  });
}

// ── TIME OFF (everyone) ─────────────────────────────────────────────────────────
export async function timeOffAsk(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  if (!w.me) return res.status(403).json({ error: 'Time off is for the people on the team.' });
  const today = todayService(w.tz);
  const from = cleanDay(body.from), to = cleanDay(body.to) || cleanDay(body.from);
  if (!from || !to) return res.status(400).json({ error: 'Pick the first and the last day.' });
  if (from < today) return res.status(400).json({ error: 'Time off starts today or later.' });
  if (to < from) return res.status(400).json({ error: 'The last day is before the first day.' });
  if (to > addDays(from, 30)) return res.status(400).json({ error: 'Ask for at most 31 days at a time.' });
  if (from > addDays(today, 365)) return res.status(400).json({ error: 'That is more than a year away.' });
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().replace(/\s+/g, ' ') : null;
  if (note && Array.from(note).length > 200) return res.status(400).json({ error: 'The reason is at most 200 letters.' });
  if (note && /[<>]/.test(note)) return res.status(400).json({ error: 'The reason cannot have < or >.' });
  const waiting = await sb(`/staff_time_off?restaurant_id=eq.${w.rid}&taster_id=eq.${w.tasterId}&status=eq.waiting&select=id,from_date,to_date`);
  if (!waiting.ok) return res.status(waiting.status === 404 ? 409 : 502).json(waiting.status === 404 ? NOT_READY : { error: 'Could not read your requests. Please try again.' });
  const list = Array.isArray(waiting.data) ? waiting.data : [];
  if (list.length >= 10) return res.status(429).json({ error: 'You have 10 requests waiting. Wait for an answer first.' });
  if (list.some((o) => o.from_date <= to && o.to_date >= from)) return res.status(409).json({ error: 'You already asked for some of those days.' });
  const saved = await sb('/staff_time_off', { method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ restaurant_id: w.rid, taster_id: w.tasterId, from_date: from, to_date: to, note }) });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data[0]) return res.status(502).json({ error: 'Could not send it (the database answered ' + saved.status + ').' });
  const days = from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
  await tell(w.rid, builderIds(w.team), `${w.me.name} asks for time off: ${days}.`, from, { except: w.tasterId });
  return res.status(200).json({ success: true, id: Number(saved.data[0].id) });
}

export async function timeOffCancel(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which request?' });
  const today = todayService(w.tz);
  const got = await sb(`/staff_time_off?id=eq.${id}&restaurant_id=eq.${w.rid}&taster_id=eq.${w.tasterId}&select=id,status,from_date,to_date`);
  const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!row) return res.status(404).json({ error: 'That request is not there.' });
  if (!['waiting', 'approved'].includes(row.status) || row.to_date < today) return res.status(409).json({ error: 'That request can no longer be cancelled.' });
  const done = await sb(`/staff_time_off?id=eq.${id}&status=in.(waiting,approved)`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'cancelled' }) });
  if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: 'That request can no longer be cancelled.' });
  if (row.status === 'approved') {
    const days = row.from_date === row.to_date ? dayLabel(row.from_date) : `${dayLabel(row.from_date)} – ${dayLabel(row.to_date)}`;
    await tell(w.rid, builderIds(w.team), `${(w.me || {}).name || 'Someone'} cancelled their time off: ${days}.`, row.from_date, { except: w.tasterId });
  }
  return res.status(200).json({ success: true });
}

// ── AVAILABILITY (everyone, their own) ───────────────────────────────────────────
// { restaurantId, days: [{ weekday 0–6, kind: all|from|until|none, at: 'HH:MM' }] }
export async function availabilitySave(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  if (!w.me) return res.status(403).json({ error: 'Availability is for the people on the team.' });
  const days = Array.isArray(body.days) ? body.days : null;
  if (!days || days.length !== 7) return res.status(400).json({ error: 'Send the seven days.' });
  const rows = [];
  const seen = new Set();
  for (const d of days) {
    const wd = Number(d && d.weekday), kind = d && d.kind;
    if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) return res.status(400).json({ error: 'Each day once, Monday to Sunday.' });
    seen.add(wd);
    if (!['all', 'from', 'until', 'none'].includes(kind)) return res.status(400).json({ error: 'All day, from, until or can\'t work.' });
    const at = kind === 'from' || kind === 'until' ? cleanClock(d.at) : null;
    if ((kind === 'from' || kind === 'until') && !at) return res.status(400).json({ error: `Pick a time for ${WEEKDAY[wd]}.` });
    rows.push({ restaurant_id: w.rid, taster_id: w.tasterId, weekday: wd, kind, at_time: at, updated_at: new Date().toISOString() });
  }
  const saved = await sb('/staff_availability?on_conflict=restaurant_id,taster_id,weekday', {
    method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  if (!saved.ok) return res.status(saved.status === 404 ? 409 : 502).json(saved.status === 404 ? NOT_READY : { error: 'Could not save it (the database answered ' + saved.status + ').' });
  return res.status(200).json({ success: true });
}

// ── OFFER A SHIFT, TAKE ONE, PICK UP AN OPEN ONE (everyone) ────────────────────────
async function liveShift(w, shiftId) {
  const got = await sb(`/staff_shifts?id=eq.${Number(shiftId)}&restaurant_id=eq.${w.rid}&select=${SHIFT_COLS}`);
  const row = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!row || !row.pub || row.removed_at) return null;
  return row;
}

export async function shiftOffer(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  const row = await liveShift(w, body.shiftId);
  if (!row || Number(row.pub.taster_id) !== w.tasterId || Number(row.taster_id) !== w.tasterId) return res.status(404).json({ error: 'That shift is not yours, or it changed. Pull down to see the schedule again.' });
  if (Date.parse(row.pub.starts_at) <= Date.now()) return res.status(409).json({ error: 'That shift has started.' });
  const saved = await sb('/staff_shift_requests', { method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ restaurant_id: w.rid, shift_id: Number(row.id), kind: 'offer', from_taster: w.tasterId, status: 'open' }) });
  if (!saved.ok) {
    if (saved.status === 409 || (saved.data && saved.data.code === '23505')) return res.status(409).json({ error: 'That shift is already offered.' });
    return res.status(502).json({ error: 'Could not offer it (the database answered ' + saved.status + ').' });
  }
  const d = dress(row, face(row, true), w.tz);
  const posName = d.positionId && w.team.pos[d.positionId] ? ' · ' + w.team.pos[d.positionId].name : '';
  const ids = Object.values(w.team.people).filter((p) => d.positionId === null || p.positionId === d.positionId).map((p) => p.tasterId);
  await tell(w.rid, ids, `${w.me.name} offers a shift: ${dayLabel(d.date)} · ${d.fromWords} – ${d.toWords}${posName}.`, d.date, { except: w.tasterId });
  return res.status(200).json({ success: true, id: Number(saved.data[0].id) });
}

export async function shiftTake(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  if (!w.me) return res.status(403).json({ error: 'Shifts are for the people on the team.' });
  const row = await liveShift(w, body.shiftId);
  if (!row) return res.status(404).json({ error: 'That shift is not there any more.' });
  const f = face(row, true);
  if (Date.parse(f.startsAt) <= Date.now()) return res.status(409).json({ error: 'That shift has started.' });
  if (f.positionId !== null && f.positionId !== w.me.positionId) {
    return res.status(403).json({ error: `That shift is for ${(w.team.pos[f.positionId] || {}).name || 'another position'}.` });
  }
  if (f.tasterId === w.tasterId) return res.status(409).json({ error: 'That shift is already yours.' });
  const o = await overlapOf(w.rid, w.tasterId, Date.parse(f.startsAt), Date.parse(f.endsAt), row.id);
  if (o.error) return res.status(502).json({ error: 'Could not check your other shifts. Please try again.' });
  if (o.row) return res.status(409).json({ error: 'You already work at that time.' });
  const now = new Date().toISOString();
  let reqId = null, words;
  const d = dress(row, f, w.tz);
  const when = `${dayLabel(d.date)} · ${d.fromWords} – ${d.toWords}`;
  if (f.tasterId === null) {
    if (row.taster_id !== null) return res.status(409).json({ error: 'That shift was just given to someone.' });
    const saved = await sb('/staff_shift_requests', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: w.rid, shift_id: Number(row.id), kind: 'pickup', to_taster: w.tasterId, status: 'taken', taken_at: now }) });
    if (!saved.ok) {
      if (saved.status === 409 || (saved.data && saved.data.code === '23505')) return res.status(409).json({ error: 'Someone already asked for that shift.' });
      return res.status(502).json({ error: 'Could not ask for it (the database answered ' + saved.status + ').' });
    }
    reqId = Number(saved.data[0].id);
    words = `${w.me.name} wants to pick up the open shift: ${when}.`;
  } else {
    const taken = await sb(`/staff_shift_requests?shift_id=eq.${Number(row.id)}&restaurant_id=eq.${w.rid}&kind=eq.offer&status=eq.open`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'taken', to_taster: w.tasterId, taken_at: now }) });
    if (!taken.ok || !Array.isArray(taken.data) || !taken.data.length) return res.status(409).json({ error: 'That shift is not offered any more, or someone took it first.' });
    reqId = Number(taken.data[0].id);
    words = `${w.me.name} wants to take ${(w.team.people[f.tasterId] || {}).name || 'a'}'s shift: ${when}.`;
    await tell(w.rid, [f.tasterId], `${w.me.name} wants to take your shift: ${when}. A manager decides.`, d.date);
  }
  await tell(w.rid, builderIds(w.team), words, d.date, { except: w.tasterId });
  return res.status(200).json({ success: true, id: reqId });
}

// Take back an offer, or a "take" / "pick up" that is still waiting.
export async function shiftRequestCancel(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h);
  if (!w) return;
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which request?' });
  const got = await sb(`/staff_shift_requests?id=eq.${id}&restaurant_id=eq.${w.rid}&select=id,kind,from_taster,to_taster,status`);
  const r = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!r || !['open', 'taken'].includes(r.status)) return res.status(404).json({ error: 'That request is not waiting any more.' });
  const mineOffer = r.kind === 'offer' && Number(r.from_taster) === w.tasterId;
  const mineTake = Number(r.to_taster) === w.tasterId;
  if (!mineOffer && !mineTake) return res.status(403).json({ error: 'That request is not yours.' });
  // An offer taken back: over. A "take" of an offer taken back: the offer is open again. A pick-up taken back: over.
  const patch = mineOffer || r.kind === 'pickup' ? { status: 'cancelled', decided_at: new Date().toISOString(), decided_by: w.tasterId }
                                               : { status: 'open', to_taster: null, taken_at: null };
  const done = await sb(`/staff_shift_requests?id=eq.${id}&status=eq.${r.status}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
  if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: 'That request just changed. Look again.' });
  return res.status(200).json({ success: true });
}

// ── WHAT THE BUILDERS APPROVE ─────────────────────────────────────────────────────
async function weekMinutes(rid, tasterId, date, tz, extraMin = 0) {
  const start = weekStartOf(date), end = addDays(start, 6);
  const got = await sb(`/staff_shifts?restaurant_id=eq.${rid}&taster_id=eq.${tasterId}&removed_at=is.null&service_date=gte.${start}&service_date=lte.${end}&select=starts_at,ends_at`);
  const m = (got.ok && Array.isArray(got.data) ? got.data : []).reduce((s, r) => s + Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000), 0);
  return m + extraMin;
}

export async function schedRequests(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h, { build: true });
  if (!w) return;
  const today = todayService(w.tz);
  const [offs, reqs] = await Promise.all([
    sb(`/staff_time_off?restaurant_id=eq.${w.rid}&status=eq.waiting&to_date=gte.${today}&order=from_date.asc&select=id,taster_id,from_date,to_date,note,created_at`),
    sb(`/staff_shift_requests?restaurant_id=eq.${w.rid}&status=eq.taken&order=taken_at.asc&select=id,shift_id,kind,from_taster,to_taster,taken_at`),
  ]);
  if (!offs.ok || !reqs.ok) return res.status(502).json({ error: 'Could not read the requests. Please try again.' });
  const out = [];
  for (const o of (Array.isArray(offs.data) ? offs.data : [])) {
    const p = w.team.people[Number(o.taster_id)];
    const shifts = await sb(`/staff_shifts?restaurant_id=eq.${w.rid}&taster_id=eq.${Number(o.taster_id)}&removed_at=is.null&service_date=gte.${o.from_date}&service_date=lte.${o.to_date}&select=id`);
    const n = shifts.ok && Array.isArray(shifts.data) ? shifts.data.length : 0;
    out.push({ kind: 'timeoff', id: Number(o.id), who: p ? p.name : 'Someone', from: o.from_date, to: o.to_date,
      days: o.from_date === o.to_date ? dayLabel(o.from_date) : `${dayLabel(o.from_date)} – ${dayLabel(o.to_date)}`,
      note: o.note || null, warn: n ? `${p ? p.name : 'They'} ${n === 1 ? 'has a shift' : 'has ' + n + ' shifts'} those days.` : null, at: o.created_at });
  }
  for (const r of (Array.isArray(reqs.data) ? reqs.data : [])) {
    const row = await liveShift(w, r.shift_id);
    if (!row) continue;
    const d = dress(row, face(row, true), w.tz);
    const taker = w.team.people[Number(r.to_taster)];
    const m = await weekMinutes(w.rid, Number(r.to_taster), d.date, w.tz, d.minutes);
    out.push({ kind: r.kind === 'offer' ? 'swap' : 'pickup', id: Number(r.id), who: taker ? taker.name : 'Someone',
      from: r.kind === 'offer' ? ((w.team.people[Number(r.from_taster)] || {}).name || 'Someone') : null,
      shift: { ...d, position: d.positionId && w.team.pos[d.positionId] ? w.team.pos[d.positionId].name : null },
      hours: hoursOf(m), over40: m > 40 * 60, at: r.taken_at });
  }
  return res.status(200).json({ success: true, requests: out });
}

// { restaurantId, kind: 'timeoff' | 'shift', id, approve: true|false }
export async function schedDecide(req, res, body, tasterId, h) {
  const w = await who(res, tasterId, body, req, h, { build: true });
  if (!w) return;
  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which request?' });
  if (typeof body.approve !== 'boolean') return res.status(400).json({ error: 'Approve or decline?' });
  const now = new Date().toISOString();
  if (body.kind === 'timeoff') {
    const got = await sb(`/staff_time_off?id=eq.${id}&restaurant_id=eq.${w.rid}&select=id,taster_id,from_date,to_date,status`);
    const o = got.ok && Array.isArray(got.data) ? got.data[0] : null;
    if (!o || o.status !== 'waiting') return res.status(404).json({ error: 'That request is not waiting any more.' });
    if (Number(o.taster_id) === w.tasterId && w.level < LEVEL.owner) return res.status(403).json({ error: 'Someone else decides your own time off.' });
    const done = await sb(`/staff_time_off?id=eq.${id}&status=eq.waiting`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: body.approve ? 'approved' : 'declined', decided_at: now, decided_by: w.tasterId }) });
    if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: 'Someone answered it a moment ago.' });
    const days = o.from_date === o.to_date ? dayLabel(o.from_date) : `${dayLabel(o.from_date)} – ${dayLabel(o.to_date)}`;
    await tell(w.rid, [o.taster_id], body.approve ? `Your time off is approved: ${days}.` : `Your time off was declined: ${days}. Talk to a manager.`, o.from_date);
    return res.status(200).json({ success: true });
  }
  if (body.kind !== 'shift') return res.status(400).json({ error: 'Which kind of request?' });
  const got = await sb(`/staff_shift_requests?id=eq.${id}&restaurant_id=eq.${w.rid}&select=id,shift_id,kind,from_taster,to_taster,status`);
  const r = got.ok && Array.isArray(got.data) ? got.data[0] : null;
  if (!r || r.status !== 'taken') return res.status(404).json({ error: 'That request is not waiting any more.' });
  if (Number(r.to_taster) === w.tasterId && w.level < LEVEL.owner) return res.status(403).json({ error: 'Someone else decides a shift you asked for.' });
  const row = await liveShift(w, r.shift_id);
  if (!row) return res.status(404).json({ error: 'That shift is not there any more.' });
  const d = dress(row, face(row, true), w.tz);
  const when = `${dayLabel(d.date)} · ${d.fromWords} – ${d.toWords}`;
  if (!body.approve) {
    const done = await sb(`/staff_shift_requests?id=eq.${id}&status=eq.taken`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'declined', decided_at: now, decided_by: w.tasterId }) });
    if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: 'Someone answered it a moment ago.' });
    await tell(w.rid, [r.to_taster], `Not this time: the shift ${when} stays as it was.`, d.date);
    if (r.kind === 'offer') await tell(w.rid, [r.from_taster], `Your shift ${when} is still yours: the swap was declined.`, d.date);
    return res.status(200).json({ success: true });
  }
  const taker = Number(r.to_taster);
  if (!w.team.people[taker]) return res.status(409).json({ error: 'That person is not on the team any more.' });
  const expected = r.kind === 'offer' ? Number(r.from_taster) : null;
  if ((row.taster_id === null ? null : Number(row.taster_id)) !== expected || (row.pub.taster_id == null ? null : Number(row.pub.taster_id)) !== expected) {
    return res.status(409).json({ error: 'That shift was changed in the meantime. Decline this request and look at the shift again.' });
  }
  const o = await overlapOf(w.rid, taker, Date.parse(row.starts_at), Date.parse(row.ends_at), row.id);
  if (o.error) return res.status(502).json({ error: 'Could not check the other shifts. Please try again.' });
  if (o.row) return res.status(409).json({ error: `${w.team.people[taker].name} already works at that time.` });
  const moved = await sb(`/staff_shifts?id=eq.${Number(row.id)}&restaurant_id=eq.${w.rid}&removed_at=is.null${expected === null ? '&taster_id=is.null' : '&taster_id=eq.' + expected}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ taster_id: taker, pub: { ...row.pub, taster_id: taker }, changed_at: now, changed_by: w.tasterId }) });
  if (!moved.ok || !Array.isArray(moved.data) || !moved.data.length) return res.status(409).json({ error: 'That shift was changed in the meantime.' });
  await sb(`/staff_shift_requests?id=eq.${id}&status=eq.taken`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved', decided_at: now, decided_by: w.tasterId }) });
  await tell(w.rid, [taker], `The shift is yours: ${when}.`, d.date);
  if (r.kind === 'offer') await tell(w.rid, [r.from_taster], `${w.team.people[taker].name} takes your shift: ${when}. You're off.`, d.date);
  return res.status(200).json({ success: true });
}
