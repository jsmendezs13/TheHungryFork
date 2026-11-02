// api/_lib/square.js — r50 (2 Nov 2026): each restaurant's own Square account
// for event tickets (Sebastian, 30 Oct: "each restaurant, not Seb's Analytics
// nor Fork's Rating, can sell tickets"; the money goes to the restaurant; no fee).
//
// One Square application (Seb's Analytics') — its Application ID is public, its
// secret lives only in Vercel (SQUARE_APP_ID, SQUARE_APP_SECRET). Each
// restaurant connects its own account with Square's "OAuth code flow": a
// manager taps Connect Square, logs in on Square's own page, taps Allow, and
// Square sends them back to /square-back with a one-time code. The keys Square
// gives for that account are kept in square_connections locked with AES-GCM
// (the key comes from the app secret, so nothing else to keep), and a browser
// never sees them.
//
// What the site may do with the account (the "scopes"): make an order and a
// payment link (ORDERS_WRITE, PAYMENTS_WRITE), read them back to know they are
// paid or refunded (ORDERS_READ, PAYMENTS_READ), and read the shop's locations
// (MERCHANT_PROFILE_READ). Nothing else: no customers, no other sales.
//
// "Sandbox" (Square's test mode, test cards, no real money) or the real thing
// is read from the Application ID: Square's sandbox IDs start with "sandbox-".

import crypto from 'node:crypto';

