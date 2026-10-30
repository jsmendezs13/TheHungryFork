// api/_lib/floor.js
//
// r46 (Sebastian, 29 Oct 16:55 → 23:10, "I love it! Let's do it!"): the table
// map on the manager page — Reservations → Map. Every action here is reached
// through api/reservations.js with an action name that starts with "map_", so
// the site still deploys as twelve functions.
//
//   · Each room is drawn once (a rectangle of squares; squares removed; a bar,
//     a door, objects with a name; round or square tables dragged into place).
//     Saving a room makes its seats and tables in Settings → Rooms the
//     drawing's, so online booking sells exactly what is drawn.
//   · In service: tap a table = busy, a clock starts; tap again = free. The
//     day's bookings sit on tables by themselves with their time; a booking
//     "Reserved" on a table (the pin) stays there, the others move to another
//     free table that fits when theirs gets busy. Tables can be joined
//     ("10+13") and separated again.
//
// Who may do what — from the database, on every request (as staff.js):
//   crew     (1) sees the map and works the tables: busy, free, join, separate,
//                and undo those — but never changes a booking (his rule: crew
//                change nothing about the bookings)
//   manager  (2) also: "their party is here" (Arrived), Reserved / not, seat a
//                walk-in on a table a booking needs, and draws the rooms
//   owner (3) and platform admin (4) can do all of that too
//
// Where a booking sits is worked out here, from the same data for everybody,
// so every phone shows the same map (placeBookings). The phones ask again every
// few seconds.

import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { loadBooking, clockIn } from './booking.js';
import { serviceToday, inServiceDay, addDays, gate, mark } from './staff.js';
import { tellChange } from './changes.js';

const readLimiter  = makeLimiter({ requests: 900, window: '10 m', prefix: 'resv:map:read' });
const writeLimiter = makeLimiter({ requests: 300, window: '10 m', prefix: 'resv:map:write' });

const MIN = 60 * 1000;
export const UNDO_MINUTES = 15;          // as the database: hf_map_reopen / hf_map_unseat
const NEEDS_SQL = 'The table map needs this update\'s SQL step (migration 32). Run it in Supabase, then try again.';

// How many squares a table takes: 2×2 up to 4 seats, then one more square across for every 2 seats.
export function footprint(seats) {
  const n = Number(seats) || 0;
  return { w: n <= 4 ? 2 : Math.min(10, Math.ceil(n / 2)), h: 2 };
}

