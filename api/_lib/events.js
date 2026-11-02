// api/_lib/events.js — r50 (2 Nov 2026): private events with tickets, sold by
// each restaurant on its own Square account (Sebastian, 30 Oct 16:42; design
// approved 2 Nov: "It looks brilliant!").
//
// Reached through api/reservations.js (the site stays at its twelve functions):
//   guests   event_get · event_buy · tickets_get           (no account needed)
//   staff    ev_list · ev_day · ev_save · ev_status · ev_guests · ev_scan ·
//            ev_admit · ev_unadmit · ev_void                 (ev_*)
//            sq_status · sq_connect · sq_location · sq_disconnect   (sq_*)
//   Square   GET  /square-back    the manager comes back from Square's page
//            POST /square-events  Square's messages (a payment, a refund)
//   cron     ticketsCron(), from the daily job
//
// The rules (his answers): the money goes to the restaurant's Square account;
// Seb's Analytics takes no fee; "Take the whole room" only if they choose (then
// online booking skips that room for the event's hours: migration 34); one
// ticket per person, each with its own QR (the restaurant's logo in the middle)
// that can be shared, and that lets one person in, once; the buyer gets an email
// with the tickets.
//
// Who sees what: crew see the events, the guests' names and phones, and work
// the door (Let in); managers and owners make the events, connect Square, see
// the buyers' emails, and cancel a ticket. Crew NEVER see an email address.
//
// Paid or not comes only from Square itself, asked with the restaurant's own
// key: when the guest comes back from Square's page, when Square sends a
// message to /square-events (a message only says "look at order X"), when a
// page counts the tickets, and once a day.

import { makeLimiter, allow, keyFor, clientIp, normalizeUsPhone } from './auth.js';
import { sb, tasterIdFromRequest, LEVEL } from './roles.js';
import { loadBooking, cleanText, cleanEmail, cleanDate } from './booking.js';
import { gate, serviceToday } from './staff.js';
import { emailReady, senderFor, sendEmail, ticketsEmail, hostOf, sendableAddress, mailboxKey } from './email.js';
import { drawTableQr, tableQrSvg } from './qr.js';
import { notifyStaff, line } from './push.js';
import * as sq from './square.js';

const HOLD_MINUTES = 20;               // the tickets wait this long while the guest pays on Square's page
const HOUR = 3600 * 1000;
const TOKEN = /^[0-9a-f]{32}$/;
const KEY = /^[0-9a-f]{12}$/;

const publicRead  = makeLimiter({ requests: 300, window: '10 m', prefix: 'ev:read' });
const buyIp       = makeLimiter({ requests: 12,  window: '1 h',  prefix: 'ev:buy:ip' });
const buyMailbox  = makeLimiter({ requests: 8,   window: '24 h', prefix: 'ev:buy:mail' });
const hookIp      = makeLimiter({ requests: 300, window: '10 m', prefix: 'ev:hook' });
const staffRead   = makeLimiter({ requests: 600, window: '10 m', prefix: 'ev:staff:read' });
const staffWrite  = makeLimiter({ requests: 200, window: '10 m', prefix: 'ev:staff:write' });
// The same ceiling as every other email of the site (api/reservations.js): Resend's free plan sends 100 a day.
const emailDay    = makeLimiter({ requests: 95,  window: '24 h', prefix: 'resv:email:all' });

