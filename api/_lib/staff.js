// api/_lib/staff.js
//
// The restaurant's side of the reservations: the Reservations tab in
// manager.html. Every action here is reached through api/reservations.js with
// an action name that starts with "staff_", so the site still deploys as twelve
// functions (files starting with _ are not functions).
//
// Who may do what — decided here, on every request, from the database:
//   crew     (1) sees everything a manager sees, phones included, and changes nothing
//   manager  (2) marks arrived / no-show, cancels, answers big-party requests,
//                and changes the hours, holidays, rooms and rules
//   owner (3) and platform admin (4) can do all of that too
//
// What staff never see: the guest's email address. The privacy page promises it
// is seen by "only us", so it is never selected in a staff read. The server
// still uses it to send the confirmation when a manager accepts a request.

import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, loadAccess, accessProblem, levelAt, LEVEL } from './roles.js';
import { loadBooking, todayIn, clockIn, cleanDate, cleanText } from './booking.js';

// Staff are signed in, and a dashboard left open all evening asks often. These
// only stop a runaway script; they fail OPEN, because a Redis hiccup in the
// middle of service must not stop a manager marking who has arrived.
const staffReadLimiter  = makeLimiter({ requests: 600, window: '10 m', prefix: 'resv:staff:read' });
const staffWriteLimiter = makeLimiter({ requests: 200, window: '10 m', prefix: 'resv:staff:write' });

const HOUR = 3600 * 1000;

// A restaurant's day does not end at midnight. A table at 12:30 AM on Saturday
// is part of Friday night's service, so Friday's list shows it (after the
// 11:30 PM tables) and, until 5 AM, "today" is still Friday. The database
// counts the days the same way (hf_day_counts, migration 17).
export const DAY_STARTS = '05:00';
const DAY_STARTS_MIN = 5 * 60;

// The service day it is now, where the restaurant is.
export function serviceToday(timezone, now = Date.now()) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(now)).forEach((x) => { p[x.type] = x.value; });
  const date = `${p.year}-${p.month}-${p.day}`;
  return Number(p.hour) * 60 + Number(p.minute) < DAY_STARTS_MIN ? addDays(date, -1) : date;
}
// How far from the table's time each button makes sense. Outside these, a tap
// is almost certainly on the wrong card or the wrong day.
export const RULES = {
  arriveBeforeMs: 4 * HOUR,     // a guest may turn up early; not the day before
  correctAfterMs: 36 * HOUR,    // yesterday's list can still be put right
  cancelAfterMs:  12 * HOUR,    // a guest who calls at 7:10 to say they are not coming
};

// The one place that decides which buttons a booking has. The page draws what
// this says; staff_mark asks it again before it writes.
export function movesFor(row, now = Date.now()) {
  const at = new Date(row.reserved_at).getTime();
  const since = now - at;
  const recent = since <= RULES.correctAfterMs;
  return {
    canArrive: (row.status === 'booked' || row.status === 'no_show') && at - now <= RULES.arriveBeforeMs && recent,
    canNoShow: row.status === 'booked' && since >= 0 && recent,
    canUndo:   (row.status === 'seated' || row.status === 'no_show') && recent,
    canCancel: row.status === 'booked' && since <= RULES.cancelAfterMs,
  };
}

const NO_MOVES = { canArrive: false, canNoShow: false, canUndo: false, canCancel: false };

// What each move writes, and which statuses it may start from. The "from" list
// goes into the PATCH filter, so two phones tapping at once cannot fight: the
// second write finds nothing to change.
const MOVES = {
  seated:    { from: ['booked', 'no_show'], allowed: 'canArrive' },
  no_show:   { from: ['booked'],            allowed: 'canNoShow' },
  booked:    { from: ['seated', 'no_show'], allowed: 'canUndo' },
  cancelled: { from: ['booked'],            allowed: 'canCancel' },
};

const WHY_NOT = {
  seated:    'This table is not due yet, or it was already closed. Check the day and the time.',
  no_show:   'A table can only be marked as a no-show once its time has come.',
  booked:    'This table can no longer be put back.',
  cancelled: 'This table can no longer be cancelled here.',
};

// Everything a staff read selects from reservations. guest_email is NOT here,
// on purpose, and a test fails if it ever is.
const BOOKING_COLUMNS = 'id,code,area_id,guest_name,guest_phone,party_size,reserved_at,local_date,local_time,'
                      + 'status,notes,source,seated_at,no_show_at,cancelled_at,created_at';
const REQUEST_COLUMNS = 'id,guest_name,guest_phone,party_size,wanted_date,wanted_time,occasion,message,status,created_at';

