// api/manager-dish.js
//
// The only way a dish can be changed from a browser.
//
// The dishes table itself stays read-only to the public key — there is no RLS
// policy letting anyone write to it, and there deliberately never will be.
// Every change comes through here, where the caller's role is checked against
// the database first and the list of columns they may touch is fixed in code.
//
// What a manager may NOT change, and why:
//   image, image_open  — photography is work Sebastian is paid for
//   slug               — it is in URLs and in the category routing
//   restaurant_id      — nobody moves a dish to another restaurant
//
// Allergens ARE editable here, which reverses an earlier decision. Locking
// them looked careful and was the opposite: a locked field stays empty, and an
// empty allergen list helps nobody. The restaurant is the only party that
// knows what is in the dish, so the restaurant declares it — as explicit
// checkboxes rather than free text, and labelled on the menu as the
// restaurant's own statement.

import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import { tasterIdFromRequest, loadAccess, canEditDishes, sb, accessProblem } from './_lib/roles.js';
import { TEXT_FIELDS, isAllergen } from './_lib/dish-fields.js';

// Generous, because a manager marking a busy Friday night sold out will click
// a lot. Tight enough that a stolen session cannot rewrite the whole menu.
const writeLimiter = makeLimiter({ requests: 80, window: '5 m', prefix: 'dish:write' });

// The lengths live in _lib/dish-fields.js, next to the allergen list.
const MAX = TEXT_FIELDS;

// Returns { ok, value } or { ok:false, error }.
function clean(field, raw) {
  // Allergens. Thirty plain booleans, and the reason this endpoint exists at
  // all: only the kitchen knows what is in the pan, so only the restaurant can
  // declare it. Ticking one is a statement by that restaurant, and the menu
  // labels it as such.
  if (isAllergen(field)) {
    if (typeof raw !== 'boolean') return { ok: false, error: 'Allergen values must be true or false.' };
    return { ok: true, value: raw };
  }

  if (field === 'is_hidden' || field === 'is_chefs_pick') {
    if (typeof raw !== 'boolean') return { ok: false, error: field + ' must be true or false.' };
    return { ok: true, value: raw };
  }

  // The manager marks a dish sold out and it stays that way until they clear
  // it by hand — no automatic reset, so nothing returns to the menu unless a
  // person decides it is really available again. The column keeps its old name
  // but now reads as "sold out SINCE this moment"; null means available.
  if (field === 'sold_out') {
    if (typeof raw !== 'boolean') return { ok: false, error: 'sold_out must be true or false.' };
    return { ok: true, column: 'sold_out_until', value: raw ? new Date().toISOString() : null };
  }

  if (field === 'price') {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 10000) {
      return { ok: false, error: 'Price must be between 0 and 10000.' };
    }
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  if (Object.prototype.hasOwnProperty.call(MAX, field)) {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, error: field + ' must be text.' };
    const trimmed = raw.trim();
    if (trimmed.length > MAX[field]) {
      return { ok: false, error: `That ${field} is too long (limit ${MAX[field]} characters).` };
    }
    return { ok: true, value: trimmed.length ? trimmed : null };
  }

  return { ok: false, error: 'That field cannot be changed here.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  if (!(await allow(writeLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many changes at once. Wait a moment and try again.' });
  }

  const { dishId, changes } = req.body || {};
  const id = Number(dishId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which dish?' });
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    return res.status(400).json({ error: 'Nothing to change.' });
  }

  // The dish decides which restaurant is being touched — never the caller.
  // Taking restaurant_id from the request body would let a manager at one
  // restaurant edit a dish at another just by changing a number.
  // The whole row, not just the id — the change log needs the values as they
  // were before this request, and "peanuts true → false" is a different event
  // from "false → true".
  const found = await sb(`/dishes?id=eq.${id}&select=*`);
  if (!found.ok || !Array.isArray(found.data) || found.data.length === 0) {
    return res.status(404).json({ error: 'That dish no longer exists.' });
  }
  const before = found.data[0];
  const restaurantId = before.restaurant_id;

  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  if (!canEditDishes(access, restaurantId)) {
    // Same message whether the account was never a manager or was removed five
    // minutes ago — there is nothing useful to learn from the difference.
    return res.status(403).json({ error: 'You do not have permission to change this menu.' });
  }

  const patch = {};
  for (const [field, raw] of Object.entries(changes)) {
    const result = clean(field, raw);
    if (!result.ok) return res.status(400).json({ error: result.error });
    patch[result.column || field] = result.value;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });

  // One Chef's Pick per restaurant. Clearing the others first means the menu
  // can never show two, whatever order the clicks arrive in.
  if (patch.is_chefs_pick === true) {
    const cleared = await sb(
      `/dishes?restaurant_id=eq.${restaurantId}&is_chefs_pick=eq.true&id=neq.${id}`,
      { method: 'PATCH', body: JSON.stringify({ is_chefs_pick: false }) }
    );
    if (!cleared.ok) return res.status(500).json({ error: 'Could not update the Chef\'s Pick.' });
  }

  const updated = await sb(`/dishes?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });

  if (!updated.ok || !Array.isArray(updated.data) || updated.data.length === 0) {
    return res.status(500).json({ error: 'Could not save that change.' });
  }

  // ── The change log ──
  // Written after the change succeeded, and deliberately not allowed to fail
  // the request: a manager marking a dish sold out on a Friday night must not
  // be blocked because the logging table is unhappy. A missing log line is a
  // gap; a manager who cannot update the menu is an outage.
  //
  // Only fields that actually changed are recorded. Saving a form without
  // touching anything should not fill the log with noise.
  try {
    const rows = Object.entries(patch)
      .filter(([column, value]) => String(before[column] ?? '') !== String(value ?? ''))
      .map(([column, value]) => ({
        dish_id:         id,
        restaurant_id:   restaurantId,
        changed_by:      tasterId,
        changed_by_name: access.firstName || null,
        field:           column,
        old_value:       before[column] === null || before[column] === undefined ? null : String(before[column]),
        new_value:       value === null || value === undefined ? null : String(value),
      }));

    if (rows.length) {
      const logged = await sb('/dish_changes', { method: 'POST', body: JSON.stringify(rows) });
      if (!logged.ok) console.error('[manager-dish] change log write failed', logged.status);
    }
  } catch (e) {
    console.error('[manager-dish] change log threw', e?.message);
  }

  console.log('[manager-dish] taster', tasterId, 'dish', id, Object.keys(patch).join(','));
  return res.status(200).json({ success: true, dish: updated.data[0] });
}
