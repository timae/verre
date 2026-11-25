// The impression page's address (Moment Visibility step 3, T13): the EXISTING
// post routes (`/feed/<id>`, a post's stack `post/<postId>`) with `r<ratingId>`
// in place of a post id, so the link opener and the opened post's own stack
// keep working with no new route files. Pure (root units:
// scripts/tests/post-privacy-units.ts).
//
// 🔒 An `r…` id is never a post: nothing may turn it into a number (`Number`
// gives NaN, and `Set` / `Map` treat NaN as one key, so every impression would
// share it in the post registries). Parsed strictly: `r`, then a positive int4
// without leading zeros.
const INT4_MAX = 2_147_483_647;
export function parseImpressionRouteId(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^r[1-9][0-9]{0,9}$/.test(raw)) return null;
  const n = Number(raw.slice(1));
  return n <= INT4_MAX ? n : null;
}
export const impressionRouteId = (ratingId: number): string => `r${ratingId}`;
export const isImpressionRouteId = (raw: string | null | undefined): boolean => typeof raw === 'string' && raw.startsWith('r');

// What a profile list row opens (T14): its post while you may open one, else
// its impression page by the rating, else nothing (a Cravings row with
// neither, as before).
export type ListRowTarget = { kind: 'post'; postId: number } | { kind: 'impression'; ratingId: number } | { kind: 'inert' };
export function listRowTarget(postId: number | null | undefined, ratingId: number | null | undefined): ListRowTarget {
  if (typeof postId === 'number' && Number.isFinite(postId)) return { kind: 'post', postId };
  if (typeof ratingId === 'number' && Number.isInteger(ratingId) && ratingId > 0 && ratingId <= INT4_MAX) return { kind: 'impression', ratingId };
  return { kind: 'inert' };
}
