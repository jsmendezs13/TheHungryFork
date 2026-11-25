// api/_lib/reviewedit.js
//
// r62 (24 Nov 2026) — Edit. Each person changes what they wrote, and nothing is lost (migration 45).
//   Sebastian, 03:xx: "only the one who writes a comment is able to edit them … the customer edits his own comments
//   because sometimes we make mistakes writing" — words and stars.
//   05:34–05:40: a reply written in the restaurant's name can be edited or deleted by whoever wrote it, by the owner
//   and by Sebastian; a manager only a crew member's; nobody edits a guest's words but the guest.
//
//   my_review_edit    the author      their review: the five scores (1–5) and the two comments
//   my_answer_edit    the author      their answer back to the restaurant (turn 3)
//   my_answer_delete  the author      …while the restaurant hasn't answered after it
//   reply_edit        the team        a reply in the restaurant's name (turn 2 'reply' or 4 'reply2'), by the rule below
//   reply_delete      the team        …while nobody has answered after it (the turn opens again)
//
// Who may change a restaurant's reply (the restaurant's level comes from roles.js, this website's restaurant only):
//   the writer, while they can still reply for the restaurant (manager and up)
//   an owner: any reply whose writer is below owner now (a manager's, a crew member's, or someone no longer on the team)
//   a manager: a crew member's reply only
//   Sebastian (platform admin): any
// Owners don't change each other's replies; a manager doesn't change another manager's.
//
// Every edit and delete first keeps the earlier version (review_versions: who, when, what it said), then changes the
// review and stamps when (edited_at, reply_edited_at, …). The review's date stays its own; the pages say "Edited".

import { makeLimiter, allow, keyFor } from './auth.js';
import { sb, tasterIdFromRequest, loadAccess, accessProblem, levelAt, LEVEL } from './roles.js';

const editLimiter = makeLimiter({ requests: 40, window: '10 m', prefix: 'review:edit' });
export const MAX_TEXT = 1500;
export const SCORES = ['flavor', 'worth_every_bite', 'signature_style', 'hospitality', 'atmosphere_vibe'];
const DISH_SCORES = ['flavor', 'worth_every_bite', 'signature_style'];
const COLS = 'id,restaurant_id,taster_id,dish_id,flavor,worth_every_bite,signature_style,hospitality,atmosphere_vibe,dish_comment,restaurant_comment,'
  + 'reply_text,reply_created_at,reply_by,reply_by_name,taster_reply_text,taster_reply_created_at,reply2_text,reply2_created_at,reply2_by,reply2_by_name,'
  + 'hidden_at,deleted_at,edited_at,reply_edited_at,taster_reply_edited_at,reply2_edited_at';
export const NOT_READY = 'Edit is not set up yet: migration 45 has not been run.';
const NOT_THERE = 'That review no longer exists.';
const PARTS = {
  reply:        { text: 'reply_text',        at: 'reply_created_at',        by: 'reply_by',  name: 'reply_by_name',  edited: 'reply_edited_at' },
  taster_reply: { text: 'taster_reply_text', at: 'taster_reply_created_at',                                          edited: 'taster_reply_edited_at' },
  reply2:       { text: 'reply2_text',       at: 'reply2_created_at',       by: 'reply2_by', name: 'reply2_by_name', edited: 'reply2_edited_at' },
};
const filled = (v) => !!(v && String(v).trim());
export const ACTIONS = ['my_review_edit', 'my_answer_edit', 'my_answer_delete', 'reply_edit', 'reply_delete', 'reply_rights'];

function cleanText(v, what) {
  if (v === null || v === undefined) return { value: null };
  if (typeof v !== 'string') return { error: `${what} has to be text.` };
  const t = v.trim();
  if (t.length > MAX_TEXT) return { error: `${what} is too long (limit ${MAX_TEXT} characters).` };
  return { value: t || null };
}

async function load(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return { status: 400, error: 'Which review?' };
  const got = await sb(`/reviews?id=eq.${n}&select=${COLS}&limit=1`);
  if (!got.ok) return got.status === 400 ? { status: 409, error: NOT_READY } : { status: 502, error: 'Could not read that review. Please try again.' };
  const row = Array.isArray(got.data) && got.data[0] ? got.data[0] : null;
  if (!row || row.deleted_at) return { status: 404, error: NOT_THERE };
  return { row };
}