export async function staff(req, res, body, action, helpers = {}) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const writes = !['staff_days', 'staff_day', 'staff_settings'].includes(action);
  if (!(await allow(writes ? staffWriteLimiter : staffReadLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }

  switch (action) {
    case 'staff_days':       return days(req, res, body, tasterId);
    case 'staff_day':        return day(req, res, body, tasterId);
    case 'staff_mark':       return mark(req, res, body, tasterId);
    case 'staff_answer':     return answer(req, res, body, tasterId, helpers);
    case 'staff_settings':   return settingsRead(req, res, body, tasterId);
    case 'staff_save_rules': return saveRules(req, res, body, tasterId);
    case 'staff_save_hours': return saveHours(req, res, body, tasterId);
    case 'staff_closure':    return closure(req, res, body, tasterId);
    case 'staff_area':       return area(req, res, body, tasterId);
    default:                 return res.status(400).json({ error: 'Unknown action.' });
  }
}

// ── WHO IS ASKING ─────────────────────────────────────────────────────────────
// Answers the request itself and returns null when the caller may not go on.
async function gate(res, tasterId, restaurantId, need) {
  const rid = Number(restaurantId);
  if (!Number.isInteger(rid) || rid < 1) { res.status(400).json({ error: 'Which restaurant?' }); return null; }
  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) { res.status(problem.status).json({ error: problem.error }); return null; }
  const level = levelAt(access, rid);
  if (level < need) {
    res.status(403).json({
      error: level >= LEVEL.crew
        ? 'Only a manager can change this. Crew can look at everything but not change it.'
        : 'This account has no access to this restaurant\'s reservations.',
    });
    return null;
  }
  return { rid, level, canEdit: level >= LEVEL.manager };
}

async function settingsFor(res, rid) {
  const loaded = await loadBooking(rid);
  if (!loaded || loaded.error) {
    res.status(loaded && loaded.error ? 502 : 404).json({
      error: loaded && loaded.error
        ? 'Could not read the booking settings (the database answered ' + loaded.status + ').'
        : 'Restaurant not found.',
    });
    return null;
  }
  return { loaded, settings: loaded.settings || {}, timezone: (loaded.settings && loaded.settings.timezone) || 'America/New_York' };
}

// ── THE DAY CAROUSEL ──────────────────────────────────────────────────────────
async function days(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew);
  if (!who) return;
  const s = await settingsFor(res, who.rid);
  if (!s) return;
  const today = serviceToday(s.timezone);
  let from = cleanDate(body.from) || addDays(today, -30);
  let to = cleanDate(body.to) || addDays(today, 90);
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) > 200) to = addDays(from, 200);   // one screen never needs more

  const rows = await sb('/rpc/hf_day_counts', {
    method: 'POST', body: JSON.stringify({ p_restaurant: who.rid, p_from: from, p_to: to }),
  });
  if (!rows.ok || !Array.isArray(rows.data)) {
    return res.status(502).json({
      error: 'Could not count the bookings (the database answered ' + rows.status + '). '
           + (rows.status === 404 ? 'That usually means migration 17 has not been run yet.' : ''),
    });
  }
  return res.status(200).json({
    success: true, today, timezone: s.timezone, from, to,
    days: rows.data.map(dressDay),
  });
}

function dressDay(r) {
  return { date: r.day, tables: r.tables, people: r.people, arrived: r.arrived,
           noShows: r.no_shows, cancelled: r.cancelled, open: !!r.is_open };
}

