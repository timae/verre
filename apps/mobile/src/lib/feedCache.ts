import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { FEED_KEY, feedItemId, feedKey, setFeedItemLike, type FeedItem, type FeedPage } from '@/lib/api/feed';
import { profileKey } from '@/lib/api/users';
import { viewerCacheEpoch } from '@/lib/query';
import { useSyncExternalStore } from 'react';

// Posts this process saw deleted (a check-in DELETE, or the reap of a
// session post's last rating). A post detail PINS its copy (it must never flip
// to "gone" just because a refetch dropped a page-boundary item), so an
// explicit deletion has to reach every mounted detail of that post, including
// one on another tab's stack (Feed: your post → your profile → switch to You →
// delete it there; Codex, 2026-11-10): those render "gone" instead of the
// pinned copy and close themselves when they regain focus. Ids are never
// reused, so the set is never pruned.
const deletedPosts = new Set<number>();
const deletedListeners = new Set<() => void>();
export function markFeedPostDeleted(id: number) {
  if (deletedPosts.has(id)) return;
  deletedPosts.add(id);
  deletedListeners.forEach((l) => l());
}
export function isFeedPostDeleted(id: number): boolean {
  return deletedPosts.has(id);
}
export function useIsFeedPostDeleted(id: number): boolean {
  return useSyncExternalStore(
    (l) => {
      deletedListeners.add(l);
      return () => deletedListeners.delete(l);
    },
    () => deletedPosts.has(id),
    () => false,
  );
}

// Post mutations against EVERY feed cache. The network feed (['feed']) and the
// profile feeds (['feed', 'user', id]) share the FEED_KEY prefix, and the same
// post can sit in several of them at once, so a like / edit echo / delete must
// reach all of them or the lists disagree about one post.
//
// 🔒 Never `invalidateQueries` a feed cache: it resets an infinite query toward
// its first page, so the list shrinks mid-refetch and the scroll offset clamps
// upward (the "feed creeps up" bug). Writes go through setQueriesData; freshness
// comes from an in-place refetch of the loaded pages.

// Cancel-then-write: an in-flight refetch whose GET left before the mutation
// committed would otherwise resolve after this write and revert it. `map`
// returning null drops the item.
export async function updateFeedCaches(queryClient: QueryClient, map: (item: FeedItem) => FeedItem | null) {
  await queryClient.cancelQueries({ queryKey: FEED_KEY });
  queryClient.setQueriesData<InfiniteData<FeedPage>>({ queryKey: FEED_KEY }, (data) =>
    data
      ? { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map(map).filter((it): it is FeedItem => it !== null) })) }
      : data,
  );
}

// After a write, cancel FIRST, then refetch/invalidate. TanStack only cancels
// an in-flight fetch for a query that already HAS data; a first load still
// pending would be reused, and its pre-write response would land as fresh
// (Codex, 2026-11-09). cancelQueries reverts it, so the refetch starts anew.
async function cancelThenRefetch(queryClient: QueryClient, filters: Parameters<QueryClient['refetchQueries']>[0]) {
  await queryClient.cancelQueries(filters);
  return queryClient.refetchQueries(filters);
}

// In-place refetch of the MOUNTED feed lists (type 'active'). An unmounted
// profile feed was already corrected by updateFeedCaches and refetches when it
// next mounts (staleTime) — refetching it now would be a request nobody sees.
export function refetchFeedCaches(queryClient: QueryClient) {
  return cancelThenRefetch(queryClient, { queryKey: FEED_KEY, type: 'active' });
}

// Just the network feed (['feed'], exact) — after a relationship change
// (follow / mute / block) its author set moves; profile lists don't.
export function refetchNetworkFeed(queryClient: QueryClient) {
  return cancelThenRefetch(queryClient, { queryKey: FEED_KEY, exact: true });
}

// One person's post list (['feed', 'user', id]) — after a follow / unfollow,
// which can flip whether their Check-Ins Visible To shows you their posts
// while the profile itself stays visible.
export function refetchUserFeed(queryClient: QueryClient, userId: number) {
  return cancelThenRefetch(queryClient, { queryKey: feedKey(userId), exact: true });
}