// Keep the earlier version first; then change the review. Returns the saved row, or { status, error }.
async function keepThenSave(row, part, action, old, patch, who) {
  const kept = await sb('/review_versions', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ review_id: Number(row.id), restaurant_id: Number(row.restaurant_id), part, action,
                           by_id: Number(who.id), by_name: who.name || null, old }),
  });
  if (!kept.ok) return kept.status === 404 ? { status: 409, error: NOT_READY } : { status: 502, error: 'Could not save that change. Please try again.' };
  const saved = await sb(`/reviews?id=eq.${Number(row.id)}&deleted_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  if (!saved.ok || !Array.isArray(saved.data) || !saved.data.length) return { status: 502, error: 'Could not save that change. Please try again.' };
  const out = {};
  COLS.split(',').forEach((c) => { out[c] = saved.data[0][c]; });
  return { row: out };
}

// The writer's standing at the restaurant now: the platform admin, their role, or (no longer on the team) a manager's.
async function writerLevel(writerId, restaurantId, memo) {
  if (!writerId) return LEVEL.manager;
  const mk = `${Number(writerId)}@${Number(restaurantId)}`;
  if (memo && mk in memo) return memo[mk];
  const lv = await writerLevelNow(writerId, restaurantId);
  if (memo) memo[mk] = lv;
  return lv;
}
async function writerLevelNow(writerId, restaurantId) {
  const [who, roles] = await Promise.all([
    sb(`/tasters?id=eq.${Number(writerId)}&select=is_platform_admin&limit=1`),
    sb(`/restaurant_roles?taster_id=eq.${Number(writerId)}&restaurant_id=eq.${Number(restaurantId)}&select=role`),
  ]);
  if (who.ok && Array.isArray(who.data) && who.data[0] && who.data[0].is_platform_admin) return LEVEL.platform;
  const levels = (roles.ok && Array.isArray(roles.data) ? roles.data : []).map((r) => LEVEL[r.role] || 0);
  return levels.length ? Math.max(...levels) : LEVEL.manager;
}

export async function mayChangeReply(access, row, part, memo) {
  const lvl = levelAt(access, row.restaurant_id);
  if (lvl < LEVEL.manager) return false;                      // only those who can reply for the restaurant
  if (lvl >= LEVEL.platform) return true;                     // Sebastian
  const writer = row[PARTS[part].by];
  if (writer && Number(writer) === Number(access.tasterId)) return true;   // the writer
  const wl = await writerLevel(writer, row.restaurant_id, memo);
  if (lvl >= LEVEL.owner) return wl < LEVEL.owner;            // an owner: below owner
  return wl < LEVEL.manager;                                  // a manager: a crew member's
}

// The menu page asks which of the replies on screen this person may change (the Manager page gets it with the list).
// { reviewIds: [..] } → { rights: { <id>: { reply: {edit, del}, reply2: {edit, del} } } } — nothing for someone off the team.
async function replyRights(req, res, body, tasterId) {
  const ids = [...new Set((Array.isArray(body.reviewIds) ? body.reviewIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 60);
  if (!ids.length) return res.status(200).json({ rights: {} });
  const access = await loadAccess(tasterId, req);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error });
  const got = await sb(`/reviews?id=in.(${ids.join(',')})&deleted_at=is.null&select=id,restaurant_id,reply_text,reply_by,taster_reply_text,reply2_text,reply2_by,reply_edited_at`);
  if (!got.ok) return got.status === 400 ? res.status(409).json({ error: NOT_READY }) : res.status(502).json({ error: 'Could not read the reviews. Please try again.' });
  const rights = {}, memo = {};
  for (const row of Array.isArray(got.data) ? got.data : []) {
    const r = {};
    if (filled(row.reply_text) && await mayChangeReply(access, row, 'reply', memo)) r.reply = { edit: true, del: !filled(row.taster_reply_text) };
    if (filled(row.reply2_text) && await mayChangeReply(access, row, 'reply2', memo)) r.reply2 = { edit: true, del: true };
    if (r.reply || r.reply2) rights[row.id] = r;
  }
  return res.status(200).json({ rights });
}

export async function reviewEdit(req, res, body, action) {
  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });
  if (action === 'reply_rights') return replyRights(req, res, body, tasterId);
  if (!(await allow(editLimiter, keyFor('e' + tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many changes in a few minutes. Wait a moment and try again.' });
  }
  const got = await load(body.reviewId);
  if (got.error) return res.status(got.status).json({ error: got.error });
  const row = got.row;
  const now = new Date().toISOString();

  // ── the author's own words ──
  if (action === 'my_review_edit' || action === 'my_answer_edit' || action === 'my_answer_delete') {
    if (Number(row.taster_id) !== Number(tasterId)) return res.status(403).json({ error: 'Only the person who wrote this review can change it.' });
    const who = { id: tasterId, name: null };
    if (action === 'my_review_edit') {
      // The team's rule (migration 37): crew can't rate the restaurant where they work, so they can't re-rate it either.
      const crew = await sb(`/restaurant_roles?taster_id=eq.${Number(tasterId)}&restaurant_id=eq.${Number(row.restaurant_id)}&role=eq.crew&select=id&limit=1`);
      if (crew.ok && Array.isArray(crew.data) && crew.data.length) return res.status(403).json({ error: 'You can\'t rate the restaurant where you work, so this review can\'t be changed while you\'re on its team.' });
      const patch = {}, old = {};
      const scores = body.scores && typeof body.scores === 'object' ? body.scores : {};
      for (const k of Object.keys(scores)) {
        if (!SCORES.includes(k)) return res.status(400).json({ error: 'Unknown rating.' });
        const v = scores[k];
        if (v === null && !DISH_SCORES.includes(k)) { if (row[k] !== null) { patch[k] = null; old[k] = row[k]; } continue; }
        if (!Number.isInteger(v) || v < 1 || v > 5) return res.status(400).json({ error: 'Each rating is 1 to 5 stars.' });
        if (Number(row[k]) !== v) { patch[k] = v; old[k] = row[k]; }
      }
      for (const [k, what] of [['dish_comment', 'What you say about the dish'], ['restaurant_comment', 'What you say about the restaurant']]) {
        if (!(k in body)) continue;
        const c = cleanText(body[k], what);
        if (c.error) return res.status(400).json({ error: c.error });
        if ((row[k] || null) !== c.value) { patch[k] = c.value; old[k] = row[k]; }
      }
      if (!Object.keys(patch).length) return res.status(200).json({ success: true, unchanged: true, review: row });
      patch.edited_at = now;
      const saved = await keepThenSave(row, 'review', 'edit', old, patch, who);
      if (saved.error) return res.status(saved.status).json({ error: saved.error });
      console.log('[reviewedit] taster', tasterId, 'edited review', row.id, Object.keys(old).join(','));
      return res.status(200).json({ success: true, review: saved.row });
    }
    const p = PARTS.taster_reply;
    if (!filled(row[p.text])) return res.status(404).json({ error: 'There is no answer of yours to change here.' });
    if (action === 'my_answer_edit') {
      const c = cleanText(body.text, 'Your answer');
      if (c.error) return res.status(400).json({ error: c.error });
      if (!c.value) return res.status(400).json({ error: 'Write something, or delete your answer instead.' });
      if (c.value === row[p.text]) return res.status(200).json({ success: true, unchanged: true, review: row });
      const saved = await keepThenSave(row, 'taster_reply', 'edit', { text: row[p.text], at: row[p.at] }, { [p.text]: c.value, [p.edited]: now }, who);
      if (saved.error) return res.status(saved.status).json({ error: saved.error });
      return res.status(200).json({ success: true, review: saved.row });
    }
    if (filled(row.reply2_text)) return res.status(409).json({ error: 'The restaurant already answered after this, so it can be edited but not deleted.' });
    const saved = await keepThenSave(row, 'taster_reply', 'delete', { text: row[p.text], at: row[p.at] }, { [p.text]: null, [p.at]: null, [p.edited]: null }, who);
    if (saved.error) return res.status(saved.status).json({ error: saved.error });
    return res.status(200).json({ success: true, review: saved.row });
  }

  // ── a reply in the restaurant's name ──
  const part = body.turn === 'reply2' ? 'reply2' : body.turn === 'reply' ? 'reply' : null;
  if (!part) return res.status(400).json({ error: 'Which reply?' });
  const p = PARTS[part];
  if (!filled(row[p.text])) return res.status(404).json({ error: 'There is no reply to change here.' });
  const access = await loadAccess(tasterId, req);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error, ...(problem.reason ? { reason: problem.reason } : {}) });
  if (!(await mayChangeReply(access, row, part))) {
    return res.status(403).json({ error: 'Only the person who wrote this reply, the owner, or Seb\'s Analytics can change it. A manager can change a crew member\'s reply.' });
  }
  const who = { id: tasterId, name: access.firstName || null };
  const old = { text: row[p.text], at: row[p.at], by: row[p.by], name: row[p.name] };
  if (action === 'reply_edit') {
    const c = cleanText(body.text, 'The reply');
    if (c.error) return res.status(400).json({ error: c.error });
    if (!c.value) return res.status(400).json({ error: 'Write something, or delete the reply instead.' });
    if (c.value === row[p.text]) return res.status(200).json({ success: true, unchanged: true, review: row });
    const saved = await keepThenSave(row, part, 'edit', old, { [p.text]: c.value, [p.edited]: now }, who);
    if (saved.error) return res.status(saved.status).json({ error: saved.error });
    console.log('[reviewedit] taster', tasterId, 'edited the', part, 'of review', row.id);
    return res.status(200).json({ success: true, review: saved.row });
  }
  if (part === 'reply' && filled(row.taster_reply_text)) {
    return res.status(409).json({ error: 'The guest already answered this reply, so it can be edited but not deleted.' });
  }
  const saved = await keepThenSave(row, part, 'delete', old, { [p.text]: null, [p.at]: null, [p.by]: null, [p.name]: null, [p.edited]: null }, who);
  if (saved.error) return res.status(saved.status).json({ error: saved.error });
  console.log('[reviewedit] taster', tasterId, 'deleted the', part, 'of review', row.id);
  return res.status(200).json({ success: true, review: saved.row });
}
