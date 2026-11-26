// api/roles.js
//
// Appointing and removing people. The screen in manager.html only draws what
// this endpoint allows; this endpoint is what actually decides.
//
// ── The one rule ───────────────────────────────────────────────────────────
//
// You may grant or remove a role STRICTLY BELOW your own level at that
// restaurant. That single comparison produces everything Sebastian asked for:
//
//   platform admin (4)  →  owner, manager, crew   at any restaurant
//   owner          (3)  →  manager, crew          at their own restaurant
//   manager        (2)  →  crew                   at their own restaurant
//   crew           (1)  →  nobody
//
// An owner cannot appoint another owner, and cannot remove one — not even
// themselves by accident. A manager cannot promote themselves to owner,
// because 2 is not strictly greater than 2. There is no separate list of
// forbidden combinations to keep in step with anything.
//
// Your level is read from the database on every request, never from the token,
// for the reason explained in _lib/roles.js: the token is up to 30 days stale.

import { makeLimiter, allow, keyFor, normalizeUsPhone } from './_lib/auth.js';
import { tasterIdFromRequest, loadAccess, levelAt, LEVEL, sb, accessProblem } from './_lib/roles.js';
// r43 (Sebastian, 26 Oct 22:56): every change to the team is a notification to the
// owners and managers: who did it, what, and when (api/_lib/changes.js).
import { tellChange, personName } from './_lib/changes.js';
// r71: "Tonight only" ends when the service day does (5 AM where the restaurant is); the person is told on their phone.
import { zoneOf, zonedMs, addDays, serviceDayAt } from './_lib/schedule.js';
import { notifyStaff, line } from './_lib/push.js';

const ROLE_WORD = { owner: 'Owner', manager: 'Manager', crew: 'Crew' };
const JOB_WORD = { host: 'Host', waiter: 'Waiter', kitchen: 'Kitchen', bar: 'Bar' };

const ROLE_RANK = { crew: LEVEL.crew, manager: LEVEL.manager, owner: LEVEL.owner };

// r71: may this person clock the others in? ("Tonight only" has an end; it is over once that has passed.)
function clockMode(r) {
  if (!r || !r.clock_others) return 'off';
  if (!r.clock_others_until) return 'always';
  return Date.parse(r.clock_others_until) > Date.now() ? 'tonight' : 'off';
}
async function restaurantName(rid) {
  const r = await sb(`/restaurants?id=eq.${rid}&select=name`);
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].name : 'The restaurant';
}

