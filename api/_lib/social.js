// api/_lib/social.js — r52 (Sebastian, 9 Nov 2026): the restaurant's pages on social media.
//
// The home page gets a Social button that opens Instagram, TikTok, Facebook and Google
// ("Find us online"). The manager pastes the four links once, in Settings → Social media,
// and a button shows only when its link is filled in. Everyone sees the same buttons:
// there is nothing here that depends on who is looking, and no reward for anything
// (asking only happy guests for a Google review, or paying for one, is against Google's
// rules and the FTC's).
//
// What the manager pastes is tidied into one shape per site before it is saved, so a
// handle ("@thehungryfork"), a link without https, or a link with tracking on the end all
// give the same thing — and the database checks that shape too (migration 36):
//   Instagram  https://www.instagram.com/<name>/        name: letters, digits, . and _ (1–30)
//   TikTok     https://www.tiktok.com/@<name>           name: letters, digits, . and _ (2–24)
//   Facebook   https://www.facebook.com/<page>          a page name, or profile.php?id=<digits>
//   Google     the Google Maps link of the restaurant   google.com/maps…, maps.app.goo.gl/…,
//                                                       goo.gl/maps/…, g.page/…, maps.google.com/…,
//                                                       search.google.com/local/writereview?placeid=…
// Before migration 36 there are no columns: Settings says so, and the home page shows no button.
import { sb, LEVEL } from './roles.js';