export const SQUARE_VERSION = '2024-10-17';
export const SCOPES = ['ORDERS_WRITE', 'ORDERS_READ', 'PAYMENTS_WRITE', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ'];
const TIMEOUT_MS = 9000;

export function squareConfig() {
  const appId = String(process.env.SQUARE_APP_ID || '').trim();
  const secret = String(process.env.SQUARE_APP_SECRET || '').trim();
  const ready = /^(sandbox-)?sq0idp-[A-Za-z0-9_-]{6,}$/.test(appId) && secret.length >= 16;
  const sandbox = appId.startsWith('sandbox-');
  // SQUARE_BASE only on the test bench (a pretend Square); never set in Vercel.
  const base = String(process.env.SQUARE_BASE || '').trim()
    || (sandbox ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com');
  return { ready, appId, secret, sandbox, base };
}

// ── keys kept locked ─────────────────────────────────────────────────────────
function keyFrom(secret, info) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('hf-square'), Buffer.from(info), 32));
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
export function seal(text, secret = squareConfig().secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(secret, 'tokens v1'), iv);
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1.${b64u(iv)}.${b64u(body)}.${b64u(c.getAuthTag())}`;
}
export function unseal(sealed, secret = squareConfig().secret) {
  try {
    const [v, iv, body, tag] = String(sealed || '').split('.');
    if (v !== 'v1' || !iv || !body || !tag) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret, 'tokens v1'), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }      // another secret (it was changed in Vercel): connect again
}

// ── the round trip to Square's page: a signed "state" ────────────────────────
// It says which restaurant and which manager started it, and until when (10
// minutes). Signed with a key from the app secret, so nobody can make one, and
// a Square account can only end up on the restaurant whose manager asked.
export function makeState(restaurantId, tasterId, now = Date.now(), secret = squareConfig().secret) {
  const body = `${Number(restaurantId)}.${Number(tasterId)}.${now + 10 * 60 * 1000}.${crypto.randomBytes(8).toString('hex')}`;
  const sig = crypto.createHmac('sha256', keyFrom(secret, 'state v1')).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}
export function readState(state, now = Date.now(), secret = squareConfig().secret) {
  const [b, sig] = String(state || '').split('.');
  if (!b || !sig || b.length > 200) return null;
  let body;
  try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const want = crypto.createHmac('sha256', keyFrom(secret, 'state v1')).update(body).digest('base64url');
  const got = Buffer.from(sig), exp = Buffer.from(want);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return null;
  const [rid, tid, until] = body.split('.').map(Number);
  if (!Number.isInteger(rid) || rid < 1 || !Number.isInteger(tid) || tid < 1 || !(until > now)) return null;
  return { restaurantId: rid, tasterId: tid };
}

export function authorizeUrl(state, cfg = squareConfig()) {
  const q = new URLSearchParams({ client_id: cfg.appId, scope: SCOPES.join(' '), state });
  if (!cfg.sandbox) q.set('session', 'false');        // Square: production needs session=false; the sandbox only takes its default
  return `${cfg.base}/oauth2/authorize?${q.toString()}`;
}

// ── talking to Square ────────────────────────────────────────────────────────
async function call(path, { method = 'GET', token, body, auth } = {}, cfg = squareConfig()) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(cfg.base + path, {
      method,
      headers: {
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(auth ? { Authorization: auth } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: abort.signal,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: {}, timedOut: err && err.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}
// Square's own words for a refusal, short (for the logs and the manager's screen).
export function squareSays(r) {
  const e = r && r.data && Array.isArray(r.data.errors) ? r.data.errors[0] : null;
  if (r && r.timedOut) return 'Square did not answer in time';
  if (!r || r.status === 0) return 'Could not reach Square';
  return (`Square ${r.status}` + (e ? `: ${e.code || ''} ${e.detail || ''}`.trimEnd() : (r.data && r.data.message ? `: ${r.data.message}` : ''))).slice(0, 240);
}

export async function exchangeCode(code, cfg = squareConfig()) {
  return call('/oauth2/token', { method: 'POST', body: { client_id: cfg.appId, client_secret: cfg.secret, grant_type: 'authorization_code', code } }, cfg);
}
export async function refreshToken(refresh, cfg = squareConfig()) {
  return call('/oauth2/token', { method: 'POST', body: { client_id: cfg.appId, client_secret: cfg.secret, grant_type: 'refresh_token', refresh_token: refresh } }, cfg);
}
export async function revoke(merchantId, cfg = squareConfig()) {
  return call('/oauth2/revoke', { method: 'POST', auth: `Client ${cfg.secret}`, body: { client_id: cfg.appId, merchant_id: merchantId } }, cfg);
}
// The shop's places that can take card payments.
export async function locations(token, cfg = squareConfig()) {
  const r = await call('/v2/locations', { token }, cfg);
  if (!r.ok) return { ok: false, status: r.status, error: squareSays(r), list: [] };
  const list = (r.data.locations || [])
    .filter((l) => l && l.status === 'ACTIVE' && (!Array.isArray(l.capabilities) || l.capabilities.includes('CREDIT_CARD_PROCESSING')))
    .map((l) => ({ id: String(l.id), name: String(l.name || l.business_name || 'Location').slice(0, 80), currency: /^[A-Z]{3}$/.test(l.currency) ? l.currency : 'USD' }));
  return { ok: true, list };
}

// The guest's checkout: one Square order with the tickets and the tax, on
// Square's own secure page. Square sends the guest back to redirectUrl.
export async function paymentLink({ token, locationId, currency, order, event, redirectUrl, buyerEmail, buyerPhone }, cfg = squareConfig()) {
  const body = {
    idempotency_key: `hf-tickets-${order.id}-${order.token.slice(0, 12)}`,
    order: {
      location_id: locationId,
      reference_id: `HF-T${order.id}`,
      line_items: [{
        name: `${event.name} · ticket`.slice(0, 120),
        quantity: String(order.quantity),
        base_price_money: { amount: event.price_cents, currency },
        note: `${order.quantity} ${order.quantity === 1 ? 'ticket' : 'tickets'} · ${order.whenLine || ''}`.slice(0, 200),
      }],
      ...(event.tax_mode === 'none' ? {} : {
        taxes: [{ uid: 'sales-tax', name: 'Sales tax', percentage: String(Number(event.tax_rate)), scope: 'ORDER',
                  type: event.tax_mode === 'included' ? 'INCLUSIVE' : 'ADDITIVE' }],
      }),
    },
    checkout_options: { redirect_url: redirectUrl, ask_for_shipping_address: false },
    pre_populated_data: { buyer_email: buyerEmail, ...(buyerPhone ? { buyer_phone_number: buyerPhone } : {}) },
    payment_note: `Tickets HF-T${order.id}`,
  };
  const r = await call('/v2/online-checkout/payment-links', { method: 'POST', token, body }, cfg);
  if (!r.ok || !r.data.payment_link || !r.data.payment_link.url) return { ok: false, status: r.status, error: squareSays(r) };
  const link = r.data.payment_link;
  const sqOrder = r.data.related_resources && Array.isArray(r.data.related_resources.orders) ? r.data.related_resources.orders[0] : null;
  const total = sqOrder && sqOrder.total_money && Number.isInteger(sqOrder.total_money.amount) ? sqOrder.total_money.amount : null;
  return { ok: true, id: String(link.id), url: String(link.url), orderId: String(link.order_id || (sqOrder && sqOrder.id) || ''), total };
}

// Is this Square order paid, and how much went back? The truth always comes
// from Square itself, with the restaurant's own key — never from what a
// message to /square-events says.
export async function orderMoney(token, squareOrderId, cfg = squareConfig()) {
  const r = await call(`/v2/orders/${encodeURIComponent(squareOrderId)}`, { token }, cfg);
  if (!r.ok || !r.data.order) return { ok: false, status: r.status, error: squareSays(r) };
  const o = r.data.order;
  const total = o.total_money && Number.isInteger(o.total_money.amount) ? o.total_money.amount : null;
  let paid = 0, refunded = 0;
  const ids = (o.tenders || []).map((t) => t && t.payment_id).filter(Boolean);
  for (const id of [...new Set(ids)].slice(0, 5)) {
    const p = await call(`/v2/payments/${encodeURIComponent(id)}`, { token }, cfg);
    if (!p.ok || !p.data.payment) return { ok: false, status: p.status, error: squareSays(p) };
    const pay = p.data.payment;
    if (pay.status === 'COMPLETED') {
      paid += Number((pay.amount_money && pay.amount_money.amount) || 0) + Number((pay.tip_money && pay.tip_money.amount) || 0);
      refunded += Number((pay.refunded_money && pay.refunded_money.amount) || 0);
    }
  }
  const due = o.net_amount_due_money && Number.isInteger(o.net_amount_due_money.amount) ? o.net_amount_due_money.amount : null;
  // A payment link's order with nothing left to pay and no tender listed yet (it happens for a moment): paid.
  if (!paid && o.state === 'COMPLETED' && due === 0 && total) paid = total;
  return { ok: true, state: o.state, total, paid, refunded, isPaid: total !== null && paid >= total && o.state !== 'CANCELED' };
}
