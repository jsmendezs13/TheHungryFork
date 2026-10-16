// api/_lib/menuset.js
//
// r36 (Sebastian, 16 Oct 12:45): the manager decides the menu's Top Rated
// caves and the order of the dishes.
//
//   menu_settings    what the Top Rated caves show now (manager page → Menu)
//   menu_top_save    for each of Starters, Entrées, Salads and Drinks: how many
//                    of the best rated dishes it shows, 1 to 10, or 0 = the
//                    cave is not on the menu
//   dish_order_save  the order of the dishes of one part of the menu
//                    (Entrées, Salads…): the fish before the steak
//
// Reached through api/reservations.js like Settings, so the site still deploys
// as twelve functions. Managers, owners and Seb's Analytics: the same people
// who may change the dishes (canEditDishes).
//
// The settings live in menu_settings (migration 25). A restaurant without a
// row shows all four caves with 5 dishes each. publicTop() is what the menu
// itself gets, with the opening hours.

import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, loadAccess, accessProblem, canEditDishes } from './roles.js';

export const TOP_KINDS = ['starters', 'entree', 'salads', 'drinks'];
export const TOP_DEFAULT = 5;
export const TOP_MAX = 10;
const COLUMN = { starters: 'top_starters', entree: 'top_entree', salads: 'top_salads', drinks: 'top_drinks' };

const readLimiter  = makeLimiter({ requests: 300, window: '10 m', prefix: 'menuset:read' });
const writeLimiter = makeLimiter({ requests: 60,  window: '5 m',  prefix: 'menuset:write' });

const NOT_READY = 'The Top Rated settings are not set up yet: migration 25 has not been run.';

// The row as the pages use it: { starters: 5, entree: 5, salads: 5, drinks: 5 }.
function topOf(row) {
  const top = {};
  TOP_KINDS.forEach((k) => {
    const n = row ? Number(row[COLUMN[k]]) : TOP_DEFAULT;
    top[k] = Number.isInteger(n) && n >= 0 && n <= TOP_MAX ? n : TOP_DEFAULT;
  });
  return top;
}
// A table that is not there yet (migration 25 not run): PostgREST says 404, or
// 400 with "relation … does not exist" (42P01) or PGRST205.
function missing(got) {
  const code = got && got.data && got.data.code;
  return got.status === 404 || code === '42P01' || code === 'PGRST205';
}
function failWords(what, got) {
  const st = got.status;
  if (st === 401 || st === 403) return `Could not ${what} (the database answered ${st}): the server is missing its permission. Seb’s Analytics has to run migration 25 again.`;
  return `Could not ${what} (the database answered ${st}). Please try again.`;
}

// For the menu (with the opening hours, api/reservations.js publicHours):
// the four numbers, or null when they cannot be read (the menu then shows the
// four caves with 5 dishes each, as a restaurant that never chose).
export async function publicTop(restaurantId) {
  const got = await sb(`/menu_settings?restaurant_id=eq.${Number(restaurantId)}&select=${Object.values(COLUMN).join(',')}&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) return null;
  return topOf(got.data[0] || null);
}

export async function menuset(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action !== 'menu_settings';
  if (!(await allow(writes ? writeLimiter : readLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many changes at once. Wait a moment and try again.' });
  }
  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  const rid = Number(body.restaurantId);
  if (!Number.isInteger(rid) || rid < 1) return res.status(400).json({ error: 'Which restaurant?' });
  if (!canEditDishes(access, rid)) return res.status(403).json({ error: 'You do not have permission to change this menu.' });

  if (action === 'menu_settings')   return settings(res, rid);
  if (action === 'menu_top_save')   return topSave(res, rid, body, tasterId);
  if (action === 'dish_order_save') return orderSave(res, rid, body, tasterId, access);
  return res.status(400).json({ error: 'Unknown action.' });
}

async function settings(res, rid) {
  const got = await sb(`/menu_settings?restaurant_id=eq.${rid}&select=*&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) {
    if (missing(got)) return res.status(200).json({ ready: false, top: topOf(null), error: NOT_READY });
    return res.status(502).json({ error: failWords('read the Top Rated settings', got) });
  }
  const row = got.data[0] || null;
  return res.status(200).json({ ready: true, top: topOf(row), chosen: !!row, changedOn: row ? row.updated_at : null });
}