export const SOCIAL_KINDS = ['instagram', 'tiktok', 'facebook', 'google'];
const COLUMN = { instagram: 'social_instagram', tiktok: 'social_tiktok', facebook: 'social_facebook', google: 'social_google' };
const NAME = { instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook', google: 'Google' };

// A link as a URL object, whatever was pasted (with or without https://, www., spaces).
function asUrl(raw) {
  let s = String(raw).trim().replace(/\s+/g, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u : null; } catch { return null; }
}
const host = (u) => u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');

// One link, tidied: { value } (null = take it off), or { error } in plain words.
export function cleanSocial(kind, raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw !== 'string') return { error: `The ${NAME[kind]} link has to be text.` };
  const t = raw.trim();
  if (!t) return { value: null };
  if (t.length > 500) return { error: `The ${NAME[kind]} link is too long.` };

  if (kind === 'instagram' || kind === 'tiktok') {
    const site = kind === 'instagram' ? 'instagram.com' : 'tiktok.com';
    let name = null;
    if (/^@?[A-Za-z0-9._]+$/.test(t)) name = t.replace(/^@/, '');
    else {
      const u = asUrl(t);
      if (!u || host(u) !== site) return { error: `That isn't an ${NAME[kind]} link. Paste the address of your ${NAME[kind]} page, or just your name there (like @thehungryfork).` };
      const first = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '');
      name = kind === 'tiktok' ? (first.startsWith('@') ? first.slice(1) : null) : first;
      if (kind === 'instagram' && ['p', 'reel', 'reels', 'explore', 'stories', 'accounts'].includes(name)) name = null;
    }
    const ok = kind === 'instagram' ? /^[A-Za-z0-9._]{1,30}$/ : /^[A-Za-z0-9._]{2,24}$/;
    if (!name || !ok.test(name)) return { error: `That ${NAME[kind]} name doesn't look right. Paste the address of your ${NAME[kind]} page (like ${kind === 'instagram' ? 'instagram.com/thehungryfork' : 'tiktok.com/@thehungryfork'}).` };
    return { value: kind === 'instagram' ? `https://www.instagram.com/${name}/` : `https://www.tiktok.com/@${name}` };
  }

  const u = asUrl(t);
  if (kind === 'facebook') {
    if (!u || !['facebook.com', 'fb.com'].includes(host(u))) return { error: 'That isn\'t a Facebook link. Paste the address of your Facebook page (like facebook.com/thehungryfork).' };
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'profile.php') {
      const id = u.searchParams.get('id');
      if (!id || !/^\d{5,25}$/.test(id)) return { error: 'That Facebook link has no page in it. Open your page on Facebook and copy its address.' };
      return { value: `https://www.facebook.com/profile.php?id=${id}` };
    }
    // facebook.com/<page>, or facebook.com/pages/<name>/<id>, or facebook.com/people/<name>/<id>
    const keep = ['pages', 'people'].includes(parts[0]) ? parts.slice(0, 3) : parts.slice(0, 1);
    const path = keep.map((p) => decodeURIComponent(p)).join('/');
    if (!path || !/^[A-Za-z0-9._/-]{1,150}$/.test(path) || ['sharer', 'share', 'login', 'groups', 'events', 'watch'].includes(keep[0])) {
      return { error: 'That Facebook link has no page in it. Open your page on Facebook and copy its address.' };
    }
    return { value: `https://www.facebook.com/${path}` };
  }

  // Google: the restaurant's own place on Google Maps (or its "write a review" link).
  if (!u) return { error: 'That isn\'t a Google Maps link. On Google Maps, open your restaurant, tap Share, and paste the link here.' };
  const h = host(u), path = u.pathname;
  const isMaps = (h === 'google.com' && path.startsWith('/maps'))
    || h === 'maps.google.com' || h === 'maps.app.goo.gl' || (h === 'goo.gl' && path.startsWith('/maps'))
    || h === 'g.page' || (h === 'g.co' && path.startsWith('/kgs'))
    || (h === 'search.google.com' && path.startsWith('/local/'));
  if (!isMaps) return { error: 'That isn\'t a Google Maps link. On Google Maps, open your restaurant, tap Share, and paste the link here.' };
  u.protocol = 'https:';
  u.hash = '';
  const value = u.toString();
  if (value.length > 500 || /[\s<>"]/.test(value)) return { error: 'That Google link is too long. Use the short link from Share on Google Maps.' };
  return { value };
}

// The short words a button shows under its name: "@thehungryfork", "thehungryfork", "Google Maps".
export function socialLabel(kind, url) {
  if (!url) return null;
  if (kind === 'instagram') return '@' + url.replace(/^https:\/\/www\.instagram\.com\//, '').replace(/\/$/, '');
  if (kind === 'tiktok') return url.replace(/^https:\/\/www\.tiktok\.com\//, '');
  if (kind === 'facebook') {
    const rest = url.replace(/^https:\/\/www\.facebook\.com\//, '');
    if (rest.startsWith('profile.php')) return 'Facebook page';
    const parts = rest.split('/');
    return ['pages', 'people'].includes(parts[0]) ? (parts[1] || 'Facebook page').replace(/-/g, ' ') : parts[0];
  }
  return 'Google Maps';
}

function out(row) {
  const links = {};
  SOCIAL_KINDS.forEach((k) => { const v = row[COLUMN[k]]; if (typeof v === 'string' && v) links[k] = v; });
  return links;
}

// For the home page (it rides with the opening hours): only the links filled in,
// with their short words. null when the columns are not there (before migration 36).
export async function socialPublic(rid) {
  const got = await sb(`/restaurants?id=eq.${Number(rid)}&select=${Object.values(COLUMN).join(',')}&limit=1`);
  if (!got.ok || !Array.isArray(got.data) || !got.data[0]) return null;
  const links = out(got.data[0]);
  const list = SOCIAL_KINDS.filter((k) => links[k]).map((k) => ({ kind: k, url: links[k], label: socialLabel(k, links[k]) }));
  return { links: list };
}

// For Settings: the four links as saved, and who saved them last and when.
export async function socialOf(rid, timezone = 'America/New_York') {
  const got = await sb(`/restaurants?id=eq.${Number(rid)}&select=${Object.values(COLUMN).join(',')},social_at,social_by&limit=1`);
  if (!got.ok || !Array.isArray(got.data) || !got.data[0]) return { ready: false };
  const r = got.data[0];
  let by = null;
  if (r.social_by) {
    const t = await sb(`/tasters?id=eq.${Number(r.social_by)}&select=first_name`);
    by = t.ok && Array.isArray(t.data) && t.data[0] ? (String(t.data[0].first_name || '').trim().split(/\s+/)[0] || null) : null;
  }
  const on = r.social_at
    ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(r.social_at))
    : null;
  const links = out(r);
  return { ready: true, links, changedOn: on, changedBy: by };
}

// Settings → Social media → Save. Managers and owners; crew see the card but cannot change it.
// body.links: { instagram, tiktok, facebook, google } — a missing kind keeps what is saved,
// an empty one takes the button off the home page.
export async function saveSocial(req, res, body, tasterId, { gate, tellChange, timezoneOf }) {
  const who = await gate(res, tasterId, body.restaurantId, LEVEL.manager, req);
  if (!who) return;
  const input = body.links && typeof body.links === 'object' ? body.links : null;
  if (!input) return res.status(400).json({ error: 'Which links?' });
  const patch = {};
  for (const k of SOCIAL_KINDS) {
    if (!(k in input)) continue;
    const c = cleanSocial(k, input[k]);
    if (c.error) return res.status(400).json({ error: c.error, kind: k });
    patch[COLUMN[k]] = c.value;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Which links?' });
  const was = await sb(`/restaurants?id=eq.${who.rid}&select=${Object.values(COLUMN).join(',')}`);
  if (!was.ok) {
    const code = was.data && was.data.code;
    if (was.status === 400 && (code === '42703' || code === 'PGRST204' || !code)) return res.status(409).json({ error: 'Social media links are not set up yet: migration 36 has not been run.' });
    return res.status(502).json({ error: 'Could not read the links (the database answered ' + was.status + '). Please try again.' });
  }
  const before = was.data && was.data[0] ? out(was.data[0]) : {};
  const saved = await sb(`/restaurants?id=eq.${who.rid}`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, social_at: new Date().toISOString(), social_by: tasterId }),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) {
    const st = saved.status, code = saved.data && saved.data.code;
    console.error('[social] save failed', who.rid, st, code || '');
    if (st === 400 && (!code || code === 'PGRST204' || code === '42703')) return res.status(409).json({ error: 'Social media links are not set up yet: migration 36 has not been run.' });
    if (st === 400 && code === '23514') return res.status(400).json({ error: 'One of the links doesn\'t look right. Check them and try again.' });
    return res.status(502).json({ error: 'Could not save the links (the database answered ' + st + '). Please try again.' });
  }
  const after = out(saved.data[0]);
  const changed = SOCIAL_KINDS.filter((k) => (before[k] || null) !== (after[k] || null));
  console.log('[social] taster', tasterId, 'saved the links of', who.rid, changed.join(',') || '(no change)');
  if (changed.length) {
    const words = changed.map((k) => (after[k] ? (before[k] ? 'changed' : 'added') : 'took off') + ' the ' + NAME[k] + ' link');
    await tellChange(who.rid, tasterId, words.join(', ') + ' (Social button on the home page)', { go: 'settings' });
  }
  const tz = timezoneOf ? await timezoneOf(who.rid) : 'America/New_York';
  return res.status(200).json({ success: true, social: await socialOf(who.rid, tz) });
}
