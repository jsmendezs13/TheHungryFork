// api/review-reply.js
//
// A restaurant answering a review, in public, under its own name.
//
// This exists because the browser can no longer write reply_text — migration 9
// took that column privilege away from every browser role. Which is the point:
// the old route let anyone holding a month-old session token write to any
// column of any review row, including the five rating numbers. A removed
// manager could have rewritten a customer's stars from the console.
//
// So the reply comes through here, where the caller's role is read from the
// database on this request, and where exactly two columns can be written.
//
// What a restaurant may do to a review, in full:
//   reply to it        ✓  here
//   change its reply   ✓  here
//   remove its reply   ✓  here, by sending empty text
//   hide it            ✗  never
//   delete it          ✗  never — only Seb's Analytics, with a written reason
//   edit a word of it  ✗  never
//   change the stars   ✗  never

import { makeLimiter, allow, keyFor } from './_lib/auth.js';
import {
  tasterIdFromRequest, loadAccess, accessProblem, canReplyToReviews, sb,
} from './_lib/roles.js';

const MAX_REPLY = 1500;

// A restaurant catching up on a week of reviews will write several in a row.
// Generous enough for that, tight enough that a stolen session cannot reply to
// every review on the platform before anyone notices.
const replyLimiter = makeLimiter({ requests: 40, window: '10 m', prefix: 'review:reply' });

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

  if (text !== null && typeof text !== 'string') {
    return res.status(400).json({ error: 'A reply has to be text.' });
  }
  const reply = (text || '').trim();
  if (reply.length > MAX_REPLY) {
    return res.status(400).json({ error: `That reply is too long (limit ${MAX_REPLY} characters).` });
  }

  // The REVIEW decides which restaurant is involved, never the request body.
  // Same rule as manager-dish.js, and for the same reason: otherwise a manager
  // at one restaurant replies on another's reviews by changing a number.
  const found = await sb(`/reviews?id=eq.${id}&select=id,restaurant_id,reply_text`);
  if (!found.ok) {
    console.error('[review-reply] read failed', found.status);
    return res.status(502).json({ error: 'Could not read that review (the database answered ' + found.status + ').' });
  }
  if (!Array.isArray(found.data) || found.data.length === 0) {
    return res.status(404).json({ error: 'That review no longer exists.' });
  }
  const review = found.data[0];

  const access = await loadAccess(tasterId);
  const problem = accessProblem(access);
  if (problem) return res.status(problem.status).json({ error: problem.error });

  if (!canReplyToReviews(access, review.restaurant_id)) {
    return res.status(403).json({
      error: 'You do not have permission to reply for this restaurant.',
    });
  }

  // Clearing a reply is deliberate and allowed: a restaurant that answered in
  // anger at 1am should be able to take its own words down. It can never touch
  // the customer's words.
  const patch = reply
    ? {
        reply_text:       reply,
        reply_created_at: new Date().toISOString(),
        reply_by:         tasterId,
        reply_by_name:    access.firstName || null,
      }
    : {
        reply_text: null, reply_created_at: null, reply_by: null, reply_by_name: null,
      };

  const saved = await sb(`/reviews?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!saved.ok || !Array.isArray(saved.data) || saved.data.length === 0) {
    console.error('[review-reply] write failed', saved.status);
    return res.status(500).json({ error: 'Could not save that reply.' });
  }

  console.log('[review-reply] taster', tasterId, reply ? 'replied to' : 'cleared reply on', id);
  return res.status(200).json({
    success:   true,
    reviewId:  id,
    replyText: saved.data[0].reply_text,
    replyAt:   saved.data[0].reply_created_at,
  });
}
