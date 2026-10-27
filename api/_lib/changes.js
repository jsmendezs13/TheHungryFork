// api/_lib/changes.js
//
// r43 (Sebastian, 26 Oct 22:56): every change to a restaurant's setup is told to
// its owners and managers (and the platform admin) as a notification on their
// phones: who did it, what changed, and when. Never to crew, and never to the
// person who made it. Notifications kind "changes" (api/_lib/push.js); each
// person can switch it off in Settings → You and your devices.
//
// A change: the team (adding or removing people, rewards, who answers guests,
// jobs), the menu (prices, words, sold out, hidden, picks, allergens, Top Rated,
// the order), the hours, holidays, rooms, the booking rules, the rewards, the
// grade, and who gets the emails about big parties. Not a change: the evening's
// service (arrivals, no-shows, answers to guests and to big-party requests).
//
// Never throws, never stops the save it reports: a change that was saved stays
// saved even if the notification cannot go.

import { sb } from './roles.js';
import { loadBooking } from './booking.js';
import { notifyStaff, line } from './push.js';

const MAX = 180;          // letters in a notification about a change (the phone shows about four lines)

// "Ana (Ana_L)", or "Ana Lopez (Ana_L)" with the last name; "Someone" when the account is gone.
export async function personName(tasterId, { full = false } = {}) {
  const got = await sb(`/tasters?id=eq.${Number(tasterId)}&select=first_name,last_name,username`);
  const t = got.ok && Array.isArray(got.data) && got.data[0] ? got.data[0] : null;
  if (!t) return 'Someone';
  const first = String(t.first_name || '').trim();
  const name = (full ? [first, String(t.last_name || '').trim()].filter(Boolean).join(' ') : first.split(/\s+/)[0]) || 'Someone';
  return t.username ? `${name} (${t.username})` : name;
}