const siteOf = (settings) => String((settings && settings.site_url) || 'https://thehungryfork.fun').replace(/\/+$/, '');
export const ticketQrText = (settings, token) => `${siteOf(settings)}/manager#ticket=${token}`;
const ticketLink = (settings, token) => `${siteOf(settings)}/tickets?t=${token}`;
const orderLink = (settings, token) => `${siteOf(settings)}/tickets?o=${token}`;
const eventLink = (settings, key) => `${siteOf(settings)}/event?k=${key}`;
const money = (c) => '$' + (Number(c) / 100).toFixed(2).replace(/\.00$/, '');
const rpc = (name, args) => sb(`/rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
const first = (r) => (r && r.ok && Array.isArray(r.data) ? r.data[0] : null);
const rows = (r) => (r && r.ok && Array.isArray(r.data) ? r.data : []);
const PATCH = (path, body) => sb(path, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });

// Before migration 34 the tables are not there: every screen says so in the same words.
const NOT_READY = 'Event tickets need migration 34 (Supabase). Run it, then try again.';
const notReady = (r) => r && (r.status === 404 || (r.data && (r.data.code === '42P01' || r.data.code === 'PGRST205' || r.data.code === 'PGRST202')));

// ── times ────────────────────────────────────────────────────────────────────
const fmt = (tz, iso, o) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...o }).format(new Date(iso));
const clock = (tz, iso) => fmt(tz, iso, { hour: 'numeric', minute: '2-digit' });
function whenWords(tz, startIso, endIso) {
  return {
    day: fmt(tz, startIso, { weekday: 'long', month: 'long', day: 'numeric' }),
    short: fmt(tz, startIso, { weekday: 'short', month: 'short', day: 'numeric' }),
    hours: `${clock(tz, startIso)} – ${clock(tz, endIso)}`,
    date: fmt(tz, startIso, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2'),
    start: fmt(tz, startIso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    end: fmt(tz, endIso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  };
}
// 2026-11-06 + 19:00 in New York → the moment, in UTC (summer time included).
export function localToIso(tz, date, time) {
  const [y, mo, d] = String(date).split('-').map(Number), [h, mi] = String(time).split(':').map(Number);
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).forEach((x) => { p[x.type] = x.value; });
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    guess += Date.UTC(y, mo - 1, d, h, mi) - shown;
  }
  return new Date(guess).toISOString();
}

// ── the counts of one or more events ─────────────────────────────────────────
async function countsFor(eventIds) {
  const ids = [...new Set(eventIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = {};
  ids.forEach((id) => { out[id] = { sold: 0, held: 0, inside: 0, paidCents: 0, refundedCents: 0, orders: 0, over: 0 }; });
  if (!ids.length) return out;
  const now = Date.now();
  const [orders, inside] = await Promise.all([
    sb(`/ticket_orders?event_id=in.(${ids.join(',')})&status=in.(held,paid,refunded)&select=event_id,quantity,status,held_until,paid_cents,refunded_cents,over_limit&limit=5000`),
    sb(`/tickets?event_id=in.(${ids.join(',')})&used_at=not.is.null&status=eq.valid&select=event_id&limit=5000`),
  ]);
  rows(orders).forEach((o) => {
    const c = out[o.event_id]; if (!c) return;
    if (o.status === 'paid') { c.sold += o.quantity; c.orders += 1; c.paidCents += Number(o.paid_cents || 0) - Number(o.refunded_cents || 0); if (o.over_limit) c.over += o.quantity; }
    else if (o.status === 'held' && Date.parse(o.held_until) > now) c.held += o.quantity;
    else if (o.status === 'refunded') c.refundedCents += Number(o.refunded_cents || 0);
  });
  rows(inside).forEach((t) => { if (out[t.event_id]) out[t.event_id].inside += 1; });
  return out;
}

function stateOf(e, c, square, now = Date.now()) {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.status === 'draft') return 'draft';
  if (now >= Date.parse(e.ends_at)) return 'over';
  if (now >= Date.parse(e.starts_at) - Number(e.close_hours) * HOUR) return 'closed';
  if (e.tickets_total - c.sold - c.held <= 0) return 'sold_out';
  if (!square) return 'not_on_sale';
  return 'on_sale';
}

function dressEvent(e, tz, areaName, c, square, settings, forStaff) {
  const w = whenWords(tz, e.starts_at, e.ends_at);
  const out = {
    key: e.public_key, name: e.name, startsAt: e.starts_at, endsAt: e.ends_at, day: w.day, short: w.short, hours: w.hours,
    room: e.area_id ? (areaName[e.area_id] || null) : null, areaId: e.area_id, takeRoom: !!e.take_room,
    priceCents: e.price_cents, price: money(e.price_cents), taxMode: e.tax_mode, taxRate: Number(e.tax_rate),
    total: e.tickets_total, left: Math.max(0, e.tickets_total - c.sold - c.held), max: e.max_per_order,
    closeHours: e.close_hours, about: e.about || '', included: e.included || '', adultsOnly: !!e.adults_only,
    state: stateOf(e, c, square), link: eventLink(settings, e.public_key),
  };
  if (forStaff) Object.assign(out, { id: e.id, status: e.status, date: w.date, start: w.start, end: w.end,
    sold: c.sold, held: c.held, inside: c.inside, paidCents: c.paidCents, paid: money(c.paidCents), orders: c.orders, over: c.over });
  return out;
}

async function areaNames(rid) {
  const a = await sb(`/restaurant_areas?restaurant_id=eq.${rid}&select=id,name,is_active&order=sort_order.asc,id.asc`);
  const names = {}; rows(a).forEach((x) => { names[x.id] = x.name; });
  return { names, list: rows(a) };
}

// ── the restaurant's Square account ──────────────────────────────────────────
async function connectionOf(rid) {
  const r = await sb(`/square_connections?restaurant_id=eq.${rid}&select=*`);
  if (!r.ok) return { missing: notReady(r), row: null };
  return { row: first(r) };
}
// A working key for the account (refreshed when it has less than a week left).
async function keyOf(rid, known) {
  const row = known || (await connectionOf(rid)).row;
  if (!row) return null;
  const cfg = sq.squareConfig();
  if (!cfg.ready) return null;
  let access = sq.unseal(row.access_enc, cfg.secret);
  if (!access) return null;
  if (Date.parse(row.expires_at) - Date.now() < 7 * 24 * HOUR) {
    const fresh = await refreshRow(row, cfg);
    if (fresh) access = fresh;
  }
  return { token: access, row };
}
async function refreshRow(row, cfg = sq.squareConfig()) {
  const refresh = sq.unseal(row.refresh_enc, cfg.secret);
  if (!refresh) return null;
  const r = await sq.refreshToken(refresh, cfg);
  if (!r.ok || !r.data.access_token) {
    await PATCH(`/square_connections?restaurant_id=eq.${row.restaurant_id}`, { last_error: sq.squareSays(r) });
    return null;
  }
  await PATCH(`/square_connections?restaurant_id=eq.${row.restaurant_id}`, {
    access_enc: sq.seal(r.data.access_token, cfg.secret),
    refresh_enc: sq.seal(r.data.refresh_token || refresh, cfg.secret),
    expires_at: r.data.expires_at || new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    refreshed_at: new Date().toISOString(), last_error: null,
  });
  return r.data.access_token;
}

// ── paid? ────────────────────────────────────────────────────────────────────
// Ask Square about one order and act on the answer: paid → the tickets are made
// and sent; money back → refunded; not paid and its minutes are over → back on sale.
async function settleOrder(order, key) {
  if (!order || !order.square_order_id || !['held', 'expired', 'paid', 'refunded'].includes(order.status)) return order && order.status;
  const k = key || await keyOf(order.restaurant_id);
  if (!k) return order.status;
  const m = await sq.orderMoney(k.token, order.square_order_id);
  await PATCH(`/ticket_orders?id=eq.${order.id}`, { checked_at: new Date().toISOString() });
  if (!m.ok) return order.status;
  let status = order.status;
  if (m.isPaid && (order.status === 'held' || order.status === 'expired')) {
    const p = first(await rpc('hf_ticket_paid', { p_order: order.id, p_paid_cents: m.paid }));
    if (p && p.ok) { status = 'paid'; if (p.newly) await afterPaid(order.id); }
  } else if (!m.isPaid && order.status === 'held' && Date.parse(order.held_until) <= Date.now()) {
    const x = first(await rpc('hf_ticket_expire', { p_order: order.id }));
    if (x && x.ok) status = 'expired';
  }
  if ((status === 'paid' || status === 'refunded') && m.refunded !== Number(order.refunded_cents || 0) && m.refunded > 0) {
    const r = first(await rpc('hf_ticket_refund', { p_order: order.id, p_refunded_cents: m.refunded }));
    if (r && r.ok) status = r.full_refund ? 'refunded' : 'paid';
  }
  return status;
}

// Holds whose minutes are over, for this event: asked about before counting (a few at most).
async function settleHolds(eventId, most = 3) {
  const r = await sb(`/ticket_orders?event_id=eq.${Number(eventId)}&status=eq.held&held_until=lt.${new Date().toISOString()}` +
                     '&select=*&order=held_until.asc&limit=' + most);
  for (const o of rows(r)) {
    const st = await settleOrder(o);
    // No answer from Square (or no key): it waits for the next look; its minutes are over, so it no longer counts.
    if (st === 'held' && !o.square_order_id) await rpc('hf_ticket_expire', { p_order: o.id });
  }
}

// Paid: the email with the tickets, and the team's phones.
async function afterPaid(orderId, { push = true } = {}) {
  const o = first(await sb(`/ticket_orders?id=eq.${Number(orderId)}&select=*`));
  if (!o) return;
  const [e, t, loaded] = await Promise.all([
    sb(`/events?id=eq.${o.event_id}&select=*`), sb(`/tickets?order_id=eq.${o.id}&select=seq,token,status&order=seq.asc`), loadBooking(o.restaurant_id),
  ]);
  const ev = first(e), tickets = rows(t);
  if (!ev || !loaded || loaded.error) return;
  const tz = (loaded.settings && loaded.settings.timezone) || 'America/New_York';
  await Promise.all([
    o.email_sent_at ? null : mailTickets(o, ev, tickets, loaded, tz),
    !push ? null : notifyStaff(o.restaurant_id, 'bookings', {
      title: loaded.restaurant.name,
      body: line(`${o.buyer_name}: ${o.quantity} ${o.quantity === 1 ? 'ticket' : 'tickets'} · ${ev.name}, ${fmt(tz, ev.starts_at, { weekday: 'short', month: 'short', day: 'numeric' })}`),
      url: '/manager#events', tag: 'tickets-' + o.id,
    }),
  ]);
}

async function mailTickets(o, ev, tickets, loaded, tz) {
  const settings = loaded.settings;
  const to = sendableAddress(o.buyer_email);
  const note = (fields) => PATCH(`/ticket_orders?id=eq.${o.id}`, fields);
  if (!emailReady(settings)) return note({ email_error: 'Not sent: email is not set up for this restaurant' });
  if (!to) return note({ email_error: 'Not sent: the address cannot receive email' });
  if (!(await allow(emailDay, keyFor('all'), { failOpen: false }))) return note({ email_error: 'Not sent yet: the day\'s emails are used up (the daily job tries again)' });
  const areas = await areaNames(o.restaurant_id);
  const sender = senderFor(settings, loaded.restaurant);
  const list = tickets.filter((x) => x.status === 'valid').map((x) => ({ seq: x.seq, cid: `ticket-${x.seq}`, share: ticketLink(settings, x.token), token: x.token }));
  const attachments = list.map((x) => ({ filename: `ticket-${x.seq}.png`, content: drawTableQr(ticketQrText(settings, x.token)).toString('base64'), content_id: x.cid }));
  const mail = ticketsEmail({
    restaurant: loaded.restaurant, timezone: tz, event: { ...ev, areaName: ev.area_id ? areas.names[ev.area_id] : null },
    order: o, tickets: list, link: orderLink(settings, o.token), siteHost: hostOf(settings),
  });
  const sent = await sendEmail({ from: sender.from, to, replyTo: sender.replyTo, subject: mail.subject, html: mail.html, text: mail.text,
    attachments, idempotencyKey: `tickets-${o.id}`, tags: [{ name: 'kind', value: 'tickets' }] });
  if (sent.ok || sent.duplicate) return note({ email_sent_at: new Date().toISOString(), email_error: null });
  return note({ email_error: ('Not sent: ' + (sent.error || 'unknown')).slice(0, 300) });
}

// ── GUESTS ───────────────────────────────────────────────────────────────────
export async function eventsPublic(req, res, body, action) {
  if (!(await allow(publicRead, keyFor(clientIp(req)), { failOpen: true }))) return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  if (action === 'event_get') return eventGet(req, res, body);
  if (action === 'event_buy') return eventBuy(req, res, body);
  if (action === 'tickets_get') return ticketsGet(req, res, body);
  return res.status(400).json({ error: 'Unknown action.' });
}

async function eventByKey(key) {
  if (!KEY.test(String(key || ''))) return { gone: true };
  const r = await sb(`/events?public_key=eq.${key}&select=*`);
  if (!r.ok) return { error: notReady(r) ? NOT_READY : 'Could not read the event (the database answered ' + r.status + ').' };
  const e = first(r);
  return e ? { event: e } : { gone: true };
}

async function eventGet(req, res, body) {
  const got = await eventByKey(body.key);
  if (got.error) return res.status(502).json({ error: got.error });
  let e = got.event;
  if (got.gone) return res.status(404).json({ error: 'This event is not here. Check the link with the restaurant.', reason: 'gone' });
  if (e.status === 'draft') {          // a draft: only the restaurant's team (a preview)
    const tasterId = tasterIdFromRequest(req);
    const who = tasterId ? await gate({ status: () => ({ json: () => null }) }, tasterId, e.restaurant_id, LEVEL.crew, req) : null;
    if (!who) return res.status(404).json({ error: 'This event is not here. Check the link with the restaurant.', reason: 'gone' });
  }
  await settleHolds(e.id);
  const [loaded, c, conn, areas] = await Promise.all([loadBooking(e.restaurant_id), countsFor([e.id]), connectionOf(e.restaurant_id), areaNames(e.restaurant_id)]);
  if (!loaded || loaded.error) return res.status(502).json({ error: 'Could not read the restaurant.' });
  const tz = (loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const square = !!(conn.row && conn.row.location_id && sq.squareConfig().ready);
  return res.status(200).json({
    success: true,
    restaurant: { name: loaded.restaurant.name, address: loaded.restaurant.address, phone: loaded.restaurant.phone },
    event: { ...dressEvent(e, tz, areas.names, c[e.id], square, loaded.settings, false), draft: e.status === 'draft' },
    sandbox: square && conn.row.sandbox,
  });
}

const BUY_WHY = {
  not_on_sale: 'Tickets for this event are not on sale right now.',
  closed: 'Ticket sales for this event have closed.',
  too_many: 'That is more tickets than one order can have.',
  sold_out: 'Sold out — there are no tickets left.',
};

async function eventBuy(req, res, body) {
  const name = cleanText(body.name, 80);
  if (!name || name.length < 2 || !/\p{L}/u.test(name)) return res.status(400).json({ error: 'Please write your name.', reason: 'name' });
  const email = cleanEmail(body.email);
  if (!email || !sendableAddress(email)) return res.status(400).json({ error: 'Please write your email: the tickets go there.', reason: 'email' });
  const typed = String(body.phone || '').trim();
  const phone = typed ? normalizeUsPhone(typed) : null;
  if (typed && !phone) return res.status(400).json({ error: 'That phone number does not look right (a US number, or leave it empty).', reason: 'phone' });
  const qty = Number(body.quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 20) return res.status(400).json({ error: 'How many tickets?', reason: 'quantity' });

  const got = await eventByKey(body.key);
  if (got.error) return res.status(502).json({ error: got.error });
  if (got.gone || got.event.status !== 'published') return res.status(409).json({ error: BUY_WHY.not_on_sale, reason: 'not_on_sale' });
  const e = got.event;

  if (!(await allow(buyIp, keyFor(clientIp(req)), { failOpen: false }))) return res.status(429).json({ error: 'Too many orders from this connection. Please call the restaurant.' });
  if (!(await allow(buyMailbox, keyFor('mail:' + mailboxKey(email)), { failOpen: false }))) return res.status(429).json({ error: 'That email already has several orders today. Please call the restaurant.' });

  const [loaded, k] = await Promise.all([loadBooking(e.restaurant_id), keyOf(e.restaurant_id)]);
  if (!loaded || loaded.error) return res.status(502).json({ error: 'Could not read the restaurant.' });
  if (!k || !k.row.location_id) return res.status(409).json({ error: BUY_WHY.not_on_sale, reason: 'not_on_sale' });
  await settleHolds(e.id);

  const held = first(await rpc('hf_ticket_hold', { p_restaurant: e.restaurant_id, p_event: e.id, p_qty: qty, p_name: name, p_email: email,
    p_phone: phone, p_taster: tasterIdFromRequest(req), p_minutes: HOLD_MINUTES }));
  if (!held) return res.status(502).json({ error: 'Could not hold the tickets. Please try again in a moment.' });
  if (!held.ok) {
    return res.status(409).json({ error: held.reason === 'sold_out' && held.left_after > 0 ? `Only ${held.left_after} ${held.left_after === 1 ? 'ticket is' : 'tickets are'} left.` : (BUY_WHY[held.reason] || BUY_WHY.not_on_sale),
      reason: held.reason, left: held.left_after });
  }
  const tz = (loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const w = whenWords(tz, e.starts_at, e.ends_at);
  const link = await sq.paymentLink({
    token: k.token, locationId: k.row.location_id, currency: k.row.currency || 'USD',
    order: { id: held.order_id, token: held.token, quantity: qty, whenLine: `${w.short}, ${w.hours}` }, event: e,
    redirectUrl: orderLink(loaded.settings, held.token), buyerEmail: email, buyerPhone: phone,
  });
  if (!link.ok) {
    await PATCH(`/ticket_orders?id=eq.${held.order_id}&status=eq.held`, { status: 'cancelled', updated_at: new Date().toISOString() });
    console.error('[events:buy] payment link failed', e.id, link.error);
    return res.status(502).json({ error: 'Square could not open the payment page just now. Please try again in a moment.', reason: 'square' });
  }
  await PATCH(`/ticket_orders?id=eq.${held.order_id}`, {
    square_order_id: link.orderId || null, square_link_id: link.id, pay_url: link.url,
    ...(Number.isInteger(link.total) && link.total > 0 ? { total_cents: link.total } : {}), updated_at: new Date().toISOString(),
  });
  return res.status(200).json({ success: true, url: link.url, order: held.token, minutes: HOLD_MINUTES });
}

async function ticketsGet(req, res, body) {
  const o = TOKEN.test(String(body.o || '')) ? String(body.o) : null;
  const t = !o && TOKEN.test(String(body.t || '')) ? String(body.t) : null;
  if (!o && !t) return res.status(404).json({ error: 'This link does not open any tickets.', reason: 'gone' });
  let order, only = null;
  if (o) {
    const r = await sb(`/ticket_orders?token=eq.${o}&select=*`);
    if (!r.ok) return res.status(502).json({ error: notReady(r) ? NOT_READY : 'Could not read the tickets.' });
    order = first(r);
  } else {
    const r = await sb(`/tickets?token=eq.${t}&select=id,order_id,seq,token,status,used_at`);
    if (!r.ok) return res.status(502).json({ error: notReady(r) ? NOT_READY : 'Could not read the ticket.' });
    only = first(r);
    order = only ? first(await sb(`/ticket_orders?id=eq.${only.order_id}&select=*`)) : null;
  }
  if (!order) return res.status(404).json({ error: 'This link does not open any tickets.', reason: 'gone' });
  // Back from Square's page (or still waiting): ask Square now.
  if (o && (order.status === 'held' || order.status === 'expired')) {
    const st = await settleOrder(order);
    if (st !== order.status) order = first(await sb(`/ticket_orders?id=eq.${order.id}&select=*`)) || order;
  }
  const [e, list, loaded] = await Promise.all([
    sb(`/events?id=eq.${order.event_id}&select=*`),
    only ? Promise.resolve({ ok: true, data: [only] }) : sb(`/tickets?order_id=eq.${order.id}&select=id,seq,token,status,used_at&order=seq.asc`),
    loadBooking(order.restaurant_id),
  ]);
  const ev = first(e);
  if (!ev || !loaded || loaded.error) return res.status(502).json({ error: 'Could not read the event.' });
  const tz = (loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const areas = await areaNames(order.restaurant_id);
  const w = whenWords(tz, ev.starts_at, ev.ends_at);
  const tickets = rows(list).map((x) => ({
    seq: x.seq, of: order.quantity, status: x.status, usedAt: x.used_at, usedClock: x.used_at ? clock(tz, x.used_at) : null,
    link: ticketLink(loaded.settings, x.token), qr: order.status === 'paid' && x.status === 'valid' ? tableQrSvg(ticketQrText(loaded.settings, x.token)) : null,
  }));
  return res.status(200).json({
    success: true,
    view: only ? 'ticket' : 'order',
    restaurant: { name: loaded.restaurant.name, address: loaded.restaurant.address, phone: loaded.restaurant.phone },
    event: { key: ev.public_key, name: ev.name, day: w.day, short: w.short, hours: w.hours, startsAt: ev.starts_at, endsAt: ev.ends_at,
             room: ev.area_id ? areas.names[ev.area_id] || null : null, adultsOnly: !!ev.adults_only, cancelled: ev.status === 'cancelled', link: eventLink(loaded.settings, ev.public_key) },
    order: only ? { status: order.status } : {
      status: order.status, quantity: order.quantity, firstName: String(order.buyer_name || '').split(/\s+/)[0],
      total: money(order.paid_cents || order.total_cents), taxMode: ev.tax_mode, refunded: order.refunded_cents ? money(order.refunded_cents) : null,
      unit: money(order.unit_cents), sub: money(order.unit_cents * order.quantity),
      tax: ev.tax_mode === 'added' ? money(Math.max(0, (order.paid_cents || order.total_cents) - order.unit_cents * order.quantity)) : null,
      payUrl: order.status === 'held' && Date.parse(order.held_until) > Date.now() ? order.pay_url : null,
      heldUntil: order.held_until, emailed: !!order.email_sent_at,
    },
    tickets,
  });
}

// ── STAFF ────────────────────────────────────────────────────────────────────
export async function eventsStaff(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  const reads = ['ev_list', 'ev_day', 'ev_guests', 'ev_scan', 'sq_status'];
  if (!(await allow(reads.includes(action) ? staffRead : staffWrite, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many taps in a few minutes. Wait a moment and try again.' });
  }
  const need = ['ev_day', 'ev_guests', 'ev_scan', 'ev_admit', 'ev_unadmit'].includes(action) ? LEVEL.crew : LEVEL.manager;
  const who = await gate(res, tasterId, body.restaurantId, need, req);
  if (!who) return;
  const loaded = await loadBooking(who.rid);
  if (!loaded || loaded.error) return res.status(502).json({ error: 'Could not read the restaurant settings.' });
  const tz = (loaded.settings && loaded.settings.timezone) || 'America/New_York';
  const ctx = { req, res, body, who, tasterId, loaded, tz, settings: loaded.settings };
  switch (action) {
    case 'ev_list':       return evList(ctx);
    case 'ev_day':        return evDay(ctx);
    case 'ev_save':       return evSave(ctx);
    case 'ev_status':     return evStatus(ctx);
    case 'ev_guests':     return evGuests(ctx);
    case 'ev_scan':       return evScan(ctx);
    case 'ev_admit':      return evAdmit(ctx);
    case 'ev_unadmit':    return evUnadmit(ctx);
    case 'ev_void':       return evVoid(ctx);
    case 'sq_status':     return sqStatus(ctx);
    case 'sq_connect':    return sqConnect(ctx);
    case 'sq_location':   return sqLocation(ctx);
    case 'sq_disconnect': return sqDisconnect(ctx);
    default:              return res.status(400).json({ error: 'Unknown action.' });
  }
}

async function squareSummary(rid) {
  const cfg = sq.squareConfig();
  const c = await connectionOf(rid);
  if (c.missing) return { ready: false, migration: false, connected: false };
  const row = c.row;
  return {
    migration: true, ready: cfg.ready, sandbox: row ? !!row.sandbox : cfg.sandbox, connected: !!row,
    location: row && row.location_id ? { id: row.location_id, name: row.location_name } : null,
    problem: row && row.last_error ? row.last_error : null,
  };
}

async function evList({ res, who, tz, settings }) {
  const since = new Date(Date.now() - 60 * 24 * HOUR).toISOString();
  const r = await sb(`/events?restaurant_id=eq.${who.rid}&ends_at=gte.${since}&select=*&order=starts_at.asc&limit=200`);
  if (!r.ok) return res.status(notReady(r) ? 409 : 502).json({ error: notReady(r) ? NOT_READY : 'Could not read the events.', reason: notReady(r) ? 'migration' : undefined });
  const list = rows(r);
  for (const e of list.filter((x) => x.status === 'published').slice(0, 4)) await settleHolds(e.id, 2);
  const [c, square, areas] = await Promise.all([countsFor(list.map((e) => e.id)), squareSummary(who.rid), areaNames(who.rid)]);
  const selling = !!(square.connected && square.location && square.ready);
  return res.status(200).json({
    success: true, square, canEdit: who.canEdit, timezone: tz,
    rooms: areas.list.map((a) => ({ id: a.id, name: a.name })),
    events: list.map((e) => dressEvent(e, tz, areas.names, c[e.id], selling, settings, true)),
  });
}

// The events of one service day (the Reservations day, the Map, the Timeline).
async function evDay({ res, body, who, tz, settings }) {
  const date = cleanDate(body.date) || serviceToday(tz);
  const from = localToIso(tz, date, '05:00');
  const next = new Date(Date.parse(from) + 24 * HOUR).toISOString();
  const r = await sb(`/events?restaurant_id=eq.${who.rid}&status=eq.published&starts_at=lt.${next}&ends_at=gt.${from}&select=*&order=starts_at.asc&limit=20`);
  if (!r.ok) return res.status(200).json({ success: true, date, events: [], ready: !notReady(r) });
  const list = rows(r);
  const [c, areas] = await Promise.all([countsFor(list.map((e) => e.id)), areaNames(who.rid)]);
  return res.status(200).json({ success: true, date, ready: true, events: list.map((e) => dressEvent(e, tz, areas.names, c[e.id], true, settings, true)) });
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Text with its lines kept ("What's included", one per line): each line tidied, no empty lines, nothing invisible.
function cleanLines(value, max) {
  const t = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return t ? t.slice(0, max) : null;
}
function cents(v) {
  const t = String(v === undefined || v === null ? '' : v).replace(/[$,\s]/g, '');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
const intIn = (v, lo, hi) => { const n = Number(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : null; };

async function evSave({ res, body, who, tasterId, tz, settings }) {
  const f = body.event || {};
  const bad = (field, error) => res.status(400).json({ error, field });
  const name = cleanText(f.name, 80);
  if (!name || name.length < 2) return bad('name', 'Please give the event a name.');
  const date = cleanDate(f.date);
  if (!date) return bad('date', 'Which day is the event?');
  if (!TIME.test(String(f.start || '')) || !TIME.test(String(f.end || ''))) return bad('start', 'When does it start and end?');
  const startsAt = localToIso(tz, date, f.start);
  let endsAt = localToIso(tz, date, f.end);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = new Date(Date.parse(localToIso(tz, date, f.end)) + 24 * HOUR).toISOString();   // past midnight
  if (Date.parse(endsAt) - Date.parse(startsAt) > 24 * HOUR) return bad('end', 'An event can last 24 hours at most.');
  const areas = await areaNames(who.rid);
  const areaId = f.areaId === null || f.areaId === '' || f.areaId === undefined ? null : Number(f.areaId);
  if (areaId !== null && !areas.names[areaId]) return bad('areaId', 'Which room?');
  const takeRoom = f.takeRoom === true;
  if (takeRoom && areaId === null) return bad('areaId', 'To take the whole room, choose the room.');
  const price = cents(f.price);
  if (price === null || price < 100 || price > 500000) return bad('price', 'The price per person, in dollars (at least $1).');
  const total = intIn(f.total, 1, 2000);
  if (total === null) return bad('total', 'How many tickets are for sale (1 to 2,000)?');
  const taxMode = ['added', 'included', 'none'].includes(f.taxMode) ? f.taxMode : null;
  if (!taxMode) return bad('taxMode', 'Is the sales tax added at checkout, included, or none?');
  const taxRate = Number(f.taxRate);
  if (!(taxRate >= 0 && taxRate <= 25) || !/^\d{1,2}(\.\d{1,3})?$/.test(String(f.taxRate))) return bad('taxRate', 'The tax rate, in % (for example 8.875).');
  const max = intIn(f.max, 1, 20);
  if (max === null) return bad('max', 'The most tickets in one order (1 to 20).');
  const closeHours = intIn(f.closeHours, 0, 168);
  if (closeHours === null) return bad('closeHours', 'Sales close how many hours before (0 to 168)?');
  const about = cleanLines(f.about, 1200), included = cleanLines(f.included, 600);
  const row = { name, starts_at: startsAt, ends_at: endsAt, area_id: areaId, take_room: takeRoom, price_cents: price, tickets_total: total,
    tax_mode: taxMode, tax_rate: taxRate, max_per_order: max, close_hours: closeHours, about, included, adults_only: f.adultsOnly === true,
    updated_at: new Date().toISOString() };

  let saved;
  const id = f.id ? Number(f.id) : null;
  if (id) {
    const old = first(await sb(`/events?id=eq.${id}&restaurant_id=eq.${who.rid}&select=*`));
    if (!old) return res.status(404).json({ error: 'This event is not here any more.' });
    if (old.status === 'cancelled') return res.status(409).json({ error: 'A cancelled event cannot be changed.' });
    const c = (await countsFor([id]))[id];
    if (total < c.sold + c.held) return bad('total', `${c.sold + c.held} tickets are already sold or being paid: the number cannot be lower.`);
    const r = await sb(`/events?id=eq.${id}&restaurant_id=eq.${who.rid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    saved = first(r);
    if (!saved) return res.status(502).json({ error: 'Could not save the event (the database answered ' + r.status + ').' });
  } else {
    const r = await sb('/events', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...row, restaurant_id: who.rid, created_by: tasterId, status: 'draft' }) });
    if (!r.ok && notReady(r)) return res.status(409).json({ error: NOT_READY, reason: 'migration' });
    saved = first(r);
    if (!saved) return res.status(502).json({ error: 'Could not save the event (the database answered ' + r.status + ').' });
  }
  const c = (await countsFor([saved.id]))[saved.id];
  const square = await squareSummary(who.rid);
  return res.status(200).json({ success: true, event: dressEvent(saved, tz, areas.names, c, !!(square.connected && square.location && square.ready), settings, true),
    conflicts: takeRoom ? await bookingsInRoom(who.rid, saved, tz) : [] });
}

