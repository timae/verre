// Which impression of a post a profile-list row opens (useOpenListPost).
// 🔒 An explicit selector, never "the wine id": a blind row of someone else's
// post carries NO wine id, and `undefined === undefined` would match the first
// blind row. Impressions rows name their rating (the list row's `id` is the
// post row's `ratingId`); Cravings rows carry no rating id and are never blind
// on someone else's list, so they match by the wine id, which is always a
// string there.
export type ListPostTarget = { ratingId: number } | { wineId: string };

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
  if ('ratingId' in target) return item.session.wines.findIndex((w) => w.ratingId === target.ratingId);
  // 🔒 Never an absent id against an absent id.
  if (!target.wineId) return -1;
  return item.session.wines.findIndex((w) => w.id === target.wineId);
}
