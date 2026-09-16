// api/checkin-token.js
//
// "I am here." The customer taps one button and this hands back a QR code.
//
// The QR is just a link: thehungryfork.fun/checkin.html?t=<random>. That is
// deliberate — a link needs no app and no scanner. Staff point the camera that
// came with their phone at the customer's screen, the phone offers to open the
// link, and the site takes over from there.
//
// Nothing about the customer is in the QR. Not their name, not their number,
// not their account id. Anyone who photographs it over the customer's shoulder
// holds a ticket that expires in ninety seconds and, if they use it, records a
// visit for the customer. There is nothing to steal.

import QRCode from 'qrcode';
import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import { tasterIdFromRequest, sb } from './_lib/roles.js';
import {
  TOKEN_SECONDS, makeToken, hashToken, makeShortCode, siteUrl,
} from './_lib/checkin.js';

// The screen refreshes itself every ninety seconds while it is open, so a
// customer waiting five minutes for a table legitimately asks for a few. This
// is loose enough never to interrupt that and tight enough that nobody farms
// tokens.
const issueLimiter = makeLimiter({ requests: 60, window: '10 m', prefix: 'checkin:issue' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  if (!(await allow(issueLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many codes at once. Wait a minute and try again.' });
  }

  const token = makeToken();
  const expiresAt = new Date(Date.now() + TOKEN_SECONDS * 1000);

  // The short code has to be unique among the codes that are still alive. Six
  // characters from an alphabet of 31 is about a billion combinations against
  // at most a handful of live tokens, so a clash is a curiosity rather than a
  // risk — but "a curiosity" is not "impossible", and a clash would check in
  // the wrong person. Three tries, then the QR alone.
  let shortCode = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = makeShortCode();
    const clash = await sb(
      `/check_in_tokens?short_code=eq.${candidate}&used_at=is.null` +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`
    );
    if (clash.ok && Array.isArray(clash.data) && clash.data.length === 0) { shortCode = candidate; break; }
  }

  const created = await sb('/check_in_tokens', {
    method: 'POST',
    body: JSON.stringify({
      token_hash: hashToken(token),
      taster_id:  tasterId,
      short_code: shortCode,
      expires_at: expiresAt.toISOString(),
    }),
  });
  if (!created.ok) {
    console.error('[checkin-token] insert failed', created.status);
    return res.status(500).json({ error: 'Could not create your check-in code.' });
  }

  // Housekeeping, here rather than in a scheduled job: this table is pure
  // litter an hour later, and the person who just made a row is the right
  // person to sweep up their own. Failure is ignored — a stale row nobody can
  // use is not a reason to refuse somebody a check-in code.
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await sb(
      `/check_in_tokens?taster_id=eq.${tasterId}&expires_at=lt.${encodeURIComponent(cutoff)}`,
      { method: 'DELETE' }
    );
  } catch (e) {
    console.error('[checkin-token] sweep failed', e?.message);
  }

  const url = `${siteUrl()}/checkin.html?t=${encodeURIComponent(token)}`;

  // Drawn on the server, as an SVG. No QR library in the browser, no request to
  // a QR website, and nothing about this customer ever leaves our own servers
  // to have a picture made of it.
  //
  // Error correction M, not H: the code has to survive a fingerprint on a
  // screen, not a sun-bleached sticker on a window. M keeps the squares big,
  // which is what actually matters when one phone photographs another.
  let svg;
  try {
    svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#2B211A', light: '#FFFFFF' },
    });
  } catch (e) {
    console.error('[checkin-token] qr failed', e?.message);
    return res.status(500).json({ error: 'Could not draw your check-in code.' });
  }

  return res.status(200).json({
    success:   true,
    svg,
    shortCode,
    expiresAt: expiresAt.toISOString(),
    seconds:   TOKEN_SECONDS,
  });
}
