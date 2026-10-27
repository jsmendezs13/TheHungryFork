// api/_lib/roles.js
//
// Who is allowed to do what.
//
// The session token lasts 30 days and carries the role the account had at the
// moment it logged in. That is enough to say "this request is taster 7". It is
// NOT enough to say "taster 7 may still edit this restaurant" — an owner you
// removed this morning would keep that power in their pocket until the token
// expired, and the only way to cut it short would be rotating the JWT secret,
// which logs out every customer on the platform.
//
// So the token only IDENTIFIES. The database AUTHORISES, on every request.
// One extra query per write, and removing someone takes effect immediately.

import jwt from 'jsonwebtoken';

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://pkdwrjwsqrlfdxgqmpva.supabase.co';

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  };
}

// Thin wrapper over PostgREST. Returns parsed JSON or null rather than
// throwing on a non-JSON body, so callers only ever check `ok`.
export async function sb(path, options = {}) {
  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    ...options,
    headers: { ...serviceHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) console.error('[sb]', res.status, path, text.slice(0, 300));
  return { ok: res.ok, status: res.status, data };
}

// Returns the taster id the caller proved they own, or null. Never trust
// anything else in the token — the roles inside it may be a month stale.
export function tasterIdFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return null;

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.error('[roles] SUPABASE_JWT_SECRET is not set');
    return null;
  }

  try {
    const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
    const id = Number(claims.taster_id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;   // expired, tampered with, or signed by someone else
  }
}

// r43: the device a staff session belongs to (claim "dev", api/_lib/devices.js), or null.
export function deviceIdFromRequest(req) {
  const header = (req && req.headers && req.headers.authorization) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token || !process.env.SUPABASE_JWT_SECRET) return null;
  try {
    const claims = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, { algorithms: ['HS256'] });
    const id = Number(claims.dev);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

// Ranked, so "at least a manager" is one comparison instead of a list of
// role names that someone will forget to update.
export const LEVEL = { none: 0, crew: 1, manager: 2, owner: 3, platform: 4 };

