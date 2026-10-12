// api/_lib/guests.js
//
// Two small things the restaurant's pages need about a guest (Sebastian, 12 Oct).
// Both are read-only and neither ever selects the guest's email address.
//
//   waitingOnly(rows)   "New" means a guest is still waiting for an answer.
//                       A guest's message the restaurant has answered after is
//                       not new any more, whoever on the team answered and
//                       whether or not that person's own screen "read" it
//                       (Sebastian answers as the platform, which never marks
//                       a restaurant's messages read — so before this, his
//                       answer left the number on the bubble for ever).
//   addHandles(rows)    The guest's handle (Johan_I), for rows that have a
//                       taster_id, set as row.handle. A booking made without an
//                       account has none: row.handle is null and the page
//                       shows the name alone.

import { sb } from './roles.js';

const CHUNK = 150;                        // ids per request: the address stays short

function wholeIds(list, field) {
  return [...new Set(list.map((r) => Number(r && r[field])).filter((n) => Number.isInteger(n) && n > 0))];
}

// rows: guest messages not yet read, each with id and reservation_id.
// Returns only the ones with no restaurant answer after them. If the answers
// cannot be read, every row stays (a guest is never hidden by a failed read).
export async function waitingOnly(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = wholeIds(list, 'reservation_id');
  if (!ids.length) return list;
  const parts = [];
  for (let i = 0; i < ids.length; i += CHUNK) parts.push(ids.slice(i, i + CHUNK));
  const got = await Promise.all(parts.map((p) =>
    sb(`/reservation_messages?reservation_id=in.(${p.join(',')})&from_guest=is.false&select=id,reservation_id&order=id.desc&limit=3000`)));
  if (got.some((g) => !g.ok || !Array.isArray(g.data))) return list;
  const lastAnswer = {};
  got.forEach((g) => g.data.forEach((m) => {
    const at = Number(m.id);
    if (!(lastAnswer[m.reservation_id] >= at)) lastAnswer[m.reservation_id] = at;
  }));
  return list.filter((m) => !(Number(m.id) < lastAnswer[m.reservation_id]));
}

// rows: bookings or requests that carry taster_id. Sets row.handle on each.
export async function addHandles(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = wholeIds(list, 'taster_id');
  const handle = {};
  if (ids.length) {
    const parts = [];
    for (let i = 0; i < ids.length; i += CHUNK) parts.push(ids.slice(i, i + CHUNK));
    const got = await Promise.all(parts.map((p) => sb(`/tasters?id=in.(${p.join(',')})&select=id,username&limit=${p.length}`)));
    got.forEach((g) => {
      if (g.ok && Array.isArray(g.data)) g.data.forEach((t) => { if (t.username) handle[t.id] = String(t.username); });
    });
  }
  list.forEach((r) => { if (r) r.handle = (r.taster_id && handle[r.taster_id]) || null; });
  return list;
}