// After a post CREATE: a popped (unmounted) profile list can't show the new
// post — there's nothing to patch it into — and within its staleTime it would
// reopen without it. Drop the unmounted feed caches so they load fresh on next
// open (Codex, 2026-11-09). Mounted lists are untouched: refetchFeedCaches
// updates them in place.
export function dropUnmountedFeedCaches(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: FEED_KEY, type: 'inactive' });
}

// A post write (create / edit / delete) also changes its AUTHOR's profile
// header: impression count, average, tile photo. The header is a plain query,
// not an infinite list, so invalidating it is safe (the never-invalidate rule
// above is about the feed lists): mounted headers refetch, others on next open.
export async function invalidateProfileHeader(queryClient: QueryClient, authorId: number | null) {
  if (authorId == null) return;
  const filters = { queryKey: profileKey(authorId), exact: true };
  await queryClient.cancelQueries(filters); // see cancelThenRefetch
  await queryClient.invalidateQueries(filters);
}

// A profile header after a relationship write (cancel first, as above).
export function refetchProfileHeader(queryClient: QueryClient, userId: number) {
  return cancelThenRefetch(queryClient, { queryKey: profileKey(userId), exact: true });
}

// Optimistic like: flip liked + adjust likeCount in every cache immediately,
// fire the server call, reconcile with its authoritative count; on error,
// refetch in place (never a frozen-snapshot restore — a focus refetch may have
// advanced the cache mid-flight).
//
// Per-post mutation seq, module-wide: the hearts stay tappable while a request
// is in flight, responses can arrive OUT OF ORDER (a quick like→unlike where the
// POST resolves after the DELETE would restore liked:true), and the same post
// can be toggled from two lists. Only the post's LATEST request may reconcile.
const likeSeq = new Map<number, number>();

//
// `liked` is VIEWER-specific (unlike an edit echo or a delete, which are the
// post's truth for everyone): a response landing after a sign-out must not
// write it into the next account's caches, which may hold the same post by
// then (Codex, 2026-11-09). So every write after an await checks the viewer
// epoch (lib/query.tsx).
export async function toggleFeedLike(queryClient: QueryClient, id: number, nextLiked: boolean) {
  const epoch = viewerCacheEpoch();
  const sameViewer = () => viewerCacheEpoch() === epoch;
  const seq = (likeSeq.get(id) ?? 0) + 1;
  likeSeq.set(id, seq);
  await updateFeedCaches(queryClient, (it) => (sameViewer() ? applyLike(it, id, nextLiked) : it));
  try {
    // An idempotent double-like or block-pair-hidden likes make the server's
    // count diverge from the optimistic ±1.
    const server = await setFeedItemLike(id, nextLiked);
    if (likeSeq.get(id) !== seq || !sameViewer()) return; // a newer toggle / another viewer owns it now
    await updateFeedCaches(queryClient, (it) => (sameViewer() ? applyLike(it, id, server.liked, server.count) : it));
  } catch {
    if (likeSeq.get(id) !== seq || !sameViewer()) return; // ditto
    refetchFeedCaches(queryClient);
  }
}

// Apply a like flip to whichever payload the target id lives on. Without
// `count` this is the optimistic ±1 (no-op if liked already matches); with
// `count` (server-authoritative) both fields reconcile to the response.
function applyLike(item: FeedItem, id: number, nextLiked: boolean, count?: number): FeedItem {
  if (feedItemId(item) !== id) return item;
  const delta = nextLiked ? 1 : -1;
  if (item.type === 'session') {
    const likeCount = count ?? (item.session.liked === nextLiked ? item.session.likeCount : Math.max(0, item.session.likeCount + delta));
    if (item.session.liked === nextLiked && item.session.likeCount === likeCount) return item;
    return { ...item, session: { ...item.session, liked: nextLiked, likeCount } };
  }
  const likeCount = count ?? (item.checkin.liked === nextLiked ? item.checkin.likeCount : Math.max(0, item.checkin.likeCount + delta));
  if (item.checkin.liked === nextLiked && item.checkin.likeCount === likeCount) return item;
  return { ...item, checkin: { ...item.checkin, liked: nextLiked, likeCount } };
}
