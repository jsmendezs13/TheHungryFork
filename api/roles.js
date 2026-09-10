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

// Ranked, so "at least a manager" is one comparison instead of a list of
// role names that someone will forget to update.
export const LEVEL = { none: 0, crew: 1, manager: 2, owner: 3, platform: 4 };

// Reads the caller's real, current standing straight from the database.
export async function loadAccess(tasterId) {
  const [who, roles] = await Promise.all([
    sb(`/tasters?id=eq.${tasterId}&select=id,first_name,is_platform_admin`),
    sb(`/restaurant_roles?taster_id=eq.${tasterId}&select=restaurant_id,role,can_issue_codes`),
  ]);

  if (!who.ok || !Array.isArray(who.data) || who.data.length === 0) return null;

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

  return {
    tasterId: who.data[0].id,
    firstName: who.data[0].first_name,
    isPlatformAdmin: !!who.data[0].is_platform_admin,
    byRestaurant,
  };
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
