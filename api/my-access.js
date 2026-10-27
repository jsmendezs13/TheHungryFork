// api/my-access.js
//
// "What am I allowed to do?" — answered from the database, not from the token
// the browser is holding. manager.html calls this on every load, so someone
// who was removed sees the truth the moment they refresh instead of keeping a
// dashboard that still looks like it works.

import { tasterIdFromRequest, loadAccess, sb, LEVEL, accessProblem } from './_lib/roles.js';
import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import { listDevices, removeDevice, deviceOut, TRUST_DAYS } from './_lib/devices.js';
import { KINDS, publicKey, vapidReady, kindsFor, cleanSubscription, sendOne } from './_lib/push.js';

// r43: the person's own devices and notifications (manager page → Settings).
//   devices · device_remove
//   push_key · push_state · push_save · push_off · push_test
const pushLimiter = makeLimiter({ requests: 30, window: '10 m', prefix: 'push:acct' });
const ACTIONS = ['devices', 'device_remove', 'push_key', 'push_state', 'push_save', 'push_off', 'push_test'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const access = await loadAccess(tasterId, req);           // r43: req, so the session's device is checked
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error, ...(problem.reason ? { reason: problem.reason } : {}) });

  const action = req.method === 'POST' && req.body && typeof req.body === 'object' ? String(req.body.action || '') : '';
  if (action) {
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Unknown action.' });
    return mine(req, res, req.body, action, access);
  }

  let restaurants = [];

  if (access.isPlatformAdmin) {
    // You see every restaurant on the platform.
    const r = await sb('/restaurants?select=id,name&order=name.asc');

    // If this query FAILS, say so. The old version quietly turned any failure
    // into an empty list, so a broken permission and a genuinely empty table
    // produced the same screen — and the screen blamed the table. Never let a
    // failed read masquerade as a successful empty one.
    if (!r.ok) {
      console.error('[my-access] restaurants read failed', r.status);
      return res.status(502).json({
        error: 'Could not read the restaurants table (status ' + r.status + ').',
      });
    }
    if (!Array.isArray(r.data)) {
      return res.status(502).json({
        error: 'The restaurants table returned something unexpected.',
      });
    }

    restaurants = r.data.map((x) => ({
      id: x.id,
      name: x.name,
      role: 'platform',
      level: LEVEL.platform,
    }));
  } else {
    const ids = Object.keys(access.byRestaurant);
    if (ids.length) {
      const r = await sb(
        `/restaurants?id=in.(${ids.join(',')})&select=id,name&order=name.asc`
      );
      restaurants = (Array.isArray(r.data) ? r.data : []).map((x) => {
        const entry = access.byRestaurant[x.id] || access.byRestaurant[String(x.id)];
        return {
          id: x.id,
          name: x.name,
          role: entry ? entry.role : 'none',
          level: entry ? entry.level : LEVEL.none,
        };
      });
    }
  }

  return res.status(200).json({
    success: true,
    tasterId: access.tasterId,
    firstName: access.firstName,
    handle: access.handle || null,
    isPlatformAdmin: access.isPlatformAdmin,
    restaurants,
  });
}

// ── r43: YOUR DEVICES AND NOTIFICATIONS ───────────────────────────────────────
async function mine(req, res, body, action, access) {
  const me = access.tasterId;
  const staff = access.isPlatformAdmin || Object.keys(access.byRestaurant || {}).length > 0;
  if (!staff) return res.status(403).json({ error: 'This is for the restaurant\'s team.' });
  if (access.devicesOff) return res.status(503).json({ error: 'This needs migration 30 first (Supabase, SQL editor).' });
  // While the update is going up, api/_lib/roles.js may still be the old one (it goes last): it knows no devices yet.
  if (!('device' in access)) return res.status(503).json({ error: 'This part is being updated. Please try again in a few minutes.', reason: 'updating' });
  const current = access.device;                        // a staff session always has one here (roles.js)

  if (action === 'devices') {
    const rows = await listDevices(me);
    if (!rows) return res.status(502).json({ error: 'Could not read your devices. Please try again.' });
    return res.status(200).json({ success: true, trustDays: TRUST_DAYS, devices: rows.map((r) => deviceOut(r, current && current.id)) });
  }
  if (action === 'device_remove') {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Which device?' });
    if (!(await removeDevice(me, id, me))) return res.status(404).json({ error: 'That device is not on your account any more.' });
    console.log('[my-access] taster', me, 'removed device', id);
    return res.status(200).json({ success: true, loggedOut: !!current && Number(current.id) === id });
  }
  // Notifications
  if (!(await allow(pushLimiter, keyFor(me), { failOpen: true }))) return res.status(429).json({ error: 'Too many taps. Wait a moment.' });
  const allowed = await kindsFor(access);
  if (action === 'push_key') {
    return res.status(200).json({ success: true, ready: vapidReady(), key: publicKey(), kinds: allowed });
  }
  const sub = cleanSubscription(body.subscription);
  const endpoint = sub ? sub.endpoint : String(body.endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'Which notifications?' });
  if (action === 'push_state') {
    const got = await sb(`/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&taster_id=eq.${Number(me)}&select=kinds,device_id&limit=1`);
    const row = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
    // here: the subscription belongs to this session's device (after a new log-in on the same phone it does not, and the page saves it again)
    return res.status(200).json({ success: true, on: !!row, here: !!row && !!current && Number(row.device_id) === Number(current.id),
      kinds: row ? row.kinds.filter((k) => allowed.includes(k)) : [], allowed });
  }
  if (action === 'push_off') {
    await sb(`/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&taster_id=eq.${Number(me)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    return res.status(200).json({ success: true, on: false });
  }
  if (action === 'push_save') {
    if (!vapidReady()) return res.status(503).json({ error: 'Notifications are not set up yet. Ask Seb\'s Analytics.' });
    if (!sub) return res.status(400).json({ error: 'This browser gave an address for notifications that we do not accept.' });
    const kinds = (Array.isArray(body.kinds) ? body.kinds : allowed).filter((k) => KINDS.includes(k) && allowed.includes(k));
    // One subscription per address: the same phone again (another account, or turned on again) replaces it.
    await sb(`/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    const saved = await sb('/push_subscriptions', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ taster_id: Number(me), device_id: Number(current.id), endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, kinds }),
    });
    if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) return res.status(502).json({ error: 'Could not save that. Please try again.' });
    console.log('[my-access] taster', me, 'notifications on, device', current.id, kinds.join(','));
    return res.status(200).json({ success: true, on: true, kinds, allowed });
  }
  if (action === 'push_test') {
    const got = await sb(`/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}&taster_id=eq.${Number(me)}&select=id,endpoint,p256dh,auth&limit=1`);
    const row = got.ok && Array.isArray(got.data) && got.data.length ? got.data[0] : null;
    if (!row) return res.status(404).json({ error: 'Notifications are not on for this device.' });
    const sent = await sendOne(row, { title: 'HF Staff', body: 'Notifications work on this device.', url: '/manager', tag: 'test', kind: 'test' }, { urgency: 'high', ttl: 600 });
    if (sent.gone) {
      await sb(`/push_subscriptions?id=eq.${Number(row.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.status(410).json({ error: 'This device stopped taking notifications. Turn them on again.', on: false });
    }
    if (!sent.ok) return res.status(502).json({ error: 'The test could not be sent. Please try again in a moment.' });
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ error: 'Unknown action.' });
}