async function topSave(res, rid, body, tasterId) {
  const top = body.top;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return res.status(400).json({ error: 'Nothing to save.' });
  const row = { restaurant_id: rid, updated_at: new Date().toISOString(), updated_by: tasterId };
  for (const k of TOP_KINDS) {
    const n = top[k];
    if (!Number.isInteger(n) || n < 0 || n > TOP_MAX) {
      return res.status(400).json({ error: `Top Rated ${k}: choose 1 to ${TOP_MAX} dishes, or 0 to take it off the menu.` });
    }
    row[COLUMN[k]] = n;
  }
  // Insert the row the first time, change it after (restaurant_id is the key).
  const saved = await sb('/menu_settings?on_conflict=restaurant_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
    if (missing(saved)) return res.status(409).json({ error: NOT_READY });
    return res.status(502).json({ error: failWords('save the Top Rated settings', saved) });
  }
  return res.status(200).json({ ready: true, top: topOf(saved.data[0]), chosen: true, changedOn: saved.data[0].updated_at });
}

// The order of one part of the menu: every dish of it, in the new order. The
// server checks they are all this restaurant's, all the same part of the menu,
// and all of it (a list made before someone added a dish would leave that dish
// without a place). sort_order becomes 1, 2, 3… in that part; the menu and the
// manager page show each part by its own sort_order, so the other parts are
// not touched.
async function orderSave(res, rid, body, tasterId, access) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  if (!ids || !ids.length || ids.length > 200 || ids.some((n) => !Number.isInteger(n) || n < 1) || new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'Which dishes, in which order?' });
  }
  const got = await sb(`/dishes?id=in.(${ids.join(',')})&select=id,restaurant_id,restaurant_category,sort_order`);
  if (!got.ok || !Array.isArray(got.data)) return res.status(502).json({ error: failWords('read the dishes', got) });
  if (got.data.length !== ids.length || got.data.some((d) => Number(d.restaurant_id) !== rid)) {
    return res.status(404).json({ error: 'Some of those dishes are not on this menu. Reload the page.' });
  }
  const cat = got.data[0].restaurant_category;
  if (got.data.some((d) => d.restaurant_category !== cat)) return res.status(400).json({ error: 'Those dishes are in different parts of the menu.' });
  const all = await sb(`/dishes?restaurant_id=eq.${rid}&restaurant_category=${cat === null ? 'is.null' : 'eq.' + encodeURIComponent(cat)}&select=id`);
  if (!all.ok || !Array.isArray(all.data)) return res.status(502).json({ error: failWords('read the dishes', all) });
  if (all.data.length !== ids.length) {
    return res.status(409).json({ error: 'The menu changed meanwhile (a dish was added or removed). Reload the page and try again.' });
  }
  const before = {};
  got.data.forEach((d) => { before[d.id] = d.sort_order; });
  const changed = [];
  for (let i = 0; i < ids.length; i++) {
    const want = i + 1;
    if (before[ids[i]] === want) continue;
    const up = await sb(`/dishes?id=eq.${ids[i]}&restaurant_id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({ sort_order: want }) });
    if (!up.ok) {
      return res.status(502).json({ error: failWords('save the order', up) + (changed.length ? ' Part of the new order was saved: reload the page.' : ''), saved: changed.length });
    }
    changed.push({ dish_id: ids[i], old: before[ids[i]], now: want });
  }
  // The change log (as manager-dish.js): never allowed to fail the request.
  if (changed.length) {
    try {
      const rows = changed.map((c) => ({
        dish_id: c.dish_id, restaurant_id: rid, changed_by: tasterId, changed_by_name: access.firstName || null,
        field: 'sort_order', old_value: c.old === null || c.old === undefined ? null : String(c.old), new_value: String(c.now),
      }));
      const logged = await sb('/dish_changes', { method: 'POST', body: JSON.stringify(rows) });
      if (!logged.ok) console.error('[menuset] change log write failed', logged.status);
    } catch (e) { console.error('[menuset] change log threw', e && e.message); }
  }
  return res.status(200).json({ ok: true, order: ids.map((id, i) => ({ id, sort_order: i + 1 })), changed: changed.length });
}
