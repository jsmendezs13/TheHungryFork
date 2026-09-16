// api/checkin-confirm.js
//
// The other half: a member of staff has the customer's ticket, and says yes.
//
// Two shapes of request, on purpose:
//
//   { token }                       → look, do not touch. Returns the
//                                     customer's name so the waiter can see
//                                     who they are about to confirm.
//   { token, confirm:true, restaurantId } → record the visit, burn the ticket.
//
// Looking must not consume the ticket, or a waiter who opened the link and
// then dropped their phone would have destroyed a customer's visit. Only the
// press of the button consumes it.
//
// Three things are checked that a customer cannot influence:
//   1. the ticket is alive and unused
//   2. the person pressing Confirm holds a role AT THAT RESTAURANT, read from
//      the database now, not from their month-old token
//   3. they are not confirming themselves

import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import { tasterIdFromRequest, loadAccess, levelAt, LEVEL, sb } from './_lib/roles.js';
import { hashToken, normalizeShortCode, newYorkDate } from './_lib/checkin.js';

// Aimed at the six-character fallback code, which is the only guessable thing
// here. A busy Saturday is nowhere near this; a machine walking through codes
// gets a billion combinations and a hundred and fifty tries.
const lookupLimiter = makeLimiter({ requests: 150, window: '10 m', prefix: 'checkin:confirm' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const staffId = tasterIdFromRequest(req);
  if (!staffId) return res.status(401).json({ error: 'Please log in again.' });

  if (!(await allow(lookupLimiter, keyFor(staffId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
  }

  const { token, code, confirm, restaurantId } = req.body || {};

  // ── Where does this member of staff work? ───────────────────────────────
  const access = await loadAccess(staffId);
  if (!access) return res.status(401).json({ error: 'Please log in again.' });

  let places = [];
  if (access.isPlatformAdmin) {
    const all = await sb('/restaurants?select=id,name&order=name.asc');
    if (!all.ok) return res.status(502).json({ error: 'Could not read the restaurants list.' });
    places = (Array.isArray(all.data) ? all.data : []).map((r) => ({ id: r.id, name: r.name, role: 'platform' }));
  } else {
    // Crew and upwards. A waiter is the whole point of this feature — they are
    // the ones standing at the table — so the bar is the lowest role there is,
    // not the manager bar the rest of the system uses.
    const ids = Object.keys(access.byRestaurant).filter((id) => levelAt(access, id) >= LEVEL.crew);
    if (ids.length) {
      const some = await sb(`/restaurants?id=in.(${ids.join(',')})&select=id,name&order=name.asc`);
      places = (Array.isArray(some.data) ? some.data : []).map((r) => ({
        id: r.id, name: r.name, role: (access.byRestaurant[r.id] || access.byRestaurant[String(r.id)] || {}).role,
      }));
    }
  }

  if (!places.length) {
    // The single most likely thing to go wrong in a real dining room: the
    // waiter scanned the code with their own personal account. Say so, rather
    // than "forbidden".
    return res.status(403).json({
      error: 'This account does not work at a restaurant on The Hungry Fork, so it cannot confirm visits. ' +
             'Ask your manager to add you, then scan the code again.',
    });
  }

  // ── Find the ticket ─────────────────────────────────────────────────────
  let query;
  if (typeof token === 'string' && token.length > 20) {
    query = `/check_in_tokens?token_hash=eq.${hashToken(token)}`;
  } else {
    const short = normalizeShortCode(code);
    if (!short) return res.status(400).json({ error: 'That code does not look right. It is six characters.' });
    query = `/check_in_tokens?short_code=eq.${short}&used_at=is.null`;
  }

  const found = await sb(query + '&select=id,taster_id,expires_at,used_at&order=id.desc&limit=1');
  if (!found.ok) return res.status(502).json({ error: 'Could not check that code.' });
  if (!Array.isArray(found.data) || found.data.length === 0) {
    return res.status(404).json({ error: 'That code is not valid. Ask for a fresh one.' });
  }

  const ticket = found.data[0];
  if (ticket.used_at) {
    return res.status(409).json({ error: 'That code has already been used. Ask for a fresh one.' });
  }
  if (new Date(ticket.expires_at).getTime() <= Date.now()) {
    return res.status(410).json({ error: 'That code has expired. Ask them to tap Check In again — it takes a second.' });
  }
  if (Number(ticket.taster_id) === Number(staffId)) {
    return res.status(403).json({ error: 'You cannot confirm your own visit.' });
  }

  // ── Who is it? ──────────────────────────────────────────────────────────
  const who = await sb(`/tasters?id=eq.${ticket.taster_id}&select=id,first_name,last_name,username`);
  if (!who.ok || !Array.isArray(who.data) || who.data.length === 0) {
    return res.status(404).json({ error: 'That account no longer exists.' });
  }
  const customer = who.data[0];
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'This taster';

  // One restaurant means no question to ask. Several means the waiter picks,
  // and the page shows the list.
  const chosen = restaurantId != null
    ? places.find((p) => String(p.id) === String(restaurantId))
    : (places.length === 1 ? places[0] : null);

  // ── LOOK ────────────────────────────────────────────────────────────────
  if (confirm !== true) {
    let alreadyToday = false;
    if (chosen) {
      const today = newYorkDate();
      const seen = await sb(
        `/check_ins?taster_id=eq.${ticket.taster_id}&restaurant_id=eq.${chosen.id}` +
        `&visit_date=eq.${today}&select=id&limit=1`
      );
      alreadyToday = Array.isArray(seen.data) && seen.data.length > 0;
    }
    return res.status(200).json({
      success: true,
      customer: { name: customerName, username: customer.username || null },
      restaurants: places.map((p) => ({ id: p.id, name: p.name })),
      restaurantId: chosen ? chosen.id : null,
      alreadyToday,
    });
  }

  // ── CONFIRM ─────────────────────────────────────────────────────────────
  if (!chosen) return res.status(400).json({ error: 'Choose which restaurant this visit is for.' });

  // visit_date is left to the database on purpose — see migration 7. Sending
  // one from here would put the "which day is it" decision in two places, and
  // one of them would eventually be in the wrong timezone.
  const saved = await sb('/check_ins', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      taster_id:         ticket.taster_id,
      restaurant_id:     chosen.id,
      confirmed_by:      staffId,
      confirmed_by_name: access.firstName || null,
    }),
  });

  // 23505 is the unique index doing its job: they have already been in today.
  // That is not an error anybody needs to apologise for, so it comes back as a
  // success with a different message — and the ticket is still spent, or the
  // customer would stand there showing the same code hoping for a second one.
  const duplicate = !saved.ok && (saved.status === 409 || saved.data?.code === '23505');

  if (!saved.ok && !duplicate) {
    console.error('[checkin-confirm] insert failed', saved.status, saved.data?.message);
    return res.status(500).json({ error: 'Could not record that visit.' });
  }

  const burned = await sb(`/check_in_tokens?id=eq.${ticket.id}&used_at=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ used_at: new Date().toISOString(), used_by: staffId }),
  });
  // If this comes back empty, another waiter burned the same ticket a moment
  // ago. The visit is already recorded either way — the unique index saw to
  // that — so there is nothing to undo and nothing to warn anyone about.
  if (!burned.ok) console.error('[checkin-confirm] could not mark token used', burned.status);

  // "That is their fourth visit here" is the whole reward, for now. Cheap to
  // count, and it is the thing a waiter actually enjoys saying out loud.
  const counted = await sb(
    `/check_ins?taster_id=eq.${ticket.taster_id}&restaurant_id=eq.${chosen.id}&select=id`
  );
  const visitsHere = Array.isArray(counted.data) ? counted.data.length : null;

  console.log('[checkin] staff', staffId, 'confirmed', ticket.taster_id, 'at', chosen.id, duplicate ? '(already today)' : '');

  return res.status(200).json({
    success:      true,
    alreadyToday: duplicate,
    customer:     { name: customerName, username: customer.username || null },
    restaurant:   { id: chosen.id, name: chosen.name },
    visitDate:    duplicate ? newYorkDate() : (saved.data?.[0]?.visit_date || newYorkDate()),
    visitsHere,
  });
}