// ── ONE DAY: THE BOOKINGS, THE ROOMS, THE REQUESTS ────────────────────────────
async function day(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew);
  if (!who) return;
  const s = await settingsFor(res, who.rid);
  if (!s) return;
  const today = serviceToday(s.timezone);
  const date = cleanDate(body.date) || today;
  const next = addDays(date, 1);

  // The day and the small hours after it; the tables before 5 AM on the day
  // itself belong to the night before.
  const [bookings, areas, requests] = await Promise.all([
    sb(`/reservations?restaurant_id=eq.${who.rid}&local_date=in.(${date},${next})&select=${BOOKING_COLUMNS}` +
       '&order=local_date.asc,local_time.asc,id.asc&limit=1000'),
    sb(`/restaurant_areas?restaurant_id=eq.${who.rid}&select=id,name,seats,tables,is_active,sort_order&order=sort_order.asc,id.asc`),
    sb(`/reservation_requests?restaurant_id=eq.${who.rid}&status=eq.new&wanted_date=gte.${today}` +
       `&select=${REQUEST_COLUMNS}&order=wanted_date.asc,created_at.asc&limit=50`),
  ]);
  if (!bookings.ok || !Array.isArray(bookings.data)) {
    return res.status(502).json({ error: 'Could not read the bookings (the database answered ' + bookings.status + ').' });
  }
  const areaList = Array.isArray(areas.data) ? areas.data : [];
  const areaName = {};
  areaList.forEach((a) => { areaName[a.id] = a.name; });
  const now = Date.now();

  const dressed = bookings.data
    .filter((r) => inServiceDay(r, date))
    .map((r) => dressBooking(r, s.timezone, areaName, now, who.canEdit, date));
  const live = dressed.filter((b) => b.status !== 'cancelled');
  return res.status(200).json({
    success: true,
    today, date, timezone: s.timezone, now: new Date(now).toISOString(),
    level: who.level, canEdit: who.canEdit,
    settings: {
      enabled: !!s.settings.is_enabled,
      graceMinutes: s.settings.grace_minutes,
      autoReleaseLate: !!s.settings.auto_release_late,
      holdMinutes: s.settings.hold_minutes,
      slotMinutes: s.settings.slot_minutes,
    },
    counts: {
      tables:    live.length,
      people:    live.reduce((n, b) => n + b.party, 0),
      arrived:   dressed.filter((b) => b.status === 'seated' || b.status === 'done').length,
      noShows:   dressed.filter((b) => b.status === 'no_show').length,
      cancelled: dressed.length - live.length,
    },
    bookings: dressed,
    areas: areaList.filter((a) => a.is_active).map((a) => ({ id: a.id, name: a.name, seats: a.seats })),
    requests: (requests.ok && Array.isArray(requests.data) ? requests.data : []).map((q) => dressRequest(q)),
  });
}

export function inServiceDay(r, date) {
  const t = String(r.local_time || '00:00').slice(0, 5);
  return (r.local_date === date && t >= DAY_STARTS) || (r.local_date === addDays(date, 1) && t < DAY_STARTS);
}

