// api/my-checkins.js
//
// Everything the two calendars need, in one request.
//
// This endpoint will only ever tell an account about itself. There is no
// parameter for whose visits to fetch, so there is nothing to tamper with: the
// taster id comes from the signed token and nowhere else. Which named person
// was in which restaurant on which evening is the most sensitive thing this
// platform holds, and it is not reachable from a browser by any other route.

import { tasterIdFromRequest, sb } from './_lib/roles.js';
import { newYorkDate } from './_lib/checkin.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  const rows = await sb(
    `/check_ins?taster_id=eq.${tasterId}&select=restaurant_id,visit_date&order=visit_date.desc&limit=2000`
  );
  if (!rows.ok || !Array.isArray(rows.data)) {
    console.error('[my-checkins] read failed', rows.status, rows.data?.message);
    return res.status(502).json({
      error: 'Could not read your visits (the database answered ' + rows.status + '). '
           + (rows.status === 404
               ? 'That usually means migration 7 has not been run yet.'
               : 'If that is a 401 or 403, service_role is missing its grant on check_ins.'),
    });
  }

  // Names for the restaurant picker. Only the ones they have actually been to
  // — a list of every restaurant on the platform would be a list of places
  // they have never been, which is not a calendar.
  const ids = [...new Set(rows.data.map((r) => r.restaurant_id))];
  let names = {};
  if (ids.length) {
    const places = await sb(`/restaurants?id=in.(${ids.join(',')})&select=id,name`);
    (Array.isArray(places.data) ? places.data : []).forEach((p) => { names[p.id] = p.name; });
  }

  return res.status(200).json({
    success: true,
    today:   newYorkDate(),   // the browser's clock may be in another timezone
    visits:  rows.data.map((r) => ({
      restaurantId: r.restaurant_id,
      date:         r.visit_date,     // YYYY-MM-DD, already New York
    })),
    restaurants: ids.map((id) => ({ id, name: names[id] || 'Restaurant' })),
  });
}
