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

const ROLE_WORD = { owner: 'Owner', manager: 'Manager', crew: 'Crew' };
const JOB_WORD = { host: 'Host', waiter: 'Waiter', kitchen: 'Kitchen', bar: 'Bar' };

const ROLE_RANK = { crew: LEVEL.crew, manager: LEVEL.manager, owner: LEVEL.owner };

// Looking someone up by phone number reveals whether that number has an
// account. Only owners and above can reach it, and this caps how fast anyone
// could walk through a range of numbers looking for hits.
const lookupLimiter = makeLimiter({ requests: 30, window: '10 m', prefix: 'roles:lookup' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const { action, restaurantId, phone, role, tasterId: targetId, canIssueCodes, canMessage, job } = req.body || {};
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
    let rows = await sb(
      `/restaurant_roles?restaurant_id=eq.${restId}` +
      '&select=id,taster_id,role,can_issue_codes,can_message,job,created_at&order=role.asc'
    );
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

    return res.status(200).json({
      success: true,
      myLevel,
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
          // What this particular caller may do to this particular row.
          canRemove: myLevel > (ROLE_RANK[r.role] || 0),
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

    const created = await sb('/restaurant_roles', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        taster_id: target.id,
        restaurant_id: restId,
        role,
        granted_by: tasterId,
      }),
    });
    if (!created.ok) return res.status(500).json({ error: 'Could not add that person.' });

    await syncAdminFlag(target.id);

    console.log('[roles] taster', tasterId, 'granted', role, 'to', target.id, 'at', restId);
    await tellChange(restId, tasterId, `added ${await personName(target.id, { full: true })} to the team as ${ROLE_WORD[role]}`, { go: 'team' });
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
    const row = await sb(`/restaurant_roles?id=eq.${rowId}&select=id,restaurant_id,role,taster_id,can_issue_codes`);
    if (!row.ok || !Array.isArray(row.data) || row.data.length === 0) {
      return res.status(404).json({ error: 'That role no longer exists.' });
    }
    const target = row.data[0];
    if (Number(target.restaurant_id) !== restId) {
      return res.status(403).json({ error: 'That role belongs to another restaurant.' });
    }
    if (target.role !== 'crew') return res.status(400).json({ error: 'Managers and owners always give rewards; this switch is for crew.' });
    if (myLevel < LEVEL.manager) return res.status(403).json({ error: 'Not allowed.' });

    const saved = await sb(`/restaurant_roles?id=eq.${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify({ can_issue_codes: !!canIssueCodes }),
    });
    if (!saved.ok) return res.status(500).json({ error: 'Could not save that.' });
    if (!!target.can_issue_codes !== !!canIssueCodes) {
      const who = await personName(target.taster_id, { full: true });
      await tellChange(restId, tasterId, canIssueCodes ? `let ${who} give rewards` : `stopped ${who} from giving rewards`, { go: 'team' });
    }
    return res.status(200).json({ success: true });
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
    const was = await sb(`/restaurant_roles?id=eq.${rowId}&select=taster_id,can_message,job`);
    const prev = was.ok && Array.isArray(was.data) && was.data[0] ? was.data[0] : null;
    let patch;
    if (action === 'messages') {
      if (typeof canMessage !== 'boolean') return res.status(400).json({ error: 'On or off?' });
      patch = { can_message: canMessage };
    } else {
      const value = job === null || job === '' ? null : String(job);
      if (value !== null && !CREW_JOBS.includes(value)) return res.status(400).json({ error: 'Pick host, waiter, kitchen or bar.' });
      patch = { job: value };
    }
    const saved = await sb(`/restaurant_roles?id=eq.${rowId}&restaurant_id=eq.${restId}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
    });
    if (!saved.ok) {
      return res.status(saved.status === 400 ? 409 : 500).json({
        error: saved.status === 400 ? 'This needs migration 19 first (the messages database).' : 'Could not save that.',
      });
    }
    console.log('[roles] taster', tasterId, 'set', Object.keys(patch)[0], 'for role', rowId, 'at', restId);
    if (prev) {
      const who = await personName(prev.taster_id, { full: true });
      if (action === 'messages' && !!prev.can_message !== !!patch.can_message) {
        await tellChange(restId, tasterId, patch.can_message ? `let ${who} answer guest messages` : `stopped ${who} from answering guest messages`, { go: 'team' });
      }
      if (action === 'job' && (prev.job || null) !== patch.job) {
        await tellChange(restId, tasterId, `set ${who}'s job: ${JOB_WORD[prev.job] || 'none'} → ${JOB_WORD[patch.job] || 'none'}`, { go: 'team' });
      }
    }
    return res.status(200).json({ success: true, canMessage: saved.data && saved.data[0] ? !!saved.data[0].can_message : undefined,
                                  job: saved.data && saved.data[0] ? saved.data[0].job || null : undefined });
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