// serviceDate: the day whose list this card is on. A table in the small hours
// after it counts its minutes past midnight (12:30 AM = 24:30), so the clock on
// the page keeps rolling forward instead of jumping back to the morning.
export function dressBooking(r, timezone, areaName, now, canEdit, serviceDate) {
  const [hh, mm] = String(r.local_time || '00:00').split(':').map(Number);
  const late = serviceDate && r.local_date !== serviceDate ? 1440 : 0;
  return {
    id:     r.id,
    code:   r.code,
    name:   r.guest_name,
    phone:  r.guest_phone,
    party:  r.party_size,
    areaId: r.area_id || null,
    areaName: r.area_id ? areaName[r.area_id] || null : null,
    date:   r.local_date,
    time:   `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    minutes: late + hh * 60 + mm,
    at:     new Date(r.reserved_at).toISOString(),
    label:  clockIn(timezone, r.reserved_at).label,
    status: r.status,
    notes:  r.notes || null,
    source: r.source,
    seatedLabel: r.seated_at ? clockIn(timezone, r.seated_at).label : null,
    // Crew get the same card with no buttons at all.
    ...(canEdit ? movesFor(r, now) : NO_MOVES),
  };
}

function dressRequest(q) {
  return {
    id: q.id, name: q.guest_name, phone: q.guest_phone, party: q.party_size,
    date: q.wanted_date, time: q.wanted_time ? String(q.wanted_time).slice(0, 5) : null,
    occasion: q.occasion || null, message: q.message || null, status: q.status, createdAt: q.created_at,
  };
}

// ── ARRIVED · NO-SHOW · UNDO · CANCEL ─────────────────────────────────────────
async function mark(req, res, body, tasterId) {
  const id = Number(body.id);
  const to = String(body.to || '');
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which table?' });
  const move = MOVES[to];
  if (!move) return res.status(400).json({ error: 'Unknown change.' });

  // The restaurant comes from the booking itself, never from the request: a
  // manager of one restaurant cannot touch another's tables by sending its id.
  const found = await sb(`/reservations?id=eq.${id}&select=${BOOKING_COLUMNS},restaurant_id&limit=1`);
  if (!found.ok || !Array.isArray(found.data) || !found.data.length) {
    return res.status(404).json({ error: 'That table is not there any more.' });
  }
  const row = found.data[0];
  const who = await gate(res, tasterId, row.restaurant_id, LEVEL.manager);
  if (!who) return;

  const s = await loadBooking(row.restaurant_id);
  const timezone = (s && s.settings && s.settings.timezone) || 'America/New_York';
  const now = Date.now();

  if (!movesFor(row, now)[move.allowed]) {
    return res.status(409).json({ error: WHY_NOT[to], booking: dressBooking(row, timezone, {}, now, true) });
  }

  const stamp = new Date(now).toISOString();
  const fields = { status: to, updated_at: stamp };
  if (to === 'seated')    Object.assign(fields, { seated_at: stamp, no_show_at: null });
  if (to === 'no_show')   Object.assign(fields, { no_show_at: stamp });
  if (to === 'booked')    Object.assign(fields, { seated_at: null, no_show_at: null });
  if (to === 'cancelled') Object.assign(fields, { cancelled_at: stamp, cancelled_by: tasterId });

  const done = await sb(`/reservations?id=eq.${id}&status=in.(${move.from.join(',')})`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  if (!done.ok) {
    console.error('[staff:mark] update failed', id, to, done.status);
    return res.status(502).json({ error: 'Could not save that. Please try again.' });
  }
  if (!Array.isArray(done.data) || !done.data.length) {
    // Somebody else changed it first (another phone, or the guest's own link).
    const fresh = await sb(`/reservations?id=eq.${id}&select=${BOOKING_COLUMNS}&limit=1`);
    const now2 = fresh.ok && Array.isArray(fresh.data) && fresh.data.length ? fresh.data[0] : row;
    return res.status(409).json({
      error: 'Someone changed this table a moment ago. The list now shows what it is.',
      booking: dressBooking(now2, timezone, {}, Date.now(), true),
    });
  }
  console.log('[staff:mark] taster', tasterId, 'set', row.code, 'to', to);
  return res.status(200).json({ success: true, booking: dressBooking(done.data[0], timezone, {}, Date.now(), true) });
}

// ── YES OR NO TO A BIG PARTY ──────────────────────────────────────────────────
const ACCEPT_REFUSED = {
  gone:     'That request is not there any more.',
  answered: 'Someone has already answered this request.',
  past:     'That time has already passed. Pick a later one.',
  area:     'That room is not open for bookings. Pick another room.',
  too_big:  'More than 50 people cannot be held as one booking yet. Call the guest and block the room by hand.',
};

async function answer(req, res, body, tasterId, helpers) {
  const requestId = Number(body.requestId);
  if (!Number.isInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Which request?' });
  const decision = String(body.decision || '');
  if (decision !== 'accept' && decision !== 'decline') return res.status(400).json({ error: 'Accept or decline?' });

  // guest_email is read here only to send the confirmation. It never goes back
  // to the page.
  const found = await sb(`/reservation_requests?id=eq.${requestId}` +
                         '&select=id,restaurant_id,status,guest_name,guest_email,party_size&limit=1');
  if (!found.ok || !Array.isArray(found.data) || !found.data.length) {
    return res.status(404).json({ error: ACCEPT_REFUSED.gone });
  }
  const q = found.data[0];
  const who = await gate(res, tasterId, q.restaurant_id, LEVEL.manager);
  if (!who) return;
  if (q.status !== 'new') return res.status(409).json({ error: ACCEPT_REFUSED.answered });

  if (decision === 'decline') {
    const done = await sb(`/reservation_requests?id=eq.${requestId}&status=eq.new`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'declined', reply_note: cleanText(body.note, 1000),
                             decided_by: tasterId, decided_at: new Date().toISOString() }),
    });
    if (!done.ok) return res.status(502).json({ error: 'Could not save that. Please try again.' });
    if (!Array.isArray(done.data) || !done.data.length) return res.status(409).json({ error: ACCEPT_REFUSED.answered });
    return res.status(200).json({ success: true, declined: true });
  }

  const s = await settingsFor(res, q.restaurant_id);
  if (!s) return;
  const date = cleanDate(body.date);
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time || '')) ? String(body.time) : null;
  if (!date || !time) return res.status(400).json({ error: 'Pick the day and the time for the table.' });
  const at = zonedToUtc(date, time, s.timezone);
  if (!at) return res.status(400).json({ error: 'That time does not exist on that day (the clocks change). Pick another.' });
  const areaId = Number(body.areaId);
  if (!Number.isInteger(areaId) || areaId < 1) return res.status(400).json({ error: 'Pick the room.' });

  const made = await sb('/rpc/hf_accept_request', {
    method: 'POST',
    body: JSON.stringify({ p_request: requestId, p_at: at.toISOString(), p_area: areaId, p_by: tasterId }),
  });
  if (!made.ok || !Array.isArray(made.data) || !made.data.length) {
    console.error('[staff:answer] hf_accept_request failed', made.status);
    return res.status(502).json({
      error: 'Could not make the table (the database answered ' + made.status + '). '
           + (made.status === 404 ? 'That usually means migration 17 has not been run yet.' : ''),
    });
  }
  const result = made.data[0];
  if (!result.ok) {
    return res.status(409).json({ error: ACCEPT_REFUSED[result.reason] || ACCEPT_REFUSED.answered, reason: result.reason });
  }

  // The guest hears about it the same way an online booking does, with the
  // same caps. If this fails the table still stands; the page says "call them".
  let emailSent = false;
  if (q.guest_email && typeof helpers.confirmByEmail === 'function') {
    try {
      const areaRow = await sb(`/restaurant_areas?id=eq.${areaId}&select=name`);
      emailSent = await helpers.confirmByEmail({
        reservationId: result.reservation_id, email: q.guest_email, loaded: s.loaded, timezone: s.timezone,
        at: at.toISOString(), party: q.party_size, code: result.code, guestName: q.guest_name,
        areaName: areaRow.ok && Array.isArray(areaRow.data) && areaRow.data.length ? areaRow.data[0].name : null,
      });
    } catch (err) {
      console.error('[staff:answer] confirmation threw', result.reservation_id, err && err.message);
    }
  }
  console.log('[staff:answer] taster', tasterId, 'accepted request', requestId, 'as', result.code);
  return res.status(200).json({
    success: true, accepted: true, code: result.code, date, emailSent,
    guestName: q.guest_name, ...clockIn(s.timezone, at),
  });
}

// A day and a clock time where the restaurant is, as a real moment. null when
// that time does not exist there (the hour the clocks jump forward).
export function zonedToUtc(date, time, timezone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wanted;
  for (let i = 0; i < 3; i++) guess = wanted - offsetAt(guess, timezone);
  const back = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(guess)).replace(',', '');
  return back === `${date} ${time}` ? new Date(guess) : null;
}

function offsetAt(ms, timezone) {
  const p = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// ── SETTINGS: EVERYTHING THE MANAGER OWNS, AND THE NUMBERS ────────────────────
async function settingsRead(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.crew);
  if (!who) return;
  const s = await settingsFor(res, who.rid);
  if (!s) return;
  const today = todayIn(s.timezone);
  const monthStart = today.slice(0, 8) + '01';
  const lastMonthStart = addMonths(monthStart, -1);

  const [hours, closures, areas, counts] = await Promise.all([
    sb(`/restaurant_hours?restaurant_id=eq.${who.rid}&select=weekday,opens_at,closes_at&order=weekday.asc,opens_at.asc`),
    sb(`/restaurant_closures?restaurant_id=eq.${who.rid}&closure_date=gte.${today}` +
       '&select=closure_date,opens_at,closes_at,reason&order=closure_date.asc&limit=100'),
    sb(`/restaurant_areas?restaurant_id=eq.${who.rid}&select=id,name,seats,tables,is_active,sort_order&order=sort_order.asc,id.asc`),
    sb('/rpc/hf_day_counts', { method: 'POST',
       body: JSON.stringify({ p_restaurant: who.rid, p_from: lastMonthStart, p_to: addDays(today, 30) }) }),
  ]);
  if (!hours.ok || !closures.ok || !areas.ok) {
    return res.status(502).json({ error: 'Could not read the settings (the database answered '
      + [hours, closures, areas].find((x) => !x.ok).status + ').' });
  }

  // A closed day takes away its service, 5 AM to 5 AM: the tables counted are
  // that day's and the small hours after it, not the night before's.
  const closureList = closures.data || [];
  let booked = {};
  if (closureList.length) {
    const dates = [...new Set(closureList.flatMap((c) => [c.closure_date, addDays(c.closure_date, 1)]))];
    const hits = await sb(`/reservations?restaurant_id=eq.${who.rid}&status=in.(booked,seated)` +
                          `&local_date=in.(${dates.join(',')})&select=local_date,local_time&limit=2000`);
    const rows = hits.ok && Array.isArray(hits.data) ? hits.data : [];
    closureList.forEach((c) => { booked[c.closure_date] = rows.filter((h) => inServiceDay(h, c.closure_date)).length; });
  }

  const dayRows = counts.ok && Array.isArray(counts.data) ? counts.data.map(dressDay) : [];
  const sum = (from, to) => dayRows.filter((d) => d.date >= from && d.date <= to).reduce((t, d) => ({
    tables: t.tables + d.tables, people: t.people + d.people, arrived: t.arrived + d.arrived,
    noShows: t.noShows + d.noShows, cancelled: t.cancelled + d.cancelled,
  }), { tables: 0, people: 0, arrived: 0, noShows: 0, cancelled: 0 });

  const st = s.settings;
  return res.status(200).json({
    success: true, level: who.level, canEdit: who.canEdit, today, timezone: s.timezone,
    restaurant: { id: s.loaded.restaurant.id, name: s.loaded.restaurant.name },
    rules: rulesOut(st),
    email: { ready: !!st.email_from_address, from: st.email_from_address || null },
    hours: (hours.data || []).map((h) => ({ weekday: h.weekday, opens: String(h.opens_at).slice(0, 5), closes: String(h.closes_at).slice(0, 5) })),
    closures: closureList.map((c) => ({
      date: c.closure_date, opens: c.opens_at ? String(c.opens_at).slice(0, 5) : null,
      closes: c.closes_at ? String(c.closes_at).slice(0, 5) : null, reason: c.reason || null,
      bookedTables: booked[c.closure_date] || 0,
    })),
    areas: (areas.data || []).map((a) => ({ id: a.id, name: a.name, seats: a.seats, tables: a.tables, active: !!a.is_active })),
    numbers: counts.ok ? {
      thisMonth: { from: monthStart, to: today, ...sum(monthStart, today) },
      lastMonth: { from: lastMonthStart, to: addDays(monthStart, -1), ...sum(lastMonthStart, addDays(monthStart, -1)) },
      next30:    { from: addDays(today, 1), to: addDays(today, 30), ...sum(addDays(today, 1), addDays(today, 30)) },
    } : null,
  });
}

function rulesOut(st) {
  return {
    enabled: !!st.is_enabled, emailEnabled: !!st.email_enabled, autoReleaseLate: !!st.auto_release_late,
    slotMinutes: st.slot_minutes, holdMinutes: st.hold_minutes, lastSeatingMinutes: st.last_seating_minutes,
    leadMinutes: st.lead_minutes, bookAheadDays: st.book_ahead_days, maxPartyInstant: st.max_party_instant,
    maxPartyRequest: st.max_party_request, graceMinutes: st.grace_minutes,
  };
}

// The same limits the database checks, so the manager hears a sentence instead
// of a constraint name.
const NUMBER_RULES = {
  holdMinutes:        ['hold_minutes', 30, 300, 'A table is held between 30 and 300 minutes.'],
  lastSeatingMinutes: ['last_seating_minutes', 0, 240, 'The last booking can be up to 240 minutes before closing.'],
  leadMinutes:        ['lead_minutes', 0, 1440, 'The notice a guest must give is between 0 and 1440 minutes.'],
  bookAheadDays:      ['book_ahead_days', 1, 365, 'Guests can book between 1 and 365 days ahead.'],
  maxPartyInstant:    ['max_party_instant', 1, 50, 'Instant booking is for 1 to 50 people.'],
  maxPartyRequest:    ['max_party_request', 1, 500, 'A request can be for up to 500 people.'],
  graceMinutes:       ['grace_minutes', 0, 240, 'The wait for a late guest is between 0 and 240 minutes.'],
};
const SWITCH_RULES = { enabled: 'is_enabled', emailEnabled: 'email_enabled', autoReleaseLate: 'auto_release_late' };

async function saveRules(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager);
  if (!who) return;
  const s = await settingsFor(res, who.rid);
  if (!s) return;
  const input = body.rules && typeof body.rules === 'object' ? body.rules : {};
  const patch = {};

  for (const [key, column] of Object.entries(SWITCH_RULES)) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') return res.status(400).json({ error: 'A switch is on or off.' });
      patch[column] = input[key];
    }
  }
  for (const [key, [column, min, max, message]] of Object.entries(NUMBER_RULES)) {
    if (key in input) {
      const n = Number(input[key]);
      if (!Number.isInteger(n) || n < min || n > max) return res.status(400).json({ error: message });
      patch[column] = n;
    }
  }
  if ('slotMinutes' in input) {
    const n = Number(input.slotMinutes);
    if (![15, 20, 30, 60].includes(n)) return res.status(400).json({ error: 'Times are offered every 15, 20, 30 or 60 minutes.' });
    patch.slot_minutes = n;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to save.' });

  const merged = { ...s.settings, ...patch };
  if (merged.max_party_request <= merged.max_party_instant) {
    return res.status(400).json({ error: 'The biggest request must be larger than the biggest instant booking.' });
  }
  if (patch.email_enabled === true && !s.settings.email_from_address) {
    return res.status(409).json({ error: 'Emails are not set up for this restaurant yet. Ask Seb\'s Analytics to set up its sending address.' });
  }

  patch.updated_at = new Date().toISOString();
  patch.updated_by = tasterId;
  const saved = await sb(`/restaurant_booking_settings?restaurant_id=eq.${who.rid}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
    console.error('[staff:rules] save failed', who.rid, saved.status);
    return res.status(502).json({ error: 'Could not save the rules (the database answered ' + saved.status + ').' });
  }
  console.log('[staff:rules] taster', tasterId, 'changed', Object.keys(patch).join(','), 'at', who.rid);
  return res.status(200).json({ success: true, rules: rulesOut(saved.data[0]) });
}

