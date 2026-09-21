// api/review-reply.js
//
// One conversation about one dish, with exactly four turns.
//
//   1. the guest rates and comments        (posted with the review itself)
//   2. the restaurant answers              reply_text
//   3. the guest answers back, once        taster_reply_text
//   4. the restaurant has the last word    reply2_text
//   ── closed ──
//
// NOBODY NAMES THEIR TURN. The row decides. A caller says only "here is what
// I want to add to review 31", and this file works out from the columns
// already filled which turn is next and who is allowed to take it. There is
// no slot parameter to get wrong, to forge, or to keep in step between the
// browser and the server.
//
// NOTHING CAN BE TAKEN BACK. A turn already taken is never overwritten, and
// an empty reply is refused rather than treated as "delete mine" — otherwise
// "clear it" is just "edit it" with an extra step. This is Sebastian's rule
// and it is the strong version of it: if it was said, it stands.
//
// This endpoint exists at all because migration 9 took reply_text away from
// every browser role, and migration 10 did the same for the three columns
// added since. The old route let anyone holding a month-old session token
// PATCH any column of any review — including the five rating numbers. A
// removed manager could have rewritten a customer's stars from the console.
//
// What a restaurant may do to a review, in full:
//   answer it            ✓  here, once
//   have the last word   ✓  here, once, and only after the guest answers
//   change its answer    ✗  never — not by editing, not by clearing
//   answer twice in a row ✗ never
//   hide it              ✗  never
//   delete it            ✗  never — only Seb's Analytics, with a written reason
//   edit a word of it    ✗  never
//   change the stars     ✗  never

import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import {
  tasterIdFromRequest, loadAccess, accessProblem, canReplyToReviews, sb,
} from './_lib/roles.js';

const MAX_REPLY = 1500;

// A restaurant catching up on a week of reviews will write several in a row.
// Generous enough for that, tight enough that a stolen session cannot answer
// every review on the platform before anyone notices.
const replyLimiter = makeLimiter({ requests: 40, window: '10 m', prefix: 'review:reply' });

const filled = (v) => !!(v && String(v).trim());

// The whole rule, in one function. Each turn is unlocked by the one before it
// being taken, so the order cannot be jumped and a turn cannot be repeated.
// Returns null when the conversation is finished.
export function nextTurn(review) {
  if (!filled(review.reply_text)) {
    return { side: 'restaurant',
             cols: { text: 'reply_text',  at: 'reply_created_at',
                     by: 'reply_by',      name: 'reply_by_name' } };
  }
  if (!filled(review.taster_reply_text)) {
    return { side: 'guest',
             cols: { text: 'taster_reply_text', at: 'taster_reply_created_at' } };
  }
  if (!filled(review.reply2_text)) {
    return { side: 'restaurant',
             cols: { text: 'reply2_text', at: 'reply2_created_at',
                     by: 'reply2_by',     name: 'reply2_by_name' } };
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const tasterId = tasterIdFromRequest(req);
  if (!tasterId) return res.status(401).json({ error: 'Please log in again.' });

  if (!(await allow(replyLimiter, keyFor(tasterId), { failOpen: true }))) {
    return res.status(429).json({ error: 'Too many replies at once. Wait a few minutes.' });
  }

  const { reviewId, text } = req.body || {};
  const id = Number(reviewId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Which review?' });

  if (typeof text !== 'string') return res.status(400).json({ error: 'A reply has to be text.' });
  const reply = text.trim();

  // No empty reply, and therefore no way to erase a turn by saving nothing
  // over it. Somebody who regrets what they wrote has to live with it, which
  // is the same deal the guest who wrote the review got.
  if (!reply) {
    return res.status(400).json({ error: 'A reply cannot be empty. Nothing here can be taken back once it is posted, so write it before you send it.' });
  }
  if (reply.length > MAX_REPLY) {
    return res.status(400).json({ error: `That reply is too long (limit ${MAX_REPLY} characters).` });
  }

  // The REVIEW decides which restaurant is involved, and who the guest is —
  // never the request body. Same rule as manager-dish.js, and for the same
  // reason: otherwise a manager at one restaurant answers on another's
  // reviews by changing a number.
  const found = await sb(
    `/reviews?id=eq.${id}&select=id,restaurant_id,taster_id,reply_text,taster_reply_text,reply2_text`
  );
  if (!found.ok) {
    console.error('[review-reply] read failed', found.status);
    return res.status(502).json({ error: 'Could not read that review (the database answered ' + found.status + ').' });
  }
  if (!Array.isArray(found.data) || found.data.length === 0) {
    return res.status(404).json({ error: 'That review no longer exists.' });
  }
  const review = found.data[0];

  const turn = nextTurn(review);
  if (!turn) {
    return res.status(409).json({
      error: 'This conversation is finished. A review gets one reply from the restaurant, one answer from the guest, and one last word from the restaurant — and that is all.',
    });
  }

  // ── may this person take THIS turn? ──
  let authorName = null;

  if (turn.side === 'guest') {
    // Only the person whose review it is, and a manager cannot speak for them.
    // No role lookup at all here: a guest has no role, and asking for one
    // would mean a broken permissions table stopped customers replying.
    if (String(review.taster_id) !== String(tasterId)) {
      return res.status(403).json({
        error: filled(review.reply2_text)
          ? 'This conversation is finished.'
          : 'It is the guest\'s turn to answer. Only the person who wrote this review can take it.',
      });
    }
  } else {
    const access = await loadAccess(tasterId);
    const problem = accessProblem(access);
    if (problem) return res.status(problem.status).json({ error: problem.error });

    if (!canReplyToReviews(access, review.restaurant_id)) {
      return res.status(403).json({ error: 'You do not have permission to reply for this restaurant.' });
    }
    authorName = access.firstName || null;
  }

  // Exactly the columns for this one turn. Nothing already written is named,
  // so there is no patch this endpoint can build that overwrites anything.
  const patch = { [turn.cols.text]: reply, [turn.cols.at]: new Date().toISOString() };
  if (turn.cols.by)   patch[turn.cols.by]   = tasterId;
  if (turn.cols.name) patch[turn.cols.name] = authorName;

  const saved = await sb(`/reviews?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!saved.ok || !Array.isArray(saved.data) || saved.data.length === 0) {
    console.error('[review-reply] write failed', saved.status);
    return res.status(500).json({ error: 'Could not save that reply.' });
  }

  const row = saved.data[0];
  console.log('[review-reply] taster', tasterId, 'took the', turn.side, 'turn on review', id);
  return res.status(200).json({
    success:   true,
    reviewId:  id,
    side:      turn.side,
    column:    turn.cols.text,
    replyText: row[turn.cols.text],
    replyAt:   row[turn.cols.at],
    // What the screen should draw next, worked out from the row that was
    // actually saved rather than from what the browser thinks it holds.
    closed:    !nextTurn(row),
    nextSide:  nextTurn(row)?.side || null,
  });
}
