// Which impression of a post a profile-list row opens (useOpenListPost).
// 🔒 By the post row's `ratingId`, never "the wine id": a blind row of someone
// else's post carries NO wine id, and `undefined === undefined` would match
// the first blind row. Impressions rows name their rating (the list row's `id`);
// Cravings rows carry the rating their score and post come from (`ratingId`,
// catalogue model change step 7: since step 5 that can be another bottle of the
// same wine than the craving's).
export type ListPostTarget = { ratingId: number };

// Structural on purpose (a FeedItem fits): this module is unit-tested from the
// repo root, and importing the app's API types there would pull React
// Native's global typings into the web's type-check.
type PostLike =
  | { type: 'checkin' }
  | { type: 'session'; session: { wines: { ratingId: number; id?: string }[] } };

// -1 = not in this post (the caller shows "This impression isn't available").
// A standalone post is its one impression.
export function listPostIndex(item: PostLike | null, target: ListPostTarget): number {
  if (!item) return -1;
  if (item.type === 'checkin') return 0;
  // 🔒 Never an absent key against an absent one.
  if (!Number.isInteger(target.ratingId)) return -1;
  return item.session.wines.findIndex((w) => w.ratingId === target.ratingId);
}
