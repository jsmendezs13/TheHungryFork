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
// r40 (Sebastian, 19 Oct 23:57): menu_top_save may carry, instead of (or with)
// the four numbers, the order of the caves of one carousel — the menu's
// (Chef's Pick, Appetizers, Entrées…) or the drinks' (Bartender's Pick, Wines,
// Cocktails…): order: { side: 'main' | 'drinks', keys: [...] }. It rides on
// menu_top_save so api/reservations.js (the function that routes it) does not
// change. Saved in menu_settings.cave_order_main / cave_order_drinks
// (migration 27); empty = the menu's own order. With them, hidden: [...] — the
// caves the manager took off the menu (their dishes stay; only the door goes),
// in caves_hidden.
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
import { tellChange } from './changes.js';      // r43: a notification to the owners and managers

export const TOP_KINDS = ['starters', 'entree', 'salads', 'drinks'];
export const TOP_DEFAULT = 5;
export const TOP_MAX = 10;
const COLUMN = { starters: 'top_starters', entree: 'top_entree', salads: 'top_salads', drinks: 'top_drinks' };

const readLimiter  = makeLimiter({ requests: 300, window: '10 m', prefix: 'menuset:read' });
const writeLimiter = makeLimiter({ requests: 60,  window: '5 m',  prefix: 'menuset:write' });

const NOT_READY = 'The Top Rated settings are not set up yet: migration 25 has not been run.';
const ORDER_NOT_READY = 'The order of the caves is not set up yet: migration 27 has not been run.';
// The caves each carousel may have (the menu adds the ones it has, in this order, after the saved ones).
export const CAVES = {
  main:   ['chefs-pick', 'starters', 'entree', 'salads', 'sides', 'desserts', 'drinks', 'top-starters', 'top-entree', 'top-salads'],
  drinks: ['bartenders-pick', 'wines', 'cocktails', 'beers', 'spirits', 'shots', 'drinks-other', 'top-drinks'],
};
const ORDER_COLUMN = { main: 'cave_order_main', drinks: 'cave_order_drinks' };
// The caves a manager may take off the menu: the parts of the menu and the kinds of drink (not Chef's Pick, the
// Drinks door, Bartender's Pick or the Top Rated ones: those have their own switches).
export const HIDEABLE = ['starters', 'entree', 'salads', 'sides', 'desserts', 'wines', 'cocktails', 'beers', 'spirits', 'shots', 'drinks-other'];
// The saved order as the pages use it: { main: [...], drinks: [...], hidden: [...] } (only known caves, each once).
function orderOf(row) {
  const out = {};
  for (const side of Object.keys(CAVES)) {
    const v = row && Array.isArray(row[ORDER_COLUMN[side]]) ? row[ORDER_COLUMN[side]] : [];
    out[side] = [...new Set(v.filter((k) => CAVES[side].includes(k)))];
  }
  const h = row && Array.isArray(row.caves_hidden) ? row.caves_hidden : [];
  out.hidden = [...new Set(h.filter((k) => HIDEABLE.includes(k)))];
  return out;
}

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
// r40: with the order of the caves too (top.order), when migration 27 is in — the whole row is asked for, so the
// same request works before and after it.
export async function publicTop(restaurantId) {
  const got = await sb(`/menu_settings?restaurant_id=eq.${Number(restaurantId)}&select=*&limit=1`);
  if (!got.ok || !Array.isArray(got.data)) return null;
  const row = got.data[0] || null;
  const top = topOf(row);
  if (row && (ORDER_COLUMN.main in row)) top.order = orderOf(row);
  return top;
}

export async function menuset(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const writes = action !== 'menu_settings';
  if (!(await allow(writes ? writeLimiter : readLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many changes at once. Wait a moment and try again.' });
  }
  const access = await loadAccess(tasterId, req);           // r43: req, so the session's device is checked
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error, ...(problem.reason ? { reason: problem.reason } : {}) });

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
  // r40: orderReady — whether migration 27 is in (a row is needed to know; without one, the column list is asked for).
  let orderReady = row ? ORDER_COLUMN.main in row : null;
  if (orderReady === null) {
    const probe = await sb(`/menu_settings?select=${ORDER_COLUMN.main}&limit=1`);
    orderReady = probe.ok;
  }
  return res.status(200).json({ ready: true, top: topOf(row), chosen: !!row, changedOn: row ? row.updated_at : null,
                                order: orderOf(row), orderReady });
}