// "Take the whole room": the tables already booked in that room during the event (to move or call).
async function bookingsInRoom(rid, e, tz) {
  const s = first(await sb(`/restaurant_booking_settings?restaurant_id=eq.${rid}&select=hold_minutes`));
  const hold = Number((s && s.hold_minutes) || 90) * 60000;
  const from = new Date(Date.parse(e.starts_at) - hold).toISOString();
  const r = await sb(`/reservations?restaurant_id=eq.${rid}&area_id=eq.${e.area_id}&status=in.(booked,seated)&reserved_at=gt.${from}&reserved_at=lt.${e.ends_at}` +
                     '&select=id,guest_name,party_size,reserved_at&order=reserved_at.asc&limit=50');
  return rows(r).map((b) => ({ id: b.id, name: b.guest_name, party: b.party_size, time: clock(tz, b.reserved_at) }));
}

async function evStatus({ res, body, who, tz, settings }) {
  const id = Number(body.id), to = String(body.to || '');
  if (!['published', 'draft', 'cancelled'].includes(to)) return res.status(400).json({ error: 'Publish, back to draft, or cancel?' });
  const e = first(await sb(`/events?id=eq.${id}&restaurant_id=eq.${who.rid}&select=*`));
  if (!e) return res.status(404).json({ error: 'This event is not here any more.' });
  const c = (await countsFor([id]))[id];
  if (to === 'published') {
    const square = await squareSummary(who.rid);
    if (!square.ready) return res.status(409).json({ error: 'Square is not set up on the site yet (Seb\'s Analytics adds it in Vercel).', reason: 'square_app' });
    if (!square.connected || !square.location) return res.status(409).json({ error: 'Connect Square first (Settings → Tickets · Square): the money goes to your Square account.', reason: 'square' });
    if (Date.parse(e.ends_at) <= Date.now()) return res.status(409).json({ error: 'This event is over.' });
    if (e.status === 'cancelled') return res.status(409).json({ error: 'A cancelled event cannot be published again. Make a new one.' });
  }
  if (to === 'draft' && (c.sold > 0 || c.held > 0)) return res.status(409).json({ error: 'Tickets are already sold: it cannot go back to a draft. You can cancel it.' });
  const r = await sb(`/events?id=eq.${id}&restaurant_id=eq.${who.rid}`, { method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: to, updated_at: new Date().toISOString() }) });
  const saved = first(r);
  if (!saved) return res.status(502).json({ error: 'Could not change the event.' });
  const areas = await areaNames(who.rid);
  const square = await squareSummary(who.rid);
  return res.status(200).json({ success: true, event: dressEvent(saved, tz, areas.names, c, !!(square.connected && square.location && square.ready), settings, true),
    refundsToDo: to === 'cancelled' ? c.orders : 0 });
}