// ── THE ROUTER ───────────────────────────────────────────────────────────────
export async function floor(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action !== 'map_get';
  if (!(await allow(writes ? writeLimiter : readLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  switch (action) {
    case 'map_get':      return getMap(req, res, body, tasterId);
    case 'map_save':     return saveRoom(req, res, body, tasterId);
    case 'map_seat':     return seat(req, res, body, tasterId);
    case 'map_free':     return free(req, res, body, tasterId);
    case 'map_reopen':   return reopen(req, res, body, tasterId);
    case 'map_unseat':   return unseat(req, res, body, tasterId);
    case 'map_pin':      return pin(req, res, body, tasterId);
    case 'map_join':     return join(req, res, body, tasterId);
    case 'map_separate': return separate(req, res, body, tasterId);
    default:             return res.status(400).json({ error: 'Unknown action.' });
  }
}

// ── READING THE MAP ──────────────────────────────────────────────────────────
// Everything the map needs, as the database has it now. null + an answer sent
// when it cannot be read.
async function load(res, rid) {
  const loaded = await loadBooking(rid);
  if (!loaded || loaded.error) {
    res.status(loaded && loaded.error ? 502 : 404).json({ error: loaded && loaded.error ? 'Could not read the booking settings.' : 'Restaurant not found.' });
    return null;
  }
  const s = loaded.settings || {};
  const timezone = s.timezone || 'America/New_York';
  const today = serviceToday(timezone);
  const next = addDays(today, 1);
  const [areas, plans, tables, sessions, joins, bookings] = await Promise.all([
    sb(`/restaurant_areas?restaurant_id=eq.${rid}&select=id,name,seats,tables,is_active,sort_order&order=sort_order.asc,id.asc`),
    sb(`/floor_plans?restaurant_id=eq.${rid}&select=area_id,cols,rows,cells,version`),
    sb(`/floor_tables?restaurant_id=eq.${rid}&select=number,area_id,seats,shape,x,y&order=number.asc`),
    sb(`/table_sessions?restaurant_id=eq.${rid}&ended_at=is.null&select=id,area_id,tables,reservation_id,auto,started_at&order=id.asc`),
    sb(`/table_joins?restaurant_id=eq.${rid}&service_date=eq.${today}&ended_at=is.null&select=id,area_id,tables&order=id.asc`),
    sb(`/reservations?restaurant_id=eq.${rid}&local_date=in.(${today},${next})&status=in.(booked,seated)` +
       '&select=id,area_id,guest_name,party_size,reserved_at,local_date,local_time,status,seated_at,table_number&order=reserved_at.asc,id.asc&limit=1000'),
  ]);
  if ([plans, tables, sessions, joins].some((x) => !x.ok && (x.status === 404 || x.status === 400))
      || (!bookings.ok && bookings.status === 400)) {
    res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
    return null;
  }
  if (![areas, plans, tables, sessions, joins, bookings].every((x) => x.ok && Array.isArray(x.data))) {
    res.status(502).json({ error: 'Could not read the map. Please try again in a moment.' });
    return null;
  }
  return {
    rid, timezone, today,
    settings: { holdMinutes: Number(s.hold_minutes) || 90, graceMinutes: Number(s.grace_minutes ?? 30), autoReleaseLate: s.auto_release_late !== false },
    areas: areas.data, plans: plans.data, tables: tables.data, sessions: sessions.data, joins: joins.data,
    bookings: bookings.data.filter((b) => inServiceDay(b, today)),
  };
}

// The tables a party can sit at: each table alone, or a group joined today.
// The group's key is its first table (the one listed first).
export function unitsOf(tables, joins) {
  const byArea = {};
  const joinOf = {};
  (joins || []).forEach((j) => j.tables.forEach((n) => { joinOf[n] = j; }));
  const seatsOf = {};
  tables.forEach((t) => { seatsOf[t.number] = t.seats; });
  tables.forEach((t) => {
    const a = Number(t.area_id);
    const list = byArea[a] || (byArea[a] = []);
    const j = joinOf[t.number];
    if (!j) list.push({ key: t.number, members: [t.number], seats: t.seats, area: a, joinId: null });
    else if (j.tables[0] === t.number) {
      list.push({ key: t.number, members: j.tables.slice(), seats: j.tables.reduce((n, m) => n + (seatsOf[m] || 0), 0), area: a, joinId: j.id });
    }
  });
  return byArea;
}

// Where every booking still to come sits — the same answer on every phone.
// Reserved first (it stays on its table), then by time; each other booking on
// the smallest table that fits, is free over its stay, and is not busy now if
// the booking is due within the sitting time. No such table: "No table yet".
// A late booking keeps its table until the restaurant's grace minutes run out
// (if "release late tables" is on), then lets it go.
export function placeBookings({ units, sessions, bookings, now, holdMinutes, graceMinutes, autoReleaseLate }) {
  const HOLD = holdMinutes * MIN;
  const busyKey = new Set();
  const all = Object.values(units).flat();
  (sessions || []).forEach((s) => all.forEach((u) => { if (u.members.some((m) => s.tables.includes(m))) busyKey.add(u.key); }));
  const place = {}, waiting = [], released = [], holds = {};
  const pending = [];
  bookings.forEach((b) => {
    if (b.status !== 'booked') return;
    const at = Date.parse(b.reserved_at);
    if (autoReleaseLate && now - at > graceMinutes * MIN) { released.push(b.id); return; }
    pending.push({ b, at });
  });
  pending.sort((x, y) => (y.b.table_number ? 1 : 0) - (x.b.table_number ? 1 : 0) || x.at - y.at || x.b.id - y.b.id);
  const clash = (key, at) => (holds[key] || []).some(([s, e]) => at < e && s < at + HOLD);
  const drawnAreas = new Set(Object.keys(units).map(Number).filter((a) => units[a].length));
  const listFor = (b) => { const area = b.area_id ? Number(b.area_id) : null; return area !== null ? units[area] || [] : all; };
  const fits = (u, b, at) => u.seats >= b.party_size && !(busyKey.has(u.key) && at - now < HOLD);
  const hold = (key, at, id) => { (holds[key] = holds[key] || []).push([at, at + HOLD, id]); };
  const unhold = (key, id) => { holds[key] = (holds[key] || []).filter((h) => h[2] !== id); };
  const stay = {};
  pending.forEach(({ b, at }) => {
    const area = b.area_id ? Number(b.area_id) : null;
    if (area !== null && !drawnAreas.has(area)) return;           // that room is not drawn yet: not on the map
    const list = listFor(b);
    let u = null;
    // Reserved stays where it is kept — unless those tables are too small for the party now (joined ones separated)
    if (b.table_number) u = list.find((x) => x.members.includes(Number(b.table_number)) && x.seats >= b.party_size) || null;
    if (!u) u = list.filter((x) => fits(x, b, at) && !clash(x.key, at)).sort((x, y) => x.seats - y.seats || x.key - y.key)[0] || null;
    stay[b.id] = { b, at };
    if (u) { place[b.id] = u.key; hold(u.key, at, b.id); }
    else waiting.push(b.id);
  });
  // A second look for each booking left without a table: a table it fits
  // whose only clash is ONE booking (not Reserved) that can sit elsewhere —
  // that one moves, and both have a table (a 2 on the 6-top leaves Mike's 6
  // nowhere to go, until the 2 moves to a 2-top).
  for (let i = 0; i < waiting.length; i++) {
    const { b, at } = stay[waiting[i]];
    const list = listFor(b);
    let done = false;
    for (const u of list.filter((x) => fits(x, b, at)).sort((x, y) => x.seats - y.seats || x.key - y.key)) {
      const blocking = (holds[u.key] || []).filter(([s, e]) => at < e && s < at + HOLD);
      if (blocking.length !== 1) continue;
      const other = stay[blocking[0][2]];
      if (!other || other.b.table_number) continue;
      const elsewhere = listFor(other.b).filter((x) => x.key !== u.key && fits(x, other.b, other.at) && !clash(x.key, other.at))
        .sort((x, y) => x.seats - y.seats || x.key - y.key)[0];
      if (!elsewhere) continue;
      unhold(u.key, other.b.id);
      place[other.b.id] = elsewhere.key; hold(elsewhere.key, other.at, other.b.id);
      place[b.id] = u.key; hold(u.key, at, b.id);
      done = true;
      break;
    }
    if (done) { waiting.splice(i, 1); i -= 1; }
  }
  return { place, waiting, released, busy: [...busyKey] };
}

// Brings the busy tables into line with the bookings, then dresses the map.
//  · A table busy for a booking that is no longer Arrived (Arrived undone on
//    the list) never was: that busy is taken away.
//  · A booking marked Arrived elsewhere (the list, a scanned QR) and never on
//    the map sits down by itself at its table, if one is free.
async function settle(state, tasterId) {
  let changed = false;
  const open = state.sessions.filter((s) => s.reservation_id);
  if (open.length) {
    const ids = [...new Set(open.map((s) => Number(s.reservation_id)))];
    const got = await sb(`/reservations?id=in.(${ids.join(',')})&select=id,status`);
    if (got.ok && Array.isArray(got.data)) {
      const status = {};
      got.data.forEach((r) => { status[r.id] = r.status; });
      for (const s of open) {
        const st = status[s.reservation_id];
        if (st && st !== 'seated' && st !== 'done') {
          await sb(`/table_sessions?id=eq.${Number(s.id)}&ended_at=is.null`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          changed = true;
        }
      }
    }
  }
  const hold = state.settings.holdMinutes * MIN, now = Date.now();
  const seated = state.bookings.filter((b) => b.status === 'seated' && b.seated_at && now - Date.parse(b.seated_at) < hold);
  if (seated.length) {
    const ever = await sb(`/table_sessions?reservation_id=in.(${seated.map((b) => Number(b.id)).join(',')})&select=reservation_id`);
    if (ever.ok && Array.isArray(ever.data)) {
      const had = new Set(ever.data.map((x) => Number(x.reservation_id)));
      const units = unitsOf(state.tables, state.joins);
      const todo = seated.filter((b) => !had.has(Number(b.id)));
      // the table the map was showing for them (as if still to come), else the smallest free one that fits
      const shown = placeBookings({ units, sessions: state.sessions, now, ...state.settings,
        bookings: state.bookings.map((b) => (todo.includes(b) ? { ...b, status: 'booked' } : b)) });
      const busy = new Set(shown.busy);
      for (const b of todo) {
        const area = b.area_id ? Number(b.area_id) : null;
        const list = area !== null ? units[area] || [] : Object.values(units).flat();
        if (!list.length) continue;
        let u = list.find((x) => x.key === shown.place[b.id] && !busy.has(x.key)) || null;
        if (!u) u = list.filter((x) => !busy.has(x.key) && x.seats >= b.party_size).sort((x, y) => x.seats - y.seats || x.key - y.key)[0];
        if (!u) continue;                                   // nowhere free: the map lists them under "No table yet"
        const r = await rpc('hf_map_seat', { p_restaurant: state.rid, p_area: u.area, p_tables: u.members, p_reservation: Number(b.id), p_auto: true, p_by: tasterId });
        if (r && r.ok) { busy.add(u.key); changed = true; }
      }
    }
  }
  return changed;
}

async function rpc(name, args) {
  const r = await sb(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return r.status === 404 ? { ok: false, reason: 'migration' } : null;
  return r.data[0];
}

function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'Guest'; }

// What the phone gets: the rooms (drawing and tables), the busy tables, the
// joins, the day's bookings still to come or sitting, and where each sits.
function dress(state, who) {
  const now = Date.now();
  const units = unitsOf(state.tables, state.joins);
  const placed = placeBookings({ units, sessions: state.sessions, bookings: state.bookings, now, ...state.settings });
  const plans = {};
  state.plans.forEach((p) => { plans[p.area_id] = p; });
  const tablesBy = {};
  state.tables.forEach((t) => { (tablesBy[t.area_id] = tablesBy[t.area_id] || []).push(t); });
  const sitting = {};
  state.sessions.forEach((s) => { if (s.reservation_id) sitting[s.reservation_id] = s.id; });
  return {
    success: true,
    level: who.level,
    can: { tables: who.level >= LEVEL.crew, bookings: who.level >= LEVEL.manager, draw: who.level >= LEVEL.manager },
    today: state.today, timezone: state.timezone, now: new Date(now).toISOString(),
    settings: state.settings,
    rooms: state.areas.filter((a) => a.is_active || plans[a.id]).map((a) => {
      const p = plans[a.id];
      return {
        id: a.id, name: a.name, active: !!a.is_active, drawn: !!p,
        cols: p ? p.cols : null, rows: p ? p.rows : null, cells: p ? p.cells : {}, version: p ? p.version : 0,
        tables: (tablesBy[a.id] || []).map((t) => ({ n: t.number, seats: t.seats, shape: t.shape, x: t.x, y: t.y })),
      };
    }),
    busy: state.sessions.map((s) => ({ id: s.id, areaId: s.area_id, tables: s.tables, bookingId: s.reservation_id || null, since: s.started_at })),
    joins: state.joins.map((j) => ({ id: j.id, areaId: j.area_id, tables: j.tables })),
    bookings: state.bookings.map((b) => ({
      id: b.id, name: b.guest_name, first: firstName(b.guest_name), party: b.party_size, areaId: b.area_id || null,
      at: new Date(b.reserved_at).toISOString(), label: clockIn(state.timezone, b.reserved_at).label,
      status: b.status, pin: b.table_number || null, sitting: sitting[b.id] || null,
    })),
    place: placed.place, waiting: placed.waiting, released: placed.released,
  };
}

// The map as it is now, with what just happened (or why not: status 409 and an error) — so the phone redraws at once.
async function fresh(res, who, tasterId, extra = {}, status = 200) {
  let state = await load(res, who.rid);
  if (!state) return null;
  if (await settle(state, tasterId)) {
    state = await load(res, who.rid);
    if (!state) return null;
  }
  return res.status(status).json({ ...dress(state, who), ...extra });
}

async function getMap(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!who) return;
  return fresh(res, who, tasterId);
}

// ── THE UNIT A PHONE TAPPED ──────────────────────────────────────────────────
// The phone sends the tables it drew as one place. If the map has changed since
// (somebody joined or separated them), the answer says so instead of guessing.
function cleanTables(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 12) return null;
  const out = list.map(Number);
  if (out.some((n) => !Number.isInteger(n) || n < 1 || n > 999) || new Set(out).size !== out.length) return null;
  return out;
}
function unitFor(state, tables) {
  const units = unitsOf(state.tables, state.joins);
  const all = Object.values(units).flat();
  const u = all.find((x) => x.members.includes(tables[0]));
  if (!u || u.members.length !== tables.length || !tables.every((n) => u.members.includes(n))) return null;
  return { unit: u, units };
}
const CHANGED = 'The map changed a moment ago (someone else tapped). It now shows what it is: try again.';
function nameOf(u) { return (u.members.length > 1 ? 'tables ' : 'table ') + u.members.join('+'); }

// ── BUSY ──────────────────────────────────────────────────────────────────────
// A walk-in (anybody on the team), or a booking's party ("their party is here",
// a manager — it is the same Arrived as on the list). A walk-in may not take a
// table a booking needs within the sitting time, unless a manager says "seat a
// walk-in anyway": then a booking Reserved there loses its pin, and any
// booking left without a table goes to "No table yet".
async function seat(req, res, body, tasterId) {
  const tables = cleanTables(body.tables);
  if (!tables) return res.status(400).json({ error: 'Which table?' });
  const bookingId = body.bookingId === undefined || body.bookingId === null ? null : Number(body.bookingId);
  if (bookingId !== null && (!Number.isInteger(bookingId) || bookingId < 1)) return res.status(400).json({ error: 'Which booking?' });
  const force = body.force === true;
  const who = await gate(res, tasterId, body.restaurantId, bookingId !== null || force ? LEVEL.manager : LEVEL.crew, req);
  if (!who) return;
  const state = await load(res, who.rid);
  if (!state) return;
  const found = unitFor(state, tables);
  if (!found) return fresh(res, who, tasterId, { error: CHANGED, reason: 'changed' }, 409);
  const { unit, units } = found;
  const now = Date.now(), HOLD = state.settings.holdMinutes * MIN;

  if (bookingId !== null) {
    const b = state.bookings.find((x) => Number(x.id) === bookingId);
    if (!b) return res.status(404).json({ error: 'That booking is not on today\'s list.' });
    if (b.area_id && Number(b.area_id) !== unit.area) return res.status(409).json({ error: `${firstName(b.guest_name)} booked another room. Seat them there, or move the booking first.` });
    if (unit.seats < b.party_size) return res.status(409).json({ error: `${cap(nameOf(unit))} has ${unit.seats} seats: ${firstName(b.guest_name)} is ${people(b.party_size)}. Join another table to it first.`, reason: 'small' });
    const r = await rpc('hf_map_seat', { p_restaurant: who.rid, p_area: unit.area, p_tables: unit.members, p_reservation: bookingId, p_auto: false, p_by: tasterId });
    if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
    if (!r.ok) return answerNo(res, r.reason, who, tasterId, unit);
    if (b.status === 'booked') {
      const marked = await viaStaff(mark, req, { id: bookingId, to: 'seated' }, tasterId);
      if (marked.status !== 200) {
        await rpc('hf_map_unseat', { p_restaurant: who.rid, p_session: r.session_id, p_by: tasterId });
        return res.status(marked.status).json({ error: (marked.data && marked.data.error) || 'Could not mark them as arrived.' });
      }
    }
    return fresh(res, who, tasterId, { done: { kind: 'seat', sessionId: r.session_id, who: firstName(b.guest_name), tables: unit.members } });
  }

  // a walk-in: who would be left without a table?
  const before = placeBookings({ units, sessions: state.sessions, bookings: state.bookings, now, ...state.settings });
  const fake = state.sessions.concat([{ tables: unit.members }]);
  const soon = state.bookings.filter((b) => before.place[b.id] === unit.key && Date.parse(b.reserved_at) - now < HOLD);
  const kept = soon.filter((b) => b.table_number && unit.members.includes(Number(b.table_number)));
  let bookings = state.bookings;
  if (kept.length && !force) {
    const b = kept[0];
    return res.status(409).json({ error: `${cap(nameOf(unit))} is Reserved for ${firstName(b.guest_name)} at ${clockIn(state.timezone, b.reserved_at).label}. Touch and hold the table for more.`, reason: 'kept' });
  }
  if (force && kept.length) bookings = bookings.map((b) => (kept.includes(b) ? { ...b, table_number: null } : b));
  const after = placeBookings({ units, sessions: fake, bookings, now, ...state.settings });
  // anybody due within the sitting time who had a table and would have none (not only those on this table:
  // the one moved off it can take another's)
  const stranded = state.bookings.filter((b) => before.place[b.id] && !after.place[b.id] && Date.parse(b.reserved_at) - now < HOLD);
  if (stranded.length && !force) {
    const b = stranded[0];
    return res.status(409).json({ error: `A walk-in here leaves ${firstName(b.guest_name)} (${people(b.party_size)}, ${clockIn(state.timezone, b.reserved_at).label}) without a table. `
      + (who.level >= LEVEL.manager ? '' : 'A manager can seat a walk-in there anyway.'), reason: 'needed', who: firstName(b.guest_name) });
  }
  const r = await rpc('hf_map_seat', { p_restaurant: who.rid, p_area: unit.area, p_tables: unit.members, p_reservation: null, p_auto: false, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (!r.ok) return answerNo(res, r.reason, who, tasterId, unit);
  const unpinned = [];
  for (const b of kept) {
    if (!force) break;
    const done = await sb(`/reservations?id=eq.${Number(b.id)}&restaurant_id=eq.${who.rid}&table_number=eq.${Number(b.table_number)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ table_number: null }),
    });
    if (done.ok) unpinned.push({ bookingId: b.id, table: Number(b.table_number) });
  }
  const findUnit = (key) => Object.values(units).flat().find((x) => x.key === key);
  const moved = soon.filter((b) => after.place[b.id] && after.place[b.id] !== unit.key)
    .map((b) => ({ who: firstName(b.guest_name), label: clockIn(state.timezone, b.reserved_at).label, to: findUnit(after.place[b.id]).members }));
  return fresh(res, who, tasterId, { done: { kind: 'seat', sessionId: r.session_id, walkIn: true, tables: unit.members, moved, unpinned,
    noTable: stranded.map((b) => firstName(b.guest_name)) } });
}

// The database said no: why, in words.
async function answerNo(res, reason, who, tasterId, unit) {
  if (reason === 'migration') return res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
  const words = {
    busy: `${cap(nameOf(unit))} is busy already (someone tapped it a moment ago).`,
    already_seated: 'They are at a table already.',
    no_table: CHANGED, no_booking: 'That booking is not here.',
  };
  return fresh(res, who, tasterId, { error: words[reason] || CHANGED, reason: reason || 'changed' }, 409);
}

// ── FREE, AND THE TWO UNDOS ──────────────────────────────────────────────────
async function sessionOf(rid, id) {
  const got = await sb(`/table_sessions?id=eq.${Number(id)}&restaurant_id=eq.${Number(rid)}&select=id,tables,reservation_id,started_at,ended_at&limit=1`);
  return got.ok && Array.isArray(got.data) ? got.data[0] || null : null;
}

async function free(req, res, body, tasterId) {
  const id = Number(body.sessionId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!who) return;
  const s = await sessionOf(who.rid, id);
  const r = await rpc('hf_map_free', { p_restaurant: who.rid, p_session: id, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (r.reason === 'migration') return res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
  if (!r.ok) return fresh(res, who, tasterId, { error: 'That table is free already.', reason: 'not_busy' }, 409);
  const minutes = s ? Math.max(0, Math.round((Date.now() - Date.parse(s.started_at)) / MIN)) : null;
  return fresh(res, who, tasterId, { done: { kind: 'free', sessionId: id, tables: s ? s.tables : [], minutes } });
}

async function reopen(req, res, body, tasterId) {
  const id = Number(body.sessionId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!who) return;
  const r = await rpc('hf_map_reopen', { p_restaurant: who.rid, p_session: id, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (r.reason === 'migration') return res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
  if (!r.ok) {
    const why = { too_late: 'Too late to undo (15 minutes).', busy: 'Someone is at that table now, so it cannot be undone.' }[r.reason] || 'That cannot be undone now.';
    return fresh(res, who, tasterId, { error: why, reason: r.reason }, 409);
  }
  return fresh(res, who, tasterId, { done: { kind: 'reopen', sessionId: id } });
}

// Undo busy. A booking's party: a manager, and its Arrived is undone too (the
// same Undo as on the list).
async function unseat(req, res, body, tasterId) {
  const id = Number(body.sessionId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });
  const first = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!first) return;
  const s = await sessionOf(first.rid, id);
  if (!s || s.ended_at) return fresh(res, first, tasterId, { error: 'That table is not busy any more.', reason: 'not_busy' }, 409);
  if (Date.now() - Date.parse(s.started_at) > UNDO_MINUTES * MIN) {
    return fresh(res, first, tasterId, { error: 'Too late to undo (15 minutes). Tap the table to free it.', reason: 'too_late' }, 409);
  }
  if (s.reservation_id) {
    if (first.level < LEVEL.manager) return res.status(403).json({ error: 'Only a manager can undo an arrival. Crew can free the table.' });
    const st = await sb(`/reservations?id=eq.${Number(s.reservation_id)}&select=status`);
    if (st.ok && Array.isArray(st.data) && st.data[0] && st.data[0].status === 'seated') {
      const marked = await viaStaff(mark, req, { id: Number(s.reservation_id), to: 'booked' }, tasterId);
      if (marked.status !== 200) return res.status(marked.status).json({ error: (marked.data && marked.data.error) || 'Could not undo the arrival.' });
    }
  }
  const r = await rpc('hf_map_unseat', { p_restaurant: first.rid, p_session: id, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (!r.ok) return fresh(res, first, tasterId, { error: 'That cannot be undone now.', reason: r.reason }, 409);
  return fresh(res, first, tasterId, { done: { kind: 'unseat', sessionId: id } });
}

// ── RESERVED (the pin) ───────────────────────────────────────────────────────
async function pin(req, res, body, tasterId) {
  const id = Number(body.bookingId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which booking?' });
  const table = body.table === null || body.table === undefined ? null : Number(body.table);
  if (table !== null && (!Number.isInteger(table) || table < 1 || table > 999)) return res.status(400).json({ error: 'Which table?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  const state = await load(res, who.rid);
  if (!state) return;
  const b = state.bookings.find((x) => Number(x.id) === id);
  if (!b || b.status !== 'booked') return fresh(res, who, tasterId, { error: 'That booking is not waiting for a table.', reason: 'not_booked' }, 409);
  if (table !== null) {
    const t = state.tables.find((x) => x.number === table);
    if (!t) return fresh(res, who, tasterId, { error: CHANGED, reason: 'changed' }, 409);
    if (b.area_id && Number(b.area_id) !== Number(t.area_id)) {
      return res.status(409).json({ error: `Table ${table} is in another room: ${firstName(b.guest_name)} booked ${roomName(state, b.area_id)}.` });
    }
    const u = Object.values(unitsOf(state.tables, state.joins)).flat().find((x) => x.members.includes(table));
    if (u.seats < b.party_size) {
      return res.status(409).json({ error: `${cap(nameOf(u))} has ${u.seats} seats: ${firstName(b.guest_name)} is ${people(b.party_size)}. Join another table to it first.`, reason: 'small' });
    }
  }
  const done = await sb(`/reservations?id=eq.${id}&restaurant_id=eq.${who.rid}&status=eq.booked`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ table_number: table }),
  });
  if (!done.ok) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (!Array.isArray(done.data) || !done.data.length) return fresh(res, who, tasterId, { error: CHANGED, reason: 'changed' }, 409);
  return fresh(res, who, tasterId, { done: { kind: 'pin', bookingId: id, table, was: b.table_number || null, who: firstName(b.guest_name), label: clockIn(state.timezone, b.reserved_at).label } });
}

function roomName(state, areaId) { const a = state.areas.find((x) => Number(x.id) === Number(areaId)); return a ? a.name : 'another room'; }

// ── JOIN AND SEPARATE ────────────────────────────────────────────────────────
async function join(req, res, body, tasterId) {
  const a = cleanTables(body.a), b = cleanTables(body.b);
  if (!a || !b) return res.status(400).json({ error: 'Which tables?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!who) return;
  const state = await load(res, who.rid);
  if (!state) return;
  const fa = unitFor(state, a), fb = unitFor(state, b);
  if (!fa || !fb) return fresh(res, who, tasterId, { error: CHANGED, reason: 'changed' }, 409);
  const ua = fa.unit, ub = fb.unit;
  if (ua.key === ub.key) return res.status(400).json({ error: 'Tap another table to join.' });
  if (ua.area !== ub.area) return res.status(409).json({ error: 'Only tables in the same room can be joined.' });
  if (ua.members.length + ub.members.length > 12) return res.status(409).json({ error: 'Twelve tables at most in one group.' });
  const busyB = state.sessions.some((s) => s.tables.some((n) => ub.members.includes(n)));
  const group = busyB ? ub.members.concat(ua.members) : ua.members.concat(ub.members);
  const r = await rpc('hf_map_join', { p_restaurant: who.rid, p_area: ua.area, p_tables: group, p_date: state.today, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (r.reason === 'migration') return res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
  if (!r.ok) {
    const why = { both_busy: 'Both are busy: free one of them first.', joined_elsewhere: CHANGED, busy_elsewhere: CHANGED }[r.reason] || CHANGED;
    return fresh(res, who, tasterId, { error: why, reason: r.reason }, 409);
  }
  // who sits there now that did not before (a party too big for either table)
  const after = await load(res, who.rid);
  if (!after) return;
  const unitsBefore = fa.units;
  const before = placeBookings({ units: unitsBefore, sessions: state.sessions, bookings: state.bookings, now: Date.now(), ...state.settings });
  const placedAfter = placeBookings({ units: unitsOf(after.tables, after.joins), sessions: after.sessions, bookings: after.bookings, now: Date.now(), ...after.settings });
  const came = after.bookings.filter((x) => placedAfter.place[x.id] === group[0] && before.place[x.id] !== ua.key && before.place[x.id] !== ub.key)
    .map((x) => ({ who: firstName(x.guest_name), party: x.party_size, label: clockIn(after.timezone, x.reserved_at).label }));
  const seats = ua.seats + ub.seats;
  return fresh(res, who, tasterId, { done: { kind: 'join', joinId: r.join_id, tables: group, seats, came } });
}

async function separate(req, res, body, tasterId) {
  const id = Number(body.joinId);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which tables?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew, req);
  if (!who) return;
  const got = await sb(`/table_joins?id=eq.${id}&restaurant_id=eq.${who.rid}&select=tables&limit=1`);
  const tables = got.ok && Array.isArray(got.data) && got.data[0] ? got.data[0].tables : null;
  const r = await rpc('hf_map_separate', { p_restaurant: who.rid, p_join: id, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save that. Please try again.' });
  if (r.reason === 'migration') return res.status(503).json({ error: NEEDS_SQL, reason: 'migration' });
  if (!r.ok) return fresh(res, who, tasterId, { error: 'Those tables are not joined any more.', reason: r.reason }, 409);
  return fresh(res, who, tasterId, { done: { kind: 'separate', joinId: id, tables } });
}

// ── DRAWING A ROOM ───────────────────────────────────────────────────────────
// The phone sends the whole room; everything is checked here again, then the
// database saves it in one go (hf_map_save), only if nobody saved it since.
const KIND = /^(gone|Bar|Door|Object:[^<>"\\]{1,24})$/;
export function checkRoom(body) {
  const cols = Number(body.cols), rows = Number(body.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 4 || cols > 30 || rows < 4 || rows > 40) {
    return { error: 'A room is 4 to 30 squares wide and 4 to 40 long.' };
  }
  const raw = body.cells && typeof body.cells === 'object' && !Array.isArray(body.cells) ? body.cells : null;
  if (!raw) return { error: 'The drawing is missing.' };
  const cells = {};
  for (const [k, v] of Object.entries(raw)) {
    const m = /^(\d{1,2}),(\d{1,2})$/.exec(k);
    if (!m || Number(m[1]) >= cols || Number(m[2]) >= rows) return { error: 'A square is outside the room.' };
    const val = typeof v === 'string' ? v.replace(/^Object:\s+/, 'Object:').replace(/\s+$/, '') : '';
    if (!KIND.test(val)) return { error: 'A square has something the map does not know. Names of objects: up to 24 letters.' };
    cells[k] = val;
  }
  if (!Array.isArray(body.tables) || body.tables.length > 120) return { error: 'Up to 120 tables in a room.' };
  const used = {};
  const tables = [];
  for (const t of body.tables) {
    const n = Number(t && t.n), seats = Number(t && t.seats), x = Number(t && t.x), y = Number(t && t.y), shape = t && t.shape;
    if (!Number.isInteger(n) || n < 1 || n > 999) return { error: 'Table numbers go from 1 to 999.' };
    if (!Number.isInteger(seats) || seats < 1 || seats > 20) return { error: `Table ${n}: 1 to 20 seats.` };
    if (shape !== 'round' && shape !== 'square') return { error: `Table ${n}: round or square.` };
    if (!Number.isInteger(x) || !Number.isInteger(y)) return { error: `Table ${n}: where is it?` };
    const f = footprint(seats);
    if (x < 0 || y < 0 || x + f.w > cols || y + f.h > rows) return { error: `Table ${n} is outside the room.` };
    for (let i = 0; i < f.w; i++) {
      for (let j = 0; j < f.h; j++) {
        const k = (x + i) + ',' + (y + j);
        if (cells[k]) return { error: `Table ${n} stands on ${cells[k] === 'gone' ? 'a removed square' : cells[k].replace(/^Object:/, '')}: move it.` };
        if (used[k]) return { error: `Tables ${used[k]} and ${n} are on top of each other: move one.` };
        used[k] = n;
      }
    }
    tables.push({ n, seats, shape, x, y });
  }
  if (new Set(tables.map((t) => t.n)).size !== tables.length) return { error: 'Each table needs its own number.' };
  return { cols, rows, cells, tables };
}

async function saveRoom(req, res, body, tasterId) {
  const areaId = Number(body.areaId);
  if (!Number.isInteger(areaId) || areaId < 1) return res.status(400).json({ error: 'Which room?' });
  const version = Number(body.version);
  if (!Number.isInteger(version) || version < 0) return res.status(400).json({ error: 'Which version of the room?' });
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  const room = checkRoom(body);
  if (room.error) return res.status(400).json({ error: room.error });
  const r = await rpc('hf_map_save', { p_restaurant: who.rid, p_area: areaId, p_cols: room.cols, p_rows: room.rows,
    p_cells: room.cells, p_tables: room.tables, p_version: version, p_by: tasterId });
  if (!r) return res.status(502).json({ error: 'Could not save the room. Please try again.' });
  if (!r.ok) {
    const [why, n] = String(r.reason || '').split(':');
    const words = {
      migration: NEEDS_SQL,
      no_room: 'That room is not there any more.',
      changed: 'Someone saved this room a moment ago. Close it and open it again to see theirs, then make your change.',
      number_taken: `Table ${n} is already in another room. Each number is used once in the restaurant: choose another.`,
      same_number: `Two tables are number ${n}. Each table needs its own number.`,
      outside: `Table ${n} is outside the room.`,
      busy: `Table ${n} is busy now, so it cannot be taken out. Free it on the map first.`,
    };
    return res.status(r.reason === 'migration' ? 503 : 409).json({ error: words[why] || 'Could not save the room.', reason: why });
  }
  const area = await sb(`/restaurant_areas?id=eq.${areaId}&select=name,seats,tables`);
  const a = area.ok && Array.isArray(area.data) ? area.data[0] : null;
  if (a) await tellChange(who.rid, tasterId, `drew the room ${a.name}: ${a.tables} tables, ${a.seats} seats`, { go: 'settings' });
  return fresh(res, who, tasterId, { done: { kind: 'save', areaId, version: r.version } });
}

// ── SMALL THINGS ─────────────────────────────────────────────────────────────
function people(n) { return n + (n === 1 ? ' person' : ' people'); }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// One of staff.js's actions, answered here instead of to the phone.
async function viaStaff(fn, req, body, tasterId) {
  let status = 200, data = null;
  const out = { status(n) { status = n; return out; }, json(x) { data = x; return out; }, setHeader() {}, end() { return out; } };
  await fn(req, out, body, tasterId);
  return { status, data };
}