async function topSave(res, rid, body, tasterId) {
  const top = body.top, order = body.order, hidden = body.hidden;
  const hasTop = top && typeof top === 'object' && !Array.isArray(top);
  const hasOrder = order && typeof order === 'object' && !Array.isArray(order);
  const hasHidden = hidden !== undefined;
  if (!hasTop && !hasOrder && !hasHidden) return res.status(400).json({ error: 'Nothing to save.' });
  const row = { restaurant_id: rid, updated_at: new Date().toISOString(), updated_by: tasterId };
  if (hasTop) {
    for (const k of TOP_KINDS) {
      const n = top[k];
      if (!Number.isInteger(n) || n < 0 || n > TOP_MAX) {
        return res.status(400).json({ error: `Top Rated ${k}: choose 1 to ${TOP_MAX} dishes, or 0 to take it off the menu.` });
      }
      row[COLUMN[k]] = n;
    }
  }
  if (hasOrder) {
    // r40: the order of the caves of one carousel: every key one of its caves, each once.
    const side = order.side, keys = order.keys;
    if (!Object.prototype.hasOwnProperty.call(CAVES, side)) return res.status(400).json({ error: 'Which carousel: the menu or the drinks?' });
    if (!Array.isArray(keys) || keys.length > CAVES[side].length || keys.some((k) => !CAVES[side].includes(k)) || new Set(keys).size !== keys.length) {
      return res.status(400).json({ error: 'That order has a cave the menu does not have. Reload the page and try again.' });
    }
    const probe = await sb(`/menu_settings?select=${ORDER_COLUMN[side]}&limit=1`);
    if (!probe.ok) return res.status(409).json({ error: missing(probe) ? NOT_READY : ORDER_NOT_READY });
    row[ORDER_COLUMN[side]] = keys;
  }
  if (hasHidden) {
    // r40: the caves taken off the menu (all of them at once: the list as it is now).
    if (!Array.isArray(hidden) || hidden.some((k) => !HIDEABLE.includes(k)) || new Set(hidden).size !== hidden.length) {
      return res.status(400).json({ error: 'That cave cannot be hidden here. Reload the page and try again.' });
    }
    const probe = await sb('/menu_settings?select=caves_hidden&limit=1');
    if (!probe.ok) return res.status(409).json({ error: missing(probe) ? NOT_READY : ORDER_NOT_READY });
    row.caves_hidden = hidden;
  }
  // r43: as it was, for the notification
  const was = await sb(`/menu_settings?restaurant_id=eq.${rid}&select=*&limit=1`);
  const prev = was.ok && Array.isArray(was.data) ? was.data[0] || null : null;
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
  const what = describeMenuSettings(prev, saved.data[0], { hasTop, hasOrder, hasHidden });
  if (what) await tellChange(rid, tasterId, what, { go: 'menu' });
  return res.status(200).json({ ready: true, top: topOf(saved.data[0]), chosen: true, changedOn: saved.data[0].updated_at, order: orderOf(saved.data[0]) });
}

// r43: "changed Top Rated: Appetizers 5 → 3; Drinks off", "changed the order of the menu's sections", …
const TOP_WORDS = { starters: 'Appetizers', entree: 'Entrées', salads: 'Salads', drinks: 'Drinks' };
const CAVE_WORDS = { starters: 'Appetizers', entree: 'Entrées', salads: 'Salads', sides: 'Sides', desserts: 'Desserts', wines: 'Wines',
  cocktails: 'Cocktails', beers: 'Beers', spirits: 'Spirits', shots: 'Shots', 'drinks-other': 'Other drinks' };
export function describeMenuSettings(prev, now, { hasTop, hasOrder, hasHidden }) {
  const parts = [];
  if (hasTop) {
    const a = topOf(prev), b = topOf(now), tops = [];
    TOP_KINDS.forEach((k) => {
      if (a[k] === b[k]) return;
      tops.push(`${TOP_WORDS[k]} ${b[k] === 0 ? 'off' : a[k] === 0 ? 'on (' + b[k] + ')' : a[k] + ' → ' + b[k]}`);
    });
    if (tops.length) parts.push('changed Top Rated: ' + tops.join(', '));
  }
  if (hasOrder) {
    const a = orderOf(prev), b = orderOf(now);
    if (JSON.stringify(a.main) !== JSON.stringify(b.main)) parts.push('changed the order of the menu\'s sections');
    if (JSON.stringify(a.drinks) !== JSON.stringify(b.drinks)) parts.push('changed the order of the drinks\' sections');
  }
  if (hasHidden) {
    const a = orderOf(prev).hidden, b = orderOf(now).hidden;
    const off = b.filter((k) => !a.includes(k)).map((k) => CAVE_WORDS[k] || k), on = a.filter((k) => !b.includes(k)).map((k) => CAVE_WORDS[k] || k);
    if (off.length) parts.push('took ' + off.join(', ') + ' off the menu');
    if (on.length) parts.push('put ' + on.join(', ') + ' back on the menu');
  }
  return parts.length ? parts.join('; ') : null;
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
  if (changed.length) await tellChange(rid, tasterId, `changed the order of ${cat ? String(cat).trim() : 'the dishes'} on the menu`, { go: 'menu' });
  return res.status(200).json({ ok: true, order: ids.map((id, i) => ({ id, sort_order: i + 1 })), changed: changed.length });
}