// Looking someone up by phone number reveals whether that number has an
// account. Only owners and above can reach it, and this caps how fast anyone
// could walk through a range of numbers looking for hits.
const lookupLimiter = makeLimiter({ requests: 30, window: '10 m', prefix: 'roles:lookup' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const { action, restaurantId, phone, role, tasterId: targetId, canIssueCodes, canMessage, job } = req.body || {};   // r70: also roleId, positionId, position
  const restId = Number(restaurantId);
  if (!Number.isInteger(restId) || restId <= 0) {
    return res.status(400).json({ error: 'Which restaurant?' });
  }

  const access = await loadAccess(tasterId, req);           // r43: req, so the session's device is checked
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error, ...(problem.reason ? { reason: problem.reason } : {}) });

  const myLevel = levelAt(access, restId);
  if (myLevel < LEVEL.manager) {
    return res.status(403).json({ error: 'You do not have permission to manage people here.' });
  }

  // ── LIST ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    // r71: clock_others (migration 48) first; r70: position_id, own_message, own_codes (migration 47); r53: can_moderate
    // (migration 37); before them, the list as r52 read it.
    let rows = await sb(
      `/restaurant_roles?restaurant_id=eq.${restId}` +
      '&select=id,taster_id,role,can_issue_codes,can_message,job,can_moderate,position_id,own_message,own_codes,clock_others,clock_others_until,created_at&order=role.asc'
    );
    if (!rows.ok && rows.status === 400) {
      rows = await sb(
        `/restaurant_roles?restaurant_id=eq.${restId}` +
        '&select=id,taster_id,role,can_issue_codes,can_message,job,can_moderate,position_id,own_message,own_codes,created_at&order=role.asc'
      );
    }
    if (!rows.ok && rows.status === 400) {
      rows = await sb(`/restaurant_roles?restaurant_id=eq.${restId}&select=id,taster_id,role,can_issue_codes,can_message,job,can_moderate,created_at&order=role.asc`);
    }
    if (!rows.ok && rows.status === 400) {
      rows = await sb(`/restaurant_roles?restaurant_id=eq.${restId}&select=id,taster_id,role,can_issue_codes,can_message,job,created_at&order=role.asc`);
    }
    // Before migration 19 there is no can_message or job: the list as before.
    if (!rows.ok && rows.status === 400) {
      rows = await sb(`/restaurant_roles?restaurant_id=eq.${restId}&select=id,taster_id,role,can_issue_codes,created_at&order=role.asc`);
    }
    if (!rows.ok || !Array.isArray(rows.data)) {
      // The status is in the message on purpose. "Could not read the people
      // list" sent Sebastian looking at the People feature; "status 401" would
      // have pointed straight at the grant that was missing.
      console.error('[roles] restaurant_roles list failed', rows.status);
      return res.status(502).json({
        error: 'Could not read the people list (the database answered ' + rows.status + '). '
             + 'If that is a 401 or 403, service_role is missing its grant on restaurant_roles.',
      });
    }

    // Names come from a second lookup rather than an embedded join, because the
    // browser cannot read the tasters table at all any more — and should not.
    const ids = [...new Set(rows.data.map((r) => r.taster_id))];
    let people = {};
    if (ids.length) {
      const who = await sb(
        `/tasters?id=in.(${ids.join(',')})&select=id,first_name,last_name,username,phone_number`
      );
      (Array.isArray(who.data) ? who.data : []).forEach((t) => { people[t.id] = t; });
    }

    // r70: the positions (migration 47), with what each one can do in the app.
    let positions;
    const pos = await sb(`/staff_positions?restaurant_id=eq.${restId}&archived_at=is.null&select=id,name,color,sort_order,can_message,can_rewards,can_schedule&order=sort_order.asc,id.asc`);
    if (pos.ok && Array.isArray(pos.data)) {
      positions = pos.data.map((p) => ({ id: Number(p.id), name: p.name, color: p.color, canMessage: !!p.can_message, canRewards: !!p.can_rewards,
        canSchedule: !!p.can_schedule, people: rows.data.filter((r) => Number(r.position_id) === Number(p.id)).length }));
    }

    return res.status(200).json({
      success: true,
      myLevel,
      me: tasterId,
      positions,                              // r70: undefined before migration 47 (the page shows the old Job then)
      people: rows.data.map((r) => {
        const t = people[r.taster_id] || {};
        return {
          id: r.id,
          tasterId: r.taster_id,
          name: [t.first_name, t.last_name].filter(Boolean).join(' ') || 'Unknown',
          username: t.username || null,
          // The last four digits only. An owner needs to recognise which person
          // this is, not to hold their manager's phone number.
          phoneEnds: t.phone_number ? String(t.phone_number).slice(-4) : null,
          role: r.role,
          canIssueCodes: !!r.can_issue_codes,
          // Crew only (migration 19): what they do, and whether they answer
          // guest messages. undefined before the migration: the page hides both.
          canMessage: 'can_message' in r ? !!r.can_message : undefined,
          job: 'job' in r ? r.job || null : undefined,
          // r53: managers only — "Can moderate reviews" (the owner chooses). undefined before migration 37.
          canModerate: r.role === 'manager' && 'can_moderate' in r ? !!r.can_moderate : undefined,
          // r70: the position, and the person's own switches (the position may add to them). undefined before migration 47.
          positionId: 'position_id' in r ? (r.position_id === null ? null : Number(r.position_id)) : undefined,
          ownMessage: 'own_message' in r ? !!r.own_message : undefined,
          ownCodes: 'own_codes' in r ? !!r.own_codes : undefined,
          canSetPosition: myLevel > (ROLE_RANK[r.role] || 0) || Number(r.taster_id) === Number(tasterId),
          // r71: may this crew member clock the others in? off | tonight | always. undefined before migration 48.
          clockOthers: 'clock_others' in r ? clockMode(r) : undefined,
          clockOthersUntil: 'clock_others' in r && clockMode(r) === 'tonight' ? new Date(r.clock_others_until).toISOString() : undefined,
          // What this particular caller may do to this particular row.
          canRemove: myLevel > (ROLE_RANK[r.role] || 0),
          canSetModerate: r.role === 'manager' && myLevel >= LEVEL.owner,
        };
      }),
    });
  }

  // ── GRANT ───────────────────────────────────────────────────────────────
  if (action === 'grant') {
    if (!ROLE_RANK[role]) return res.status(400).json({ error: 'Unknown role.' });
    if (myLevel <= ROLE_RANK[role]) {
      return res.status(403).json({ error: `You cannot appoint someone as ${role}.` });
    }

    if (!(await allow(lookupLimiter, keyFor(tasterId), { failOpen: true }))) {
      return res.status(429).json({ error: 'Too many lookups. Wait a few minutes.' });
    }

    const normalized = normalizeUsPhone(phone);
    if (!normalized) return res.status(400).json({ error: 'Please enter a valid US phone number.' });

    const found = await sb(
      `/tasters?phone_number=eq.${encodeURIComponent(normalized)}&select=id,first_name,last_name,username`
    );
    if (!found.ok) return res.status(502).json({ error: 'Could not look up that number.' });

    // The person has to have an account already. Pre-authorising a number that
    // has never signed up would mean holding a permission against a phone
    // number belonging to nobody — and whoever later claimed that number would
    // inherit it.
    if (!Array.isArray(found.data) || found.data.length === 0) {
      return res.status(404).json({
        error: 'No account with that number yet. Ask them to sign up on the site first, then add them here.',
      });
    }

    const target = found.data[0];

    const existing = await sb(
      `/restaurant_roles?taster_id=eq.${target.id}&restaurant_id=eq.${restId}&select=id,role`
    );
    const already = (Array.isArray(existing.data) ? existing.data : []).find((r) => r.role === role);
    if (already) {
      return res.status(409).json({ error: `${target.first_name} is already ${role} here.` });
    }

    // r70: the Add row has a position too (migration 47).
    let position = null;
    const pidRaw = req.body.positionId;
    if (pidRaw !== undefined && pidRaw !== null && pidRaw !== '') {
      const pid = Number(pidRaw);
      const got = Number.isInteger(pid) && pid > 0 ? await sb(`/staff_positions?id=eq.${pid}&restaurant_id=eq.${restId}&archived_at=is.null&select=id,name,job`) : null;
      position = got && got.ok && Array.isArray(got.data) ? got.data[0] || null : null;
      if (!position) return res.status(400).json({ error: 'That position is not here any more.' });
    }

    const created = await sb('/restaurant_roles', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        taster_id: target.id,
        restaurant_id: restId,
        role,
        granted_by: tasterId,
        ...(position ? { position_id: Number(position.id), job: position.job || null } : {}),
      }),
    });
    if (!created.ok) return res.status(500).json({ error: 'Could not add that person.' });

    await syncAdminFlag(target.id);

    console.log('[roles] taster', tasterId, 'granted', role, 'to', target.id, 'at', restId);
    await tellChange(restId, tasterId, `added ${await personName(target.id, { full: true })} to the team as ${ROLE_WORD[role]}${position ? ' · ' + position.name : ''}`, { go: 'team' });
    return res.status(200).json({
      success: true,
      added: {
        name: [target.first_name, target.last_name].filter(Boolean).join(' '),
        username: target.username,
        role,
      },
    });
  }

  // ── REVOKE ──────────────────────────────────────────────────────────────
  if (action === 'revoke') {
    const rowId = Number(req.body.roleId);
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ error: 'Which role?' });

    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,taster_id,restaurant_id,role`);
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) {
      return res.status(404).json({ error: 'That role no longer exists.' });
    }
    const target = row.data[0];

    // The row decides which restaurant is involved, never the request body.
    if (Number(target.restaurant_id) !== restId) {
      return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    }
    if (myLevel <= (ROLE_RANK[target.role] || 0)) {
      return res.status(403).json({ error: `You cannot remove ${target.role}s.` });
    }

    const gone = await sb(`/restaurant_roles?id=eq.${rowId}`, { method: 'DELETE' });
    if (!gone.ok) return res.status(500).json({ error: 'Could not remove that person.' });

    await syncAdminFlag(target.taster_id);

    console.log('[roles] taster', tasterId, 'revoked', target.role, 'from', target.taster_id);
    await tellChange(restId, tasterId, `removed ${await personName(target.taster_id, { full: true })} (${ROLE_WORD[target.role] || target.role}) from the team`, { go: 'team' });
    return res.status(200).json({ success: true });
  }

  // ── CREW CODE PERMISSION ────────────────────────────────────────────────
  if (action === 'codes') {
    const rowId = Number(req.body.roleId);
    let row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,can_issue_codes:own_codes`);   // r70: the own switch
    if (!row.ok && row.status === 400) row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,can_issue_codes`);
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) {
      return res.status(404).json({ error: 'That role no longer exists.' });
    }
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) {
      return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    }
    if (target.role !== 'crew') return res.status(400).json({ error: 'Managers and owners always give rewards; this switch is for crew.' });
    if (myLevel < LEVEL.manager) return res.status(403).json({ error: 'Not allowed.' });

    // r70: the person's own switch (migration 47: the position may add to it); before migration 47 the column itself.
    let saved = await sb(`/restaurant_roles?id=eq.${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ own_codes: !!canIssueCodes }),
    });
    if (!saved.ok && saved.status === 400) {
      saved = await sb(`/restaurant_roles?id=eq.${rowId}`, { method: 'PATCH', body: JSON.stringify({ can_issue_codes: !!canIssueCodes }) });
    }
    if (!saved.ok) return res.status(500).json({ error: 'Could not save that.' });
    if (!!target.can_issue_codes !== !!canIssueCodes) {
      const who = await personName(target.taster_id, { full: true });
      await tellChange(restId, tasterId, canIssueCodes ? `let ${who} give rewards` : `stopped ${who} from giving rewards`, { go: 'team' });
    }
    return res.status(200).json({ success: true });
  }

  // ── MANAGERS: CAN MODERATE REVIEWS (r53) ───────────────────────────────
  // Sebastian, 5 Nov: the owner, and the managers the owner chooses, moderate reviews. Never crew.
  if (action === 'moderate') {
    const rowId = Number(req.body.roleId);
    const on = req.body.canModerate;
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ error: 'Which person?' });
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'On or off?' });
    if (myLevel < LEVEL.owner) return res.status(403).json({ error: 'Only the owner chooses who moderates reviews.' });
    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,can_moderate`);
    if (!row.ok && row.status === 400) return res.status(409).json({ error: 'This needs migration 37 first (the moderation database).' });
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) return res.status(404).json({ error: 'That role no longer exists.' });
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    if (target.role !== 'manager') return res.status(400).json({ error: 'Owners always moderate, and crew never do. This switch is for managers.' });
    const saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, { method: 'PATCH', body: JSON.stringify({ can_moderate: on }) });
    if (!saved.ok) return res.status(500).json({ error: 'Could not save that.' });
    if (!!target.can_moderate !== on) {
      const who = await personName(target.taster_id, { full: true });
      await tellChange(restId, tasterId, on ? `let ${who} moderate reviews` : `stopped ${who} from moderating reviews`, { go: 'team' });
    }
    console.log('[roles] taster', tasterId, 'set can_moderate', on, 'for role', rowId, 'at', restId);
    return res.status(200).json({ success: true, canModerate: on });
  }

  // ── CREW: ANSWERS GUEST MESSAGES · JOB ────────────────────────────────────
  // Sebastian, 8 Oct: a manager decides which crew members talk to guests
  // about their tables (a host, a waiter), and can say what each one does.
  // Managers and owners always answer; this switch is for crew only.
  if (action === 'messages' || action === 'job') {
    const rowId = Number(req.body.roleId);
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ error: 'Which person?' });
    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role`);
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) {
      return res.status(404).json({ error: 'That role no longer exists.' });
    }
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) {
      return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    }
    if (target.role !== 'crew') {
      return res.status(400).json({ error: 'Managers and owners always answer guests. This is for crew.' });
    }
    // r43: as it was, for the notification (before migration 19 these columns are not there: no words then)
    // r70: "can_message" here is the person's own switch when migration 47 is in
    let was = await sb(`/restaurant_roles?id=eq.${rowId}&select=taster_id,can_message:own_message,job`);
    if (!was.ok) was = await sb(`/restaurant_roles?id=eq.${rowId}&select=taster_id,can_message,job`);
    const prev = was.ok && Array.isArray(was.data) && was.data[0] ? was.data[0] : null;
    let patch, fallback = null;
    if (action === 'messages') {
      if (typeof canMessage !== 'boolean') return res.status(400).json({ error: 'On or off?' });
      // r70: the person's own switch (migration 47: the position may add to it); before migration 47 the column itself.
      patch = { own_message: canMessage };
      fallback = { can_message: canMessage };
    } else {
      const value = job === null || job === '' ? null : String(job);
      if (value !== null && !CREW_JOBS.includes(value)) return res.status(400).json({ error: 'Pick host, waiter, kitchen or bar.' });
      patch = { job: value };
    }
    let saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    if (!saved.ok && saved.status === 400 && fallback) {
      patch = fallback;
      saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
      });
    }
    if (!saved.ok) {
      return res.status(saved.status === 400 ? 409 : 500).json({
        error: saved.status === 400 ? 'This needs migration 19 first (the messages database).' : 'Could not save that.',
      });
    }
    console.log('[roles] taster', tasterId, 'set', Object.keys(patch)[0], 'for role', rowId, 'at', restId);
    if (prev) {
      const who = await personName(prev.taster_id, { full: true });
      if (action === 'messages' && !!prev.can_message !== !!canMessage) {
        await tellChange(restId, tasterId, canMessage ? `let ${who} answer guest messages` : `stopped ${who} from answering guest messages`, { go: 'team' });
      }
      if (action === 'job' && (prev.job || null) !== patch.job) {
        await tellChange(restId, tasterId, `set ${who}'s job: ${JOB_WORD[prev.job] || 'none'} → ${JOB_WORD[patch.job] || 'none'}`, { go: 'team' });
      }
    }
    return res.status(200).json({ success: true, canMessage: saved.data && saved.data[0] ? !!saved.data[0].can_message : undefined,
                                  job: saved.data && saved.data[0] ? saved.data[0].job || null : undefined });
  }

  // ── r71: CLOCKING THE OTHERS IN, LET TO SOMEONE ─────────────────────────────
  // Sebastian, 25 Nov: "Add the option that let someone have the option for clock in others, maybe a manager let to the
  // bartender clock in someone when he's not at the restaurant, so he can delegate that option".
  // Crew only (managers and owners clock people in already). "Tonight only" ends at 5 AM, when the service day ends.
  if (action === 'clock_delegate') {
    const rowId = Number(req.body.roleId);
    const mode = req.body.mode;
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ error: 'Which person?' });
    if (!['off', 'tonight', 'always'].includes(mode)) return res.status(400).json({ error: 'Pick Off, Tonight only, or Until I turn it off.' });
    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,clock_others,clock_others_until`);
    if (!row.ok && row.status === 400) return res.status(409).json({ error: 'This needs migration 48 first (clocking in).' });
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) return res.status(404).json({ error: 'That role no longer exists.' });
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    if (target.role !== 'crew') return res.status(400).json({ error: 'Managers and owners clock people in already.' });
    const tz = await zoneOf(restId);
    const until = mode === 'tonight' ? new Date(zonedMs(addDays(serviceDayAt(Date.now(), tz), 1), '05:00', tz)).toISOString() : null;
    const saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ clock_others: mode !== 'off', clock_others_until: until }),
    });
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) return res.status(500).json({ error: 'Could not save that.' });
    const was = clockMode(target);
    if (was !== mode || mode === 'tonight') {
      const who = await personName(target.taster_id, { full: true });
      const words = { off: `stopped ${who} from clocking the others in`, tonight: `let ${who} clock the others in tonight (until 5 AM)`,
                      always: `let ${who} clock the others in, until it is switched off` };
      await tellChange(restId, tasterId, words[mode], { go: 'team' });
      if (Number(target.taster_id) !== Number(tasterId)) {
        const boss = await personName(tasterId);
        const name = await restaurantName(restId);
        await notifyStaff(restId, 'schedule', {
          title: `${name} · Schedule`,
          body: line(mode === 'off' ? `${boss} switched off clocking the others in for you.`
            : `${boss} let you clock the others in${mode === 'tonight' ? ' tonight (until 5 AM)' : ''}. Team → Schedule → Who's in.`, 170),
          url: `/manager#go=schedule&at=${restId}&in=1`, tag: `clock-let-${restId}-${Date.now()}`,
        }, { only: [Number(target.taster_id)] });
      }
    }
    return res.status(200).json({ success: true, clockOthers: clockMode(saved.data[0]), clockOthersUntil: until });
  }

  // ── r70: A PERSON'S POSITION ─────────────────────────────────────────────
  // Sebastian, 25 Nov: "The manager registered their phone numbers as crew members and select its position, existing
  // one or create a new one with the different functions on the app".
  if (action === 'position') {
    const rowId = Number(req.body.roleId);
    const raw = req.body.positionId;
    const pid = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (!Number.isInteger(rowId) || rowId <= 0) return res.status(400).json({ error: 'Which person?' });
    if (pid !== null && (!Number.isInteger(pid) || pid <= 0)) return res.status(400).json({ error: 'Which position?' });
    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,position_id`);
    if (!row.ok && row.status === 400) return res.status(409).json({ error: 'Positions need migration 47 first.' });
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) return res.status(404).json({ error: 'That role no longer exists.' });
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    if (!(myLevel > (ROLE_RANK[target.role] || 0) || Number(target.taster_id) === Number(tasterId))) {
      return res.status(403).json({ error: `You cannot change a ${target.role}'s position.` });
    }
    const list = await sb(`/staff_positions?restaurant_id=eq.${restId}&archived_at=is.null&select=id,name,job`);
    const all = list.ok && Array.isArray(list.data) ? list.data : [];
    const chosen = pid === null ? null : all.find((p) => Number(p.id) === pid);
    if (pid !== null && !chosen) return res.status(404).json({ error: 'That position is not here any more.' });
    const saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ position_id: pid, job: chosen && chosen.job ? chosen.job : null }),
    });
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) return res.status(500).json({ error: 'Could not save that.' });
    const was = all.find((p) => Number(p.id) === Number(target.position_id));
    if (Number(target.position_id || 0) !== Number(pid || 0)) {
      const who = await personName(target.taster_id, { full: true });
      await tellChange(restId, tasterId, `set ${who}'s position: ${was ? was.name : 'none'} → ${chosen ? chosen.name : 'none'}`, { go: 'team' });
    }
    return res.status(200).json({ success: true, positionId: pid, canMessage: !!saved.data[0].can_message, canIssueCodes: !!saved.data[0].can_issue_codes });
  }

  // ── r70: A POSITION: NEW, CHANGED, REMOVED ─────────────────────────────────
  if (action === 'position_save') {
    const p = req.body.position || {};
    const name = typeof p.name === 'string' ? p.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || Array.from(name).length > 30) return res.status(400).json({ error: 'A position has a name of 1 to 30 letters.' });
    if (/[<>]/.test(name)) return res.status(400).json({ error: 'A name cannot have < or >.' });
    const color = typeof p.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.color) ? p.color.toUpperCase() : null;
    if (!color) return res.status(400).json({ error: 'Pick a color.' });
    for (const k of ['canMessage', 'canRewards', 'canSchedule']) {
      if (typeof p[k] !== 'boolean') return res.status(400).json({ error: 'Switch each function on or off.' });
    }
    const fields = { name, color, can_message: p.canMessage, can_rewards: p.canRewards, can_schedule: p.canSchedule };
    const id = p.id === undefined || p.id === null ? null : Number(p.id);
    let before = null, saved;
    if (id !== null) {
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which position?' });
      const got = await sb(`/staff_positions?id=eq.${id}&restaurant_id=eq.${restId}&archived_at=is.null&select=id,name,color,can_message,can_rewards,can_schedule`);
      if (!got.ok && got.status === 404) return res.status(409).json({ error: 'Positions need migration 47 first.' });
      before = got.ok && Array.isArray(got.data) ? got.data[0] : null;
      if (!before) return res.status(404).json({ error: 'That position is not here any more.' });
      saved = await sb(`/staff_positions?id=eq.${id}&restaurant_id=eq.${restId}&archived_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(fields) });
    } else {
      const last = await sb(`/staff_positions?restaurant_id=eq.${restId}&select=sort_order&order=sort_order.desc&limit=1`);
      if (!last.ok && last.status === 404) return res.status(409).json({ error: 'Positions need migration 47 first.' });
      const count = await sb(`/staff_positions?restaurant_id=eq.${restId}&archived_at=is.null&select=id`);
      if (count.ok && Array.isArray(count.data) && count.data.length >= 30) return res.status(409).json({ error: 'A restaurant can have up to 30 positions.' });
      const order = last.ok && Array.isArray(last.data) && last.data[0] ? Number(last.data[0].sort_order) + 1 : 1;
      saved = await sb('/staff_positions', { method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ restaurant_id: restId, ...fields, sort_order: order, created_by: tasterId }) });
    }
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
      if (saved.status === 409 || (saved.data && saved.data.code === '23505')) return res.status(409).json({ error: `There is already a position called ${name}.` });
      return res.status(500).json({ error: 'Could not save the position.' });
    }
    const row = saved.data[0];
    const fn = (b, on, words) => (on === b ? null : (on ? words + ' on' : words + ' off'));
    if (!before) {
      await tellChange(restId, tasterId, `added the position ${name}`, { go: 'team' });
    } else {
      const what = [before.name !== name ? `renamed to ${name}` : null, before.color !== color ? 'new color' : null,
        fn(!!before.can_message, p.canMessage, 'answers guest messages'), fn(!!before.can_rewards, p.canRewards, 'gives rewards'),
        fn(!!before.can_schedule, p.canSchedule, 'builds the schedule')].filter(Boolean);
      if (what.length) await tellChange(restId, tasterId, `changed the position ${before.name}: ${what.join(', ')}`, { go: 'team' });
    }
    return res.status(200).json({ success: true, position: { id: Number(row.id), name: row.name, color: row.color,
      canMessage: !!row.can_message, canRewards: !!row.can_rewards, canSchedule: !!row.can_schedule } });
  }

  if (action === 'position_archive') {
    const id = Number(req.body.positionId);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which position?' });
    const people = await sb(`/restaurant_roles?restaurant_id=eq.${restId}&position_id=eq.${id}&select=id`);
    const done = await sb(`/staff_positions?id=eq.${id}&restaurant_id=eq.${restId}&archived_at=is.null`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ archived_at: new Date().toISOString() }) });
    if (!done.ok && done.status === 404) return res.status(409).json({ error: 'Positions need migration 47 first.' });
    if (!done.ok || !Array.isArray(done.data) || !done.data.length) return res.status(404).json({ error: 'That position is not here any more.' });
    const n = people.ok && Array.isArray(people.data) ? people.data.length : 0;
    await tellChange(restId, tasterId, `removed the position ${done.data[0].name}${n ? ` (${n} ${n === 1 ? 'person has' : 'people have'} no position now)` : ''}`, { go: 'team' });
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ error: 'Unknown action.' });
}

const CREW_JOBS = ['host', 'waiter', 'kitchen', 'bar'];

// tasters.is_restaurant_admin is a copy of "does this account hold any role
// anywhere". It exists so the corner menu on every page can decide whether to
// draw the Manager link without every ordinary customer paying for an extra
// request on every page load. This function is the only thing that writes it.
async function syncAdminFlag(tasterId) {
  try {
    const roles = await sb(`/restaurant_roles?taster_id=eq.${tasterId}&select=id&limit=1`);
    const has = Array.isArray(roles.data) && roles.data.length > 0;
    await sb(`/tasters?id=eq.${tasterId}`, {
      method: 'PATCH',
      body: JSON.stringify({ is_restaurant_admin: has }),
    });
  } catch (e) {
    // A stale flag draws a menu link that leads to a page saying no. Not worth
    // failing the appointment over.
    console.error('[roles] could not sync is_restaurant_admin', e?.message);
  }
}