// ── OPENING HOURS ─────────────────────────────────────────────────────────────
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function checkHours(list) {
  if (!Array.isArray(list)) return { error: 'The hours must be a list.' };
  if (!list.length) return { error: 'Every day closed? Switch Online booking off instead, so guests are told to call.' };
  if (list.length > 28) return { error: 'At most four services a day.' };
  const byDay = {};
  const clean = [];
  for (const h of list) {
    const weekday = Number(h && h.weekday);
    const opens = String(h && h.opens || ''), closes = String(h && h.closes || '');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'A day of the week is missing.' };
    if (!CLOCK.test(opens) || !CLOCK.test(closes)) return { error: 'Every service needs an opening and a closing time.' };
    if (opens === closes) return { error: 'A service cannot open and close at the same time.' };
    const start = toMin(opens);
    const end = toMin(closes) > start ? toMin(closes) : toMin(closes) + 1440;   // after midnight
    (byDay[weekday] = byDay[weekday] || []).push([start, end]);
    clean.push({ weekday, opens, closes });
  }
  for (const [weekday, spans] of Object.entries(byDay)) {
    if (spans.length > 4) return { error: 'At most four services a day.' };
    spans.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] < spans[i - 1][1]) {
        return { error: `Two services overlap on ${WEEKDAYS[weekday]}. Make one end before the next begins.` };
      }
    }
  }
  return { hours: clean };
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The same week, whatever order it is written in.
function hoursKey(list) {
  return (Array.isArray(list) ? list : []).map((h) => `${Number(h && h.weekday)}|${String(h && h.opens || '').slice(0, 5)}|${String(h && h.closes || '').slice(0, 5)}`)
    .sort().join(',');
}