async function evGuests({ res, body, who, tz }) {
  const id = Number(body.id);
  const e = first(await sb(`/events?id=eq.${id}&restaurant_id=eq.${who.rid}&select=id,name,starts_at,ends_at,tickets_total,status`));
  if (!e) return res.status(404).json({ error: 'This event is not here any more.' });
  await settleHolds(id, 3);
  const cols = 'id,buyer_name,buyer_phone,quantity,status,held_until,paid_cents,total_cents,refunded_cents,over_limit,created_at,paid_at,email_sent_at,email_error'
    + (who.level >= LEVEL.manager ? ',buyer_email' : '');            // crew NEVER see an email address
  const [orders, tickets] = await Promise.all([
    sb(`/ticket_orders?event_id=eq.${id}&status=in.(held,paid,refunded)&select=${cols}&order=created_at.asc&limit=1000`),
    sb(`/tickets?event_id=eq.${id}&select=id,order_id,seq,status,used_at&order=order_id.asc,seq.asc&limit=4000`),
  ]);
  const byOrder = {};
  rows(tickets).forEach((t) => { (byOrder[t.order_id] = byOrder[t.order_id] || []).push({ id: t.id, seq: t.seq, status: t.status, usedAt: t.used_at, usedClock: t.used_at ? clock(tz, t.used_at) : null }); });
  const now = Date.now();
  const list = rows(orders).filter((o) => o.status !== 'held' || Date.parse(o.held_until) > now).map((o) => ({
    id: o.id, name: o.buyer_name, phone: o.buyer_phone || null, ...(who.level >= LEVEL.manager ? { email: o.buyer_email } : {}),
    quantity: o.quantity, status: o.status, paid: o.paid_cents ? money(o.paid_cents) : null, refunded: o.refunded_cents ? money(o.refunded_cents) : null,
    overLimit: !!o.over_limit, emailed: !!o.email_sent_at, emailProblem: who.level >= LEVEL.manager ? o.email_error : null,
    tickets: byOrder[o.id] || [],
  }));
  return res.status(200).json({ success: true, event: { id: e.id, name: e.name, hours: whenWords(tz, e.starts_at, e.ends_at).hours, status: e.status }, orders: list, canEdit: who.canEdit });
}

