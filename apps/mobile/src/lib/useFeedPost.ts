import { useInfiniteQuery } from '@tanstack/react-query';
import { feedItemQueryOptions, feedQueryOptions, findFeedItem } from '@/lib/api/feed';

// THE read of one post for the detail, its edit and the edit details (lists
// plan D9): from the list it was opened from (the network feed, or one
// person's profile feed via `user`), or, with `source: 'item'` (opened from a
// profile tile list, where the post can be older than any loaded page), from
// ONLY that post's own item query (['feed', 'user', id, 'item', postId], the
// list's page shape). `refetchOnMount: false` like the list reads: the row
// prefetched it; a cold open still runs the initial fetch.
export function useFeedPost(postId: number, userId: string | null, source: string | undefined) {
  const opts = source === 'item' && userId != null && Number.isFinite(postId)
    ? feedItemQueryOptions(userId, postId)
    : feedQueryOptions(userId);
  const feed = useInfiniteQuery({ ...opts, refetchOnMount: false });
  const found = Number.isFinite(postId) ? findFeedItem(feed.data?.pages, postId) : null;
  return { feed, found };
}