async function saveHours(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager);
  if (!who) return;
  const checked = checkHours(body.hours);
  if (checked.error) return res.status(400).json({ error: checked.error });

  // The page sends the hours its editor started from. If someone else saved
  // different hours in the meantime, this save would silently undo theirs: say
  // so and send theirs back instead.
  if (Array.isArray(body.base)) {
    const now = await sb(`/restaurant_hours?restaurant_id=eq.${who.rid}&select=weekday,opens_at,closes_at`);
    if (!now.ok || !Array.isArray(now.data)) {
      return res.status(502).json({ error: 'Could not read the hours (the database answered ' + now.status + '). Nothing was changed.' });
    }
    const current = now.data.map((h) => ({ weekday: h.weekday, opens: String(h.opens_at).slice(0, 5), closes: String(h.closes_at).slice(0, 5) }));
    if (hoursKey(current) !== hoursKey(body.base)) {
      return res.status(409).json({
        error: 'Someone else changed the hours a moment ago. Their hours are on the screen now; make your change again.',
        hours: current.sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens)),
      });
    }
  }

  const saved = await sb('/rpc/hf_set_hours', {
    method: 'POST', body: JSON.stringify({ p_restaurant: who.rid, p_hours: checked.hours, p_by: tasterId }),
  });
  if (!saved.ok) {
    console.error('[staff:hours] save failed', who.rid, saved.status);
    return res.status(502).json({
      error: 'Could not save the hours (the database answered ' + saved.status + '). Nothing was changed. '
           + (saved.status === 404 ? 'That usually means migration 17 has not been run yet.' : ''),
    });
  }
  console.log('[staff:hours] taster', tasterId, 'saved', checked.hours.length, 'services at', who.rid);
  return res.status(200).json({ success: true, hours: checked.hours });
}

