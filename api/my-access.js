// api/my-access.js
//
// "What am I allowed to do?" — answered from the database, not from the token
// the browser is holding. manager.html calls this on every load, so someone
// who was removed sees the truth the moment they refresh instead of keeping a
// dashboard that still looks like it works.

import { tasterIdFromRequest, loadAccess, sb, LEVEL } from './_lib/roles.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const access = await loadAccess(tasterId);
  if (!access) return res.status(401).json({ error: 'Please log in again.' });

  let restaurants = [];

  if (access.isPlatformAdmin) {
    // You see every restaurant on the platform.
    const r = await sb('/restaurants?select=id,name&order=name.asc');
    restaurants = (Array.isArray(r.data) ? r.data : []).map((x) => ({
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
    isPlatformAdmin: access.isPlatformAdmin,
    restaurants,
  });
}