async function ticketByToken(token, rid) {
  if (!TOKEN.test(String(token || ''))) return null;
  const t = first(await sb(`/tickets?token=eq.${token}&select=id,order_id,event_id,restaurant_id,seq,status,used_at`));
  if (!t) return null;
  if (t.restaurant_id !== rid) return { other: true };
  const [o, e] = await Promise.all([sb(`/ticket_orders?id=eq.${t.order_id}&select=buyer_name,quantity,status`), sb(`/events?id=eq.${t.event_id}&select=id,name,starts_at,ends_at,status`)]);
  return { t, o: first(o), e: first(e) };
}
function scanAnswer(x, tz, extra = {}) {
  const w = whenWords(tz, x.e.starts_at, x.e.ends_at);
  return { ticketId: x.t.id, seq: x.t.seq, of: x.o.quantity, name: x.o.buyer_name, event: x.e.name, eventId: x.e.id, day: w.short, hours: w.hours,
    usedAt: x.t.used_at, usedClock: x.t.used_at ? clock(tz, x.t.used_at) : null, ...extra };
}
async function evScan({ res, body, who, tz }) {
  const x = await ticketByToken(body.token, who.rid);
  if (!x) return res.status(200).json({ success: true, state: 'not_found' });
  if (x.other) return res.status(200).json({ success: true, state: 'other_restaurant' });
  const now = Date.now();
  let state = 'ok';
  if (x.e.status === 'cancelled') state = 'event_cancelled';
  else if (x.t.status === 'void' || x.o.status !== 'paid') state = 'void';
  else if (x.t.used_at) state = 'used';
  else if (now < Date.parse(x.e.starts_at) - 6 * HOUR || now > Date.parse(x.e.ends_at) + 3 * HOUR) state = 'not_now';
  return res.status(200).json({ success: true, state, ...scanAnswer(x, tz) });
}
async function evAdmit({ res, body, who, tasterId, tz }) {
  // From the QR (token), or from the guest list by hand (ticketId: the guest's phone died, the name is on the list).
  if (!body.token && body.ticketId) {
    const t = first(await sb(`/tickets?id=eq.${Number(body.ticketId)}&restaurant_id=eq.${who.rid}&select=token`));
    body.token = t ? t.token : null;
  }
  const x = await ticketByToken(body.token, who.rid);
  if (!x) return res.status(200).json({ success: true, state: 'not_found' });
  if (x.other) return res.status(200).json({ success: true, state: 'other_restaurant' });
  const r = first(await rpc('hf_ticket_admit', { p_restaurant: who.rid, p_token: String(body.token), p_by: tasterId }));
  if (!r) return res.status(502).json({ error: 'Could not let them in. Try again.' });
  const again = await ticketByToken(body.token, who.rid);
  return res.status(200).json({ success: true, state: r.ok ? 'in' : (r.reason === 'event_cancelled' ? 'event_cancelled' : r.reason), ...scanAnswer(again || x, tz) });
}
async function evUnadmit({ res, body, who, tasterId }) {
  const r = first(await rpc('hf_ticket_unadmit', { p_restaurant: who.rid, p_ticket: Number(body.ticketId), p_by: tasterId }));
  if (!r || !r.ok) return res.status(409).json({ error: 'It can no longer be undone (15 minutes at most).' });
  return res.status(200).json({ success: true });
}
async function evVoid({ res, body, who, tasterId }) {
  const r = first(await rpc('hf_ticket_void', { p_restaurant: who.rid, p_ticket: Number(body.ticketId), p_void: body.void !== false, p_by: tasterId }));
  if (!r) return res.status(502).json({ error: 'Could not change the ticket.' });
  if (!r.ok) return res.status(409).json({ error: r.reason === 'used' ? 'This ticket was already used at the door.' : 'This ticket cannot be changed.' });
  return res.status(200).json({ success: true });
}