// ── HOLIDAYS AND SPECIAL DAYS ─────────────────────────────────────────────────
async function closure(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager);
  if (!who) return;
  const s = await settingsFor(res, who.rid);
  if (!s) return;
  const today = todayIn(s.timezone);
  const date = cleanDate(body.date);
  if (!date) return res.status(400).json({ error: 'Pick the day.' });

  if (body.op === 'remove') {
    const gone = await sb(`/restaurant_closures?restaurant_id=eq.${who.rid}&closure_date=eq.${date}`, {
      method: 'DELETE', headers: { Prefer: 'return=representation' },
    });
    if (!gone.ok) return res.status(502).json({ error: 'Could not remove that day (the database answered ' + gone.status + ').' });
    return res.status(200).json({ success: true, removed: date });
  }
  if (body.op !== 'add') return res.status(400).json({ error: 'Add or remove?' });

  if (date < today) return res.status(400).json({ error: 'That day has already passed.' });
  if (date > addDays(today, 730)) return res.status(400).json({ error: 'Pick a day within the next two years.' });
  const opens = body.opens ? String(body.opens) : null;
  const closes = body.closes ? String(body.closes) : null;
  if ((opens === null) !== (closes === null)) return res.status(400).json({ error: 'Give both an opening and a closing time, or neither for a day off.' });
  if (opens && (!CLOCK.test(opens) || !CLOCK.test(closes) || opens === closes)) {
    return res.status(400).json({ error: 'Those special hours are not valid times.' });
  }

  const saved = await sb('/restaurant_closures?on_conflict=restaurant_id,closure_date', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ restaurant_id: who.rid, closure_date: date, opens_at: opens, closes_at: closes,
                           reason: cleanText(body.reason, 80), created_by: tasterId }),
  });
  if (!saved.ok) {
    console.error('[staff:closure] save failed', who.rid, saved.status);
    return res.status(502).json({ error: 'Could not save that day (the database answered ' + saved.status + ').' });
  }
  // Closing a day does not cancel the tables already booked on it. The manager
  // is told how many, so they can call those guests.
  const hits = await sb(`/reservations?restaurant_id=eq.${who.rid}&local_date=in.(${date},${addDays(date, 1)})` +
                        '&status=in.(booked,seated)&select=id,local_date,local_time&limit=1000');
  const bookedTables = hits.ok && Array.isArray(hits.data) ? hits.data.filter((h) => inServiceDay(h, date)).length : 0;
  return res.status(200).json({ success: true, date, opens, closes, bookedTables });
}