// The clock where the restaurant is: "10:42 PM".
export function clockAt(timezone, ms = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone || 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

// Tell the restaurant's owners and managers. what: the change, after the name
// ("changed Fork Steak: price $30.00 → $32.00"). place: where the notification
// opens — { dish: id } or { go: 'team' | 'menu' | 'settings' }.
export async function tellChange(restaurantId, actorId, what, place = {}) {
  try {
    const rid = Number(restaurantId);
    if (!what || !Number.isInteger(rid) || rid < 1) return 0;
    const [who, loaded] = await Promise.all([personName(actorId), loadBooking(rid).catch(() => null)]);
    const tz = (loaded && loaded.settings && loaded.settings.timezone) || 'America/New_York';
    const name = (loaded && loaded.restaurant && loaded.restaurant.name) || 'The restaurant';
    const url = place.dish ? `/manager#dish=${Number(place.dish)}&at=${rid}`
      : `/manager#go=${['team', 'menu', 'settings'].includes(place.go) ? place.go : 'settings'}&at=${rid}`;
    console.log('[changes]', rid, 'by', actorId + ':', what);
    return await notifyStaff(rid, 'changes', {
      title: `${name} · Change`,
      body: line(`${who} ${what} · ${clockAt(tz)}`, MAX),
      url, tag: `change-${rid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    }, { except: actorId });
  } catch (err) {
    console.error('[changes] could not tell', restaurantId, err && err.message);
    return 0;
  }
}

// ── Words ─────────────────────────────────────────────────────────────────────
export const money = (v) => (v === null || v === undefined || v === '' ? 'no price' : '$' + Number(v).toFixed(2));
const same = (a, b) => String(a ?? '') === String(b ?? '');
const words = (v) => (v === null || v === undefined || String(v).trim() === '' ? 'none' : `"${line(String(v), 40)}"`);
const human = (column) => String(column).replace(/^allergen_/, '').replace(/_/g, ' ');

// A clock time "13:30" → "1:30 PM", "12:00" → "12 PM".
export function clock12(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''));
  if (!m) return String(t || '');
  const h = Number(m[1]), ap = h < 12 ? 'AM' : 'PM', hh = h % 12 || 12;
  return m[2] === '00' ? `${hh} ${ap}` : `${hh}:${m[2]} ${ap}`;
}

// One dish: what the patch changed, in a few words each.
const PRICE_WORDS = { price: 'price', price_glass: 'glass price', price_bottle: 'bottle price', price_shot: 'shot price', price_mixed: 'mixed-drink price' };
const TEXT_WORDS = { description: 'description', about: 'about', ingredients: 'ingredients', modifications: 'modifications', wine: 'wine note',
  cocktail: 'cocktail note', allergens_text: 'allergen note' };
export function describeDish(before, patch) {
  const parts = [], plus = [], minus = [];
  for (const [col, value] of Object.entries(patch)) {
    const old = before[col];
    if (same(old, value)) continue;
    if (col in PRICE_WORDS) parts.push(`${PRICE_WORDS[col]} ${money(old)} → ${money(value)}`);
    else if (col === 'sold_out_until') parts.push(value ? 'sold out' : 'back on the menu (no longer sold out)');
    else if (col === 'is_hidden') parts.push(value ? 'hidden from the menu' : 'shown on the menu again');
    else if (col === 'is_chefs_pick') parts.push(value ? 'now the Chef\'s Pick' : 'no longer the Chef\'s Pick');
    else if (col === 'is_bartenders_pick') parts.push(value ? 'now the Bartender\'s Pick' : 'no longer the Bartender\'s Pick');
    else if (col.startsWith('allergen_')) (value ? plus : minus).push(human(col));
    else if (col === 'name') parts.push(`renamed to ${words(value)}`);
    else if (col === 'drink_kind') parts.push(`kind of drink ${old || 'none'} → ${value || 'none'}`);
    else if (col === 'pair_wine_id') parts.push(value ? 'wine pairing changed' : 'wine pairing removed');
    else if (col === 'pair_cocktail_id') parts.push(value ? 'cocktail pairing changed' : 'cocktail pairing removed');
    else if (col in TEXT_WORDS) parts.push(`${TEXT_WORDS[col]} edited`);
    else parts.push(`${human(col)} ${old ? words(old) + ' → ' : ''}${words(value)}`);
  }
  if (plus.length || minus.length) {
    parts.push('allergens' + (plus.length ? ' + ' + plus.join(', ') : '') + (minus.length ? ' − ' + minus.join(', ') : ''));
  }
  return parts.length ? `changed ${words(before.name).replace(/^"|"$/g, '')}: ${parts.join('; ')}` : null;
}

// The booking rules: the labels of Settings.
const RULE_WORDS = {
  is_enabled: ['Online booking', 'switch'], email_enabled: ['Emails to guests', 'switch'], auto_release_late: ['Give away the table of a late guest', 'switch'],
  hold_minutes: ['A table is held for', 'minutes'], grace_minutes: ['Wait for a late guest', 'minutes'],
  last_seating_minutes: ['Last booking before closing', 'minutes'], lead_minutes: ['Guests book at least', 'minutes ahead'],
  book_ahead_days: ['Guests can book up to', 'days ahead'], max_party_instant: ['Online booking up to', 'people'],
  max_party_request: ['The biggest request', 'people'], slot_minutes: ['Times every', 'minutes'],
};
export function describeRules(before, patch) {
  const parts = [];
  for (const [col, [label, unit]] of Object.entries(RULE_WORDS)) {
    if (!(col in patch) || same(before[col], patch[col])) continue;
    parts.push(unit === 'switch' ? `${label} ${patch[col] ? 'on' : 'off'}` : `${label} ${before[col] ?? '–'} → ${patch[col]} ${unit}`);
  }
  return parts.length ? `changed the booking rules: ${parts.join('; ')}` : null;
}

// The rewards (Settings → Rewards).
export function describeLoyalty(before, row) {
  const b = before || {}, parts = [];
  const on = (col, label) => { if (!!b[col] !== !!row[col]) parts.push(`${label} ${row[col] ? 'on' : 'off'}`); };
  const num = (col, label, unit) => { if (b[col] !== undefined && !same(b[col], row[col])) parts.push(`${label} ${b[col] ?? '–'} → ${row[col]}${unit}`); };
  const txt = (col, label) => { if (!same(b[col], row[col])) parts.push(`${label} ${words(row[col])}`); };
  const terms = (col, label) => { if (!same(b[col], row[col])) parts.push(`${label} terms edited`); };
  on('lucky_on', 'Lucky Bite'); num('lucky_every', 'Lucky Bite every', ' dishes'); txt('lucky_reward', 'Lucky Bite prize');
  on('stamps_on', 'Stamp card'); num('stamps_every', 'Stamp card', ' visits'); txt('stamps_reward', 'full-card reward');
  num('reward_days', 'Rewards last', ' days');
  on('invite_on', 'Invite a friend'); txt('invite_discount', 'friend\'s discount'); num('invite_days', 'Invites last', ' days');
  terms('lucky_terms', 'Lucky Bite'); terms('stamps_terms', 'Stamp card'); terms('invite_terms', 'Invite');
  return parts.length ? `changed the rewards: ${parts.join('; ')}` : null;
}

// The opening hours: the days that changed.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];
function dayHours(list, d) {
  const s = (list || []).filter((h) => Number(h.weekday) === d)
    .map((h) => [String(h.opens).slice(0, 5), String(h.closes).slice(0, 5)]).sort((a, b) => a[0].localeCompare(b[0]));
  return s.length ? s.map(([o, c]) => `${clock12(o)}–${clock12(c)}`).join(' & ') : 'closed';
}
export function describeHours(before, after) {
  const changed = ORDER.filter((d) => dayHours(before, d) !== dayHours(after, d));
  if (!changed.length) return null;
  const shown = changed.slice(0, 3).map((d) => `${DAYS[d]} ${dayHours(before, d)} → ${dayHours(after, d)}`);
  return `changed the hours: ${shown.join('; ')}${changed.length > 3 ? `; and ${changed.length - 3} more day${changed.length - 3 > 1 ? 's' : ''}` : ''}`;
}

// "Thu, Nov 26"
export function dayWords(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
}