// ── Square, from Settings ────────────────────────────────────────────────────
async function sqStatus({ res, who }) {
  const square = await squareSummary(who.rid);
  let locations = null;
  if (square.connected && !square.location) {
    const k = await keyOf(who.rid);
    if (k) { const l = await sq.locations(k.token); if (l.ok) locations = l.list; }
  }
  return res.status(200).json({ success: true, square, locations });
}
async function sqConnect({ res, who, tasterId }) {
  const cfg = sq.squareConfig();
  if (!cfg.ready) return res.status(409).json({ error: 'Square is not set up on the site yet (Seb\'s Analytics adds it in Vercel).', reason: 'square_app' });
  const c = await connectionOf(who.rid);
  if (c.missing) return res.status(409).json({ error: NOT_READY, reason: 'migration' });
  return res.status(200).json({ success: true, url: sq.authorizeUrl(sq.makeState(who.rid, tasterId)) });
}
async function sqLocation({ res, body, who }) {
  const k = await keyOf(who.rid);
  if (!k) return res.status(409).json({ error: 'Connect Square first.' });
  const l = await sq.locations(k.token);
  if (!l.ok) return res.status(502).json({ error: 'Square did not answer: ' + l.error });
  const loc = l.list.find((x) => x.id === String(body.locationId || ''));
  if (!loc) return res.status(400).json({ error: 'Which location?' });
  await PATCH(`/square_connections?restaurant_id=eq.${who.rid}`, { location_id: loc.id, location_name: loc.name, currency: loc.currency });
  return res.status(200).json({ success: true, square: await squareSummary(who.rid) });
}
async function sqDisconnect({ res, who }) {
  const c = await connectionOf(who.rid);
  if (c.row) {
    const r = await sq.revoke(c.row.merchant_id);
    if (!r.ok) console.error('[events:square] revoke failed', who.rid, sq.squareSays(r));
    await sb(`/square_connections?restaurant_id=eq.${who.rid}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
  return res.status(200).json({ success: true, square: await squareSummary(who.rid) });
}

// ── the manager comes back from Square's page (GET /square-back) ─────────────
export async function squareBack(req, res, url) {
  const site = 'https://thehungryfork.fun';
  const go = (where, settings) => { res.status(302); res.setHeader('Location', `${siteOf(settings) || site}/manager#square=${where}`); res.setHeader('Cache-Control', 'no-store'); res.end(); };
  const p = url.searchParams;
  const st = sq.readState(p.get('state'));
  if (!st) return go('expired');
  const loaded = await loadBooking(st.restaurantId);
  const settings = loaded && !loaded.error ? loaded.settings : null;
  if (p.get('error') || !p.get('code')) return go('denied', settings);
  // Still a manager (or owner) of that restaurant?
  const [role, admin] = await Promise.all([
    sb(`/restaurant_roles?taster_id=eq.${st.tasterId}&restaurant_id=eq.${st.restaurantId}&role=in.(owner,manager)&select=id`),
    sb(`/tasters?id=eq.${st.tasterId}&is_platform_admin=is.true&select=id`),
  ]);
  if (!rows(role).length && !rows(admin).length) return go('denied', settings);
  const cfg = sq.squareConfig();
  if (!cfg.ready) return go('failed', settings);
  const t = await sq.exchangeCode(String(p.get('code')).slice(0, 400), cfg);
  if (!t.ok || !t.data.access_token || !t.data.merchant_id) { console.error('[events:square] code exchange failed', sq.squareSays(t)); return go('failed', settings); }
  const l = await sq.locations(t.data.access_token, cfg);
  const one = l.ok && l.list.length === 1 ? l.list[0] : null;
  const row = {
    restaurant_id: st.restaurantId, merchant_id: String(t.data.merchant_id), sandbox: cfg.sandbox,
    access_enc: sq.seal(t.data.access_token, cfg.secret), refresh_enc: sq.seal(t.data.refresh_token || '', cfg.secret),
    expires_at: t.data.expires_at || new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    location_id: one ? one.id : null, location_name: one ? one.name : null, currency: one ? one.currency : 'USD',
    connected_by: st.tasterId, connected_at: new Date().toISOString(), refreshed_at: null, last_error: null,
  };
  const saved = await sb('/square_connections?on_conflict=restaurant_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  if (!saved.ok) { console.error('[events:square] save failed', saved.status); return go('failed', settings); }
  return go(one ? 'connected' : 'choose', settings);
}

// ── Square's messages (POST /square-events) ──────────────────────────────────
// A message is only a hint: "look at order X". Paid or refunded is then asked of
// Square itself with the restaurant's key, so a made-up message changes nothing.
export async function squareEvents(req, res) {
  if (!(await allow(hookIp, keyFor(clientIp(req)), { failOpen: true }))) return res.status(429).json({ error: 'slow down' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const obj = (b.data && b.data.object) || {};
  const ids = [obj.payment && obj.payment.order_id, obj.refund && obj.refund.order_id, obj.order && (obj.order.id || obj.order.order_id)]
    .filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(x));
  let looked = 0;
  for (const id of [...new Set(ids)].slice(0, 3)) {
    const o = first(await sb(`/ticket_orders?square_order_id=eq.${encodeURIComponent(id)}&select=*`));
    if (o) { await settleOrder(o); looked += 1; }
  }
  if (b.type === 'oauth.authorization.revoked' && typeof b.merchant_id === 'string' && /^[A-Za-z0-9_-]{2,64}$/.test(b.merchant_id)) {
    for (const row of rows(await sb(`/square_connections?merchant_id=eq.${b.merchant_id}&select=*`))) {
      const k = sq.unseal(row.access_enc);
      const l = k ? await sq.locations(k) : { ok: false, status: 401 };
      if (!l.ok && (l.status === 401 || l.status === 403)) await sb(`/square_connections?restaurant_id=eq.${row.restaurant_id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  }
  return res.status(200).json({ ok: true, looked });
}

// ── once a day (the cron in api/reservations.js) ─────────────────────────────
export async function ticketsCron(budgetMs = 12000) {
  const out = { refreshed: 0, settled: 0, mailed: 0 };
  const until = Date.now() + budgetMs;            // the daily job has 30 seconds for everything: the tickets take 12 at most
  try {
    const cfg = sq.squareConfig();
    if (cfg.ready) {
      const soon = new Date(Date.now() + 10 * 24 * HOUR).toISOString();
      for (const row of rows(await sb(`/square_connections?expires_at=lt.${soon}&select=*&order=expires_at.asc&limit=8`))) {
        if (Date.now() > until) return out;
        if (await refreshRow(row, cfg)) out.refreshed += 1;
      }
    }
    const due = rows(await sb(`/ticket_orders?status=eq.held&held_until=lt.${new Date().toISOString()}&select=*&order=held_until.asc&limit=15`));
    for (const o of due) {
      if (Date.now() > until) return out;
      const st = await settleOrder(o);
      if (st !== 'held') out.settled += 1; else if (!o.square_order_id) await rpc('hf_ticket_expire', { p_order: o.id });
    }
    const unsent = rows(await sb(`/ticket_orders?status=eq.paid&email_sent_at=is.null&paid_at=lt.${new Date(Date.now() - 10 * 60000).toISOString()}&select=id&limit=5`));
    for (const o of unsent) { if (Date.now() > until) return out; await afterPaid(o.id, { push: false }); out.mailed += 1; }
  } catch (err) {
    console.error('[events:cron] threw', err && err.message);
  }
  return out;
}