// ── ROOMS ─────────────────────────────────────────────────────────────────────
async function area(req, res, body, tasterId) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager);
  if (!who) return;
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').replace(/[<>"]/g, '');
  if (name.length < 2 || name.length > 40) return res.status(400).json({ error: 'A room name is 2 to 40 letters.' });
  const seats = Number(body.seats), tables = Number(body.tables);
  if (!Number.isInteger(seats) || seats < 0 || seats > 500) return res.status(400).json({ error: 'Seats: a number from 0 to 500.' });
  if (!Number.isInteger(tables) || tables < 0 || tables > 200) return res.status(400).json({ error: 'Tables: a number from 0 to 200 (0 = do not count tables).' });
  const active = body.active !== false;

  if (body.op === 'add') {
    const made = await sb('/restaurant_areas', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ restaurant_id: who.rid, name, seats, tables, is_active: active, sort_order: 100 }),
    });
    if (made.status === 409) return res.status(409).json({ error: `There is already a room called "${name}".` });
    if (!made.ok) return res.status(502).json({ error: 'Could not add the room (the database answered ' + made.status + ').' });
    return res.status(200).json({ success: true, area: outArea(made.data[0]) });
  }
  if (body.op !== 'save') return res.status(400).json({ error: 'Add or save?' });

  const id = Number(body.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which room?' });
  if (!active) {
    // Switching off the last open room would make every time "full" online.
    const open = await sb(`/restaurant_areas?restaurant_id=eq.${who.rid}&is_active=eq.true&id=neq.${id}&select=id&limit=1`);
    if (open.ok && Array.isArray(open.data) && !open.data.length) {
      return res.status(409).json({ error: 'Keep at least one room open, or switch Online booking off instead.' });
    }
  }
  // restaurant_id in the filter as well as the id: a room of another restaurant
  // is simply not found.
  const saved = await sb(`/restaurant_areas?id=eq.${id}&restaurant_id=eq.${who.rid}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name, seats, tables, is_active: active }),
  });
  if (saved.status === 409) return res.status(409).json({ error: `There is already a room called "${name}".` });
  if (!saved.ok) return res.status(502).json({ error: 'Could not save the room (the database answered ' + saved.status + ').' });
  if (!Array.isArray(saved.data) || !saved.data.length) return res.status(404).json({ error: 'That room is not there any more.' });
  return res.status(200).json({ success: true, area: outArea(saved.data[0]) });
}

function outArea(a) {
  return { id: a.id, name: a.name, seats: a.seats, tables: a.tables, active: !!a.is_active };
}

// ── DATES ─────────────────────────────────────────────────────────────────────
export function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(date, n) {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}