// Reads the caller's real, current standing straight from the database.
//
// r43 (Sebastian, 26 Oct): req is the request itself, so the session's device
// can be checked. An account with a role (or the platform admin) must be on a
// device that is still trusted (not removed, not past its 60 days): otherwise
// access.deviceProblem is set and accessProblem answers 401 "log in again". A
// caller that forgets to pass req is refused for a staff account (fail closed).
// Before migration 30 (no staff_devices table) nothing is checked.
export async function loadAccess(tasterId, req) {
  const dev = req ? deviceIdFromRequest(req) : null;
  const [who, roles, device] = await Promise.all([
    sb(`/tasters?id=eq.${tasterId}&select=id,first_name,username,is_platform_admin`),
    sb(`/restaurant_roles?taster_id=eq.${tasterId}&select=restaurant_id,role,can_issue_codes`),
    dev ? sb(`/staff_devices?id=eq.${dev}&taster_id=eq.${Number(tasterId)}&select=id,label,verified_at,trusted_until,last_used_at,revoked_at&limit=1`)
        : sb(`/staff_devices?taster_id=eq.${Number(tasterId)}&select=id&limit=1`),
  ]);

  if (!who.ok || !Array.isArray(who.data) || who.data.length === 0) return null;

  // If the roles table itself could not be read, we do NOT know what this
  // person may do — and "no roles" is not the answer. It only looks like one.
  //
  // This is exactly how restaurant_roles stayed broken from the day it was
  // created: the read was failing, the failure produced an empty list, and an
  // empty list is indistinguishable from an honest "this person is not a
  // manager anywhere". Migration 8 fixed the cause; this makes sure the next
  // one announces itself instead of hiding behind a plausible answer.
  const rolesUnavailable = !roles.ok || !Array.isArray(roles.data);
  if (rolesUnavailable) {
    console.error('[roles] restaurant_roles read failed', roles.status);
  }

  // One person can hold more than one role at the same restaurant; the
  // strongest one wins.
  const byRestaurant = {};
  (Array.isArray(roles.data) ? roles.data : []).forEach((r) => {
    const level = LEVEL[r.role] || 0;
    const current = byRestaurant[r.restaurant_id];
    if (!current || level > current.level) {
      byRestaurant[r.restaurant_id] = {
        role: r.role,
        level,
        canIssueCodes: !!r.can_issue_codes,
      };
    }
  });

  // r43: the device. Staff = the platform admin, anyone with a role, or anyone
  // whose roles could not be read (never skipped on a guess).
  const isPlatformAdmin = !!who.data[0].is_platform_admin;
  const staff = isPlatformAdmin || rolesUnavailable || Object.keys(byRestaurant).length > 0;
  let deviceRow = null, deviceProblem = null, devicesOff = false;
  if (device && !device.ok && device.status === 404) devicesOff = true;          // before migration 30
  else if (staff && device && !device.ok) deviceProblem = 'unavailable';      // the check could not be made: not a logout
  else if (staff) {
    const row = dev && device && device.ok && Array.isArray(device.data) && device.data.length ? device.data[0] : null;
    if (row && !row.revoked_at && Date.parse(row.trusted_until) > Date.now()) {
      deviceRow = row;
      if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3600 * 1000) {
        await sb(`/staff_devices?id=eq.${Number(row.id)}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_used_at: new Date().toISOString() }),
        });
      }
    } else {
      deviceProblem = !dev ? 'none' : (row && row.revoked_at ? 'removed' : row ? 'expired' : 'unknown');
    }
  }

  return {
    tasterId: who.data[0].id,
    firstName: who.data[0].first_name,
    handle: who.data[0].username || null,       // r27: shown beside the name (Santiago (Santi_V))
    isPlatformAdmin,
    byRestaurant,
    rolesUnavailable,
    device: deviceRow,                           // r43: the trusted device of this session (null for guests)
    deviceProblem,
    devicesOff,
  };
}

// Every endpoint that calls loadAccess should run its result through this
// before deciding anything, so the answer to "can I?" is never "no" when the
// truth is "we could not find out".
//
// A platform admin is the exception, and deliberately so: their standing comes
// from tasters.is_platform_admin, not from the roles table, so the outage does
// not change what they may do — and they are the one person who can go and fix
// it. Locking Sebastian out of his own dashboard because the roles table is
// unreachable would be the opposite of helpful.
export function accessProblem(access) {
  if (!access) return { status: 401, error: 'Please log in again.' };
  // r43: when the roles cannot be read, that is the answer (502) — never a logout for a device a guest does not have.
  if (access.rolesUnavailable && !access.isPlatformAdmin) {
    return {
      status: 502,
      error: 'Could not read the permissions table, so we cannot tell what you are allowed to do. '
           + 'This is a problem on our side, not with your account. Please try again in a moment.',
    };
  }
  // r43: a staff session on a device that is not (or no longer) trusted.
  if (access.deviceProblem === 'unavailable') {
    return { status: 502, error: 'Could not check this device right now. Please try again in a moment.' };
  }
  if (access.deviceProblem) {
    return { status: 401, reason: 'device', error: access.deviceProblem === 'removed'
      ? 'This device was removed from your account. Please log in again.'
      : 'Please log in again: this device needs to be confirmed with a code.' };
  }
  return null;
}

// Platform admin outranks every restaurant. Everyone else is only as strong as
// their role at the restaurant actually being touched.
export function levelAt(access, restaurantId) {
  if (!access) return LEVEL.none;
  if (access.isPlatformAdmin) return LEVEL.platform;
  const entry = access.byRestaurant[String(restaurantId)] || access.byRestaurant[Number(restaurantId)];
  return entry ? entry.level : LEVEL.none;
}

// Convenience gates, named after what they protect rather than the number.
export const canEditDishes      = (a, r) => levelAt(a, r) >= LEVEL.manager;
export const canReplyToReviews  = (a, r) => levelAt(a, r) >= LEVEL.manager;
export const canAppointManagers = (a, r) => levelAt(a, r) >= LEVEL.owner;
export const canAppointOwners   = (a)    => !!a && a.isPlatformAdmin;
